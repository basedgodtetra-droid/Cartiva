export type CartivaWorkspaceContextState =
  | "empty"
  | "editing"
  | "clarifying"
  | "ready"
  | "comparing"
  | "result_incomplete"
  | "basket_ready"
  | "cart_ready";

export function getCartivaWorkspaceContext({
  itemCount,
  unresolvedCount,
  canCompare,
  comparisonPhase,
  completedItems,
  matchedCount,
  cartPhase,
  subtotalLabel,
  locationName,
}: {
  itemCount: number;
  unresolvedCount: number;
  canCompare: boolean;
  comparisonPhase: "idle" | "finding-store" | "searching" | "complete" | "error";
  completedItems: number;
  matchedCount: number;
  cartPhase: "idle" | "authorizing" | "adding" | "success" | "reviewed" | "error";
  subtotalLabel?: string;
  locationName?: string;
}): { state: CartivaWorkspaceContextState; headline: string; supporting: string } {
  if (comparisonPhase === "finding-store") {
    return {
      state: "comparing",
      headline: "Finding your Kroger store",
      supporting: "Cartiva is choosing a nearby store for one consistent basket.",
    };
  }
  if (comparisonPhase === "searching") {
    return {
      state: "comparing",
      headline: "Building your complete basket",
      supporting: `${Math.min(completedItems, itemCount)} of ${itemCount} ${itemCount === 1 ? "product" : "products"} checked${locationName ? ` at ${locationName}` : ""}.`,
    };
  }
  if (comparisonPhase === "complete") {
    if (itemCount > 0 && matchedCount === itemCount) {
      if (cartPhase === "success") {
        return {
          state: "cart_ready",
          headline: "Your Kroger cart is ready",
          supporting: `${itemCount} ${itemCount === 1 ? "item was" : "items were"} added to Kroger.`,
        };
      }
      return {
        state: "basket_ready",
        headline: "Your Kroger basket is ready",
        supporting: `${matchedCount} of ${itemCount} items matched${subtotalLabel ? ` · ${subtotalLabel}` : ""}.`,
      };
    }
    const remaining = Math.max(0, itemCount - matchedCount);
    return {
      state: "result_incomplete",
      headline: `Kroger matched ${matchedCount} of ${itemCount} items`,
      supporting: `${remaining} ${remaining === 1 ? "item needs" : "items need"} a quick review before Cartiva shows a complete total.`,
    };
  }
  if (unresolvedCount > 0) {
    return {
      state: "clarifying",
      headline: `${unresolvedCount} quick ${unresolvedCount === 1 ? "choice" : "choices"}`,
      supporting: `We understood the rest of your list. Finish ${unresolvedCount === 1 ? "this detail" : "these details"} and we'll keep going.`,
    };
  }
  if (itemCount === 0) {
    return {
      state: "empty",
      headline: "What's on your list?",
      supporting: "Add groceries however you normally write them.",
    };
  }
  if (canCompare) {
    return {
      state: "ready",
      headline: `${itemCount} ${itemCount === 1 ? "item" : "items"} ready to compare`,
      supporting: "Everything looks good. Cartiva compares complete baskets only.",
    };
  }
  return {
    state: "editing",
    headline: "Keep adding, or compare when you're ready.",
    supporting: "Add a ZIP code when you want Cartiva to check the complete basket.",
  };
}
