import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CartivaCreationModeTabs } from "@/components/cartiva-list-creation";

describe("Cartiva list creation modes", () => {
  it("renders the three first-class creation modes as accessible tabs", () => {
    const markup = renderToStaticMarkup(createElement(CartivaCreationModeTabs, {
      mode: "build-plan",
      onMode: () => undefined,
    }));
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("Grocery list");
    expect(markup).toContain("Build my plan");
    expect(markup).toContain("Paste a recipe");
    expect(markup).toContain('aria-selected="true"');
  });

  it("keeps trust copy, a compact tabbed workspace, pantry review, and per-meal controls in the integrated UI", () => {
    const source = readFileSync(path.join(process.cwd(), "components", "cartiva-list-creation.tsx"), "utf8");
    const planningSource = readFileSync(path.join(process.cwd(), "lib", "cartiva-planning.ts"), "utf8");
    expect(source).toContain("Nutrition is estimated");
    expect(source).toContain("actual total comes from Cartiva");
    expect(source).toContain("review the meals and ingredients before anything is added");
    expect(source).toContain("More protein");
    expect(source).toContain("Make this cheaper");
    expect(source).toContain("Lower calories");
    expect(source).toContain("Replace");
    expect(source).toContain("Meals <span>");
    expect(source).toContain("Grocery list <span>");
    expect(source).toContain("I have all of these");
    expect(source).toContain("I already have ${ingredient.name}");
    expect(source).toContain("Use last week’s plan");
    expect(source).toContain("Update ${count} plan ${count === 1 ? \"grocery\" : \"groceries\"} in my list");
    expect(source).toContain("Remove this plan’s groceries from my list");
    expect(source).toContain("allowEmptyCommit={committedPlanId === plan.id}");
    expect(source).toContain("Building meals around your goals…");
    expect(planningSource).toContain("Checking calories, protein, and budget…");
    expect(planningSource).toContain("Adjusting the plan…");
    expect(source).toContain("These goals conflict");
    expect(source).toContain("What matters most?");
    expect(source).toContain("Stay under calories");
    expect(source).toContain("Hit protein");
    expect(source).toContain("Stay under budget");
    expect(source).toContain("Choose what matters most before adding this conflicting plan");
    expect(source).toContain("Higher protein");
    expect(source).toContain("Make cheaper");
    expect(source).toContain("refineWholePlan");
  });

  it("bridges both generated paths back into the existing workspace instead of a second cart", () => {
    const workspace = readFileSync(path.join(process.cwd(), "components", "cartiva-workspace.tsx"), "utf8");
    expect(workspace).toContain('onCommit={(ingredients, suggestedName, plan) => commitGeneratedIngredients(');
    expect(workspace).toContain('"plan",');
    expect(workspace).toContain('commitGeneratedIngredients(ingredients, suggestedName, "recipe")');
    expect(workspace).toContain('setCreationMode("grocery-list")');
    expect(workspace).toContain("reconcileCommittedPlanState");
    expect(workspace).toContain("trackStoredPlanIngredientEdit");
    expect(workspace).toContain("plannedBudgetDollars={activePlanBudgetDollars}");
    expect(workspace).not.toContain("separateShoppingEngine");
  });
});
