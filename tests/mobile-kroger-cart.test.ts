import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DELETE as cartDelete,
  GET as cartGet,
  POST as cartPost,
} from "@/app/api/mobile/v1/kroger/cart/route";
import { resetRateLimitsForTests } from "@/lib/api-security";
import {
  acknowledgeMobileKrogerCartOperation,
  clearKrogerCartOperations,
  clearKrogerCartOperationsForOwner,
  latestMobileKrogerCartOperation,
  mobileKrogerCartOperationIdentity,
  resetKrogerCartOperationsForTests,
  runKrogerCartOperation,
} from "@/lib/kroger-cart-operations";
import {
  resetComparisonReceiptsForTests,
  saveComparisonReceipt,
} from "@/lib/mobile-comparison-receipts";
import {
  resetMobileOwnerOperationLocksForTests,
  withMobileOwnerOperationLock,
} from "@/lib/mobile-owner-operation-lock";
import {
  createMobileSessionCredentials,
  issueMobileSession,
  MOBILE_SESSION_TTL_MS,
  renewMobileSession,
  resetMobileSessionRecoveryForTests,
} from "@/lib/mobile-session";
import {
  addToKrogerCart,
  KrogerProviderError,
} from "@/lib/kroger-provider";
import { getMobileKrogerAuthClient } from "@/lib/kroger-mobile-auth";
import {
  AvailabilityStatus,
  BasketCompleteness,
  type ComparisonSessionReceipt,
} from "@/packages/shared/src";

const mobileAuth = vi.hoisted(() => ({
  authorizationGeneration: "a".repeat(43),
}));

vi.mock("@/lib/kroger-provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kroger-provider")>("@/lib/kroger-provider");
  return { ...actual, addToKrogerCart: vi.fn() };
});

vi.mock("@/lib/kroger-mobile-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kroger-mobile-auth")>("@/lib/kroger-mobile-auth");
  return {
    ...actual,
    getMobileKrogerAuthClient: vi.fn(() => ({
      ownerScoped: true,
      getAuthorizationGeneration: vi.fn(async () => mobileAuth.authorizationGeneration),
    })),
  };
});

let receiptFile: string;
let comparisonFile: string;
const MAX_CART_RECEIPT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CART_RECEIPT_RECORDS = 4_096;

function receipt(
  comparisonId = "comparison_cart_route_001",
  lines: Array<{ id: string; upc: string; quantity: number }> = [
    { id: "milk", upc: "0001111012345", quantity: 2 },
  ],
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
    requestedItemIds: lines.map((line) => line.id),
    basketLines: lines.map((line) => ({
      lineId: `${comparisonId}:${line.id}`,
      requestedItemId: line.id,
      requestedItem: line.id,
      normalizedIntent: line.id,
      quantity: line.quantity,
      status: "ACCEPTED",
      retailerProductId: line.upc,
      upc: line.upc,
      matchedProduct: `Matched ${line.id}`,
      priceCents: 399,
      locationId: "62000115",
      availabilityStatus: AvailabilityStatus.VERIFIED_IN_STOCK,
      matchConfidence: "high",
      provenance: {
        dataSource: "kroger_public_api",
        priceSource: "kroger_location_product",
        priceScope: "exact_store",
        priceReliability: "verified",
        exactStoreVerified: true,
        sourceLocationId: "62000115",
        fulfillment: ["pickup"],
        checkedAt,
      },
    })),
    completeness: BasketCompleteness.COMPLETE,
    checkedAt,
    createdAt: checkedAt,
  };
}

function request(token: string, body: unknown) {
  return new Request("https://api.cartiva.test/api/mobile/v1/kroger/cart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": "203.0.113.55",
    },
    body: JSON.stringify(body),
  });
}

function recoveryRequest(token: string) {
  return new Request("https://api.cartiva.test/api/mobile/v1/kroger/cart", {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Forwarded-For": "203.0.113.55",
    },
  });
}

