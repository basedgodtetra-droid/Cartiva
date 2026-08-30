import { describe, expect, it } from "vitest";
import {
  activeListFragment,
  canLookupWalmartSuggestions,
  conciseSuggestionMetadata,
  grocerySuggestionQuery,
  grocerySuggestionTextUpdate,
  grocerySuggestions,
  prioritizeWalmartSuggestions,
  replaceListFragment,
  WALMART_PRODUCT_LOOKUP_DEBOUNCE_MS,
  walmartProductSuggestions,
} from "../src/grocery-autocomplete";

describe("local grocery autocomplete", () => {
  it("starts exact Walmart product lookup after a short typing pause", () => {
    expect(WALMART_PRODUCT_LOOKUP_DEBOUNCE_MS).toBeGreaterThanOrEqual(250);
    expect(WALMART_PRODUCT_LOOKUP_DEBOUNCE_MS).toBeLessThanOrEqual(350);
  });

  it("suggests useful tuna options before submission", () => {
    expect(grocerySuggestions("tuna").map((item) => item.value)).toEqual([
      "tuna in water",
      "tuna in oil",
      "tuna pouches",
      "albacore tuna",
    ]);
  });

  it("supports partial category and brand searches", () => {
    expect(grocerySuggestions("tun")[0].value).toBe("tuna in water");
    expect(grocerySuggestions("coke").map((item) => item.value)).toEqual([
      "Coca-Cola 12 pack cans",
      "Coca-Cola 24 pack cans",
      "Coca-Cola 2 liter bottle",
    ]);
  });

  it("does not use arbitrary descriptor words as product intent", () => {
    const cheese = grocerySuggestions("cheese");
    const water = grocerySuggestions("water");

    expect(cheese.map((item) => item.value)).toEqual([
      "American cheese slices",
      "Swiss cheese slices",
      "cheddar cheese block",
      "shredded mozzarella cheese",
      "string cheese",
    ]);
    expect(cheese.some((item) => /doritos/i.test(item.value))).toBe(false);
    expect(water.some((item) => /tuna/i.test(item.value))).toBe(false);
    expect(water.some((item) => /bubly/i.test(item.value))).toBe(false);
    expect(water.every((item) => /water/i.test(item.category) || /water/i.test(item.value))).toBe(true);
  });

  it("keeps useful category choices visible when they are not brand substitutions", () => {
    expect(grocerySuggestions("yogurt").map((item) => item.value)).toEqual([
      "plain Greek yogurt 32 oz",
      "vanilla Greek yogurt",
      "strawberry yogurt cups",
    ]);
  });

  it("refines broad produce language locally before a Walmart lookup", () => {
    expect(grocerySuggestions("produce").map((item) => item.value)).toEqual([
      "Fruit",
      "Vegetables",
      "Salad greens",
      "Fresh herbs",
    ]);
    expect(grocerySuggestions("produce").every((item) => item.kind === "category")).toBe(true);

    const vegetables = grocerySuggestions("vegetables", 8).map((item) => item.value);
    expect(vegetables).toEqual([
      "broccoli",
      "asparagus",
      "tomatoes",
      "carrots",
      "spinach",
      "onions",
      "bell peppers",
      "cucumber",
    ]);
    expect(vegetables.every((value) => !/\b\d+(?:\.\d+)?\b/.test(value))).toBe(true);
  });

  it("prioritizes concrete produce choices without inventing a package size", () => {
    expect(grocerySuggestions("broccoli")[0].value).toBe("broccoli");
    expect(grocerySuggestions("asparagus")[0].value).toBe("asparagus");
    expect(grocerySuggestions("tomatoes")[0].value).toBe("tomatoes");
    expect(grocerySuggestions("bell peppers")[0].value).toBe("bell peppers");
    expect(grocerySuggestions("cucumber")[0].value).toBe("cucumber");
    expect(grocerySuggestions("zucchini")[0].value).toBe("zucchini");
    expect(grocerySuggestions("cauliflower")[0].value).toBe("cauliflower");
  });

  it("continues broad produce refinements into useful neutral choices", () => {
    expect(grocerySuggestions("fruit").map((item) => item.value)).toEqual([
      "bananas",
      "apples",
      "oranges",
    ]);
    expect(grocerySuggestions("salad greens").map((item) => item.value)).toEqual([
      "spinach",
      "lettuce",
      "spring mix",
    ]);
    expect(grocerySuggestions("fresh herbs").map((item) => item.value)).toEqual([
      "cilantro",
      "parsley",
      "basil",
    ]);
  });

  it("shows Coke variants only when the shopper types the variant", () => {
    const coke = grocerySuggestions("coke").map((item) => item.value);
    expect(coke.every((value) => /^coca-cola\b/i.test(value))).toBe(true);
    expect(coke.some((value) => /zero|diet|cherry/i.test(value))).toBe(false);

    expect(grocerySuggestions("coke z").map((item) => item.value)).toEqual([
      "Coke Zero 12 pack cans",
      "Coke Zero 24 pack cans",
    ]);
    expect(grocerySuggestions("coke zero").map((item) => item.value)).toEqual([
      "Coke Zero 12 pack cans",
      "Coke Zero 24 pack cans",
    ]);
  });

  it("preserves quantity prefixes for regular and variant Coke", () => {
    expect(grocerySuggestions("2 coke")[0].value).toBe("2 Coca-Cola 12 pack cans");
    expect(grocerySuggestions("3 coke zero")[0].value).toBe("3 Coke Zero 12 pack cans");
  });

  it("keeps Takis intent precise without adding fake catalog terminology", () => {
    expect(grocerySuggestions("takis")[0].value).toBe("Takis Fuego");
    expect(grocerySuggestions("takis")[0].value).not.toMatch(/standard bag/i);
  });

  it("does not show noisy suggestions for one letter or unknown text", () => {
    expect(grocerySuggestions("t")).toEqual([]);
    expect(grocerySuggestions("zzzzzz")).toEqual([]);
  });

  it("finds and replaces only the item at the caret", () => {
    const value = "eggs\ntun\nbread";
    const fragment = activeListFragment(value, value.indexOf("tun") + 3);
    expect(fragment).toEqual({ start: 5, end: 8, text: "tun" });
    expect(replaceListFragment(value, fragment, "tuna in water")).toEqual({
      value: "eggs\ntuna in water\nbread",
      caret: 18,
    });
  });

  it("keeps live Walmart titles with commas out of delimiter-based list text", () => {
    const value = "eggs, ham, milk";
    const fragment = activeListFragment(value, 4);
    expect(grocerySuggestionTextUpdate(value, fragment, {
      value: "Great Value Large White Eggs, 12 Count",
      exactTitle: "Great Value Large White Eggs, 12 Count",
      source: "walmart",
      productId: "EGGS12",
      category: "Walmart | $1.67",
      aliases: [],
    })).toEqual({ value, caret: 4 });
  });

  it("replaces only the active item with a live search idea and preserves its quantity", () => {
    const value = "eggs\n2 black forest ham\nmilk";
    const fragment = activeListFragment(value, value.indexOf("ham") + 3);
    const context = grocerySuggestionQuery(fragment.text);
    const replacement = grocerySuggestionTextUpdate(value, fragment, {
      value: `${context.prefix}black forest ham lunch meat`,
      category: "From Walmart results",
      aliases: [],
      kind: "query",
      source: "walmart_idea",
    });

    expect(context).toEqual({ prefix: "2 ", query: "black forest ham" });
    expect(replacement).toEqual({
      value: "eggs\n2 black forest ham lunch meat\nmilk",
      caret: 34,
    });
  });

  it("keeps only distinct exact Walmart products in the visible dropdown", () => {
    const liveIdea = {
      value: "black forest ham lunch meat",
      category: "From Walmart results",
      aliases: [],
      kind: "query" as const,
      source: "walmart_idea" as const,
    };
    const localDuplicate = {
      ...liveIdea,
      source: "local" as const,
      category: "Common option",
    };
    const exactProduct = {
      value: "Hillshire Farm Ultra Thin Sliced Black Forest Ham, 9 oz",
      exactTitle: "Hillshire Farm Ultra Thin Sliced Black Forest Ham, 9 oz",
      category: "Live Walmart",
      aliases: [],
      kind: "product" as const,
      source: "walmart" as const,
      productId: "LIVE-HAM",
      price: 4.97,
    };
    const unstructuredTitle = {
      ...exactProduct,
      productId: undefined,
      exactTitle: "A title without a Walmart product identifier",
      value: "A title without a Walmart product identifier",
    };

    expect(walmartProductSuggestions([
      liveIdea,
      localDuplicate,
      unstructuredTitle,
      exactProduct,
      exactProduct,
    ])).toEqual([exactProduct]);
  });

  it("shows up to six exact Walmart products", () => {
    const products = Array.from({ length: 8 }, (_, index) => ({
      value: `Walmart product ${index + 1}`,
      exactTitle: `Walmart product ${index + 1}`,
      category: "Live Walmart",
      aliases: [],
      kind: "product" as const,
      source: "walmart" as const,
      productId: `PRODUCT-${index + 1}`,
      price: index + 1,
    }));

    expect(walmartProductSuggestions(products)).toEqual(products.slice(0, 6));
  });

  it("puts exact Walmart products ahead of instant local refinements", () => {
    const live = [{
      value: "Lay's Sour Cream & Onion Potato Chips, 7.75 oz Bag",
      exactTitle: "Lay's Sour Cream & Onion Potato Chips, 7.75 oz Bag",
      category: "Live Walmart",
      aliases: [],
      source: "walmart" as const,
      productId: "LIVE-LAYS",
      brand: "Lay's",
      flavor: "Sour Cream & Onion",
      packageSize: "7.75 oz",
      price: 2.50,
    }];
    const local = grocerySuggestions("chips");
    const combined = prioritizeWalmartSuggestions(live, local);

    expect(combined[0]).toMatchObject({
      source: "walmart",
      exactTitle: "Lay's Sour Cream & Onion Potato Chips, 7.75 oz Bag",
      brand: "Lay's",
      flavor: "Sour Cream & Onion",
      packageSize: "7.75 oz",
      price: 2.50,
    });
    expect(combined.slice(1).some((item) => item.source === "local")).toBe(true);
  });

  it("offers common chip flavors immediately while Walmart exact products load", () => {
    expect(grocerySuggestions("chips", 8).map((item) => item.value)).toEqual([
      "original potato chips",
      "sour cream and onion potato chips",
      "hot chips",
      "nacho cheese tortilla chips",
      "barbecue potato chips",
      "Takis Fuego",
      "Doritos nacho cheese family size",
    ]);
  });

  it("allows Walmart lookup for any meaningful selected-store product phrase", () => {
    for (const query of ["chips", "cheese", "baby wipes", "cilantro", "plates", "zzzzzz"]) {
      expect(canLookupWalmartSuggestions(query, "4366")).toBe(true);
    }
    expect(canLookupWalmartSuggestions("c", "4366")).toBe(false);
    expect(canLookupWalmartSuggestions("ch", "4366")).toBe(false);
    expect(canLookupWalmartSuggestions("chips", undefined)).toBe(false);
  });

  it("keeps concise Walmart metadata without repeating container labels", () => {
    expect(conciseSuggestionMetadata(
      "Lay's",
      "Sour Cream & Onion",
      "Bag",
      "7.75 oz Bag",
      "Lay's",
    )).toEqual(["Lay's", "Sour Cream & Onion", "7.75 oz Bag"]);
  });

  it("supports comma-separated lists without replacing neighboring items", () => {
    const value = "milk, tun, eggs";
    const fragment = activeListFragment(value, 9);
    expect(replaceListFragment(value, fragment, "albacore tuna").value).toBe("milk, albacore tuna, eggs");
  });

  it("preserves a typed cart quantity when completing the grocery", () => {
    expect(grocerySuggestions("2 cans tun")[0].value).toBe("2 cans tuna in water");
  });

  it("treats the natural filler in 'bags of chips' as part of the quantity prefix", () => {
    expect(grocerySuggestionQuery("2 bags of chips")).toEqual({
      prefix: "2 bags of ",
      query: "chips",
    });
    expect(grocerySuggestions("2 bags of chips")[0].value).toBe("2 bags of original potato chips");
  });

  it("keeps package requirements in the Walmart query so Prepare can reuse the search", () => {
    for (const value of [
      "one dozen eggs",
      "2 lb chicken breast",
      "32 oz yogurt",
      "12 count plates",
      "7 up",
    ]) {
      expect(grocerySuggestionQuery(value)).toEqual({ prefix: "", query: value });
    }
    expect(grocerySuggestionQuery("2 cans tuna")).toEqual({
      prefix: "2 cans ",
      query: "tuna",
    });
  });

  it("handles semicolon-separated items", () => {
    const value = "milk; tun; eggs";
    const fragment = activeListFragment(value, 9);
    expect(replaceListFragment(value, fragment, "tuna pouches").value).toBe("milk; tuna pouches; eggs");
  });
});
