import { describe, expect, it } from "vitest";
import {
  buildKrogerCartLines,
  blockPendingKrogerCart,
  createPendingKrogerCart,
  getKrogerCartReadiness,
  markPendingKrogerCartRetryable,
  markPendingKrogerCartSubmitting,
  parsePendingKrogerCart,
  pendingKrogerCartMatches,
  resolvedKrogerCartQuantity,
} from "@/lib/cartiva-kroger-cart";
import type { GroceryNotepadItem } from "@/lib/grocery-notepad";
import type { KrogerMatchResult, KrogerProduct } from "@/lib/types";

function item(id: string): GroceryNotepadItem {
  return {
    id,
    raw: id,
    name: id,
    canonicalText: id,
    status: "ready",
  };
}

function result(upc: string, cartEligible = true): KrogerMatchResult {
  const product = {
    retailer: "kroger",
    id: upc,
    productId: upc,
    upc,
    title: `Kroger product ${upc}`,
    price: 3.49,
    priceCents: 349,
    link: `https://www.kroger.com/p/product/${upc}`,
    linkType: "product",
    seller: "Kroger",
    inStock: true,
    availabilityStatus: "in_stock",
    sponsored: false,
    checkedAt: "2026-08-31T20:00:00.000Z",
    verification: "verified",
    verificationIssues: [],
    cartEligible,
    dataSource: "kroger_public_api",
    identityVerified: true,
    priceProvenance: {
      retailer: "kroger",
      priceSource: "kroger_location_product",
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified: true,
      locationId: "01400912",
      location: {
        requestedStoreId: "01400912",
        observedStoreId: "01400912",
        responseProvesLocation: true,
        storeMatched: true,
      },
      fulfillment: ["pickup"],
      checkedAt: "2026-08-31T20:00:00.000Z",
    },
    score: 100,
    confidence: "high",
    comparablePrice: 3.49,
    matchedTerms: [],
    reasons: [],
  } satisfies KrogerProduct & {
    score: number;
    confidence: "high";
    comparablePrice: number;
    matchedTerms: string[];
    reasons: string[];
  };
  return {
    retailer: "kroger",
    requestedItem: product.title,
    recommended: product,
    alternatives: [],
    confidence: "high",
    status: "matched",
    explanation: "Verified exact-store match.",
  };
}

const items = [item("eggs"), item("milk"), item("bread"), item("soda"), item("yogurt")];
const results = [
  result("0001111011111"),
  result("0001111022222"),
  result("0001111033333"),
  result("0001111044444"),
  result("0001111055555"),
];

