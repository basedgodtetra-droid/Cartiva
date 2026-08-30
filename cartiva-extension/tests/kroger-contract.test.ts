import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CartivaBackendClient,
  KrogerCartError,
  parseKrogerStoreLookupResult,
} from "../src/backend-client";
import { isKrogerBuildEligible, krogerSubtotalCents } from "../src/totals";
import {
  isTrustedKrogerAuthorizationUrl,
  isTrustedKrogerCartUrl,
  isTrustedKrogerFamilyUrl,
  isTrustedKrogerNavigationUrl,
} from "../src/kroger-hosts";
import { canonicalKrogerCartItems, krogerCartOperationId } from "../src/kroger-cart";
import type { PreparedItem } from "../src/types";

function krogerItem(): PreparedItem {
  const checkedAt = new Date().toISOString();
  return {
    id: "eggs",
    request: { id: "eggs", text: "eggs", normalizedText: "eggs", quantity: 2 },
    retailer: "kroger",
    matchStatus: "matched",
    dataMode: "live",
    alternatives: [],
    cartStatus: "ready",
    checkedAt,
    product: {
      retailer: "kroger",
      id: "0001111085428",
      productId: "0001111085428",
      upc: "0001111085428",
      title: "Kroger Grade A Large Eggs, 12 Count",
      brand: "Kroger",
      price: 2.49,
      priceCents: 249,
      link: "https://www.kroger.com/p/kroger-grade-a-large-eggs/0001111085428",
      linkType: "product",
      inStock: true,
      availabilityStatus: "in_stock",
      identityVerified: true,
      cartEligible: true,
      verification: "verified",
      checkedAt,
      priceProvenance: {
        retailer: "kroger",
        priceScope: "exact_store",
        priceReliability: "verified",
        exactStoreVerified: true,
        fulfillment: ["pickup"],
        location: {
          requestedStoreId: "03500515",
          observedStoreId: "03500515",
          responseProvesLocation: true,
          storeMatched: true,
        },
      },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Kroger extension boundary", () => {
  it("parses official locations and preserves the returned banner", () => {
    expect(parseKrogerStoreLookupResult({
      data: [{
        locationId: "03500515",
        chain: "King Soopers",
        name: "King Soopers - Uintah",
        address: { addressLine1: "1750 W Uintah St", city: "Colorado Springs", state: "CO", zipCode: "80904" },
      }],
    }, "80904")).toEqual({
      zipCode: "80904",
      stores: [{
        id: "03500515",
        chain: "King Soopers",
        name: "King Soopers - Uintah",
        address: "1750 W Uintah St, Colorado Springs, CO, 80904",
        zip: "80904",
      }],
    });
  });

  it("requires the canonical exact-location provenance and pickup, not generic in-store", () => {
    const item = krogerItem();
    expect(isKrogerBuildEligible(item, "pickup", Date.now(), "03500515")).toBe(true);
    expect(krogerSubtotalCents([item], "pickup", Date.now(), "03500515")).toBe(498);
    const onlyInStore = {
      ...item,
      product: {
        ...item.product!,
        priceProvenance: { ...item.product!.priceProvenance!, fulfillment: ["in_store" as const] },
      },
    };
    expect(isKrogerBuildEligible(onlyInStore, "pickup", Date.now(), "03500515")).toBe(false);
    const unknownStock = { ...item, product: { ...item.product!, availabilityStatus: "unknown" as const } };
    expect(isKrogerBuildEligible(unknownStock, "pickup", Date.now(), "03500515")).toBe(false);
    expect(isKrogerBuildEligible(item, "shipping", Date.now(), "03500515")).toBe(false);
  });

  it("uses only local proxy routes for auth status, auth start, and cart", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/auth/status")) return new Response(JSON.stringify({ connected: true, configured: true }));
      if (value.endsWith("/auth/start")) return new Response(JSON.stringify({ authorizationUrl: "https://api.kroger.com/v1/connect/oauth2/authorize?client_id=x" }));
      return new Response(JSON.stringify({ success: true, addedCount: 1, cartUrl: "https://www.kroger.com/cart" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new CartivaBackendClient();
    await client.getKrogerOAuthStatus("http://localhost:3000");
    await client.startKrogerOAuth("http://localhost:3000");
    await client.addKrogerCart("http://localhost:3000", {
      locationId: "03500515",
      fulfillmentMode: "pickup",
      operationId: "kroger-test-operation-0001",
      items: [{ upc: "0001111085428", quantity: 1 }],
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:3000/api/extension/kroger/auth/status",
      "http://localhost:3000/api/extension/kroger/auth/start",
      "http://localhost:3000/api/extension/kroger/cart",
    ]);
  });

  it("preserves an uncertain cart outcome and never presents it as retry-safe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Kroger did not confirm the upstream result.",
      code: "outcome_unknown",
      retrySafe: false,
    }), { status: 502 })));
    const client = new CartivaBackendClient();
    await expect(client.addKrogerCart("http://localhost:3000", {
      locationId: "03500515",
      fulfillmentMode: "pickup",
      operationId: "kroger-test-operation-unknown",
      items: [{ upc: "0001111085428", quantity: 1 }],
    })).rejects.toMatchObject<KrogerCartError>({
      code: "outcome_unknown",
      retrySafe: false,
      status: 502,
    });
  });

  it("supports disconnecting a stale Kroger session through the local proxy", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connected: false })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CartivaBackendClient();
    await expect(client.disconnectKrogerOAuth("http://127.0.0.1:8088")).resolves.toMatchObject({ connected: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8088/api/extension/kroger/auth/disconnect",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("derives the same protected operation for the same semantic cart", async () => {
    const first = await krogerCartOperationId("03500515", "pickup", [
      { upc: "0001111085428", quantity: 1 },
      { upc: "0001111041707", quantity: 1 },
      { upc: "0001111085428", quantity: 1 },
    ]);
    const reordered = await krogerCartOperationId("03500515", "pickup", [
      { upc: "0001111085428", quantity: 2 },
      { upc: "0001111041707", quantity: 1 },
    ]);
    const changed = await krogerCartOperationId("03500515", "pickup", [
      { upc: "0001111085428", quantity: 3 },
      { upc: "0001111041707", quantity: 1 },
    ]);
    expect(canonicalKrogerCartItems([
      { upc: "0001111085428", quantity: 1 },
      { upc: "0001111085428", quantity: 1 },
    ])).toEqual([{ upc: "0001111085428", quantity: 2 }]);
    expect(first).toBe(reordered);
    expect(first).toMatch(/^kroger_[a-f0-9]{64}$/);
    expect(changed).not.toBe(first);
  });

  it("allows only the exact Kroger-family host list", () => {
    expect(isTrustedKrogerFamilyUrl("https://www.kingsoopers.com/cart")).toBe(true);
    expect(isTrustedKrogerFamilyUrl("https://www.frysfood.com/p/item/123")).toBe(true);
    expect(isTrustedKrogerFamilyUrl("https://www.bakersplus.com/cart")).toBe(true);
    expect(isTrustedKrogerFamilyUrl("https://www.metromarket.net/cart")).toBe(true);
    expect(isTrustedKrogerFamilyUrl("https://evilkroger.com/cart")).toBe(false);
    expect(isTrustedKrogerFamilyUrl("https://kingsoopers.com.evil.example/cart")).toBe(false);
    expect(isTrustedKrogerCartUrl("https://www.kingsoopers.com/cart")).toBe(true);
    expect(isTrustedKrogerCartUrl("https://www.kingsoopers.com/p/item/123")).toBe(false);
    expect(isTrustedKrogerAuthorizationUrl(
      "https://api.kroger.com/v1/connect/oauth2/authorize?client_id=cartiva",
    )).toBe(true);
    expect(isTrustedKrogerAuthorizationUrl("https://api.kroger.com/v1/cart/add")).toBe(false);
    expect(isTrustedKrogerAuthorizationUrl(
      "https://api.kroger.com.evil.example/v1/connect/oauth2/authorize",
    )).toBe(false);
    expect(isTrustedKrogerNavigationUrl("http://10.evil.example/oauth")).toBe(false);
    expect(isTrustedKrogerNavigationUrl("http://192.168.evil.example/oauth")).toBe(false);
  });
});
