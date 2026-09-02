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

  it("keeps trust copy, review-before-add, and per-meal controls in the integrated UI", () => {
    const source = readFileSync(path.join(process.cwd(), "components", "cartiva-list-creation.tsx"), "utf8");
    expect(source).toContain("Nutrition is estimated");
    expect(source).toContain("actual total comes from Cartiva");
    expect(source).toContain("review the meals and ingredients before anything is added");
    expect(source).toContain("Increase protein");
    expect(source).toContain("Use cheaper ingredients");
    expect(source).toContain("Replace");
    expect(source).toContain("Regenerate");
    expect(source).toContain("Add ${plan.ingredients.length}");
  });

  it("bridges both generated paths back into the existing workspace instead of a second cart", () => {
    const workspace = readFileSync(path.join(process.cwd(), "components", "cartiva-workspace.tsx"), "utf8");
    expect(workspace).toContain('commitGeneratedIngredients(ingredients, suggestedName, "plan")');
    expect(workspace).toContain('commitGeneratedIngredients(ingredients, suggestedName, "recipe")');
    expect(workspace).toContain('setCreationMode("grocery-list")');
    expect(workspace).not.toContain("separateShoppingEngine");
  });
});