describe("Cartiva Kroger cart readiness", () => {
  it("enables a complete five-line basket without requiring a prior customer connection", () => {
    expect(getKrogerCartReadiness({
      items,
      results,
      quantities: Object.fromEntries(items.map((entry) => [entry.id, 1])),
      comparisonComplete: true,
      customerConnected: false,
      cartCapability: true,
    })).toMatchObject({
      basketComplete: true,
      acceptedLineCount: 5,
      cartEligibleLineCount: 5,
      upcLineCount: 5,
      quantitiesValid: true,
      customerConnected: false,
      canAddToKroger: true,
    });
  });

  it("keeps comparison available but disables transfer when the deployment has no cart capability", () => {
    const readiness = getKrogerCartReadiness({
      items,
      results,
      quantities: Object.fromEntries(items.map((entry) => [entry.id, 1])),
      comparisonComplete: true,
      customerConnected: false,
      cartCapability: false,
    });
    expect(readiness).toMatchObject({ basketComplete: true, canAddToKroger: false });
    expect(readiness.reason).toMatch(/transfer is unavailable/i);
  });

  it.each([
    ["likely available", "likely_available" as const],
    ["unknown availability", "unknown" as const],
  ])("retains a %s match but excludes it from readiness and cart lines", (_label, availabilityStatus) => {
    const retained = result("0001111011111");
    retained.recommended!.availabilityStatus = availabilityStatus;
    retained.recommended!.inStock = false;
    retained.resolution = "matched_check_availability";

    expect(buildKrogerCartLines([items[0]], [retained], { eggs: 1 })).toEqual([]);
    expect(getKrogerCartReadiness({
      items: [items[0]],
      results: [retained],
      quantities: { eggs: 1 },
      comparisonComplete: true,
    })).toMatchObject({
      basketComplete: false,
      acceptedLineCount: 0,
      cartEligibleLineCount: 0,
      canAddToKroger: false,
    });
  });

  it("requires approval before a verified package plan can become a handoff line", () => {
    const approvalRequired = result("0001111011111");
    approvalRequired.fulfillment = {
      kind: "variable_weight",
      cartQuantity: 1,
      packageCount: 1,
      label: "1 variable-weight package",
      approvalRequired: true,
    };

    expect(buildKrogerCartLines([items[0]], [approvalRequired], { eggs: 1 })).toEqual([]);
    expect(getKrogerCartReadiness({
      items: [items[0]],
      results: [approvalRequired],
      quantities: { eggs: 1 },
      comparisonComplete: true,
    })).toMatchObject({ basketComplete: false, acceptedLineCount: 0, canAddToKroger: false });
  });

  it("explains a missing cart UPC without logging or inventing one", () => {
    const missingUpc = result("0001111055555");
    missingUpc.recommended!.upc = "";
    const readiness = getKrogerCartReadiness({
      items,
      results: [...results.slice(0, 4), missingUpc],
      quantities: Object.fromEntries(items.map((entry) => [entry.id, 1])),
      comparisonComplete: true,
    });
    expect(readiness).toMatchObject({ upcLineCount: 4, canAddToKroger: false });
    expect(readiness.reason).toMatch(/missing its cart UPC/i);
  });

  it("preserves exact UPC strings and aggregates duplicate product quantities", () => {
    const duplicate = result("0001111011111");
    expect(buildKrogerCartLines(
      items,
      [results[0], duplicate, ...results.slice(2)],
      { eggs: 2, milk: 3, bread: 1, soda: 2, yogurt: 1 },
    )).toEqual([
      { upc: "0001111011111", quantity: 5 },
      { upc: "0001111033333", quantity: 1 },
      { upc: "0001111044444", quantity: 2 },
      { upc: "0001111055555", quantity: 1 },
    ]);
  });

  it("uses the matcher's resolved package quantity for totals and Kroger handoff", () => {
    const pasta = item("pasta");
    const multiPackage = result("0001111066666");
    multiPackage.resolution = "multi_package_fulfillment";
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

    expect(resolvedKrogerCartQuantity(multiPackage, 1)).toBe(3);
    expect(buildKrogerCartLines(
      [pasta],
      [multiPackage],
      { pasta: 1 },
    )).toEqual([{ upc: "0001111066666", quantity: 3 }]);
    expect(getKrogerCartReadiness({
      items: [pasta],
      results: [multiPackage],
      quantities: { pasta: 1 },
      comparisonComplete: true,
    })).toMatchObject({ quantitiesValid: true, canAddToKroger: true });
  });

  it("fails quantity validation when a returned fulfillment plan is malformed", () => {
    const pasta = item("pasta");
    const malformed = result("0001111066666");
    malformed.fulfillment = {
      kind: "multi_package",
      cartQuantity: 100,
      packageCount: 100,
      label: "100 packages",
      approvalRequired: false,
    };

    expect(resolvedKrogerCartQuantity(malformed, 1)).toBeUndefined();
    expect(getKrogerCartReadiness({
      items: [pasta],
      results: [malformed],
      quantities: { pasta: 1 },
      comparisonComplete: true,
    })).toMatchObject({ quantitiesValid: false, canAddToKroger: false });
  });

  it("fails closed when duplicate UPC quantities aggregate past Kroger's limit", () => {
    const duplicate = result("0001111011111");
    const overflowResults = [results[0], duplicate, ...results.slice(2)];
    const overflowQuantities = { eggs: 60, milk: 40, bread: 1, soda: 1, yogurt: 1 };

    expect(getKrogerCartReadiness({
      items,
      results: overflowResults,
      quantities: overflowQuantities,
      comparisonComplete: true,
    })).toMatchObject({ quantitiesValid: false, canAddToKroger: false });
    expect(buildKrogerCartLines(items, overflowResults, overflowQuantities)).toEqual([]);
  });

  it("accepts an aggregated UPC quantity at the exact limit", () => {
    const duplicate = result("0001111011111");
    expect(buildKrogerCartLines(
      [item("first"), item("second")],
      [results[0], duplicate],
      { first: 49, second: 50 },
    )).toEqual([{ upc: "0001111011111", quantity: 99 }]);
  });
});

