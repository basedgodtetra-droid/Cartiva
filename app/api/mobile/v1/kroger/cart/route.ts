import { createHash } from "node:crypto";
import {
  enforcePublicReadRateLimit,
  hasOnlyKeys,
  isRecord,
  readPublicValidatedJson,
} from "@/lib/api-security";
import { KrogerAuthError } from "@/lib/kroger-auth";
import {
  acknowledgeMobileKrogerCartOperation,
  KrogerCartOperationAlreadyReviewedError,
  KrogerCartOperationConflictError,
  KrogerCartOwnerOperationPendingError,
  KrogerCartOperationStateUnavailableError,
  KrogerCartOutcomeUnknownError,
  latestMobileKrogerCartOperation,
  mobileKrogerCartOperationIdentity,
  mobileKrogerCartOperationStatus,
  type MobileKrogerCartOperationRecovery,
  runKrogerCartOperation,
} from "@/lib/kroger-cart-operations";
import {
  getMobileKrogerAuthClient,
  mobileKrogerCapabilityStatus,
} from "@/lib/kroger-mobile-auth";
import {
  ComparisonReceiptStateUnavailableError,
  loadComparisonReceipt,
} from "@/lib/mobile-comparison-receipts";
import { withMobileOwnerOperationLock } from "@/lib/mobile-owner-operation-lock";
import {
  mobileSessionOptions,
  rejectDisallowedMobileBrowserOrigin,
  withMobileSessionCors,
} from "@/lib/mobile-api-cors";
import {
  mobileSessionErrorResponse,
  requireMobileSession,
} from "@/lib/mobile-session";
import {
  addToKrogerCart,
  krogerCartUrl,
  KrogerProviderError,
} from "@/lib/kroger-provider";
import {
  comparisonCartMutationReadiness,
  type ComparisonCartMutationReadiness,
} from "@/packages/shared/src";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MobileCartRequest {
  comparisonId?: unknown;
}

export function OPTIONS(request: Request) {
  return mobileSessionOptions(request, ["DELETE", "GET", "POST"]);
}

export async function GET(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-kroger-cart-recovery",
    { limit: 30, windowMs: 60_000 },
  );
  if (limited) return withMobileSessionCors(limited, request);
  let ownerId: string;
  try {
    ownerId = requireMobileSession(request).ownerId;
  } catch (error) {
    return withMobileSessionCors(mobileSessionErrorResponse(error), request);
  }
  try {
    const operation = await withMobileOwnerOperationLock(ownerId, () => (
      latestMobileKrogerCartOperation(ownerId)
    ));
    return withMobileSessionCors(Response.json(
      operation ?? { status: "NONE" },
      { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
    ), request);
  } catch (error) {
    if (error instanceof KrogerCartOperationStateUnavailableError) {
      return withMobileSessionCors(Response.json({
        status: "OUTCOME_UNKNOWN",
        error: error.message,
        code: "outcome_unknown",
        retrySafe: false,
      }, { status: 503, headers: { "Cache-Control": "no-store" } }), request);
    }
    return withMobileSessionCors(Response.json({
      status: "UNAVAILABLE",
      error: "Cartiva could not recover the latest Kroger cart operation.",
      code: "recovery_unavailable",
      retrySafe: false,
    }, { status: 503, headers: { "Cache-Control": "no-store" } }), request);
  }
}

export async function DELETE(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-kroger-cart-acknowledge",
    { limit: 12, windowMs: 60_000 },
  );
  if (limited) return withMobileSessionCors(limited, request);
  let ownerId: string;
  try {
    ownerId = requireMobileSession(request).ownerId;
  } catch (error) {
    return withMobileSessionCors(mobileSessionErrorResponse(error), request);
  }
  const parsed = await readPublicValidatedJson<unknown>(request);
  if (!parsed.ok) return withMobileSessionCors(parsed.response, request);
  if (
    !isRecord(parsed.value)
    || !hasOnlyKeys(parsed.value, ["operationId", "acknowledgement"])
    || typeof parsed.value.operationId !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(parsed.value.operationId)
    || parsed.value.acknowledgement !== "REVIEWED_RETAILER_CART"
  ) {
    return withMobileSessionCors(Response.json({
      error: "Confirm that you reviewed the retailer cart before starting another.",
      code: "invalid_acknowledgement",
    }, { status: 400, headers: { "Cache-Control": "no-store" } }), request);
  }
  const operationId = parsed.value.operationId;
  try {
    const acknowledged = await withMobileOwnerOperationLock(ownerId, () => (
      acknowledgeMobileKrogerCartOperation(ownerId, operationId)
    ));
    if (!acknowledged) {
      return withMobileSessionCors(Response.json({
        error: "This Kroger cart operation is no longer available.",
        code: "operation_unavailable",
      }, { status: 404, headers: { "Cache-Control": "no-store" } }), request);
    }
    return withMobileSessionCors(Response.json({
      status: "ACKNOWLEDGED",
      operationId,
    }, { headers: { "Cache-Control": "no-store" } }), request);
  } catch (error) {
    const unknown = error instanceof KrogerCartOperationStateUnavailableError;
    return withMobileSessionCors(Response.json({
      status: unknown ? "OUTCOME_UNKNOWN" : "UNAVAILABLE",
      error: unknown
        ? error.message
        : "Cartiva could not record the retailer-cart review.",
      code: unknown ? "outcome_unknown" : "acknowledgement_unavailable",
      retrySafe: false,
    }, { status: 503, headers: { "Cache-Control": "no-store" } }), request);
  }
}

