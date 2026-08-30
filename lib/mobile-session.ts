import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { durableAtomicWriteFile } from "./durable-files";
import { withMobileOwnerOperationLock } from "./mobile-owner-operation-lock";
import "./server-only-guard";

const MOBILE_SESSION_VERSION = "v1";
const MOBILE_RECOVERY_VERSION = "r1";
export const MOBILE_SESSION_TTL_MS = 60 * 60_000;
export const MOBILE_RECOVERY_INACTIVITY_MS = 30 * 24 * 60 * 60_000;
const MOBILE_SESSION_MINIMUM_VALIDITY_MS = 5 * 60_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECOVERY_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MOBILE_RECOVERY_RECORD_LIMIT = 100_000;
const MOBILE_RECOVERY_FILE_LIMIT_BYTES = 64 * 1024 * 1024;

export interface MobileSessionIdentity {
  /** Stable, non-secret owner key used only for server-side record partitioning. */
  ownerId: string;
  expiresAt: number;
}

export interface IssuedMobileSession extends MobileSessionIdentity {
  /** Opaque bearer credential. Store only in the device secure store. */
  sessionToken: string;
}

export interface CreatedMobileSession extends IssuedMobileSession {
  /** Independent rotating recovery credential. Store only in iOS SecureStore. */
  recoveryToken: string;
}

interface MobileRecoveryRecord {
  version: 1;
  sessionId: string;
  currentRecoveryHash: string;
  previousRecoveryHash: string | null;
  createdAt: number;
  updatedAt: number;
}

interface MobileRecoveryStore {
  version: 1;
  records: MobileRecoveryRecord[];
}

export class MobileSessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "configuration"
      | "missing"
      | "invalid"
      | "expired"
      | "renew_required"
      | "recovery_required"
      | "storage",
    readonly status: number,
  ) {
    super(message);
    this.name = "MobileSessionError";
  }
}

function configuredSecret() {
  const value = process.env.CARTIVA_SESSION_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new MobileSessionError(
      "Secure mobile sessions are not configured on the Cartiva server.",
      "configuration",
      503,
    );
  }
  return createHash("sha256")
    .update("Cartiva temporary mobile session signing\0", "utf8")
    .update(value, "utf8")
    .digest();
}

function configuredVerificationSecrets() {
  const current = configuredSecret();
  const previousValue = process.env.CARTIVA_SESSION_PREVIOUS_SECRET?.trim();
  if (!previousValue) return [current];
  if (previousValue.length < 32) {
    throw new MobileSessionError(
      "The previous mobile session signing secret is invalid.",
      "configuration",
      503,
    );
  }
  const previous = createHash("sha256")
    .update("Cartiva temporary mobile session signing\0", "utf8")
    .update(previousValue, "utf8")
    .digest();
  return safeEqual(current.toString("base64url"), previous.toString("base64url"))
    ? [current]
    : [current, previous];
}

function recoveryStoreFile() {
  const configured = process.env.CARTIVA_MOBILE_SESSION_FILE?.trim() ?? "";
  if (process.env.NODE_ENV === "production") {
    if (
      process.env.CARTIVA_SECURE_STATE_MODE?.trim() !== "SINGLE_INSTANCE_FILESYSTEM"
      || !configured
      || !path.isAbsolute(configured)
    ) {
      throw new MobileSessionError(
        "Production mobile session recovery needs an absolute durable secure-state file.",
        "configuration",
        503,
      );
    }
  }
  return configured
    ? path.resolve(/* turbopackIgnore: true */ configured)
    : path.resolve(".cartiva", "mobile-session-recovery.json");
}

function signature(value: string) {
  return createHmac("sha256", configuredSecret()).update(value, "utf8").digest("base64url");
}

function signatureIsValid(value: string, supplied: string) {
  return configuredVerificationSecrets().some((secret) => safeEqual(
    createHmac("sha256", secret).update(value, "utf8").digest("base64url"),
    supplied,
  ));
}

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function ownerIdFor(sessionId: string) {
  return createHash("sha256")
    .update("Cartiva mobile session owner\0", "utf8")
    .update(sessionId, "utf8")
    .digest("hex");
}

export function mobileSessionsAreConfigured() {
  try {
    configuredVerificationSecrets();
    recoveryStoreFile();
    return true;
  } catch {
    return false;
  }
}

export function issueMobileSession(now = Date.now()): IssuedMobileSession {
  const sessionId = randomBytes(32).toString("base64url");
  return issueMobileSessionForId(sessionId, now);
}

