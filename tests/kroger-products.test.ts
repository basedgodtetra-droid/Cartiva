import { describe, expect, it } from "vitest";

import {
  applyGroceryClarification,
  interpretGroceryInput,
} from "@/lib/grocery-notepad";
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

  it.each([
    {
      request: "93/7 ground beef 2 lb",
      wrongTitle: "Kroger Ground Beef 80/20, 2 lb Tray",
      exactTitle: "Kroger Lean Ground Beef 93% Lean, 2 lb Tray",
      productType: "Ground Beef",
      size: { amount: 2, unit: "lb", kind: "weight", baseAmount: 32, baseUnit: "oz", label: "2 lb" } as const,
    },
    {
      request: "boneless skinless chicken breast",
      wrongTitle: "Kroger Bone-In Skin-On Chicken Thighs",
      exactTitle: "Kroger Boneless Skinless Chicken Breast",
      productType: "Chicken Breast",
    },
    {
      request: "ribeye steak",
      wrongTitle: "Kroger Sirloin Steak",
      exactTitle: "Kroger Ribeye Steak",
      productType: "Beef",
    },
    {
      request: "pork chops",
      wrongTitle: "Kroger Pork Tenderloin",
      exactTitle: "Kroger Pork Chops",
      productType: "Pork",
    },
    {
      request: "salmon fillet",
      wrongTitle: "Salmon Flavor Cat Treats",
      exactTitle: "Kroger Atlantic Salmon Fillet",
      productType: "Seafood",
    },
  ])("strictly verifies resolved protein attributes for $request", ({
    request,
    wrongTitle,
    exactTitle,
    productType,
    size,
  }) => {
    const wrong = krogerProduct({
      id: "0001111000001",
      productId: "0001111000001",
      upc: "0001111000001",
      title: wrongTitle,
      productType,
      price: 1.99,
      priceCents: 199,
      size,
    });
    const exact = krogerProduct({
      id: "0001111000002",
      productId: "0001111000002",
      upc: "0001111000002",
      title: exactTitle,
      productType,
      price: 6.99,
      priceCents: 699,
      size,
    });
    const constraints = analyzeProductFacets(request).constraints;

    expect(rankKrogerProducts(request, [wrong], constraints)).toMatchObject({
      status: "no_match",
      recommended: null,
    });
    expect(rankKrogerProducts(request, [wrong, exact], constraints).recommended?.productId).toBe(exact.productId);
  });

  it.each([
    {
      caseName: "a chicken productType that contradicts the title's cut",
      request: "boneless skinless chicken breast",
      title: "Kroger Boneless Skinless Chicken Thighs",
      productType: "Chicken Breast",
    },
    {
      caseName: "a seafood productType that contradicts the title's species",
      request: "wild caught salmon fillet",
      title: "Kroger Wild Caught Cod Fillet",
      productType: "Salmon",
    },
    {
      caseName: "a cod liver-oil supplement",
      request: "cod",
      title: "Kroger Cod Liver Oil 1000 mg Softgels",
      productType: "Vitamins and Supplements",
    },
    {
      caseName: "prepared tuna salad",
      request: "tuna",
      title: "Kroger Tuna Salad",
      productType: "Deli Prepared Foods",
    },
    {
      caseName: "breakfast-sausage pizza",
      request: "breakfast sausage",
      title: "Kroger Breakfast Sausage Pizza",
      productType: "Frozen Pizza",
    },
  ])("rejects $caseName despite exact-store eligibility", ({
    request,
    title,
    productType,
  }) => {
    const candidate = krogerProduct({
      id: "0001111000003",
      productId: "0001111000003",
      upc: "0001111000003",
      title,
      productType,
      size: undefined,
    });
    const constraints = analyzeProductFacets(request).constraints;

    expect(candidate.priceProvenance.exactStoreVerified).toBe(true);
    expect(rankKrogerProducts(request, [candidate], constraints)).toMatchObject({
      status: "no_match",
      recommended: null,
    });
  });

  it("allows either raw or fully cooked shrimp after the shopper chooses Any", () => {
    const clarified = applyGroceryClarification("shrimp", "shrimp-cooking", "any");
    const interpreted = interpretGroceryInput(clarified).items[0];
    const request = interpreted.canonicalText;
    const constraints = analyzeProductFacets(request).constraints;
    const raw = krogerProduct({
      id: "0001111000101",
      productId: "0001111000101",
      upc: "0001111000101",
      title: "Kroger Raw Jumbo Shrimp 1 lb",
      productType: "Seafood",
    });
    const cooked = krogerProduct({
      id: "0001111000102",
      productId: "0001111000102",
      upc: "0001111000102",
      title: "Kroger Fully Cooked Jumbo Shrimp 1 lb",
      productType: "Seafood",
    });

    expect(interpreted.status).toBe("ready");
    expect(rankKrogerProducts(request, [raw], constraints).recommended?.productId).toBe(raw.productId);
    expect(rankKrogerProducts(request, [cooked], constraints).recommended?.productId).toBe(cooked.productId);
  });

  it("allows smoked sausage after Any style without admitting sausage pizza", () => {
    const clarified = applyGroceryClarification("sausage", "sausage-style", "any");
    const interpreted = interpretGroceryInput(clarified).items[0];
    const request = interpreted.canonicalText;
    const constraints = analyzeProductFacets(request).constraints;
    const smoked = krogerProduct({
      id: "0001111000201",
      productId: "0001111000201",
      upc: "0001111000201",
      title: "Kroger Smoked Sausage 14 oz",
      productType: "Sausage",
    });
    const pizza = krogerProduct({
      id: "0001111000202",
      productId: "0001111000202",
      upc: "0001111000202",
      title: "Kroger Sausage Pizza 20 oz",
      productType: "Frozen Pizza",
    });

    expect(interpreted.status).toBe("ready");
    expect(rankKrogerProducts(request, [smoked], constraints).recommended?.productId).toBe(smoked.productId);
    expect(rankKrogerProducts(request, [pizza], constraints)).toMatchObject({
      status: "no_match",
      recommended: null,
    });
  });
});
