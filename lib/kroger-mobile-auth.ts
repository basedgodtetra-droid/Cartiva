import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import {
  durableAtomicWriteFile,
  durableRemoveFile,
  durableRename,
} from "./durable-files";
import {
  KrogerAuthClient,
  KrogerAuthError,
  type KrogerAuthConfig,
} from "./kroger-auth";
import { latestMobileKrogerCartOperation } from "./kroger-cart-operations";
import { mobileSessionsAreConfigured } from "./mobile-session";
import { withMobileOwnerOperationLock } from "./mobile-owner-operation-lock";
import { mobileSecureStateStatus, requireMobileSecureState } from "./mobile-secure-state";
import "./server-only-guard";

const MOBILE_CALLBACK_PATH = "/api/mobile/v1/kroger/oauth/callback";
const MOBILE_RETURN_URI = "cartiva://oauth/kroger";
export const MOBILE_KROGER_SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MOBILE_KROGER_SESSION_TOUCH_INTERVAL_MS = 60 * 60_000;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const OAUTH_COMPLETION_TTL_MS = 5 * 60_000;
// A disconnect marker only has to outlive every older claimed state or staged
// completion. Expiring it also prevents dormant markers from pinning an old
// signing key beyond the supported current + previous rotation window.
const OWNER_DISCONNECT_MARKER_TTL_MS = Math.max(
  OAUTH_STATE_TTL_MS,
  OAUTH_COMPLETION_TTL_MS,
);
const OAUTH_COMPLETION_JANITOR_INTERVAL_MS = 60_000;
const OAUTH_START_LIMIT = 8;

interface MobileKrogerConfiguration extends KrogerAuthConfig {
  redirectUri: string;
  appReturnUri: string;
}

interface PendingMobileAuthorizationPayload {
  version: 1;
  stateHash: string;
  ownerId: string;
  comparisonId: string;
  issuedAt: number;
  expiresAt: number;
}

interface StoredPendingMobileAuthorization extends PendingMobileAuthorizationPayload {
  mac: string;
}

export interface PendingMobileAuthorization {
  ownerId: string;
  comparisonId: string;
  issuedAt: number;
  expiresAt: number;
}

interface MobileAuthorizationCompletionPayload {
  version: 1;
  completionHash: string;
  ownerId: string;
  comparisonId: string;
  sessionDigest: string;
  /** OAuth-state epoch used to invalidate staged tokens across disconnects. */
  issuedAt: number;
  expiresAt: number;
}

interface StoredMobileAuthorizationCompletion extends MobileAuthorizationCompletionPayload {
  mac: string;
}

export interface PendingMobileAuthorizationCompletion {
  completion: string;
  comparisonId: string;
  expiresAt: number;
}

export type MobileKrogerAuthorizationState =
  | "CONNECTED"
  | "NOT_CONNECTED"
  | "UNAVAILABLE";

export interface MobileKrogerCapabilityStatus {
  mode: "CART_TRANSFER_SUPPORTED" | "SHOPPING_PAGE_ONLY";
  cartTransferSupported: boolean;
  requiresRetailerCheckout: true;
  requiresCustomerAuthorization: boolean;
  cartApiLocationBound: false;
  requiresStoreConfirmation: true;
  configured: boolean;
  reason?: string;
}

function clean(value: string | undefined) {
  return value?.trim() ?? "";
}