function issueMobileSessionForId(sessionId: string, now = Date.now()): IssuedMobileSession {
  const expiresAt = now + MOBILE_SESSION_TTL_MS;
  const expires = expiresAt.toString(36);
  const signed = `${MOBILE_SESSION_VERSION}.${sessionId}.${expires}`;
  return {
    sessionToken: `${signed}.${signature(signed)}`,
    ownerId: ownerIdFor(sessionId),
    expiresAt,
  };
}

function recoveryTokenFor(sessionId: string) {
  return `${MOBILE_RECOVERY_VERSION}.${sessionId}.${randomBytes(32).toString("base64url")}`;
}

function parseMobileRecoveryToken(token: string) {
  const [version, sessionId, recoverySecret, extra] = token.split(".");
  if (
    extra !== undefined
    || version !== MOBILE_RECOVERY_VERSION
    || !SESSION_ID_PATTERN.test(sessionId ?? "")
    || !SESSION_ID_PATTERN.test(recoverySecret ?? "")
  ) {
    throw new MobileSessionError(
      "A valid rotating Cartiva recovery credential is required.",
      "recovery_required",
      401,
    );
  }
  return { sessionId, recoverySecret };
}

function recoveryHash(sessionId: string, recoverySecret: string) {
  return createHash("sha256")
    .update("Cartiva mobile session recovery credential v1\0", "utf8")
    .update(sessionId, "utf8")
    .update("\0", "utf8")
    .update(recoverySecret, "utf8")
    .digest("hex");
}

function validRecoveryRecord(value: unknown): value is MobileRecoveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 6
    && record.version === 1
    && typeof record.sessionId === "string"
    && SESSION_ID_PATTERN.test(record.sessionId)
    && typeof record.currentRecoveryHash === "string"
    && RECOVERY_HASH_PATTERN.test(record.currentRecoveryHash)
    && (record.previousRecoveryHash === null || (
      typeof record.previousRecoveryHash === "string"
      && RECOVERY_HASH_PATTERN.test(record.previousRecoveryHash)
      && record.previousRecoveryHash !== record.currentRecoveryHash
    ))
    && typeof record.createdAt === "number"
    && Number.isSafeInteger(record.createdAt)
    && record.createdAt > 0
    && typeof record.updatedAt === "number"
    && Number.isSafeInteger(record.updatedAt)
    && record.updatedAt >= record.createdAt;
}

function recoveryStorageError() {
  return new MobileSessionError(
    "Cartiva could not safely access mobile session recovery state.",
    "storage",
    503,
  );
}

function missingFile(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT",
  );
}

async function readRecoveryStore(): Promise<MobileRecoveryStore> {
  const file = recoveryStoreFile();
  let serialized: string;
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > MOBILE_RECOVERY_FILE_LIMIT_BYTES) {
      throw recoveryStorageError();
    }
    serialized = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof MobileSessionError) throw error;
    if (missingFile(error)) return { version: 1, records: [] };
    throw recoveryStorageError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw recoveryStorageError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw recoveryStorageError();
  }
  const store = parsed as Record<string, unknown>;
  if (
    Object.keys(store).length !== 2
    || store.version !== 1
    || !Array.isArray(store.records)
    || store.records.length > MOBILE_RECOVERY_RECORD_LIMIT
  ) {
    throw recoveryStorageError();
  }
  const seen = new Set<string>();
  for (const record of store.records) {
    if (!validRecoveryRecord(record) || seen.has(record.sessionId)) {
      throw recoveryStorageError();
    }
    seen.add(record.sessionId);
  }
  return { version: 1, records: store.records };
}

async function persistRecoveryStore(store: MobileRecoveryStore) {
  const file = recoveryStoreFile();
  try {
    await durableAtomicWriteFile(file, JSON.stringify(store));
  } catch {
    throw recoveryStorageError();
  }
}

function activeRecoveryRecords(store: MobileRecoveryStore, now: number) {
  return store.records.filter(
    (record) => record.updatedAt + MOBILE_RECOVERY_INACTIVITY_MS > now,
  );
}

async function pruneRecoveryStore(store: MobileRecoveryStore, now: number) {
  const records = activeRecoveryRecords(store, now);
  if (records.length === store.records.length) return store;
  const pruned = { version: 1 as const, records };
  await persistRecoveryStore(pruned);
  return pruned;
}

type MobileSessionGlobal = typeof globalThis & {
  __cartivaMobileSessionFileMutation?: Promise<void>;
};

