import { describe, expect, it } from "vitest";
import {
  comparisonProgressAnnouncement,
  groceryParsingAnnouncement,
} from "../mobile/src/services/accessibility-progress";

describe("mobile VoiceOver progress copy", () => {
  it("announces stable grocery interpretation summaries", () => {
    expect(groceryParsingAnnouncement(4, 0))
      .toBe("Cartiva understood 4 items. All details are ready.");
    expect(groceryParsingAnnouncement(2, 1))
      .toBe("Cartiva understood 2 items. 1 item needs a quick detail.");
    expect(groceryParsingAnnouncement(0, 0)).toBe("Grocery list cleared.");
  });

  it("announces comparison stage boundaries but not noisy item stream events", () => {
    expect(comparisonProgressAnnouncement({ type: "location-started" }))
      .toContain("Finding a nearby");
    expect(comparisonProgressAnnouncement({
      type: "location-found",
      location: {
        name: "Union Station",
        chain: "King Soopers",
      },
    })).toBe("King Soopers, Union Station, selected. Matching your items.");
    expect(comparisonProgressAnnouncement({
      type: "item-search",
      index: 0,
      item: "Milk",
    })).toBeNull();
    expect(comparisonProgressAnnouncement({
      type: "item-verified",
      index: 0,
      item: "Milk",
      matched: true,
    })).toBeNull();
    expect(comparisonProgressAnnouncement({
      type: "basket-checked",
      matchedCount: 3,
      requestedCount: 4,
    })).toContain("Basket incomplete");
  });
});