function configuration(): MobileKrogerConfiguration {
  const clientId = clean(process.env.KROGER_CLIENT_ID);
  const clientSecret = clean(process.env.KROGER_CLIENT_SECRET);
  const redirectUri = clean(process.env.KROGER_MOBILE_REDIRECT_URI);
  const configuredAppReturnUri = clean(process.env.CARTIVA_MOBILE_APP_RETURN_URI);
  if (!clientId || !clientSecret) {
    throw new KrogerAuthError(
      "Kroger customer authorization credentials are not configured.",
      "configuration",
      503,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new KrogerAuthError(
      "Kroger mobile authorization needs a registered HTTPS callback.",
      "configuration",
      503,
    );
  }
  if (
    parsed.protocol !== "https:"
    || parsed.pathname !== MOBILE_CALLBACK_PATH
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new KrogerAuthError(
      `KROGER_MOBILE_REDIRECT_URI must be an HTTPS URL ending in ${MOBILE_CALLBACK_PATH}.`,
      "configuration",
      503,
    );
  }
  const appReturnUri = configuredAppReturnUri
    || (process.env.NODE_ENV === "production" ? "" : MOBILE_RETURN_URI);
  let parsedAppReturn: URL;
  try {
    parsedAppReturn = new URL(appReturnUri);
  } catch {
    throw new KrogerAuthError(
      "Kroger mobile authorization needs a claimed Cartiva app return link.",
      "configuration",
      503,
    );
  }
  const isDevelopmentScheme = process.env.NODE_ENV !== "production"
    && parsedAppReturn.protocol === "cartiva:"
    && parsedAppReturn.hostname === "oauth"
    && parsedAppReturn.pathname === "/kroger";
  const isClaimedHttpsLink = parsedAppReturn.protocol === "https:"
    && parsedAppReturn.pathname === "/oauth/kroger"
    && !parsedAppReturn.username
    && !parsedAppReturn.password
    && !parsedAppReturn.port
    && !parsedAppReturn.search
    && !parsedAppReturn.hash;
  if (!isDevelopmentScheme && !isClaimedHttpsLink) {
    throw new KrogerAuthError(
      process.env.NODE_ENV === "production"
        ? "CARTIVA_MOBILE_APP_RETURN_URI must be an HTTPS universal link claimed by the Cartiva iOS app and ending in /oauth/kroger."
        : "CARTIVA_MOBILE_APP_RETURN_URI must be a claimed HTTPS /oauth/kroger link or the development cartiva://oauth/kroger scheme.",
      "configuration",
      503,
    );
  }
  if (!mobileSessionsAreConfigured()) {
    throw new KrogerAuthError(
      "Secure temporary mobile sessions are not configured.",
      "configuration",
      503,
    );
  }
  try {
    requireMobileSecureState();
  } catch (error) {
    throw new KrogerAuthError(
      error instanceof Error ? error.message : "Secure mobile state is not configured.",
      "configuration",
      503,
    );
  }
  ensureCompletionJanitor();
  return { clientId, clientSecret, redirectUri, appReturnUri };
}

export function mobileKrogerCapabilityStatus(): MobileKrogerCapabilityStatus {
  try {
    configuration();
    return {
      mode: "CART_TRANSFER_SUPPORTED",
      cartTransferSupported: true,
      requiresRetailerCheckout: true,
      requiresCustomerAuthorization: true,
      cartApiLocationBound: false,
      requiresStoreConfirmation: true,
      configured: true,
    };
  } catch {
    const secureState = mobileSecureStateStatus();
    return {
      mode: "SHOPPING_PAGE_ONLY",
      cartTransferSupported: false,
      requiresRetailerCheckout: true,
      requiresCustomerAuthorization: true,
      cartApiLocationBound: false,
      requiresStoreConfirmation: true,
      configured: false,
      reason: secureState.configured
        ? "Kroger customer cart transfer needs a registered secure callback and server session configuration."
        : secureState.reason,
    };
  }
}

function stateDirectory() {
  return process.env.CARTIVA_MOBILE_OAUTH_STATE_DIR?.trim()
    ? path.resolve(process.env.CARTIVA_MOBILE_OAUTH_STATE_DIR.trim())
    : path.resolve(".cartiva", "mobile-kroger-oauth");
}

function sessionDirectory() {
  return process.env.CARTIVA_MOBILE_KROGER_SESSION_DIR?.trim()
    ? path.resolve(process.env.CARTIVA_MOBILE_KROGER_SESSION_DIR.trim())
    : path.resolve(".cartiva", "mobile-kroger-sessions");
}

function completionDirectory() {
  return process.env.CARTIVA_MOBILE_OAUTH_COMPLETION_DIR?.trim()
    ? path.resolve(process.env.CARTIVA_MOBILE_OAUTH_COMPLETION_DIR.trim())
    : path.resolve(".cartiva", "mobile-kroger-oauth-completions");
}

function completionOwnerDirectory(ownerId: string) {
  return path.join(completionDirectory(), ownerId);
}

function completionHash(completion: string) {
  return createHash("sha256")
    .update("Cartiva mobile Kroger OAuth completion\0", "utf8")
    .update(completion, "utf8")
    .digest("hex");
}

function completionRecordFile(ownerId: string, hash: string) {
  return path.join(completionOwnerDirectory(ownerId), `${hash}.json`);
}

function completionSessionFile(ownerId: string, hash: string) {
  return path.join(completionOwnerDirectory(ownerId), `${hash}.session`);
}

function claimedCompletionFile(ownerId: string, hash: string) {
  return path.join(
    completionOwnerDirectory(ownerId),
    `${hash}.${process.pid}.${randomBytes(6).toString("hex")}.claimed`,
  );
}

function completionPayloadText(payload: MobileAuthorizationCompletionPayload) {
  return [
    "Cartiva mobile Kroger OAuth completion v1",
    payload.version,
    payload.completionHash,
    payload.ownerId,
    payload.comparisonId,
    payload.sessionDigest,
    payload.issuedAt,
    payload.expiresAt,
  ].join("\n");
}

function completionMac(payload: MobileAuthorizationCompletionPayload) {
  return createHmac("sha256", stateKey())
    .update(completionPayloadText(payload), "utf8")
    .digest("base64url");
}

function completionMacIsValid(
  payload: MobileAuthorizationCompletionPayload,
  supplied: string,
) {
  return sealedMacIsValid(completionPayloadText(payload), supplied);
}

function validStoredCompletion(value: unknown): value is StoredMobileAuthorizationCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 8
    && record.version === 1
    && typeof record.completionHash === "string"
    && /^[a-f0-9]{64}$/.test(record.completionHash)
    && typeof record.ownerId === "string"
    && validOwnerId(record.ownerId)
    && typeof record.comparisonId === "string"
    && validComparisonId(record.comparisonId)
    && typeof record.sessionDigest === "string"
    && /^[a-f0-9]{64}$/.test(record.sessionDigest)
    && typeof record.issuedAt === "number"
    && Number.isSafeInteger(record.issuedAt)
    && record.issuedAt > 0
    && typeof record.expiresAt === "number"
    && Number.isSafeInteger(record.expiresAt)
    && record.expiresAt > record.issuedAt
    && typeof record.mac === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(record.mac);
}

function missingFile(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT",
  );
}

function completionStorageError() {
  return new KrogerAuthError(
    "Cartiva could not safely verify the pending Kroger connection. Start again later.",
    "storage",
    503,
  );
}

async function readAuthorizationCompletion(ownerId: string, completion: string) {
  if (!validOwnerId(ownerId) || !/^[A-Za-z0-9_-]{43}$/.test(completion)) {
    throw new KrogerAuthError(
      "This Kroger connection completion is invalid or expired.",
      "oauth_binding",
      400,
    );
  }
  const hash = completionHash(completion);
  let serialized: string;
  try {
    serialized = await readFile(completionRecordFile(ownerId, hash), "utf8");
  } catch (error) {
    if (missingFile(error)) {
      throw new KrogerAuthError(
        "This Kroger connection completion is invalid or expired.",
        "oauth_binding",
        400,
      );
    }
    throw completionStorageError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw completionStorageError();
  }
  if (!validStoredCompletion(parsed)) throw completionStorageError();
  const { mac, ...payload } = parsed;
  if (
    payload.completionHash !== hash
    || payload.ownerId !== ownerId
    || !completionMacIsValid(payload, mac)
  ) {
    throw completionStorageError();
  }
  if (payload.expiresAt <= Date.now()) {
    try {
      await durableRemoveFile(completionRecordFile(ownerId, hash));
      await durableRemoveFile(completionSessionFile(ownerId, hash));
    } catch {
      throw completionStorageError();
    }
    throw new KrogerAuthError(
      "This Kroger connection completion expired. Start again.",
      "oauth_binding",
      400,
    );
  }
  return { payload, hash };
}

