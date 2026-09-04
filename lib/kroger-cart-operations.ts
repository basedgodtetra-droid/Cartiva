import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RECEIPT_TTL_MS = 24 * 60 * 60_000;
const MAX_RECEIPT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_RECORDS = 4_096;
const MAX_OPERATION_ID_LENGTH = 256;
const MAX_FINGERPRINT_LENGTH = 256;
const MAX_CART_URL_LENGTH = 512;
const MAX_RETAILER_LABEL_LENGTH = 128;
const MAX_LOCATION_ID_LENGTH = 128;
const MAX_LOCATION_NAME_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 2_048;
// Missing/ambiguous retailer evidence never becomes safe merely with time.
// A mobile owner can clear this sentinel only through the explicit reviewed-
// cart acknowledgement; acknowledged history then receives the normal TTL.
const MOBILE_UNRESOLVED_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

export interface KrogerCartReceipt {
  operationId: string;
  requestFingerprint: string;
  success: true;
  addedCount: number;
  itemCount: number;
  cartUrl: string;
  chain: string;
  selectedSearchLocation: { locationId: string; name: string };
  locationBoundByCartApi: false;
  message: string;
  completedAt: string;
  expiresAt: number;
  mobileContext?: MobileKrogerCartOperationContext;
  acknowledgedAt?: string;
}

interface KrogerCartUnknownOutcome {
  operationId: string;
  requestFingerprint: string;
  outcomeUnknown: true;
  completedAt: string;
  expiresAt: number;
  mobileContext?: MobileKrogerCartOperationContext;
  acknowledgedAt?: string;
}

type KrogerCartOperationRecord = KrogerCartReceipt | KrogerCartUnknownOutcome;

export interface MobileKrogerCartOperationContext {
  ownerId: string;
  comparisonId: string;
  publicOperationId: string;
  cartUrl: string;
  retailerBanner: string;
  locationId: string;
  locationName: string;
  locationBoundByCartApi: false;
  storeSelectionMustBeConfirmed: true;
}

export type MobileKrogerCartOperationRecovery =
  | {
      status: "CONFIRMED";
      operationId: string;
      comparisonId: string;
      completedAt: string;
      message: string;
      addedCount: number;
      itemCount: number;
      handoff: {
        mode: "CART_TRANSFER_SUPPORTED";
        url: string;
        retailerBanner: string;
        locationId: string;
        locationName: string;
        locationBoundByCartApi: false;
        storeSelectionMustBeConfirmed: true;
      };
    }
  | {
      status: "OUTCOME_UNKNOWN";
      operationId: string;
      comparisonId: string;
      completedAt: string;
      message: string;
      retrySafe: false;
      reviewHandoff: {
        url: string;
        retailerBanner: string;
        locationId: string;
        locationName: string;
        locationBoundByCartApi: false;
        storeSelectionMustBeConfirmed: true;
      };
    };

export class KrogerCartOutcomeUnknownError extends Error {
  constructor() {
    super("Kroger's response was interrupted. Check the retailer cart before trying again.");
    this.name = "KrogerCartOutcomeUnknownError";
  }
}

export class KrogerCartOperationConflictError extends Error {
  constructor() {
    super("This Kroger cart operation ID was already used for a different cart.");
    this.name = "KrogerCartOperationConflictError";
  }
}

export class KrogerCartOperationAlreadyReviewedError extends Error {
  constructor() {
    super("This basket was previously submitted and reviewed. No new Kroger cart update was sent.");
    this.name = "KrogerCartOperationAlreadyReviewedError";
  }
}

export class KrogerCartOwnerOperationPendingError extends Error {
  constructor(readonly recovery: MobileKrogerCartOperationRecovery) {
    super(
      recovery.status === "CONFIRMED"
        ? "A Kroger cart was already added for this Cartiva session. Review it before starting another."
        : "A previous Kroger cart update could not be confirmed. Review the retailer cart before starting another.",
    );
    this.name = "KrogerCartOwnerOperationPendingError";
  }
}

/**
 * The durable duplicate-write guard could not be read or validated. Treat this
 * exactly like an unknown retailer outcome: retrying could issue a second PUT.
 */
