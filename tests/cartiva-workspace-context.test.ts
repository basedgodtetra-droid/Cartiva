import { describe, expect, it } from "vitest";
import { getCartivaWorkspaceContext } from "@/lib/cartiva-workspace-context";

const base = {
  itemCount: 0,
  unresolvedCount: 0,
  canCompare: false,
  comparisonPhase: "idle" as const,
  completedItems: 0,
  matchedCount: 0,
  cartPhase: "idle" as const,
};

describe("Cartiva workspace context", () => {
  it("starts with a direct grocery-list prompt", () => {
    expect(getCartivaWorkspaceContext(base)).toEqual({
      state: "empty",
      headline: "What's on your list?",
      supporting: "Add groceries however you normally write them.",
    });
  });

  it("prioritizes inline clarification before comparison", () => {
    expect(getCartivaWorkspaceContext({ ...base, itemCount: 5, unresolvedCount: 2 })).toMatchObject({
      state: "clarifying",
      headline: "2 quick choices",
    });
  });

  it("reports real comparison progress without inventing a percentage", () => {
    const context = getCartivaWorkspaceContext({
      ...base,
      itemCount: 5,
      comparisonPhase: "searching",
      completedItems: 3,
      locationName: "Mockingbird Kroger",
    });
    expect(context).toMatchObject({ state: "comparing", headline: "Building your complete basket" });
    expect(context.supporting).toContain("3 of 5 products checked");
    expect(context.supporting).not.toContain("%");
  });

  it("keeps the basket result distinct from retailer-confirmed cart success", () => {
    expect(getCartivaWorkspaceContext({
      ...base,
      itemCount: 5,
      comparisonPhase: "complete",
      completedItems: 5,
      matchedCount: 5,
      subtotalLabel: "$43.72",
    })).toEqual({
      state: "basket_ready",
      headline: "Your Kroger basket is ready",
      supporting: "5 of 5 items matched · $43.72.",
    });
    expect(getCartivaWorkspaceContext({
      ...base,
      itemCount: 5,
      comparisonPhase: "complete",
      completedItems: 5,
      matchedCount: 5,
      cartPhase: "success",
    })).toMatchObject({ state: "cart_ready", headline: "Your Kroger cart is ready" });
  });
});
