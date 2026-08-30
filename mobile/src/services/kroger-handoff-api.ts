import Constants, { ExecutionEnvironment } from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import { isTrustedKrogerCartUrl } from "./cart-submission-marker";
import { validateKrogerOAuthReturn } from "./kroger-oauth-return";
import { mobileSessionFetch } from "./mobile-session";

export type KrogerAuthorizationState =
  | "CONNECTED"
  | "NOT_CONNECTED"
  | "UNAVAILABLE";

export interface KrogerHandoffCapability {
  mode: "CART_TRANSFER_SUPPORTED" | "SHOPPING_PAGE_ONLY";
  cartTransferSupported: boolean;
  requiresRetailerCheckout: true;
  requiresCustomerAuthorization: boolean;
  cartApiLocationBound: false;
  requiresStoreConfirmation: true;
  configured: boolean;
  reason?: string;
}

export interface KrogerAuthorizationStatus {
  retailer: "kroger";
  authorization: KrogerAuthorizationState;
  capability: KrogerHandoffCapability;
}

export type KrogerAuthorizationOutcome =
  | { status: "CONNECTED"; authorization: KrogerAuthorizationStatus }
  | { status: "CANCELLED"; message: string }
  | { status: "FAILED" | "UNAVAILABLE"; message: string; code?: string };

class KrogerHandoffApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "KrogerHandoffApiError";
  }
}

const KROGER_AUTHORIZATION_READ_TIMEOUT_MS = 12_000;

function cancelledHandoffRequest() {
  const error = new Error("The Kroger connection check was cancelled.");
  error.name = "AbortError";
  return error;
}

