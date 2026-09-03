import { describe, expect, it } from "vitest";

import {
  packageFulfillmentForProduct,
  retailerContainerCompatible,
  retailerContainerEvidence,
  retailerCountUnitEvidence,
} from "@/lib/package-fulfillment";
import { extractMeasurement } from "@/lib/measurements";
import { parseProductIntent } from "@/lib/product-search-intent";
import type { Measurement } from "@/lib/types";

function weightSize(amount: number, unit: "oz" | "lb" = "oz"): Measurement {
  const baseAmount = unit === "lb" ? amount * 16 : amount;
  return {
    amount,
    unit,
    kind: "weight",
    baseAmount,
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

describe("retailer package fulfillment", () => {
  it("treats the container adjacent to a measured count as the sell unit", () => {
    expect(retailerContainerEvidence({
      title: "Hefty Strong Large Trash Bags 30 Count Box",
      productType: "Trash Bags",
      size: {
        amount: 30,
        unit: "count",
        kind: "count",
        baseAmount: 30,
        baseUnit: "each",
        label: "30 count",
      },
    })).toEqual([
      { container: "box", source: "retailer_title" },
    ]);
  });

  it("prefers a measured pouch over canned wording and a canned category", () => {
    expect(retailerContainerEvidence({
      title: "Chicken of the Sea Canned Tuna in Water 5 oz Pouch",
      productType: "Canned Seafood",
      size: weightSize(5),
    })).toEqual([
      { container: "pouch", source: "retailer_title" },
    ]);

    expect(packageFulfillmentForProduct(
      parseProductIntent("canned tuna 5 oz can"),
      {
        price: 1.49,
        title: "Chicken of the Sea Canned Tuna in Water 5 oz Pouch",
        productType: "Canned Seafood",
        size: weightSize(5),
      },
    )).toBeNull();
  });

  it.each([
    "Angel Soft Toilet Paper 12 Rolls 320 Sheets Per Roll",
    "Charmin Ultra Soft Toilet Paper 12 Mega Rolls 244 Sheets Per Roll",
  ])("uses the outer roll count rather than inner sheet capacity: %s", (title) => {
    expect(retailerCountUnitEvidence({
      title,
      productType: "Toilet Paper",
      size: {
        amount: 12,
        unit: "count",
        kind: "count",
        baseAmount: 12,
        baseUnit: "each",
        label: "12 count",
      },
    })).toEqual([
      { countUnit: "roll", source: "retailer_title" },
    ]);
  });

  it("binds nested household capacity to the requested count unit", () => {
    const title = "Charmin Ultra Soft Toilet Paper 12 Count 244 Sheets Per Roll";
    const product = {
      price: 14.99,
      title,
      productType: "Toilet Paper",
      size: extractMeasurement(title),
    };

    expect(packageFulfillmentForProduct(
      parseProductIntent("toilet paper 12 rolls total"),
      product,
    )).toMatchObject({
      cartQuantity: 1,
      requestedBaseAmount: 12,
      suppliedBaseAmount: 12,
      approvalRequired: false,
    });
    expect(packageFulfillmentForProduct(
      parseProductIntent("toilet paper 2928 sheets total"),
      product,
    )).toMatchObject({
      cartQuantity: 1,
      requestedBaseAmount: 2928,
      suppliedBaseAmount: 2928,
      approvalRequired: false,
    });
  });

  it.each([
    "toilet paper desired total 12 rolls",
    "toilet paper a total of 12 rolls",
    "toilet paper totaling 12 rolls",
  ])("does not turn a prefixed roll total into repeated cart lines: %s", (request) => {
    const intent = parseProductIntent(request);
    expect(intent).toMatchObject({
      requestedCartQuantity: 1,
      requestedCountUnit: "roll",
      requestedTotal: { kind: "count", baseAmount: 12 },
    });
    expect(packageFulfillmentForProduct(intent, {
      price: 12.99,
      title: "Angel Soft Toilet Paper 12 Rolls",
      productType: "Toilet Paper",
      size: extractMeasurement("Angel Soft Toilet Paper 12 Rolls"),
    })).toMatchObject({ cartQuantity: 1, suppliedBaseAmount: 12 });
  });

  it("multiplies a verified per-container wipe capacity only on the wipe axis", () => {
    const title = "Clorox Disinfecting Wipes 75 Wipes per Canister 3 Count";
    expect(packageFulfillmentForProduct(
      parseProductIntent("disinfecting wipes 225 wipes total"),
      {
        price: 12.99,
        title,
        productType: "Disinfecting Wipes",
        size: extractMeasurement(title),
      },
    )).toMatchObject({
      cartQuantity: 1,
      requestedBaseAmount: 225,
      suppliedBaseAmount: 225,
      approvalRequired: false,
    });
  });

  it.each([
    "Clorox Disinfecting Wipes 3 ct. Canisters",
    "Clorox Disinfecting Wipes 3 ct (Canisters)",
    "Clorox Disinfecting Wipes Canisters (3 Count)",
    "Clorox Disinfecting Wipes Canisters, 3 ct.",
    "Clorox Disinfecting Wipes 3 Count Fresh Scent Canisters",
    "Clorox Disinfecting Wipes Canisters Value Pack 3 Count",
    "Clorox Disinfecting Wipes 3 Count of Canisters",
  ])("does not mistake a punctuated outer canister count for wipe capacity: %s", (title) => {
    expect(packageFulfillmentForProduct(
      parseProductIntent("disinfecting wipes 225 wipes total"),
      {
        price: 12.99,
        title,
        productType: "Disinfecting Wipes",
        size: {
          amount: 3,
          unit: "count",
          kind: "count",
          baseAmount: 3,
          baseUnit: "each",
          label: "3 count",
        },
      },
    )).toBeNull();
  });

  it.each([
    "disinfecting wipes 225 count total",
    "disinfecting wipes 225 ct total",
  ])("does not guess the axis of a generic count aggregate: %s", (request) => {
    expect(packageFulfillmentForProduct(
      parseProductIntent(request),
      {
        price: 12.99,
        title: "Clorox Disinfecting Wipes 3 Count Canisters",
        productType: "Disinfecting Wipes",
        size: extractMeasurement("Clorox Disinfecting Wipes 3 Count Canisters"),
      },
    )).toBeNull();
  });

  it.each([
    "wipes 3 canisters total",
    "wipes 3 containers total",
  ])("keeps requested outer-container identity for %s", (request) => {
    const intent = parseProductIntent(request);
    expect(intent.requestedContainer).toMatch(/^(?:canister|container)$/);
    expect(packageFulfillmentForProduct(intent, {
      price: 9.99,
      title: "Cleaning Wipes 3 Count Boxes",
      productType: "Cleaning Wipes",
      size: extractMeasurement("Cleaning Wipes 3 Count Boxes"),
    })).toBeNull();
  });

  it.each([
    "Gillette Fusion5 5 Blade Razor 1 Count",
    "Gillette Fusion5 5-Blade Razor 1 Count",
    "Gillette Fusion5 5–Blade Razor 1 Count",
  ])("does not turn a singular razor descriptor into blade capacity: %s", (title) => {
    expect(packageFulfillmentForProduct(
      parseProductIntent("razor blades 5 blades total"),
      {
        price: 14.99,
        title,
        productType: "Razors",
        size: extractMeasurement(title),
      },
    )).toBeNull();
  });

  it.each([
    "Candy 5 Pieces per Serving 10 Servings per Container",
    "Candy 5 Pieces/Serving 10 Servings per Container",
  ])("does not use a per-serving piece count as sellable capacity: %s", (title) => {
    expect(packageFulfillmentForProduct(
      parseProductIntent("candy 50 pieces total"),
      {
        price: 4.99,
        title,
        productType: "Candy Pieces",
        size: extractMeasurement(title),
      },
    )).toBeNull();
  });

  it("uses a proven outer pack count with an inner sheet capacity", () => {
    const title = "Pocket Tissues 10 Sheets per Pack 10 Packs";
    expect(packageFulfillmentForProduct(
      parseProductIntent("pocket tissues 100 sheets total"),
      { price: 6.99, title, productType: "Pocket Tissues", size: extractMeasurement(title) },
    )).toMatchObject({
      cartQuantity: 1,
      requestedBaseAmount: 100,
      suppliedBaseAmount: 100,
      approvalRequired: false,
    });
  });

  it("keeps an unscoped bottle conflict when measured evidence only says each", () => {
    const intent = parseProductIntent("orange juice 6 pack 10 fl oz cartons");
    const bottledSixPack = {
      price: 4.99,
      title: "Kroger Orange Juice 6 Bottles 10 fl oz Each",
      productType: "Orange Juice",
      size: {
        amount: 60,
        unit: "fl oz" as const,
        kind: "volume" as const,
        baseAmount: 60,
        baseUnit: "fl oz" as const,
        packCount: 6,
        perPackageAmount: 10,
        label: "6 × 10 fl oz",
      },
    };

    expect(retailerContainerEvidence(bottledSixPack)).toEqual([
      { container: "bottle", source: "retailer_title" },
      { container: "each", source: "retailer_title" },
    ]);
    expect(intent.requestedContainer).toBe("carton");
    expect(retailerContainerCompatible(intent, bottledSixPack)).toBe(false);
  });

  it("fulfills a counted blade total from smaller blade packs but rejects another unit", () => {
    const intent = parseProductIntent("razor refill 12 blades total");
    const bladePack = {
      price: 14.99,
      title: "Razor Blade Refills 6 Count Box",
      productType: "Razor Blades",
      size: {
        amount: 6,
        unit: "count" as const,
        kind: "count" as const,
        baseAmount: 6,
        baseUnit: "each" as const,
        label: "6 count",
      },
    };

    expect(intent).toMatchObject({
      fulfillmentText: "razor refill",
      requestedCountUnit: "blade",
      requestedTotal: { kind: "count", baseAmount: 12 },
    });
    expect(packageFulfillmentForProduct(intent, bladePack)).toMatchObject({
      kind: "multi_package",
      cartQuantity: 2,
      packageCount: 2,
      requestedBaseAmount: 12,
      suppliedBaseAmount: 12,
    });
    expect(packageFulfillmentForProduct(intent, {
      ...bladePack,
      title: "Razor Refill Wipes 6 Count",
      productType: "Razor Wipes",
    })).toBeNull();
  });

  it("fulfills a pod total from boxed pod packs on the independent count-unit axis", () => {
    const intent = parseProductIntent("coffee pods 24 pods total");
    const podPack = {
      price: 8.99,
      title: "K-Cup Coffee Pods 12 Count Box",
      productType: "Coffee Pods",
      size: {
        amount: 12,
        unit: "count" as const,
        kind: "count" as const,
        baseAmount: 12,
        baseUnit: "each" as const,
        label: "12 count",
      },
    };

    expect(intent).toMatchObject({
      fulfillmentText: "coffee pods",
      requestedContainer: undefined,
      requestedCountUnit: "pod",
      requestedTotal: { kind: "count", baseAmount: 24 },
    });
    expect(retailerContainerEvidence(podPack)).toContainEqual({
      container: "box",
      source: "retailer_title",
    });
    expect(packageFulfillmentForProduct(intent, podPack)).toMatchObject({
      kind: "multi_package",
      cartQuantity: 2,
      packageCount: 2,
      requestedBaseAmount: 24,
      suppliedBaseAmount: 24,
    });
  });

  it("refuses a count total when one outer UPC has no numeric content capacity", () => {
    expect(packageFulfillmentForProduct(
      parseProductIntent("coffee pods 24 pods total"),
      {
        price: 8.99,
        title: "K-Cup Coffee Pods Variety Box",
        productType: "Coffee Pods",
        size: {
          amount: 1,
          unit: "count",
          kind: "count",
          baseAmount: 1,
          baseUnit: "each",
          label: "1 count",
        },
      },
    )).toBeNull();
  });

  it.each([
    ["3 bottles water", "Kroger Purified Water 24 Count Bottles", "Beverages", 24],
    ["3 bags potato chips", "Potato Chips 10 Count Bags", "Snacks", 10],
    ["2 boxes granola bars", "Granola Bars 6 Count Boxes", "Granola Bars", 6],
    ["4 pouches cat food", "Cat Food 12 Count Pouches", "Cat Food", 12],
    ["3 bottles water", "Kroger Purified Water 24 Count Bottle", "Beverages", 24],
    ["3 cans soda", "Cola 12 Count Can", "Soda", 12],
    ["3 pouches cat food", "Cat Food 12 Count Pouch", "Cat Food", 12],
    ["2 tubs hummus", "Classic Hummus Snack Tubs 4 Count", "Hummus", 4],
  ])("does not repeat a multipack when individual %s are requested", (
    request,
    title,
    productType,
    count,
  ) => {
    expect(packageFulfillmentForProduct(
      parseProductIntent(request),
      {
        price: 8.99,
        title,
        productType,
        size: {
          amount: count,
          unit: "count",
          kind: "count",
          baseAmount: count,
          baseUnit: "each",
          label: `${count} count`,
        },
      },
    )).toBeNull();
  });

  it.each([
    ["Chickpeas 3 cans", "Kroger Garbanzo Beans Each", "Canned & Packaged", weightSize(15), 3, "3 × 15 oz cans"],
    ["Diced Tomatoes 8 cans", "Kroger Petite Diced Tomatoes", "Canned & Packaged", weightSize(14.5), 8, "8 × 14.5 oz cans"],
    ["Kidney Beans 4 cans", "Kroger Dark Red Kidney Beans 15.5 oz Can", "Canned & Packaged", weightSize(15.5), 4, "4 × 15.5 oz cans"],
    ["Light Coconut Milk 2 cans", "Thai Kitchen Lite Coconut Milk 13.66 fl oz Can", "International", volumeSize(13.66), 2, "2 × 13.66 fl oz cans"],
  ])("uses the shopper's container total as cart quantity: %s", (
    request,
    title,
    productType,
    size,
    expectedQuantity,
    label,
  ) => {
    const fulfillment = packageFulfillmentForProduct(
      parseProductIntent(request),
      { price: 1.49, title, productType, size },
    );

    expect(fulfillment).toMatchObject({
      kind: "multi_package",
      cartQuantity: expectedQuantity,
      packageCount: expectedQuantity,
      label,
      approvalRequired: false,
    });
  });

  it("does not relabel a dry bag as requested cans", () => {
    const fulfillment = packageFulfillmentForProduct(
      parseProductIntent("Chickpeas 3 cans"),
      {
        price: 2.49,
        title: "Kroger Dry Chickpeas 1 lb Bag",
        productType: "Dry Beans",
        size: weightSize(1, "lb"),
      },
    );

    expect(fulfillment).toBeNull();
  });

  it("fulfills three pounds of ground turkey with three one-pound packages", () => {
    const fulfillment = packageFulfillmentForProduct(
      parseProductIntent("Ground Turkey 93/7 3 lb"),
      { price: 5.49, size: weightSize(1, "lb") },
    );

    expect(fulfillment).toMatchObject({
      kind: "multi_package",
      cartQuantity: 3,
      packageCount: 3,
      requestedBaseAmount: 48,
      suppliedBaseAmount: 48,
      baseUnit: "oz",
      overageBaseAmount: 0,
      overagePercent: 0,
      approvalRequired: false,
    });
  });

  it.each([
    ["Chicken Breasts 1-1.5 lb Package", 3],
    ["Chicken Breasts 1 to 1.5 lb Package", 3],
    ["Chicken Breasts 1.5-2 lb Package", 2],
  ])("never treats a variable-weight upper bound as guaranteed: %s", (title, cartQuantity) => {
    expect(packageFulfillmentForProduct(
      parseProductIntent("chicken breasts 3 lb total"),
      { price: 7.99, title, productType: "Chicken Breasts", size: extractMeasurement(title) },
    )).toMatchObject({
      cartQuantity,
      requestedBaseAmount: 48,
      suppliedBaseAmount: 48,
      approvalRequired: false,
    });
  });

  it("uses enough 1.25-pound packages without silently undersupplying meat", () => {
    const fulfillment = packageFulfillmentForProduct(
      parseProductIntent("Ground Turkey 93/7 3 lb"),
      { price: 5.49, size: weightSize(1.25, "lb") },
    );

    expect(fulfillment).toMatchObject({
      kind: "multi_package",
      cartQuantity: 3,
      requestedBaseAmount: 48,
      suppliedBaseAmount: 60,
      overagePercent: 25,
    });
  });

  it("accepts a truthful nearby variable-weight meat package", () => {
    const fulfillment = packageFulfillmentForProduct(
      parseProductIntent("Chicken breast 2 lb"),
      { price: 9.99, size: weightSize(2.18, "lb") },
    );

    expect(fulfillment).toMatchObject({
      kind: "variable_weight",
      cartQuantity: 1,
      requestedBaseAmount: 32,
      suppliedBaseAmount: 34.88,
      overagePercent: 9,
    });
    expect(fulfillment?.label).toMatch(/^Approx\./);
  });

  it.each([
    [12, 3, 36, 7.2, 25],
    [16, 2, 32, 3.2, 11.1],
  ])("never undersupplies 1.8 lb of red-lentil pasta from %s oz packages", (
    packageOunces,
    expectedQuantity,
    suppliedBaseAmount,
    overageBaseAmount,
    overagePercent,
  ) => {
    const fulfillment = packageFulfillmentForProduct(
      parseProductIntent("Red Lentil Pasta 1.8 lb"),
      { price: 3.49, size: weightSize(packageOunces) },
    );

    expect(fulfillment).toMatchObject({
      kind: "multi_package",
      cartQuantity: expectedQuantity,
      packageCount: expectedQuantity,
      requestedBaseAmount: 28.8,
      suppliedBaseAmount,
      overagePercent,
      approvalRequired: false,
    });
    expect(fulfillment!.overageBaseAmount).toBeCloseTo(overageBaseAmount, 6);
    expect(fulfillment!.suppliedBaseAmount).toBeGreaterThanOrEqual(
      fulfillment!.requestedBaseAmount!,
    );
  });

  it("multiplies a physical-total solution by an explicit list quantity", () => {
    const fulfillment = packageFulfillmentForProduct(
      parseProductIntent("Ground Turkey 93/7 3 lb"),
      { price: 5.49, size: weightSize(1, "lb") },
      2,
    );

    expect(fulfillment).toMatchObject({
      cartQuantity: 6,
      packageCount: 6,
      requestedBaseAmount: 96,
      suppliedBaseAmount: 96,
    });
  });

  it("fulfills a metric recipe total without losing or undersupplying the amount", () => {
    const intent = parseProductIntent("Chicken Breast 500 g total");
    const fulfillment = packageFulfillmentForProduct(
      intent,
      { price: 4.49, size: weightSize(8.82) },
    );

    expect(intent).toMatchObject({
      requestedTotal: { baseAmount: 17.637, baseUnit: "oz" },
      strictPackageRequest: false,
    });
    expect(fulfillment).toMatchObject({
      kind: "multi_package",
      cartQuantity: 2,
      requestedBaseAmount: 17.637,
      suppliedBaseAmount: 17.64,
    });
    expect(fulfillment!.suppliedBaseAmount).toBeGreaterThanOrEqual(
      fulfillment!.requestedBaseAmount!,
    );
  });

  it("rejects a package combination whose overage is too large instead of choosing it anyway", () => {
    expect(packageFulfillmentForProduct(
      parseProductIntent("Red Lentil Pasta 1.8 lb"),
      { price: 6.99, size: weightSize(3, "lb") },
    )).toBeNull();
  });
});
