import { describe, expect, it } from "vitest";
import { extractExplicitRequestDetails, parseShoppingList } from "../src/parser";

describe("extension shopping-list parser", () => {
  it("parses multiline lists", () => {
    expect(parseShoppingList("eggs\nbacon\nmilk").map((item) => item.text)).toEqual([
      "eggs",
      "bacon",
      "milk",
    ]);
  });

  it("parses comma-separated and simple natural lists", () => {
    expect(parseShoppingList("milk, eggs and chicken").map((item) => item.normalizedText)).toEqual([
      "milk",
      "eggs",
      "chicken",
    ]);
  });

  it("deduplicates repeated items and combines cart quantities", () => {
    const parsed = parseShoppingList("eggs, eggs\n2x eggs");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].quantity).toBe(4);
  });

  it("preserves named brands and extracts explicit package requirements", () => {
    const parsed = parseShoppingList("Coke Zero 24 pack 12 oz, Takis");
    expect(parsed[0]).toMatchObject({
      text: "Coke Zero 24 pack 12 oz",
      brand: "Coca-Cola",
      packCount: 24,
      size: "12 oz",
    });
    expect(parsed[1]).toMatchObject({ text: "Takis", brand: "Takis" });
  });

  it("leaves generic items unbranded so the backend may choose a store brand", () => {
    expect(extractExplicitRequestDetails("bread").brand).toBeUndefined();
  });

  it("keeps protected compound foods together", () => {
    expect(parseShoppingList("mac and cheese, eggs").map((item) => item.text)).toEqual([
      "mac and cheese",
      "eggs",
    ]);
  });

  it("splits adjacent grocery anchors without typed separators", () => {
    expect(parseShoppingList("eggs bacon").map((item) => item.text)).toEqual(["eggs", "bacon"]);
  });

  it("splits adjacent produce items using the expanded vegetable vocabulary", () => {
    expect(parseShoppingList(
      "broccoli asparagus tomatoes bell peppers cucumber zucchini squash cauliflower celery",
    ).map((item) => item.text)).toEqual([
      "broccoli",
      "asparagus",
      "tomatoes",
      "bell peppers",
      "cucumber",
      "zucchini",
      "squash",
      "cauliflower",
      "celery",
    ]);
  });

  it("keeps typed produce state with the item it describes", () => {
    expect(parseShoppingList("fresh asparagus frozen broccoli").map((item) => item.text)).toEqual([
      "fresh asparagus",
      "frozen broccoli",
    ]);
  });

  it("handles package quantities and a dozen as a package requirement", () => {
    const parsed = parseShoppingList("2 packs bacon and one dozen eggs");
    expect(parsed[0]).toMatchObject({ text: "bacon", quantity: 2 });
    expect(parsed[1]).toMatchObject({ text: "one dozen eggs", quantity: 1, packCount: 12 });
  });

  it("attaches a quantity/package prefix to the following adjacent item", () => {
    const parsed = parseShoppingList("eggs 2 packs bacon");
    expect(parsed.map((item) => ({ text: item.text, quantity: item.quantity }))).toEqual([
      { text: "eggs", quantity: 1 },
      { text: "bacon", quantity: 2 },
    ]);
  });

  it("keeps Walmart title package commas attached to their products", () => {
    const parsed = parseShoppingList(
      "Great Value Large White Eggs, 12 Count, Great Value Honey Ham Lunchmeat Plastic Tub, 9 oz, 2% milk 1 gallon, oreos",
    );

    expect(parsed.map((item) => item.text)).toEqual([
      "Great Value Large White Eggs, 12 Count",
      "Great Value Honey Ham Lunchmeat Plastic Tub, 9 oz",
      "2% milk 1 gallon",
      "oreos",
    ]);
    expect(parsed.map((item) => item.quantity)).toEqual([1, 1, 1, 1]);
  });

  it("keeps consecutive size and pack fragments on one soda title", () => {
    expect(parseShoppingList(
      "Coca-Cola Soda Pop Fridge Pack Cans, 12 fl oz, 12 Pack, bacon",
    ).map((item) => item.text)).toEqual([
      "Coca-Cola Soda Pop Fridge Pack Cans, 12 fl oz, 12 Pack",
      "bacon",
    ]);
  });
});
