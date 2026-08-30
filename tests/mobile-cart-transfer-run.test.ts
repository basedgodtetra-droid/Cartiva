import { describe, expect, it, vi } from "vitest";
import {
  cartHandoffBelongsToComparison,
  cartTransferBlocksNavigation,
  runGuardedKrogerCartTransfer,
  type CartTransferRunPhase,
} from "../mobile/src/services/cart-transfer-run";
import type {
  ConfirmedKrogerCartAdd,
  KrogerAuthorizationOutcome,
  KrogerAuthorizationStatus,
} from "../mobile/src/services/kroger-handoff-api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const identity = {
  comparisonId: "comparison_current_001",
  locationId: "62000001",
  retailerBanner: "King Soopers",
};

const capability = {
  mode: "CART_TRANSFER_SUPPORTED" as const,
  cartTransferSupported: true,
  requiresRetailerCheckout: true as const,
  requiresCustomerAuthorization: true,
  cartApiLocationBound: false as const,
  requiresStoreConfirmation: true as const,
  configured: true,
};

const connected: KrogerAuthorizationStatus = {
  retailer: "kroger",
  authorization: "CONNECTED",
  capability,
};

const notConnected: KrogerAuthorizationStatus = {
  ...connected,
  authorization: "NOT_CONNECTED",
};

