import { describe, expect, it } from "vitest";

import fragmentFixtureSource from "@/tests/fixtures/cartiva-item-fragment-attachment.json";
import {
  interpretGroceryInput,
  isOrphanGroceryModifier,
} from "@/packages/shared/src/grocery-notepad";

interface ExpectedFragmentItem {
  name?: string;
  detail?: string;
  canonicalText?: string;
  leanRatio?: string;
  requestedWeight?: string;
  preparation?: string;
  size?: string;
  style?: string;
  itemCountOnly?: boolean;
}

interface FragmentCase {
  id: string;
  group: "RATIO" | "EACH" | "PACKAGE" | "ATTRIBUTE" | "MIXED";
  input: string;
  tags: Array<"ITEM_FRAGMENT_ATTACHMENT" | "ORPHAN_MODIFIER">;
  expectedItems: ExpectedFragmentItem[];
}

const fixture = fragmentFixtureSource as {
  schemaVersion: number;
  suite: {
    id: string;
    requiredCases: number;
    requiredPerGroup: number;
  };
  cases: FragmentCase[];
};

describe("Cartiva item-fragment attachment reliability loop", () => {
  it("retains 100 permanent, evenly distributed parser cases", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.suite.id).toBe("cartiva-item-fragment-attachment-100");
    expect(fixture.cases).toHaveLength(100);
    expect(new Set(fixture.cases.map((testCase) => testCase.id)).size).toBe(100);
    for (const group of ["RATIO", "EACH", "PACKAGE", "ATTRIBUTE", "MIXED"] as const) {
      expect(fixture.cases.filter((testCase) => testCase.group === group)).toHaveLength(20);
    }
  });

  it.each(fixture.cases)("$id attaches modifiers without creating orphan groceries", (testCase) => {
    const result = interpretGroceryInput(testCase.input);

    expect(result.items, `${testCase.id} parsed the wrong item count`).toHaveLength(testCase.expectedItems.length);
    for (const [index, expected] of testCase.expectedItems.entries()) {
      const actual = result.items[index];
      expect(isOrphanGroceryModifier(actual.name), `${testCase.id} exposed orphan ${actual.name}`).toBe(false);
      if (expected.itemCountOnly) continue;
      if (expected.name) expect(actual.name).toBe(expected.name);
      if (expected.detail) expect(actual.detail).toBe(expected.detail);
      if (expected.canonicalText) expect(actual.canonicalText).toBe(expected.canonicalText);
      if (expected.leanRatio) expect(actual.proteinIntent?.leanRatio?.value).toBe(expected.leanRatio);
      if (expected.requestedWeight) expect(actual.proteinIntent?.weight?.value).toBe(expected.requestedWeight);
      if (expected.preparation) expect(actual.proteinIntent?.preparation?.value).toBe(expected.preparation);
      if (expected.size) expect(actual.proteinIntent?.size?.value).toBe(expected.size);
      if (expected.style) expect(actual.proteinIntent?.style?.value).toBe(expected.style);
    }
  });

  it("parses the reported ten-item list as exactly ten groceries", () => {
    const input = [
      "Large eggs, 18 count",
      "2% milk, 1 gallon",
      "White bread",
      "Chicken breast, 2 lb",
      "Ground beef, 93/7, 1 lb",
      "Bananas, 6",
      "Black beans, 3 cans",
      "Coke Zero, 12 pack",
      "Greek yogurt, 32 oz",
      "Paper towels, 6 rolls",
    ].join("\n");
    const result = interpretGroceryInput(input);

    expect(result.items.map((item) => item.canonicalText)).toEqual([
      "Large Eggs, 18 ct",
      "2% Milk, 1 gallon",
      "White Bread",
      "Chicken Breast, 2 lb",
      "Ground Beef, 93/7, 1 lb",
      "Bananas, 6 each",
      "Black Beans, 3 cans",
      "Coke Zero, 12 pack",
      "Greek Yogurt, 32 oz",
      "Paper Towels, 6 rolls",
    ]);
    expect(interpretGroceryInput(input, { undoImplicitSplits: true }).items).toHaveLength(10);
  });

  it.each(["6", "93/7", "2 lb", "18 ct", "12 pack", "3 cans"])(
    "does not let orphan modifier %s survive as a product",
    (fragment) => {
      expect(isOrphanGroceryModifier(fragment)).toBe(true);
      expect(interpretGroceryInput(fragment).items).toHaveLength(0);
    },
  );
});