export class KrogerCartOperationStateUnavailableError extends KrogerCartOutcomeUnknownError {
  constructor() {
    super();
    this.message = "Cartiva could not verify the previous Kroger cart operation. Check the retailer cart before trying again.";
    this.name = "KrogerCartOperationStateUnavailableError";
  }
}

export function mobileKrogerCartOperationIdentity(ownerId: string, comparisonId: string) {
  if (!/^[a-f0-9]{64}$/.test(ownerId) || !/^[A-Za-z0-9_-]{16,128}$/.test(comparisonId)) {
    throw new Error("A valid mobile owner and comparison are required.");
  }
  const publicOperationId = createHash("sha256")
    .update("Cartiva mobile Kroger comparison operation\0", "utf8")
    .update(ownerId, "utf8")
    .update("\0", "utf8")
    .update(comparisonId, "utf8")
    .digest("base64url");
  return {
    publicOperationId,
    internalOperationId: `mobile:${ownerId}:${publicOperationId}`,
  };
}

export async function mobileKrogerCartOperationStatus(ownerId: string, comparisonId: string) {
  const { internalOperationId } = mobileKrogerCartOperationIdentity(ownerId, comparisonId);
  const completed = await receipts();
  const existing = completed.get(internalOperationId);
  if (!existing || existing.expiresAt <= Date.now()) return null;
  return "outcomeUnknown" in existing ? "OUTCOME_UNKNOWN" as const : "CONFIRMED" as const;
}

type OperationGlobal = typeof globalThis & {
  __cartivaKrogerCartOperations?: {
    receipts?: Map<string, KrogerCartOperationRecord>;
    loading?: Promise<Map<string, KrogerCartOperationRecord>>;
    inFlight: Map<string, { requestFingerprint: string; promise: Promise<KrogerCartReceipt> }>;
  };
  __cartivaKrogerCartOperationFileMutation?: Promise<void>;
};

function state() {
  const globalState = globalThis as OperationGlobal;
  globalState.__cartivaKrogerCartOperations ??= { inFlight: new Map() };
  return globalState.__cartivaKrogerCartOperations;
}

function receiptFile() {
  // Serverless deployment bundles are read-only. The web cart flow still gets
  // the existing in-instance duplicate guard while each warm instance is
  // alive; ambiguous outcomes remain fail-closed and are never retried by the
  // UI.
  if (
    process.env.VERCEL === "1"
    || process.env.CARTIVA_SERVERLESS_WEB_SESSION === "true"
  ) {
    return path.join(os.tmpdir(), "cartiva-kroger-cart-receipts.json");
  }
  return process.env.KROGER_CART_RECEIPT_FILE?.trim()
    || path.resolve(".cartiva", "kroger-cart-receipts.json");
}

const TRUSTED_KROGER_CART_HOSTS = new Set([
  "www.kroger.com", "www.ralphs.com", "www.fredmeyer.com", "www.kingsoopers.com",
  "www.frysfood.com", "www.smithsfoodanddrug.com", "www.qfc.com", "www.dillons.com",
  "www.harristeeter.com", "www.marianos.com", "www.picknsave.com", "www.food4less.com",
  "www.citymarket.com", "www.bakersplus.com", "www.foodsco.net", "www.gerbes.com",
  "www.jaycfoods.com", "www.metromarket.net", "www.pay-less.com", "www.rulerfoods.com",
]);

function validBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength;
}

function validPossiblyEmptyBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === "string" && value.length <= maximumLength;
}

