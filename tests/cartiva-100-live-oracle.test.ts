import { describe, expect, it } from "vitest";

import type {
  KrogerMatchResult,
  KrogerProduct,
  Measurement,
  RankedKrogerProduct,
  RetailPackageFulfillment,
} from "@/lib/types";
import {
  cartiva100LiveCaseDisposition,
  cartiva100LiveFulfillmentFailure,
  cartiva100LiveIndependentCandidateReady,
  cartiva100LiveOracleFailure,
  formatCartiva100LiveReport,
  selectedMetadata,
} from "@/tests/support/cartiva-100-live";
import { cartiva100LiveCases } from "@/tests/support/cartiva-100";
import { parseProductIntent } from "@/lib/product-search-intent";

function product(overrides: Partial<KrogerProduct> = {}): KrogerProduct {
  return {
    retailer: "kroger",
    id: "live-oracle-product",
    productId: "live-oracle-product",
    upc: "0001111000999",
    title: "Kroger Product",
    price: 3.49,
    priceCents: 349,
    link: "https://www.kroger.com/p/product/0001111000999",
    inStock: true,
    availabilityStatus: "in_stock",
    sponsored: false,
    cartEligible: true,
    dataSource: "kroger_public_api",
    identityVerified: true,
    priceProvenance: {
      retailer: "kroger",
      priceSource: "kroger_location_product",
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified: true,
      locationId: "03500529",
      location: {
        requestedStoreId: "03500529",
        observedStoreId: "03500529",
        responseProvesLocation: true,
        storeMatched: true,
      },
      fulfillment: ["pickup"],
    },
    ...overrides,
  };
}

function volumePack(packCount: number, eachFluidOunces = 12): Measurement {
  return {
    amount: packCount * eachFluidOunces,
    unit: "fl oz",
    kind: "volume",
    baseAmount: packCount * eachFluidOunces,
    baseUnit: "fl oz",
    packCount,
    perPackageAmount: eachFluidOunces,
    label: `${packCount} × ${eachFluidOunces} fl oz`,
  };
}

