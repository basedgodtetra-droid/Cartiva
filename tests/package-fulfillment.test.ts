import { describe, expect, it } from "vitest";

import { packageFulfillmentForProduct } from "@/lib/package-fulfillment";
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

  it("rejects a package combination whose overage is too large instead of choosing it anyway", () => {
    expect(packageFulfillmentForProduct(
      parseProductIntent("Red Lentil Pasta 1.8 lb"),
      { price: 6.99, size: weightSize(3, "lb") },
    )).toBeNull();
  });
});