function validKrogerCartUrl(value: unknown) {
  if (!validBoundedString(value, MAX_CART_URL_LENGTH)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && TRUSTED_KROGER_CART_HOSTS.has(parsed.hostname.toLowerCase())
      && /^\/cart\/?$/.test(parsed.pathname)
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function validMobileContext(value: unknown): value is MobileKrogerCartOperationContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return Object.keys(context).length === 9
    && /^[a-f0-9]{64}$/.test(String(context.ownerId ?? ""))
    && /^[A-Za-z0-9_-]{16,128}$/.test(String(context.comparisonId ?? ""))
    && /^[A-Za-z0-9_-]{43}$/.test(String(context.publicOperationId ?? ""))
    && validKrogerCartUrl(context.cartUrl)
    && validBoundedString(context.retailerBanner, MAX_RETAILER_LABEL_LENGTH)
    && validBoundedString(context.locationId, MAX_LOCATION_ID_LENGTH)
    && validBoundedString(context.locationName, MAX_LOCATION_NAME_LENGTH)
    && context.locationBoundByCartApi === false
    && context.storeSelectionMustBeConfirmed === true;
}

function validRecord(value: unknown): value is KrogerCartOperationRecord {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt);
  const expectedKeys = receipt.outcomeUnknown === true
    ? [
        "operationId", "requestFingerprint", "outcomeUnknown", "completedAt",
        "expiresAt",
      ]
    : [
        "operationId", "requestFingerprint", "success", "addedCount", "itemCount",
        "cartUrl", "chain", "selectedSearchLocation", "locationBoundByCartApi",
        "message", "completedAt", "expiresAt",
      ];
  if (receipt.mobileContext !== undefined) expectedKeys.push("mobileContext");
  if (receipt.acknowledgedAt !== undefined) expectedKeys.push("acknowledgedAt");
  if (
    keys.length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(receipt, key))
  ) return false;
  const common = validBoundedString(receipt.operationId, MAX_OPERATION_ID_LENGTH)
    && validBoundedString(receipt.requestFingerprint, MAX_FINGERPRINT_LENGTH)
    && validBoundedString(receipt.completedAt, 64)
    && Number.isFinite(Date.parse(receipt.completedAt))
    && typeof receipt.expiresAt === "number"
    && Number.isFinite(receipt.expiresAt)
    && (
      receipt.mobileContext === undefined
      || validMobileContext(receipt.mobileContext)
    )
    && (
      receipt.acknowledgedAt === undefined
      || (
        validBoundedString(receipt.acknowledgedAt, 64)
        && Number.isFinite(Date.parse(receipt.acknowledgedAt))
      )
    );
  if (!common) return false;
  const completedAt = Date.parse(receipt.completedAt as string);
  if (completedAt > (receipt.expiresAt as number)) return false;
  if (typeof receipt.acknowledgedAt === "string") {
    const acknowledgedAt = Date.parse(receipt.acknowledgedAt);
    if (acknowledgedAt < completedAt || acknowledgedAt > (receipt.expiresAt as number)) return false;
  }
  if (receipt.outcomeUnknown === true) return true;
  const selectedSearchLocation = receipt.selectedSearchLocation as Record<string, unknown> | null;
  return receipt.success === true
    && validKrogerCartUrl(receipt.cartUrl)
    && Number.isInteger(receipt.addedCount)
    && (receipt.addedCount as number) >= 1
    && (receipt.addedCount as number) <= 2_376
    && Number.isInteger(receipt.itemCount)
    && (receipt.itemCount as number) >= 1
    && (receipt.itemCount as number) <= 50
    && (receipt.addedCount as number) >= (receipt.itemCount as number)
    && validPossiblyEmptyBoundedString(receipt.chain, MAX_RETAILER_LABEL_LENGTH)
    && selectedSearchLocation !== null
    && typeof selectedSearchLocation === "object"
    && !Array.isArray(selectedSearchLocation)
    && Object.keys(selectedSearchLocation).length === 2
    && validBoundedString(selectedSearchLocation.locationId, MAX_LOCATION_ID_LENGTH)
    && validBoundedString(selectedSearchLocation.name, MAX_LOCATION_NAME_LENGTH)
    && receipt.locationBoundByCartApi === false
    && validPossiblyEmptyBoundedString(receipt.message, MAX_MESSAGE_LENGTH);
}

