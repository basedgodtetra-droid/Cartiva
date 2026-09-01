import { describe, expect, it } from "vitest";
import { interpretGroceryInput } from "@/lib/grocery-notepad";
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

  it("does not reuse a store resolved for a different ZIP but can resolve one during comparison", () => {
    expect(readiness({ resolvedZip: "10001" })).toMatchObject({
      canCompare: true,
      storeSelected: false,
      reason: "Ready — Cartiva will choose a nearby store.",
    });
  });

  it("can begin from a valid ZIP and choose a nearby returned store automatically", () => {
    expect(readiness({ resolvedZip: "", selectedLocationId: "" })).toMatchObject({
      canCompare: true,
      storeSelected: false,
      reason: "Ready — Cartiva will choose a nearby store.",
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

  it("accepts the requested five-item test basket and enables it after store resolution", () => {
    const parsed = interpretGroceryInput([
      "Large eggs, 18 count",
      "2% milk, 1 gallon",
      "White bread",
      "Coke Zero, 12 pack",
      "Greek yogurt, 32 oz",
    ].join("\n"));

    expect(parsed).toMatchObject({
      readyCount: 5,
      unresolvedCount: 0,
      limitReached: false,
      omittedCount: 0,
    });
    expect(parsed.items).toHaveLength(5);
    expect(getCompareReadiness({
      itemCount: parsed.items.length,
      unresolvedCount: parsed.unresolvedCount,
      limitReached: parsed.limitReached,
      zipInput: "80202",
      resolvedZip: "80202",
      selectedLocationId: "62000115",
    })).toMatchObject({
      canCompare: true,
      itemsReady: true,
      zipValid: true,
      storeSelected: true,
      clarificationsRemaining: 0,
      reason: "Ready to compare the complete basket.",
    });
  });
});