async function verifyCompletionSessionDigest(
  ownerId: string,
  hash: string,
  expectedDigest: string,
) {
  let encryptedSession: Buffer;
  try {
    encryptedSession = await readFile(completionSessionFile(ownerId, hash));
  } catch {
    throw completionStorageError();
  }
  const actualDigest = createHash("sha256").update(encryptedSession).digest("hex");
  if (!safeEqual(actualDigest, expectedDigest)) throw completionStorageError();
}

async function removeOwnerAuthorizationCompletions(ownerId: string) {
  const directory = completionOwnerDirectory(ownerId);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (missingFile(error)) return;
    throw completionStorageError();
  }
  if (entries.some((entry) => !/^[a-f0-9]{64}(?:\.json|\.session|\.\d+\.[a-f0-9]{12}\.claimed|\.json\.\d+\.[a-f0-9]{12}\.tmp)$/.test(entry))) {
    throw completionStorageError();
  }
  try {
    for (const entry of entries) {
      await durableRemoveFile(path.join(directory, entry));
    }
  } catch {
    throw completionStorageError();
  }
}

async function pruneOwnerAuthorizationCompletionsUnlocked(
  ownerId: string,
  now = Date.now(),
) {
  const directory = completionOwnerDirectory(ownerId);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (missingFile(error)) return 0;
    throw completionStorageError();
  }
  if (entries.some((entry) => !/^[a-f0-9]{64}(?:\.json|\.session|\.\d+\.[a-f0-9]{12}\.claimed|\.json\.\d+\.[a-f0-9]{12}\.tmp)$/.test(entry))) {
    throw completionStorageError();
  }

  const recordHashes = new Set(
    entries
      .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
      .map((entry) => entry.slice(0, 64)),
  );
  let pendingCount = 0;
  for (const hash of recordHashes) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(completionRecordFile(ownerId, hash), "utf8"));
    } catch {
      throw completionStorageError();
    }
    if (!validStoredCompletion(parsed)) throw completionStorageError();
    const { mac, ...payload } = parsed;
    if (
      payload.ownerId !== ownerId
      || payload.completionHash !== hash
      || !completionMacIsValid(payload, mac)
    ) {
      throw completionStorageError();
    }
    if (payload.expiresAt <= now) {
      try {
        await rm(completionRecordFile(ownerId, hash), { force: true });
        await rm(completionSessionFile(ownerId, hash), { force: true });
      } catch {
        throw completionStorageError();
      }
      continue;
    }
    await verifyCompletionSessionDigest(ownerId, hash, payload.sessionDigest);
    pendingCount += 1;
  }

  // A staged encrypted token without its signed record cannot ever be safely
  // activated. Remove it while holding the owner lock so it cannot be a
  // callback that is between token exchange and record publication.
  for (const entry of entries.filter((value) => /^[a-f0-9]{64}\.session$/.test(value))) {
    const hash = entry.slice(0, 64);
    if (recordHashes.has(hash)) continue;
    try {
      await rm(completionSessionFile(ownerId, hash), { force: true });
    } catch {
      throw completionStorageError();
    }
  }

  // Temporary/claimed records can exist only after a crashed process because
  // this owner lock excludes active preparation and activation in the current
  // supported deployment. They are unusable and safe to remove.
  for (const entry of entries.filter((value) => value.endsWith(".tmp") || value.endsWith(".claimed"))) {
    try {
      await rm(path.join(directory, entry), { force: true });
    } catch {
      throw completionStorageError();
    }
  }
  return pendingCount;
}

export async function pruneExpiredMobileKrogerAuthorizationCompletions(
  now = Date.now(),
) {
  let owners: string[];
  try {
    owners = await readdir(completionDirectory());
  } catch (error) {
    if (missingFile(error)) return;
    throw completionStorageError();
  }
  if (owners.some((ownerId) => !validOwnerId(ownerId))) throw completionStorageError();
  // Never hold two owner locks at once. Global activity eventually removes
  // abandoned refresh tokens without introducing cross-owner deadlocks.
  for (const ownerId of owners.sort()) {
    await withMobileOwnerOperationLock(ownerId, () => (
      pruneOwnerAuthorizationCompletionsUnlocked(ownerId, now)
    ));
  }
}

export async function pruneExpiredMobileKrogerSessions(
  _activeOwnerId?: string,
  now = Date.now(),
) {
  let entries: string[];
  try {
    entries = await readdir(sessionDirectory());
  } catch (error) {
    if (missingFile(error)) return;
    throw mobileKrogerSessionStorageError();
  }
  if (entries.some((entry) => entry.endsWith(".json") && !/^[a-f0-9]{64}\.json$/.test(entry))) {
    throw mobileKrogerSessionStorageError();
  }
  for (const entry of entries.filter((value) => /^[a-f0-9]{64}\.json$/.test(value)).sort()) {
    const ownerId = entry.slice(0, -5);
    await withMobileOwnerOperationLock(ownerId, () => (
      validateMobileKrogerSessionFileUnlocked(ownerId, now, false)
    ));
  }
}

function mobileKrogerSessionStorageError() {
  return new KrogerAuthError(
    "Cartiva could not verify the saved Kroger connection. Disconnect it explicitly or restore secure storage before reconnecting.",
    "storage",
    503,
  );
}