function enqueueRecoveryMutation<T>(mutation: () => Promise<T>) {
  const state = globalThis as MobileSessionGlobal;
  const previous = state.__cartivaMobileSessionFileMutation ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  state.__cartivaMobileSessionFileMutation = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

class MobileSessionCollisionError extends Error {}

export async function createMobileSessionCredentials(
  now = Date.now(),
): Promise<CreatedMobileSession> {
  configuredSecret();
  recoveryStoreFile();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sessionId = randomBytes(32).toString("base64url");
    const recoveryToken = recoveryTokenFor(sessionId);
    const { recoverySecret } = parseMobileRecoveryToken(recoveryToken);
    const ownerId = ownerIdFor(sessionId);
    try {
      return await withMobileOwnerOperationLock(ownerId, () => enqueueRecoveryMutation(async () => {
        const loaded = await readRecoveryStore();
        const records = activeRecoveryRecords(loaded, now);
        const store: MobileRecoveryStore = { version: 1, records };
        if (store.records.some((record) => record.sessionId === sessionId)) {
          throw new MobileSessionCollisionError();
        }
        if (store.records.length >= MOBILE_RECOVERY_RECORD_LIMIT) throw recoveryStorageError();
        const next: MobileRecoveryStore = {
          version: 1,
          records: [...store.records, {
            version: 1,
            sessionId,
            currentRecoveryHash: recoveryHash(sessionId, recoverySecret),
            previousRecoveryHash: null,
            createdAt: now,
            updatedAt: now,
          }],
        };
        await persistRecoveryStore(next);
        return {
          ...issueMobileSessionForId(sessionId, now),
          recoveryToken,
        };
      }));
    } catch (error) {
      if (error instanceof MobileSessionCollisionError) continue;
      throw error;
    }
  }
  throw recoveryStorageError();
}

function parseMobileSessionToken(token: string) {
  const [version, sessionId, expires, suppliedSignature, extra] = token.split(".");
  if (
    extra !== undefined
    || version !== MOBILE_SESSION_VERSION
    || !SESSION_ID_PATTERN.test(sessionId ?? "")
    || !/^[0-9a-z]{8,12}$/.test(expires ?? "")
    || !SIGNATURE_PATTERN.test(suppliedSignature ?? "")
  ) {
    throw new MobileSessionError(
      "This Cartiva session is invalid. Reopen the app and try again.",
      "invalid",
      401,
    );
  }
  const signed = `${version}.${sessionId}.${expires}`;
  if (!signatureIsValid(signed, suppliedSignature)) {
    throw new MobileSessionError(
      "This Cartiva session is invalid. Reopen the app and try again.",
      "invalid",
      401,
    );
  }
  const expiresAt = Number.parseInt(expires, 36);
  if (!Number.isSafeInteger(expiresAt)) {
    throw new MobileSessionError(
      "This Cartiva session is invalid. Reopen the app and try again.",
      "invalid",
      401,
    );
  }
  return { sessionId, expiresAt };
}

export function verifyMobileSessionToken(
  token: string,
  now = Date.now(),
): MobileSessionIdentity {
  const { sessionId, expiresAt } = parseMobileSessionToken(token);
  // Tokens minted by older or misconfigured deployments must not preserve a
  // bearer beyond the current one-hour access window. Recovery, not a
  // long-dated access token, is the only supported way to retain the owner.
  if (expiresAt > now + MOBILE_SESSION_TTL_MS) {
    throw new MobileSessionError(
      "This Cartiva session is invalid. Reopen the app and try again.",
      "invalid",
      401,
    );
  }
  if (expiresAt <= now) {
    throw new MobileSessionError(
      "This Cartiva session expired. Reopen the app and try again.",
      "expired",
      401,
    );
  }
  return { ownerId: ownerIdFor(sessionId), expiresAt };
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  const match = /^Bearer ([A-Za-z0-9_.-]{80,220})$/.exec(authorization);
  if (!match) {
    throw new MobileSessionError(
      "A secure Cartiva session is required.",
      "missing",
      401,
    );
  }
  return match[1];
}

function recoveryBearerToken(request: Request) {
  const token = bearerToken(request);
  parseMobileRecoveryToken(token);
  return token;
}

export function requireMobileSession(request: Request) {
  const identity = verifyMobileSessionToken(bearerToken(request));
  if (identity.expiresAt - Date.now() <= MOBILE_SESSION_MINIMUM_VALIDITY_MS) {
    throw new MobileSessionError(
      "Renew the secure Cartiva session before continuing.",
      "renew_required",
      401,
    );
  }
  return identity;
}

