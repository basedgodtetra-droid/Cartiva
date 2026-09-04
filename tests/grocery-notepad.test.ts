import { describe, expect, it } from "vitest";
import {
  applyGroceryClarification,
  groceryProteinOriginKey,
  interpretGroceryInput,
  resolveGroceryClarification,
} from "@/lib/grocery-notepad";
import { AttributeOrigin } from "@/packages/shared/src/types";

describe("Smart Grocery Notepad interpretation", () => {
  it("turns subjective grocery language into one useful choice instead of inventing intent", () => {
    expect(interpretGroceryInput("healthy cereal").items[0].clarification?.id).toBe("cereal-kind");
    expect(interpretGroceryInput("good sandwich bread").items[0].clarification?.id).toBe("bread-kind");
    expect(interpretGroceryInput("cheap rice").items[0].clarification?.id).toBe("rice-kind");
    expect(interpretGroceryInput("cheese for tacos").items[0].clarification?.id).toBe("cheese-kind");
  });

  it("repairs common turkey shorthand before applying the protein policy", () => {
    expect(interpretGroceryInput("ground turky").items[0]).toMatchObject({
      raw: "ground turkey",
      clarification: { id: "ground-turkey-ratio" },
    });
  });

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

  it("normalizes all seven false-no-match regression items without losing requested totals", () => {
    const result = interpretGroceryInput([
      "Chickpeas 3 cans",
      "Diced Tomatoes 8 cans",
      "Kidney Beans 4 cans",
      "Light Coconut Milk 2 cans",
      "Ground Turkey 93/7 3 lb",
      "Red Lentil Pasta 1.8 lb",
      "White Rice",
    ].join("\n"));

    expect(result).toMatchObject({ readyCount: 7, unresolvedCount: 0 });
    expect(result.items).toMatchObject([
      {
        raw: "Chickpeas 3 cans",
        name: "Chickpeas",
        detail: "3 cans",
        canonicalText: "Chickpeas, 3 cans",
        status: "ready",
      },
      {
        raw: "Diced Tomatoes 8 cans",
        name: "Diced Tomatoes",
        detail: "8 cans",
        canonicalText: "Diced Tomatoes, 8 cans",
        status: "ready",
      },
      {
        raw: "Kidney Beans 4 cans",
        name: "Kidney Beans",
        detail: "4 cans",
        canonicalText: "Kidney Beans, 4 cans",
        status: "ready",
      },
      {
        raw: "Light Coconut Milk 2 cans",
        name: "Light Coconut Milk",
        detail: "2 cans",
        canonicalText: "Light Coconut Milk, 2 cans",
        status: "ready",
      },
      {
        raw: "Ground Turkey 93/7 3 lb",
        name: "Ground Turkey",
        detail: "93/7 · 3 lb",
        canonicalText: "Ground Turkey, 93/7, 3 lb",
        status: "ready",
      },
      {
        raw: "Red Lentil Pasta 1.8 lb",
        name: "Red Lentil Pasta",
        detail: "1.8 lb",
        canonicalText: "Red Lentil Pasta, 1.8 lb",
        status: "ready",
      },
      {
        raw: "White Rice",
        name: "White Rice",
        canonicalText: "White Rice",
        status: "ready",
      },
    ]);
  });

  it("keeps planner totals in canonical matching text without showing total as the product name", () => {
    expect(interpretGroceryInput([
      "Eggs 21 count total",
      "Chicken breast 500 g total",
    ].join("\n")).items).toMatchObject([
      {
        name: "Eggs",
        detail: "21 ct",
        canonicalText: "Eggs, 21 ct total",
      },
      {
        name: "Chicken Breast",
        detail: "500 g",
        canonicalText: "Chicken Breast, 500 g total",
        proteinIntent: {
          weight: { value: "500 g" },
        },
      },
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
      "chicken breast 2 lb",
      "bananas",
    ]);
    expect(result.serialized).toBe(
      "Eggs, 18 ct\nWhite Bread\nMilk, 1 gallon\nChicken Breast, 2 lb\nBananas",
    );
    expect(result.usedSmartSplit).toBe(true);
    expect(result.unresolvedCount).toBe(2);
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
    const yogurt = interpretGroceryInput("yogurt").items[0];
    expect(yogurt.clarification?.id).toBe("yogurt-kind");
    const greekYogurt = applyGroceryClarification(yogurt.raw, "yogurt-kind", "Greek");
    expect(interpretGroceryInput(greekYogurt).items[0].clarification?.id).toBe("yogurt-size");
    expect(interpretGroceryInput("chicken breast").items[0].clarification?.id).toBe("chicken-preparation");
    expect(interpretGroceryInput("bananas").items[0].clarification).toBeUndefined();

    const pasta = interpretGroceryInput("pasta").items[0];
    expect(pasta.clarification?.id).toBe("pasta-kind");
    const spaghetti = applyGroceryClarification(pasta.raw, "pasta-kind", "spaghetti");
    expect(interpretGroceryInput(spaghetti)).toMatchObject({
      readyCount: 1,
      unresolvedCount: 0,
      items: [{ raw: "spaghetti pasta", canonicalText: "Spaghetti Pasta", status: "ready" }],
    });
  });

  it("normalizes common count and hyphenated package forms", () => {
    expect(interpretGroceryInput("18-count eggs").items[0]).toMatchObject({
      name: "Eggs",
      detail: "18 ct",
      status: "ready",
    });
    expect(interpretGroceryInput("dozen eggs").items[0]).toMatchObject({ name: "Eggs", detail: "12 ct" });
    expect(interpretGroceryInput("four dozen eggs").items[0]).toMatchObject({
      name: "Eggs",
      detail: "48 ct",
      canonicalText: "Eggs, 12 ct x4",
      status: "ready",
    });
    expect(interpretGroceryInput("12 eggs").items[0]).toMatchObject({ name: "Eggs", detail: "12 ct" });
    expect(interpretGroceryInput("coke zero 12-pack").items[0].clarification).toBeUndefined();
    expect(interpretGroceryInput("chicken breast 2-lb").items[0].clarification?.id).toBe("chicken-preparation");
  });

  it("lets named soda proceed while retaining clarification for generic soda", () => {
    const named = interpretGroceryInput("coke\ncoke zero\nbread");
    expect(named).toMatchObject({ readyCount: 2, unresolvedCount: 1 });
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
      "Pepsi",
      "Sprite",
      "Dr Pepper",
    ]);
    const original = applyGroceryClarification(generic.raw, "soda-kind", "Coca-Cola");
    expect(interpretGroceryInput(original).items[0].clarification).toBeUndefined();
    expect(interpretGroceryInput("Coke Zero 2 L").items[0].clarification).toBeUndefined();
  });

  it("preserves retailer quantity separately from package identity", () => {
    expect(interpretGroceryInput("2 gallons of whole milk").items[0]).toMatchObject({
      name: "Whole Milk",
      detail: "1 gallon",
      canonicalText: "Whole Milk, 1 gallon x2",
      status: "ready",
    });
    expect(interpretGroceryInput("2 whole milk gallon").items[0].canonicalText).toBe(
      "Whole Milk, 1 gallon x2",
    );
    expect(interpretGroceryInput("2 dozen eggs").items[0]).toMatchObject({
      name: "Eggs",
      detail: "24 ct",
      canonicalText: "Eggs, 12 ct x2",
      status: "ready",
    });
    expect(interpretGroceryInput("two dozen eggs x3").items[0].canonicalText).toBe(
      "Eggs, 12 ct x6",
    );
    expect(interpretGroceryInput("three dozen eggs x2").items[0].canonicalText).toBe(
      "Eggs, 12 ct x6",
    );
    expect(interpretGroceryInput("2 pints cream").items[0]).toMatchObject({
      name: "Cream",
      detail: "1 pt",
      canonicalText: "Cream, 1 pt x2",
      status: "ready",
    });
  });

  it("keeps an explicit measured sell-container beside its normalized detail", () => {
    expect(interpretGroceryInput("trash bags 30 count box").items[0]).toMatchObject({
      name: "Trash Bags",
      detail: "30 ct box",
      canonicalText: "Trash Bags, 30 ct box",
    });
    expect(interpretGroceryInput("pasta sauce 24 oz jar").items[0]).toMatchObject({
      name: "Pasta Sauce",
      detail: "24 oz jar",
      canonicalText: "Pasta Sauce, 24 oz jar",
    });
    expect(interpretGroceryInput("1 count can opener").items[0]).toMatchObject({
      name: "Can Opener",
      detail: "1 ct",
      canonicalText: "Can Opener, 1 ct",
    });
    expect(interpretGroceryInput("razor refill 12 blades total").items[0]).toMatchObject({
      name: "Razor Refill",
      detail: "12 blades",
      canonicalText: "Razor Refill, 12 blades total",
    });
    expect(interpretGroceryInput("coffee pods 24-pods total").items[0]).toMatchObject({
      name: "Coffee Pods",
      detail: "24 pods",
      canonicalText: "Coffee Pods, 24 pods total",
    });
    expect(interpretGroceryInput("rice 2 × 500 g").items[0]).toMatchObject({
      name: "Rice",
      detail: "2 × 500 g",
      canonicalText: "Rice, 2 × 500 g",
    });
  });

  it.each([
    ["toilet paper 12-rolls", "Toilet Paper, 12 rolls"],
    ["toilet paper 12 giant rolls", "Toilet Paper, 12 rolls"],
    ["toilet paper 12 super mega rolls", "Toilet Paper, 12 rolls"],
    ["paper towels 12 select-a-size rolls", "Paper Towels, 12 rolls"],
  ])("normalizes strict counted-content variants without losing their amount: %s", (raw, canonicalText) => {
    expect(interpretGroceryInput(raw).items[0]).toMatchObject({
      canonicalText,
      detail: "12 rolls",
      status: "ready",
    });
  });

  it.each([
    ["2 bar stools", "2 Bar Stools"],
    ["1 pod coffee maker", "1 Pod Coffee Maker"],
    ["1 blade sharpener", "1 Blade Sharpener"],
    ["2 wipe warmers", "2 Wipe Warmers"],
  ])("does not turn a counted-unit identity into package detail: %s", (raw, canonicalText) => {
    expect(interpretGroceryInput(raw).items[0]).toMatchObject({
      name: canonicalText,
      canonicalText,
      detail: undefined,
    });
  });

  it("repairs allow-listed grocery typos without mutating valid attributes", () => {
    expect(interpretGroceryInput("banannas 6").items[0].canonicalText).toBe("Bananas, 6 each");
    expect(interpretGroceryInput("creamy peanut butter 16oz").items[0].canonicalText).toBe(
      "Creamy Peanut Butter, 16 oz",
    );
    expect(interpretGroceryInput("sharp cheddar cheese block 8oz").items[0].canonicalText).toBe(
      "Sharp Cheddar Cheese Block, 8 oz",
    );
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

  it("allows exactly 50 items and explicitly blocks overflow", () => {
    const fifty = Array.from({ length: 50 }, (_, index) => `grocery ${index + 1}`).join("\n");
    const fiftyOne = `${fifty}\ngrocery 51`;

    expect(interpretGroceryInput(fifty)).toMatchObject({
      limitReached: false,
      omittedCount: 0,
    });
    expect(interpretGroceryInput(fiftyOne)).toMatchObject({
      limitReached: true,
      omittedCount: 1,
    });
    expect(interpretGroceryInput(fiftyOne).items).toHaveLength(50);
  });

  it("can undo an implicit smart split without changing explicit list lines", () => {
    const original = "eggs 18 count white bread";
    expect(interpretGroceryInput(original).items).toHaveLength(2);
    expect(interpretGroceryInput(original, { undoImplicitSplits: true }).items.map((item) => item.raw)).toEqual([
      original,
    ]);

    expect(interpretGroceryInput("eggs\nwhite bread", { undoImplicitSplits: true }).items).toHaveLength(2);
  });

  it.each([
    ["ground beef", "ground-beef-ratio"],
    ["93/7 ground beef", undefined],
    ["chicken", "chicken-cut"],
    ["chicken breast", "chicken-preparation"],
    ["boneless skinless chicken breast", undefined],
    ["steak", "steak-cut"],
    ["ribeye steak", undefined],
    ["pork", "pork-form"],
    ["salmon", "salmon-form"],
    ["ground beef 93/7 2 lb", undefined],
  ])("applies the protein clarification contract for %s", (input, clarificationId) => {
    const item = interpretGroceryInput(input).items[0];
    expect(item.clarification?.id).toBe(clarificationId);
    expect(item.status).toBe(clarificationId ? "needs-detail" : "ready");
    expect(item.proteinIntent).toBeDefined();
  });

  it("normalizes explicit protein attributes without repeating a supplied answer", () => {
    const explicit = interpretGroceryInput("ground beef 93/7 2 lb").items[0];
    expect(explicit).toMatchObject({
      name: "Ground Beef",
      detail: "93/7 · 2 lb",
      canonicalText: "Ground Beef, 93/7, 2 lb",
      status: "ready",
      proteinIntent: {
        category: "meat",
        animal: { value: "beef", origin: AttributeOrigin.USER_EXPLICIT },
        form: { value: "ground", origin: AttributeOrigin.USER_EXPLICIT },
        leanRatio: { value: "93/7", origin: AttributeOrigin.USER_EXPLICIT },
        weight: { value: "2 lb", origin: AttributeOrigin.USER_EXPLICIT },
      },
    });
    expect(interpretGroceryInput("93% lean ground beef").items[0].proteinIntent?.leanRatio?.value).toBe("93/7");
  });

  it("progresses through at most two material protein questions", () => {
    const chicken = interpretGroceryInput("chicken").items[0];
    const breastRaw = applyGroceryClarification(chicken.raw, chicken.clarification!.id, "breast");
    const breast = interpretGroceryInput(breastRaw).items[0];
    expect(breast.raw).toBe("chicken breast");
    expect(breast.clarification?.id).toBe("chicken-preparation");

    const readyRaw = applyGroceryClarification(breast.raw, breast.clarification!.id, "boneless skinless");
    expect(interpretGroceryInput(readyRaw).items[0]).toMatchObject({
      raw: "boneless skinless chicken breast",
      status: "ready",
      clarification: undefined,
    });

    const steakRaw = applyGroceryClarification("steak", "steak-cut", "ribeye");
    expect(interpretGroceryInput(steakRaw).items[0]).toMatchObject({ raw: "ribeye steak", status: "ready" });

    const porkRaw = applyGroceryClarification("pork", "pork-form", "chops");
    expect(interpretGroceryInput(porkRaw).items[0].clarification?.id).toBe("pork-chop-preparation");
  });

  it("preserves USER_SELECTED provenance while keeping no preference flexible", () => {
    const selection = resolveGroceryClarification("ground beef", "ground-beef-ratio", "93/7");
    expect(selection.selectedAttribute).toEqual({
      key: "leanRatio",
      value: "93/7",
      origin: AttributeOrigin.USER_SELECTED,
    });
    const selected = interpretGroceryInput(selection.raw, {
      proteinOrigins: {
        [groceryProteinOriginKey(selection.raw)]: {
          leanRatio: AttributeOrigin.USER_SELECTED,
        },
      },
    }).items[0];
    expect(selected.proteinIntent?.leanRatio).toEqual({
      value: "93/7",
      origin: AttributeOrigin.USER_SELECTED,
    });

    const anyRaw = applyGroceryClarification("ground beef", "ground-beef-ratio", "any");
    expect(interpretGroceryInput(anyRaw).items[0]).toMatchObject({
      name: "Ground Beef",
      detail: "Any lean ratio",
      canonicalText: "Ground Beef, Any lean ratio",
      status: "ready",
    });
  });

  it("keeps duplicate-row protein origins separate with indexed keys", () => {
    const raw = "ground beef 93/7";
    const legacyKey = groceryProteinOriginKey(raw);
    const firstKey = groceryProteinOriginKey(raw, 0);
    const secondKey = groceryProteinOriginKey(raw, 1);
    const result = interpretGroceryInput(`${raw}\n${raw}`, {
      proteinOrigins: {
        [legacyKey]: { leanRatio: AttributeOrigin.INFERRED },
        [firstKey]: { leanRatio: AttributeOrigin.USER_SELECTED },
        [secondKey]: { leanRatio: AttributeOrigin.USER_EXPLICIT },
      },
    });

    expect(firstKey).not.toBe(secondKey);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].proteinIntent?.leanRatio?.origin).toBe(AttributeOrigin.USER_SELECTED);
    expect(result.items[1].proteinIntent?.leanRatio?.origin).toBe(AttributeOrigin.USER_EXPLICIT);
  });

  it("uses category policies across turkey, bacon, sausage, fish, and shrimp", () => {
    expect(interpretGroceryInput("turkey").items[0].clarification?.id).toBe("turkey-form");
    expect(interpretGroceryInput("ground turkey").items[0].clarification?.id).toBe("ground-turkey-ratio");
    expect(interpretGroceryInput("bacon").items[0].clarification?.id).toBe("bacon-style");
    expect(interpretGroceryInput("sausage").items[0].clarification?.id).toBe("sausage-style");
    expect(interpretGroceryInput("fish").items[0].clarification?.id).toBe("fish-species");
    expect(interpretGroceryInput("shrimp").items[0].clarification?.id).toBe("shrimp-cooking");
    expect(interpretGroceryInput("raw shrimp").items[0].clarification?.id).toBe("shrimp-size");
    expect(interpretGroceryInput("jumbo raw shrimp").items[0].clarification).toBeUndefined();
  });
});