function cartItems(
  lines: Array<{ upc?: string; quantity: number; status: string }>,
  modality: "PICKUP" | "DELIVERY",
) {
  const quantities = new Map<string, number>();
  for (const line of lines) {
    if (line.status !== "ACCEPTED" || !line.upc || !/^\d{8,14}$/.test(line.upc)) return null;
    const quantity = (quantities.get(line.upc) ?? 0) + line.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return null;
    quantities.set(line.upc, quantity);
  }
  if (!quantities.size || quantities.size > 24) return null;
  return [...quantities].map(([upc, quantity]) => ({ upc, quantity, modality }));
}

function mutationReadinessFailureResponse(
  request: Request,
  reason: Extract<ComparisonCartMutationReadiness, { ready: false }>["reason"],
) {
  const basketIncomplete = reason === "BASKET_INCOMPLETE";
  return withMobileSessionCors(Response.json({
    status: "FAILED",
    success: false,
    error: basketIncomplete
      ? "Cartiva can add only a complete basket. Review the unmatched items first."
      : "This store verification is too old for an automatic cart update. Compare the basket again first.",
    code: basketIncomplete
      ? "basket_incomplete"
      : "comparison_stale",
    retrySafe: true,
  }, { status: 409, headers: { "Cache-Control": "no-store" } }), request);
}

function priorOperationResponse(
  request: Request,
  recovery: MobileKrogerCartOperationRecovery,
  comparisonId: string,
) {
  if (recovery.comparisonId === comparisonId && recovery.status === "CONFIRMED") {
    return withMobileSessionCors(Response.json({
      ...recovery,
      success: true,
      replayed: true,
      recovered: true,
    }, { status: 200, headers: { "Cache-Control": "no-store" } }), request);
  }
  if (recovery.comparisonId === comparisonId && recovery.status === "OUTCOME_UNKNOWN") {
    return withMobileSessionCors(Response.json({
      ...recovery,
      success: false,
      error: recovery.message,
      code: "outcome_unknown",
    }, { status: 409, headers: { "Cache-Control": "no-store" } }), request);
  }
  return withMobileSessionCors(Response.json({
    status: "BLOCKED",
    success: false,
    error: recovery.status === "CONFIRMED"
      ? "A Kroger cart was already added for this Cartiva session. Review it before starting another."
      : "A previous Kroger cart update could not be confirmed. Review the retailer cart before starting another.",
    code: "prior_cart_operation_requires_review",
    retrySafe: false,
    priorOperation: recovery,
  }, { status: 409, headers: { "Cache-Control": "no-store" } }), request);
}

function reviewedComparisonResponse(request: Request) {
  return withMobileSessionCors(Response.json({
    status: "FAILED",
    success: false,
    error: "This basket was previously submitted and reviewed. No new Kroger cart update was sent. Compare again before starting another cart.",
    code: "comparison_previously_added",
    retrySafe: true,
  }, { status: 409, headers: { "Cache-Control": "no-store" } }), request);
}

