import { describe, expect, it } from "vitest";
import {
  AUTO_COMPARE_LIST_DEBOUNCE_MS,
  AUTO_COMPARE_MIN_START_INTERVAL_MS,
  automaticComparisonDelay,
  automaticComparisonKey,
  automaticRetailerReady,
  automaticallySelectedStore,
  shouldStartAutomaticComparison,
} from "../src/auto-comparison";
import type { ComparisonRetailerContext } from "../src/comparison";
import type { ParsedListItem, Retailer } from "../src/types";

const request: ParsedListItem = {
  id: "eggs",
  text: "eggs",
  normalizedText: "eggs",
  quantity: 1,
};

const contexts: Record<Retailer, ComparisonRetailerContext> = {
  walmart: { fulfillmentMode: "delivery", storeId: "3014", zip: "79912" },
  target: { fulfillmentMode: "delivery", zip: "79912" },
  kroger: { fulfillmentMode: "delivery", storeId: "70500576", zip: "79912" },
};

describe("automatic ZIP-first comparison", () => {
  it("allows Target to participate as a ZIP-localized estimate without a store ID", () => {
    expect(automaticRetailerReady("target", contexts.target)).toBe(true);
  });

  it("still requires automatically resolved store IDs for Walmart and Kroger", () => {
    expect(automaticRetailerReady("walmart", { fulfillmentMode: "delivery", zip: "79912" })).toBe(false);
    expect(automaticRetailerReady("kroger", { fulfillmentMode: "delivery", zip: "79912" })).toBe(false);
  });

  it("does not start when both store directories fail and Target is the only ready retailer", () => {
    const failedContexts: Record<Retailer, ComparisonRetailerContext> = {
      walmart: { fulfillmentMode: "delivery", zip: "79912" },
      target: { fulfillmentMode: "delivery", zip: "79912" },
      kroger: { fulfillmentMode: "delivery", zip: "79912" },
    };
    expect((Object.keys(failedContexts) as Retailer[])
      .filter((retailer) => automaticRetailerReady(retailer, failedContexts[retailer]))).toEqual(["target"]);
  });

  it("keeps a valid saved same-ZIP store, otherwise selects the provider default", () => {
    const stores = [{ id: "default", zip: "79912" }, { id: "saved", zip: "79912" }];
    const saved = { id: "saved", zip: "79912" };
    expect(automaticallySelectedStore(stores, saved, "79912")).toBe(stores[1]);
    expect(automaticallySelectedStore(stores, saved, "79913")).toBe(stores[0]);
    expect(automaticallySelectedStore(stores, { id: "stale", zip: "79912" }, "79912")).toBe(stores[0]);
  });

  it("dedupes by the complete list and context signature", () => {
    const original = automaticComparisonKey([request], contexts);
    expect(automaticComparisonKey([{ ...request, quantity: 2 }], contexts)).not.toBe(original);
    expect(automaticComparisonKey([request], {
      ...contexts,
      walmart: { ...contexts.walmart, storeId: "3015" },
    })).not.toBe(original);
  });

  it("debounces list edits and enforces a minimum interval between starts", () => {
    expect(automaticComparisonDelay(10_000, 0)).toBe(AUTO_COMPARE_LIST_DEBOUNCE_MS);
    expect(automaticComparisonDelay(10_000, 9_900)).toBe(AUTO_COMPARE_MIN_START_INTERVAL_MS - 100);
  });

  it("does not refire the same current or in-flight list-and-context signature", () => {
    expect(shouldStartAutomaticComparison("same", "same", undefined)).toBe(false);
    expect(shouldStartAutomaticComparison("same", undefined, "same")).toBe(false);
    expect(shouldStartAutomaticComparison("new", "old", undefined)).toBe(true);
  });
});
