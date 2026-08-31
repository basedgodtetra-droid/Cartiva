import { describe, expect, it } from "vitest";
import {
  buildCartivaComparisonRecord,
  deleteSavedList,
  duplicateSavedList,
  emptyCartivaLibrary,
  parseCartivaLibrary,
  recordComparison,
  saveHistoricalBasket,
  serializeCartivaLibrary,
  upsertSavedList,
} from "@/lib/cartiva-library";
import type { KrogerMatchResult } from "@/lib/types";

const now = "2026-08-31T12:00:00.000Z";

function verifiedResult(upc: string, price: number, title: string, packageLabel: string): KrogerMatchResult {
  return {
    retailer: "kroger",
    requestedItem: title,
    recommended: {
      retailer: "kroger",
      id: upc,
      productId: upc,
      upc,
      title,
      price,
      priceCents: Math.round(price * 100),
      link: `https://www.kroger.com/p/${upc}`,
      inStock: true,
      sponsored: false,
      size: {
        amount: 1,
        unit: "count",
        kind: "count",
        baseAmount: 1,
        baseUnit: "each",
        label: packageLabel,
      },
      priceProvenance: {
        retailer: "kroger",
        priceSource: "kroger_location_product",
        priceScope: "exact_store",
        priceReliability: "verified",
        exactStoreVerified: true,
        locationId: "store-1",
        location: {
          requestedStoreId: "store-1",
          observedStoreId: "store-1",
          responseProvesLocation: true,
          storeMatched: true,
        },
        fulfillment: ["pickup"],
        checkedAt: now,
      },
      dataSource: "kroger_public_api",
      identityVerified: true,
      availabilityStatus: "in_stock",
      cartEligible: true,
      score: 10,
      confidence: "high",
      comparablePrice: price,
      matchedTerms: [],
      reasons: [],
    },
    alternatives: [],
    confidence: "high",
    status: "matched",
    explanation: "Verified exact-store match.",
  };
}

