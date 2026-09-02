import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { POST as cartPost } from "@/app/api/kroger/cart/route";
import { POST as searchPost } from "@/app/api/kroger/search/route";
import { POST as extensionStart } from "@/app/api/extension/kroger/auth/start/route";
import {
  addToKrogerCart,
  getKrogerLocation,
  searchKrogerProducts,
  krogerCartItemsWereVerified,
} from "@/lib/kroger-provider";
import { KrogerProviderError } from "@/lib/kroger-provider";
import { getKrogerAuthClient, KrogerAuthError } from "@/lib/kroger-auth";
import {
  clearKrogerCartOperations,
  resetKrogerCartOperationsForTests,
  runKrogerCartOperation,
} from "@/lib/kroger-cart-operations";
import type { KrogerProduct } from "@/lib/types";

vi.mock("@/lib/kroger-provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kroger-provider")>("@/lib/kroger-provider");
  return {
    ...actual,
    addToKrogerCart: vi.fn(),
    getKrogerLocation: vi.fn(),
    searchKrogerProducts: vi.fn(),
    krogerCartItemsWereVerified: vi.fn(() => true),
  };
});

vi.mock("@/lib/kroger-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kroger-auth")>("@/lib/kroger-auth");
  return {
    ...actual,
    getKrogerAuthClient: vi.fn(),
  };
});

const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

function krogerProduct(overrides: Partial<KrogerProduct> = {}): KrogerProduct {
  const productId = overrides.productId ?? overrides.id ?? "0001111012345";
  return {
    retailer: "kroger",
    id: productId,
    productId,
    upc: overrides.upc ?? productId,
    title: "Kroger Grade A Large Eggs 12 Count",
    price: 2.99,
    link: `https://www.kroger.com/p/item/${productId}`,
    inStock: true,
    availabilityStatus: "in_stock",
    sponsored: false,
    size: {
      amount: 12,
      unit: "count",
      kind: "count",
      baseAmount: 12,
      baseUnit: "each",
      label: "12 count",
    },
    cartEligible: true,
    dataSource: "kroger_public_api",
    identityVerified: true,
    verification: "verified",
    priceProvenance: {
      retailer: "kroger",
      priceSource: "kroger_location_product",
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified: true,
      locationId: "AB12CD34",
      location: {
        requestedStoreId: "AB12CD34",
        observedStoreId: "AB12CD34",
        responseProvesLocation: true,
        storeMatched: true,
      },
      fulfillment: ["pickup"],
    },
    ...overrides,
  };
}

