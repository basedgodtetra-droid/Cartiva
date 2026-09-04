import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GET as capabilitiesGet,
  OPTIONS as capabilitiesOptions,
} from "@/app/api/mobile/v1/capabilities/route";
import {
  OPTIONS as locationsOptions,
  POST as locationsPost,
} from "@/app/api/mobile/v1/kroger/locations/route";
import { POST as searchPost } from "@/app/api/mobile/v1/kroger/search/route";
import { POST as cartPost } from "@/app/api/kroger/cart/route";
import { POST as oauthStartPost } from "@/app/api/kroger/oauth/start/route";
import { POST as disconnectPost } from "@/app/api/kroger/auth/disconnect/route";
import { resetRateLimitsForTests } from "@/lib/api-security";
import { getKrogerAuthClient } from "@/lib/kroger-auth";
import {
  clearComparisonReceiptsForTests,
  comparisonBasketDigest,
  loadComparisonReceipt,
  resetComparisonReceiptsForTests,
} from "@/lib/mobile-comparison-receipts";
import { issueMobileSession } from "@/lib/mobile-session";
import {
  findKrogerLocations,
  getKrogerLocation,
  searchKrogerProducts,
} from "@/lib/kroger-provider";
import type { KrogerProduct } from "@/lib/types";
import {
  decodeKrogerSearchEvent,
  type KrogerSearchRequest,
} from "@/mobile/src/services/cartiva-api";

vi.mock("@/lib/kroger-provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kroger-provider")>("@/lib/kroger-provider");
  return {
    ...actual,
    findKrogerLocations: vi.fn(),
    getKrogerLocation: vi.fn(),
    searchKrogerProducts: vi.fn(),
  };
});

vi.mock("@/lib/kroger-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kroger-auth")>("@/lib/kroger-auth");
  return { ...actual, getKrogerAuthClient: vi.fn() };
});

const apiOrigin = "https://api.cartiva.example";
const browserOrigin = "https://mobile.cartiva.example";

