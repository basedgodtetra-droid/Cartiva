import { randomBytes } from "node:crypto";
import { KrogerCartOperationConflictError, KrogerCartOutcomeUnknownError, type KrogerCartReceipt } from "./kroger-cart-operations";
import { sharedCommand } from "./kroger-shared-client";
import { openShared, sealShared, stateHash, type SharedCart } from "./kroger-shared-protocol";
import type { SharedWebLease } from "./kroger-shared-web";
import { isKrogerFamilyCartUrl } from "./kroger-family-links";
import "./server-only-guard";

type CartResult = Omit<KrogerCartReceipt, "operationId" | "requestFingerprint" | "completedAt" | "expiresAt" | "mobileContext" | "acknowledgedAt">;
export class SharedCartReviewRequiredError extends KrogerCartOutcomeUnknownError {
  constructor(readonly recoveryOperationId: string) { super(); }
}
export function sharedCartId(owner: string, publicOperationId: string) {
  return stateHash(`${owner}\0${publicOperationId}`);
}
function validCart(row: SharedCart | null): row is SharedCart {
  return Boolean(row && typeof row.request_fingerprint === "string" && typeof row.payload_encrypted === "string"
    && typeof row.status === "string" && (row.receipt_encrypted === null || typeof row.receipt_encrypted === "string")
    && (row.error_code === null || typeof row.error_code === "string"));
}

export async function runSharedKrogerCartOperation(
  context: SharedWebLease,
  operationId: string,
  requestFingerprint: string,
  operation: () => Promise<CartResult>,
  isSafeRetry: (error: unknown) => boolean,
  frozenBasket: unknown,
) {
  const owner = context.owner;
  const id = sharedCartId(owner, operationId);
  const binding = `cart:${owner}`;
  await context.assertCurrent();
  let prior: SharedCart | null;
  try { prior = await sharedCommand<SharedCart | null>({ op: "cart.read", owner, id }); }
  catch { throw new SharedCartReviewRequiredError(operationId); }
  if (prior) {
    if (!validCart(prior)) throw new SharedCartReviewRequiredError(operationId);
    if (prior.request_fingerprint !== requestFingerprint) throw new KrogerCartOperationConflictError();
    if (prior.error_code?.startsWith("reviewed:")) throw new SharedCartReviewRequiredError(operationId);
    if (prior.status === "succeeded" && prior.receipt_encrypted) {
      try {
        const receipt = openShared<KrogerCartReceipt>(prior.receipt_encrypted, binding);
        if (!receipt || receipt.operationId !== operationId || receipt.requestFingerprint !== requestFingerprint || receipt.success !== true
          || !Number.isInteger(receipt.itemCount) || receipt.itemCount < 1 || receipt.itemCount > 50
          || !Number.isInteger(receipt.addedCount) || receipt.addedCount < receipt.itemCount || receipt.addedCount > 4950
          || receipt.locationBoundByCartApi !== false || !receipt.selectedSearchLocation?.locationId
          || !Number.isFinite(Date.parse(receipt.completedAt)) || typeof receipt.cartUrl !== "string" || !isKrogerFamilyCartUrl(receipt.cartUrl)) throw new Error();
        const cartUrl = new URL(receipt.cartUrl);
        if (cartUrl.protocol !== "https:" || cartUrl.port || cartUrl.pathname !== "/cart" || cartUrl.search || cartUrl.hash || cartUrl.username || cartUrl.password) throw new Error();
        return { receipt, replayed: true };
      } catch { throw new SharedCartReviewRequiredError(operationId); }
    }
    if (prior.status !== "failed_retryable") throw new SharedCartReviewRequiredError(operationId);
  }
  const attempt = randomBytes(32).toString("base64url");
  let claimed: boolean;
  try {
    claimed = await sharedCommand<boolean>({ op: "cart.claim", owner, id, fingerprint: requestFingerprint,
      lease: context.lease, version: context.version, attempt,
      payload: sealShared({ operationId, basket: frozenBasket }, binding) });
  } catch { throw new SharedCartReviewRequiredError(operationId); }
  if (claimed !== true) {
    const pending = await sharedCommand<SharedCart | null>({ op: "cart.pending", owner }).catch(() => null);
    let payload: { operationId: string } | null = null;
    try { payload = validCart(pending) ? openShared<{ operationId: string }>(pending.payload_encrypted, binding) : null; }
    catch { throw new SharedCartReviewRequiredError(operationId); }
    const recoveryId = payload && /^[A-Za-z0-9_-]{16,128}$/.test(payload.operationId) ? payload.operationId : operationId;
    throw new SharedCartReviewRequiredError(recoveryId);
  }
  let result: CartResult;
  try {
    await context.assertCurrent();
    result = await operation();
  } catch (error) {
    if (isSafeRetry(error)) {
      try {
        const released = await sharedCommand({ op: "cart.retryable", owner, id, fingerprint: requestFingerprint, attempt });
        if (!released) throw new Error();
      } catch { throw new SharedCartReviewRequiredError(operationId); }
      throw error;
    }
    throw new SharedCartReviewRequiredError(operationId);
  }
  const receipt: KrogerCartReceipt = { ...result, operationId, requestFingerprint,
    completedAt: new Date().toISOString(), expiresAt: 253402300799000 };
  // Receipt persistence is outside the safe-retry catch: retailer acceptance
  // followed by a failed DB response must NEVER release the write guard.
  try {
    const saved = await sharedCommand({ op: "cart.finish", owner, id, fingerprint: requestFingerprint,
      attempt, receipt: sealShared(receipt, binding) });
    if (!saved) throw new Error();
  } catch { throw new SharedCartReviewRequiredError(operationId); }
  return { receipt, replayed: false };
}