function validRecordBinding(record: KrogerCartOperationRecord) {
  if (!record.operationId.startsWith("mobile:")) return record.mobileContext === undefined;
  const context = record.mobileContext;
  if (
    !context
    || record.operationId !== `mobile:${context.ownerId}:${context.publicOperationId}`
    || mobileKrogerCartOperationIdentity(context.ownerId, context.comparisonId).publicOperationId
      !== context.publicOperationId
    || !/^[A-Za-z0-9_-]{43}$/.test(record.requestFingerprint)
  ) return false;
  if (record.acknowledgedAt) {
    if (record.expiresAt !== Date.parse(record.acknowledgedAt) + RECEIPT_TTL_MS) return false;
  } else if (record.expiresAt !== MOBILE_UNRESOLVED_EXPIRES_AT) {
    return false;
  }
  if ("outcomeUnknown" in record) return true;
  return record.cartUrl === context.cartUrl
    && record.chain === context.retailerBanner
    && record.selectedSearchLocation.locationId === context.locationId
    && record.selectedSearchLocation.name === context.locationName
    && record.locationBoundByCartApi === context.locationBoundByCartApi;
}

function pruneExpiredRecords(
  records: Map<string, KrogerCartOperationRecord>,
  now = Date.now(),
) {
  for (const [operationId, record] of records) {
    if (record.expiresAt <= now) records.delete(operationId);
  }
}

function serializeReceiptRecords(records: Map<string, KrogerCartOperationRecord>) {
  if (records.size > MAX_RECEIPT_RECORDS) {
    throw new KrogerCartOperationStateUnavailableError();
  }
  const fragments: string[] = [];
  let serializedBytes = 2; // Opening and closing array brackets.
  for (const [operationId, record] of records) {
    if (
      operationId !== record.operationId
      || !validRecord(record)
    ) {
      throw new KrogerCartOperationStateUnavailableError();
    }
    const fragment = JSON.stringify(record);
    serializedBytes += Buffer.byteLength(fragment, "utf8") + (fragments.length ? 1 : 0);
    if (serializedBytes > MAX_RECEIPT_FILE_BYTES) {
      throw new KrogerCartOperationStateUnavailableError();
    }
    fragments.push(fragment);
  }
  return `[${fragments.join(",")}]`;
}

function isMissingFile(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT",
  );
}

