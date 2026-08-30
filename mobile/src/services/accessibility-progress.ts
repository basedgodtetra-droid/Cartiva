type ComparisonAnnouncementProgress =
  | { type: "understood"; itemCount: number }
  | { type: "location-started" }
  | { type: "location-found"; location: { name: string; chain: string } }
  | { type: "item-search"; index: number; item: string }
  | { type: "item-verified"; index: number; item: string; matched: boolean }
  | { type: "basket-checked"; matchedCount: number; requestedCount: number };

export function groceryParsingAnnouncement(itemCount: number, unresolvedCount: number): string {
  if (itemCount === 0) return "Grocery list cleared.";

  const itemLabel = `${itemCount} ${itemCount === 1 ? "item" : "items"}`;
  if (unresolvedCount > 0) {
    return `Cartiva understood ${itemLabel}. ${unresolvedCount} ${unresolvedCount === 1 ? "item needs" : "items need"} a quick detail.`;
  }
  return `Cartiva understood ${itemLabel}. All details are ready.`;
}

/**
 * Keep VoiceOver updates to stage boundaries. Per-candidate and per-item stream
 * events can arrive quickly and would otherwise interrupt each other.
 */
export function comparisonProgressAnnouncement(progress: ComparisonAnnouncementProgress): string | null {
  if (progress.type === "location-started") {
    return "List understood. Finding a nearby Kroger-family store.";
  }
  if (progress.type === "location-found") {
    const retailer = progress.location.chain?.trim() || "Kroger-family store";
    return `${retailer}, ${progress.location.name}, selected. Matching your items.`;
  }
  if (progress.type === "basket-checked") {
    const complete = progress.matchedCount === progress.requestedCount;
    return `Comparison complete. ${progress.matchedCount} of ${progress.requestedCount} items verified. Basket ${complete ? "complete" : "incomplete"}.`;
  }
  return null;
}
