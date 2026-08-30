import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GET as capabilitiesGet } from "@/app/api/mobile/v1/capabilities/route";
import { POST as authStartPost } from "@/app/api/mobile/v1/kroger/auth/start/route";
import { POST as authCompletePost } from "@/app/api/mobile/v1/kroger/auth/complete/route";
import { GET as authStatusGet } from "@/app/api/mobile/v1/kroger/auth/status/route";
import { GET as oauthCallbackGet } from "@/app/api/mobile/v1/kroger/oauth/callback/route";
import { POST as sessionPost } from "@/app/api/mobile/v1/session/route";
import { resetRateLimitsForTests } from "@/lib/api-security";
import {
  mobileKrogerCartOperationIdentity,
  resetKrogerCartOperationsForTests,
  runKrogerCartOperation,
} from "@/lib/kroger-cart-operations";
import {
  disconnectMobileKroger,
  resetMobileKrogerAuthForTests,
} from "@/lib/kroger-mobile-auth";
import {
  loadComparisonReceipt,
  resetComparisonReceiptsForTests,
  saveComparisonReceipt,
} from "@/lib/mobile-comparison-receipts";
import { withMobileOwnerOperationLock } from "@/lib/mobile-owner-operation-lock";
import { issueMobileSession } from "@/lib/mobile-session";
import {
  AvailabilityStatus,
  BasketCompleteness,
  type ComparisonSessionReceipt,
} from "@/packages/shared/src";

let directory: string;

function comparison(
  comparisonId: string,
  complete = true,
): ComparisonSessionReceipt {
  const checkedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    comparisonId,
    retailer: "kroger",
    retailerChain: "KINGSOOPERS",
    retailerBanner: "King Soopers",
    locationId: "62000115",
    locationName: "King Soopers — Union Station",
    locationAddress: "1950 Chestnut Pl, Denver, CO 80202",
    zipCode: "80202",
    fulfillmentMode: "pickup",
    requestedItemIds: ["bread"],
    basketLines: [{
      lineId: `${comparisonId}:bread`,
      requestedItemId: "bread",
      requestedItem: "bread",
      normalizedIntent: "bread",
      quantity: 1,
      status: complete ? "ACCEPTED" : "UNMATCHED",
      ...(complete ? {
        retailerProductId: "0001111008473",
        upc: "0001111008473",
        matchedProduct: "Kroger White Bread",
        priceCents: 199,
        provenance: {
          dataSource: "kroger_public_api" as const,
          priceSource: "kroger_location_product" as const,
          priceScope: "exact_store" as const,
          priceReliability: "verified" as const,
          exactStoreVerified: true,
          sourceLocationId: "62000115",
          fulfillment: ["pickup" as const],
          checkedAt,
        },
      } : {}),
      locationId: "62000115",
      availabilityStatus: complete
        ? AvailabilityStatus.VERIFIED_IN_STOCK
        : AvailabilityStatus.UNKNOWN,
      matchConfidence: complete ? "high" : "low",
    }],
    completeness: complete ? BasketCompleteness.COMPLETE : BasketCompleteness.INCOMPLETE,
    checkedAt,
    createdAt: checkedAt,
  };
}

