import { beforeEach, describe, expect, it, vi } from "vitest";
import { KrogerAuthError, type KrogerAuthClient } from "@/lib/kroger-auth";
import {
  findKrogerLocations,
  addToKrogerCart,
  resetKrogerProviderForTests,
  searchKrogerProducts,
} from "@/lib/kroger-provider";
import { rankKrogerProducts } from "@/lib/kroger-products";
import { isRetailerHandoffAcceptedMatch } from "@/packages/shared/src";

function authWithResponses(responses: unknown[]) {
  const fetchPublic = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  return { fetchPublic } as unknown as KrogerAuthClient;
}

beforeEach(() => resetKrogerProviderForTests());

describe("Kroger provider normalization", () => {
  it("prefers official sellable size metadata over nutrition numbers in a title", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111017676",
      upc: "0001111017676",
      description: "Protein Bars 6 Pack 12 g Protein 1.76 oz Each",
      brand: "Kroger",
      categories: ["Nutrition Bars"],
      items: [{
        itemId: "0001111017676",
        size: "10.56 oz",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 7.99 },
      }],
    }] }]);

    const result = await searchKrogerProducts("protein bars", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);

    expect(result.products[0]?.size).toMatchObject({
      kind: "weight",
      baseAmount: 10.56,
      baseUnit: "oz",
      label: "10.56 oz",
    });
  });

  it("reconciles one outer retailer item with numeric counted contents", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0004740066012",
      upc: "0004740066012",
      description: "Gillette Razor Blade Refills 6 Blades",
      brand: "Gillette",
      categories: ["Razor Blades"],
      items: [{
        itemId: "0004740066012",
        size: "1 ct",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 24.99 },
      }],
    }] }]);

    const result = await searchKrogerProducts("razor blade refills", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);

    expect(result.products[0]?.size).toMatchObject({
      kind: "count",
      baseAmount: 6,
      baseUnit: "each",
    });
    const ranked = rankKrogerProducts("razor refill 12 blades total", result.products);
    expect(ranked).toMatchObject({
      status: "matched",
      fulfillment: {
        cartQuantity: 2,
        packageCount: 2,
        requestedBaseAmount: 12,
        suppliedBaseAmount: 12,
        approvalRequired: false,
      },
    });
    expect(isRetailerHandoffAcceptedMatch(ranked)).toBe(true);
  });

  it("reconciles generic count and dozen titles when one outer item is reported", async () => {
    const auth = authWithResponses([{ data: [
      {
        productId: "0001111012012",
        upc: "0001111012012",
        description: "K-Cup Coffee Pods 12 Count Box",
        brand: "Kroger",
        categories: ["Coffee Pods"],
        items: [{
          itemId: "0001111012012",
          size: "1 ct",
          inventory: { stockLevel: "HIGH" },
          fulfillment: { curbside: true },
          price: { regular: 8.99 },
        }],
      },
      {
        productId: "0001111010012",
        upc: "0001111010012",
        description: "Kroger Grade A Large White Eggs One Dozen",
        brand: "Kroger",
        categories: ["Eggs"],
        items: [{
          itemId: "0001111010012",
          size: "1 ct",
          inventory: { stockLevel: "HIGH" },
          fulfillment: { curbside: true },
          price: { regular: 3.49 },
        }],
      },
    ] }]);

    const result = await searchKrogerProducts("pods eggs", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);

    expect(result.products.map((product) => product.size?.baseAmount)).toEqual([12, 12]);
    expect(rankKrogerProducts("coffee pods 24 pods total", result.products)).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 2, requestedBaseAmount: 24, suppliedBaseAmount: 24 },
    });
    expect(rankKrogerProducts("eggs 21 count total", result.products)).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 2, requestedBaseAmount: 21, suppliedBaseAmount: 24 },
    });
  });

  it("does not bind one outer item to a textual count unit without numeric capacity", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012001",
      upc: "0001111012001",
      description: "K-Cup Coffee Pods Variety Box",
      brand: "Kroger",
      categories: ["Coffee Pods"],
      items: [{
        itemId: "0001111012001",
        size: "1 ct",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 8.99 },
      }],
    }] }]);

    const result = await searchKrogerProducts("coffee pods", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    const ranked = rankKrogerProducts("coffee pods 24 pods total", result.products);

    expect(ranked.status).not.toBe("matched");
    expect(isRetailerHandoffAcceptedMatch(ranked)).toBe(false);
  });

  it("reconciles per-unit physical metadata with the title's verified multipack", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012400",
      upc: "0001111012400",
      description: "Kroger Purified Water 24 Bottles 16.9 fl oz",
      brand: "Kroger",
      categories: ["Water"],
      items: [{
        itemId: "0001111012400",
        size: "16.9 fl oz",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 5.99 },
      }],
    }] }]);

    const result = await searchKrogerProducts("water", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products[0]?.size).toMatchObject({
      kind: "volume",
      packCount: 24,
      perPackageAmount: 16.9,
      baseAmount: 405.6,
    });
    const ranked = rankKrogerProducts("water 405.6 fl oz total", result.products);
    expect(ranked).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 1, requestedBaseAmount: 405.6, suppliedBaseAmount: 405.6 },
    });
    expect(isRetailerHandoffAcceptedMatch(ranked)).toBe(true);
  });

  it("reconciles pound-based per-unit metadata with a physical multipack title", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012401",
      upc: "0001111012401",
      description: "Frozen Chicken Breasts 4 Count 2 lb Each",
      brand: "Kroger",
      categories: ["Frozen Chicken"],
      items: [{
        itemId: "0001111012401",
        size: "2 lb",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 19.99 },
      }],
    }] }]);

    const result = await searchKrogerProducts("frozen chicken breasts", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products[0]?.size).toMatchObject({
      kind: "weight",
      packCount: 4,
      perPackageAmount: 2,
      baseAmount: 128,
      baseUnit: "oz",
    });
    const ranked = rankKrogerProducts("frozen chicken breasts 8 lb total", result.products);
    expect(ranked).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 1, requestedBaseAmount: 128, suppliedBaseAmount: 128 },
    });
    expect(isRetailerHandoffAcceptedMatch(ranked)).toBe(true);
  });

  it("reconciles reverse Pack-of physical metadata without repeating the multipack", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012402",
      upc: "0001111012402",
      description: "Protein Shake Pack of 2 12 fl oz Bottles",
      brand: "Kroger",
      categories: ["Protein Shakes"],
      items: [{
        itemId: "0001111012402",
        size: "12 fl oz",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 6.99 },
      }],
    }] }]);

    const result = await searchKrogerProducts("protein shake", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products[0]?.size).toMatchObject({
      kind: "volume",
      packCount: 2,
      baseAmount: 24,
    });
    expect(rankKrogerProducts("protein shake 24 fl oz total", result.products)).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 1, suppliedBaseAmount: 24 },
    });
  });

  it("keeps an unresolved count-plus-physical title on the safe count axis", async () => {
    const auth = authWithResponses([{ data: [
      {
        productId: "0001111012403",
        upc: "0001111012403",
        description: "Kroger Greek Yogurt 4 Count 5.3 oz",
        brand: "Kroger",
        categories: ["Greek Yogurt"],
        items: [{
          itemId: "0001111012403",
          size: "5.3 oz",
          inventory: { stockLevel: "HIGH" },
          fulfillment: { curbside: true },
          price: { regular: 4.99 },
        }],
      },
      {
        productId: "0001111012404",
        upc: "0001111012404",
        description: "Kroger Frozen Beef Meatballs 12 Count 1.69 lb Bag",
        brand: "Kroger",
        categories: ["Frozen Meatballs"],
        items: [{
          itemId: "0001111012404",
          size: "1.69 lb",
          inventory: { stockLevel: "HIGH" },
          fulfillment: { curbside: true },
          price: { regular: 8.99 },
        }],
      },
    ] }]);

    const result = await searchKrogerProducts("yogurt meatballs", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products.map((product) => product.size?.baseAmount)).toEqual([4, 12]);
    expect(rankKrogerProducts("greek yogurt 4 count total", result.products)).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 1, suppliedBaseAmount: 4 },
    });
    for (const request of ["greek yogurt 21.2 oz total", "frozen beef meatballs 20 lb total"]) {
      const ranked = rankKrogerProducts(request, result.products);
      expect(ranked.status).not.toBe("matched");
      expect(isRetailerHandoffAcceptedMatch(ranked)).toBe(false);
    }
  });

  it("does not repeat a physical-size case for an individual-container request", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012405",
      upc: "0001111012405",
      description: "Kroger Purified Water 24 Count 16.9 fl oz Bottle",
      brand: "Kroger",
      categories: ["Water"],
      items: [{
        itemId: "0001111012405",
        size: "16.9 fl oz",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 5.99 },
      }],
    }] }]);
    const result = await searchKrogerProducts("water", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    const ranked = rankKrogerProducts("3 bottles water", result.products);
    expect(ranked.status).not.toBe("matched");
    expect(isRetailerHandoffAcceptedMatch(ranked)).toBe(false);
  });

  it("combines a named outer-container count with per-unit physical metadata", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012407",
      upc: "0001111012407",
      description: "Kroger Purified Water 24 Bottles",
      brand: "Kroger",
      categories: ["Water"],
      items: [{
        itemId: "0001111012407",
        size: "16.9 fl oz",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 5.99 },
      }],
    }] }]);
    const result = await searchKrogerProducts("water", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products[0]?.size).toMatchObject({
      packCount: 24,
      perPackageAmount: 16.9,
      baseAmount: 405.6,
      baseUnit: "fl oz",
    });
    expect(rankKrogerProducts("water 405.6 fl oz total", result.products)).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 1, suppliedBaseAmount: 405.6 },
    });
    const individualRequest = rankKrogerProducts("3 bottles water", result.products);
    expect(individualRequest.status).not.toBe("matched");
    expect(isRetailerHandoffAcceptedMatch(individualRequest)).toBe(false);
  });

  it("does not re-multiply a retailer total already corroborated by the title", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012409",
      upc: "0001111012409",
      description: "Kroger Sparkling Water 12 Bottles 12 fl oz",
      brand: "Kroger",
      categories: ["Sparkling Water"],
      items: [{
        itemId: "0001111012409",
        size: "144 fl oz",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 5.99 },
      }],
    }] }]);
    const result = await searchKrogerProducts("sparkling water", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products[0]?.size).toMatchObject({ baseAmount: 144, baseUnit: "fl oz" });
    expect(rankKrogerProducts("sparkling water 1300 fl oz total", result.products)).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 10, requestedBaseAmount: 1300, suppliedBaseAmount: 1440 },
    });
  });

  it("never multiplies an explicitly total sell-UPC size by its container count", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012408",
      upc: "0001111012408",
      description: "Purina Cat Food 12 Pouches 36 oz Total",
      brand: "Purina",
      categories: ["Cat Food"],
      items: [{
        itemId: "0001111012408",
        size: "3 oz",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 14.99 },
      }],
    }] }]);
    const result = await searchKrogerProducts("cat food", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products[0]?.size?.baseAmount).toBe(36);
    expect(rankKrogerProducts("cat food 432 oz total", result.products)).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 12, requestedBaseAmount: 432, suppliedBaseAmount: 432 },
    });
  });

  it("does not multiply a food-piece roll count by the bag's total weight", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001410005514",
      upc: "0001410005514",
      description: "Pepperidge Farm Farmhouse Holiday Stuffing Seasoned Dinner Rolls 12 Rolls",
      brand: "Pepperidge Farm",
      categories: ["Dinner Rolls"],
      items: [{
        itemId: "0001410005514",
        size: "12 oz",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 4.99 },
      }],
    }] }]);
    const result = await searchKrogerProducts("dinner rolls", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products[0]?.size?.baseAmount).toBe(12);
    expect(rankKrogerProducts("dinner rolls 120 oz total", result.products)).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 10, requestedBaseAmount: 120, suppliedBaseAmount: 120 },
    });
  });

  it("reconciles a parenthesized outer count with per-can metadata", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0005000025819",
      upc: "0005000025819",
      description: "Fancy Feast Marinated Morsels Poultry & Beef Wet Cat Food Variety Pack (24) 3 oz Cans",
      brand: "Fancy Feast",
      categories: ["Cat Food"],
      items: [{
        itemId: "0005000025819",
        size: "3 oz",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 20.99 },
      }],
    }] }]);
    const result = await searchKrogerProducts("fancy feast cat food", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products[0]?.size).toMatchObject({
      packCount: 24,
      perPackageAmount: 3,
      baseAmount: 72,
      baseUnit: "oz",
    });
    expect(rankKrogerProducts("fancy feast cat food 72 oz total", result.products)).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 1, requestedBaseAmount: 72, suppliedBaseAmount: 72 },
    });
  });

  it("uses a compound sellable weight for aggregate fulfillment", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0001111012406",
      upc: "0001111012406",
      description: "Kroger Beef Chuck Roast 1 lb 8 oz Package",
      brand: "Kroger",
      categories: ["Beef Roast"],
      items: [{
        itemId: "0001111012406",
        size: "1 lb 8 oz",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 12.99 },
      }],
    }] }]);
    const result = await searchKrogerProducts("beef chuck roast", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);
    expect(result.products[0]?.size?.baseAmount).toBe(24);
    expect(rankKrogerProducts("beef chuck roast 3 lb total", result.products)).toMatchObject({
      status: "matched",
      fulfillment: { cartQuantity: 2, requestedBaseAmount: 48, suppliedBaseAmount: 48 },
    });
  });

  it("does not treat a hyphenated razor model as the sellable refill count", async () => {
    const auth = authWithResponses([{ data: [{
      productId: "0004740066013",
      upc: "0004740066013",
      description: "Gillette Fusion5 5-Blade Razor Refills, 4 Count",
      brand: "Gillette",
      categories: ["Razor Blades"],
      items: [{
        itemId: "0004740066013",
        size: "4 ct",
        inventory: { stockLevel: "HIGH" },
        fulfillment: { curbside: true },
        price: { regular: 24.99 },
      }],
    }] }]);

    const result = await searchKrogerProducts("razor blade refills", {
      locationId: "01400912",
      locationVerified: true,
      locationName: "Kroger Dallas",
      chain: "Kroger",
      fulfillmentMode: "pickup",
    }, auth);

    expect(result.products[0]?.size).toMatchObject({
      kind: "count",
      baseAmount: 4,
      baseUnit: "each",
    });
    const ranked = rankKrogerProducts("razor refills 5 blades total", result.products);
    expect(ranked.status).not.toBe("matched");
    expect(isRetailerHandoffAcceptedMatch(ranked)).toBe(false);
  });

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
      attributeOrigins: {
        title: "RETAILER_METADATA",
        brand: "RETAILER_METADATA",
        size: "RETAILER_METADATA",
      },
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
      cartEligible: true,
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

  it("classifies a cart 401 as an expired connection", async () => {
    const auth = {
      fetchCustomer: vi.fn(async () => new Response(null, { status: 401 })),
    } as unknown as KrogerAuthClient;
    await expect(addToKrogerCart([{
      upc: "0001111012345",
      quantity: 1,
      modality: "PICKUP",
    }], auth)).rejects.toEqual(expect.objectContaining({
      name: "KrogerAuthError",
      code: "not_connected",
      status: 401,
    } satisfies Partial<KrogerAuthError>));
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
