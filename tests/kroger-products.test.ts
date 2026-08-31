import { describe, expect, it } from "vitest";

import { rankKrogerProducts } from "@/lib/kroger-products";
import { analyzeProductFacets } from "@/lib/product-facets";
import type { KrogerProduct } from "@/lib/types";

function krogerProduct(overrides: Partial<KrogerProduct> = {}): KrogerProduct {
  return {
    retailer: "kroger",
    id: "0001111012345",
    productId: "0001111012345",
    upc: "0001111012345",
    title: "Kroger Grade A Large Eggs 12 Count",
    price: 3.49,
    priceCents: 349,
    link: "https://www.kroger.com/p/eggs/0001111012345",
    linkType: "product",
    seller: "Kroger",
    brand: "Kroger",
    productType: "Eggs",
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
    checkedAt: "2026-08-24T13:00:00.000Z",
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
      regularPriceCents: 349,
      locationId: "01400912",
      location: {
        requestedStoreId: "01400912",
        observedStoreId: "01400912",
        responseProvesLocation: true,
        storeMatched: true,
      },
      fulfillment: ["pickup"],
      checkedAt: "2026-08-24T13:00:00.000Z",
    },
    ...overrides,
  };
}

describe("Kroger product ranking", () => {
  it("reports the confidence carried by its recommended verified match", () => {
    const product = krogerProduct();
    const result = rankKrogerProducts(
      "large eggs 12 count",
      [product],
      [],
      { productId: product.productId },
    );

    expect(result.recommended).not.toBeNull();
    expect(result.recommended?.confidence).toBe("high");
    expect(result.confidence).toBe(result.recommended?.confidence);
    expect(result.status).toBe("matched");
  });

  it("keeps likely availability truthful while preserving the verified UPC for cart handoff", () => {
    const likely = krogerProduct({
      id: "0004900002890",
      productId: "0004900002890",
      upc: "0004900002890",
      title: "Coca-Cola Original Taste Soda Cans",
      brand: "Coca-Cola",
      productType: "Beverages",
      price: 11.99,
      priceCents: 1199,
      inStock: false,
      availabilityStatus: "likely_available",
      cartEligible: true,
      size: undefined,
    });
    const constraints = analyzeProductFacets("coke").constraints;

    const result = rankKrogerProducts("coke", [likely], constraints);

    expect(result).toMatchObject({ status: "matched" });
    expect(result.recommended).toMatchObject({
      productId: likely.productId,
      availabilityStatus: "likely_available",
      inStock: false,
      cartEligible: true,
    });
    expect(result.recommended?.reasons).toContain(
      "listed for the selected fulfillment method; inventory level was not reported",
    );

    const unknown = rankKrogerProducts("coke", [{
      ...likely,
      availabilityStatus: "unknown",
    }], constraints);
    expect(unknown).toMatchObject({ status: "no_match", recommended: null });
  });

  it("never accepts a low-confidence packaged strawberry-banana item for bananas", () => {
    const packagedSnack = krogerProduct({
      id: "0008500006421",
      productId: "0008500006421",
      upc: "0008500006421",
      title: "Pure Organic Strawberry Banana 6.2oz",
      brand: "Pure Organic",
      productType: "Fruit Snacks",
      price: 4.49,
      priceCents: 449,
      size: {
        amount: 6.2,
        unit: "oz",
        kind: "weight",
        baseAmount: 6.2,
        baseUnit: "oz",
        label: "6.2 oz",
      },
    });

    const automatic = rankKrogerProducts("bananas", [packagedSnack]);
    expect(automatic).toMatchObject({
      status: "no_match",
      confidence: "low",
      recommended: null,
      alternatives: [],
    });
    expect(automatic.explanation).toMatch(/could not verify it strongly enough/i);

    const preferred = rankKrogerProducts(
      "bananas",
      [packagedSnack],
      [],
      { productId: packagedSnack.productId },
    );
    expect(preferred).toMatchObject({
      status: "no_match",
      confidence: "low",
      recommended: null,
      alternatives: [],
    });
  });

  it("continues to accept a medium-confidence semantic match", () => {
    const bread = krogerProduct({
      id: "0001111088888",
      productId: "0001111088888",
      upc: "0001111088888",
      title: "Kroger White Bread",
      productType: "Bread",
      price: 1.99,
      priceCents: 199,
      size: undefined,
    });

    const result = rankKrogerProducts("white bread", [bread]);
    expect(result.recommended?.confidence).toBe("high");
    expect(result).toMatchObject({ status: "matched", confidence: "high" });
  });

  it("never exposes Walmart suggestion provenance in a revalidated Kroger match", () => {
    const bread = krogerProduct({
      id: "0001111088899",
      productId: "0001111088899",
      upc: "0001111088899",
      title: "Kroger White Bread",
      productType: "Bread",
      price: 1.99,
      priceCents: 199,
      size: undefined,
    });

    const result = rankKrogerProducts(
      "white bread",
      [bread],
      [],
      { productId: bread.productId },
    );

    expect(result.recommended?.reasons).toContain("preserves the previously verified product");
    expect(result.recommended?.reasons.join(" ")).not.toMatch(/walmart/i);
  });

  it.each([
    {
      caseName: "A: Coke accepts Coca-Cola Original Taste",
      request: "coke",
      title: "Coca-Cola Original Taste Soda Pop",
      expectedMatch: true,
      expectedConfidence: "medium" as const,
    },
    {
      caseName: "B: Coke Zero accepts Coca-Cola Zero Sugar",
      request: "coke zero",
      title: "Coca-Cola Zero Sugar Soda Pop",
      expectedMatch: true,
      expectedConfidence: "high" as const,
    },
    {
      caseName: "C: Coke Zero rejects regular Coca-Cola",
      request: "coke zero",
      title: "Coca-Cola Original Taste Soda Pop",
      expectedMatch: false,
      expectedConfidence: "low" as const,
    },
    {
      caseName: "D: Coke rejects Diet Coke",
      request: "coke",
      title: "Diet Coke Soda Pop",
      expectedMatch: false,
      expectedConfidence: "low" as const,
    },
  ])("enforces soda identity and variant — $caseName", ({
    request,
    title,
    expectedMatch,
    expectedConfidence,
  }) => {
    const product = krogerProduct({
      id: "0004900000001",
      productId: "0004900000001",
      upc: "0004900000001",
      title,
      brand: "Coca-Cola",
      productType: "Soda",
      price: 8.99,
      priceCents: 899,
      size: undefined,
    });
    const constraints = analyzeProductFacets(request).constraints;
    const result = rankKrogerProducts(request, [product], constraints);

    if (expectedMatch) {
      expect(result.status).toBe("matched");
      expect(result.recommended?.productId).toBe(product.productId);
      expect(result.confidence).toBe(expectedConfidence);
      expect(result.recommended?.reasons).toContain("confirms Coca-Cola soda identity");
    } else {
      expect(result).toMatchObject({
        status: "no_match",
        confidence: expectedConfidence,
        recommended: null,
      });
    }
  });
});