async function withHandoffReadDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMessage: string,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  if (signal?.aborted) throw cancelledHandoffRequest();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline!: (error: Error) => void;
  let rejectCancellation!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    // Reject independently of fetch so a mocked or platform body reader that
    // ignores abort cannot leave the Results action permanently in flight.
    rejectCancellation(cancelledHandoffRequest());
    controller.abort();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  timeout = setTimeout(() => {
    // Settle the controlled timeout before aborting the underlying body read;
    // this keeps the shopper-facing failure deterministic.
    rejectDeadline(new KrogerHandoffApiError(timeoutMessage, "timeout"));
    controller.abort();
  }, KROGER_AUTHORIZATION_READ_TIMEOUT_MS);
  try {
    return await Promise.race([operation(controller.signal), deadline, cancellation]);
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

export interface ConfirmedKrogerCartAdd {
  status: "CONFIRMED";
  success: true;
  operationId: string;
  comparisonId: string;
  replayed: boolean;
  addedCount: number;
  itemCount: number;
  message: string;
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

export interface KrogerCartReviewHandoff {
  url: string;
  retailerBanner: string;
  locationId: string;
  locationName: string;
  locationBoundByCartApi: false;
  storeSelectionMustBeConfirmed: true;
}

export interface FailedKrogerCartAdd {
  status: "FAILED" | "OUTCOME_UNKNOWN";
  success: false;
  operationId?: string;
  error: string;
  code: string;
  retrySafe: boolean;
  reviewHandoff?: KrogerCartReviewHandoff;
}

export type KrogerCartAddOutcome = ConfirmedKrogerCartAdd | FailedKrogerCartAdd;

export interface KrogerCartComparisonIdentity {
  comparisonId: string;
  locationId: string;
  retailerBanner: string;
}

export interface KrogerAuthorizationOptions {
  signal?: AbortSignal;
}

interface KrogerAuthorizationStart {
  retailer: "kroger";
  comparisonId: string;
  authorizationUrl: string;
  returnUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function parseKrogerCapability(value: unknown): KrogerHandoffCapability {
  const required = [
    "mode",
    "cartTransferSupported",
    "requiresRetailerCheckout",
    "requiresCustomerAuthorization",
    "cartApiLocationBound",
    "requiresStoreConfirmation",
    "configured",
  ] as const;
  if (!isRecord(value) || !exactKeys(value, required, ["reason"])) {
    throw new KrogerHandoffApiError(
      "Cartiva received an invalid Kroger capability response.",
      "invalid_response",
    );
  }
  const transfer = value.mode === "CART_TRANSFER_SUPPORTED"
    && value.cartTransferSupported === true
    && value.configured === true
    && value.reason === undefined;
  const shoppingOnly = value.mode === "SHOPPING_PAGE_ONLY"
    && value.cartTransferSupported === false
    && value.configured === false
    && typeof value.reason === "string"
    && value.reason.trim().length > 0;
  if (
    (!transfer && !shoppingOnly)
    || value.requiresRetailerCheckout !== true
    || value.requiresCustomerAuthorization !== true
    || value.cartApiLocationBound !== false
    || value.requiresStoreConfirmation !== true
  ) {
    throw new KrogerHandoffApiError(
      "Cartiva received an inconsistent Kroger capability response.",
      "invalid_response",
    );
  }
  return value as unknown as KrogerHandoffCapability;
}

function parseKrogerAuthorizationStatus(value: unknown): KrogerAuthorizationStatus {
  if (!isRecord(value) || !exactKeys(value, ["retailer", "authorization", "capability"])) {
    throw new KrogerHandoffApiError(
      "Cartiva received an invalid Kroger connection response.",
      "invalid_response",
    );
  }
  const capability = parseKrogerCapability(value.capability);
  const authorization = value.authorization;
  const authorizationKnown = authorization === "CONNECTED"
    || authorization === "NOT_CONNECTED"
    || authorization === "UNAVAILABLE";
  const consistent = authorizationKnown
    && (capability.configured
      ? authorization === "CONNECTED" || authorization === "NOT_CONNECTED"
      : authorization === "UNAVAILABLE");
  if (value.retailer !== "kroger" || !consistent) {
    throw new KrogerHandoffApiError(
      "Cartiva could not safely verify the Kroger connection state.",
      "invalid_response",
    );
  }
  return {
    retailer: "kroger",
    authorization,
    capability,
  };
}

const KROGER_AUTHORIZATION_ORIGIN = "https://api.kroger.com";
const KROGER_AUTHORIZATION_PATH = "/v1/connect/oauth2/authorize";
const KROGER_OAUTH_RETURN_PATH = "/oauth/kroger";

function parseUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function validKrogerAuthorizationUrl(value: unknown) {
  const url = parseUrl(value);
  return Boolean(
    url
    && url.origin === KROGER_AUTHORIZATION_ORIGIN
    && url.pathname === KROGER_AUTHORIZATION_PATH
    && !url.username
    && !url.password
    && !url.port
    && !url.hash,
  );
}

function validKrogerReturnBase(value: unknown) {
  const url = parseUrl(value);
  if (!url || url.search || url.hash || url.username || url.password || url.port) {
    return false;
  }
  if (url.protocol === "https:") {
    const claimedDomain = `applinks:${url.hostname}`;
    const associatedDomains = Constants.expoConfig?.ios?.associatedDomains ?? [];
    return url.pathname === KROGER_OAUTH_RETURN_PATH
      && associatedDomains.some((entry) => entry.split("?", 1)[0] === claimedDomain);
  }
  return __DEV__
    && url.protocol === "cartiva:"
    && url.hostname === "oauth"
    && url.pathname === "/kroger";
}

function parseKrogerAuthorizationStart(
  value: unknown,
  expectedComparisonId: string,
): KrogerAuthorizationStart {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).some((key) => ![
      "retailer",
      "comparisonId",
      "authorizationUrl",
      "returnUrl",
    ].includes(key))
  ) {
    throw new KrogerHandoffApiError(
      "Cartiva received an invalid Kroger sign-in response.",
      "invalid_response",
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.retailer !== "kroger"
    || candidate.comparisonId !== expectedComparisonId
    || !validKrogerAuthorizationUrl(candidate.authorizationUrl)
    || !validKrogerReturnBase(candidate.returnUrl)
  ) {
    throw new KrogerHandoffApiError(
      "Cartiva could not safely verify the Kroger sign-in destination.",
      "invalid_response",
    );
  }
  return candidate as unknown as KrogerAuthorizationStart;
}

function sameOAuthReturnBase(callback: URL, expected: URL) {
  return callback.protocol === expected.protocol
    && callback.hostname === expected.hostname
    && callback.port === expected.port
    && callback.username === expected.username
    && callback.password === expected.password
    && callback.pathname === expected.pathname
    && !callback.hash;
}

function hasOnlySingleOAuthReturnParameters(callback: URL) {
  const allowed = new Set(["status", "comparisonId", "completion"]);
  const counts = new Map<string, number>();
  for (const key of callback.searchParams.keys()) {
    if (!allowed.has(key)) return false;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if ((counts.get(key) ?? 0) > 1) return false;
  }
  return true;
}

async function responseError(response: Response, fallback: string) {
  try {
    const value = await response.json() as { error?: unknown };
    if (typeof value.error === "string" && value.error.trim()) return value.error;
  } catch {
    // Keep the controlled fallback.
  }
  return fallback;
}

export async function getKrogerAuthorizationStatus(signal?: AbortSignal) {
  return withHandoffReadDeadline(
    signal,
    "Checking the Kroger connection took too long. Try again when your connection is stable.",
    async (boundedSignal) => {
      const response = await mobileSessionFetch("api/mobile/v1/kroger/auth/status", {
        method: "GET",
        signal: boundedSignal,
      });
      if (!response.ok) {
        throw new Error(await responseError(
          response,
          "Cartiva could not check the Kroger connection.",
        ));
      }
      return parseKrogerAuthorizationStatus(await response.json() as unknown);
    },
  );
}

export async function startKrogerAuthorization(
  comparisonId: string,
  signal?: AbortSignal,
) {
  return withHandoffReadDeadline(
    signal,
    "Starting Kroger sign-in took too long. Nothing was transferred; try again when your connection is stable.",
    async (boundedSignal) => {
      const response = await mobileSessionFetch("api/mobile/v1/kroger/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comparisonId }),
        signal: boundedSignal,
      });
      if (!response.ok) {
        let value: { error?: unknown; code?: unknown } = {};
        try {
          value = await response.json() as typeof value;
        } catch {
          // Keep the controlled fallback below.
        }
        throw new KrogerHandoffApiError(
          typeof value.error === "string" && value.error.trim()
            ? value.error
            : "Kroger customer authorization could not start.",
          typeof value.code === "string" ? value.code : undefined,
        );
      }
      return parseKrogerAuthorizationStart(
        await response.json() as unknown,
        comparisonId,
      );
    },
  );
}

export async function completeKrogerAuthorization(
  comparisonId: string,
  completion: string,
  signal?: AbortSignal,
) {
  const response = await mobileSessionFetch("api/mobile/v1/kroger/auth/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completion }),
    signal,
  });
  let value: unknown = {};
  try {
    value = await response.json() as unknown;
  } catch {
    // Keep the controlled failure below.
  }
  const record = isRecord(value) ? value : {};
  let authorization: KrogerAuthorizationStatus | undefined;
  if (
    response.ok
    && exactKeys(record, ["retailer", "authorization", "comparisonId", "capability"])
    && record.comparisonId === comparisonId
  ) {
    try {
      authorization = parseKrogerAuthorizationStatus({
        retailer: record.retailer,
        authorization: record.authorization,
        capability: record.capability,
      });
    } catch {
      authorization = undefined;
    }
  }
  if (
    !authorization
    || authorization.authorization !== "CONNECTED"
    || authorization.capability.mode !== "CART_TRANSFER_SUPPORTED"
  ) {
    throw new KrogerHandoffApiError(
      typeof record.error === "string" && record.error.trim()
        ? record.error
        : "Cartiva could not safely finish the Kroger connection.",
      typeof record.code === "string" ? record.code : undefined,
    );
  }
  return authorization;
}

