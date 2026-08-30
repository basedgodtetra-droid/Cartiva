import { describe, expect, it } from "vitest";
import {
  AvailabilityStatus,
  BasketCompleteness,
  assertComparisonStoreInvariant,
  comparisonCanReuseLocation,
  createPersistedComparisonEnvelope,
  localCorrectionMetadata,
  parsePersistedComparisonEnvelope,
  type ComparisonSessionReceipt,
} from "@/packages/shared/src";

function savedComparison(): ComparisonSessionReceipt {
  return {
    schemaVersion: 1,
    comparisonId: "cmp_persisted_union_station",
    retailer: "kroger",
    retailerChain: "KINGSOOPERS",
    retailerBanner: "King Soopers",
    locationId: "62000115",
    locationName: "King Soopers - Union Station",
    locationAddress: "1950 Chestnut Pl, Denver, CO 80202",
    zipCode: "80202",
    fulfillmentMode: "pickup",
    requestedItemIds: ["coke-line"],
    basketLines: [{
      lineId: "cmp_persisted_union_station:coke-line",
      requestedItemId: "coke-line",
      requestedItem: "Coke Zero 12 pack x2",
      normalizedIntent: "Coke Zero 12 pack",
      quantity: 2,
      status: "ACCEPTED",
      retailerProductId: "0004900003714",
      upc: "0004900003714",
      matchedProduct: "Coca-Cola Zero Sugar Soda",
      matchedPackage: "12 x 12 fl oz",
      priceCents: 1199,
      locationId: "62000115",
      availabilityStatus: AvailabilityStatus.LIKELY_AVAILABLE,
      matchConfidence: "high",
      provenance: {
        dataSource: "kroger_public_api",
        priceSource: "kroger_location_product",
        priceScope: "exact_store",
        priceReliability: "verified",
        exactStoreVerified: true,
        sourceLocationId: "62000115",
        fulfillment: ["pickup"],
      },
    }],
    completeness: BasketCompleteness.COMPLETE,
    checkedAt: "2026-08-24T18:00:00.000Z",
    createdAt: "2026-08-24T18:00:00.000Z",
  };
}

describe("persisted comparison envelope", () => {
  it("rejects corrupt and obsolete envelopes", () => {
    expect(parsePersistedComparisonEnvelope("not json")).toBeNull();
    expect(parsePersistedComparisonEnvelope(JSON.stringify({
      schemaVersion: 0,
      savedAt: new Date().toISOString(),
      rawInput: "bread",
      zipCode: "80202",
      comparison: null,
    }))).toBeNull();
  });

  it("restores a valid list, ZIP, exact-store receipt, and package quantity", () => {
    const comparison = savedComparison();
    const serialized = JSON.stringify(createPersistedComparisonEnvelope({
      rawInput: "Coke Zero 12 pack x2",
      zipCode: "80202",
      comparison,
    }, "2026-08-24T18:05:00.000Z"));
    const restored = parsePersistedComparisonEnvelope(serialized);
    const receipt = assertComparisonStoreInvariant(
      restored?.comparison as ComparisonSessionReceipt,
    );
    expect(restored).toMatchObject({
      rawInput: "Coke Zero 12 pack x2",
      zipCode: "80202",
    });
    expect(receipt).toMatchObject({
      locationId: "62000115",
      retailerBanner: "King Soopers",
      basketLines: [{ quantity: 2, upc: "0004900003714" }],
    });
  });

  it("does not restore store evidence for a changed ZIP or changed list identity", () => {
    const comparison = savedComparison();
    expect(comparisonCanReuseLocation(comparison, "79912", ["coke-line"])).toBe(false);
    expect(comparisonCanReuseLocation(comparison, "80202", ["bread-line"])).toBe(false);
  });

  it("preserves retailer evidence time but disables cart receipt after a local correction", () => {
    const original = savedComparison();
    expect(localCorrectionMetadata(original, "cmp_after_alternative_choice")).toEqual({
      comparisonId: "cmp_after_alternative_choice",
      checkedAt: "2026-08-24T18:00:00.000Z",
      createdAt: "2026-08-24T18:00:00.000Z",
      serverReceiptPersisted: false,
    });
  });
});