function acknowledgementRequest(token: string, operationId: string) {
  return new Request("https://api.cartiva.test/api/mobile/v1/kroger/cart", {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": "203.0.113.55",
    },
    body: JSON.stringify({
      operationId,
      acknowledgement: "REVIEWED_RETAILER_CART",
    }),
  });
}

function mobileOperationContext(ownerId: string, comparisonId: string) {
  const identity = mobileKrogerCartOperationIdentity(ownerId, comparisonId);
  return {
    identity,
    context: {
      ownerId,
      comparisonId,
      publicOperationId: identity.publicOperationId,
      cartUrl: "https://www.kingsoopers.com/cart",
      retailerBanner: "King Soopers",
      locationId: "62000115",
      locationName: "King Soopers — Union Station",
      locationBoundByCartApi: false as const,
      storeSelectionMustBeConfirmed: true as const,
    },
  };
}

function operationResult(label: string) {
  return {
    success: true as const,
    addedCount: 1,
    itemCount: 1,
    cartUrl: "https://www.kingsoopers.com/cart",
    chain: "King Soopers",
    selectedSearchLocation: { locationId: "62000115", name: label },
    locationBoundByCartApi: false as const,
    message: "confirmed",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitsForTests();
  mobileAuth.authorizationGeneration = "a".repeat(43);
  receiptFile = path.join(os.tmpdir(), `cartiva-mobile-cart-${Date.now()}-${Math.random()}.json`);
  comparisonFile = path.join(os.tmpdir(), `cartiva-mobile-comparison-${Date.now()}-${Math.random()}.json`);
  vi.stubEnv("CARTIVA_SESSION_SECRET", "cart-route-session-secret-that-is-at-least-thirty-two-characters");
  vi.stubEnv("CARTIVA_MOBILE_SESSION_FILE", `${receiptFile}.sessions`);
  vi.stubEnv("CARTIVA_ENABLE_KROGER_CART_WRITES", "true");
  vi.stubEnv("KROGER_CLIENT_ID", "mobile-cart-client-id");
  vi.stubEnv("KROGER_CLIENT_SECRET", "mobile-cart-client-secret");
  vi.stubEnv(
    "KROGER_MOBILE_REDIRECT_URI",
    "https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback",
  );
  vi.stubEnv("KROGER_CART_RECEIPT_FILE", receiptFile);
  vi.stubEnv("CARTIVA_COMPARISON_RECEIPT_FILE", comparisonFile);
  resetKrogerCartOperationsForTests();
  resetComparisonReceiptsForTests();
  resetMobileOwnerOperationLocksForTests();
  resetMobileSessionRecoveryForTests();
  vi.mocked(addToKrogerCart).mockResolvedValue(undefined);
});

