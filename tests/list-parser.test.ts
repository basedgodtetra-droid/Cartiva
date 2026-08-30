import { describe, expect, it } from "vitest";
import { parseShoppingList } from "@/lib/list-parser";

describe("parseShoppingList", () => {
  it("parses the mobile MVP baseline lists without requiring separators", () => {
    expect(parseShoppingList("eggs milk bread bananas")).toEqual([
      "eggs",
      "milk",
      "bread",
      "bananas",
    ]);
    expect(parseShoppingList("eggs 18 count white bread milk gallon")).toEqual([
      "eggs 18 count",
      "white bread",
      "milk gallon",
    ]);
  });

  it("separates adjacent grocery words without punctuation", () => {
    expect(parseShoppingList("eggs bacon")).toEqual(["eggs", "bacon"]);
  });

  it("parses a comma-separated grocery list", () => {
    expect(parseShoppingList("milk, eggs, chicken")).toEqual(["milk", "eggs", "chicken"]);
  });

  it("reattaches package-only comma fragments in Walmart catalog titles", () => {
    expect(parseShoppingList(
      "Great Value Large White Eggs, 12 Count, Great Value Honey Ham Lunchmeat Plastic Tub, 9 oz, 2% milk 1 gallon, oreos",
    )).toEqual([
      "Great Value Large White Eggs, 12 Count",
      "Great Value Honey Ham Lunchmeat Plastic Tub, 9 oz",
      "2% milk 1 gallon",
      "oreos",
    ]);
  });

  it("keeps consecutive package fragments with one catalog product", () => {
    expect(parseShoppingList(
      "Coca-Cola Soda Pop Fridge Pack Cans, 12 fl oz, 12 Pack, bacon",
    )).toEqual([
      "Coca-Cola Soda Pop Fridge Pack Cans, 12 fl oz, 12 Pack",
      "bacon",
    ]);
  });

  it("preserves quantities while splitting natural-language connectors", () => {
    expect(parseShoppingList("2 packs bacon and one dozen eggs")).toEqual([
      "2 packs bacon",
      "one dozen eggs",
    ]);
  });

  it("keeps restrictions attached to their item", () => {
    expect(parseShoppingList("plain Greek yogurt no vanilla")).toEqual([
      "plain Greek yogurt no vanilla",
    ]);
  });

  it("keeps package sizes attached to their item", () => {
    expect(parseShoppingList("chicken breast 3 lb")).toEqual(["chicken breast 3 lb"]);
  });

  it("keeps complete product phrases and left-side package sizes together", () => {
    expect(parseShoppingList("eggs 18 count white bread")).toEqual([
      "eggs 18 count",
      "white bread",
    ]);
    expect(parseShoppingList("chicken breast 2 lb coke zero 12 pack bread")).toEqual([
      "chicken breast 2 lb",
      "coke zero 12 pack",
      "bread",
    ]);
  });

  it("moves leading product attributes to the product on their right", () => {
    expect(parseShoppingList("eggs 12 ct 2% milk 1 gallon")).toEqual([
      "eggs 12 ct",
      "2% milk 1 gallon",
    ]);
    expect(parseShoppingList("eggs diet coke 12 pack")).toEqual([
      "eggs",
      "diet coke 12 pack",
    ]);
    expect(parseShoppingList("eggs half gallon milk")).toEqual([
      "eggs",
      "half gallon milk",
    ]);
    expect(parseShoppingList("eggs 12 pack coke zero")).toEqual([
      "eggs",
      "12 pack coke zero",
    ]);
  });

  it("recognizes a hyphenated Coca-Cola phrase", () => {
    expect(parseShoppingList("coca-cola 12 pack bread")).toEqual([
      "coca-cola 12 pack",
      "bread",
    ]);
  });

  it("parses new lines and commas", () => {
    expect(parseShoppingList("eggs\nplain Greek yogurt 32 oz, broccoli 1 lb")).toEqual([
      "eggs",
      "plain Greek yogurt 32 oz",
      "broccoli 1 lb",
    ]);
  });

  it("parses a simple natural-language list", () => {
    expect(
      parseShoppingList("I need eggs, plain Greek yogurt 32 oz and black beans 15 oz."),
    ).toEqual(["eggs", "plain Greek yogurt 32 oz", "black beans 15 oz"]);
  });

  it("preserves compound foods and useful qualifiers", () => {
    expect(parseShoppingList("mac and cheese, Chobani plain yogurt 32 oz, no vanilla")).toEqual([
      "mac and cheese",
      "Chobani plain yogurt 32 oz, no vanilla",
    ]);
  });
});