export async function completeAndVerifyKrogerAuthorization(
  comparisonId: string,
  completion: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const { signal, timeoutMs = 25_000 } = options;
  const deadlineAt = Date.now() + timeoutMs;
  const runBounded = async <T>(
    operation: (requestSignal: AbortSignal) => Promise<T>,
    maximumMs: number,
  ) => {
    if (signal?.aborted) throw new Error("Kroger connection verification was cancelled.");
    const remainingMs = Math.min(maximumMs, deadlineAt - Date.now());
    if (remainingMs <= 0) throw new Error("Kroger connection verification timed out.");
    const controller = new AbortController();
    let rejectDeadline!: (error: Error) => void;
    let rejectCancellation!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const abort = () => {
      rejectCancellation(new Error("Kroger connection verification was cancelled."));
      controller.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      // Settle independently before aborting. Some mobile body readers and
      // test doubles do not observe AbortSignal once response headers exist.
      rejectDeadline(new Error("Kroger connection verification timed out."));
      controller.abort();
    }, remainingMs);
    try {
      return await Promise.race([operation(controller.signal), deadline, cancellation]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };

  let firstError: unknown;
  try {
    await runBounded(
      (requestSignal) => completeKrogerAuthorization(
        comparisonId,
        completion,
        requestSignal,
      ),
      20_000,
    );
    const authorization = await runBounded(
      (requestSignal) => getKrogerAuthorizationStatus(requestSignal),
      5_000,
    );
    if (authorization.authorization === "CONNECTED") return authorization;
    throw new Error("Kroger did not confirm the connection.");
  } catch (error) {
    firstError = error;
  }
  if (signal?.aborted) throw firstError;

  // Activation may have committed before its response was interrupted. Use
  // only a fresh owner-scoped server status, within the same composed deadline,
  // to recover that result. A stalled recovery request is aborted.
  try {
    const authorization = await runBounded(
      (requestSignal) => getKrogerAuthorizationStatus(requestSignal),
      5_000,
    );
    if (authorization.authorization === "CONNECTED") return authorization;
  } catch {
    // Preserve the first controlled completion/verification failure.
  }
  throw firstError;
}

export async function authorizeKroger(
  comparisonId: string,
  options: KrogerAuthorizationOptions = {},
): Promise<KrogerAuthorizationOutcome> {
  const { signal } = options;
  const stopped = (): KrogerAuthorizationOutcome => ({
    status: "CANCELLED",
    message: "Kroger sign-in was stopped. Nothing was transferred and your Cartiva basket is still here.",
  });
  if (signal?.aborted) return stopped();
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    return {
      status: "UNAVAILABLE",
      message: "Kroger sign-in requires the Cartiva development build on iPhone. Grocery comparison still works in Expo Go.",
    };
  }
  let start;
  try {
    start = await startKrogerAuthorization(comparisonId, signal);
  } catch (error) {
    if (signal?.aborted) return stopped();
    return {
      status: "FAILED",
      message: error instanceof Error
        ? error.message
        : "Kroger customer authorization could not start.",
      ...(error instanceof KrogerHandoffApiError && error.code ? { code: error.code } : {}),
    };
  }

  if (signal?.aborted) return stopped();

  const dismissOnAbort = () => {
    try {
      WebBrowser.dismissAuthSession();
    } catch {
      // Android cannot dismiss its custom tab programmatically. The caller's
      // stale-screen guard still ignores the eventual browser result.
    }
  };
  signal?.addEventListener("abort", dismissOnAbort, { once: true });
  let browserResult;
  try {
    browserResult = await WebBrowser.openAuthSessionAsync(
      start.authorizationUrl,
      start.returnUrl,
      // Avoid silently reusing a household Safari Kroger account on shared
      // iPhones. The shopper explicitly signs in for this Cartiva operation.
      {
        preferEphemeralSession: true,
        // HTTPS returns are universal links. Expo's iOS implementation only
        // selects that callback API when this flag is explicit.
        preferUniversalLinks: start.returnUrl.startsWith("https://"),
      },
    );
  } finally {
    signal?.removeEventListener("abort", dismissOnAbort);
  }
  if (signal?.aborted) return stopped();
  if (browserResult.type === "cancel" || browserResult.type === "dismiss") {
    return {
      status: "CANCELLED",
      message: "Kroger sign-in was cancelled. Your Cartiva basket is still here.",
    };
  }
  if (browserResult.type !== "success") {
    return {
      status: "FAILED",
      message: "Kroger sign-in did not finish. Your Cartiva basket is still here.",
    };
  }

  let callbackDecision = validateKrogerOAuthReturn({}, comparisonId);
  try {
    const callback = new URL(browserResult.url);
    const expectedReturn = new URL(start.returnUrl);
    if (
      sameOAuthReturnBase(callback, expectedReturn)
      && hasOnlySingleOAuthReturnParameters(callback)
    ) {
      callbackDecision = validateKrogerOAuthReturn({
        status: callback.searchParams.get("status") ?? undefined,
        comparisonId: callback.searchParams.get("comparisonId") ?? undefined,
        completion: callback.searchParams.get("completion") ?? undefined,
      }, comparisonId);
    }
  } catch {
    // Fail closed below.
  }
  if (callbackDecision.comparisonId !== comparisonId) {
    return {
      status: "FAILED",
      message: "Kroger returned to a different or expired Cartiva comparison. Your basket was not changed.",
    };
  }
  if (callbackDecision.status === "cancelled") {
    return {
      status: "CANCELLED",
      message: "Kroger sign-in was cancelled. Your Cartiva basket is still here.",
    };
  }
  if (callbackDecision.status !== "pending" || !callbackDecision.completion) {
    return {
      status: "FAILED",
      message: "Kroger returned without a connection approval for this iPhone session. Your basket was not changed.",
    };
  }

  try {
    const authorization = await completeAndVerifyKrogerAuthorization(
      comparisonId,
      callbackDecision.completion,
      { signal },
    );
    return { status: "CONNECTED", authorization };
  } catch (error) {
    if (signal?.aborted) return stopped();
    return {
      status: "FAILED",
      message: error instanceof Error
        ? error.message
        : "Cartiva could not verify the Kroger connection.",
    };
  }
}