afterEach(() => {
  resetKrogerCartOperationsForTests();
  resetComparisonReceiptsForTests();
  resetMobileOwnerOperationLocksForTests();
  resetMobileSessionRecoveryForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("owner-scoped mobile Kroger cart route", () => {
  it("renews an expired bearer into the same owner and still recovers unresolved cart history", async () => {
    const expired = await createMobileSessionCredentials(Date.now() - MOBILE_SESSION_TTL_MS - 1);
    const mobile = mobileOperationContext(expired.ownerId, "comparison_expired_owner_recovery_001");
    await runKrogerCartOperation(
      mobile.identity.internalOperationId,
      "r".repeat(43),
      async () => operationResult("expired owner recovery"),
      undefined,
      mobile.context,
    );

    const [, sessionId] = expired.recoveryToken.split(".");
    const nextRecoveryToken = `r1.${sessionId}.${"n".repeat(43)}`;
    const renewed = await renewMobileSession(new Request(
      "https://api.cartiva.test/api/mobile/v1/session/renew",
      { headers: { Authorization: `Bearer ${expired.recoveryToken}` } },
    ), nextRecoveryToken);
    expect(renewed.ownerId).toBe(expired.ownerId);
    const recovered = await cartGet(recoveryRequest(renewed.sessionToken));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      status: "CONFIRMED",
      comparisonId: "comparison_expired_owner_recovery_001",
    });
  });

  it("honors the server cart-write kill switch before any operation", async () => {
    const issued = issueMobileSession();
    const comparison = receipt("comparison_kill_switch_001");
    await saveComparisonReceipt(issued.ownerId, comparison);
    vi.stubEnv("CARTIVA_ENABLE_KROGER_CART_WRITES", "false");

    const response = await cartPost(request(issued.sessionToken, {
      comparisonId: comparison.comparisonId,
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "cart_transfer_unavailable",
    });
    expect(addToKrogerCart).not.toHaveBeenCalled();
  });

  it("derives exact UPC quantities from the immutable receipt and replays after repeated taps", async () => {
    const issued = issueMobileSession();
    const comparison = receipt("comparison_cart_replay_001", [
      { id: "beans-a", upc: "0001111012345", quantity: 2 },
      { id: "beans-b", upc: "0001111012345", quantity: 3 },
    ]);
    await saveComparisonReceipt(issued.ownerId, comparison);

    const first = await cartPost(request(issued.sessionToken, { comparisonId: comparison.comparisonId }));
    const replay = await cartPost(request(issued.sessionToken, { comparisonId: comparison.comparisonId }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: "CONFIRMED",
      success: true,
      comparisonId: comparison.comparisonId,
      replayed: false,
      addedCount: 5,
      itemCount: 1,
      handoff: {
        retailerBanner: "King Soopers",
        locationId: "62000115",
        locationBoundByCartApi: false,
        storeSelectionMustBeConfirmed: true,
      },
    });
    expect(await replay.json()).toMatchObject({ status: "CONFIRMED", replayed: true });
    expect(addToKrogerCart).toHaveBeenCalledTimes(1);
    expect(addToKrogerCart).toHaveBeenCalledWith([{
      upc: "0001111012345",
      quantity: 5,
      modality: "PICKUP",
    }], expect.objectContaining({ ownerScoped: true }));
  });

  it("recovers a submitted cart by owner before stale comparison checks and requires explicit review", async () => {
    const issued = issueMobileSession();
    const firstComparison = receipt("comparison_owner_recovery_001");
    await saveComparisonReceipt(issued.ownerId, firstComparison);

    const first = await cartPost(request(issued.sessionToken, {
      comparisonId: firstComparison.comparisonId,
    }));
    const confirmed = await first.json();
    expect(first.status).toBe(200);
    expect(confirmed).toMatchObject({
      status: "CONFIRMED",
      comparisonId: firstComparison.comparisonId,
    });

    resetKrogerCartOperationsForTests();
    const recovered = await cartGet(recoveryRequest(issued.sessionToken));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      status: "CONFIRMED",
      operationId: confirmed.operationId,
      comparisonId: firstComparison.comparisonId,
      handoff: {
        url: "https://www.kingsoopers.com/cart",
        locationId: "62000115",
        storeSelectionMustBeConfirmed: true,
      },
    });

    const laterComparison = receipt("comparison_owner_recovery_002");
    await saveComparisonReceipt(issued.ownerId, laterComparison);
    const blocked = await cartPost(request(issued.sessionToken, {
      comparisonId: laterComparison.comparisonId,
    }));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      status: "BLOCKED",
      code: "prior_cart_operation_requires_review",
      priorOperation: { operationId: confirmed.operationId },
    });
    expect(addToKrogerCart).toHaveBeenCalledTimes(1);

    const acknowledged = await cartDelete(acknowledgementRequest(
      issued.sessionToken,
      confirmed.operationId,
    ));
    expect(acknowledged.status).toBe(200);
    expect(await acknowledged.json()).toMatchObject({
      status: "ACKNOWLEDGED",
      operationId: confirmed.operationId,
    });

    const reviewedReplay = await cartPost(request(issued.sessionToken, {
      comparisonId: firstComparison.comparisonId,
    }));
    expect(reviewedReplay.status).toBe(409);
    expect(await reviewedReplay.json()).toMatchObject({
      status: "FAILED",
      code: "comparison_previously_added",
      retrySafe: true,
      error: expect.stringContaining("No new Kroger cart update was sent"),
    });
    expect(addToKrogerCart).toHaveBeenCalledTimes(1);

    const afterReview = await cartPost(request(issued.sessionToken, {
      comparisonId: laterComparison.comparisonId,
    }));
    expect(afterReview.status).toBe(200);
    expect(await afterReview.json()).toMatchObject({
      status: "CONFIRMED",
      comparisonId: laterComparison.comparisonId,
    });
    expect(addToKrogerCart).toHaveBeenCalledTimes(2);
  });

  it("never exposes or acknowledges another owner's cart operation", async () => {
    const ownerA = issueMobileSession();
    const ownerB = issueMobileSession();
    const comparison = receipt("comparison_private_recovery_1");
    await saveComparisonReceipt(ownerA.ownerId, comparison);
    const created = await cartPost(request(ownerA.sessionToken, {
      comparisonId: comparison.comparisonId,
    }));
    const confirmed = await created.json();

    expect(await (await cartGet(recoveryRequest(ownerB.sessionToken))).json()).toEqual({ status: "NONE" });
    const denied = await cartDelete(acknowledgementRequest(ownerB.sessionToken, confirmed.operationId));
    expect(denied.status).toBe(404);
    expect((await cartGet(recoveryRequest(ownerA.sessionToken))).status).toBe(200);
  });

  it("recovers a confirmation without issuing another write after authorization generation changes", async () => {
    const issued = issueMobileSession();
    const comparison = receipt("comparison_auth_generation_1");
    await saveComparisonReceipt(issued.ownerId, comparison);

    const first = await cartPost(request(issued.sessionToken, {
      comparisonId: comparison.comparisonId,
    }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "CONFIRMED", replayed: false });

    mobileAuth.authorizationGeneration = "b".repeat(43);
    const afterReconnect = await cartPost(request(issued.sessionToken, {
      comparisonId: comparison.comparisonId,
    }));
    expect(afterReconnect.status).toBe(200);
    expect(await afterReconnect.json()).toMatchObject({
      status: "CONFIRMED",
      success: true,
      replayed: true,
      recovered: true,
    });
    expect(addToKrogerCart).toHaveBeenCalledTimes(1);
  });

  it("does not let another owner replay or access the first owner's comparison", async () => {
    const ownerA = issueMobileSession();
    const ownerB = issueMobileSession();
    const comparison = receipt("comparison_owner_isolation_01");
    await saveComparisonReceipt(ownerA.ownerId, comparison);

    const denied = await cartPost(request(ownerB.sessionToken, {
      comparisonId: comparison.comparisonId,
    }));
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ success: false, code: "comparison_unavailable" });
    expect(addToKrogerCart).not.toHaveBeenCalled();

    await saveComparisonReceipt(ownerB.ownerId, comparison);
    expect((await cartPost(request(ownerA.sessionToken, {
      comparisonId: comparison.comparisonId,
    }))).status).toBe(200);
    expect((await cartPost(request(ownerB.sessionToken, {
      comparisonId: comparison.comparisonId,
    }))).status).toBe(200);
    expect(addToKrogerCart).toHaveBeenCalledTimes(2);
  });

  it("rejects client-supplied UPC/location fields instead of trusting them", async () => {
    const issued = issueMobileSession();
    const comparison = receipt();
    await saveComparisonReceipt(issued.ownerId, comparison);
    const response = await cartPost(request(issued.sessionToken, {
      comparisonId: comparison.comparisonId,
      locationId: "wrong-store",
      items: [{ upc: "9999999999999", quantity: 99 }],
    }));
    expect(response.status).toBe(400);
    expect(addToKrogerCart).not.toHaveBeenCalled();
  });

  it("fails closed with a controlled response when comparison storage cannot be verified", async () => {
    const issued = issueMobileSession();
    const unavailablePath = await mkdtemp(path.join(os.tmpdir(), "cartiva-comparison-unavailable-"));
    vi.stubEnv("CARTIVA_COMPARISON_RECEIPT_FILE", unavailablePath);
    resetComparisonReceiptsForTests();

    const response = await cartPost(request(issued.sessionToken, {
      comparisonId: "comparison_storage_unavailable_1",
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "FAILED",
      code: "comparison_state_unavailable",
      retrySafe: true,
    });
    expect(addToKrogerCart).not.toHaveBeenCalled();
  });

  it("never mutates a retained match whose inventory was not confirmed", async () => {
    const issued = issueMobileSession();
    const comparison = receipt("comparison_unverified_inventory_1");
    comparison.basketLines[0] = {
      ...comparison.basketLines[0],
      status: "REJECTED",
      retailerProductId: undefined,
      upc: undefined,
      matchedProduct: undefined,
      priceCents: undefined,
      provenance: undefined,
      availabilityStatus: AvailabilityStatus.LIKELY_AVAILABLE,
    };
    comparison.completeness = BasketCompleteness.INCOMPLETE;
    await saveComparisonReceipt(issued.ownerId, comparison);

    const response = await cartPost(request(issued.sessionToken, {
      comparisonId: comparison.comparisonId,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "FAILED",
      success: false,
      code: "basket_incomplete",
      retrySafe: true,
    });
    expect(addToKrogerCart).not.toHaveBeenCalled();
  });

  it("requires a fresh exact-store receipt immediately before cart mutation", async () => {
    const issued = issueMobileSession();
    const comparison = receipt("comparison_stale_cart_evidence_1");
    comparison.checkedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    await saveComparisonReceipt(issued.ownerId, comparison);

    const response = await cartPost(request(issued.sessionToken, {
      comparisonId: comparison.comparisonId,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "FAILED",
      success: false,
      code: "comparison_stale",
      retrySafe: true,
    });
    expect(addToKrogerCart).not.toHaveBeenCalled();
  });

  it("rechecks receipt freshness after waiting for an owner operation lock", async () => {
    const initialNow = Date.now();
    let currentNow = initialNow;
    vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    const issued = issueMobileSession();
    const comparison = receipt("comparison_ages_while_queued_1");
    const almostStale = new Date(initialNow - 14 * 60_000 - 59_000).toISOString();
    comparison.checkedAt = almostStale;
    comparison.basketLines[0].provenance!.checkedAt = almostStale;
    await saveComparisonReceipt(issued.ownerId, comparison);

    let releaseBlocker!: () => void;
    let markBlockerStarted!: () => void;
    const blockerCanFinish = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve;
    });
    const blocker = withMobileOwnerOperationLock(issued.ownerId, async () => {
      markBlockerStarted();
      await blockerCanFinish;
    });
    await blockerStarted;

    const lockState = globalThis as typeof globalThis & {
      __cartivaMobileOwnerOperationLocks?: Map<string, Promise<void>>;
    };
    const blockerEntry = lockState.__cartivaMobileOwnerOperationLocks?.get(issued.ownerId);
    const pendingResponse = cartPost(request(issued.sessionToken, {
      comparisonId: comparison.comparisonId,
    }));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (lockState.__cartivaMobileOwnerOperationLocks?.get(issued.ownerId) !== blockerEntry) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(lockState.__cartivaMobileOwnerOperationLocks?.get(issued.ownerId)).not.toBe(blockerEntry);

    currentNow += 2 * 60_000;
    releaseBlocker();
    await blocker;
    const response = await pendingResponse;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "FAILED",
      success: false,
      code: "comparison_stale",
      retrySafe: true,
    });
    expect(addToKrogerCart).not.toHaveBeenCalled();
  });

  it("never reports confirmation when Kroger rejects or cannot confirm the mutation", async () => {
    const issued = issueMobileSession();
    const safeFailure = receipt("comparison_safe_failure_01");
    await saveComparisonReceipt(issued.ownerId, safeFailure);
    vi.mocked(addToKrogerCart).mockRejectedValueOnce(new KrogerProviderError(
      "Kroger could not add these items to the cart.",
      "upstream",
      400,
    ));
    const failed = await cartPost(request(issued.sessionToken, {
      comparisonId: safeFailure.comparisonId,
    }));
    expect(await failed.json()).toMatchObject({
      status: "FAILED",
      success: false,
      retrySafe: true,
    });

    const ambiguousReceipt = receipt("comparison_unknown_outcome_1");
    await saveComparisonReceipt(issued.ownerId, ambiguousReceipt);
    vi.mocked(addToKrogerCart).mockRejectedValueOnce(new Error("socket closed after PUT"));
    const ambiguous = await cartPost(request(issued.sessionToken, {
      comparisonId: ambiguousReceipt.comparisonId,
    }));
    expect(await ambiguous.json()).toMatchObject({
      status: "OUTCOME_UNKNOWN",
      success: false,
      code: "outcome_unknown",
      retrySafe: false,
    });
    resetKrogerCartOperationsForTests();
    const recovered = await cartGet(recoveryRequest(issued.sessionToken));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      status: "OUTCOME_UNKNOWN",
      comparisonId: ambiguousReceipt.comparisonId,
      retrySafe: false,
      reviewHandoff: { locationId: "62000115" },
    });
  });

  it("treats a receipt-store failure after Kroger returns success as outcome unknown", async () => {
    const issued = issueMobileSession();
    const comparison = receipt("comparison_post_add_persist_1");
    await saveComparisonReceipt(issued.ownerId, comparison);
    const invalidReceiptTarget = await mkdtemp(path.join(os.tmpdir(), "cartiva-cart-directory-"));
    vi.mocked(addToKrogerCart).mockImplementationOnce(async () => {
      // The intent record has already been written. Point the confirmation
      // write at an existing directory to simulate durable-store failure after
      // Kroger's PUT was accepted.
      vi.stubEnv("KROGER_CART_RECEIPT_FILE", invalidReceiptTarget);
    });

    const response = await cartPost(request(issued.sessionToken, {
      comparisonId: comparison.comparisonId,
    }));
    expect(await response.json()).toMatchObject({
      status: "OUTCOME_UNKNOWN",
      success: false,
      code: "outcome_unknown",
      retrySafe: false,
    });
    expect(addToKrogerCart).toHaveBeenCalledTimes(1);
  });
});