/** Call only while holding this owner's operation lock. */
async function validateMobileKrogerSessionFileUnlocked(
  ownerId: string,
  now = Date.now(),
  touch = true,
) {
  const file = path.join(sessionDirectory(), `${ownerId}.json`);
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(file);
  } catch (error) {
    if (missingFile(error)) return false;
    throw mobileKrogerSessionStorageError();
  }
  if (!metadata.isFile()) throw mobileKrogerSessionStorageError();
  const disconnectedAt = await ownerDisconnectedAt(ownerId, true);
  if (disconnectedAt && metadata.mtimeMs <= disconnectedAt) {
    try {
      await durableRemoveFile(file);
      // Also clears an expired marker now that no pre-disconnect token can
      // survive it. A fresh marker remains for still-running old callbacks.
      await ownerDisconnectedAt(ownerId);
    } catch {
      throw mobileKrogerSessionStorageError();
    }
    clients().delete(ownerId);
    return false;
  }
  // A newly activated file is newer than the marker. Retire only an expired
  // marker; a live one still invalidates pre-disconnect callback payloads.
  if (disconnectedAt) await ownerDisconnectedAt(ownerId);
  if (metadata.mtimeMs + MOBILE_KROGER_SESSION_RETENTION_MS <= now) {
    try {
      await durableRemoveFile(file);
    } catch (error) {
      if (!missingFile(error)) throw mobileKrogerSessionStorageError();
    }
    clients().delete(ownerId);
    return false;
  }
  if (touch && metadata.mtimeMs + MOBILE_KROGER_SESSION_TOUCH_INTERVAL_MS <= now) {
    try {
      const accessedAt = new Date(now);
      await utimes(file, accessedAt, accessedAt);
    } catch {
      throw mobileKrogerSessionStorageError();
    }
  }
  return true;
}

function stateHash(state: string) {
  return createHash("sha256")
    .update("Cartiva mobile Kroger OAuth state\0", "utf8")
    .update(state, "utf8")
    .digest("hex");
}

