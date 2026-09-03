import { describe, expect, it } from "vitest";

import type {
  KrogerMatchResult,
  RankedKrogerProduct,
} from "@/mobile/src/services/cartiva-api";
import { applyKrogerAlternativeSelection } from "@/mobile/src/state/kroger-alternative-selection";

const checkedAt = "2026-09-02T15:00:00.000Z";

function product(id: string, ounces: number): RankedKrogerProduct {
  return {
    retailer: "kroger",
    id,
    productId: id,
    upc: id,
    title: `Red lentil pasta ${ounces} oz`,
    price: 3.99,
    priceCents: 399,
    link: `https://www.kroger.com/p/red-lentil-pasta/${id}`,
    linkType: "product",
    size: {
      amount: ounces,
      unit: "oz",
      kind: "weight",
      baseAmount: ounces,
      baseUnit: "oz",
      label: `${ounces} oz`,
    },
    checkedAt,
    inStock: true,
    availabilityStatus: "in_stock",
    cartEligible: true,
    dataSource: "kroger_public_api",
    confidence: "high",
    score: 95,
    reasons: ["Verified red lentil pasta"],
    priceProvenance: {
      regularPriceCents: 399,
      locationId: "62000115",
      locationName: "King Soopers",
      chain: "KINGSOOPERS",
      checkedAt,
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified: true,
      fulfillment: ["pickup"],
    },
  };
}

function match(): KrogerMatchResult {
  return {
    retailer: "kroger",
    requestedItem: "2 x red lentil pasta 12 oz",
    recommended: product("0001111011111", 12),
    alternatives: [],
    confidence: "high",
    status: "matched",
    resolution: "multi_package_fulfillment",
    fulfillment: {
      kind: "multi_package",
      cartQuantity: 2,
      packageCount: 2,
      requestedBaseAmount: 24,
      suppliedBaseAmount: 24,
      baseUnit: "oz",
      overageBaseAmount: 0,
      overagePercent: 0,
      label: "2 × 12 oz boxes · 24 oz total",
      approvalRequired: false,
    },
    explanation: "Two 12 oz packages fulfill the request.",
    verifiedAt: checkedAt,
  };
}

describe("mobile Kroger alternative selection", () => {
  it("keeps a 12 oz to 16 oz selection in review until quantity is recomputed", () => {
    const selected = applyKrogerAlternativeSelection(
      match(),
      product("0001111022222", 16),
    );

    expect(selected).toMatchObject({
      status: "review",
      resolution: "needs_choice",
      recommended: { id: "0001111022222", size: { label: "16 oz" } },
    });
    expect(selected.fulfillment).toBeUndefined();
    expect(selected.clarification).toMatch(/compare again/i);
  });

  it("preserves the verified cart quantity for an equivalent package size", () => {
    const selected = applyKrogerAlternativeSelection(
      match(),
      product("0001111033333", 12),
    );

    expect(selected).toMatchObject({
      status: "matched",
      resolution: "multi_package_fulfillment",
      fulfillment: { cartQuantity: 2, approvalRequired: false },
    });
  });
});