describe("guarded mobile Kroger cart transfer", () => {
  it("does not cross the cart-write boundary when the comparison changes during status", async () => {
    const status = deferred<KrogerAuthorizationStatus>();
    let currentComparisonId: string | null = identity.comparisonId;
    const addToCart = vi.fn();
    const prepareCartWrite = vi.fn();
    const request = runGuardedKrogerCartTransfer({
      identity,
      isCurrent: (comparisonId) => currentComparisonId === comparisonId,
      getAuthorizationStatus: vi.fn(() => status.promise),
      authorize: vi.fn(),
      prepareCartWrite,
      cancelPreparedCartWrite: vi.fn(),
      addToCart,
      recordCartOutcome: vi.fn(),
    });

    currentComparisonId = "comparison_replaced_002";
    status.resolve(connected);

    await expect(request).resolves.toEqual({ kind: "STALE_BEFORE_WRITE" });
    expect(prepareCartWrite).not.toHaveBeenCalled();
    expect(addToCart).not.toHaveBeenCalled();
  });

  it("does not add to the cart when Results unmounts during OAuth", async () => {
    const authorization = deferred<KrogerAuthorizationOutcome>();
    const authorizationStarted = deferred<void>();
    let mounted = true;
    const addToCart = vi.fn();
    const request = runGuardedKrogerCartTransfer({
      identity,
      isCurrent: (comparisonId) => mounted && comparisonId === identity.comparisonId,
      getAuthorizationStatus: vi.fn(async () => notConnected),
      authorize: vi.fn(() => {
        authorizationStarted.resolve();
        return authorization.promise;
      }),
      prepareCartWrite: vi.fn(),
      cancelPreparedCartWrite: vi.fn(),
      addToCart,
      recordCartOutcome: vi.fn(),
    });

    await authorizationStarted.promise;
    mounted = false;
    authorization.resolve({ status: "CONNECTED", authorization: connected });

    await expect(request).resolves.toEqual({ kind: "STALE_BEFORE_WRITE" });
    expect(addToCart).not.toHaveBeenCalled();
  });

  it("reports an inline OAuth success before crossing the cart-write boundary", async () => {
    const phases: CartTransferRunPhase[] = [];
    const failedOutcome = {
      status: "FAILED" as const,
      success: false as const,
      error: "Kroger did not accept the cart.",
      code: "upstream",
      retrySafe: true,
    };
    const result = await runGuardedKrogerCartTransfer({
      identity,
      isCurrent: (comparisonId) => comparisonId === identity.comparisonId,
      getAuthorizationStatus: vi.fn(async () => notConnected),
      authorize: vi.fn(async () => ({ status: "CONNECTED" as const, authorization: connected })),
      prepareCartWrite: vi.fn(async () => undefined),
      cancelPreparedCartWrite: vi.fn(),
      addToCart: vi.fn(async () => failedOutcome),
      recordCartOutcome: vi.fn(async () => true),
      onPhase: (phase) => phases.push(phase),
    });

    expect(result).toEqual({ kind: "CART_OUTCOME", outcome: failedOutcome });
    expect(phases).toEqual([
      "CHECKING_AUTHORIZATION",
      "AUTHORIZING",
      "AUTHORIZATION_CONNECTED",
      "CART_WRITE_STARTED",
      "CART_OUTCOME_RECORDED",
    ]);
  });

  it("records a confirmed outcome even if the screen becomes stale after the POST starts", async () => {
    const cartResponse = deferred<ConfirmedKrogerCartAdd>();
    const cartWriteStarted = deferred<void>();
    const controller = new AbortController();
    const phases: CartTransferRunPhase[] = [];
    let mounted = true;
    let currentComparisonId: string | null = identity.comparisonId;
    const addToCart = vi.fn(() => {
      cartWriteStarted.resolve();
      return cartResponse.promise;
    });
    const prepareCartWrite = vi.fn(async () => undefined);
    const recordCartOutcome = vi.fn(async () => true);
    const request = runGuardedKrogerCartTransfer({
      identity,
      signal: controller.signal,
      isCurrent: (comparisonId) => mounted && currentComparisonId === comparisonId,
      getAuthorizationStatus: vi.fn(async () => connected),
      authorize: vi.fn(),
      prepareCartWrite,
      cancelPreparedCartWrite: vi.fn(),
      addToCart,
      recordCartOutcome,
      onPhase: (phase) => phases.push(phase),
    });

    await cartWriteStarted.promise;
    mounted = false;
    currentComparisonId = "comparison_after_navigation_003";
    controller.abort();
    const confirmed: ConfirmedKrogerCartAdd = {
      status: "CONFIRMED",
      success: true,
      operationId: "A".repeat(43),
      comparisonId: identity.comparisonId,
      replayed: false,
      addedCount: 3,
      itemCount: 2,
      message: "Kroger accepted the selected product identifiers.",
      handoff: {
        mode: "CART_TRANSFER_SUPPORTED",
        url: "https://www.kingsoopers.com/cart",
        retailerBanner: identity.retailerBanner,
        locationId: identity.locationId,
        locationName: "Union Station",
        locationBoundByCartApi: false,
        storeSelectionMustBeConfirmed: true,
      },
    };
    cartResponse.resolve(confirmed);

    await expect(request).resolves.toEqual({ kind: "CART_OUTCOME", outcome: confirmed });
    expect(prepareCartWrite).toHaveBeenCalledWith(identity);
    expect(addToCart).toHaveBeenCalledOnce();
    expect(recordCartOutcome).toHaveBeenCalledWith(identity, confirmed);
    expect(phases).toContain("CART_WRITE_STARTED");
    expect(phases).toContain("AUTHORIZATION_CONNECTED");
    expect(phases.at(-1)).toBe("CART_OUTCOME_RECORDED");
  });

  it("blocks navigation only between POST start and terminal outcome recording", () => {
    expect(cartTransferBlocksNavigation("IDLE")).toBe(false);
    expect(cartTransferBlocksNavigation("PREPARING")).toBe(false);
    expect(cartTransferBlocksNavigation("CART_WRITE_STARTED")).toBe(true);
    expect(cartTransferBlocksNavigation("OUTCOME_RECORDED")).toBe(false);
  });

  it("does not POST when the durable submission marker cannot be written", async () => {
    const addToCart = vi.fn();
    const request = runGuardedKrogerCartTransfer({
      identity,
      isCurrent: (comparisonId) => comparisonId === identity.comparisonId,
      getAuthorizationStatus: vi.fn(async () => connected),
      authorize: vi.fn(),
      prepareCartWrite: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
      cancelPreparedCartWrite: vi.fn(),
      addToCart,
      recordCartOutcome: vi.fn(),
    });

    await expect(request).rejects.toThrow("storage unavailable");
    expect(addToCart).not.toHaveBeenCalled();
  });

  it("binds restored handoff outcomes to their exact comparison", () => {
    expect(cartHandoffBelongsToComparison(
      "comparison_current_001",
      "comparison_current_001",
    )).toBe(true);
    expect(cartHandoffBelongsToComparison(
      "comparison_current_001",
      "comparison_replaced_002",
    )).toBe(false);
    expect(cartHandoffBelongsToComparison(undefined, "comparison_current_001")).toBe(false);
  });
});
