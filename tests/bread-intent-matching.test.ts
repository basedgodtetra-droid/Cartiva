import { describe, expect, it } from "vitest";
import { interpretGroceryInput } from "@/lib/grocery-notepad";
import { rankKrogerProducts } from "@/lib/kroger-products";
import { analyzeProductFacets } from "@/lib/product-facets";
import { parseProductIntent } from "@/lib/product-search-intent";
import type { KrogerProduct } from "@/lib/types";

function breadProduct(
  id: string,
  title: string,
  price: number,
  brand = "Kroger",
): KrogerProduct {
  const sizeMatch = title.match(/\b(\d+(?:\.\d+)?)\s*oz\b/i);
  const ounces = sizeMatch ? Number(sizeMatch[1]) : undefined;
  return {
    retailer: "kroger",
    id,
    productId: id,
    upc: id,
    title,
    price,
    priceCents: Math.round(price * 100),
    link: `https://www.kroger.com/p/${id}`,
    linkType: "product",
    seller: "Kroger",
    brand,
    productType: "Bread",
    inStock: true,
    availabilityStatus: "in_stock",
    sponsored: false,
    size: ounces === undefined ? undefined : {
      amount: ounces,
      unit: "oz",
      kind: "weight",
      baseAmount: ounces,
      baseUnit: "oz",
      label: `${ounces} oz`,
    },
    checkedAt: "2026-08-24T14:00:00.000Z",
    verification: "verified",
    verificationIssues: [],
    cartEligible: true,
    dataSource: "kroger_public_api",
    identityVerified: true,
    priceProvenance: {
      retailer: "kroger",
      priceSource: "kroger_location_product",
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified: true,
      regularPriceCents: Math.round(price * 100),
      locationId: "01400912",
      location: {
        requestedStoreId: "01400912",
        observedStoreId: "01400912",
        responseProvesLocation: true,
        storeMatched: true,
      },
      fulfillment: ["pickup"],
      checkedAt: "2026-08-24T14:00:00.000Z",
    },
  };
}

describe("bread intent and category-aware matching", () => {
  it("accepts a normal 20 oz loaf for generic bread without adding retailer weight to intent", () => {
    const notepadItem = interpretGroceryInput("white bread").items[0];
    const intent = parseProductIntent(notepadItem.raw);
    const result = rankKrogerProducts(notepadItem.raw, [
      breadProduct("0001111000020", "Kroger Classic White Sandwich Bread 20 oz Loaf", 1.99),
    ]);

    expect(notepadItem).toMatchObject({
      raw: "white bread",
      canonicalText: "White Bread",
      status: "ready",
    });
    expect(notepadItem.detail).toBeUndefined();
    expect(intent).toMatchObject({
      verificationText: "white bread",
      category: "bread",
    });
    expect(intent.requestedPackageLabel).toBeUndefined();
    expect(intent.packageConstraints).toEqual([]);
    expect(result).toMatchObject({
      requestedItem: "white bread",
      status: "matched",
      recommended: { id: "0001111000020" },
    });
  });

  it("prefers a classic loaf over an unrequested gluten-free specialty loaf", () => {
    const glutenFree = breadProduct(
      "0001111000012",
      "Kroger Gluten Free White Sandwich Bread 20 oz Loaf",
      1.49,
    );
    const classic = breadProduct(
      "0001111000020",
      "Kroger Classic White Sandwich Bread 20 oz Loaf",
      2.99,
    );

    const result = rankKrogerProducts("white bread", [glutenFree, classic]);

    expect(result).toMatchObject({
      status: "matched",
      recommended: { id: classic.id },
    });
  });

  it("rejects classic bread when gluten-free is an explicit shopper requirement", () => {
    const request = "gluten-free white bread";
    const constraints = analyzeProductFacets(request).constraints;
    const classic = breadProduct(
      "0001111000020",
      "Kroger Classic White Sandwich Bread 20 oz Loaf",
      1.49,
    );
    const glutenFree = breadProduct(
      "0001111000012",
      "Kroger Gluten Free White Sandwich Bread 20 oz Loaf",
      4.99,
    );

    expect(constraints).toContainEqual(expect.objectContaining({
      attribute: "dietary",
      value: "gluten-free",
      source: "typed",
    }));

    expect(rankKrogerProducts(request, [classic], constraints)).toMatchObject({
      status: "no_match",
      recommended: null,
    });
    expect(rankKrogerProducts(request, [classic, glutenFree], constraints)).toMatchObject({
      status: "matched",
      recommended: { id: glutenFree.id },
    });
  });

  it("rejects a 12 oz loaf when the shopper explicitly requests 20 oz", () => {
    const request = "white bread 20 oz";
    const constraints = analyzeProductFacets(request).constraints;
    const twelveOunce = breadProduct(
      "0001111000012",
      "Kroger Classic White Sandwich Bread 12 oz Loaf",
      0.99,
    );
    const twentyOunce = breadProduct(
      "0001111000020",
      "Kroger Classic White Sandwich Bread 20 oz Loaf",
      2.49,
    );

    expect(constraints).toContainEqual(expect.objectContaining({
      attribute: "loafSize",
      value: "20-oz",
      source: "typed",
    }));

    expect(rankKrogerProducts(request, [twelveOunce], constraints)).toMatchObject({
      status: "no_match",
      recommended: null,
    });
    expect(rankKrogerProducts(request, [twelveOunce, twentyOunce], constraints)).toMatchObject({
      status: "matched",
      recommended: { id: twentyOunce.id },
    });
  });

  it("never treats hamburger buns as a loaf merely because the bread brand matches", () => {
    const cheapBuns = breadProduct(
      "bimbo-buns-cheap",
      "Bimbo Soft White Hamburger Buns",
      0.01,
      "Bimbo",
    );
    const expensiveBuns = { ...cheapBuns, id: "bimbo-buns-expensive", price: 99, priceCents: 9_900 };

    expect(rankKrogerProducts("Bimbo bread", [cheapBuns])).toMatchObject({
      status: "no_match",
      recommended: null,
    });
    expect(rankKrogerProducts("Bimbo bread", [expensiveBuns])).toMatchObject({
      status: "no_match",
      recommended: null,
    });
  });

  it("accepts buns when the shopper explicitly requests the buns format", () => {
    const buns = breadProduct(
      "bimbo-buns",
      "Bimbo Soft White Hamburger Buns",
      3.49,
      "Bimbo",
    );
    const loaf = breadProduct(
      "bimbo-loaf",
      "Bimbo Soft White Sandwich Bread Loaf",
      2.99,
      "Bimbo",
    );

    expect(rankKrogerProducts("Bimbo hamburger buns", [loaf, buns])).toMatchObject({
      status: "matched",
      recommended: { id: buns.id },
    });
  });
});
