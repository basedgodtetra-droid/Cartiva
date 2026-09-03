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

  it("combines adjacent pounds and ounces into one sellable weight", () => {
    expect(extractMeasurement("Kroger Beef Chuck Roast 1 lb 8 oz Package")).toMatchObject({
      amount: 24,
      unit: "oz",
      baseAmount: 24,
      baseUnit: "oz",
      kind: "weight",
      label: "1 lb 8 oz",
    });
  });

  it.each([
    ["Chicken Breasts 1-1.5 lb Package", 1, 16],
    ["Chicken Breasts 1 to 1.5 lb Package", 1, 16],
    ["Chicken Breasts 1.5-2 lb Package", 1.5, 24],
  ])("uses the guaranteed lower bound for a variable-weight range in %s", (
    title,
    amount,
    baseAmount,
  ) => {
    expect(extractMeasurement(title as string)).toMatchObject({
      amount,
      unit: "lb",
      baseAmount,
      baseUnit: "oz",
    });
  });

  it("extracts count quantities", () => {
    expect(extractMeasurement("Large White Eggs, 12 Count")).toMatchObject({
      amount: 12,
      baseUnit: "each",
      kind: "count",
    });
  });

  it.each([
    ["Fish Oil 1 g Omega 3 100 Count", 100],
    ["Gillette Fusion5 5-Blade Razor Refills, 4 Count", 4],
    ["Mach3 3-Blade Razor Refills, 8 Count", 8],
    ["Bounty Select-A-Size Paper Towels 6 Double Rolls 1 Count", 6],
    ["Charmin Ultra Soft Toilet Paper 12 Rolls 1 Count", 12],
  ])("prefers the explicit sellable count over dosage or model numbers in %s", (title, count) => {
    expect(extractMeasurement(title)).toMatchObject({
      amount: count,
      kind: "count",
      baseAmount: count,
      baseUnit: "each",
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

  it.each([
    "Cleaning Wipes 3 Pack 75 Wipes Each",
    "Cleaning Wipes 75 Wipes Each 3 Pack",
    "Cleaning Wipes 3 × 75 Wipes",
    "Cleaning Wipes 75 Wipes per Canister 3 Count",
    "Cleaning Wipes 3 Count 75 Wipes per Canister",
  ])("calculates the sellable total for count multipacks in %s", (title) => {
    expect(extractMeasurement(title)).toMatchObject({
      amount: 225,
      unit: "count",
      kind: "count",
      baseAmount: 225,
      baseUnit: "each",
      packCount: 3,
      perPackageAmount: 75,
      label: "3 × 75 count",
    });
  });

  it.each([
    "Cleaning Wipes 75 Wipes per Canister Pack of 3",
    "Cleaning Wipes Pack of 3 75 Wipes per Canister",
    "Cleaning Wipes 75 Wipes 3 Canisters",
    "Cleaning Wipes 3 Canisters 75 Wipes Each",
  ])("calculates reverse and named-container count multipacks in %s", (title) => {
    expect(extractMeasurement(title)).toMatchObject({
      amount: 225,
      kind: "count",
      baseAmount: 225,
      packCount: 3,
      perPackageAmount: 75,
    });
  });

  it("ignores a singular blade model inside a multipack and uses the explicit sell count", () => {
    expect(extractMeasurement("Gillette Fusion5 2 Pack 5-Blade Razor Refills 4 Count")).toMatchObject({
      amount: 4,
      kind: "count",
      baseAmount: 4,
      packCount: undefined,
    });
  });

  it.each([
    ["Protein Bars 6 Pack 12 g Protein 1.76 oz Each", 6, 1.76, 10.56, "oz"],
    ["Protein Bars 6 Pack 12 g of Plant Protein 1.76 oz", 6, 1.76, 10.56, "oz"],
    ["Protein Bars 6 Pack 12 g Plant Protein 1.76 oz", 6, 1.76, 10.56, "oz"],
    ["Protein Shakes 4 Pack 30 g High Quality Protein 11 fl oz", 4, 11, 44, "fl oz"],
    ["Quest Protein Bars 4 Pack 5 g Net Carbs 2.12 oz", 4, 2.12, 8.48, "oz"],
    ["Protein Bars 6 Pack 10 g Collagen Peptides 1.76 oz", 6, 1.76, 10.56, "oz"],
    ["Protein Bars 4 Pack 3 g Saturated Fat 2.12 oz", 4, 2.12, 8.48, "oz"],
    ["Protein Bars 4 Pack 5 g Soluble Fiber 2.12 oz", 4, 2.12, 8.48, "oz"],
    ["Protein Bars 4 Pack 5 g Prebiotic Fiber 2.12 oz", 4, 2.12, 8.48, "oz"],
  ])("ignores nutrient claims while finding the sellable multipack size in %s", (
    title,
    packCount,
    perPackageAmount,
    baseAmount,
    baseUnit,
  ) => {
    expect(extractMeasurement(title as string)).toMatchObject({
      packCount,
      perPackageAmount,
      baseAmount,
      baseUnit,
    });
  });

  it("does not multiply nested household capacity by the outer roll count", () => {
    expect(extractMeasurement("Paper Towels 12 Rolls 244 Sheets Per Roll")).toMatchObject({
      kind: "count",
      baseAmount: 12,
      packCount: undefined,
    });
  });

  it.each([
    "Toilet Paper 12-Rolls",
    "Toilet Paper 12 Giant Rolls",
    "Toilet Paper 12 Super Mega Rolls",
    "Paper Towels 12 Select-A-Size Rolls",
  ])("recognizes every strict counted-content form in %s", (title) => {
    expect(extractMeasurement(title)).toMatchObject({
      kind: "count",
      baseAmount: 12,
      baseUnit: "each",
    });
  });

  it.each([
    "Rice 2 pack 500 g",
    "Rice 2-pack 500 g",
    "Rice 2 x 500 g",
    "Rice 2 × 500 g",
    "Rice 500 g 2 pack",
    "Rice 500 g x 2 Bags",
    "Rice 500 g Pack of 2 Bags",
  ])("keeps both metric packages in the requested total for %s", (request) => {
    expect(extractMeasurement(request)).toMatchObject({
      packCount: 2,
      perPackageAmount: 17.637,
      baseAmount: 35.274,
      baseUnit: "oz",
      label: "2 × 500 g",
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
    ["Cat Food 12 Pouches 3 oz Each", 12, 3, 36, "oz"],
    ["Greek Yogurt 4 Tubs 5.3 oz Each", 4, 5.3, 21.2, "oz"],
    ["Apple Juice 8 Cartons 6.75 fl oz Each", 8, 6.75, 54, "fl oz"],
    ["Long Grain Rice 2 Bags 500 g Each", 2, 17.637, 35.274, "oz"],
    ["Cola Soda 12 Count 12 fl oz Cans", 12, 12, 144, "fl oz"],
    ["Water Case of 12 16.9 fl oz Bottles", 12, 16.9, 202.8, "fl oz"],
    ["Fancy Feast Variety Pack (24) 3 oz Cans", 24, 3, 72, "oz"],
  ])("calculates count-first physical multipacks for %s", (
    title,
    packCount,
    perPackageAmount,
    baseAmount,
    baseUnit,
  ) => {
    expect(extractMeasurement(title as string)).toMatchObject({
      packCount,
      perPackageAmount,
      baseAmount,
      baseUnit,
    });
  });

  it.each([
    ["Pepsi Cola Soda Pop, 2 Liter Bottle", 67.628, "2 L"],
    ["Whole Milk, 1 Gallon", 128, "1 gal"],
    ["Orange Juice, 1 Quart", 32, "1 qt"],
    ["Heavy Cream, 1 Pint", 16, "1 pt"],
    ["Heavy Cream, 2 pt", 32, "2 pt"],
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
    ["Chicken Breast 500 g", 17.637, "500 g"],
    ["Rice 1 kg", 35.274, "1 kg"],
    ["Whey Protein Powder 500 g", 17.637, "500 g"],
    ["Plant Protein Powder 250 g", 8.8185, "250 g"],
  ])("normalizes metric catalog weights for %s", (title, baseAmount, label) => {
    expect(extractMeasurement(title)).toMatchObject({
      baseAmount,
      baseUnit: "oz",
      kind: "weight",
      label,
    });
  });

  it.each([
    "Whey Protein Powder 25 g Protein per Serving",
    "Whey Protein Powder 25 g per serving",
    "Whey Protein Powder 25 g/serving",
    "Creatine Powder 5 g per scoop",
    "Supplement Powder 10 g per dose",
    "BCAA Powder 5 g BCAAs",
  ])("never treats a nutrition amount as package weight: %s", (title) => {
    expect(extractMeasurement(title)).toBeUndefined();
  });

  it("skips an early per-serving amount and uses the later sellable size", () => {
    expect(extractMeasurement("Whey Protein Powder 25 g per serving 2 lb tub")).toMatchObject({
      amount: 2,
      unit: "lb",
      baseAmount: 32,
      baseUnit: "oz",
    });
    expect(extractMeasurement("Whey Protein Powder 25 g/serving 2 lb tub")).toMatchObject({
      amount: 2,
      unit: "lb",
      baseAmount: 32,
    });
    expect(extractMeasurement("BCAA Powder 5 g BCAAs 12 oz Tub")).toMatchObject({
      amount: 12,
      unit: "oz",
      baseAmount: 12,
    });
    expect(extractMeasurement("Creatine Monohydrate Powder 5 g 120 Servings 600 g Tub")).toMatchObject({
      amount: 21.1644,
      baseAmount: 21.1644,
      baseUnit: "oz",
    });
    expect(extractMeasurement("Glutamine Powder 5 g Glutamine 500 g Tub")).toMatchObject({
      amount: 17.637,
      baseAmount: 17.637,
      baseUnit: "oz",
    });
    expect(extractMeasurement("Protein Powder Serving Size 30 g Net Wt 600 g")).toMatchObject({
      amount: 21.1644,
      baseAmount: 21.1644,
      baseUnit: "oz",
    });
    expect(extractMeasurement("Orange Juice Serving Size 8 fl oz Net Contents 64 fl oz")).toMatchObject({
      amount: 64,
      baseAmount: 64,
      baseUnit: "fl oz",
    });
  });

  it("prefers a later container-adjacent package size over an early nutrition claim", () => {
    expect(extractMeasurement("KIND Healthy Grains Granola 10 g Whole Grains 11 oz Bag")).toMatchObject({
      amount: 11,
      unit: "oz",
      baseAmount: 11,
      baseUnit: "oz",
    });
    expect(extractMeasurement("Orange Juice 8 fl oz per serving 64 fl oz Bottle")).toMatchObject({
      amount: 64,
      unit: "fl oz",
      baseAmount: 64,
    });
    expect(extractMeasurement("Milk 8 fl oz serving 1 gal Jug")).toMatchObject({
      amount: 128,
      unit: "fl oz",
      baseAmount: 128,
    });
  });

  it.each([
    ["Wild Caught Salmon 4 oz Fillets 1 lb Bag", 1, "lb", 16],
    ["Ground Beef 4 oz Patties 1 lb Package", 1, "lb", 16],
    ["Chicken Burgers 4 oz Patties 2 lb Bag", 2, "lb", 32],
  ])("uses the outer sellable weight instead of a per-piece weight in %s", (
    title,
    amount,
    unit,
    baseAmount,
  ) => {
    expect(extractMeasurement(title as string)).toMatchObject({
      amount,
      unit,
      baseAmount,
      baseUnit: "oz",
    });
  });

  it.each([
    ["ground beef 1/2 lb", 0.5, 8],
    ["ground beef ½ lb", 0.5, 8],
    ["cheese 3/4 lb total", 0.75, 12],
    ["turkey 1 1/2 lb", 1.5, 24],
    ["turkey 1½ lb", 1.5, 24],
    ["turkey 1-1/2 lb", 1.5, 24],
    ["ground beef 1 / 2 lb", 0.5, 8],
    ["ground beef .5 lb", 0.5, 8],
    ["ground beef ⅛ lb", 0.125, 2],
    ["ground beef 1 ⅛ lb", 1.125, 18],
  ])("parses common fractional measurements safely in %s", (request, amount, baseAmount) => {
    expect(extractMeasurement(request as string)).toMatchObject({
      amount,
      unit: "lb",
      baseAmount,
      baseUnit: "oz",
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