function jsonRequest(pathname: string, body: unknown, origin?: string, authorization?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Forwarded-For": "203.0.113.42",
  };
  if (origin) headers.Origin = origin;
  if (authorization) headers.Authorization = authorization;
  return new Request(`${apiOrigin}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function eggProduct(): KrogerProduct {
  return {
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CARTIVA_MOBILE_ALLOWED_ORIGINS", "");
  vi.stubEnv(
    "CARTIVA_COMPARISON_RECEIPT_FILE",
    path.join(tmpdir(), `cartiva-mobile-api-comparison-${randomUUID()}.json`),
  );
  resetComparisonReceiptsForTests();
  resetRateLimitsForTests();
  vi.mocked(findKrogerLocations).mockResolvedValue({
    zipCode: "80202",
    locations: [{
      locationId: "AB12CD34",
      name: "King Soopers Test",
      chain: "KINGSOOPERS",
      address: {
        addressLine1: "1 Main Street",
        city: "Denver",
        state: "CO",
        zipCode: "80202",
      },
      departments: [],
    }],
    diagnostics: { apiCall: true, cacheHit: false, deduplicated: false, durationMs: 1 },
  });
  vi.mocked(getKrogerLocation).mockResolvedValue({
    locationId: "AB12CD34",
    name: "King Soopers Test",
    chain: "King Soopers",
    address: {
      addressLine1: "1 Main Street",
      city: "Denver",
      state: "CO",
      zipCode: "80202",
    },
    departments: [],
  });
  vi.mocked(searchKrogerProducts).mockResolvedValue({
    products: [eggProduct()],
    diagnostics: { apiCall: true, cacheHit: false, deduplicated: false, durationMs: 1 },
  });
});

afterEach(async () => {
  await clearComparisonReceiptsForTests();
  vi.unstubAllEnvs();
});

describe("anonymous mobile v1 read boundary", () => {
  it("accepts a native non-loopback store lookup without an Origin header", async () => {
    const response = await locationsPost(jsonRequest(
      "/api/mobile/v1/kroger/locations",
      { zipCode: "80202" },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toMatchObject({
      retailer: "kroger",
      zipCode: "80202",
      locations: [{
        locationId: "AB12CD34",
        name: "King Soopers Test",
        handoff: {
          mode: "SHOPPING_PAGE_ONLY",
          url: "https://www.kingsoopers.com/",
          storeSelectionRequired: true,
        },
      }],
    });
    expect(findKrogerLocations).toHaveBeenCalledWith("80202");
  });

  it("preserves Kroger's NDJSON stream while disabling cart transfer for mobile", async () => {
    const comparisonId = randomUUID();
    const mobileRequest: KrogerSearchRequest = {
      comparisonId,
      items: [{
        text: "large eggs 12 count",
        requestedItemId: "eggs-line",
        quantity: 1,
      }],
      locationId: "AB12CD34",
      zipCode: "80202",
      fulfillmentMode: "pickup",
    };
    const response = await searchPost(jsonRequest(
      "/api/mobile/v1/kroger/search",
      {
        retailer: "kroger",
        ...mobileRequest,
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("X-Cartiva-Cart-Automation"))
      .toBe("unavailable-on-anonymous-mobile-api");
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => decodeKrogerSearchEvent(event, mobileRequest, false)))
      .toHaveLength(3);
    expect(events.map((event) => event.type === "item" ? event.phase : event.type))
      .toEqual(["search", "verification", "performance"]);
    expect(events[1]).toMatchObject({
      phase: "verification",
      cartAutomation: { enabled: false },
      result: { status: "matched", recommended: { productId: "0001111012345" } },
    });
    expect(events.at(-1)).not.toHaveProperty("comparisonReceipt");
  });

  it("persists exact same-store UPCs and package quantities only for a signed mobile session", async () => {
    vi.stubEnv("CARTIVA_SESSION_SECRET", "test-only-mobile-session-secret-at-least-32-bytes");
    const session = issueMobileSession();
    const comparisonId = randomUUID();
    const mobileRequest: KrogerSearchRequest = {
      comparisonId,
      items: [{
        text: "large eggs 12 count",
        requestedItemId: "eggs-line",
        quantity: 2,
      }],
      locationId: "AB12CD34",
      zipCode: "80202",
      fulfillmentMode: "pickup",
    };
    const response = await searchPost(jsonRequest(
      "/api/mobile/v1/kroger/search",
      {
        retailer: "kroger",
        ...mobileRequest,
      },
      undefined,
      `Bearer ${session.sessionToken}`,
    ));

    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => decodeKrogerSearchEvent(event, mobileRequest, true)))
      .toHaveLength(3);
    expect(events[0]).toMatchObject({
      cartAutomation: { enabled: true, requiresCustomerConnection: true },
    });
    expect(events.at(-1)).toMatchObject({
      type: "performance",
      comparisonReceipt: {
        comparisonId,
        locationId: "AB12CD34",
        retailerBanner: "King Soopers",
        completeness: "COMPLETE",
        persisted: true,
      },
    });
    resetComparisonReceiptsForTests();
    const persistedReceipt = await loadComparisonReceipt(session.ownerId, comparisonId);
    expect(persistedReceipt).toMatchObject({
      locationId: "AB12CD34",
      zipCode: "80202",
      basketLines: [{
        requestedItemId: "eggs-line",
        retailerProductId: "0001111012345",
        upc: "0001111012345",
        quantity: 2,
        locationId: "AB12CD34",
      }],
    });
    expect(events.at(-1).comparisonReceipt.basketDigest)
      .toBe(comparisonBasketDigest(persistedReceipt!));
  });

  it("persists a likely-available catalog match as a complete warning-enabled handoff", async () => {
    vi.stubEnv("CARTIVA_SESSION_SECRET", "test-only-mobile-session-secret-at-least-32-bytes");
    const session = issueMobileSession();
    const comparisonId = randomUUID();
    vi.mocked(searchKrogerProducts).mockResolvedValue({
      products: [{
        ...eggProduct(),
        inStock: false,
        availabilityStatus: "likely_available",
        // Limited inventory confirmation is a warning, not a cart blocker.
        cartEligible: true,
      }],
      diagnostics: { apiCall: true, cacheHit: false, deduplicated: false, durationMs: 1 },
    });
    const mobileRequest: KrogerSearchRequest = {
      comparisonId,
      items: [{
        text: "large eggs 12 count",
        requestedItemId: "eggs-line",
        quantity: 1,
      }],
      locationId: "AB12CD34",
      zipCode: "80202",
      fulfillmentMode: "pickup",
    };

    const response = await searchPost(jsonRequest(
      "/api/mobile/v1/kroger/search",
      { retailer: "kroger", ...mobileRequest },
      undefined,
      `Bearer ${session.sessionToken}`,
    ));

    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((event) => event.phase === "verification")).toMatchObject({
      result: {
        status: "matched",
        resolution: "matched_check_availability",
        recommended: { availabilityStatus: "likely_available", cartEligible: true },
      },
    });
    expect(events.at(-1)).toMatchObject({
      comparisonReceipt: { comparisonId, completeness: "COMPLETE", persisted: true },
    });

    resetComparisonReceiptsForTests();
    const persistedReceipt = await loadComparisonReceipt(session.ownerId, comparisonId);
    expect(persistedReceipt).toMatchObject({
      completeness: "COMPLETE",
      basketLines: [{
        requestedItemId: "eggs-line",
        status: "ACCEPTED",
        availabilityStatus: "LIKELY_AVAILABLE",
        retailerProductId: "0001111012345",
        upc: "0001111012345",
      }],
    });
  });

  it("rejects duplicate requested line IDs before a signed comparison searches Kroger", async () => {
    vi.stubEnv("CARTIVA_SESSION_SECRET", "test-only-mobile-session-secret-at-least-32-bytes");
    const session = issueMobileSession();
    const response = await searchPost(jsonRequest(
      "/api/mobile/v1/kroger/search",
      {
        retailer: "kroger",
        comparisonId: randomUUID(),
        items: [
          { text: "bread", requestedItemId: "duplicate-line", quantity: 1 },
          { text: "milk", requestedItemId: "duplicate-line", quantity: 1 },
        ],
        locationId: "AB12CD34",
        zipCode: "80202",
        fulfillmentMode: "pickup",
      },
      undefined,
      `Bearer ${session.sessionToken}`,
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/unique line identifier/i) });
    expect(searchKrogerProducts).not.toHaveBeenCalled();
  });

  it("matches normal Coke, Coke Zero, and bread through the anonymous mobile route", async () => {
    const regularCoke: KrogerProduct = {
      ...eggProduct(),
      id: "0004900001273",
      productId: "0004900001273",
      upc: "0004900001273",
      title: "Coca-Cola Original Taste Soda 12 Pack 12 fl oz Cans",
      brand: "Coca-Cola",
      productType: "Soft Drinks",
      price: 11.99,
      inStock: false,
      availabilityStatus: "likely_available",
      cartEligible: true,
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
    };
    const cokeZero: KrogerProduct = {
      ...regularCoke,
      id: "0004900003714",
      productId: "0004900003714",
      upc: "0004900003714",
      title: "Coca-Cola Zero Sugar Soda 12 Pack 12 fl oz Cans",
    };
    const bread: KrogerProduct = {
      ...eggProduct(),
      id: "0001111008473",
      productId: "0001111008473",
      upc: "0001111008473",
      title: "Kroger Classic White Sandwich Bread 20 oz",
      brand: "Kroger",
      productType: "Bread",
      price: 1.99,
      size: {
        amount: 20,
        unit: "oz",
        kind: "weight",
        baseAmount: 20,
        baseUnit: "oz",
        label: "20 oz",
      },
    };
    vi.mocked(searchKrogerProducts).mockResolvedValue({
      products: [regularCoke, cokeZero, bread],
      diagnostics: { apiCall: true, cacheHit: false, deduplicated: false, durationMs: 1 },
    });

    const response = await searchPost(jsonRequest(
      "/api/mobile/v1/kroger/search",
      {
        retailer: "kroger",
        items: [{ text: "coke" }, { text: "coke zero" }, { text: "bread" }],
        locationId: "AB12CD34",
        zipCode: "80202",
        fulfillmentMode: "pickup",
      },
    ));

    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const verified = events
      .filter((event) => event.type === "item" && event.phase === "verification")
      .sort((left, right) => left.index - right.index);

    expect(verified).toHaveLength(3);
    expect(verified[0]).toMatchObject({
      result: {
        status: "matched",
        recommended: {
          productId: regularCoke.productId,
          availabilityStatus: "likely_available",
          cartEligible: true,
        },
      },
    });
    expect(verified[1]).toMatchObject({
      result: {
        status: "matched",
        recommended: {
          productId: cokeZero.productId,
          availabilityStatus: "likely_available",
          cartEligible: true,
        },
      },
    });
    expect(verified[2]).toMatchObject({
      result: {
        status: "matched",
        recommended: { productId: bread.productId, availabilityStatus: "in_stock" },
      },
    });
    expect(verified[0].result.recommended.title).toMatch(/Original Taste/i);
    expect(verified[1].result.recommended.title).toMatch(/Zero Sugar/i);
    expect(verified[2].result.requestedItem).toBe("bread");
  });

  it("does not let a preferred unsafe packaged alternative become a verified mobile match", async () => {
    const packagedSnack: KrogerProduct = {
      ...eggProduct(),
      id: "0008500006421",
      productId: "0008500006421",
      upc: "0008500006421",
      title: "Pure Organic Strawberry Banana 6.2oz",
      brand: "Pure Organic",
      productType: "Fruit Snacks",
      price: 4.49,
      size: {
        amount: 6.2,
        unit: "oz",
        kind: "weight",
        baseAmount: 6.2,
        baseUnit: "oz",
        label: "6.2 oz",
      },
    };
    vi.mocked(searchKrogerProducts).mockResolvedValue({
      products: [packagedSnack],
      diagnostics: { apiCall: true, cacheHit: false, deduplicated: false, durationMs: 1 },
    });

    const response = await searchPost(jsonRequest(
      "/api/mobile/v1/kroger/search",
      {
        retailer: "kroger",
        items: [{ text: "bananas", preferredProductId: packagedSnack.productId }],
        locationId: "AB12CD34",
        zipCode: "80202",
        fulfillmentMode: "pickup",
      },
    ));

    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const verification = events.find((event) => event.phase === "verification");
    expect(verification).toMatchObject({
      diagnostics: { verificationStatus: "no_verified_match" },
      result: {
        status: "no_match",
        confidence: "low",
        recommended: null,
        alternatives: [],
      },
    });
    expect(verification.result.explanation).toMatch(/none matched bananas/i);
  });

  it("rejects fields that the existing Kroger read contract does not support", async () => {
    const response = await searchPost(jsonRequest(
      "/api/mobile/v1/kroger/search",
      {
        items: ["eggs"],
        locationId: "AB12CD34",
        fulfillmentMode: "pickup",
        userId: "mass-assigned-user",
      },
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/unsupported fields/i) });
    expect(getKrogerLocation).not.toHaveBeenCalled();
    expect(searchKrogerProducts).not.toHaveBeenCalled();
  });

  it("requires safe JSON payloads on the public read boundary", async () => {
    const wrongType = new Request(`${apiOrigin}/api/mobile/v1/kroger/locations`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect((await locationsPost(wrongType)).status).toBe(415);

    const oversized = new Request(`${apiOrigin}/api/mobile/v1/kroger/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(64 * 1024 + 1),
      },
      body: "{}",
    });
    expect((await locationsPost(oversized)).status).toBe(413);
    expect(findKrogerLocations).not.toHaveBeenCalled();
  });

  it("denies browser CORS by default and allows only an exact configured origin", async () => {
    const denied = await locationsPost(jsonRequest(
      "/api/mobile/v1/kroger/locations",
      { zipCode: "80202" },
      browserOrigin,
    ));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(findKrogerLocations).not.toHaveBeenCalled();

    vi.stubEnv("CARTIVA_MOBILE_ALLOWED_ORIGINS", browserOrigin);
    const allowed = await locationsPost(jsonRequest(
      "/api/mobile/v1/kroger/locations",
      { zipCode: "80202" },
      browserOrigin,
    ));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(browserOrigin);

    const preflight = locationsOptions(new Request(
      `${apiOrigin}/api/mobile/v1/kroger/locations`,
      {
        method: "OPTIONS",
        headers: {
          Origin: browserOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, x-cartiva-client",
        },
      },
    ));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(browserOrigin);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(preflight.headers.get("Access-Control-Allow-Headers"))
      .toBe("Accept, Content-Type, X-Cartiva-Client");

    const capabilitiesPreflight = capabilitiesOptions(new Request(
      `${apiOrigin}/api/mobile/v1/capabilities`,
      {
        method: "OPTIONS",
        headers: {
          Origin: browserOrigin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "x-cartiva-client",
        },
      },
    ));
    expect(capabilitiesPreflight.status).toBe(204);
    expect(capabilitiesPreflight.headers.get("Access-Control-Allow-Origin")).toBe(browserOrigin);
    expect(capabilitiesPreflight.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });

  it("permits an explicitly configured private-LAN web preview only outside production", async () => {
    const lanOrigin = "http://192.168.1.129:8081";
    vi.stubEnv("CARTIVA_MOBILE_ALLOWED_ORIGINS", lanOrigin);
    vi.stubEnv("NODE_ENV", "development");

    const developmentResponse = await locationsPost(jsonRequest(
      "/api/mobile/v1/kroger/locations",
      { zipCode: "80202" },
      lanOrigin,
    ));
    expect(developmentResponse.status).toBe(200);
    expect(developmentResponse.headers.get("Access-Control-Allow-Origin")).toBe(lanOrigin);

    vi.stubEnv("NODE_ENV", "production");
    const productionResponse = await locationsPost(jsonRequest(
      "/api/mobile/v1/kroger/locations",
      { zipCode: "80202" },
      lanOrigin,
    ));
    expect(productionResponse.status).toBe(403);
    expect(productionResponse.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("reports only the truthful anonymous Kroger read and handoff capability", async () => {
    const response = capabilitiesGet(new Request(
      `${apiOrigin}/api/mobile/v1/capabilities`,
      { headers: { "X-Forwarded-For": "203.0.113.43" } },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      apiVersion: "v1",
      access: "ANONYMOUS_READ_ONLY",
      retailers: [{
        id: "kroger",
        label: "Kroger",
        status: "ACTIVE",
        read: { locations: true, productSearch: true },
        handoff: {
          mode: "SHOPPING_PAGE_ONLY",
          cartTransferSupported: false,
          requiresRetailerCheckout: true,
          reason: "Kroger cart writing is not explicitly enabled on this Cartiva backend.",
        },
      }],
    });
    expect(JSON.stringify(body)).not.toMatch(/token|secret|oauth/i);
  });

  it("returns a chain-safe shopping page, never a cart-transfer destination", async () => {
    const response = await locationsPost(jsonRequest(
      "/api/mobile/v1/kroger/locations",
      { zipCode: "80202" },
    ));
    const body = await response.json();
    const handoff = body.locations[0].handoff;
    const url = new URL(handoff.url);

    expect(handoff.mode).toBe("SHOPPING_PAGE_ONLY");
    expect(handoff.storeSelectionRequired).toBe(true);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("www.kingsoopers.com");
    expect(url.pathname).toBe("/");
    expect(url.pathname).not.toMatch(/\/cart|\/p\//i);
    expect(JSON.stringify(handoff)).not.toMatch(/added|transferred|oauth|token/i);
  });

  it("does not open the existing cart or OAuth mutations to non-loopback callers", async () => {
    const cart = await cartPost(jsonRequest("/api/kroger/cart", {
      operationId: "mobile_attempt_000001",
      locationId: "AB12CD34",
      fulfillmentMode: "pickup",
      items: [{ upc: "0001111012345", quantity: 1 }],
    }));
    const oauthStart = await oauthStartPost(new Request(`${apiOrigin}/api/kroger/oauth/start`, {
      method: "POST",
    }));
    const disconnect = await disconnectPost(new Request(
      `${apiOrigin}/api/kroger/auth/disconnect`,
      { method: "POST" },
    ));

    expect(cart.status).toBe(403);
    expect(oauthStart.status).toBe(403);
    expect(disconnect.status).toBe(403);
    expect(getKrogerAuthClient).not.toHaveBeenCalled();
  });
});