describe("Kroger cart operation owner isolation", () => {
  it("keeps concurrent operation receipts durable across a process-state reload", async () => {
    const firstOperation = vi.fn(async () => operationResult("Concurrent A"));
    const secondOperation = vi.fn(async () => operationResult("Concurrent B"));

    await Promise.all([
      runKrogerCartOperation(
        "legacy-concurrent-a",
        "fingerprint-concurrent-a",
        firstOperation,
      ),
      runKrogerCartOperation(
        "legacy-concurrent-b",
        "fingerprint-concurrent-b",
        secondOperation,
      ),
    ]);

    resetKrogerCartOperationsForTests();
    expect((await runKrogerCartOperation(
      "legacy-concurrent-a",
      "fingerprint-concurrent-a",
      firstOperation,
    )).replayed).toBe(true);
    expect((await runKrogerCartOperation(
      "legacy-concurrent-b",
      "fingerprint-concurrent-b",
      secondOperation,
    )).replayed).toBe(true);
    expect(firstOperation).toHaveBeenCalledTimes(1);
    expect(secondOperation).toHaveBeenCalledTimes(1);
  });

  it("legacy account cleanup preserves mobile receipts and owner cleanup is scoped", async () => {
    const ownerA = "a".repeat(64);
    const ownerB = "b".repeat(64);
    const mobileA = mobileOperationContext(ownerA, "comparison_owner_cleanup_a");
    const mobileB = mobileOperationContext(ownerB, "comparison_owner_cleanup_b");
    const operationA = vi.fn(async () => operationResult("A"));
    const operationB = vi.fn(async () => operationResult("B"));
    mobileA.context.locationName = "A";
    mobileB.context.locationName = "B";
    await runKrogerCartOperation(
      mobileA.identity.internalOperationId,
      "a".repeat(43),
      operationA,
      undefined,
      mobileA.context,
    );
    await runKrogerCartOperation(
      mobileB.identity.internalOperationId,
      "b".repeat(43),
      operationB,
      undefined,
      mobileB.context,
    );

    await clearKrogerCartOperations();
    resetKrogerCartOperationsForTests();
    expect((await runKrogerCartOperation(
      mobileA.identity.internalOperationId,
      "a".repeat(43),
      operationA,
      undefined,
      mobileA.context,
    )).replayed).toBe(true);
    expect(operationA).toHaveBeenCalledTimes(1);

    // Unacknowledged confirmations remain durable through customer disconnect.
    await clearKrogerCartOperationsForOwner(ownerA);
    expect((await runKrogerCartOperation(
      mobileB.identity.internalOperationId,
      "b".repeat(43),
      operationB,
      undefined,
      mobileB.context,
    )).replayed).toBe(true);
    expect(operationB).toHaveBeenCalledTimes(1);
    expect((await latestMobileKrogerCartOperation(ownerA))?.status).toBe("CONFIRMED");
    expect(getMobileKrogerAuthClient).not.toHaveBeenCalled();
  });

  it("fails closed when durable mobile records are duplicated or context binding is corrupted", async () => {
    const owner = "d".repeat(64);
    const first = mobileOperationContext(owner, "comparison_corrupt_guard_1");
    const second = mobileOperationContext(owner, "comparison_corrupt_guard_2");
    await runKrogerCartOperation(
      first.identity.internalOperationId,
      "c".repeat(43),
      async () => operationResult(first.context.locationName),
      undefined,
      first.context,
    );
    const stored = JSON.parse(await readFile(receiptFile, "utf8"));
    stored.push({
      ...stored[0],
      operationId: second.identity.internalOperationId,
      requestFingerprint: "d".repeat(43),
      mobileContext: second.context,
      selectedSearchLocation: {
        locationId: second.context.locationId,
        name: second.context.locationName,
      },
    });
    await writeFile(receiptFile, JSON.stringify(stored), "utf8");
    resetKrogerCartOperationsForTests();
    await expect(latestMobileKrogerCartOperation(owner)).rejects.toMatchObject({
      name: "KrogerCartOperationStateUnavailableError",
    });

    stored[1].operationId = stored[0].operationId;
    await writeFile(receiptFile, JSON.stringify(stored), "utf8");
    resetKrogerCartOperationsForTests();
    await expect(latestMobileKrogerCartOperation(owner)).rejects.toMatchObject({
      name: "KrogerCartOperationStateUnavailableError",
    });
  });

  it("rejects a tampered comparison binding and impossible confirmed counts", async () => {
    const owner = "e".repeat(64);
    const mobile = mobileOperationContext(owner, "comparison_tamper_binding_1");
    await runKrogerCartOperation(
      mobile.identity.internalOperationId,
      "e".repeat(43),
      async () => operationResult(mobile.context.locationName),
      undefined,
      mobile.context,
    );
    const original = JSON.parse(await readFile(receiptFile, "utf8"));

    const wrongComparison = structuredClone(original);
    wrongComparison[0].mobileContext.comparisonId = "comparison_tamper_binding_2";
    await writeFile(receiptFile, JSON.stringify(wrongComparison), "utf8");
    resetKrogerCartOperationsForTests();
    await expect(latestMobileKrogerCartOperation(owner)).rejects.toMatchObject({
      name: "KrogerCartOperationStateUnavailableError",
    });

    const impossibleCounts = structuredClone(original);
    impossibleCounts[0].addedCount = 0;
    impossibleCounts[0].itemCount = 0;
    await writeFile(receiptFile, JSON.stringify(impossibleCounts), "utf8");
    resetKrogerCartOperationsForTests();
    await expect(latestMobileKrogerCartOperation(owner)).rejects.toMatchObject({
      name: "KrogerCartOperationStateUnavailableError",
    });
  });

  it("keeps an unresolved mobile cart guard beyond 24 hours until explicit review", async () => {
    const owner = "f".repeat(64);
    const mobile = mobileOperationContext(owner, "comparison_long_lived_guard_1");
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await runKrogerCartOperation(
      mobile.identity.internalOperationId,
      "f".repeat(43),
      async () => operationResult(mobile.context.locationName),
      undefined,
      mobile.context,
    );

    now += 30 * 24 * 60 * 60_000;
    resetKrogerCartOperationsForTests();
    await expect(latestMobileKrogerCartOperation(owner)).resolves.toMatchObject({
      status: "CONFIRMED",
      comparisonId: mobile.context.comparisonId,
    });

    expect(await acknowledgeMobileKrogerCartOperation(
      owner,
      mobile.identity.publicOperationId,
    )).toBe(true);
    now += 24 * 60 * 60_000 + 1;
    resetKrogerCartOperationsForTests();
    await expect(latestMobileKrogerCartOperation(owner)).resolves.toBeNull();
  });

  it("prunes expired acknowledged receipts from memory and disk during the next serialized commit", async () => {
    const owner = "1".repeat(64);
    const mobile = mobileOperationContext(owner, "comparison_pruned_after_review_1");
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await runKrogerCartOperation(
      mobile.identity.internalOperationId,
      "p".repeat(43),
      async () => operationResult(mobile.context.locationName),
      undefined,
      mobile.context,
    );
    expect(await acknowledgeMobileKrogerCartOperation(
      owner,
      mobile.identity.publicOperationId,
    )).toBe(true);

    now += 24 * 60 * 60_000 + 60_000;
    await runKrogerCartOperation(
      "legacy-prune-trigger",
      "legacy-prune-trigger-fingerprint",
      async () => operationResult("Prune trigger"),
    );

    const stored = JSON.parse(await readFile(receiptFile, "utf8"));
    expect(stored).toHaveLength(1);
    expect(stored[0].operationId).toBe("legacy-prune-trigger");
    expect(await latestMobileKrogerCartOperation(owner)).toBeNull();
  });

  it("fails closed before a cart call when the durable record-count capacity is exhausted", async () => {
    await runKrogerCartOperation(
      "legacy-capacity-seed",
      "legacy-capacity-seed-fingerprint",
      async () => operationResult("Capacity seed"),
    );
    const [seed] = JSON.parse(await readFile(receiptFile, "utf8"));
    const atCapacity = Array.from({ length: MAX_CART_RECEIPT_RECORDS }, (_, index) => ({
      ...seed,
      operationId: `legacy-capacity-${index}`,
      requestFingerprint: `legacy-capacity-fingerprint-${index}`,
    }));
    await writeFile(receiptFile, JSON.stringify(atCapacity), "utf8");
    resetKrogerCartOperationsForTests();
    const operation = vi.fn(async () => operationResult("Must not run"));

    await expect(runKrogerCartOperation(
      "legacy-capacity-overflow",
      "legacy-capacity-overflow-fingerprint",
      operation,
    )).rejects.toMatchObject({
      name: "KrogerCartOperationStateUnavailableError",
    });
    expect(operation).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(receiptFile, "utf8"))).toHaveLength(MAX_CART_RECEIPT_RECORDS);
  });

  it("rejects oversized or over-count durable receipt files with bounded loading", async () => {
    await writeFile(receiptFile, Buffer.alloc(MAX_CART_RECEIPT_FILE_BYTES + 1, 0x20));
    resetKrogerCartOperationsForTests();
    await expect(latestMobileKrogerCartOperation("2".repeat(64))).rejects.toMatchObject({
      name: "KrogerCartOperationStateUnavailableError",
    });

    const now = Date.now();
    const overCount = Array.from({ length: MAX_CART_RECEIPT_RECORDS + 1 }, (_, index) => ({
      operationId: `legacy-over-count-${index}`,
      requestFingerprint: `legacy-over-count-fingerprint-${index}`,
      outcomeUnknown: true,
      completedAt: new Date(now).toISOString(),
      expiresAt: now + 24 * 60 * 60_000,
    }));
    await writeFile(receiptFile, JSON.stringify(overCount), "utf8");
    resetKrogerCartOperationsForTests();
    await expect(latestMobileKrogerCartOperation("3".repeat(64))).rejects.toMatchObject({
      name: "KrogerCartOperationStateUnavailableError",
    });
  });
});