async function readReceiptFileBounded() {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(/* turbopackIgnore: true */ receiptFile(), "r");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new KrogerCartOperationStateUnavailableError();
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_RECEIPT_FILE_BYTES) {
      throw new KrogerCartOperationStateUnavailableError();
    }
    // Read through a fixed ceiling rather than using readFile(). The extra
    // byte detects a file that grows after stat without allocating based on
    // attacker-controlled file size.
    const buffer = Buffer.allocUnsafe(MAX_RECEIPT_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_RECEIPT_FILE_BYTES) {
      throw new KrogerCartOperationStateUnavailableError();
    }
    return buffer.toString("utf8", 0, bytesRead);
  } catch (error) {
    if (error instanceof KrogerCartOperationStateUnavailableError) throw error;
    throw new KrogerCartOperationStateUnavailableError();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function syncReceiptDirectory(directory: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Node/Windows cannot fsync a directory handle (EPERM). Windows is not an
    // accepted production cart-write topology; local development still flushes
    // the temporary file before its atomic rename. Every supported production
    // filesystem must durably flush the rename metadata or fail before Kroger.
    if (
      process.platform === "win32"
      && process.env.NODE_ENV !== "production"
      && error
      && typeof error === "object"
      && "code" in error
      && error.code === "EPERM"
    ) return;
    throw new KrogerCartOperationStateUnavailableError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function receipts() {
  const operationState = state();
  if (operationState.receipts) return operationState.receipts;
  operationState.loading ??= (async () => {
    // Runtime-only local state. The bounded reader also prevents a corrupt or
    // attacker-expanded file from driving unbounded process allocation.
    const serialized = await readReceiptFileBounded();
    if (serialized === null) {
      const loaded = new Map<string, KrogerCartOperationRecord>();
      operationState.receipts = loaded;
      return loaded;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new KrogerCartOperationStateUnavailableError();
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_RECEIPT_RECORDS) {
      throw new KrogerCartOperationStateUnavailableError();
    }
    const now = Date.now();
    const seen = new Set<string>();
    const loaded = new Map<string, KrogerCartOperationRecord>();
    for (const candidate of parsed) {
      if (!validRecord(candidate) || !validRecordBinding(candidate) || seen.has(candidate.operationId)) {
        throw new KrogerCartOperationStateUnavailableError();
      }
      seen.add(candidate.operationId);
      if (candidate.expiresAt > now) loaded.set(candidate.operationId, candidate);
    }
    operationState.receipts = loaded;
    return loaded;
  })();
  return operationState.loading;
}

function enqueueReceiptFileMutation<T>(mutation: () => Promise<T>) {
  const globalState = globalThis as OperationGlobal;
  const previous = globalState.__cartivaKrogerCartOperationFileMutation
    ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(mutation);
  // Keep the queue usable after a failed write while still returning the
  // original rejection to the caller that requested that mutation.
  globalState.__cartivaKrogerCartOperationFileMutation = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

async function commitReceiptMutation(
  mutation: (records: Map<string, KrogerCartOperationRecord>) => void,
) {
  const operationState = state();
  // `receipts()` is always called by public mutators before this helper. The
  // serialized queue then rebases every mutation on the latest published map,
  // preventing two concurrent operations from overwriting each other's guard.
  await enqueueReceiptFileMutation(async () => {
    const current = operationState.receipts;
    if (!current) throw new KrogerCartOperationStateUnavailableError();
    const next = new Map(current);
    // Prune inside the same queue that serializes every write. A long-lived
    // process therefore cannot retain expired acknowledgements indefinitely,
    // and concurrent commits cannot reintroduce a stale snapshot.
    pruneExpiredRecords(next);
    mutation(next);
    const serialized = serializeReceiptRecords(next);
    const file = receiptFile();
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      await rename(temporary, file);
      await syncReceiptDirectory(path.dirname(file));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    operationState.receipts = next;
    operationState.loading = Promise.resolve(next);
  });
}

function recoveryForRecord(
  record: KrogerCartOperationRecord,
): MobileKrogerCartOperationRecovery {
  const context = record.mobileContext;
  if (!context) throw new KrogerCartOperationStateUnavailableError();
  if ("outcomeUnknown" in record) {
    return {
      status: "OUTCOME_UNKNOWN",
      operationId: context.publicOperationId,
      comparisonId: context.comparisonId,
      completedAt: record.completedAt,
      message: "A previous Kroger cart update could not be confirmed. Check the retailer cart before trying again.",
      retrySafe: false,
      reviewHandoff: {
        url: context.cartUrl,
        retailerBanner: context.retailerBanner,
        locationId: context.locationId,
        locationName: context.locationName,
        locationBoundByCartApi: false,
        storeSelectionMustBeConfirmed: true,
      },
    };
  }
  return {
    status: "CONFIRMED",
    operationId: context.publicOperationId,
    comparisonId: context.comparisonId,
    completedAt: record.completedAt,
    message: record.message,
    addedCount: record.addedCount,
    itemCount: record.itemCount,
    handoff: {
      mode: "CART_TRANSFER_SUPPORTED",
      url: record.cartUrl,
      retailerBanner: context.retailerBanner,
      locationId: context.locationId,
      locationName: context.locationName,
      locationBoundByCartApi: false,
      storeSelectionMustBeConfirmed: true,
    },
  };
}

function unacknowledgedOwnerRecord(
  completed: Map<string, KrogerCartOperationRecord>,
  ownerId: string,
) {
  const prefix = `mobile:${ownerId}:`;
  const active = [...completed.entries()]
    .filter(([operationId, record]) => (
      operationId.startsWith(prefix)
      && record.expiresAt > Date.now()
      && !record.acknowledgedAt
    ))
    .sort(([, left], [, right]) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  if (!active.length) return null;
  // One owner can have at most one unresolved mobile cart write. More than one
  // means the durable duplicate guard is internally inconsistent, so do not
  // guess which retailer mutation is safe to retry.
  if (active.length !== 1) throw new KrogerCartOperationStateUnavailableError();
  const [operationId, record] = active[0];
  if (
    !record.mobileContext
    || record.mobileContext.ownerId !== ownerId
    || operationId !== `${prefix}${record.mobileContext.publicOperationId}`
  ) {
    throw new KrogerCartOperationStateUnavailableError();
  }
  return { operationId, record, recovery: recoveryForRecord(record) };
}

export async function latestMobileKrogerCartOperation(
  ownerId: string,
): Promise<MobileKrogerCartOperationRecovery | null> {
  if (!/^[a-f0-9]{64}$/.test(ownerId)) {
    throw new Error("A valid mobile owner is required.");
  }
  return unacknowledgedOwnerRecord(await receipts(), ownerId)?.recovery ?? null;
}

export async function acknowledgeMobileKrogerCartOperation(
  ownerId: string,
  publicOperationId: string,
) {
  if (!/^[a-f0-9]{64}$/.test(ownerId) || !/^[A-Za-z0-9_-]{43}$/.test(publicOperationId)) {
    return false;
  }
  const completed = await receipts();
  const internalOperationId = `mobile:${ownerId}:${publicOperationId}`;
  const existing = completed.get(internalOperationId);
  if (
    !existing
    || existing.expiresAt <= Date.now()
    || existing.mobileContext?.ownerId !== ownerId
    || existing.mobileContext.publicOperationId !== publicOperationId
  ) return false;
  if (existing.acknowledgedAt) return true;
  await commitReceiptMutation((next) => {
    const current = next.get(internalOperationId);
    if (
      !current
      || current.expiresAt <= Date.now()
      || current.mobileContext?.ownerId !== ownerId
      || current.mobileContext.publicOperationId !== publicOperationId
    ) throw new KrogerCartOperationStateUnavailableError();
    if (!current.acknowledgedAt) {
      const acknowledgedAt = new Date().toISOString();
      next.set(internalOperationId, {
        ...current,
        acknowledgedAt,
        expiresAt: Date.parse(acknowledgedAt) + RECEIPT_TTL_MS,
      });
    }
  });
  return true;
}

export async function runKrogerCartOperation(
  operationId: string,
  requestFingerprint: string,
  operation: () => Promise<Omit<
    KrogerCartReceipt,
    "operationId" | "requestFingerprint" | "completedAt" | "expiresAt" | "mobileContext" | "acknowledgedAt"
  >>,
  isSafeRetry: (error: unknown) => boolean = () => false,
  mobileContext?: MobileKrogerCartOperationContext,
) {
  const mobileOperation = operationId.startsWith("mobile:");
  if (
    mobileOperation !== Boolean(mobileContext)
    || (
      mobileContext
      && (
        !validMobileContext(mobileContext)
        || operationId !== `mobile:${mobileContext.ownerId}:${mobileContext.publicOperationId}`
        || mobileKrogerCartOperationIdentity(
          mobileContext.ownerId,
          mobileContext.comparisonId,
        ).publicOperationId !== mobileContext.publicOperationId
        || !/^[A-Za-z0-9_-]{43}$/.test(requestFingerprint)
      )
    )
  ) throw new KrogerCartOperationStateUnavailableError();
  const operationState = state();
  const completed = await receipts();
  const existing = completed.get(operationId);
  if (existing && existing.expiresAt > Date.now()) {
    if (existing.acknowledgedAt) {
      throw new KrogerCartOperationAlreadyReviewedError();
    }
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new KrogerCartOperationConflictError();
    }
    if ("outcomeUnknown" in existing) throw new KrogerCartOutcomeUnknownError();
    return { receipt: existing, replayed: true };
  }
  const active = operationState.inFlight.get(operationId);
  if (active) {
    if (active.requestFingerprint !== requestFingerprint) {
      throw new KrogerCartOperationConflictError();
    }
    return { receipt: await active.promise, replayed: true };
  }
  if (mobileContext) {
    const prior = unacknowledgedOwnerRecord(completed, mobileContext.ownerId);
    if (prior && prior.operationId !== operationId) {
      throw new KrogerCartOwnerOperationPendingError(prior.recovery);
    }
  }

  const pending = (async () => {
    // Write intent *before* the retailer call. If the server exits after Kroger
    // accepts the PUT but before Cartiva sees its response, a restarted server
    // will block the duplicate and ask the shopper to inspect the cart.
    const pendingReceipt: KrogerCartUnknownOutcome = {
      operationId,
      requestFingerprint,
      outcomeUnknown: true,
      completedAt: new Date().toISOString(),
      expiresAt: mobileContext ? MOBILE_UNRESOLVED_EXPIRES_AT : Date.now() + RECEIPT_TTL_MS,
      ...(mobileContext ? { mobileContext } : {}),
    };
    await commitReceiptMutation((next) => {
      const current = next.get(operationId);
      if (current && current.expiresAt > Date.now()) {
        if (current.requestFingerprint !== requestFingerprint) {
          throw new KrogerCartOperationConflictError();
        }
        if ("outcomeUnknown" in current) throw new KrogerCartOutcomeUnknownError();
        throw new KrogerCartOperationConflictError();
      }
      if (mobileContext) {
        const prior = unacknowledgedOwnerRecord(next, mobileContext.ownerId);
        if (prior && prior.operationId !== operationId) {
          throw new KrogerCartOwnerOperationPendingError(prior.recovery);
        }
      }
      next.set(operationId, pendingReceipt);
    });
    try {
      const result = await operation();
      const receipt: KrogerCartReceipt = {
        ...result,
        operationId,
        requestFingerprint,
        completedAt: new Date().toISOString(),
        expiresAt: mobileContext ? MOBILE_UNRESOLVED_EXPIRES_AT : Date.now() + RECEIPT_TTL_MS,
        ...(mobileContext ? { mobileContext } : {}),
      };
      await commitReceiptMutation((next) => {
        const current = next.get(operationId);
        if (
          !current
          || !("outcomeUnknown" in current)
          || current.requestFingerprint !== requestFingerprint
        ) throw new KrogerCartOperationStateUnavailableError();
        next.set(operationId, receipt);
      });
      return receipt;
    } catch (error) {
      if (isSafeRetry(error)) {
        await commitReceiptMutation((next) => {
          const current = next.get(operationId);
          if (
            current
            && "outcomeUnknown" in current
            && current.requestFingerprint === requestFingerprint
          ) next.delete(operationId);
        });
      }
      throw error;
    }
  })();
  operationState.inFlight.set(operationId, { requestFingerprint, promise: pending });
  try {
    return { receipt: await pending, replayed: false };
  } finally {
    operationState.inFlight.delete(operationId);
  }
}

export function resetKrogerCartOperationsForTests() {
  delete (globalThis as OperationGlobal).__cartivaKrogerCartOperations;
}

export async function clearKrogerCartOperations() {
  const operationState = state();
  // Account changes wait for any old-account PUT to settle. This prevents an
  // in-flight operation from recreating an old receipt after the clear.
  await Promise.allSettled(
    [...operationState.inFlight.values()].map(({ promise }) => promise),
  );
  await receipts();
  // Confirmed unprefixed successes belong to the old legacy customer session.
  // Owner-prefixed mobile receipts belong to other isolated sessions and must
  // survive. Uncertain outcomes also remain as conservative duplicate guards.
  await commitReceiptMutation((next) => {
    for (const [operationId, record] of next) {
      if (!operationId.startsWith("mobile:") && !("outcomeUnknown" in record)) {
        next.delete(operationId);
      }
    }
  });
}

/**
 * Clears replayable success receipts for one temporary mobile owner. Unknown
 * outcomes remain blocked because retrying them could duplicate a Kroger PUT.
 * Legacy operation IDs never use this prefix and remain untouched.
 */
export async function clearKrogerCartOperationsForOwner(ownerId: string) {
  if (!/^[a-f0-9]{64}$/.test(ownerId)) return;
  const prefix = `mobile:${ownerId}:`;
  const operationState = state();
  await Promise.allSettled(
    [...operationState.inFlight.entries()]
      .filter(([operationId]) => operationId.startsWith(prefix))
      .map(([, { promise }]) => promise),
  );
  await receipts();
  await commitReceiptMutation((next) => {
    for (const [operationId, receipt] of next) {
      // Disconnecting or rotating a customer token must never erase an
      // unresolved duplicate-write guard. Only an already acknowledged success
      // can be discarded here; unknown outcomes stay until TTL expiry.
      if (
        !operationId.startsWith(prefix)
        || "outcomeUnknown" in receipt
        || !receipt.acknowledgedAt
      ) continue;
      next.delete(operationId);
    }
  });
}
