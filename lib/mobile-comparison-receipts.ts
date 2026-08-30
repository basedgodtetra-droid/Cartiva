import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import {
  assertComparisonStoreInvariant,
  comparisonBasketCanonicalPayload,
  type ComparisonSessionReceipt,
} from "@/packages/shared/src";
import { durableAtomicWriteFile } from "./durable-files";
import "./server-only-guard";

const RECEIPT_TTL_MS = 2 * 60 * 60_000;
const MAX_RECEIPT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_RECORDS = 4_096;

interface StoredComparisonReceipt {
  ownerId: string;
  fingerprint: string;
  receipt: ComparisonSessionReceipt;
  expiresAt: number;
}

type ReceiptGlobal = typeof globalThis & {
  __cartivaMobileComparisonReceipts?: {
    values?: Map<string, StoredComparisonReceipt>;
    loading?: Promise<Map<string, StoredComparisonReceipt>>;
    mutation: Promise<void>;
  };
};

export class ComparisonReceiptConflictError extends Error {
  constructor() {
    super("This comparison ID is already bound to a different store or basket.");
    this.name = "ComparisonReceiptConflictError";
  }
}

export class ComparisonReceiptStateUnavailableError extends Error {
  constructor() {
    super("Cartiva could not verify the saved comparison state. Try again after secure storage is restored.");
    this.name = "ComparisonReceiptStateUnavailableError";
  }
}

function state() {
  const globalState = globalThis as ReceiptGlobal;
  globalState.__cartivaMobileComparisonReceipts ??= { mutation: Promise.resolve() };
  return globalState.__cartivaMobileComparisonReceipts;
}

function receiptFile() {
  return process.env.CARTIVA_COMPARISON_RECEIPT_FILE?.trim()
    || path.resolve(".cartiva", "mobile-comparison-receipts.json");
}

function storageKey(ownerId: string, comparisonId: string) {
  return `${ownerId}:${comparisonId}`;
}

function validOwnerId(value: string) {
  return /^[a-f0-9]{64}$/i.test(value);
}

function validStored(value: unknown): value is StoredComparisonReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.ownerId === "string"
    && validOwnerId(record.ownerId)
    && typeof record.fingerprint === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(record.fingerprint)
    && typeof record.expiresAt === "number"
    && Number.isFinite(record.expiresAt)
    && record.receipt !== null
    && typeof record.receipt === "object";
}

