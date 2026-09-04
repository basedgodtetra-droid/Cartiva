import { isTrustedKrogerCartUrl } from "./cart-submission-marker";
import { mobileSessionFetch } from "./mobile-session";

const RECOVERY_REQUEST_TIMEOUT_MS = 10_000;

interface KrogerCartRecoveryHandoff {
  url: string;
  retailerBanner: string;
  locationId: string;
  locationName: string;
  locationBoundByCartApi: false;
  storeSelectionMustBeConfirmed: true;
}

export type KrogerCartRecovery =
  | { status: "NONE" }
  | {
      status: "CONFIRMED";
      operationId: string;
      comparisonId: string;
      completedAt: string;
      message: string;
      addedCount: number;
      itemCount: number;
      handoff: KrogerCartRecoveryHandoff & { mode: "CART_TRANSFER_SUPPORTED" };
    }
  | {
      status: "OUTCOME_UNKNOWN";
      operationId: string;
      comparisonId: string;
      completedAt: string;
      message: string;
      retrySafe: false;
      reviewHandoff: KrogerCartRecoveryHandoff;
    };

export class KrogerCartRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KrogerCartRecoveryError";
  }
}

async function withRecoveryRequestTimeout<T>(
  externalSignal: AbortSignal | undefined,
  timeoutMessage: string,
  request: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  let rejectDeadline!: (error: KrogerCartRecoveryError) => void;
  let rejectCancellation!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abortFromCaller = () => {
    const error = new Error("The Kroger cart recovery check was cancelled.");
    error.name = "AbortError";
    rejectCancellation(error);
    controller.abort();
  };
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    // Settle before aborting so a platform JSON reader that ignores abort
    // cannot leave Results permanently waiting.
    rejectDeadline(new KrogerCartRecoveryError(timeoutMessage));
    controller.abort();
  }, RECOVERY_REQUEST_TIMEOUT_MS);
  try {
    return await Promise.race([request(controller.signal), deadline, cancellation]);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validComparisonId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function decodeHandoff(value: unknown, confirmed: boolean) {
  const handoff = record(value);
  const expectedKeys = confirmed
    ? [
        "mode", "url", "retailerBanner", "locationId", "locationName",
        "locationBoundByCartApi", "storeSelectionMustBeConfirmed",
      ]
    : [
        "url", "retailerBanner", "locationId", "locationName",
        "locationBoundByCartApi", "storeSelectionMustBeConfirmed",
      ];
  if (
    !handoff
    || !hasOnlyKeys(handoff, expectedKeys)
    || (confirmed && handoff.mode !== "CART_TRANSFER_SUPPORTED")
    || !isTrustedKrogerCartUrl(handoff.url)
    || !validText(handoff.retailerBanner, 80)
    || !validText(handoff.locationId, 64)
    || !validText(handoff.locationName, 160)
    || handoff.locationBoundByCartApi !== false
    || handoff.storeSelectionMustBeConfirmed !== true
  ) return null;
  return handoff as unknown as KrogerCartRecoveryHandoff & {
    mode?: "CART_TRANSFER_SUPPORTED";
  };
}

export function decodeKrogerCartRecovery(value: unknown): KrogerCartRecovery | null {
  const recovery = record(value);
  if (!recovery || typeof recovery.status !== "string") return null;
  if (recovery.status === "NONE") {
    return hasOnlyKeys(recovery, ["status"]) ? { status: "NONE" } : null;
  }
  const commonKeys = [
    "status", "operationId", "comparisonId", "completedAt", "message",
  ];
  if (
    !validOperationId(recovery.operationId)
    || !validComparisonId(recovery.comparisonId)
    || typeof recovery.completedAt !== "string"
    || !Number.isFinite(Date.parse(recovery.completedAt))
    || !validText(recovery.message, 500)
  ) return null;
  if (recovery.status === "CONFIRMED") {
    if (!hasOnlyKeys(recovery, [...commonKeys, "addedCount", "itemCount", "handoff"])) {
      return null;
    }
    const handoff = decodeHandoff(recovery.handoff, true);
    if (
      !handoff
      || !Number.isSafeInteger(recovery.addedCount)
      || (recovery.addedCount as number) < 1
      || (recovery.addedCount as number) > 4_950
      || !Number.isSafeInteger(recovery.itemCount)
      || (recovery.itemCount as number) < 1
      || (recovery.itemCount as number) > 50
      || (recovery.addedCount as number) < (recovery.itemCount as number)
      || (recovery.addedCount as number) > (recovery.itemCount as number) * 99
    ) return null;
    return {
      status: "CONFIRMED",
      operationId: recovery.operationId,
      comparisonId: recovery.comparisonId,
      completedAt: recovery.completedAt,
      message: recovery.message,
      addedCount: recovery.addedCount as number,
      itemCount: recovery.itemCount as number,
      handoff: {
        ...handoff,
        mode: "CART_TRANSFER_SUPPORTED",
      },
    };
  }
  if (recovery.status === "OUTCOME_UNKNOWN") {
    if (
      !hasOnlyKeys(recovery, [...commonKeys, "retrySafe", "reviewHandoff"])
      || recovery.retrySafe !== false
    ) return null;
    const reviewHandoff = decodeHandoff(recovery.reviewHandoff, false);
    if (!reviewHandoff) return null;
    return {
      status: "OUTCOME_UNKNOWN",
      operationId: recovery.operationId,
      comparisonId: recovery.comparisonId,
      completedAt: recovery.completedAt,
      message: recovery.message,
      retrySafe: false,
      reviewHandoff,
    };
  }
  return null;
}

async function responseMessage(response: Response, fallback: string) {
  try {
    const value = await response.json() as { error?: unknown };
    return typeof value.error === "string" && value.error.trim()
      ? value.error
      : fallback;
  } catch {
    return fallback;
  }
}

export async function getKrogerCartRecovery(signal?: AbortSignal) {
  return withRecoveryRequestTimeout(
    signal,
    "Kroger cart recovery timed out. Retry the safety check before adding another cart.",
    async (boundedSignal) => {
      const response = await mobileSessionFetch("api/mobile/v1/kroger/cart", {
        method: "GET",
        signal: boundedSignal,
      });
      if (!response.ok) {
        throw new KrogerCartRecoveryError(await responseMessage(
          response,
          "Cartiva could not verify the latest Kroger cart operation.",
        ));
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new KrogerCartRecoveryError("Cartiva could not verify the latest Kroger cart operation.");
      }
      const decoded = decodeKrogerCartRecovery(value);
      if (!decoded) {
        throw new KrogerCartRecoveryError("Kroger cart recovery returned an invalid response.");
      }
      return decoded;
    },
  );
}

export async function acknowledgeKrogerCartRecovery(
  operationId: string,
  signal?: AbortSignal,
) {
  if (!validOperationId(operationId)) {
    throw new KrogerCartRecoveryError("The Kroger cart review could not be verified.");
  }
  return withRecoveryRequestTimeout(
    signal,
    "Recording the Kroger cart review timed out. Automatic cart add remains paused; retry the review check.",
    async (boundedSignal) => {
      const response = await mobileSessionFetch("api/mobile/v1/kroger/cart", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId,
          acknowledgement: "REVIEWED_RETAILER_CART",
        }),
        signal: boundedSignal,
      });
      if (!response.ok) {
        throw new KrogerCartRecoveryError(await responseMessage(
          response,
          "Cartiva could not record that you reviewed the Kroger cart.",
        ));
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new KrogerCartRecoveryError("Cartiva could not verify the cart-review acknowledgement.");
      }
      const acknowledgement = record(value);
      if (
        !acknowledgement
        || !hasOnlyKeys(acknowledgement, ["status", "operationId"])
        || acknowledgement.status !== "ACKNOWLEDGED"
        || acknowledgement.operationId !== operationId
      ) {
        throw new KrogerCartRecoveryError("Cartiva could not verify the cart-review acknowledgement.");
      }
      return { status: "ACKNOWLEDGED" as const, operationId };
    },
  );
}
