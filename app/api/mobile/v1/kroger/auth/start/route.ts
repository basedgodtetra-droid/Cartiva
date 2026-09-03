import {
  enforcePublicReadRateLimit,
  hasOnlyKeys,
  isRecord,
  readPublicValidatedJson,
} from "@/lib/api-security";
import { KrogerAuthError } from "@/lib/kroger-auth";
import {
  KrogerCartOperationStateUnavailableError,
  latestMobileKrogerCartOperation,
  mobileKrogerCartOperationStatus,
} from "@/lib/kroger-cart-operations";
import {
  createMobileKrogerAuthorization,
  mobileKrogerReturnUrl,
} from "@/lib/kroger-mobile-auth";
import { loadComparisonReceipt } from "@/lib/mobile-comparison-receipts";
import {
  BasketCompleteness,
  comparisonCartMutationReadiness,
} from "@/packages/shared/src";
import {
  mobileSessionOptions,
  rejectDisallowedMobileBrowserOrigin,
  withMobileSessionCors,
} from "@/lib/mobile-api-cors";
import {
  mobileSessionErrorResponse,
  requireMobileSession,
} from "@/lib/mobile-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  return mobileSessionOptions(request, ["POST"]);
}

class MobileAuthorizationStartStateError extends Error {
  constructor(
    readonly body: Record<string, unknown>,
    readonly status: number,
  ) {
    super(typeof body.error === "string" ? body.error : "Kroger authorization cannot start.");
    this.name = "MobileAuthorizationStartStateError";
  }
}

async function validateAuthorizationStartState(ownerId: string, comparisonId: string) {
  const previousOperation = await latestMobileKrogerCartOperation(ownerId);
  if (previousOperation) {
    throw new MobileAuthorizationStartStateError({
      error: previousOperation.status === "OUTCOME_UNKNOWN"
        ? "A previous cart update could not be confirmed. Check Kroger before creating another comparison."
        : "A Kroger cart was already added for this Cartiva session. Review it before connecting again.",
      code: previousOperation.status === "OUTCOME_UNKNOWN"
        ? "outcome_unknown"
        : "comparison_already_submitted",
      retrySafe: false,
      priorOperation: previousOperation,
    }, 409);
  }
  if (await mobileKrogerCartOperationStatus(ownerId, comparisonId)) {
    throw new MobileAuthorizationStartStateError({
      error: "This basket was previously submitted and reviewed. No new Kroger cart update was sent. Compare again before reconnecting.",
      code: "comparison_previously_added",
      retrySafe: true,
    }, 409);
  }
  const receipt = await loadComparisonReceipt(ownerId, comparisonId);
  if (!receipt) {
    throw new MobileAuthorizationStartStateError({
      error: "This comparison expired or is not available. Compare your cart again before connecting Kroger.",
      code: "comparison_unavailable",
    }, 404);
  }
  if (receipt.completeness !== BasketCompleteness.COMPLETE) {
    throw new MobileAuthorizationStartStateError({
      error: "Complete every required basket line before connecting Kroger.",
      code: "basket_incomplete",
    }, 409);
  }
  const mutationReadiness = comparisonCartMutationReadiness(receipt);
  if (!mutationReadiness.ready) {
    throw new MobileAuthorizationStartStateError({
      error: mutationReadiness.reason === "BASKET_INCOMPLETE"
        ? "Complete every required basket line before connecting Kroger."
        : "This store verification is too old for cart transfer. Compare the basket again before connecting Kroger.",
      code: mutationReadiness.reason === "BASKET_INCOMPLETE"
        ? "basket_incomplete"
        : "comparison_stale",
    }, 409);
  }
}

export async function POST(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-kroger-auth-start",
    { limit: 8, windowMs: 10 * 60_000 },
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
    || !hasOnlyKeys(parsed.value, ["comparisonId"])
    || typeof parsed.value.comparisonId !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/.test(parsed.value.comparisonId)
  ) {
    return withMobileSessionCors(Response.json(
      { error: "Choose a valid Cartiva comparison before connecting Kroger." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    ), request);
  }
  const comparisonId = parsed.value.comparisonId;

  try {
    const authorizationUrl = await createMobileKrogerAuthorization(
      ownerId,
      comparisonId,
      () => validateAuthorizationStartState(ownerId, comparisonId),
    );
    return withMobileSessionCors(Response.json({
      retailer: "kroger",
      comparisonId,
      authorizationUrl,
      returnUrl: mobileKrogerReturnUrl("connected").split("?", 1)[0],
    }, {
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    }), request);
  } catch (error) {
    if (error instanceof MobileAuthorizationStartStateError) {
      return withMobileSessionCors(Response.json(
        error.body,
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      ), request);
    }
    if (error instanceof KrogerCartOperationStateUnavailableError) {
      return withMobileSessionCors(Response.json({
        error: error.message,
        code: "outcome_unknown",
        retrySafe: false,
      }, { status: 503, headers: { "Cache-Control": "no-store" } }), request);
    }
    const status = error instanceof KrogerAuthError ? error.status : 500;
    return withMobileSessionCors(Response.json(
      {
        error: error instanceof KrogerAuthError && error.code !== "configuration"
          ? error.message
          : "Kroger customer authorization is not available from this Cartiva server.",
        code: error instanceof KrogerAuthError ? error.code : "upstream",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    ), request);
  }
}