describe("Cartiva 100 independent live oracle", () => {
  it("retains only genuine, exact-store, HTTPS observation metadata", () => {
    const fulfillment: RetailPackageFulfillment = {
      kind: "single_package",
      cartQuantity: 1,
      packageCount: 1,
      overageBaseAmount: 0,
      overagePercent: 0,
      label: "1 retailer package",
      approvalRequired: false,
    };
    const observed = product({
      checkedAt: "2026-09-02T20:00:00.000Z",
      sourceUrl: "https://www.kroger.com/p/product/0001111000999",
      priceProvenance: {
        ...product().priceProvenance,
        checkedAt: "2026-09-02T20:00:00.000Z",
      },
    });
    const ranked: RankedKrogerProduct = {
      ...observed,
      score: 100,
      confidence: "high",
      comparablePrice: observed.price,
      matchedTerms: ["product"],
      reasons: ["Product identity"],
    };
    const result: KrogerMatchResult = {
      retailer: "kroger",
      requestedItem: "Kroger Product",
      status: "matched",
      resolution: "matched",
      confidence: "high",
      recommended: ranked,
      alternatives: [],
      explanation: "Verified.",
      fulfillment,
    };

    expect(selectedMetadata(result, "03500529")).toMatchObject({
      locationId: "03500529",
      checkedAt: "2026-09-02T20:00:00.000Z",
      sourceUrl: "https://www.kroger.com/p/product/0001111000999",
    });
    expect(selectedMetadata({
      ...result,
      recommended: { ...ranked, checkedAt: undefined, priceProvenance: { ...ranked.priceProvenance, checkedAt: undefined } },
    }, "03500529")).toBeUndefined();
    expect(selectedMetadata({ ...result, recommended: { ...ranked, sourceUrl: "http://example.com/item", link: "http://example.com/item" } }, "03500529")).toBeUndefined();
    expect(selectedMetadata(result, "DIFFERENT_STORE")).toBeUndefined();
  });

  it("proves a soda pack from retail-unit count and rejects conflicting counts", () => {
    const twelvePack = product({
      title: "Coca-Cola Zero Sugar Soda Cans 12 x 12 fl oz",
      productType: "Soda",
      size: volumePack(12),
    });
    expect(cartiva100LiveOracleFailure("C100-L1-017", twelvePack)).toBeUndefined();
    expect(cartiva100LiveOracleFailure("C100-L1-017", {
      ...twelvePack,
      title: "Coca-Cola Zero Sugar Soda Cans 24 Pack",
      size: volumePack(24),
    })).toContain("expected 12");
    expect(cartiva100LiveOracleFailure("C100-L1-017", {
      ...twelvePack,
      title: "Coca-Cola Zero Sugar Soda 12 fl oz Can",
      size: { ...volumePack(1), packCount: undefined },
    })).toContain("did not confirm a 12-pack");
    expect(cartiva100LiveOracleFailure("C100-L1-017", {
      ...twelvePack,
      title: "Coca-Cola Zero Sugar Soda Cans 12 Pack",
      size: volumePack(24),
    })).toContain("conflicting pack count");
  });

  it("requires canned-bean evidence and refuses conflicting containers", () => {
    const canned = product({
      title: "Kroger Dark Red Kidney Beans 15.5 oz Can",
      productType: "Canned & Packaged",
    });
    expect(cartiva100LiveOracleFailure("C100-L2-001", canned)).toBeUndefined();
    expect(cartiva100LiveOracleFailure("C100-L2-001", {
      ...canned,
      title: "Kroger Dry Kidney Beans 1 lb Bag",
      productType: "Dry Beans",
    })).toContain("conflicting bag");
    expect(cartiva100LiveOracleFailure("C100-L2-001", {
      ...canned,
      title: "Kroger Kidney Beans Pouch",
    })).toContain("conflicting pouch");
  });

  it("independently verifies total quantity, SKU arithmetic, and overage", () => {
    const testCase = cartiva100LiveCases().find((item) => item.id === "C100-L2-008")!;
    const turkey = product({
      title: "Kroger Ground Turkey 1 lb",
      productType: "Ground Turkey",
      size: {
        amount: 1,
        unit: "lb",
        kind: "weight",
        baseAmount: 16,
        baseUnit: "oz",
        label: "1 lb",
      },
    });
    const valid: RetailPackageFulfillment = {
      kind: "multi_package",
      cartQuantity: 3,
      packageCount: 3,
      requestedBaseAmount: 48,
      suppliedBaseAmount: 48,
      baseUnit: "oz",
      overageBaseAmount: 0,
      overagePercent: 0,
      label: "3 × 1 lb",
      approvalRequired: false,
    };

    expect(cartiva100LiveFulfillmentFailure(testCase, turkey, valid)).toBeUndefined();
    expect(cartiva100LiveFulfillmentFailure(testCase, turkey, {
      ...valid,
      cartQuantity: 1,
      packageCount: 1,
      suppliedBaseAmount: 16,
    })).toContain("undersupplied");
    expect(cartiva100LiveFulfillmentFailure(testCase, turkey, {
      ...valid,
      cartQuantity: 2,
      packageCount: 2,
      suppliedBaseAmount: 48,
    })).toContain("arithmetic");
    expect(cartiva100LiveFulfillmentFailure(testCase, turkey, {
      ...valid,
      cartQuantity: 5,
      packageCount: 5,
      suppliedBaseAmount: 80,
    })).toContain("safe limit");
  });

  it("accepts limited inventory telemetry and blocks explicit unavailability", () => {
    const checkedAt = "2026-09-02T20:00:00.000Z";
    const fulfillment: RetailPackageFulfillment = {
      kind: "single_package",
      cartQuantity: 1,
      packageCount: 1,
      overageBaseAmount: 0,
      overagePercent: 0,
      label: "20 oz loaf",
      approvalRequired: false,
    };
    const observed = product({
      title: "Kroger Enriched White Bread 20 oz Loaf",
      productType: "White Bread",
      checkedAt,
      sourceUrl: "https://www.kroger.com/p/product/0001111000999",
      priceProvenance: {
        ...product().priceProvenance,
        checkedAt,
      },
    });
    const ranked: RankedKrogerProduct = {
      ...observed,
      score: 100,
      confidence: "high",
      comparablePrice: observed.price,
      matchedTerms: ["white", "bread"],
      reasons: ["Product identity"],
    };
    const ready: KrogerMatchResult = {
      retailer: "kroger",
      requestedItem: "white bread",
      status: "matched",
      resolution: "matched",
      confidence: "high",
      recommended: ranked,
      alternatives: [],
      explanation: "Verified.",
      fulfillment,
    };
    const likelyProduct: RankedKrogerProduct = {
      ...ranked,
      inStock: false,
      availabilityStatus: "likely_available",
    };
    const likely: KrogerMatchResult = {
      ...ready,
      resolution: "matched_check_availability",
      recommended: likelyProduct,
    };
    const unavailable: KrogerMatchResult = {
      ...ready,
      resolution: "matched_check_availability",
      recommended: {
        ...ranked,
        inStock: false,
        availabilityStatus: "out_of_stock",
        cartEligible: false,
      },
    };

    expect(cartiva100LiveCaseDisposition({
      result: ready,
      provenanceMatches: true,
    })).toMatchObject({
      status: "LIVE_PASSED",
      reason: expect.stringMatching(/handoff ready/i),
    });
    const warningReady = cartiva100LiveCaseDisposition({
      result: likely,
      provenanceMatches: true,
    });
    expect(warningReady).toMatchObject({
      status: "LIVE_PASSED",
      reason: expect.stringMatching(/handoff ready/i),
    });
    const blocked = cartiva100LiveCaseDisposition({
      result: unavailable,
      provenanceMatches: true,
    });
    expect(blocked).toMatchObject({
      status: "EXTERNAL_BLOCKED",
      reason: expect.stringMatching(/out of stock.*cannot be handed off/i),
    });
    const blockedMetadata = selectedMetadata(unavailable, "03500529");
    expect(blockedMetadata).toMatchObject({
      productId: "live-oracle-product",
      availabilityStatus: "out_of_stock",
    });
    const blockedReport = formatCartiva100LiveReport({
      suiteId: "cartiva-100-kroger-live",
      status: "EXTERNAL_BLOCKED",
      checkedAt,
      retailerCalls: 1,
      matched: 0,
      blocked: 1,
      failed: 0,
      cases: [{
        id: "C100-L1-002",
        input: "white bread",
        status: blocked.status,
        reason: blocked.reason,
        searchAttempts: [],
        returnedCandidateCount: 1,
        selectedProduct: blockedMetadata,
      }],
    });
    expect(blockedReport).toContain("Kroger Enriched White Bread 20 oz Loaf");
    expect(blockedReport).toContain(blocked.reason);

    const testCase = cartiva100LiveCases().find((item) => item.id === "C100-L1-002")!;
    const intent = parseProductIntent("white bread");
    expect(cartiva100LiveIndependentCandidateReady(
      testCase,
      intent,
      ranked,
      "03500529",
    )).toBe(true);
    expect(cartiva100LiveIndependentCandidateReady(
      testCase,
      intent,
      likelyProduct,
      "03500529",
    )).toBe(true);
    expect(cartiva100LiveIndependentCandidateReady(
      testCase,
      intent,
      { ...ranked, inStock: false, availabilityStatus: "unknown" },
      "03500529",
    )).toBe(true);
    expect(cartiva100LiveIndependentCandidateReady(
      testCase,
      intent,
      { ...ranked, inStock: false, availabilityStatus: "out_of_stock" },
      "03500529",
    )).toBe(false);

    expect(cartiva100LiveCaseDisposition({
      result: {
        ...ready,
        recommended: { ...ranked, cartEligible: false },
      },
      provenanceMatches: true,
    })).toMatchObject({
      status: "EXTERNAL_BLOCKED",
      reason: expect.stringMatching(/eligible.*handoff/i),
    });
    expect(cartiva100LiveCaseDisposition({
      result: {
        ...ready,
        status: "review",
        resolution: "needs_choice",
        fulfillment: { ...fulfillment, approvalRequired: true },
      },
      provenanceMatches: true,
    })).toMatchObject({
      status: "EXTERNAL_BLOCKED",
      reason: expect.stringMatching(/shopper review.*handoff/i),
    });
    expect(cartiva100LiveCaseDisposition({
      result: likely,
      provenanceMatches: false,
    })).toMatchObject({
      status: "LIVE_FAILED",
      reason: expect.stringMatching(/exact-store provenance/i),
    });
  });

  it("labels successful live results as handoff ready", () => {
    const formatted = formatCartiva100LiveReport({
      suiteId: "cartiva-100-kroger-live",
      status: "LIVE_PASSED",
      checkedAt: "2026-09-02T20:00:00.000Z",
      retailerCalls: 1,
      matched: 1,
      blocked: 0,
      failed: 0,
      cases: [],
    });
    expect(formatted).toContain("HANDOFF READY: 1");
    expect(formatted).not.toContain("MATCHED:");
  });
});