function searchResponse(products: KrogerProduct[]) {
  return {
    products,
    diagnostics: { apiCall: true, cacheHit: false, deduplicated: false, durationMs: 4 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetKrogerCartOperationsForTests();
  vi.stubEnv("KROGER_CART_RECEIPT_FILE", path.join(os.tmpdir(), `cartiva-kroger-receipts-${Date.now()}-${Math.random()}.json`));
  vi.mocked(krogerCartItemsWereVerified).mockReturnValue(true);
  vi.mocked(getKrogerLocation).mockResolvedValue({
    locationId: "AB12CD34",
    name: "King Soopers Test",
    chain: "King Soopers",
    address: { addressLine1: "1 Main", city: "Denver", state: "CO", zipCode: "80202" },
    departments: [],
  });
});

describe("Kroger extension routes", () => {
  it("returns an authorization URL as JSON instead of following the redirect", async () => {
    vi.mocked(getKrogerAuthClient).mockReturnValue({
      createAuthorizationUrl: () => "https://api.kroger.com/v1/connect/oauth2/authorize?state=safe",
    } as never);
    const response = await extensionStart(new Request(
      "http://localhost:3000/api/extension/kroger/auth/start",
      { method: "POST", headers: { Origin: extensionOrigin } },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://api.kroger.com/v1/connect/oauth2/authorize?state=safe",
      authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/authorize?state=safe",
    });
  });

  it("accepts official alphanumeric location IDs but never forwards them to cart/add", async () => {
    const cartRequest = () => new Request("http://localhost:3000/api/kroger/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
        operationId: "build_AB12CD34_0001",
        locationId: "AB12CD34",
        fulfillmentMode: "pickup",
        items: [{ upc: "0001111012345", quantity: 2 }],
      }),
      });
    const response = await cartPost(cartRequest());
    expect(response.status).toBe(200);
    vi.mocked(krogerCartItemsWereVerified).mockReturnValue(false);
    const replay = await cartPost(cartRequest());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ success: true, replayed: true });
    expect(addToKrogerCart).toHaveBeenCalledWith([{
      upc: "0001111012345",
      quantity: 2,
      modality: "PICKUP",
    }]);
    expect(await response.json()).toMatchObject({
      success: true,
      addedCount: 2,
      cartUrl: "https://www.kingsoopers.com/cart",
      locationBoundByCartApi: false,
    });
  });

  it("persists an ambiguous cart outcome across restart and never retries it", async () => {
    vi.mocked(addToKrogerCart).mockRejectedValueOnce(new KrogerProviderError(
      "Kroger's cart response did not confirm whether items were added.",
      "outcome_unknown",
      502,
    ));
    const cartRequest = () => new Request("http://localhost:3000/api/kroger/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "ambiguous_AB12CD34_01",
        locationId: "AB12CD34",
        fulfillmentMode: "pickup",
        items: [{ upc: "0001111012345", quantity: 1 }],
      }),
    });
    const first = await cartPost(cartRequest());
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ code: "outcome_unknown", retrySafe: false });
    expect(addToKrogerCart).toHaveBeenCalledTimes(1);

    // Simulate a server restart: only the ignored local receipt survives.
    resetKrogerCartOperationsForTests();
    vi.mocked(krogerCartItemsWereVerified).mockReturnValue(false);
    const retry = await cartPost(cartRequest());
    expect(retry.status).toBe(502);
    expect(await retry.json()).toMatchObject({ code: "outcome_unknown", retrySafe: false });
    expect(addToKrogerCart).toHaveBeenCalledTimes(1);
  });

  it("returns a retryable reconnect state when authorization expires during the cart write", async () => {
    vi.mocked(addToKrogerCart).mockRejectedValueOnce(new KrogerAuthError(
      "Your Kroger connection expired or was revoked. Reconnect Kroger.",
      "not_connected",
      401,
    ));
    const response = await cartPost(new Request("http://localhost:3000/api/kroger/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "expired_AB12CD34_01",
        locationId: "AB12CD34",
        fulfillmentMode: "pickup",
        items: [{ upc: "0001111012345", quantity: 1 }],
      }),
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "auth_expired",
      retrySafe: true,
    });
  });

  it("persists cart intent before calling Kroger so a mid-request restart cannot duplicate it", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const operation = vi.fn(async () => {
      await gate;
      return {
        success: true as const,
        addedCount: 1,
        itemCount: 1,
        cartUrl: "https://www.kroger.com/cart",
        chain: "Kroger",
        selectedSearchLocation: { locationId: "AB12CD34", name: "Kroger Test" },
        locationBoundByCartApi: false as const,
        message: "accepted",
      };
    });
    const first = runKrogerCartOperation(
      "crash_safe_operation_001",
      "fingerprint",
      operation,
    );
    while (operation.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    resetKrogerCartOperationsForTests();
    await expect(runKrogerCartOperation(
      "crash_safe_operation_001",
      "fingerprint",
      operation,
    )).rejects.toMatchObject({ name: "KrogerCartOutcomeUnknownError" });
    expect(operation).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it("retains uncertain cart outcomes when the Kroger account changes", async () => {
    const operation = vi.fn(async () => {
      throw new Error("the upstream outcome was interrupted");
    });
    await expect(runKrogerCartOperation(
      "uncertain_account_switch_001",
      "same-cart-fingerprint",
      operation,
    )).rejects.toThrow("the upstream outcome was interrupted");

    await clearKrogerCartOperations();
    await expect(runKrogerCartOperation(
      "uncertain_account_switch_001",
      "same-cart-fingerprint",
      operation,
    )).rejects.toMatchObject({ name: "KrogerCartOutcomeUnknownError" });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("streams search then exact-location verification then performance", async () => {
    vi.mocked(searchKrogerProducts).mockResolvedValue({
      products: [{
        retailer: "kroger",
        id: "0001111012345",
        productId: "0001111012345",
        upc: "0001111012345",
        title: "Kroger Grade A Large Eggs 12 Count",
        price: 2.99,
        link: "https://www.kroger.com/p/eggs/0001111012345",
        inStock: true,
        availabilityStatus: "in_stock",
        sponsored: false,
        size: { amount: 12, unit: "count", kind: "count", baseAmount: 12, baseUnit: "each", label: "12 count" },
        cartEligible: true,
        dataSource: "kroger_public_api",
        identityVerified: true,
        verification: "verified",
        priceProvenance: {
          retailer: "kroger",
          priceSource: "kroger_location_product",
          priceScope: "exact_store",
          priceReliability: "verified",
          exactStoreVerified: true,
          locationId: "AB12CD34",
          location: {
            requestedStoreId: "AB12CD34",
            observedStoreId: "AB12CD34",
            responseProvesLocation: true,
            storeMatched: true,
          },
          fulfillment: ["pickup"],
        },
      }],
      diagnostics: { apiCall: true, cacheHit: false, deduplicated: false, durationMs: 4 },
    });
    const response = await searchPost(new Request("http://localhost:3000/api/kroger/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        retailer: "kroger",
        items: [{ text: "eggs 12 count", preferredProductId: "0001111012345" }],
        locationId: "AB12CD34",
        fulfillmentMode: "pickup",
      }),
    }));
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type === "item" ? event.phase : event.type))
      .toEqual(["search", "verification", "performance"]);
    expect(events[1]).toMatchObject({
      retailer: "kroger",
      result: { status: "matched", recommended: { cartEligible: true } },
      diagnostics: { locationId: "AB12CD34", verificationStatus: "verified" },
    });
  });

  it("discovers a gallon of milk with a retailer-friendly query while verifying the full package", async () => {
    const milk = krogerProduct({
      id: "0001111099991",
      productId: "0001111099991",
      upc: "0001111099991",
      title: "Kroger Vitamin D Whole Milk Gallon",
      brand: "Kroger",
      productType: "Milk",
      price: 3.19,
      size: {
        amount: 128,
        unit: "fl oz",
        kind: "volume",
        baseAmount: 128,
        baseUnit: "fl oz",
        label: "1 gal",
      },
    });
    vi.mocked(searchKrogerProducts).mockResolvedValue(searchResponse([milk]));

    const response = await searchPost(new Request("http://localhost:3000/api/kroger/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ text: "Whole Milk, 1 gallon" }],
        locationId: "AB12CD34",
        fulfillmentMode: "pickup",
      }),
    }));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const query = vi.mocked(searchKrogerProducts).mock.calls[0]?.[0] as string;

    expect(query).toMatch(/whole milk/i);
    expect(query).not.toMatch(/gallon|128|\b1\b/i);
    expect(searchKrogerProducts).toHaveBeenCalledTimes(1);
    expect(events[1]).toMatchObject({
      phase: "verification",
      result: { status: "matched", recommended: { productId: "0001111099991" } },
    });
  });

  it("broadens discovery but never substitutes a closest pack", async () => {
    const twelvePack = krogerProduct({
      id: "0001111088812",
      productId: "0001111088812",
      upc: "0001111088812",
      title: "Coca-Cola Original Taste Soda 12 Cans 12 fl oz",
      brand: "Coca-Cola",
      productType: "Soft Drinks",
      price: 8.49,
      size: {
        amount: 144,
        unit: "fl oz",
        kind: "volume",
        baseAmount: 144,
        baseUnit: "fl oz",
        packCount: 12,
        perPackageAmount: 12,
        label: "12 x 12 fl oz",
      },
    });
    vi.mocked(searchKrogerProducts).mockResolvedValue(searchResponse([twelvePack]));

    const response = await searchPost(new Request("http://localhost:3000/api/kroger/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ text: "Coca-Cola Original, 24 pack" }],
        locationId: "AB12CD34",
        fulfillmentMode: "pickup",
      }),
    }));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const verification = events.find((event) => event.phase === "verification");
    const queries = vi.mocked(searchKrogerProducts).mock.calls.map(([query]) => query);

    expect(queries.length).toBeGreaterThanOrEqual(1);
    expect(queries.length).toBeLessThanOrEqual(3);
    expect(queries.every((query) => !/24\s*(?:pack|pk)/i.test(query))).toBe(true);
    expect(verification.result).toMatchObject({ status: "no_match", recommended: null });
    expect(verification.result.explanation).toMatch(/no verified 24-pack package/i);
  });

  it("preserves extension package fields for strict verification without putting them in discovery", async () => {
    const twelvePack = krogerProduct({
      id: "0001111088813",
      productId: "0001111088813",
      upc: "0001111088813",
      title: "Coca-Cola Original Taste Soda 12 Pack 12 fl oz Cans",
      brand: "Coca-Cola",
      productType: "Soft Drinks",
      size: {
        amount: 144,
        unit: "fl oz",
        kind: "volume",
        baseAmount: 144,
        baseUnit: "fl oz",
        packCount: 12,
        perPackageAmount: 12,
        label: "12 x 12 fl oz",
      },
    });
    vi.mocked(searchKrogerProducts).mockResolvedValue(searchResponse([twelvePack]));

    const response = await searchPost(new Request("http://localhost:3000/api/kroger/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{
          text: "Coca-Cola Original",
          explicitBrand: "Coca-Cola",
          explicitSize: "12 oz",
          explicitPackCount: 24,
        }],
        locationId: "AB12CD34",
        fulfillmentMode: "pickup",
      }),
    }));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const verification = events.find((event) => event.phase === "verification");
    const queries = vi.mocked(searchKrogerProducts).mock.calls.map(([query]) => query);

    expect(queries.every((query) => !/12\s*oz|24\s*(?:pack|pk)/i.test(query))).toBe(true);
    expect(verification.result).toMatchObject({ status: "no_match", recommended: null });
    // The public stream keeps the response bound to the exact request line;
    // the derived extension facts remain strict verification constraints.
    expect(verification.result.requestedItem).toBe("Coca-Cola Original");
    expect(verification.result.explanation).toMatch(/no verified 24-pack of 12 fl oz package/i);
  });

  it("explains when a strict identity and package lack pickup commerce evidence", async () => {
    const unavailableEggs = krogerProduct({
      inStock: false,
      availabilityStatus: "unknown",
      cartEligible: false,
    });
    vi.mocked(searchKrogerProducts).mockResolvedValue(searchResponse([unavailableEggs]));

    const response = await searchPost(new Request("http://localhost:3000/api/kroger/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ text: "Large eggs, 12 count" }],
        locationId: "AB12CD34",
        fulfillmentMode: "pickup",
      }),
    }));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const verification = events.find((event) => event.phase === "verification");

    expect(verification.result).toMatchObject({ status: "no_match", recommended: null });
    expect(verification.result.explanation).toMatch(/did not confirm it as in stock/i);
  });
});

