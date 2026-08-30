import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secureStoreTestDouble as secureStore } from "@/tests/test-doubles/expo-secure-store";
import { clearMobileSession } from "@/mobile/src/services/mobile-session";
import {
  acknowledgeKrogerCartRecovery,
  decodeKrogerCartRecovery,
  getKrogerCartRecovery,
} from "@/mobile/src/services/kroger-cart-recovery-api";

const operationId = "R".repeat(43);
const sessionId = "s".repeat(43);
const accessToken = `v1.${sessionId}.mabcdef12.${"a".repeat(43)}`;
const recoveryToken = `r1.${sessionId}.${"r".repeat(43)}`;
const storedSession = JSON.stringify({
  version: 2,
  accessToken,
  recoveryToken,
});
const confirmed = {
  status: "CONFIRMED",
  operationId,
  comparisonId: "comparison_from_previous_launch_001",
  completedAt: "2026-08-24T12:00:00.000Z",
  message: "King Soopers confirmed the cart add.",
  addedCount: 5,
  itemCount: 4,
  handoff: {
    mode: "CART_TRANSFER_SUPPORTED",
    url: "https://www.kingsoopers.com/cart",
    retailerBanner: "King Soopers",
    locationId: "62000115",
    locationName: "Union Station",
    locationBoundByCartApi: false,
    storeSelectionMustBeConfirmed: true,
  },
} as const;

describe("mobile owner-level Kroger cart recovery", () => {
  beforeEach(async () => {
    vi.stubGlobal("__DEV__", true);
    secureStore.getItemAsync = vi.fn(async () => null);
    secureStore.setItemAsync = vi.fn(async () => undefined);
    secureStore.deleteItemAsync = vi.fn(async () => undefined);
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(async () => storedSession);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers a confirmed operation from an earlier launch and comparison", async () => {
    const requestFetch = vi.fn(async () => Response.json(confirmed));
    vi.stubGlobal("fetch", requestFetch);

    await expect(getKrogerCartRecovery()).resolves.toEqual(confirmed);
    expect(requestFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/mobile/v1/kroger/cart",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: `Bearer ${accessToken}` }),
      }),
    );
  });

  it("decodes outcome unknown without turning it into a retry-safe state", () => {
    const unknown = {
      status: "OUTCOME_UNKNOWN",
      operationId,
      comparisonId: "comparison_unknown_previous_001",
      completedAt: "2026-08-24T12:00:00.000Z",
      message: "Kroger's response was interrupted.",
      retrySafe: false,
      reviewHandoff: {
        url: "https://www.kroger.com/cart",
        retailerBanner: "Kroger",
        locationId: "62000115",
        locationName: "Central",
        locationBoundByCartApi: false,
        storeSelectionMustBeConfirmed: true,
      },
    };
    expect(decodeKrogerCartRecovery(unknown)).toEqual(unknown);
  });

  it("rejects a recovery CTA outside the exact Kroger-family cart allowlist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...confirmed,
      handoff: { ...confirmed.handoff, url: "https://phishing.example/cart" },
    })));

    await expect(getKrogerCartRecovery()).rejects.toThrow("invalid response");
  });

  it.each([
    "https://www.kroger.com/cart?source=cartiva",
    "https://www.kroger.com/cart#review",
  ])("rejects a recovery cart URL with query or hash: %s", (url) => {
    expect(decodeKrogerCartRecovery({
      ...confirmed,
      handoff: { ...confirmed.handoff, url },
    })).toBeNull();
  });

  it("rejects a confirmed count that reports fewer added units than basket lines", () => {
    expect(decodeKrogerCartRecovery({
      ...confirmed,
      addedCount: 3,
      itemCount: 4,
    })).toBeNull();
  });

  it("fails closed when the review acknowledgement is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "UNAVAILABLE",
      error: "Cartiva could not record the retailer-cart review.",
      retrySafe: false,
    }, { status: 503 })));

    await expect(acknowledgeKrogerCartRecovery(operationId))
      .rejects.toThrow("could not record");
  });

  it("rejects an expired recovery acknowledgement so Results can re-fetch owner state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "UNAVAILABLE",
      error: "That Kroger cart recovery has expired.",
      code: "not_found",
      retrySafe: false,
    }, { status: 404 })));

    await expect(acknowledgeKrogerCartRecovery(operationId))
      .rejects.toThrow("recovery has expired");
  });

  it("sends the explicit reviewed-cart acknowledgement and validates the receipt", async () => {
    const requestFetch = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      void _input;
      void _init;
      return Response.json({
        status: "ACKNOWLEDGED",
        operationId,
      });
    });
    vi.stubGlobal("fetch", requestFetch);

    await expect(acknowledgeKrogerCartRecovery(operationId)).resolves.toEqual({
      status: "ACKNOWLEDGED",
      operationId,
    });
    const request = requestFetch.mock.calls[0]?.[1];
    expect(request).toMatchObject({ method: "DELETE" });
    expect(JSON.parse(String(request?.body))).toEqual({
      operationId,
      acknowledgement: "REVIEWED_RETAILER_CART",
    });
  });

  it("bounds a stalled owner recovery check and leaves a useful retry message", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));

    const assertion = expect(getKrogerCartRecovery()).rejects.toThrow(
      "recovery timed out",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("bounds recovery when response headers arrive but JSON decoding stalls", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise<never>(() => undefined),
      } as unknown as Response);
    }));

    const assertion = expect(getKrogerCartRecovery()).rejects.toThrow(
      "recovery timed out",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });
});
