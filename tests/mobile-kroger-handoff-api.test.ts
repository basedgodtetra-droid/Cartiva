import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mobileSessionFetch: vi.fn(),
}));

vi.mock("../mobile/src/services/mobile-session", () => ({
  mobileSessionFetch: mocks.mobileSessionFetch,
}));
import {
  addComparisonToKrogerCart,
  authorizeKroger,
  completeAndVerifyKrogerAuthorization,
  disconnectKroger,
  getKrogerAuthorizationStatus,
  startKrogerAuthorization,
} from "../mobile/src/services/kroger-handoff-api";
import { webBrowserTestDouble } from "./test-doubles/expo-web-browser";

const identity = {
  comparisonId: "comparison_handoff_api_001",
  locationId: "62000115",
  retailerBanner: "King Soopers",
};

function capability() {
  return {
    mode: "CART_TRANSFER_SUPPORTED" as const,
    cartTransferSupported: true,
    requiresRetailerCheckout: true as const,
    requiresCustomerAuthorization: true,
    cartApiLocationBound: false as const,
    requiresStoreConfirmation: true as const,
    configured: true,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal("__DEV__", true);
  mocks.mobileSessionFetch.mockReset();
  webBrowserTestDouble.openAuthSessionAsync = async () => ({ type: "cancel" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mobile Kroger handoff API", () => {
  it.each([
    ["status", () => getKrogerAuthorizationStatus()],
    ["authorization start", () => startKrogerAuthorization(identity.comparisonId)],
    ["disconnect", () => disconnectKroger()],
  ])("times out a %s response whose headers arrive but JSON body stalls", async (_label, request) => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    mocks.mobileSessionFetch.mockImplementationOnce((_path: string, init: RequestInit) => {
      requestSignal = init.signal;
      return Promise.resolve(new Response(new ReadableStream({
        start() {
          // Deliberately never enqueue or close: response headers are present,
          // while the body behaves like a stalled mobile connection.
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });

    const pending = request();
    const rejection = expect(pending).rejects.toThrow(/took too long/i);
    await vi.advanceTimersByTimeAsync(12_100);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([
    ["missing capability", { retailer: "kroger", authorization: "CONNECTED" }],
    ["unknown authorization", {
      retailer: "kroger",
      authorization: "AUTHORIZED",
      capability: capability(),
    }],
    ["inconsistent unavailable status", {
      retailer: "kroger",
      authorization: "UNAVAILABLE",
      capability: capability(),
    }],
    ["extra response field", {
      retailer: "kroger",
      authorization: "CONNECTED",
      capability: capability(),
      accessToken: "must-not-be-accepted",
    }],
  ])("rejects a malformed successful status payload: %s", async (_label, payload) => {
    mocks.mobileSessionFetch.mockResolvedValueOnce(Response.json(payload));
    await expect(getKrogerAuthorizationStatus()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("requires an exact NOT_CONNECTED response before confirming disconnect", async () => {
    mocks.mobileSessionFetch.mockResolvedValueOnce(Response.json({
      retailer: "kroger",
      authorization: "NOT_CONNECTED",
      capability: capability(),
    }));
    await expect(disconnectKroger()).resolves.toMatchObject({
      authorization: "NOT_CONNECTED",
    });
  });

  it("treats an otherwise confirmed response with an untrusted cart URL as outcome unknown", async () => {
    mocks.mobileSessionFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      status: "CONFIRMED",
      success: true,
      operationId: "A".repeat(43),
      comparisonId: identity.comparisonId,
      replayed: false,
      addedCount: 1,
      itemCount: 1,
      message: "confirmed",
      handoff: {
        mode: "CART_TRANSFER_SUPPORTED",
        url: "https://www.kingsoopers.com.evil.example/cart",
        retailerBanner: identity.retailerBanner,
        locationId: identity.locationId,
        locationName: "King Soopers — Union Station",
        locationBoundByCartApi: false,
        storeSelectionMustBeConfirmed: true,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(addComparisonToKrogerCart(identity)).resolves.toMatchObject({
      status: "OUTCOME_UNKNOWN",
      success: false,
      retrySafe: false,
      code: "outcome_unknown",
    });
  });

  it("uses an ephemeral browser and redeems pending approval before reporting connected", async () => {
    mocks.mobileSessionFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        retailer: "kroger",
        comparisonId: identity.comparisonId,
        authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/authorize?state=opaque",
        returnUrl: "https://api.cartiva.test/oauth/kroger",
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        retailer: "kroger",
        authorization: "CONNECTED",
        comparisonId: identity.comparisonId,
        capability: capability(),
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        retailer: "kroger",
        authorization: "CONNECTED",
        capability: capability(),
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const openAuthSessionAsync = vi.fn(async () => ({
      type: "success",
      url: `https://api.cartiva.test/oauth/kroger?status=pending&comparisonId=${identity.comparisonId}&completion=${"B".repeat(43)}`,
    } as const));
    webBrowserTestDouble.openAuthSessionAsync = openAuthSessionAsync;

    await expect(authorizeKroger(identity.comparisonId)).resolves.toMatchObject({
      status: "CONNECTED",
      authorization: { authorization: "CONNECTED" },
    });
    expect(openAuthSessionAsync).toHaveBeenCalledWith(
      expect.stringContaining("api.kroger.com"),
      "https://api.cartiva.test/oauth/kroger",
      { preferEphemeralSession: true, preferUniversalLinks: true },
    );
    expect(mocks.mobileSessionFetch.mock.calls[1]).toEqual([
      "api/mobile/v1/kroger/auth/complete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ completion: "B".repeat(43) }),
      }),
    ]);
  });

  it.each([
    ["wrong retailer", {
      retailer: "target",
      comparisonId: identity.comparisonId,
      authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/authorize?state=opaque",
      returnUrl: "https://api.cartiva.test/oauth/kroger",
    }],
    ["wrong comparison", {
      retailer: "kroger",
      comparisonId: "comparison_handoff_api_002",
      authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/authorize?state=opaque",
      returnUrl: "https://api.cartiva.test/oauth/kroger",
    }],
    ["lookalike Kroger origin", {
      retailer: "kroger",
      comparisonId: identity.comparisonId,
      authorizationUrl: "https://api.kroger.com.evil.example/v1/connect/oauth2/authorize?state=opaque",
      returnUrl: "https://api.cartiva.test/oauth/kroger",
    }],
    ["wrong Kroger authorization path", {
      retailer: "kroger",
      comparisonId: identity.comparisonId,
      authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/token?state=opaque",
      returnUrl: "https://api.cartiva.test/oauth/kroger",
    }],
    ["unsafe return base", {
      retailer: "kroger",
      comparisonId: identity.comparisonId,
      authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/authorize?state=opaque",
      returnUrl: "https://api.cartiva.test.evil.example/oauth/kroger?continue=1",
    }],
    ["unclaimed return host", {
      retailer: "kroger",
      comparisonId: identity.comparisonId,
      authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/authorize?state=opaque",
      returnUrl: "https://unclaimed.example/oauth/kroger",
    }],
  ])("rejects a %s start payload before opening a browser", async (_label, payload) => {
    mocks.mobileSessionFetch.mockResolvedValueOnce(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const openAuthSessionAsync = vi.fn(async () => ({ type: "cancel" } as const));
    webBrowserTestDouble.openAuthSessionAsync = openAuthSessionAsync;

    await expect(authorizeKroger(identity.comparisonId)).resolves.toMatchObject({
      status: "FAILED",
      code: "invalid_response",
    });
    expect(openAuthSessionAsync).not.toHaveBeenCalled();
  });

  it.each([
    "https://api.cartiva.test.evil.example/oauth/kroger",
    "https://api.cartiva.test/oauth/not-kroger",
    "cartiva://oauth/kroger",
  ])("rejects a callback from a different base before redeeming it: %s", async (callbackBase) => {
    mocks.mobileSessionFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      retailer: "kroger",
      comparisonId: identity.comparisonId,
      authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/authorize?state=opaque",
      returnUrl: "https://api.cartiva.test/oauth/kroger",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    webBrowserTestDouble.openAuthSessionAsync = async () => ({
      type: "success",
      url: `${callbackBase}?status=pending&comparisonId=${identity.comparisonId}&completion=${"D".repeat(43)}`,
    });

    await expect(authorizeKroger(identity.comparisonId)).resolves.toMatchObject({
      status: "FAILED",
    });
    expect(mocks.mobileSessionFetch).toHaveBeenCalledTimes(1);
  });

  it("uses the custom-scheme callback API only for the explicit development return", async () => {
    mocks.mobileSessionFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      retailer: "kroger",
      comparisonId: identity.comparisonId,
      authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/authorize?state=opaque",
      returnUrl: "cartiva://oauth/kroger",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const openAuthSessionAsync = vi.fn(async () => ({ type: "cancel" } as const));
    webBrowserTestDouble.openAuthSessionAsync = openAuthSessionAsync;

    await expect(authorizeKroger(identity.comparisonId)).resolves.toMatchObject({
      status: "CANCELLED",
    });
    expect(openAuthSessionAsync).toHaveBeenCalledWith(
      expect.stringContaining("api.kroger.com"),
      "cartiva://oauth/kroger",
      { preferEphemeralSession: true, preferUniversalLinks: false },
    );
  });

  it("rejects the development custom scheme in a production bundle", async () => {
    vi.stubGlobal("__DEV__", false);
    mocks.mobileSessionFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      retailer: "kroger",
      comparisonId: identity.comparisonId,
      authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/authorize?state=opaque",
      returnUrl: "cartiva://oauth/kroger",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const openAuthSessionAsync = vi.fn(async () => ({ type: "cancel" } as const));
    webBrowserTestDouble.openAuthSessionAsync = openAuthSessionAsync;

    await expect(authorizeKroger(identity.comparisonId)).resolves.toMatchObject({
      status: "FAILED",
      code: "invalid_response",
    });
    expect(openAuthSessionAsync).not.toHaveBeenCalled();
  });

  it("aborts a stalled recovery status after an interrupted activation", async () => {
    vi.useFakeTimers();
    let recoveryAborted = false;
    mocks.mobileSessionFetch
      .mockRejectedValueOnce(new TypeError("activation response interrupted"))
      .mockImplementationOnce((_path: string, init: RequestInit) => new Promise<Response>(
        (_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            recoveryAborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        },
      ));

    const result = completeAndVerifyKrogerAuthorization(
      identity.comparisonId,
      "C".repeat(43),
      { timeoutMs: 25 },
    );
    const rejection = expect(result).rejects.toThrow("activation response interrupted");
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
    expect(recoveryAborted).toBe(true);
    vi.useRealTimers();
  });

  it("settles when authorization headers arrive but the completion JSON body stalls", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    mocks.mobileSessionFetch.mockImplementationOnce((_path: string, init: RequestInit) => {
      requestSignal = init.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise<never>(() => undefined),
      } as unknown as Response);
    });

    const pending = completeAndVerifyKrogerAuthorization(
      identity.comparisonId,
      "D".repeat(43),
      { timeoutMs: 25 },
    );
    const rejection = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("classifies a stalled cart response body as outcome unknown and never retry-safe", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    mocks.mobileSessionFetch.mockImplementationOnce((_path: string, init: RequestInit) => {
      requestSignal = init.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise<never>(() => undefined),
      } as unknown as Response);
    });

    const pending = addComparisonToKrogerCart(identity, { timeoutMs: 25 });
    const outcome = expect(pending).resolves.toMatchObject({
      status: "OUTCOME_UNKNOWN",
      success: false,
      retrySafe: false,
    });
    await vi.advanceTimersByTimeAsync(30);
    await outcome;
    expect(requestSignal?.aborted).toBe(true);
  });
});
