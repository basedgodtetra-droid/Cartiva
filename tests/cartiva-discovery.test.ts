import { describe, expect, it } from "vitest";
import { interpretGroceryInput } from "@/lib/grocery-notepad";
import { inspectShoppingList, isOrphanGroceryModifier } from "@/packages/shared/src/list-parser";
import { normalizeMeasurementFractions, invalidGroceryQuantity } from "@/packages/shared/src/quantity-text";
import { editWorkspaceItem, sanitizeWorkspaceQuantities, writeBrowserStorage } from "@/lib/cartiva-workspace-state";
import { generateMealPlan, parseRecipeText, replacePlanMeal, regenerateMealPlan } from "@/lib/cartiva-planning";
import { plannerDietaryRestrictions, plannerIngredientAllowed } from "@/lib/planner-restrictions";

// Permanent deterministic fuzz corpus: reproducible failures, no success-rate relabeling.
const identities = ["chicken breast", "ground beef", "rice", "black beans", "white bread", "2% milk", "Greek yogurt", "Coke Zero", "bananas", "paper towels"];
const amounts = ["1/2 lb", "½ lb", ".5 lb", "0.5 lb", "1½ lb", "1,5 lb"];
describe("Cartiva discovery — parser properties", () => {
  for (const food of identities) for (let seed = 0; seed < 40; seed++) {
    const source = seed % 2 ? food.toUpperCase() : food;
    const variant = `${" ".repeat(seed % 4)}${source.replaceAll(" ", " ".repeat(1 + seed % 5))}${" ".repeat(seed % 3)}`;
    it(`whitespace/case ${food} seed ${seed}`, () => {
      const canonical = (text: string) => interpretGroceryInput(text).items.map((item) => item.canonicalText.toLowerCase());
      expect(canonical(variant)).toEqual(canonical(food));
      expect(interpretGroceryInput(variant).items.every((item) => !isOrphanGroceryModifier(item.raw))).toBe(true);
    });
  }
  it.each(amounts)("normalizes physical amount %s before item splitting", (amount) => {
    const normalized = normalizeMeasurementFractions(`rice ${amount}`);
    expect(normalized).toBe(`rice ${/^(1½|1,5)/.test(amount) ? "1.5" : "0.5"} lb`);
    const parsed = interpretGroceryInput(`rice ${amount}`);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].raw).toBe(normalized);
  });
  it.each(["80/20", "85/15", "90/10", "93/7", "96/4"])("preserves ratio %s beside comma amounts", (ratio) => {
    for (const form of [ratio, ratio.replace("/", " / ")]) {
      const parsed = interpretGroceryInput(`ground beef,${form},1lb`);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].canonicalText.replaceAll(" ", "")).toContain(ratio);
    }
  });
  it.each(["0 bananas", "ground beef 0 lb", "-2 lb rice", "rice 1/0 lb", "Coke Zero x0", "Coke Zero x100", "100 bananas", "100 cans black beans", "bananas 1.5 each", "Coke Zero x-2"])("rejects invalid explicit quantity: %s", (text) => {
    expect(invalidGroceryQuantity(text)).toBeTruthy();
    expect(interpretGroceryInput(text).unresolvedCount).toBeGreaterThan(0);
  });
  it.each(["93/7,ground beef", "2 lb,chicken", "6,bananas"])("attaches prefix modifier: %s", (text) => {
    const parsed = inspectShoppingList(text);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.unattachedModifiers).toEqual([]);
    expect(isOrphanGroceryModifier(parsed.items[0])).toBe(false);
  });
  it("never silently discards standalone modifiers or long-list overflow", () => {
    expect(interpretGroceryInput("93/7\nchicken").inputIssues).toHaveLength(1);
    const result = interpretGroceryInput(Array.from({ length: 100 }, () => "rice").join("\n"));
    expect(result.items).toHaveLength(50);
    expect(result.omittedCount).toBe(50);
  });
});

describe("Cartiva discovery — state transitions", () => {
  it("keeps independent duplicate occurrences and quantity overrides through deletion", () => {
    const items = interpretGroceryInput("coffee\nrice\nbananas\nbananas").items;
    const edited = editWorkspaceItem(items, 0, null, { [items[2].id]: 6, [items[3].id]: 2 });
    const next = interpretGroceryInput(edited.rawInput).items;
    expect(next).toHaveLength(3);
    expect(edited.quantities[next[1].id]).toBe(6);
    expect(edited.quantities[next[2].id]).toBe(2);
  });
  it("survives 100 seeded edit/delete transitions without moving overrides", () => {
    let raw = identities.join("\n");
    let items = interpretGroceryInput(raw).items;
    let quantities = Object.fromEntries(items.map((item, index) => [item.id, index + 1]));
    for (let step = 0; step < 100; step++) {
      const index = step % items.length;
      const before = items.map((item) => quantities[item.id]);
      const edited = editWorkspaceItem(items, index, items[index].raw.toUpperCase(), quantities);
      raw = edited.rawInput; quantities = edited.quantities; items = interpretGroceryInput(raw).items;
      expect(items.map((item) => quantities[item.id])).toEqual(before);
    }
  });
  it("rejects corrupt stored values and reports failed storage without throwing", () => {
    expect(sanitizeWorkspaceQuantities({ a: "2", b: {}, c: -1, d: Infinity, e: 2.1, f: 100, okay: 99 })).toEqual({ okay: 99 });
    expect(writeBrowserStorage({ setItem() { throw new Error("quota"); } }, "workspace", "{}")).toBe(false);
  });
});

describe("Cartiva discovery — plans and recipes", () => {
  it.each(["allergic to milk", "allergic to peanuts and dairy", "no dairy or eggs", "vegan", "gluten free", "no sesame and soy", "allergies: milk and eggs", "no dairy, eggs, and peanuts", "peanut and dairy allergies"])("checks actual ingredients for %s", (notes) => {
    const restrictions = plannerDietaryRestrictions(notes).exclusions;
    const draft = { notes: `${notes}; 1800 calories, 160g protein, 3 days` };
    const plan = generateMealPlan(draft);
    for (const version of [plan, regenerateMealPlan(plan, draft), replacePlanMeal(plan, plan.meals[0].id)]) {
      expect(version.ingredients.every((item) => plannerIngredientAllowed(item.name, restrictions))).toBe(true);
    }
  });
  it("does not promise support for an unknown allergy", () => {
    expect(() => generateMealPlan({ notes: "allergic to kiwi" })).toThrow(/can't yet check/);
  });
  it.each(["1/0 cup rice", "0 bananas", "-2 cups rice", "1 (0 oz) chicken", "1 (99999999999999999999 oz) chicken"])("rejects invalid recipe amount %s", (text) => {
    expect(() => parseRecipeText(`Ingredients\n${text}`)).toThrow(/amount|quantity|positive|greater/i);
  });
  it("separates directions, fractions, liters, and optional ingredients", () => {
    const recipe = parseRecipeText("Ingredients\n½ cup rice\n1 liter water\n2 onions (optional)\nDice onions\nInstructions\nCook rice");
    expect(recipe.ingredients.some((item) => /dice|cook/i.test(item.name))).toBe(false);
    expect(recipe.ingredients.find((item) => /rice/i.test(item.name))?.amount).toBe(0.5);
    expect(recipe.ingredients.find((item) => /water/i.test(item.name))?.amount).toBe(1000);
    expect(recipe.ingredients.find((item) => /onions/i.test(item.name))?.optional).toBe(true);
  });
});