export async function renewMobileSession(
  request: Request,
  nextRecoveryToken: string,
  now = Date.now(),
): Promise<CreatedMobileSession> {
  configuredSecret();
  recoveryStoreFile();
  const presentedToken = recoveryBearerToken(request);
  const presented = parseMobileRecoveryToken(presentedToken);
  const proposed = parseMobileRecoveryToken(nextRecoveryToken);
  if (proposed.sessionId !== presented.sessionId) {
    throw new MobileSessionError(
      "The replacement Cartiva recovery credential is invalid.",
      "invalid",
      401,
    );
  }
  const presentedHash = recoveryHash(presented.sessionId, presented.recoverySecret);
  const proposedHash = recoveryHash(proposed.sessionId, proposed.recoverySecret);
  const ownerId = ownerIdFor(presented.sessionId);

  return withMobileOwnerOperationLock(ownerId, () => enqueueRecoveryMutation(async () => {
    const store = await pruneRecoveryStore(await readRecoveryStore(), now);
    const index = store.records.findIndex((record) => record.sessionId === presented.sessionId);
    if (index < 0) {
      throw new MobileSessionError(
        "This Cartiva recovery credential is invalid or revoked.",
        "invalid",
        401,
      );
    }
    const record = store.records[index];
    const presentedCurrent = safeEqual(presentedHash, record.currentRecoveryHash);
    const presentedPrevious = record.previousRecoveryHash !== null
      && safeEqual(presentedHash, record.previousRecoveryHash);
    const isIdempotentRetry = record.previousRecoveryHash !== null
      && presentedPrevious
      && safeEqual(proposedHash, record.currentRecoveryHash);

    if (presentedCurrent) {
      if (
        safeEqual(proposedHash, record.currentRecoveryHash)
        || (record.previousRecoveryHash !== null
          && safeEqual(proposedHash, record.previousRecoveryHash))
      ) {
        throw new MobileSessionError(
          "The replacement Cartiva recovery credential must be new.",
          "invalid",
          401,
        );
      }
      const records = [...store.records];
      records[index] = {
        ...record,
        currentRecoveryHash: proposedHash,
        previousRecoveryHash: record.currentRecoveryHash,
        updatedAt: now,
      };
      await persistRecoveryStore({ version: 1, records });
    } else if (presentedPrevious && !isIdempotentRetry) {
      // The immediately previous secret is authentic but was reused with a
      // different successor. That proves a split credential family rather
      // than a random invalid guess, so revoke the whole owner recovery chain.
      await persistRecoveryStore({
        version: 1,
        records: store.records.filter((_, recordIndex) => recordIndex !== index),
      });
      throw new MobileSessionError(
        "This Cartiva recovery credential was reused. The temporary session was revoked for safety.",
        "invalid",
        401,
      );
    } else if (!isIdempotentRetry) {
      throw new MobileSessionError(
        "This Cartiva recovery credential is invalid or was already rotated.",
        "invalid",
        401,
      );
    }

    return {
      ...issueMobileSessionForId(presented.sessionId, now),
      recoveryToken: nextRecoveryToken,
    };
  }));
}

export async function revokeMobileSessionRecovery(
  request: Request,
  now = Date.now(),
  beforeRevoke?: (ownerId: string) => Promise<void>,
) {
  recoveryStoreFile();
  const presented = parseMobileRecoveryToken(recoveryBearerToken(request));
  const presentedHash = recoveryHash(presented.sessionId, presented.recoverySecret);
  const ownerId = ownerIdFor(presented.sessionId);

  await withMobileOwnerOperationLock(ownerId, () => enqueueRecoveryMutation(async () => {
    const store = await pruneRecoveryStore(await readRecoveryStore(), now);
    const index = store.records.findIndex((record) => record.sessionId === presented.sessionId);
    // Revocation is deliberately idempotent after a record is gone. If the
    // first 204 response is lost, the device can retry the exact credential
    // and safely learn that recovery is no longer possible before deleting its
    // only local revocation handle.
    if (index < 0) return;
    const record = store.records[index];
    const matchesCurrent = safeEqual(presentedHash, record.currentRecoveryHash);
    const matchesPrevious = record.previousRecoveryHash !== null
      && safeEqual(presentedHash, record.previousRecoveryHash);
    if (!matchesCurrent && !matchesPrevious) {
      throw new MobileSessionError(
        "This Cartiva recovery credential is invalid or revoked.",
        "invalid",
        401,
      );
    }
    // Owner cleanup runs inside the same owner lock and before recovery is
    // removed. If cleanup or its durable sync fails, the iPhone keeps a valid
    // recovery handle and can safely retry the explicit reset.
    await beforeRevoke?.(ownerId);
    await persistRecoveryStore({
      version: 1,
      records: store.records.filter((_, recordIndex) => recordIndex !== index),
    });
  }));
  return { ownerId };
}

export function resetMobileSessionRecoveryForTests() {
  delete (globalThis as MobileSessionGlobal).__cartivaMobileSessionFileMutation;
}

export function mobileSessionErrorResponse(error: unknown) {
  const sessionError = error instanceof MobileSessionError ? error : undefined;
  return Response.json(
    {
      error: sessionError?.message ?? "The Cartiva session could not be verified.",
      code: sessionError?.code ?? "invalid",
    },
    {
      status: sessionError?.status ?? 401,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
