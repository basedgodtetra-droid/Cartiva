import { describe, expect, it } from "vitest";
import {
  buildCartivaComparisonRecord,
  deleteSavedList,
  duplicateSavedList,
  emptyCartivaLibrary,
  parseCartivaLibrary,
  recordComparison,
  savedProductPackageLabel,
  saveHistoricalBasket,
  serializeCartivaLibrary,
  upsertSavedPlan,
  upsertSavedList,
} from "@/lib/cartiva-library";
import { generateMealPlan, updateConsolidatedIngredient } from "@/lib/cartiva-planning";
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
  it("saves and restores an editable plan with pantry selections but no stale retailer prices", () => {
    const generated = generateMealPlan({
      notes: "High protein work meal prep",
      dailyCalories: 1800,
      proteinGrams: 160,
      budgetDollars: 80,
      days: 5,
      people: 1,
    });
    const edited = {
      ...generated,
      ingredients: updateConsolidatedIngredient(
        generated.ingredients,
        generated.ingredients[0].id,
        "My preferred ingredient",
      ),
    };
    const ownedId = edited.ingredients[1].id;
    let state = upsertSavedPlan(emptyCartivaLibrary(), {
      id: "plan-weekly",
      name: "High protein week",
      plan: edited,
      ownedIngredientIds: [ownedId, ownedId, "foreign-ingredient"],
      now,
    });
    expect(state.plans[0].ownedIngredientIds).toEqual([ownedId]);
    expect(state.activities[0]).toMatchObject({ type: "plan_saved", title: "Plan saved" });

    state = parseCartivaLibrary(serializeCartivaLibrary(state));
    expect(state.plans[0]).toMatchObject({
      id: "plan-weekly",
      name: "High protein week",
      ownedIngredientIds: [ownedId],
      createdAt: now,
    });
    expect(state.plans[0].plan.ingredients[0].name).toBe("My preferred ingredient");
    expect(JSON.stringify(state.plans[0])).not.toMatch(/upc|subtotalCents|priceProvenance/);

    state = upsertSavedPlan(state, {
      id: "plan-weekly",
      name: "Cutting plan",
      plan: state.plans[0].plan,
      ownedIngredientIds: state.plans[0].ownedIngredientIds,
      now: "2026-08-31T12:10:00.000Z",
    });
    expect(state.plans[0]).toMatchObject({
      name: "Cutting plan",
      createdAt: now,
      updatedAt: "2026-08-31T12:10:00.000Z",
    });
  });

  it("keeps version-one libraries compatible and rejects malformed saved plans", () => {
    const legacy = parseCartivaLibrary(JSON.stringify({
      ...emptyCartivaLibrary(),
      plans: undefined,
    }));
    expect(legacy.plans).toEqual([]);

    const plan = generateMealPlan({ notes: "5 cheap dinners", days: 5 });
    const malformed = upsertSavedPlan(emptyCartivaLibrary(), {
      id: "unsafe-plan",
      name: "Unsafe",
      plan,
      ownedIngredientIds: [],
      now,
    });
    (malformed.plans[0].plan.ingredients[0] as { amount: number }).amount = -1;
    malformed.plans[0].ownedIngredientIds = ["not-in-this-plan"];
    expect(parseCartivaLibrary(serializeCartivaLibrary(malformed)).plans).toEqual([]);
  });

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

  it("stores the resolved retailer package quantity and extended subtotal", () => {
    const item = { id: "pasta", raw: "Red lentil pasta 1.8 lb", name: "Red lentil pasta", canonicalText: "Red lentil pasta, 1.8 lb", status: "ready" as const };
    const multiPackage = verifiedResult("000000000020", 2.99, "Red Lentil Pasta", "12 oz box");
    multiPackage.fulfillment = {
      kind: "multi_package",
      cartQuantity: 3,
      packageCount: 3,
      requestedBaseAmount: 28.8,
      suppliedBaseAmount: 36,
      baseUnit: "oz",
      overageBaseAmount: 7.2,
      overagePercent: 25,
      label: "3 × 12 oz boxes · 36 oz total",
      approvalRequired: false,
    };
    const comparison = buildCartivaComparisonRecord({
      listName: "Meal plan",
      listSnapshot: { rawInput: item.raw, quantities: { pasta: 1 }, fulfillmentMode: "pickup", zipCode: "75201" },
      items: [item],
      quantities: { pasta: 1 },
      results: [multiPackage],
      location: { locationId: "store-1", name: "Capitol Ave", chain: "Kroger", address: { addressLine1: "4241 Capitol Ave" } },
      fulfillmentMode: "pickup",
      observedAt: now,
    });

    expect(comparison?.products[0]).toMatchObject({
      quantity: 3,
      fulfillmentLabel: "3 × 12 oz boxes · 36 oz total",
      unitPriceCents: 299,
      lineTotalCents: 897,
    });
    expect(savedProductPackageLabel(comparison!.products[0])).toBe("3 × 12 oz boxes · 36 oz total");
    expect(comparison?.subtotalCents).toBe(897);
  });

  it("keeps older saved baskets readable and includes their resolved package quantity", () => {
    const item = { id: "beef", raw: "Ground beef 3 lb", name: "Ground beef", canonicalText: "Ground beef, 3 lb", status: "ready" as const };
    const multiPackage = verifiedResult("000000000030", 5.49, "Ground Beef", "1 lb");
    multiPackage.fulfillment = {
      kind: "multi_package",
      cartQuantity: 3,
      packageCount: 3,
      requestedBaseAmount: 48,
      suppliedBaseAmount: 48,
      baseUnit: "oz",
      overageBaseAmount: 0,
      overagePercent: 0,
      label: "3 × 1 lb packages · 3 lb total",
      approvalRequired: false,
    };
    const comparison = buildCartivaComparisonRecord({
      listName: "Cookout",
      listSnapshot: { rawInput: item.raw, quantities: {}, fulfillmentMode: "pickup", zipCode: "75201" },
      items: [item],
      quantities: {},
      results: [multiPackage],
      location: { locationId: "store-1", name: "Capitol Ave", chain: "Kroger", address: { addressLine1: "4241 Capitol Ave" } },
      fulfillmentMode: "pickup",
      observedAt: now,
    });
    const saved = saveHistoricalBasket(emptyCartivaLibrary(), comparison!, "2026-08-31T12:10:00.000Z");
    const legacy = structuredClone(saved);
    delete legacy.baskets[0].products[0].fulfillmentLabel;

    const reloaded = parseCartivaLibrary(serializeCartivaLibrary(legacy));
    expect(reloaded.baskets).toHaveLength(1);
    expect(savedProductPackageLabel(reloaded.baskets[0].products[0])).toBe("3 × 1 lb");
    expect(reloaded.baskets[0].products[0].lineTotalCents).toBe(1_647);
  });

  it("fails closed on corrupt or unsupported local data", () => {
    expect(parseCartivaLibrary("not json")).toEqual(emptyCartivaLibrary());
    expect(parseCartivaLibrary(JSON.stringify({ version: 99, lists: [{ id: "unsafe" }] }))).toEqual(emptyCartivaLibrary());
  });
});