function deriveStateKey(secret: string) {
  return createHash("sha256")
    .update("Cartiva mobile Kroger OAuth state seal\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

function stateKey() {
  const secret = clean(process.env.CARTIVA_SESSION_SECRET);
  if (secret.length < 32) {
    throw new KrogerAuthError(
      "Secure temporary mobile sessions are not configured.",
      "configuration",
      503,
    );
  }
  return deriveStateKey(secret);
}

function stateVerificationKeys() {
  const current = stateKey();
  const previousSecret = clean(process.env.CARTIVA_SESSION_PREVIOUS_SECRET);
  if (!previousSecret) return [current];
  if (previousSecret.length < 32) {
    throw new KrogerAuthError(
      "The previous mobile session signing secret is invalid.",
      "configuration",
      503,
    );
  }
  const previous = deriveStateKey(previousSecret);
  return timingSafeEqual(current, previous) ? [current] : [current, previous];
}

function sealedMacIsValid(value: string, supplied: string) {
  return stateVerificationKeys().some((key) => safeEqual(
    createHmac("sha256", key).update(value, "utf8").digest("base64url"),
    supplied,
  ));
}

function payloadText(payload: PendingMobileAuthorizationPayload) {
  return [
    payload.version,
    payload.stateHash,
    payload.ownerId,
    payload.comparisonId,
    payload.issuedAt,
    payload.expiresAt,
  ].join("\n");
}

function stateMac(payload: PendingMobileAuthorizationPayload) {
  return createHmac("sha256", stateKey()).update(payloadText(payload), "utf8").digest("base64url");
}

function stateMacIsValid(payload: PendingMobileAuthorizationPayload, supplied: string) {
  return sealedMacIsValid(payloadText(payload), supplied);
}

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validOwnerId(value: string) {
  return /^[a-f0-9]{64}$/.test(value);
}

function validComparisonId(value: string) {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function validStoredState(value: unknown): value is StoredPendingMobileAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 7
    && record.version === 1
    && typeof record.stateHash === "string"
    && /^[a-f0-9]{64}$/.test(record.stateHash)
    && typeof record.ownerId === "string"
    && validOwnerId(record.ownerId)
    && typeof record.comparisonId === "string"
    && validComparisonId(record.comparisonId)
    && typeof record.issuedAt === "number"
    && Number.isSafeInteger(record.issuedAt)
    && record.issuedAt > 0
    && typeof record.expiresAt === "number"
    && Number.isSafeInteger(record.expiresAt)
    && record.expiresAt > record.issuedAt
    && typeof record.mac === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(record.mac);
}

function stateFile(hash: string) {
  return path.join(stateDirectory(), `${hash}.json`);
}

function ownerDisconnectMarkerFile(ownerId: string) {
  return path.join(stateDirectory(), `${ownerId}.disconnected`);
}

interface OwnerDisconnectMarkerPayload {
  version: 1;
  ownerId: string;
  disconnectedAt: number;
}

interface StoredOwnerDisconnectMarker extends OwnerDisconnectMarkerPayload {
  mac: string;
}

function ownerDisconnectMarkerMac(payload: OwnerDisconnectMarkerPayload) {
  return createHmac("sha256", stateKey()).update([
    "Cartiva mobile Kroger disconnect marker v1",
    payload.version,
    payload.ownerId,
    payload.disconnectedAt,
  ].join("\n"), "utf8").digest("base64url");
}

function ownerDisconnectMarkerMacIsValid(
  payload: OwnerDisconnectMarkerPayload,
  supplied: string,
) {
  return sealedMacIsValid([
    "Cartiva mobile Kroger disconnect marker v1",
    payload.version,
    payload.ownerId,
    payload.disconnectedAt,
  ].join("\n"), supplied);
}

function validOwnerDisconnectMarker(value: unknown): value is StoredOwnerDisconnectMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4
    && record.version === 1
    && typeof record.ownerId === "string"
    && validOwnerId(record.ownerId)
    && typeof record.disconnectedAt === "number"
    && Number.isSafeInteger(record.disconnectedAt)
    && record.disconnectedAt > 0
    && typeof record.mac === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(record.mac);
}

async function ownerDisconnectedAt(ownerId: string, retainExpired = false) {
  const file = ownerDisconnectMarkerFile(ownerId);
  let serialized: string;
  try {
    const metadata = await stat(file);
    if (!retainExpired && metadata.mtimeMs + OWNER_DISCONNECT_MARKER_TTL_MS <= Date.now()) {
      await durableRemoveFile(file);
      return 0;
    }
    serialized = await readFile(file, "utf8");
  } catch (error) {
    if (missingFile(error)) return 0;
    throw completionStorageError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw completionStorageError();
  }
  if (!validOwnerDisconnectMarker(parsed) || parsed.ownerId !== ownerId) {
    throw completionStorageError();
  }
  const { mac, ...payload } = parsed;
  if (!ownerDisconnectMarkerMacIsValid(payload, mac)) throw completionStorageError();
  return payload.disconnectedAt;
}

async function markOwnerDisconnected(ownerId: string) {
  const file = ownerDisconnectMarkerFile(ownerId);
  const disconnectedAt = Math.max(Date.now(), (await ownerDisconnectedAt(ownerId)) + 1);
  const payload: OwnerDisconnectMarkerPayload = { version: 1, ownerId, disconnectedAt };
  const marker: StoredOwnerDisconnectMarker = {
    ...payload,
    mac: ownerDisconnectMarkerMac(payload),
  };
  try {
    await durableAtomicWriteFile(file, JSON.stringify(marker));
  } catch {
    throw completionStorageError();
  }
  return disconnectedAt;
}

async function removeOwnerAuthorizationStates(ownerId: string) {
  let entries: string[];
  try {
    entries = await readdir(stateDirectory());
  } catch (error) {
    if (missingFile(error)) return;
    throw completionStorageError();
  }
  for (const entry of entries.filter((value) => value.endsWith(".json"))) {
    const file = path.join(stateDirectory(), entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw completionStorageError();
    }
    if (!validStoredState(parsed)) throw completionStorageError();
    const { mac, ...payload } = parsed;
    if (
      entry !== `${payload.stateHash}.json`
      || !stateMacIsValid(payload, mac)
    ) throw completionStorageError();
    if (payload.ownerId === ownerId) {
      try {
        await durableRemoveFile(file);
      } catch {
        throw completionStorageError();
      }
    }
  }
}

function claimedStateFile(hash: string) {
  return path.join(
    stateDirectory(),
    `${hash}.${process.pid}.${randomBytes(6).toString("hex")}.claimed`,
  );
}

async function pruneAndCountPendingAuthorizationStates(
  ownerId: string,
  now = Date.now(),
) {
  let entries: string[] = [];
  try {
    entries = await readdir(stateDirectory());
  } catch {
    return 0;
  }
  let ownerPending = 0;
  for (const entry of entries) {
    const file = path.join(stateDirectory(), entry);
    if (entry.endsWith(".json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
      } catch {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (!validStoredState(parsed) || parsed.expiresAt <= now) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (parsed.ownerId === ownerId) ownerPending += 1;
      continue;
    }
    if (!entry.endsWith(".claimed") && !entry.endsWith(".tmp")) continue;
    try {
      const metadata = await stat(file);
      if (metadata.mtimeMs + OAUTH_STATE_TTL_MS <= now) {
        await rm(file, { force: true });
      }
    } catch {
      // Another request may already have consumed or cleaned this state.
    }
  }
  return ownerPending;
}

async function registerAuthorizationState(
  ownerId: string,
  comparisonId: string,
) {
  if (!validOwnerId(ownerId) || !validComparisonId(comparisonId)) {
    throw new KrogerAuthError("The Cartiva comparison session is invalid.", "oauth_state", 400);
  }
  return serializeOwnerStateRegistration(ownerId, async () => {
    enforceOwnerAuthorizationStart(ownerId);
    await mkdir(stateDirectory(), { recursive: true });
    const pendingCount = await pruneAndCountPendingAuthorizationStates(ownerId);
    if (pendingCount >= OAUTH_START_LIMIT) {
      throw new KrogerAuthError(
        "Too many Kroger connection attempts. Wait a few minutes and try again.",
        "rate_limit",
        429,
      );
    }
    const state = randomBytes(32).toString("base64url");
    const issuedAt = Math.max(Date.now(), (await ownerDisconnectedAt(ownerId)) + 1);
    const payload: PendingMobileAuthorizationPayload = {
      version: 1,
      stateHash: stateHash(state),
      ownerId,
      comparisonId,
      issuedAt,
      expiresAt: issuedAt + OAUTH_STATE_TTL_MS,
    };
    const record: StoredPendingMobileAuthorization = { ...payload, mac: stateMac(payload) };
    const file = stateFile(payload.stateHash);
    try {
      await durableAtomicWriteFile(file, JSON.stringify(record));
    } catch {
      throw completionStorageError();
    }
    return state;
  });
}

export async function consumeMobileKrogerAuthorizationState(
  state: string,
): Promise<PendingMobileAuthorization> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw new KrogerAuthError(
      "This Kroger connection request is invalid.",
      "oauth_state",
      400,
    );
  }
  const hash = stateHash(state);
  const inProcessClaims = stateClaims();
  if (inProcessClaims.has(hash)) {
    throw new KrogerAuthError(
      "This Kroger connection request expired or was already used.",
      "oauth_state",
      400,
    );
  }
  // The supported file-backed deployment is explicitly one process. Reserve
  // synchronously before the first await because Windows/OneDrive filesystem
  // layers do not consistently serialize concurrent rename calls themselves.
  inProcessClaims.add(hash);
  try {
    const file = stateFile(hash);
    const claimedFile = claimedStateFile(hash);
    try {
      // Claim by renaming in the same directory before reading. The filesystem
      // rename is atomic, so concurrent callbacks cannot both consume one state.
      // A process crash after this point also fails closed because the original
      // pending-state path no longer exists.
      await durableRename(file, claimedFile);
    } catch {
      throw new KrogerAuthError(
        "This Kroger connection request expired or was already used.",
        "oauth_state",
        400,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(claimedFile, "utf8"));
    } catch {
      throw new KrogerAuthError(
        "This Kroger connection request is invalid.",
        "oauth_state",
        400,
      );
    } finally {
      // OAuth state is one-use even when the record is malformed. Cleanup is
      // best-effort: an undeletable claim is still unusable because the pending
      // path was atomically removed above.
      await durableRemoveFile(claimedFile).catch(() => undefined);
    }
    if (!validStoredState(parsed)) {
      throw new KrogerAuthError("This Kroger connection request is invalid.", "oauth_state", 400);
    }
    const { mac, ...payload } = parsed;
    if (
      payload.stateHash !== hash
      || !stateMacIsValid(payload, mac)
      || payload.expiresAt <= Date.now()
    ) {
      throw new KrogerAuthError(
        "This Kroger connection request expired or could not be verified.",
        "oauth_state",
        400,
      );
    }
    return {
      ownerId: payload.ownerId,
      comparisonId: payload.comparisonId,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    };
  } finally {
    inProcessClaims.delete(hash);
  }
}

