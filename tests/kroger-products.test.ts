import { describe, expect, it } from "vitest";

import {
  applyGroceryClarification,
  interpretGroceryInput,
} from "@/lib/grocery-notepad";
import { rankKrogerProducts } from "@/lib/kroger-products";
import { analyzeProductFacets } from "@/lib/product-facets";
import type { KrogerProduct, Measurement } from "@/lib/types";

function weightSize(amount: number, unit: "oz" | "lb" = "oz"): Measurement {
  return {
    amount,
    unit,
    kind: "weight",
    baseAmount: unit === "lb" ? amount * 16 : amount,
    baseUnit: "oz",
    label: `${amount} ${unit}`,
  };
}

function volumeSize(amount: number): Measurement {
  return {
    amount,
    unit: "fl oz",
    kind: "volume",
    baseAmount: amount,
    baseUnit: "fl oz",
    label: `${amount} fl oz`,
  };
}

function countSize(amount: number): Measurement {
  return {
    amount,
    unit: "count",
    kind: "count",
    baseAmount: amount,
    baseUnit: "each",
    packCount: amount,
    perPackageAmount: 1,
    label: `${amount} count`,
  };
}

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
  it("prefers standard dry white rice when Kroger's broad aisle metadata says pasta", () => {
    const dryRice = krogerProduct({
      id: "0001111089875",
      productId: "0001111089875",
      upc: "0001111089875",
      title: "Kroger® Enriched Long Grain White Rice",
      brand: "Kroger",
      productType: "Pasta, Sauces, Grain",
      price: 1.79,
      priceCents: 179,
      size: weightSize(32),
    });
    const cookedRice = krogerProduct({
      id: "0080717671412",
      productId: "0080717671412",
      upc: "0080717671412",
      title: "Bibigo Cooked Sticky White Rice",
      brand: "bibigo",
      productType: "International",
      price: 2.99,
      priceCents: 299,
      size: weightSize(7.41),
    });

    const result = rankKrogerProducts("White Rice", [cookedRice, dryRice]);

    expect(result.recommended).toMatchObject({
      productId: dryRice.productId,
      title: dryRice.title,
      confidence: "high",
    });
    expect(result.recommended?.reasons).toContain("matches rice product category");
  });

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

  it("keeps non-definitive availability truthful and prevents unknown stock from cart handoff", () => {
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
    expect(unknown).toMatchObject({
      status: "matched",
      resolution: "matched_check_availability",
      recommended: {
        productId: likely.productId,
        availabilityStatus: "unknown",
        cartEligible: false,
      },
    });
    expect(unknown.explanation).toMatch(/check availability/i);
  });

  it.each([
    {
      caseName: "Chickpeas 3 cans",
      request: "Chickpeas 3 cans",
      correctTitle: "Kroger Garbanzo Beans Each",
      wrongTitle: "Kroger Black Beans 15 oz Can",
      productType: "Canned & Packaged",
      size: weightSize(15),
      expectedQuantity: 3,
      expectedResolution: "multi_package_fulfillment" as const,
    },
    {
      caseName: "Diced Tomatoes 8 cans",
      request: "Diced Tomatoes 8 cans",
      correctTitle: "Kroger Petite Diced Tomatoes in Tomato Juice",
      wrongTitle: "Kroger Whole Peeled Tomatoes in Tomato Juice 14.5 oz Can",
      productType: "Canned & Packaged",
      size: weightSize(14.5),
      expectedQuantity: 8,
      expectedResolution: "multi_package_fulfillment" as const,
    },
    {
      caseName: "Kidney Beans 4 cans",
      request: "Kidney Beans 4 cans",
      correctTitle: "Kroger Dark Red Kidney Beans 15.5 oz Can",
      wrongTitle: "Kroger Black Beans 15.5 oz Can",
      productType: "Canned & Packaged",
      size: weightSize(15.5),
      expectedQuantity: 4,
      expectedResolution: "multi_package_fulfillment" as const,
    },
    {
      caseName: "Light Coconut Milk 2 cans",
      request: "Light Coconut Milk 2 cans",
      correctTitle: "Thai Kitchen Lite Coconut Milk 13.66 fl oz Can",
      wrongTitle: "Thai Kitchen Unsweetened Coconut Milk 13.66 fl oz Can",
      productType: "International",
      size: volumeSize(13.66),
      expectedQuantity: 2,
      expectedResolution: "multi_package_fulfillment" as const,
    },
    {
      caseName: "Ground Turkey 93/7 3 lb",
      request: "Ground Turkey 93/7 3 lb",
      correctTitle: "Kroger 93/7 Lean Ground Turkey 1 lb Tray",
      wrongTitle: "Kroger 85/15 Ground Turkey 1 lb Tray",
      productType: "Ground Turkey",
      size: weightSize(1, "lb"),
      expectedQuantity: 3,
      expectedResolution: "multi_package_fulfillment" as const,
    },
    {
      caseName: "Red Lentil Pasta 1.8 lb",
      request: "Red Lentil Pasta 1.8 lb",
      correctTitle: "Barilla Red Lentil Penne Pasta 16 oz",
      wrongTitle: "Barilla Wheat Penne Pasta 16 oz",
      productType: "Pasta",
      size: weightSize(16),
      expectedQuantity: 2,
      expectedResolution: "multi_package_fulfillment" as const,
    },
    {
      caseName: "White Rice with unknown stock",
      request: "White Rice",
      correctTitle: "Kroger Long Grain White Rice 2 lb Bag",
      wrongTitle: "Kroger Long Grain Brown Rice 2 lb Bag",
      productType: "Rice",
      size: weightSize(2, "lb"),
      availabilityStatus: "unknown" as const,
      expectedQuantity: 1,
      expectedResolution: "matched_check_availability" as const,
    },
  ])("recovers the reported false no-match without changing identity: $caseName", ({
    request,
    correctTitle,
    wrongTitle,
    productType,
    size,
    availabilityStatus = "in_stock",
    expectedQuantity,
    expectedResolution,
  }) => {
    const resolvedAvailabilityStatus = availabilityStatus as KrogerProduct["availabilityStatus"];
    const correct = krogerProduct({
      id: "correct-product",
      productId: "correct-product",
      upc: "0001111000001",
      title: correctTitle,
      productType,
      size,
      availabilityStatus: resolvedAvailabilityStatus,
      inStock: resolvedAvailabilityStatus === "in_stock",
    });
    const wrong = krogerProduct({
      id: "wrong-product",
      productId: "wrong-product",
      upc: "0001111000002",
      title: wrongTitle,
      productType,
      size,
    });

    const result = rankKrogerProducts(request, [wrong, correct]);

    expect(rankKrogerProducts(request, [wrong])).toMatchObject({
      status: "no_match",
      resolution: "truly_unavailable",
      recommended: null,
    });
    expect(result).toMatchObject({
      status: "matched",
      resolution: expectedResolution,
      recommended: { id: correct.id },
      fulfillment: {
        cartQuantity: expectedQuantity,
        packageCount: expectedQuantity,
      },
    });
    expect(result.recommended?.id).not.toBe(wrong.id);
    if (resolvedAvailabilityStatus === "unknown") {
      expect(result.recommended?.cartEligible).toBe(false);
    }
  });

  it.each([
    {
      caseName: "chickpeas",
      request: "Chickpeas 3 cans",
      wrongContainerTitle: "Kroger Chickpeas 1 lb Bag",
      wrongContainerType: "Dry Beans",
      wrongContainerSize: weightSize(1, "lb"),
      cannedTitle: "Kroger Chickpeas 15 oz Can",
      cannedType: "Canned & Packaged",
      cannedSize: weightSize(15),
      expectedQuantity: 3,
      expectedLabel: "3 × 15 oz cans",
    },
    {
      caseName: "kidney beans",
      request: "Kidney Beans 4 cans",
      wrongContainerTitle: "Kroger Dark Red Kidney Beans 1 lb Bag",
      wrongContainerType: "Dry Beans",
      wrongContainerSize: weightSize(1, "lb"),
      cannedTitle: "Kroger Dark Red Kidney Beans 15.5 oz Can",
      cannedType: "Canned & Packaged",
      cannedSize: weightSize(15.5),
      expectedQuantity: 4,
      expectedLabel: "4 × 15.5 oz cans",
    },
    {
      caseName: "coconut milk",
      request: "Light Coconut Milk 2 cans",
      wrongContainerTitle: "Thai Kitchen Lite Coconut Milk 32 fl oz Carton",
      wrongContainerType: "Shelf Stable Milk",
      wrongContainerSize: volumeSize(32),
      cannedTitle: "Simple Truth Organic Lite Unsweetened Coconut Milk",
      cannedType: "Natural & Organic",
      cannedSize: volumeSize(13.5),
      expectedQuantity: 2,
      expectedLabel: "2 × 13.5 fl oz cans",
    },
  ])("requires verified canned packaging for $caseName", ({
    request,
    wrongContainerTitle,
    wrongContainerType,
    wrongContainerSize,
    cannedTitle,
    cannedType,
    cannedSize,
    expectedQuantity,
    expectedLabel,
  }) => {
    const wrongContainer = krogerProduct({
      id: "wrong-container",
      productId: "wrong-container",
      upc: "0001111000101",
      title: wrongContainerTitle,
      productType: wrongContainerType,
      size: wrongContainerSize,
    });
    const canned = krogerProduct({
      id: "verified-can",
      productId: "verified-can",
      upc: "0001111000102",
      title: cannedTitle,
      productType: cannedType,
      size: cannedSize,
    });

    expect(rankKrogerProducts(request, [wrongContainer])).toMatchObject({
      status: "no_match",
      resolution: "truly_unavailable",
      recommended: null,
    });
    expect(rankKrogerProducts(request, [wrongContainer, canned])).toMatchObject({
      status: "matched",
      recommended: { id: canned.id },
      fulfillment: {
        cartQuantity: expectedQuantity,
        packageCount: expectedQuantity,
        label: expectedLabel,
      },
    });
  });

  it("accepts Kroger's Each title for cans only when Kroger's category confirms it", () => {
    const eachWithoutCannedCategory = krogerProduct({
      id: "each-dry",
      productId: "each-dry",
      upc: "0001111000201",
      title: "Kroger Garbanzo Beans Each",
      productType: "Dry Beans",
      size: weightSize(15),
    });
    const eachWithCannedCategory = krogerProduct({
      ...eachWithoutCannedCategory,
      id: "each-canned",
      productId: "each-canned",
      upc: "0001111000202",
      productType: "Canned & Packaged",
    });

    expect(rankKrogerProducts("Chickpeas 3 cans", [eachWithoutCannedCategory])).toMatchObject({
      status: "no_match",
      recommended: null,
    });
    expect(rankKrogerProducts("Chickpeas 3 cans", [eachWithCannedCategory])).toMatchObject({
      status: "matched",
      recommended: { id: eachWithCannedCategory.id },
      fulfillment: {
        cartQuantity: 3,
        label: "3 × 15 oz cans",
      },
    });
  });

  it("keeps a requested 24-pack strict but fulfills an explicit 12-pack x2 request", () => {
    const twelvePack = krogerProduct({
      id: "coke-zero-12",
      productId: "coke-zero-12",
      upc: "0004900002890",
      title: "Coca-Cola Zero Sugar Soda Cans 12 fl oz 12 Pack",
      brand: "Coca-Cola",
      productType: "Soda",
      size: countSize(12),
    });

    expect(rankKrogerProducts("Coke Zero 24 pack", [twelvePack])).toMatchObject({
      status: "no_match",
      resolution: "truly_unavailable",
      recommended: null,
    });
    const explicitTwoPack = rankKrogerProducts("Coke Zero 12 pack x2", [twelvePack]);
    expect(explicitTwoPack).toMatchObject({
      status: "matched",
      resolution: "multi_package_fulfillment",
      recommended: { id: twelvePack.id },
      fulfillment: {
        kind: "multi_package",
        cartQuantity: 2,
        packageCount: 2,
      },
    });
  });

  it("chooses two 16-ounce red-lentil boxes over three 12-ounce boxes while never undersupplying", () => {
    const twelveOunce = krogerProduct({
      id: "red-lentil-12",
      productId: "red-lentil-12",
      upc: "0001111000012",
      title: "Red Lentil Penne Pasta 12 oz",
      productType: "Pasta",
      size: weightSize(12),
      price: 2.99,
      priceCents: 299,
    });
    const sixteenOunce = krogerProduct({
      id: "red-lentil-16",
      productId: "red-lentil-16",
      upc: "0001111000016",
      title: "Red Lentil Penne Pasta 16 oz",
      productType: "Pasta",
      size: weightSize(16),
      price: 3.99,
      priceCents: 399,
    });

    expect(rankKrogerProducts("Red Lentil Pasta 1.8 lb", [twelveOunce])).toMatchObject({
      recommended: { id: twelveOunce.id },
      fulfillment: {
        cartQuantity: 3,
        requestedBaseAmount: 28.8,
        suppliedBaseAmount: 36,
      },
    });
    const preferred = rankKrogerProducts(
      "Red Lentil Pasta 1.8 lb",
      [twelveOunce, sixteenOunce],
    );
    expect(preferred).toMatchObject({
      recommended: { id: sixteenOunce.id },
      fulfillment: {
        cartQuantity: 2,
        requestedBaseAmount: 28.8,
        suppliedBaseAmount: 32,
      },
    });
    expect(preferred.fulfillment!.suppliedBaseAmount).toBeGreaterThanOrEqual(
      preferred.fulfillment!.requestedBaseAmount!,
    );
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