export async function disconnectKroger(signal?: AbortSignal) {
  return withHandoffReadDeadline(
    signal,
    "Disconnecting Kroger took too long. No account change is being assumed; check again.",
    async (boundedSignal) => {
      const response = await mobileSessionFetch("api/mobile/v1/kroger/auth/disconnect", {
        method: "POST",
        signal: boundedSignal,
      });
      if (!response.ok) {
        throw new Error(await responseError(
          response,
          "Cartiva could not disconnect Kroger.",
        ));
      }
      return parseKrogerAuthorizationStatus(await response.json() as unknown);
    },
  );
}

export async function addComparisonToKrogerCart(
  comparison: KrogerCartComparisonIdentity,
  options: { timeoutMs?: number } = {},
): Promise<KrogerCartAddOutcome> {
  let response: Response;
  let value: {
    status?: unknown;
    success?: unknown;
    operationId?: unknown;
    comparisonId?: unknown;
    replayed?: unknown;
    addedCount?: unknown;
    itemCount?: unknown;
    message?: unknown;
    handoff?: Partial<ConfirmedKrogerCartAdd["handoff"]>;
    error?: unknown;
    code?: unknown;
    retrySafe?: unknown;
    reviewHandoff?: Partial<KrogerCartReviewHandoff>;
  } = {};
  let parsedResponse = false;
  const controller = new AbortController();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeout = setTimeout(() => {
    // A cart write may already have committed. Resolve the local wait first,
    // then abort transport and classify the result as outcome unknown.
    rejectDeadline(new Error("Kroger cart response timed out."));
    controller.abort();
  }, options.timeoutMs ?? 20_000);
  try {
    response = await Promise.race([
      mobileSessionFetch("api/mobile/v1/kroger/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comparisonId: comparison.comparisonId }),
        signal: controller.signal,
      }),
      deadline,
    ]);
    try {
      value = await Promise.race([response.json(), deadline]) as typeof value;
      parsedResponse = true;
    } catch {
      // A Kroger write may have completed even when its response was interrupted.
    }
  } catch {
    return {
      status: "OUTCOME_UNKNOWN",
      success: false,
      error: "Cartiva lost the connection before Kroger's response arrived. Check your retailer cart before trying again.",
      code: "outcome_unknown",
      retrySafe: false,
    };
  } finally {
    clearTimeout(timeout);
  }
  const validHandoffUrl = isTrustedKrogerCartUrl(value.handoff?.url);
  if (
    response.ok
    && value.status === "CONFIRMED"
    && value.success === true
    && typeof value.operationId === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(value.operationId)
    && value.comparisonId === comparison.comparisonId
    && typeof value.replayed === "boolean"
    && typeof value.addedCount === "number"
    && Number.isSafeInteger(value.addedCount)
    && value.addedCount > 0
    && typeof value.itemCount === "number"
    && Number.isSafeInteger(value.itemCount)
    && value.itemCount > 0
    && typeof value.message === "string"
    && value.handoff?.mode === "CART_TRANSFER_SUPPORTED"
    && validHandoffUrl
    && value.handoff.retailerBanner === comparison.retailerBanner
    && value.handoff.locationId === comparison.locationId
    && typeof value.handoff.locationName === "string"
    && value.handoff.locationBoundByCartApi === false
    && value.handoff.storeSelectionMustBeConfirmed === true
  ) {
    return value as ConfirmedKrogerCartAdd;
  }
  if (response.ok && value.status === "CONFIRMED" && value.success === true) {
    return {
      status: "OUTCOME_UNKNOWN",
      success: false,
      ...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
      error: "Kroger reported a cart update, but Cartiva could not safely verify its retailer handoff. Check the retailer cart before trying again.",
      code: "outcome_unknown",
      retrySafe: false,
    };
  }
  if (!parsedResponse) {
    return {
      status: "OUTCOME_UNKNOWN",
      success: false,
      error: "Cartiva could not verify Kroger's response. Check your retailer cart before trying again.",
      code: "outcome_unknown",
      retrySafe: false,
    };
  }
  let reviewHandoff: KrogerCartReviewHandoff | undefined;
  try {
    if (
      value.reviewHandoff
      && isTrustedKrogerCartUrl(value.reviewHandoff.url)
      && value.reviewHandoff.retailerBanner === comparison.retailerBanner
      && value.reviewHandoff.locationId === comparison.locationId
      && typeof value.reviewHandoff.locationName === "string"
      && value.reviewHandoff.locationBoundByCartApi === false
      && value.reviewHandoff.storeSelectionMustBeConfirmed === true
    ) {
      reviewHandoff = value.reviewHandoff as KrogerCartReviewHandoff;
    }
  } catch {
    reviewHandoff = undefined;
  }
  return {
    status: value.status === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "FAILED",
    success: false,
    ...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
    error: typeof value.error === "string"
      ? value.error
      : "Kroger did not confirm that the basket was added.",
    code: typeof value.code === "string" ? value.code : "invalid_response",
    retrySafe: value.retrySafe === true,
    ...(reviewHandoff ? { reviewHandoff } : {}),
  };
}
