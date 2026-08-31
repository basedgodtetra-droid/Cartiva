import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KrogerAuthClient } from "@/lib/kroger-auth";
import {
  findKrogerLocations,
  addToKrogerCart,
  resetKrogerProviderForTests,
  searchKrogerProducts,
} from "@/lib/kroger-provider";

function authWithResponses(responses: unknown[]) {
  const fetchPublic = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  return { fetchPublic } as unknown as KrogerAuthClient;
}

beforeEach(() => resetKrogerProviderForTests());

describe("Kroger provider normalization", () => {
  it("keeps all nearby grocery locations and filters fuel-only sites", async () => {
    const auth = authWithResponses([{ data: [
      { locationId: "01400912", name: "Kroger Dallas", chain: "Kroger", address: { addressLine1: "1 Main", city: "Dallas", state: "TX", zipCode: "75201" } },
      { locationId: "FUEL0001", name: "Kroger Fuel Center", chain: "Kroger", address: { addressLine1: "2 Main", city: "Dallas", state: "TX", zipCode: "75201" } },
      { locationId: "01400913", name: "Kroger Uptown", chain: "Kroger", address: { addressLine1: "3 Main", city: "Dallas", state: "TX", zipCode: "75204" } },
    ] }]);
    const first = await findKrogerLocations("75201", auth);
    const second = await findKrogerLocations("75201", auth);
    expect(first.locations.map((entry) => entry.locationId)).toEqual(["01400912", "01400913"]);
    expect(second.locations).toEqual(first.locations);
    expect(second.diagnostics.cacheHit).toBe(true);
    expect(vi.mocked(auth.fetchPublic)).toHaveBeenCalledTimes(1);
  });

  it("separates verified stock, likely availability, and unknown availability", async () => {
    const auth = authWithResponses([{ data: [
      {
        productId: "0001111012345",
        upc: "0001111012345",
        description: "Kroger Grade A Large Eggs 12 Count",
        brand: "Kroger",
        productPageURI: "/p/kroger-eggs/0001111012345",
        items: [{
          itemId: "0001111012345",
          size: "12 ct",
          inventory: { stockLevel: "HIGH" },
          fulfillment: { curbside: true, delivery: true },
          price: { regular: 3.49, promo: 2.99 },
        }],
      },
      {
        productId: "0001111099999",
        upc: "0001111099999",
        description: "Kroger Large Eggs 18 Count",
        items: [{
          itemId: "0001111099999",
          inventory: {},
          fulfillment: { curbside: true },
          price: { regular: 4.99 },
        }],
      },
      {
        productId: "0001111088888",
        upc: "0001111088888",
        description: "Kroger Large Eggs 24 Count",
        items: [{
          itemId: "0001111088888",
          inventory: {},
          fulfillment: {},
          price: { regular: 6.99 },
        }],
      },
    ] }]);
    const result = await searchKrogerProducts("eggs", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products[0]).toMatchObject({
      retailer: "kroger",
      upc: "0001111012345",
      price: 3.49,
      availabilityStatus: "in_stock",
      cartEligible: true,
      identityVerified: true,
      linkType: "product",
      priceProvenance: {
        priceScope: "exact_store",
        exactStoreVerified: true,
        regularPriceCents: 349,
        promoPriceCents: 299,
        locationId: "01400912",
        location: {
          requestedStoreId: "01400912",
          observedStoreId: "01400912",
          responseProvesLocation: true,
          storeMatched: true,
        },
      },
    });
    expect(result.products[1]).toMatchObject({
      availabilityStatus: "likely_available",
      inStock: false,
      cartEligible: false,
      priceProvenance: { fulfillment: ["pickup"] },
    });
    expect(result.products[2]).toMatchObject({
      availabilityStatus: "unknown",
      inStock: false,
      cartEligible: false,
    });
  });

  it("does not turn an unevidenced promo-only amount into a comparison price", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012346",
      upc: "0001111012346",
      description: "Kroger Large Eggs 12 Count",
      items: [{
        itemId: "0001111012346",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { promo: 2.99 },
      }],
    }] }]);

    const result = await searchKrogerProducts("eggs", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);

    expect(result.products).toEqual([]);
  });

  it("does not relabel a productId as the UPC required by Kroger Cart API", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012346",
      description: "Kroger Large Eggs 12 Count",
      items: [{
        itemId: "0001111012346",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 3.49 },
      }],
    }] }]);

    const result = await searchKrogerProducts("eggs", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);

    expect(result.products).toEqual([]);
  });

  it("rebases a verified cross-banner product URI and strips tracking", async () => {
    const sourceUrl = "https://www.kroger.com/p/kroger-large-eggs/0001111012345?utm_source=api&fulfillment=PICKUP#details";
    const auth = authWithResponses([{ data: [{
      productId: "0001111012345",
      upc: "0001111012345",
      description: "Kroger Grade A Large Eggs 12 Count",
      productPageURI: sourceUrl,
      items: [{
        itemId: "0001111012345",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 3.49 },
      }],
    }] }]);

    const result = await searchKrogerProducts("eggs", {
      locationId: "62000115",
      locationVerified: true,
      locationName: "King Soopers - Union Station",
      chain: "KINGSOOPERS",
      fulfillmentMode: "pickup",
    }, auth);

    expect(result.products[0]).toMatchObject({
      link: "https://www.kingsoopers.com/p/kroger-large-eggs/0001111012345",
      linkType: "product",
      sourceUrl,
    });
  });

  it("falls back to a banner search when the product URI identifies another item", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012345",
      upc: "0001111012345",
      description: "Kroger Grade A Large Eggs 12 Count",
      productPageURI: "https://www.kroger.com/p/wrong-item/0001111099999?tracking=unsafe",
      items: [{
        itemId: "0001111012345",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 3.49 },
      }],
    }] }]);

    const result = await searchKrogerProducts("eggs", {
      locationId: "62000115",
      locationVerified: true,
      locationName: "King Soopers - Union Station",
      chain: "KINGSOOPERS",
      fulfillmentMode: "pickup",
    }, auth);
    const product = result.products[0];
    const link = new URL(product.link);

    expect(product.linkType).toBe("search");
    expect(product.sourceUrl).toBe(product.link);
    expect(product.sourceUrl).not.toContain("0001111099999");
    expect(link.origin).toBe("https://www.kingsoopers.com");
    expect(link.pathname).toBe("/search");
    expect(link.searchParams.get("query")).toBe("Kroger Grade A Large Eggs 12 Count");
  });

  it("classifies an upstream cart 500 as an unknown outcome", async () => {
    const auth = {
      fetchCustomer: vi.fn(async () => new Response(null, { status: 500 })),
    } as unknown as KrogerAuthClient;
    await expect(addToKrogerCart([{
      upc: "0001111012345",
      quantity: 1,
      modality: "PICKUP",
    }], auth)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(auth.fetchCustomer).toHaveBeenCalledWith(
      "/v1/cart/add",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("never follows Kroger redirects for reads or cart writes", async () => {
    const readAuth = {
      fetchPublic: vi.fn(async () => new Response(null, {
        status: 302,
        headers: { Location: "https://example.invalid/redirect" },
      })),
    } as unknown as KrogerAuthClient;
    await expect(findKrogerLocations("75201", readAuth)).rejects.toMatchObject({
      code: "upstream",
      status: 502,
    });

    const cartAuth = {
      fetchCustomer: vi.fn(async () => new Response(null, {
        status: 302,
        headers: { Location: "https://example.invalid/redirect" },
      })),
    } as unknown as KrogerAuthClient;
    await expect(addToKrogerCart([{
      upc: "0001111012345",
      quantity: 1,
      modality: "PICKUP",
    }], cartAuth)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(cartAuth.fetchCustomer).toHaveBeenCalledWith(
      "/v1/cart/add",
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});