describe("pending Kroger basket", () => {
  it("round-trips the exact basket that must continue after OAuth", () => {
    const pending = createPendingKrogerCart({
      operationId: "cartiva_1234567890abcdef",
      locationId: "01400912",
      fulfillmentMode: "pickup",
      items: buildKrogerCartLines(
        items,
        results,
        Object.fromEntries(items.map((entry) => [entry.id, 1])),
      ),
      itemCount: 5,
      comparisonId: "comparison_123",
      createdAt: 1_000_000,
    });
    expect(parsePendingKrogerCart(JSON.stringify(pending), 1_000_001)).toEqual(pending);
  });

  it("rejects expired, malformed, or duplicate-UPC pending payloads", () => {
    const pending = createPendingKrogerCart({
      operationId: "cartiva_1234567890abcdef",
      locationId: "01400912",
      fulfillmentMode: "pickup",
      items: [{ upc: "0001111011111", quantity: 1 }],
      itemCount: 1,
      createdAt: 1_000_000,
    });
    expect(parsePendingKrogerCart(JSON.stringify(pending), 2_000_000)).toBeNull();
    expect(parsePendingKrogerCart(JSON.stringify({
      ...pending,
      items: [...pending.items, ...pending.items],
    }), 1_000_001)).toBeNull();
    expect(parsePendingKrogerCart(JSON.stringify({
      ...pending,
      items: [{ upc: "0001111011111", quantity: 100 }],
    }), 1_000_001)).toBeNull();
    expect(parsePendingKrogerCart("not-json", 1_000_001)).toBeNull();
  });

  it("resumes only a basket carrying an explicit shopper transfer intent", () => {
    const pending = createPendingKrogerCart({
      operationId: "cartiva_1234567890abcdef",
      locationId: "01400912",
      fulfillmentMode: "pickup",
      items: [{ upc: "0001111011111", quantity: 1 }],
      itemCount: 1,
      createdAt: 1_000_000,
    });
    expect(pending.intent).toBe("shopper_transfer");
    const withoutIntent: Partial<typeof pending> = { ...pending };
    delete withoutIntent.intent;
    expect(parsePendingKrogerCart(JSON.stringify(withoutIntent), 1_000_001)).toBeNull();
  });

  it("reuses an operation only when its exact frozen basket still matches", () => {
    const pending = createPendingKrogerCart({
      operationId: "cartiva_1234567890abcdef",
      locationId: "01400912",
      fulfillmentMode: "pickup",
      items: [{ upc: "0001111011111", quantity: 2 }],
      itemCount: 1,
      createdAt: 1_000_000,
    });
    expect(pendingKrogerCartMatches(pending, {
      locationId: "01400912",
      fulfillmentMode: "pickup",
      items: [{ upc: "0001111011111", quantity: 2 }],
      itemCount: 1,
    })).toBe(true);
    expect(pendingKrogerCartMatches(pending, {
      locationId: "01400912",
      fulfillmentMode: "pickup",
      items: [{ upc: "0001111011111", quantity: 3 }],
      itemCount: 1,
    })).toBe(false);
  });

  it("persists an uncertain outcome as a blocked operation across reloads", () => {
    const pending = createPendingKrogerCart({
      operationId: "cartiva_1234567890abcdef",
      locationId: "01400912",
      fulfillmentMode: "pickup",
      items: [{ upc: "0001111011111", quantity: 1 }],
      itemCount: 1,
      createdAt: 1_000_000,
    });
    const submitting = markPendingKrogerCartSubmitting(pending, 1_000_050);
    const blocked = blockPendingKrogerCart(
      submitting,
      "Check the retailer cart before trying again.",
      1_000_100,
    );
    expect(parsePendingKrogerCart(JSON.stringify(blocked), 1_000_101)).toEqual(blocked);
    expect(blocked.operationId).toBe(pending.operationId);
    expect(blocked.submittedAt).toBe(1_000_050);
    expect(blocked.blocked).toMatchObject({ code: "outcome_unknown" });
    expect(parsePendingKrogerCart(JSON.stringify(blocked), 9_000_000)).toEqual(blocked);
    expect(markPendingKrogerCartRetryable(submitting)).toMatchObject({
      operationId: pending.operationId,
      submittedAt: undefined,
      blocked: undefined,
    });
  });
});