export async function POST(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-kroger-cart",
    { limit: 12, windowMs: 60_000 },
  );
  if (limited) return withMobileSessionCors(limited, request);

  let ownerId: string;
  try {
    ownerId = requireMobileSession(request).ownerId;
  } catch (error) {
    return withMobileSessionCors(mobileSessionErrorResponse(error), request);
  }
  const capability = mobileKrogerCapabilityStatus();
  if (!capability.configured || !capability.cartTransferSupported) {
    return withMobileSessionCors(Response.json({
      status: "FAILED",
      success: false,
      error: capability.reason || "Kroger cart transfer is unavailable on this backend.",
      code: "cart_transfer_unavailable",
      retrySafe: true,
    }, { status: 503, headers: { "Cache-Control": "no-store" } }), request);
  }
  const parsed = await readPublicValidatedJson<unknown>(request);
  if (!parsed.ok) return withMobileSessionCors(parsed.response, request);
  if (!isRecord(parsed.value) || !hasOnlyKeys(parsed.value, ["comparisonId"])) {
    return withMobileSessionCors(Response.json(
      { error: "The Kroger cart request contains unsupported fields." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    ), request);
  }
  const body = parsed.value as MobileCartRequest;
  const comparisonId = typeof body.comparisonId === "string" ? body.comparisonId.trim() : "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(comparisonId)) {
    return withMobileSessionCors(Response.json(
      { error: "Compare your basket again before adding it to Kroger." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    ), request);
  }

  try {
    const operationHistory = await withMobileOwnerOperationLock(ownerId, async () => ({
      priorOperation: await latestMobileKrogerCartOperation(ownerId),
      comparisonStatus: await mobileKrogerCartOperationStatus(ownerId, comparisonId),
    }));
    if (operationHistory.priorOperation) {
      return priorOperationResponse(request, operationHistory.priorOperation, comparisonId);
    }
    if (operationHistory.comparisonStatus) return reviewedComparisonResponse(request);
  } catch (error) {
    if (error instanceof KrogerCartOperationStateUnavailableError) {
      return withMobileSessionCors(Response.json({
        status: "OUTCOME_UNKNOWN",
        success: false,
        error: error.message,
        code: "outcome_unknown",
        retrySafe: false,
      }, { status: 503, headers: { "Cache-Control": "no-store" } }), request);
    }
    throw error;
  }

  let comparison: Awaited<ReturnType<typeof loadComparisonReceipt>>;
  try {
    comparison = await loadComparisonReceipt(ownerId, comparisonId);
  } catch (error) {
    if (error instanceof ComparisonReceiptStateUnavailableError) {
      return withMobileSessionCors(Response.json({
        status: "FAILED",
        success: false,
        error: error.message,
        code: "comparison_state_unavailable",
        retrySafe: true,
      }, { status: 503, headers: { "Cache-Control": "no-store" } }), request);
    }
    throw error;
  }
  if (!comparison) {
    return withMobileSessionCors(Response.json({
      status: "FAILED",
      success: false,
      error: "This comparison expired or belongs to another Cartiva session. Compare your cart again.",
      code: "comparison_unavailable",
      retrySafe: true,
    }, { status: 404, headers: { "Cache-Control": "no-store" } }), request);
  }
  const mutationReadiness = comparisonCartMutationReadiness(comparison);
  if (!mutationReadiness.ready) {
    return mutationReadinessFailureResponse(request, mutationReadiness.reason);
  }
  const modality = comparison.fulfillmentMode === "pickup" ? "PICKUP" as const : "DELIVERY" as const;
  const items = cartItems(comparison.basketLines, modality);
  if (!items) {
    return withMobileSessionCors(Response.json({
      status: "FAILED",
      success: false,
      error: "This verified basket cannot be converted to safe Kroger quantities. Compare it again.",
      code: "invalid_basket",
      retrySafe: true,
    }, { status: 409, headers: { "Cache-Control": "no-store" } }), request);
  }

  const { publicOperationId, internalOperationId } = mobileKrogerCartOperationIdentity(
    ownerId,
    comparisonId,
  );
  return withMobileOwnerOperationLock(ownerId, async () => {
    try {
      const auth = getMobileKrogerAuthClient(ownerId);
      const authorizationGeneration = await auth.getAuthorizationGeneration();
      // Recheck after waiting for the owner lock and any token refresh. A
      // receipt that crosses the freshness boundary while queued must never
      // reach the durable operation intent or Kroger PUT.
      const lockedMutationReadiness = comparisonCartMutationReadiness(comparison);
      if (!lockedMutationReadiness.ready) {
        return mutationReadinessFailureResponse(request, lockedMutationReadiness.reason);
      }
      const requestFingerprint = createHash("sha256").update(JSON.stringify({
        ownerId,
        authorizationGeneration,
        comparisonId: comparison.comparisonId,
        locationId: comparison.locationId,
        retailerBanner: comparison.retailerBanner,
        fulfillmentMode: comparison.fulfillmentMode,
        checkedAt: comparison.checkedAt,
        items,
      })).digest("base64url");
      const { receipt, replayed } = await runKrogerCartOperation(
        internalOperationId,
        requestFingerprint,
        async () => {
          try {
            await addToKrogerCart(items, auth);
          } catch (error) {
            if (error instanceof KrogerProviderError && error.code === "outcome_unknown") {
              throw new KrogerCartOutcomeUnknownError();
            }
            if (error instanceof KrogerAuthError || error instanceof KrogerProviderError) throw error;
            throw new KrogerCartOutcomeUnknownError();
          }
          return {
            success: true as const,
            addedCount: items.reduce((sum, item) => sum + item.quantity, 0),
            itemCount: items.length,
            cartUrl: krogerCartUrl(comparison.retailerChain),
            chain: comparison.retailerBanner,
            selectedSearchLocation: {
              locationId: comparison.locationId,
              name: comparison.locationName,
            },
            locationBoundByCartApi: false as const,
            message: `${comparison.retailerBanner} confirmed the cart add. Review the active store, availability, quantities, and final prices with the retailer before checkout.`,
          };
        },
        (error) => (
          error instanceof KrogerAuthError
          || (error instanceof KrogerProviderError && error.code !== "outcome_unknown")
        ),
        {
          ownerId,
          comparisonId,
          publicOperationId,
          cartUrl: krogerCartUrl(comparison.retailerChain),
          retailerBanner: comparison.retailerBanner,
          locationId: comparison.locationId,
          locationName: comparison.locationName,
          locationBoundByCartApi: false,
          storeSelectionMustBeConfirmed: true,
        },
      );
      return withMobileSessionCors(Response.json({
        status: "CONFIRMED",
        success: true,
        operationId: publicOperationId,
        comparisonId,
        replayed,
        addedCount: receipt.addedCount,
        itemCount: receipt.itemCount,
        message: receipt.message,
        handoff: {
          mode: "CART_TRANSFER_SUPPORTED",
          url: receipt.cartUrl,
          retailerBanner: comparison.retailerBanner,
          locationId: comparison.locationId,
          locationName: comparison.locationName,
          locationBoundByCartApi: false,
          storeSelectionMustBeConfirmed: true,
        },
      }, {
        headers: {
          "Cache-Control": "no-store",
          Pragma: "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      }), request);
    } catch (error) {
      if (error instanceof KrogerCartOwnerOperationPendingError) {
        return withMobileSessionCors(Response.json({
          status: "BLOCKED",
          success: false,
          error: error.message,
          code: "prior_cart_operation_requires_review",
          retrySafe: false,
          priorOperation: error.recovery,
        }, {
          status: 409,
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        }), request);
      }
      if (error instanceof KrogerCartOperationAlreadyReviewedError) {
        return reviewedComparisonResponse(request);
      }
      const conflict = error instanceof KrogerCartOperationConflictError;
      const notConnected = error instanceof KrogerAuthError && error.code === "not_connected";
      const knownSafeFailure = error instanceof KrogerAuthError
        || (error instanceof KrogerProviderError && error.code !== "outcome_unknown");
      const ambiguous = error instanceof KrogerCartOutcomeUnknownError
        || (!conflict && !knownSafeFailure);
      const status = conflict
        ? 409
        : notConnected
          ? 401
          : error instanceof KrogerAuthError
            ? error.status
            : error instanceof KrogerProviderError
              ? error.status
              : 502;
      return withMobileSessionCors(Response.json(ambiguous
        ? {
            status: "OUTCOME_UNKNOWN",
            success: false,
            error: "Kroger's response was interrupted. Check your retailer cart before trying again.",
            code: "outcome_unknown",
            retrySafe: false,
            reviewHandoff: {
              url: krogerCartUrl(comparison.retailerChain),
              retailerBanner: comparison.retailerBanner,
              locationId: comparison.locationId,
              locationName: comparison.locationName,
              locationBoundByCartApi: false,
              storeSelectionMustBeConfirmed: true,
            },
          }
        : {
            status: "FAILED",
            success: false,
            error: conflict
              ? "This comparison was used with a previous Kroger connection. Create a fresh comparison before adding another cart."
              : error instanceof Error ? error.message : "Kroger could not add this basket.",
            code: conflict ? "comparison_already_submitted" : notConnected ? "not_connected" : "cart_add_failed",
            retrySafe: knownSafeFailure,
          }, {
        status,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      }), request);
    }
  });
}