type MobileKrogerGlobal = typeof globalThis & {
  __cartivaMobileKrogerAuthClients?: Map<string, KrogerAuthClient>;
  __cartivaMobileKrogerStateClaims?: Set<string>;
  __cartivaMobileKrogerCompletionClaims?: Set<string>;
  __cartivaMobileKrogerAuthorizationStarts?: Map<string, number[]>;
  __cartivaMobileKrogerStateRegistrations?: Map<string, Promise<void>>;
  __cartivaMobileKrogerCompletionJanitor?: ReturnType<typeof setInterval>;
};

function ensureCompletionJanitor() {
  const globalState = globalThis as MobileKrogerGlobal;
  if (globalState.__cartivaMobileKrogerCompletionJanitor) return;
  const prune = () => (
    Promise.all([
      pruneExpiredMobileKrogerAuthorizationCompletions(),
      pruneExpiredMobileKrogerSessions(),
    ]).catch((error) => {
      // Structural diagnostics only; never log completion handles, owners, or
      // provider data. Foreground auth/cart paths independently fail closed.
      console.error("Cartiva OAuth completion janitor failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: error instanceof KrogerAuthError ? error.code : "unexpected",
      });
    })
  );
  void prune();
  const timer = setInterval(prune, OAUTH_COMPLETION_JANITOR_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  globalState.__cartivaMobileKrogerCompletionJanitor = timer;
}

function stateClaims() {
  const globalState = globalThis as MobileKrogerGlobal;
  globalState.__cartivaMobileKrogerStateClaims ??= new Set();
  return globalState.__cartivaMobileKrogerStateClaims;
}

function completionClaims() {
  const globalState = globalThis as MobileKrogerGlobal;
  globalState.__cartivaMobileKrogerCompletionClaims ??= new Set();
  return globalState.__cartivaMobileKrogerCompletionClaims;
}

function enforceOwnerAuthorizationStart(ownerId: string, now = Date.now()) {
  const globalState = globalThis as MobileKrogerGlobal;
  globalState.__cartivaMobileKrogerAuthorizationStarts ??= new Map();
  const recent = (globalState.__cartivaMobileKrogerAuthorizationStarts.get(ownerId) ?? [])
    .filter((startedAt) => startedAt + OAUTH_STATE_TTL_MS > now);
  if (recent.length >= OAUTH_START_LIMIT) {
    throw new KrogerAuthError(
      "Too many Kroger connection attempts. Wait a few minutes and try again.",
      "rate_limit",
      429,
    );
  }
  recent.push(now);
  globalState.__cartivaMobileKrogerAuthorizationStarts.set(ownerId, recent);
}