describe("Kroger cart operation durable-state integrity", () => {
  function successfulOperation() {
    return vi.fn(async () => ({
      success: true as const,
      addedCount: 1,
      itemCount: 1,
      cartUrl: "https://www.kroger.com/cart",
      chain: "Kroger",
      selectedSearchLocation: { locationId: "AB12CD34", name: "Kroger Test" },
      locationBoundByCartApi: false as const,
      message: "accepted",
    }));
  }

  it("allows a first operation only when the receipt file is absent", async () => {
    const operation = successfulOperation();

    await expect(runKrogerCartOperation(
      "missing_receipt_file_001",
      "missing-file-fingerprint",
      operation,
    )).resolves.toMatchObject({ replayed: false });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("fails closed on corrupt receipt JSON without calling Kroger", async () => {
    const file = path.join(os.tmpdir(), `cartiva-corrupt-receipts-${Date.now()}-${Math.random()}.json`);
    vi.stubEnv("KROGER_CART_RECEIPT_FILE", file);
    await writeFile(file, "{not-json", "utf8");
    resetKrogerCartOperationsForTests();
    const operation = successfulOperation();

    await expect(runKrogerCartOperation(
      "corrupt_receipt_file_001",
      "corrupt-file-fingerprint",
      operation,
    )).rejects.toMatchObject({ name: "KrogerCartOperationStateUnavailableError" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed persisted record without calling Kroger", async () => {
    const file = path.join(os.tmpdir(), `cartiva-malformed-receipts-${Date.now()}-${Math.random()}.json`);
    vi.stubEnv("KROGER_CART_RECEIPT_FILE", file);
    await writeFile(file, JSON.stringify([{
      operationId: "prior_operation_without_a_complete_receipt",
      requestFingerprint: "prior-fingerprint",
      success: true,
    }]), "utf8");
    resetKrogerCartOperationsForTests();
    const operation = successfulOperation();

    await expect(runKrogerCartOperation(
      "malformed_receipt_file_001",
      "malformed-file-fingerprint",
      operation,
    )).rejects.toMatchObject({ name: "KrogerCartOperationStateUnavailableError" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("fails closed when the receipt path is unreadable without calling Kroger", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-unreadable-receipts-"));
    vi.stubEnv("KROGER_CART_RECEIPT_FILE", directory);
    resetKrogerCartOperationsForTests();
    const operation = successfulOperation();

    await expect(runKrogerCartOperation(
      "unreadable_receipt_file_001",
      "unreadable-file-fingerprint",
      operation,
    )).rejects.toMatchObject({ name: "KrogerCartOperationStateUnavailableError" });
    expect(operation).not.toHaveBeenCalled();
  });
});