describe("Cartiva local library", () => {
  it("saves, reloads, duplicates, renames, and deletes a five-item list", () => {
    const rawInput = "eggs\nmilk\nbread\nCoke Zero\nGreek yogurt";
    let state = upsertSavedList(emptyCartivaLibrary(), {
      id: "list-weekly",
      name: "Weekly groceries",
      snapshot: { rawInput, quantities: {}, fulfillmentMode: "pickup", zipCode: "75201" },
      itemCount: 5,
      now,
    });
    state = parseCartivaLibrary(serializeCartivaLibrary(state));
    expect(state.lists[0]).toMatchObject({ name: "Weekly groceries", itemCount: 5, rawInput });

    state = duplicateSavedList(state, "list-weekly", "list-copy", "2026-08-31T12:05:00.000Z");
    expect(state.lists[0]).toMatchObject({ id: "list-copy", name: "Weekly groceries copy", itemCount: 5 });

    state = upsertSavedList(state, {
      id: "list-copy",
      name: "Meal prep",
      snapshot: state.lists[0],
      itemCount: 5,
      now: "2026-08-31T12:06:00.000Z",
    });
    expect(state.lists[0].name).toBe("Meal prep");
    expect(deleteSavedList(state, "list-copy").lists.some((list) => list.id === "list-copy")).toBe(false);
  });

  it("records only official exact-store observations and keeps package sizes separate", () => {
    const items = [
      { id: "eggs", raw: "eggs 18 count", name: "Eggs", detail: "18 ct", canonicalText: "eggs, 18 ct", status: "ready" as const },
      { id: "milk", raw: "2% milk gallon", name: "2% Milk", detail: "1 gallon", canonicalText: "2% milk, 1 gallon", status: "ready" as const },
    ];
    const comparison = buildCartivaComparisonRecord({
      listName: "Weekly groceries",
      listSnapshot: { rawInput: items.map((item) => item.raw).join("\n"), quantities: {}, fulfillmentMode: "pickup", zipCode: "75201" },
      items,
      quantities: {},
      results: [
        verifiedResult("000000000001", 5.49, "Large eggs", "18 count"),
        verifiedResult("000000000002", 4.29, "2% milk", "1 gallon"),
      ],
      location: { locationId: "store-1", name: "Capitol Ave", chain: "Kroger", address: { addressLine1: "4241 Capitol Ave" } },
      fulfillmentMode: "pickup",
      observedAt: now,
    });
    expect(comparison).not.toBeNull();
    let state = recordComparison(emptyCartivaLibrary(), comparison!);
    state = recordComparison(state, comparison!);
    expect(state.basketHistory).toHaveLength(1);
    expect(state.productHistory).toHaveLength(2);
    expect(new Set(state.productHistory.map((item) => `${item.upc}|${item.packageLabel}`)).size).toBe(2);
  });

  it("stores saved baskets as historical results with their verified snapshot", () => {
    const item = { id: "eggs", raw: "eggs 18 count", name: "Eggs", detail: "18 ct", canonicalText: "eggs, 18 ct", status: "ready" as const };
    const comparison = buildCartivaComparisonRecord({
      listName: "Weekly groceries",
      listSnapshot: { rawInput: item.raw, quantities: {}, fulfillmentMode: "pickup", zipCode: "75201" },
      items: [item],
      quantities: {},
      results: [verifiedResult("000000000001", 5.49, "Large eggs", "18 count")],
      location: { locationId: "store-1", name: "Capitol Ave", chain: "Kroger", address: { addressLine1: "4241 Capitol Ave" } },
      fulfillmentMode: "pickup",
      observedAt: now,
    });
    const state = saveHistoricalBasket(emptyCartivaLibrary(), comparison!, "2026-08-31T12:10:00.000Z");
    expect(state.baskets[0]).toMatchObject({ historical: true, subtotalCents: 549, locationId: "store-1" });
    expect(state.baskets[0].products[0]).toMatchObject({ upc: "000000000001", packageLabel: "18 count" });
  });

  it("uses Kroger's authoritative integer cents and rejects another store's evidence", () => {
    const item = { id: "coffee", raw: "coffee", name: "Coffee", canonicalText: "coffee", status: "ready" as const };
    const verified = verifiedResult("000000000010", 14.969, "Ground coffee", "30 oz");
    const comparison = buildCartivaComparisonRecord({
      listName: "Weekly groceries",
      listSnapshot: { rawInput: item.raw, quantities: { coffee: 2 }, fulfillmentMode: "pickup", zipCode: "75201" },
      items: [item],
      quantities: { coffee: 2 },
      results: [verified],
      location: { locationId: "store-1", name: "Capitol Ave", chain: "Kroger", address: { addressLine1: "4241 Capitol Ave" } },
      fulfillmentMode: "pickup",
      observedAt: now,
    });
    expect(comparison?.subtotalCents).toBe(2_994);

    const wrongStore = structuredClone(verified);
    if (wrongStore.recommended) {
      wrongStore.recommended.priceProvenance.locationId = "store-2";
      wrongStore.recommended.priceProvenance.location.observedStoreId = "store-2";
    }
    expect(buildCartivaComparisonRecord({
      listName: "Weekly groceries",
      listSnapshot: { rawInput: item.raw, quantities: {}, fulfillmentMode: "pickup", zipCode: "75201" },
      items: [item],
      quantities: {},
      results: [wrongStore],
      location: { locationId: "store-1", name: "Capitol Ave", chain: "Kroger", address: { addressLine1: "4241 Capitol Ave" } },
      fulfillmentMode: "pickup",
      observedAt: now,
    })).toBeNull();
  });

  it("fails closed on corrupt or unsupported local data", () => {
    expect(parseCartivaLibrary("not json")).toEqual(emptyCartivaLibrary());
    expect(parseCartivaLibrary(JSON.stringify({ version: 99, lists: [{ id: "unsafe" }] }))).toEqual(emptyCartivaLibrary());
  });
});
