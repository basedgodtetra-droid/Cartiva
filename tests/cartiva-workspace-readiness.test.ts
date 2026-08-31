import { describe, expect, it } from "vitest";
import { getCompareReadiness } from "@/lib/cartiva-workspace-readiness";

function readiness(overrides: Partial<Parameters<typeof getCompareReadiness>[0]> = {}) {
  return getCompareReadiness({
    itemCount: 5,
    unresolvedCount: 0,
    limitReached: false,
    zipInput: "75201",
    resolvedZip: "75201",
    selectedLocationId: "03500529",
    ...overrides,
  });
}

describe("Cartiva workspace comparison readiness", () => {
  it("requires at least one real grocery item", () => {
    expect(readiness({ itemCount: 0 })).toMatchObject({
      canCompare: false,
      reason: "Add at least one grocery item to continue.",
    });
  });

  it("requires an exact five-digit ZIP", () => {
    expect(readiness({ zipInput: "7520", resolvedZip: "" })).toMatchObject({
      canCompare: false,
      zipValid: false,
      reason: "Enter a valid 5-digit ZIP code.",
    });
  });

  it("does not reuse a store resolved for a different ZIP", () => {
    expect(readiness({ resolvedZip: "10001" })).toMatchObject({
      canCompare: false,
      storeSelected: false,
      reason: "Find and choose a nearby store to continue.",
    });
  });

  it("explains unresolved grocery clarifications", () => {
    expect(readiness({ unresolvedCount: 2 })).toMatchObject({
      canCompare: false,
      clarificationsRemaining: 2,
      reason: "2 items need a quick choice.",
    });
  });

  it("enables comparison only when every prerequisite is satisfied", () => {
    expect(readiness()).toMatchObject({
      canCompare: true,
      itemsReady: true,
      zipValid: true,
      storeSelected: true,
      clarificationsRemaining: 0,
      reason: "Ready to compare the complete basket.",
    });
  });
});
