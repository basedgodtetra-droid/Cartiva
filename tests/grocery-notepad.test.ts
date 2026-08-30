import { describe, expect, it } from "vitest";
import {
  applyGroceryClarification,
  interpretGroceryInput,
} from "@/lib/grocery-notepad";

describe("Smart Grocery Notepad interpretation", () => {
  it("accepts natural separators and known space-separated product phrases", () => {
    expect(interpretGroceryInput("eggs, milk; white bread\nbananas").items.map((item) => item.raw)).toEqual([
      "eggs",
      "milk",
      "white bread",
      "bananas",
    ]);
    expect(interpretGroceryInput("milk 1 gallon eggs 12 count bananas").items.map((item) => item.raw)).toEqual([
      "milk 1 gallon",
      "eggs 12 count",
      "bananas",
    ]);
  });

  it("keeps count, weight, and pack details with the item on their left", () => {
    expect(interpretGroceryInput("eggs 18 count white bread").items.map((item) => item.raw)).toEqual([
      "eggs 18 count",
      "white bread",
    ]);
    expect(interpretGroceryInput("chicken breast 2 lb coke zero 12 pack bread").items.map((item) => item.raw)).toEqual([
      "chicken breast 2 lb",
      "coke zero 12 pack",
      "bread",
    ]);
  });

  it("parses the requested full example into five clean rows", () => {
    const result = interpretGroceryInput(
      "eggs 18 count white bread milk gallon chicken breast 2lb bananas",
    );

    expect(result.items.map((item) => item.raw)).toEqual([
      "eggs 18 count",
      "white bread",
      "milk gallon",
      "chicken breast 2lb",
      "bananas",
    ]);
    expect(result.serialized).toBe(
      "Eggs, 18 ct\nWhite Bread\nMilk, 1 gallon\nChicken Breast, 2 lb\nBananas",
    );
    expect(result.usedSmartSplit).toBe(true);
    expect(result.unresolvedCount).toBe(1);
  });

  it("asks progressive material questions without repeating supplied details", () => {
    const eggs = interpretGroceryInput("large eggs").items[0];
    expect(eggs.clarification?.id).toBe("egg-count");
    expect(interpretGroceryInput("large eggs 18 count").items[0].clarification).toBeUndefined();

    const milk = interpretGroceryInput("milk").items[0];
    expect(milk.clarification?.id).toBe("milk-type");
    const typedMilk = applyGroceryClarification(milk.raw, "milk-type", "2%");
    expect(interpretGroceryInput(typedMilk).items[0].clarification?.id).toBe("milk-size");
    expect(interpretGroceryInput("2% milk gallon").items[0].clarification).toBeUndefined();

    expect(interpretGroceryInput("coke").items[0].clarification).toBeUndefined();
    expect(interpretGroceryInput("coke zero").items[0].clarification).toBeUndefined();
    expect(interpretGroceryInput("coke zero 12 pack").items[0].clarification).toBeUndefined();
    expect(interpretGroceryInput("yogurt").items[0].clarification?.id).toBe("yogurt-size");
    expect(interpretGroceryInput("chicken breast").items[0].clarification?.id).toBe("chicken-weight");
    expect(interpretGroceryInput("bananas").items[0].clarification).toBeUndefined();
  });

  it("normalizes common count and hyphenated package forms", () => {
    expect(interpretGroceryInput("18-count eggs").items[0]).toMatchObject({
      name: "Eggs",
      detail: "18 ct",
      status: "ready",
    });
    expect(interpretGroceryInput("dozen eggs").items[0]).toMatchObject({ name: "Eggs", detail: "12 ct" });
    expect(interpretGroceryInput("12 eggs").items[0]).toMatchObject({ name: "Eggs", detail: "12 ct" });
    expect(interpretGroceryInput("coke zero 12-pack").items[0].clarification).toBeUndefined();
    expect(interpretGroceryInput("chicken breast 2-lb").items[0].clarification).toBeUndefined();
  });

  it("lets named soda proceed while retaining clarification for generic soda", () => {
    const named = interpretGroceryInput("coke\ncoke zero\nbread");
    expect(named).toMatchObject({ readyCount: 3, unresolvedCount: 0 });
    expect(named.items[0]).toMatchObject({
      raw: "coke",
      name: "Coke",
      canonicalText: "Coke",
      status: "ready",
    });
    expect(named.items[1]).toMatchObject({
      raw: "coke zero",
      name: "Coke Zero",
      canonicalText: "Coke Zero",
      status: "ready",
    });

    const generic = interpretGroceryInput("soda").items[0];
    expect(generic.clarification?.options.map((option) => option.label)).toEqual([
      "Coca-Cola",
      "Diet Coke",
      "Coke Zero",
    ]);
    const original = applyGroceryClarification(generic.raw, "soda-variant", "original");
    expect(interpretGroceryInput(original).items[0].clarification).toBeUndefined();
    expect(interpretGroceryInput("Coke Zero 2 L").items[0].clarification).toBeUndefined();
  });

  it("keeps numeric product identities visible without treating them as cart quantities", () => {
    expect(interpretGroceryInput(
      "7 Up\n3 Musketeers\n5 Hour Energy\n7 grain bread\n4 cheese pizza\n3 bean salad\n5 cheese tortellini\n12 grain bread\n8 O'Clock coffee\n9 Lives cat food",
    ).items).toMatchObject([
      { raw: "7 Up", name: "7 Up", canonicalText: "7 Up", status: "ready" },
      { raw: "3 Musketeers", name: "3 Musketeers", canonicalText: "3 Musketeers", status: "ready" },
      { raw: "5 Hour Energy", name: "5 Hour Energy", canonicalText: "5 Hour Energy", status: "ready" },
      { raw: "7 grain bread", name: "7 Grain Bread", canonicalText: "7 Grain Bread", status: "ready" },
      { raw: "4 cheese pizza", name: "4 Cheese Pizza", canonicalText: "4 Cheese Pizza", status: "ready" },
      { raw: "3 bean salad", name: "3 Bean Salad", canonicalText: "3 Bean Salad", status: "ready" },
      { raw: "5 cheese tortellini", name: "5 Cheese Tortellini", canonicalText: "5 Cheese Tortellini", status: "ready" },
      { raw: "12 grain bread", name: "12 Grain Bread", canonicalText: "12 Grain Bread", status: "ready" },
      { raw: "8 O'Clock coffee", name: "8 O'Clock Coffee", canonicalText: "8 O'Clock Coffee", status: "ready" },
      { raw: "9 Lives cat food", name: "9 Lives Cat Food", canonicalText: "9 Lives Cat Food", status: "ready" },
    ]);
  });

  it("keeps bread weight optional unless the shopper explicitly supplies it", () => {
    expect(interpretGroceryInput("white bread").items[0]).toMatchObject({
      raw: "white bread",
      name: "White Bread",
      canonicalText: "White Bread",
      status: "ready",
    });
    expect(interpretGroceryInput("white bread").items[0].detail).toBeUndefined();

    expect(interpretGroceryInput("white bread 20 oz").items[0]).toMatchObject({
      raw: "white bread 20 oz",
      name: "White Bread",
      detail: "20 oz",
      canonicalText: "White Bread, 20 oz",
      status: "ready",
    });
  });

  it("still asks for a material plant-milk size", () => {
    expect(interpretGroceryInput("oat milk").items[0].clarification?.id).toBe("milk-size");
    expect(interpretGroceryInput("oat milk half gallon").items[0].clarification).toBeUndefined();
  });

  it("allows exactly 24 items and explicitly blocks overflow", () => {
    const twentyFour = Array.from({ length: 24 }, (_, index) => `grocery ${index + 1}`).join("\n");
    const twentyFive = `${twentyFour}\ngrocery 25`;

    expect(interpretGroceryInput(twentyFour)).toMatchObject({
      limitReached: false,
      omittedCount: 0,
    });
    expect(interpretGroceryInput(twentyFive)).toMatchObject({
      limitReached: true,
      omittedCount: 1,
    });
    expect(interpretGroceryInput(twentyFive).items).toHaveLength(24);
  });

  it("can undo an implicit smart split without changing explicit list lines", () => {
    const original = "eggs 18 count white bread";
    expect(interpretGroceryInput(original).items).toHaveLength(2);
    expect(interpretGroceryInput(original, { undoImplicitSplits: true }).items.map((item) => item.raw)).toEqual([
      original,
    ]);

    expect(interpretGroceryInput("eggs\nwhite bread", { undoImplicitSplits: true }).items).toHaveLength(2);
  });
});