function authorizedJsonRequest(token: string, pathname: string, body: unknown) {
  return new Request(`https://api.cartiva.test${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": "203.0.113.77",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-mobile-auth-routes-"));
  vi.stubEnv("CARTIVA_SESSION_SECRET", "mobile-auth-route-secret-at-least-thirty-two-characters");
  vi.stubEnv("CARTIVA_ENABLE_KROGER_CART_WRITES", "true");
  vi.stubEnv("KROGER_CLIENT_ID", "mobile-client-id");
  vi.stubEnv("KROGER_CLIENT_SECRET", "mobile-client-secret");
  vi.stubEnv(
    "KROGER_MOBILE_REDIRECT_URI",
    "https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback",
  );
  vi.stubEnv("CARTIVA_MOBILE_OAUTH_STATE_DIR", path.join(directory, "states"));
  vi.stubEnv("CARTIVA_MOBILE_OAUTH_COMPLETION_DIR", path.join(directory, "completions"));
  vi.stubEnv("CARTIVA_MOBILE_KROGER_SESSION_DIR", path.join(directory, "sessions"));
  vi.stubEnv("CARTIVA_MOBILE_SESSION_FILE", path.join(directory, "mobile-sessions.json"));
  vi.stubEnv("CARTIVA_COMPARISON_RECEIPT_FILE", path.join(directory, "comparisons.json"));
  vi.stubEnv("KROGER_CART_RECEIPT_FILE", path.join(directory, "cart-receipts.json"));
  resetMobileKrogerAuthForTests();
  resetComparisonReceiptsForTests();
  resetKrogerCartOperationsForTests();
  resetRateLimitsForTests();
});

function completionFromCallback(response: Response) {
  const location = new URL(response.headers.get("Location")!);
  expect(location.protocol).toBe("cartiva:");
  expect(location.hostname).toBe("oauth");
  expect(location.pathname).toBe("/kroger");
  expect(location.searchParams.get("status")).toBe("pending");
  const completion = location.searchParams.get("completion");
  expect(completion).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return completion!;
}

function completeRequest(sessionToken: string, completion: string) {
  return authCompletePost(authorizedJsonRequest(
    sessionToken,
    "/api/mobile/v1/kroger/auth/complete",
    { completion },
  ));
}

async function recordConfirmedCartOperation(
  ownerId: string,
  receipt: ComparisonSessionReceipt,
  fingerprintCharacter = "C",
) {
  const operation = mobileKrogerCartOperationIdentity(ownerId, receipt.comparisonId);
  await runKrogerCartOperation(
    operation.internalOperationId,
    fingerprintCharacter.repeat(43),
    async () => ({
      success: true as const,
      addedCount: 1,
      itemCount: 1,
      cartUrl: "https://www.kingsoopers.com/cart",
      chain: "King Soopers",
      selectedSearchLocation: {
        locationId: receipt.locationId,
        name: receipt.locationName,
      },
      locationBoundByCartApi: false as const,
      message: "confirmed",
    }),
    undefined,
    {
      ownerId,
      comparisonId: receipt.comparisonId,
      publicOperationId: operation.publicOperationId,
      cartUrl: "https://www.kingsoopers.com/cart",
      retailerBanner: receipt.retailerBanner,
      locationId: receipt.locationId,
      locationName: receipt.locationName,
      locationBoundByCartApi: false,
      storeSelectionMustBeConfirmed: true,
    },
  );
}

afterEach(() => {
  resetMobileKrogerAuthForTests();
  resetComparisonReceiptsForTests();
  resetKrogerCartOperationsForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("mobile Kroger authorization routes", () => {
  it("validates the Cartiva bearer before checking Kroger connection state", async () => {
    const response = await authStatusGet(new Request(
      "https://api.cartiva.test/api/mobile/v1/kroger/auth/status",
      { headers: { "X-Forwarded-For": "203.0.113.76" } },
    ));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "missing" });
  });

  it("advertises temporary-session cart transfer only when secure callback config exists", async () => {
    const response = capabilitiesGet(new Request(
      "https://api.cartiva.test/api/mobile/v1/capabilities",
      { headers: { "X-Forwarded-For": "203.0.113.78" } },
    ));
    expect(await response.json()).toMatchObject({
      access: "ANONYMOUS_WITH_TEMPORARY_SESSION",
      retailers: [{
        id: "kroger",
        handoff: {
          mode: "CART_TRANSFER_SUPPORTED",
          cartTransferSupported: true,
          requiresCustomerAuthorization: true,
          cartApiLocationBound: false,
          requiresStoreConfirmation: true,
        },
      }],
    });
  });

  it("issues a temporary bearer without exposing Kroger credentials", async () => {
    const response = await sessionPost(new Request(
      "https://api.cartiva.test/api/mobile/v1/session",
      { method: "POST", headers: { "X-Forwarded-For": "203.0.113.79" } },
    ));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.sessionToken).toMatch(/^v1\./);
    expect(JSON.stringify(body)).not.toMatch(/mobile-client-secret|access_token|refresh_token/i);
  });

  it("requires an owned, unexpired, complete receipt before opening Kroger sign-in", async () => {
    const issued = issueMobileSession();
    const missing = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: "comparison_missing_001" },
    ));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "comparison_unavailable" });

    const incomplete = comparison("comparison_incomplete_01", false);
    await saveComparisonReceipt(issued.ownerId, incomplete);
    const rejected = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: incomplete.comparisonId },
    ));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ code: "basket_incomplete" });

    const unverified = comparison("comparison_unverified_auth_1");
    unverified.basketLines[0].availabilityStatus = AvailabilityStatus.LIKELY_AVAILABLE;
    await saveComparisonReceipt(issued.ownerId, unverified);
    const unverifiedResponse = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: unverified.comparisonId },
    ));
    expect(unverifiedResponse.status).toBe(409);
    expect(await unverifiedResponse.json()).toMatchObject({ code: "inventory_unverified" });

    const stale = comparison("comparison_stale_auth_001");
    stale.checkedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    await saveComparisonReceipt(issued.ownerId, stale);
    const staleResponse = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: stale.comparisonId },
    ));
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ code: "comparison_stale" });
  });

  it("handles customer cancellation without losing or consuming the comparison receipt", async () => {
    const issued = issueMobileSession();
    const receipt = comparison("comparison_cancel_auth_01");
    await saveComparisonReceipt(issued.ownerId, receipt);
    const start = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    const authorizationUrl = new URL((await start.json()).authorizationUrl);
    const callback = await oauthCallbackGet(new Request(
      `https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback?error=access_denied&state=${authorizationUrl.searchParams.get("state")}`,
    ));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location"))
      .toBe(`cartiva://oauth/kroger?status=cancelled&comparisonId=${receipt.comparisonId}`);
    expect(await loadComparisonReceipt(issued.ownerId, receipt.comparisonId)).not.toBeNull();
  });

  it("cannot reconnect from an old browser callback after explicit disconnect", async () => {
    const providerFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: "late-access",
      refresh_token: "late-refresh",
      expires_in: 1_800,
      scope: "cart.basic:write profile.compact product.compact",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", providerFetch);
    const issued = issueMobileSession();
    const receipt = comparison("comparison_disconnect_callback");
    await saveComparisonReceipt(issued.ownerId, receipt);
    const start = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    const authorizationUrl = new URL((await start.json()).authorizationUrl);

    await disconnectMobileKroger(issued.ownerId);
    const callback = await oauthCallbackGet(new Request(
      `https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback?code=late-code&state=${authorizationUrl.searchParams.get("state")}`,
    ));
    expect(callback.headers.get("Location")).toBe("cartiva://oauth/kroger?status=failed");
    expect(providerFetch).not.toHaveBeenCalled();
    const status = await authStatusGet(new Request(
      "https://api.cartiva.test/api/mobile/v1/kroger/auth/status",
      { headers: { Authorization: `Bearer ${issued.sessionToken}`, "X-Forwarded-For": "203.0.113.85" } },
    ));
    expect(await status.json()).toMatchObject({ authorization: "NOT_CONNECTED" });
  });

  it("does not reauthorize an already-submitted comparison for another account", async () => {
    const issued = issueMobileSession();
    const receipt = comparison("comparison_submitted_auth_1");
    await saveComparisonReceipt(issued.ownerId, receipt);
    const operation = mobileKrogerCartOperationIdentity(issued.ownerId, receipt.comparisonId);
    await runKrogerCartOperation(
      operation.internalOperationId,
      "A".repeat(43),
      async () => ({
        success: true as const,
        addedCount: 1,
        itemCount: 1,
        cartUrl: "https://www.kingsoopers.com/cart",
        chain: "King Soopers",
        selectedSearchLocation: {
          locationId: "62000115",
          name: "King Soopers — Union Station",
        },
        locationBoundByCartApi: false as const,
        message: "confirmed",
      }),
      undefined,
      {
        ownerId: issued.ownerId,
        comparisonId: receipt.comparisonId,
        publicOperationId: operation.publicOperationId,
        cartUrl: "https://www.kingsoopers.com/cart",
        retailerBanner: "King Soopers",
        locationId: "62000115",
        locationName: "King Soopers — Union Station",
        locationBoundByCartApi: false,
        storeSelectionMustBeConfirmed: true,
      },
    );
    await disconnectMobileKroger(issued.ownerId);

    const response = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "comparison_already_submitted" });
  });

  it("rechecks cart history inside the same owner lock that registers OAuth state", async () => {
    const issued = issueMobileSession();
    const receipt = comparison("comparison_auth_history_race");
    await saveComparisonReceipt(issued.ownerId, receipt);
    let releaseOwnerLock!: () => void;
    let ownerLockEntered!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseOwnerLock = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      ownerLockEntered = resolve;
    });
    const lock = withMobileOwnerOperationLock(issued.ownerId, async () => {
      ownerLockEntered();
      await release;
    });
    await entered;
    const startRequest = authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));

    const operation = mobileKrogerCartOperationIdentity(issued.ownerId, receipt.comparisonId);
    await runKrogerCartOperation(
      operation.internalOperationId,
      "B".repeat(43),
      async () => ({
        success: true as const,
        addedCount: 1,
        itemCount: 1,
        cartUrl: "https://www.kingsoopers.com/cart",
        chain: "King Soopers",
        selectedSearchLocation: {
          locationId: receipt.locationId,
          name: receipt.locationName,
        },
        locationBoundByCartApi: false as const,
        message: "confirmed",
      }),
      undefined,
      {
        ownerId: issued.ownerId,
        comparisonId: receipt.comparisonId,
        publicOperationId: operation.publicOperationId,
        cartUrl: "https://www.kingsoopers.com/cart",
        retailerBanner: receipt.retailerBanner,
        locationId: receipt.locationId,
        locationName: receipt.locationName,
        locationBoundByCartApi: false,
        storeSelectionMustBeConfirmed: true,
      },
    );
    releaseOwnerLock();
    await lock;

    const response = await startRequest;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "comparison_already_submitted" });
  });

  it("verifies a real token response server-side before status becomes connected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "customer-access",
      refresh_token: "customer-refresh",
      expires_in: 1_800,
      scope: "cart.basic:write profile.compact product.compact",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const issued = issueMobileSession();
    const receipt = comparison("comparison_connect_auth_01");
    await saveComparisonReceipt(issued.ownerId, receipt);
    const start = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    const authorizationUrl = new URL((await start.json()).authorizationUrl);
    const callback = await oauthCallbackGet(new Request(
      `https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback?code=real-code&state=${authorizationUrl.searchParams.get("state")}`,
    ));
    const completion = completionFromCallback(callback);

    const pendingStatus = await authStatusGet(new Request(
      "https://api.cartiva.test/api/mobile/v1/kroger/auth/status",
      { headers: { Authorization: `Bearer ${issued.sessionToken}`, "X-Forwarded-For": "203.0.113.80" } },
    ));
    expect(await pendingStatus.json()).toMatchObject({ authorization: "NOT_CONNECTED" });

    const completed = await completeRequest(issued.sessionToken, completion);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      authorization: "CONNECTED",
      comparisonId: receipt.comparisonId,
    });

    const status = await authStatusGet(new Request(
      "https://api.cartiva.test/api/mobile/v1/kroger/auth/status",
      { headers: { Authorization: `Bearer ${issued.sessionToken}`, "X-Forwarded-For": "203.0.113.80" } },
    ));
    expect(await status.json()).toMatchObject({ authorization: "CONNECTED" });

    const duplicateStart = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    expect(duplicateStart.status).toBe(409);
    expect(await duplicateStart.json()).toMatchObject({ code: "already_connected" });
  });

  it("does not let a forwarded browser approval bind to a different mobile owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "forwarded-customer-access",
      refresh_token: "forwarded-customer-refresh",
      expires_in: 1_800,
      scope: "cart.basic:write profile.compact product.compact",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const initiatingOwner = issueMobileSession();
    const otherOwner = issueMobileSession();
    const receipt = comparison("comparison_forwarded_auth_1");
    await saveComparisonReceipt(initiatingOwner.ownerId, receipt);
    const start = await authStartPost(authorizedJsonRequest(
      initiatingOwner.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    const authorizationUrl = new URL((await start.json()).authorizationUrl);
    const callback = await oauthCallbackGet(new Request(
      `https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback?code=forwarded-code&state=${authorizationUrl.searchParams.get("state")}`,
    ));
    const completion = completionFromCallback(callback);

    const wrongOwner = await completeRequest(otherOwner.sessionToken, completion);
    expect(wrongOwner.status).toBe(400);
    expect(await wrongOwner.json()).toMatchObject({ code: "oauth_binding" });
    const stillDisconnected = await authStatusGet(new Request(
      "https://api.cartiva.test/api/mobile/v1/kroger/auth/status",
      { headers: { Authorization: `Bearer ${initiatingOwner.sessionToken}`, "X-Forwarded-For": "203.0.113.83" } },
    ));
    expect(await stillDisconnected.json()).toMatchObject({ authorization: "NOT_CONNECTED" });

    const correctOwner = await completeRequest(initiatingOwner.sessionToken, completion);
    expect(correctOwner.status).toBe(200);
    expect(await correctOwner.json()).toMatchObject({ authorization: "CONNECTED" });
  });

  it("blocks an older callback when cart history appears while Safari is open", async () => {
    const providerFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: "stale-browser-access",
      refresh_token: "stale-browser-refresh",
      expires_in: 1_800,
      scope: "cart.basic:write profile.compact product.compact",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", providerFetch);
    const issued = issueMobileSession();
    const receipt = comparison("comparison_callback_history");
    await saveComparisonReceipt(issued.ownerId, receipt);
    const start = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    const authorizationUrl = new URL((await start.json()).authorizationUrl);
    await recordConfirmedCartOperation(issued.ownerId, receipt);

    const callback = await oauthCallbackGet(new Request(
      `https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback?code=older-code&state=${authorizationUrl.searchParams.get("state")}`,
    ));
    expect(callback.headers.get("Location"))
      .toBe(`cartiva://oauth/kroger?status=failed&comparisonId=${receipt.comparisonId}`);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("blocks pending-token activation when cart history appears after callback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "pending-history-access",
      refresh_token: "pending-history-refresh",
      expires_in: 1_800,
      scope: "cart.basic:write profile.compact product.compact",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const issued = issueMobileSession();
    const receipt = comparison("comparison_activation_history");
    await saveComparisonReceipt(issued.ownerId, receipt);
    const start = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    const authorizationUrl = new URL((await start.json()).authorizationUrl);
    const callback = await oauthCallbackGet(new Request(
      `https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback?code=pending-code&state=${authorizationUrl.searchParams.get("state")}`,
    ));
    const completion = completionFromCallback(callback);
    await recordConfirmedCartOperation(issued.ownerId, receipt, "D");

    const completed = await completeRequest(issued.sessionToken, completion);
    expect(completed.status).toBe(409);
    expect(await completed.json()).toMatchObject({ code: "cart_history" });
    const status = await authStatusGet(new Request(
      "https://api.cartiva.test/api/mobile/v1/kroger/auth/status",
      { headers: { Authorization: `Bearer ${issued.sessionToken}`, "X-Forwarded-For": "203.0.113.84" } },
    ));
    expect(await status.json()).toMatchObject({ authorization: "NOT_CONNECTED" });
  });

  it("returns Kroger's transient status failure without mislabeling the mobile bearer", async () => {
    const providerFetch = vi.fn(async () => {
      if (providerFetch.mock.calls.length === 1) {
        return new Response(JSON.stringify({
          access_token: "short-lived-customer-access",
          refresh_token: "short-lived-customer-refresh",
          expires_in: 1,
          scope: "cart.basic:write profile.compact product.compact",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new TypeError("temporary provider outage");
    });
    vi.stubGlobal("fetch", providerFetch);
    const issued = issueMobileSession();
    const receipt = comparison("comparison_status_transient_1");
    await saveComparisonReceipt(issued.ownerId, receipt);
    const start = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    const authorizationUrl = new URL((await start.json()).authorizationUrl);
    const callback = await oauthCallbackGet(new Request(
      `https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback?code=real-code&state=${authorizationUrl.searchParams.get("state")}`,
    ));
    const completion = completionFromCallback(callback);
    expect((await completeRequest(issued.sessionToken, completion)).status).toBe(502);

    const status = await authStatusGet(new Request(
      "https://api.cartiva.test/api/mobile/v1/kroger/auth/status",
      { headers: { Authorization: `Bearer ${issued.sessionToken}`, "X-Forwarded-For": "203.0.113.81" } },
    ));
    expect(status.status).toBe(502);
    expect(await status.json()).toMatchObject({
      code: "upstream",
      error: "Kroger authorization did not respond in time.",
    });
  });

  it("returns a controlled 503 when Kroger connection state storage fails", async () => {
    const providerFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: `customer-access-${providerFetch.mock.calls.length}`,
      refresh_token: `customer-refresh-${providerFetch.mock.calls.length}`,
      expires_in: providerFetch.mock.calls.length === 1 ? 1 : 1_800,
      scope: "cart.basic:write profile.compact product.compact",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", providerFetch);
    const issued = issueMobileSession();
    const receipt = comparison("comparison_status_storage_01");
    await saveComparisonReceipt(issued.ownerId, receipt);
    const start = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    const authorizationUrl = new URL((await start.json()).authorizationUrl);
    const callback = await oauthCallbackGet(new Request(
      `https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback?code=real-code&state=${authorizationUrl.searchParams.get("state")}`,
    ));
    const completion = completionFromCallback(callback);
    expect((await completeRequest(issued.sessionToken, completion)).status).toBe(200);

    const sessionDirectory = path.join(directory, "sessions");
    await rm(sessionDirectory, { recursive: true, force: true });
    await mkdir(path.join(sessionDirectory, `${issued.ownerId}.json`), { recursive: true });
    resetMobileKrogerAuthForTests();

    const status = await authStatusGet(new Request(
      "https://api.cartiva.test/api/mobile/v1/kroger/auth/status",
      { headers: { Authorization: `Bearer ${issued.sessionToken}`, "X-Forwarded-For": "203.0.113.82" } },
    ));
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({
      code: "storage",
      error: "Cartiva could not verify the saved Kroger connection. Disconnect it explicitly or restore secure storage before reconnecting.",
    });
  });

  it("never logs or returns OAuth codes, tokens, or provider descriptions", async () => {
    const providerDescription = "invalid code secret-code-123 token customer-token-456";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: providerDescription,
    }), { status: 400, headers: { "Content-Type": "application/json" } })));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const issued = issueMobileSession();
    const receipt = comparison("comparison_redacted_auth_01");
    await saveComparisonReceipt(issued.ownerId, receipt);
    const start = await authStartPost(authorizedJsonRequest(
      issued.sessionToken,
      "/api/mobile/v1/kroger/auth/start",
      { comparisonId: receipt.comparisonId },
    ));
    const authorizationUrl = new URL((await start.json()).authorizationUrl);
    const callback = await oauthCallbackGet(new Request(
      `https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback?code=secret-code-123&state=${authorizationUrl.searchParams.get("state")}`,
    ));

    expect(callback.headers.get("Location"))
      .toBe(`cartiva://oauth/kroger?status=failed&comparisonId=${receipt.comparisonId}`);
    const publicResponse = `${callback.headers.get("Location")} ${await callback.text()}`;
    const logged = JSON.stringify(log.mock.calls);
    expect(publicResponse).not.toContain("secret-code-123");
    expect(publicResponse).not.toContain("customer-token-456");
    expect(publicResponse).not.toContain(providerDescription);
    expect(logged).not.toContain("secret-code-123");
    expect(logged).not.toContain("customer-token-456");
    expect(logged).not.toContain(providerDescription);
    expect(log).toHaveBeenCalledWith("Kroger mobile OAuth callback failed", {
      name: "KrogerAuthError",
      code: "upstream",
      status: 502,
    });
  });
});