function isMissingReceiptFile(error: unknown) {
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
    if (isMissingReceiptFile(error)) return null;
    throw new ComparisonReceiptStateUnavailableError();
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_RECEIPT_FILE_BYTES) {
      throw new ComparisonReceiptStateUnavailableError();
    }
    // Fixed-size bounded read also detects a file that grows after stat.
    const buffer = Buffer.allocUnsafe(MAX_RECEIPT_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_RECEIPT_FILE_BYTES) {
      throw new ComparisonReceiptStateUnavailableError();
    }
    return buffer.toString("utf8", 0, bytesRead);
  } catch (error) {
    if (error instanceof ComparisonReceiptStateUnavailableError) throw error;
    throw new ComparisonReceiptStateUnavailableError();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function values() {
  const receiptState = state();
  if (receiptState.values) return receiptState.values;
  receiptState.loading ??= (async () => {
    const serialized = await readReceiptFileBounded();
    if (serialized === null) {
      const empty = new Map<string, StoredComparisonReceipt>();
      receiptState.values = empty;
      return empty;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new ComparisonReceiptStateUnavailableError();
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_RECEIPT_RECORDS) {
      throw new ComparisonReceiptStateUnavailableError();
    }
    const now = Date.now();
    const loaded = new Map<string, StoredComparisonReceipt>();
    for (const entry of parsed) {
      if (!validStored(entry)) throw new ComparisonReceiptStateUnavailableError();
      try {
        assertComparisonStoreInvariant(entry.receipt);
      } catch {
        throw new ComparisonReceiptStateUnavailableError();
      }
      if (fingerprint(entry.receipt) !== entry.fingerprint) {
        throw new ComparisonReceiptStateUnavailableError();
      }
      if (entry.expiresAt <= now) continue;
      const key = storageKey(entry.ownerId, entry.receipt.comparisonId);
      if (loaded.has(key)) throw new ComparisonReceiptStateUnavailableError();
      loaded.set(key, entry);
    }
    receiptState.values = loaded;
    return loaded;
  })().finally(() => {
    receiptState.loading = undefined;
  });
  return receiptState.loading;
}

async function persist(receipts: Map<string, StoredComparisonReceipt>) {
  if (receipts.size > MAX_RECEIPT_RECORDS) {
    throw new ComparisonReceiptStateUnavailableError();
  }
  const fragments: string[] = [];
  let bytes = 2;
  for (const [key, entry] of receipts) {
    if (
      key !== storageKey(entry.ownerId, entry.receipt.comparisonId)
      || !validStored(entry)
      || fingerprint(entry.receipt) !== entry.fingerprint
    ) throw new ComparisonReceiptStateUnavailableError();
    try {
      assertComparisonStoreInvariant(entry.receipt);
    } catch {
      throw new ComparisonReceiptStateUnavailableError();
    }
    const fragment = JSON.stringify(entry);
    bytes += Buffer.byteLength(fragment, "utf8") + (fragments.length ? 1 : 0);
    if (bytes > MAX_RECEIPT_FILE_BYTES) {
      throw new ComparisonReceiptStateUnavailableError();
    }
    fragments.push(fragment);
  }
  await durableAtomicWriteFile(
    receiptFile(),
    `[${fragments.join(",")}]`,
    0o600,
  );
}

function fingerprint(receipt: ComparisonSessionReceipt) {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("base64url");
}

/** Public confirmation digest for the mutation-critical basket projection. */
export function comparisonBasketDigest(receipt: ComparisonSessionReceipt) {
  assertComparisonStoreInvariant(receipt);
  return createHash("sha256")
    .update(comparisonBasketCanonicalPayload(receipt))
    .digest("hex");
}

async function serializedMutation<T>(operation: () => Promise<T>) {
  const receiptState = state();
  const previous = receiptState.mutation;
  let release!: () => void;
  receiptState.mutation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * Saves a server-authoritative, owner-scoped comparison. A comparison ID can
 * be replayed idempotently but can never be rebound to another store/basket.
 */
export async function saveComparisonReceipt(
  ownerId: string,
  receipt: ComparisonSessionReceipt,
) {
  if (!validOwnerId(ownerId)) throw new Error("A valid mobile session owner is required.");
  assertComparisonStoreInvariant(receipt);
  const nextFingerprint = fingerprint(receipt);
  return serializedMutation(async () => {
    const receiptState = state();
    const receipts = await values();
    const key = storageKey(ownerId, receipt.comparisonId);
    const nextReceipts = new Map(receipts);
    const now = Date.now();
    for (const [entryKey, entry] of nextReceipts) {
      if (entry.expiresAt <= now) nextReceipts.delete(entryKey);
    }
    const existing = nextReceipts.get(key);
    if (existing) {
      if (existing.fingerprint !== nextFingerprint) throw new ComparisonReceiptConflictError();
      if (nextReceipts.size !== receipts.size) {
        await persist(nextReceipts);
        receiptState.values = nextReceipts;
      }
      return existing.receipt;
    }
    nextReceipts.set(key, {
      ownerId,
      fingerprint: nextFingerprint,
      receipt,
      expiresAt: now + RECEIPT_TTL_MS,
    });
    await persist(nextReceipts);
    receiptState.values = nextReceipts;
    return receipt;
  });
}

/** Returns null for missing, expired, or differently-owned comparisons. */
export async function loadComparisonReceipt(ownerId: string, comparisonId: string) {
  if (!validOwnerId(ownerId) || !comparisonId.trim()) return null;
  const receipts = await values();
  const key = storageKey(ownerId, comparisonId.trim());
  const entry = receipts.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  try {
    return assertComparisonStoreInvariant(entry.receipt);
  } catch {
    return null;
  }
}

export function resetComparisonReceiptsForTests() {
  delete (globalThis as ReceiptGlobal).__cartivaMobileComparisonReceipts;
}

export async function clearComparisonReceiptsForTests() {
  resetComparisonReceiptsForTests();
  await rm(receiptFile(), { force: true });
}
