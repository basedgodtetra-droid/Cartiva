import { describe, expect, it } from "vitest";
import { calculateUnitPrice, extractMeasurement } from "@/lib/measurements";

describe("measurement extraction", () => {
  it("extracts weight and converts pounds to ounces", () => {
    expect(extractMeasurement("chicken breast 3 lb")).toMatchObject({
      amount: 3,
      unit: "lb",
      baseAmount: 48,
      kind: "weight",
    });
  });

  it("extracts count quantities", () => {
    expect(extractMeasurement("Large White Eggs, 12 Count")).toMatchObject({
      amount: 12,
      baseUnit: "each",
      kind: "count",
    });
  });

  it("does not multiply an item count by a package's reported total weight", () => {
    expect(extractMeasurement(
      "Marketside Organic Cage Free Large Brown Eggs 12 Count 1.69 lb",
    )).toMatchObject({
      amount: 12,
      baseAmount: 12,
      baseUnit: "each",
      kind: "count",
      packCount: undefined,
    });
  });

  it("treats canned-food ounces as weight, not beverage volume", () => {
    expect(extractMeasurement("Black Beans, 15 oz Can")).toMatchObject({
      baseAmount: 15,
      baseUnit: "oz",
      kind: "weight",
    });
  });

  it("calculates total size for multipacks", () => {
    expect(extractMeasurement("Greek Yogurt, 4 Pack, 5.3 oz Cups")).toMatchObject({
      packCount: 4,
      perPackageAmount: 5.3,
      baseAmount: 21.2,
    });
  });

  it("calculates 144 fluid ounces for a 12-pack of 12-ounce drinks", () => {
    expect(extractMeasurement("Gatorade, 12 pack, 12 oz bottles")).toMatchObject({
      packCount: 12,
      perPackageAmount: 12,
      baseAmount: 144,
      baseUnit: "fl oz",
    });
  });

  it.each([
    ["Pepsi Cola Soda Pop, 2 Liter Bottle", 67.628, "2 L"],
    ["Whole Milk, 1 Gallon", 128, "1 gal"],
    ["Orange Juice, 1 Quart", 32, "1 qt"],
    ["Sparkling Water, 500 mL Bottle", 16.907, "500 mL"],
  ])("normalizes catalog volume units for %s", (title, baseAmount, label) => {
    expect(extractMeasurement(title)).toMatchObject({
      baseAmount,
      baseUnit: "fl oz",
      kind: "volume",
      label,
    });
  });

  it.each([
    ["Fresh Green Whole Asparagus Bunch", "1 bunch"],
    ["Fresh Whole Green Broccoli Crowns, 1 Each", "1 each"],
    ["Fresh Roma Tomato, Each", "1 each"],
    ["Fresh Whole Green Cilantro Bunch, Fresh Produce", "1 bunch"],
  ])("treats fresh produce package units as a verifiable count: %s", (title, label) => {
    expect(extractMeasurement(title)).toMatchObject({
      amount: 1,
      baseAmount: 1,
      baseUnit: "each",
      kind: "count",
      label,
    });
  });

  it("does not reinterpret processed produce or non-produce package words", () => {
    expect(extractMeasurement("Canned Asparagus Spears, Bunch")).toBeUndefined();
    expect(extractMeasurement("Fresh Whole Chicken, Each")).toBeUndefined();
  });
});

describe("unit-price calculations", () => {
  it("calculates price per item", () => {
    expect(calculateUnitPrice(2.48, extractMeasurement("12 count"))).toEqual({
      value: 0.2067,
      label: "$0.21/each",
    });
  });

  it("calculates price per pound", () => {
    expect(calculateUnitPrice(10.44, extractMeasurement("3 lb"))).toEqual({
      value: 3.48,
      label: "$3.48/lb",
    });
  });
});