function serializeOwnerStateRegistration<T>(ownerId: string, operation: () => Promise<T>) {
  const globalState = globalThis as MobileKrogerGlobal;
  globalState.__cartivaMobileKrogerStateRegistrations ??= new Map();
  const registrations = globalState.__cartivaMobileKrogerStateRegistrations;
  const previous = registrations.get(ownerId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(() => undefined, () => undefined);
  registrations.set(ownerId, settled);
  return current.finally(() => {
    if (registrations.get(ownerId) === settled) registrations.delete(ownerId);
  });
}

function clients() {
  const globalState = globalThis as MobileKrogerGlobal;
  globalState.__cartivaMobileKrogerAuthClients ??= new Map();
  return globalState.__cartivaMobileKrogerAuthClients;
}

async function requireNoUnreviewedMobileCartOperation(ownerId: string) {
  const previous = await latestMobileKrogerCartOperation(ownerId);
  if (!previous) return;
  throw new KrogerAuthError(
    previous.status === "OUTCOME_UNKNOWN"
      ? "A previous Kroger cart update could not be confirmed. Check and review that retailer cart before connecting again."
      : "A previous Kroger cart was added. Review it before connecting Kroger again.",
    "cart_history",
    409,
  );
}

export function getMobileKrogerAuthClient(ownerId: string) {
  if (!validOwnerId(ownerId)) {
    throw new KrogerAuthError("The Cartiva session owner is invalid.", "oauth_state", 400);
  }
  // Re-evaluate the kill switch and deployment gates on every use. Returning
  // a cached token client must never bypass a runtime cart-write disable.
  const config = configuration();
  const cached = clients().get(ownerId);
  if (cached) return cached;
  const client = new KrogerAuthClient({
    ...config,
    sessionFile: path.join(sessionDirectory(), `${ownerId}.json`),
    sessionBinding: ownerId,
    beforeCustomerSessionAccess: () => validateMobileKrogerSessionFileUnlocked(ownerId),
  }, fetch, async () => {
    // Confirmed/unknown comparison operations survive reconnects. Reusing a
    // submitted comparison with another retailer account is blocked at auth
    // start; the shopper must create a fresh comparison instead.
  });
  clients().set(ownerId, client);
  return client;
}

export async function createMobileKrogerAuthorization(
  ownerId: string,
  comparisonId: string,
  validateWhileOwnerLocked?: () => Promise<void>,
) {
  if (!validOwnerId(ownerId) || !validComparisonId(comparisonId)) {
    throw new KrogerAuthError("The Cartiva comparison session is invalid.", "oauth_state", 400);
  }
  // Fail before any pruning side effect, then recheck deployment gates after
  // waiting for the owner lock. Pruning stays outside that lock because it can
  // acquire locks for other owners; nesting those locks could deadlock two
  // concurrent authorization starts.
  configuration();
  await pruneExpiredMobileKrogerSessions(ownerId);
  await pruneExpiredMobileKrogerAuthorizationCompletions();
  return withMobileOwnerOperationLock(ownerId, async () => {
    const config = configuration();
    // Cart history, immutable comparison readiness, and account connection
    // must be checked in this same critical section as durable OAuth-state
    // registration. Otherwise a cart operation/disconnect can slip between a
    // route-level check and opening Safari.
    await validateWhileOwnerLocked?.();
    const connection = await mobileKrogerConnectionStatusUnlocked(ownerId);
    if (connection.authorization === "CONNECTED") {
      throw new KrogerAuthError(
        "Kroger is already connected for this Cartiva session. Disconnect before changing accounts.",
        "already_connected",
        409,
      );
    }
    const state = await registerAuthorizationState(ownerId, comparisonId);
    return getMobileKrogerAuthClient(ownerId)
      .createAuthorizationUrlAfterExternalStateRegistration(state, config.redirectUri);
  });
}

export async function prepareMobileKrogerAuthorizationCompletion(
  pending: PendingMobileAuthorization,
  code: string,
): Promise<PendingMobileAuthorizationCompletion> {
  const config = configuration();
  await pruneExpiredMobileKrogerAuthorizationCompletions();
  return withMobileOwnerOperationLock(pending.ownerId, async () => {
    if (pending.expiresAt <= Date.now()) {
      throw new KrogerAuthError(
        "This Kroger connection request expired. Start again.",
        "oauth_state",
        400,
      );
    }
    if (pending.issuedAt <= await ownerDisconnectedAt(pending.ownerId)) {
      throw new KrogerAuthError(
        "This Kroger connection request was cancelled by disconnecting. Start again.",
        "oauth_state",
        400,
      );
    }
    // The browser may remain open after authorization state was registered.
    // Recheck durable cart history before exchanging a code so that an older
    // Safari flow cannot change account context after a cart outcome appeared.
    await requireNoUnreviewedMobileCartOperation(pending.ownerId);
    const client = getMobileKrogerAuthClient(pending.ownerId);
    if ((await client.connectionStatus()).connected) {
      throw new KrogerAuthError(
        "Kroger is already connected for this Cartiva session. Disconnect before changing accounts.",
        "already_connected",
        409,
      );
    }
    const pendingCount = await pruneOwnerAuthorizationCompletionsUnlocked(pending.ownerId);
    if (pendingCount >= OAUTH_START_LIMIT) {
      throw new KrogerAuthError(
        "Too many unfinished Kroger connections. Wait a few minutes and try again.",
        "rate_limit",
        429,
      );
    }
    const completion = randomBytes(32).toString("base64url");
    const hash = completionHash(completion);
    const directory = completionOwnerDirectory(pending.ownerId);
    const sessionFile = completionSessionFile(pending.ownerId, hash);
    const recordFile = completionRecordFile(pending.ownerId, hash);
    await mkdir(directory, { recursive: true });
    const pendingClient = new KrogerAuthClient({
      ...config,
      sessionFile,
      sessionBinding: pending.ownerId,
    }, fetch, async () => {
      // The callback only creates a pending encrypted session. The original
      // mobile bearer must present the opaque completion before activation.
    });
    try {
      await pendingClient.exchangeAuthorizationCodeAfterExternalStateValidation(
        code,
        config.redirectUri,
      );
      const payload: MobileAuthorizationCompletionPayload = {
        version: 1,
        completionHash: hash,
        ownerId: pending.ownerId,
        comparisonId: pending.comparisonId,
        sessionDigest: createHash("sha256")
          .update(await readFile(sessionFile))
          .digest("hex"),
        issuedAt: pending.issuedAt,
        expiresAt: Date.now() + OAUTH_COMPLETION_TTL_MS,
      };
      const record: StoredMobileAuthorizationCompletion = {
        ...payload,
        mac: completionMac(payload),
      };
      await durableAtomicWriteFile(recordFile, JSON.stringify(record));
      return {
        completion,
        comparisonId: pending.comparisonId,
        expiresAt: payload.expiresAt,
      };
    } catch (error) {
      await durableRemoveFile(recordFile).catch(() => undefined);
      await durableRemoveFile(sessionFile).catch(() => undefined);
      throw error;
    }
  });
}

export async function activateMobileKrogerAuthorization(
  ownerId: string,
  completion: string,
) {
  if (!validOwnerId(ownerId) || !/^[A-Za-z0-9_-]{43}$/.test(completion)) {
    throw new KrogerAuthError(
      "This Kroger connection completion is invalid or expired.",
      "oauth_binding",
      400,
    );
  }
  configuration();
  const hash = completionHash(completion);
  const claimKey = `${ownerId}:${hash}`;
  const claims = completionClaims();
  if (claims.has(claimKey)) {
    throw new KrogerAuthError(
      "This Kroger connection completion is already being used.",
      "oauth_binding",
      409,
    );
  }
  // Reserve before the first await. The reviewed file-backed deployment uses
  // one Node process, so this closes concurrent finalize attempts even where
  // the Windows/OneDrive filesystem cannot reliably arbitrate rename races.
  claims.add(claimKey);
  try {
    return await withMobileOwnerOperationLock(ownerId, async () => {
      const { payload } = await readAuthorizationCompletion(ownerId, completion);
      if (payload.ownerId !== ownerId) {
        throw new KrogerAuthError(
          "This Kroger connection completion belongs to another Cartiva session.",
          "oauth_binding",
          403,
        );
      }
      if (payload.issuedAt <= await ownerDisconnectedAt(ownerId)) {
        try {
          await rm(completionRecordFile(ownerId, hash), { force: true });
          await rm(completionSessionFile(ownerId, hash), { force: true });
        } catch {
          throw completionStorageError();
        }
        throw new KrogerAuthError(
          "This Kroger connection completion was cancelled by disconnecting. Start again.",
          "oauth_binding",
          400,
        );
      }
      // A cart operation can complete after the callback staged its encrypted
      // token but before the app redeems the handle. Never activate across an
      // unresolved retailer outcome.
      await requireNoUnreviewedMobileCartOperation(ownerId);
      const activeClient = getMobileKrogerAuthClient(ownerId);
      if ((await activeClient.connectionStatus()).connected) {
        throw new KrogerAuthError(
          "Kroger is already connected for this Cartiva session.",
          "already_connected",
          409,
        );
      }
      const recordFile = completionRecordFile(ownerId, hash);
      const claimedFile = claimedCompletionFile(ownerId, hash);
      try {
        await durableRename(recordFile, claimedFile);
      } catch (error) {
        if (missingFile(error)) {
          throw new KrogerAuthError(
            "This Kroger connection completion expired or was already used.",
            "oauth_binding",
            400,
          );
        }
        throw completionStorageError();
      }

      let activated = false;
      try {
        await verifyCompletionSessionDigest(ownerId, hash, payload.sessionDigest);
        await mkdir(sessionDirectory(), { recursive: true });
        await durableRename(
          completionSessionFile(ownerId, hash),
          path.join(sessionDirectory(), `${ownerId}.json`),
        );
        activated = true;
        clients().delete(ownerId);
        const verified = await getMobileKrogerAuthClient(ownerId).connectionStatus();
        if (!verified.connected) throw completionStorageError();
        await durableRemoveFile(claimedFile);
      } catch (error) {
        clients().delete(ownerId);
        if (!activated) {
          // Restore the record only when no customer session was activated.
          // If restoration itself fails, the claim remains unusable and the
          // operation fails closed instead of risking a second exchange.
          await durableRename(claimedFile, recordFile).catch(() => undefined);
        }
        if (error instanceof KrogerAuthError) throw error;
        throw completionStorageError();
      }
      return {
        retailer: "kroger" as const,
        authorization: "CONNECTED" as const,
        capability: mobileKrogerCapabilityStatus(),
        comparisonId: payload.comparisonId,
      };
    });
  } finally {
    claims.delete(claimKey);
  }
}

async function mobileKrogerConnectionStatusUnlocked(ownerId: string) {
  const capability = mobileKrogerCapabilityStatus();
  if (!capability.configured) {
    return {
      retailer: "kroger" as const,
      authorization: "UNAVAILABLE" as const,
      capability,
    };
  }
  const status = await getMobileKrogerAuthClient(ownerId).connectionStatus();
  return {
    retailer: "kroger" as const,
    authorization: status.connected
      ? "CONNECTED" as const
      : "NOT_CONNECTED" as const,
    capability,
  };
}

export async function mobileKrogerConnectionStatus(ownerId: string) {
  const capability = mobileKrogerCapabilityStatus();
  if (!capability.configured) {
    return {
      retailer: "kroger" as const,
      authorization: "UNAVAILABLE" as const,
      capability,
    };
  }
  if (!validOwnerId(ownerId)) {
    throw new KrogerAuthError("The Cartiva session owner is invalid.", "oauth_state", 400);
  }
  return withMobileOwnerOperationLock(ownerId, () => (
    mobileKrogerConnectionStatusUnlocked(ownerId)
  ));
}

export async function disconnectMobileKroger(ownerId: string) {
  if (!validOwnerId(ownerId)) {
    throw new KrogerAuthError("The Cartiva session owner is invalid.", "oauth_state", 400);
  }
  return withMobileOwnerOperationLock(ownerId, async () => {
    await disconnectMobileKrogerOwnerStateUnlocked(ownerId);
    // Do not call the public locked wrapper while already holding this owner's
    // lock. The unlocked helper verifies the post-disconnect state before a
    // refresh, OAuth callback, or cart operation can run for this owner.
    return mobileKrogerConnectionStatusUnlocked(ownerId);
  });
}

/** Call only while holding this owner's operation lock. */
export async function disconnectMobileKrogerOwnerStateUnlocked(ownerId: string) {
  if (!validOwnerId(ownerId)) {
    throw new KrogerAuthError("The Cartiva session owner is invalid.", "oauth_state", 400);
  }
    // Rotate the durable owner marker before removing state. A callback that
    // already claimed its state but is waiting on this lock is rejected by its
    // older issuedAt value after disconnect completes.
    await markOwnerDisconnected(ownerId);
    await removeOwnerAuthorizationStates(ownerId);
    // Invalidate any browser callback that has exchanged a token but has not
    // yet been activated by the initiating iPhone session.
    await removeOwnerAuthorizationCompletions(ownerId);
    const cached = clients().get(ownerId);
    clients().delete(ownerId);
    if (cached) {
      await cached.disconnect();
    } else {
      await durableRemoveFile(path.join(sessionDirectory(), `${ownerId}.json`));
    }
}

export function mobileKrogerReturnUrl(
  status: "pending" | "connected" | "cancelled" | "failed",
  comparisonId?: string,
  completion?: string,
) {
  const url = new URL(configuration().appReturnUri);
  url.searchParams.set("status", status);
  if (comparisonId && validComparisonId(comparisonId)) {
    url.searchParams.set("comparisonId", comparisonId);
  }
  if (status === "pending" && completion && /^[A-Za-z0-9_-]{43}$/.test(completion)) {
    url.searchParams.set("completion", completion);
  }
  return url.toString();
}

export function resetMobileKrogerAuthForTests() {
  const janitor = (globalThis as MobileKrogerGlobal).__cartivaMobileKrogerCompletionJanitor;
  if (janitor) clearInterval(janitor);
  delete (globalThis as MobileKrogerGlobal).__cartivaMobileKrogerAuthClients;
  delete (globalThis as MobileKrogerGlobal).__cartivaMobileKrogerStateClaims;
  delete (globalThis as MobileKrogerGlobal).__cartivaMobileKrogerCompletionClaims;
  delete (globalThis as MobileKrogerGlobal).__cartivaMobileKrogerAuthorizationStarts;
  delete (globalThis as MobileKrogerGlobal).__cartivaMobileKrogerStateRegistrations;
  delete (globalThis as MobileKrogerGlobal).__cartivaMobileKrogerCompletionJanitor;
}
