import { describe, expect, it } from "vitest";
import { interpretGroceryInput } from "@/lib/grocery-notepad";
import {
  matchedCommittedPlanItemIndexes,
  reconcileCommittedPlanIngredients,
  trackStoredPlanIngredientEdit,
  type StoredPlanIngredient,
} from "@/lib/cartiva-plan-reconciliation";
import type { ConsolidatedIngredient } from "@/lib/cartiva-planning";

function ingredient(id: string, name: string, shoppingText: string): ConsolidatedIngredient {
  return {
    id,
    name,
    amount: 1,
    unit: "each",
    sourceMealIds: ["meal-1"],
    optional: false,
    shoppingText,
  };
}

describe("Cartiva committed-plan grocery reconciliation", () => {
  it("replaces only plan groceries while preserving unrelated items and reviewed clarification text", () => {
    const current = interpretGroceryInput([
      "Bananas 6",
      "93/7 ground beef 2 lb",
      "Olive oil 2 tbsp",
      "Paper towels",
    ].join("\n")).items;
    const previous: StoredPlanIngredient[] = [
      { id: "beef", name: "Ground beef", shoppingText: "Ground beef 2 lb", currentRaw: "93/7 ground beef 2 lb" },
      { id: "oil", name: "Olive oil", shoppingText: "Olive oil 2 tbsp", currentRaw: "Olive oil 2 tbsp" },
    ];
    const next = [
      ingredient("beef", "Ground beef", "Ground beef 2 lb"),
      ingredient("oil", "Olive oil", "Olive oil 3 tbsp"),
      ingredient("rice", "Brown rice", "Brown rice 2 cups"),
    ];

    expect(matchedCommittedPlanItemIndexes(current, previous).matchedIndexes.size).toBe(2);
    expect(reconcileCommittedPlanIngredients(current, previous, next)).toBe([
      "Bananas 6",
      "93/7 ground beef 2 lb",
      "Olive oil 3 tbsp",
      "Brown rice 2 cups",
      "Paper towels",
    ].join("\n"));
  });

  it("does not remove similarly worded unrelated products", () => {
    const current = interpretGroceryInput("Oil-packed tuna\nBell pepper\nOlive oil 1 tbsp").items;
    const previous: StoredPlanIngredient[] = [
      { id: "oil", name: "Olive oil", shoppingText: "Olive oil 1 tbsp" },
    ];
    const next = [ingredient("oil", "Olive oil", "Olive oil 2 tbsp")];
    const reconciled = reconcileCommittedPlanIngredients(current, previous, next);
    expect(reconciled).toContain("Oil-packed tuna");
    expect(reconciled).toContain("Bell pepper");
    expect(reconciled).toContain("Olive oil 2 tbsp");
    expect(reconciled.match(/Olive oil/gi)).toHaveLength(1);
  });

  it.each([
    ["Chocolate Milk", "Milk", "Milk 1 gallon", "Milk 2 gallons"],
    ["Rice cakes", "Rice", "Rice 5 lb", "Rice 10 lb"],
    ["Chicken sausage", "Chicken", "Chicken 1 lb", "Chicken 2 lb"],
  ])("never consumes manual %s when replacing a plan line for %s", (manual, name, oldLine, newLine) => {
    const current = interpretGroceryInput(`${manual}\n${oldLine}`).items;
    const previous = [{ id: "planned", name, shoppingText: oldLine }];

    expect(reconcileCommittedPlanIngredients(current, previous, [ingredient("planned", name, newLine)])).toBe(
      `${manual}\n${newLine}`,
    );
  });

  it("leaves manual lines untouched when no previous plan line can be identified safely", () => {
    const current = interpretGroceryInput("Chocolate Milk").items;
    const previous = [{ id: "milk", name: "Milk", shoppingText: "Milk 1 gallon" }];

    expect(reconcileCommittedPlanIngredients(current, previous, [ingredient("milk", "Milk", "Milk 2 gallons")])).toBe(
      "Chocolate Milk\nMilk 2 gallons",
    );
  });

  it("can remove every prior plan line without removing adjacent manual groceries", () => {
    const current = interpretGroceryInput("Chocolate Milk\nMilk 1 gallon\nPaper towels").items;
    const previous = [{ id: "milk", name: "Milk", shoppingText: "Milk 1 gallon" }];

    expect(reconcileCommittedPlanIngredients(current, previous, [])).toBe("Chocolate Milk\nPaper towels");
  });

  it("tracks a clarified plan line by exact ownership even after other rows move", () => {
    const before = interpretGroceryInput("Bananas 6\nChicken Breast 2 lb\nPaper towels").items;
    const stored = [{
      id: "chicken",
      name: "Chicken Breast",
      shoppingText: "Chicken Breast 2 lb",
      currentRaw: "Chicken Breast 2 lb",
    }];
    const tracked = trackStoredPlanIngredientEdit(
      before,
      stored,
      1,
      "Boneless skinless Chicken Breast 2 lb",
    );
    const after = interpretGroceryInput("Paper towels\nBoneless skinless Chicken Breast 2 lb").items;

    expect(tracked.tracked).toBe(true);
    expect(reconcileCommittedPlanIngredients(
      after,
      tracked.ingredients,
      [ingredient("chicken", "Chicken Breast", "Chicken Breast 3 lb")],
    )).toBe("Paper towels\nChicken Breast 3 lb");
  });

  it("removes ownership only for the exact plan row a shopper deletes", () => {
    const current = interpretGroceryInput("Chocolate Milk\nMilk 1 gallon").items;
    const stored = [{ id: "milk", name: "Milk", shoppingText: "Milk 1 gallon", currentRaw: "Milk 1 gallon" }];

    expect(trackStoredPlanIngredientEdit(current, stored, 0, null)).toEqual({ ingredients: stored, tracked: false });
    expect(trackStoredPlanIngredientEdit(current, stored, 1, null)).toEqual({ ingredients: [], tracked: true });
  });

  it("uses stored position to preserve an identical manual grocery", () => {
    const current = interpretGroceryInput("Milk 1 gallon\nMilk 1 gallon\nPaper towels").items;
    const stored = [{
      id: "milk",
      name: "Milk",
      shoppingText: "Milk 1 gallon",
      currentRaw: "Milk 1 gallon",
      position: 1,
    }];

    expect(reconcileCommittedPlanIngredients(
      current,
      stored,
      [ingredient("milk", "Milk", "Milk 2 gallons")],
    )).toBe("Milk 1 gallon\nMilk 2 gallons\nPaper towels");
  });

  it("does not claim an ambiguous duplicate when legacy ownership has no position", () => {
    const current = interpretGroceryInput("Milk 1 gallon\nMilk 1 gallon").items;
    const stored = [{ id: "milk", name: "Milk", shoppingText: "Milk 1 gallon" }];

    expect(matchedCommittedPlanItemIndexes(current, stored).matchedIndexes.size).toBe(0);
  });
});
