import { describe, expect, it } from "vitest";
import {
  AvailabilityStatus,
  BasketCompleteness,
  interpretGroceryInput,
  parseRetailerPackageQuantity,
} from "@/packages/shared/src";
import { decodePersistedComparisonSnapshot } from "@/mobile/src/state/comparison-snapshot-decoder";
import { decodeRetailPackageFulfillment } from "@/mobile/src/services/cartiva-api";

const checkedAt = "2026-08-24T18:00:00.000Z";

function validSnapshot() {
  const requestedItems = interpretGroceryInput("eggs 12 count").items;
  const request = requestedItems[0]!;
  const comparisonId = "comparison_decoder_001";
  const locationId = "62000115";
  const quantity = parseRetailerPackageQuantity(request.raw);
  const product = {
    retailer: "kroger",
    id: "0001111012345",
    productId: "0001111012345",
    upc: "0001111012345",
    title: "Kroger Grade A Large Eggs 12 Count",
    price: 2.99,
    priceCents: 299,
    link: "https://www.kingsoopers.com/p/eggs/0001111012345",
    linkType: "product",
    size: {
      amount: 12,
      unit: "count",
      kind: "count",
      baseAmount: 12,
      baseUnit: "each",
      label: "12 count",
    },
    checkedAt,
    inStock: true,
    availabilityStatus: "in_stock",
    cartEligible: true,
    dataSource: "kroger_public_api",
    confidence: "high",
    score: 93,
    reasons: ["Egg identity and 12 count verified"],
    priceProvenance: {
      regularPriceCents: 299,
      locationId,
      locationName: "King Soopers - Union Station",
      chain: "KINGSOOPERS",
      checkedAt,
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified: true,
      fulfillment: ["pickup"],
    },
  };
  const result = {
    retailer: "kroger",
    requestedItem: request.raw,
    recommended: product,
    alternatives: [],
    confidence: "high",
    status: "matched",
    explanation: "The egg identity and requested count were verified.",
    verifiedAt: checkedAt,
  };
  return {
    schemaVersion: 1,
    comparisonId,
    retailer: "kroger",
    retailerChain: "KINGSOOPERS",
    retailerBanner: "King Soopers",
    locationId,
    locationName: "King Soopers - Union Station",
    locationAddress: "1950 Chestnut Pl, Denver, CO 80202",
    zipCode: "80202",
    fulfillmentMode: "pickup",
    requestedItemIds: [request.id],
    basketLines: [{
      lineId: `${comparisonId}:${request.id}`,
      requestedItemId: request.id,
      requestedItem: request.raw,
      normalizedIntent: quantity.searchText,
      quantity: quantity.quantity,
      status: "ACCEPTED",
      retailerProductId: product.productId,
      upc: product.upc,
      matchedProduct: product.title,
      matchedPackage: product.size.label,
      priceCents: 299,
      locationId,
      availabilityStatus: AvailabilityStatus.VERIFIED_IN_STOCK,
      matchConfidence: "high",
      provenance: {
        dataSource: "kroger_public_api",
        priceSource: "kroger_location_product",
        priceScope: "exact_store",
        priceReliability: "verified",
        exactStoreVerified: true,
        sourceLocationId: locationId,
        fulfillment: ["pickup"],
        checkedAt,
      },
    }],
    completeness: BasketCompleteness.COMPLETE,
    checkedAt,
    createdAt: checkedAt,
    requestedItems,
    results: [result],
    location: {
      locationId,
      name: "King Soopers - Union Station",
      chain: "KINGSOOPERS",
      address: {
        addressLine1: "1950 Chestnut Pl",
        city: "Denver",
        state: "CO",
        zipCode: "80202",
      },
      departments: ["Pickup"],
      handoff: {
        mode: "SHOPPING_PAGE_ONLY",
        url: "https://www.kingsoopers.com/",
        storeSelectionRequired: true,
      },
    },
    locationSelectionBasis: "KROGER_PROVIDER_ORDER",
    summary: {
      status: BasketCompleteness.COMPLETE,
      requestedCount: 1,
      matchedCount: 1,
      totalCents: 299,
      matchedSubtotalCents: 299,
    },
    capabilities: {
      apiVersion: "v1",
      access: "ANONYMOUS_WITH_TEMPORARY_SESSION",
      retailers: [{
        id: "kroger",
        label: "Kroger",
        status: "ACTIVE",
        read: { locations: true, productSearch: true },
        handoff: {
          mode: "CART_TRANSFER_SUPPORTED",
          cartTransferSupported: true,
          requiresRetailerCheckout: true,
          requiresCustomerAuthorization: true,
          cartApiLocationBound: false,
          requiresStoreConfirmation: true,
        },
      }],
    },
    serverReceiptPersisted: true,
  };
}

describe("persisted mobile comparison decoder", () => {
  it("restores a fully valid exact-store snapshot", () => {
    const snapshot = validSnapshot();
    expect(decodePersistedComparisonSnapshot(snapshot, "eggs 12 count", "80202"))
      .toEqual(snapshot);
  });

  it("restores a nearby selected store whose address is in an adjacent ZIP", () => {
    const snapshot = validSnapshot();
    snapshot.location.address.zipCode = "80216";
    snapshot.locationAddress = "1950 Chestnut Pl, Denver, CO 80216";

    expect(decodePersistedComparisonSnapshot(snapshot, "eggs 12 count", "80202"))
      .toEqual(snapshot);
  });

  it("restores a multi-package result and verifies totals from fulfillment cart quantity", () => {
    const base = validSnapshot();
    const fulfillment = {
      kind: "multi_package" as const,
      cartQuantity: 2,
      packageCount: 2,
      requestedBaseAmount: 24,
      suppliedBaseAmount: 24,
      baseUnit: "each" as const,
      overageBaseAmount: 0,
      overagePercent: 0,
      label: "2 × 12 count · 24 each total",
      approvalRequired: false,
      recoveredFromStrictNoMatch: true,
    };
    const snapshot = {
      ...base,
      results: [{
        ...base.results[0],
        resolution: "multi_package_fulfillment",
        fulfillment,
      }],
      basketLines: [{ ...base.basketLines[0], quantity: 2 }],
      summary: {
        ...base.summary,
        totalCents: 598,
        matchedSubtotalCents: 598,
      },
    };

    expect(decodePersistedComparisonSnapshot(snapshot, "eggs 12 count", "80202"))
      .toEqual(snapshot);
    expect(decodePersistedComparisonSnapshot({
      ...snapshot,
      basketLines: [{ ...snapshot.basketLines[0], quantity: 1 }],
    }, "eggs 12 count", "80202")).toBeNull();
  });

  it.each([
    ["likely available", "likely_available" as const, AvailabilityStatus.LIKELY_AVAILABLE],
    ["unknown availability", "unknown" as const, AvailabilityStatus.UNKNOWN],
  ])("restores a retained %s match as a rejected line", (
    _label,
    availabilityStatus,
    receiptAvailability,
  ) => {
    const base = validSnapshot();
    const recommended = {
      ...base.results[0].recommended,
      inStock: false,
      availabilityStatus,
      cartEligible: true,
    };
    const unacceptedLine: Partial<(typeof base.basketLines)[number]> = {
      ...base.basketLines[0],
    };
    delete unacceptedLine.retailerProductId;
    delete unacceptedLine.upc;
    delete unacceptedLine.matchedProduct;
    delete unacceptedLine.matchedPackage;
    delete unacceptedLine.priceCents;
    delete unacceptedLine.provenance;
    const snapshot = {
      ...base,
      results: [{
        ...base.results[0],
        recommended,
        resolution: "matched_check_availability",
        fulfillment: {
          kind: "single_package",
          cartQuantity: 1,
          packageCount: 1,
          label: "12 count",
          approvalRequired: false,
        },
      }],
      basketLines: [{
        ...unacceptedLine,
        status: "REJECTED",
        availabilityStatus: receiptAvailability,
        matchConfidence: "high",
      }],
      completeness: BasketCompleteness.INCOMPLETE,
      summary: {
        status: BasketCompleteness.INCOMPLETE,
        requestedCount: 1,
        matchedCount: 0,
        matchedSubtotalCents: 0,
      },
    };

    expect(decodePersistedComparisonSnapshot(snapshot, "eggs 12 count", "80202"))
      .toEqual(snapshot);
  });

  it("strictly rejects malformed package-fulfillment metadata", () => {
    const valid = {
      kind: "multi_package",
      cartQuantity: 2,
      packageCount: 2,
      requestedBaseAmount: 24,
      suppliedBaseAmount: 24,
      baseUnit: "each",
      overageBaseAmount: 0,
      overagePercent: 0,
      label: "2 × 12 count",
      approvalRequired: false,
    };

    expect(decodeRetailPackageFulfillment(valid)).toEqual(valid);
    expect(decodeRetailPackageFulfillment({ ...valid, cartQuantity: 1 })).toBeNull();
    expect(decodeRetailPackageFulfillment({ ...valid, cartQuantity: 2.5 })).toBeNull();
    expect(decodeRetailPackageFulfillment({ ...valid, baseUnit: "lb" })).toBeNull();
    expect(decodeRetailPackageFulfillment({ ...valid, unexpected: true })).toBeNull();
  });

  it("fails closed for missing capability structure", () => {
    expect(decodePersistedComparisonSnapshot({
      ...validSnapshot(),
      capabilities: {},
    }, "eggs 12 count", "80202")).toBeNull();
  });

  it.each([
    ["summary", (snapshot: ReturnType<typeof validSnapshot>) => ({
      ...snapshot,
      summary: { ...snapshot.summary, matchedCount: "1" },
    })],
    ["location", (snapshot: ReturnType<typeof validSnapshot>) => ({
      ...snapshot,
      location: { ...snapshot.location, address: { ...snapshot.location.address, state: null } },
    })],
    ["results", (snapshot: ReturnType<typeof validSnapshot>) => ({
      ...snapshot,
      results: [{
        ...snapshot.results[0],
        recommended: {
          ...snapshot.results[0].recommended,
          priceProvenance: {
            ...snapshot.results[0].recommended.priceProvenance,
            locationId: "different-store",
          },
        },
      }],
    })],
    ["basket lines", (snapshot: ReturnType<typeof validSnapshot>) => ({
      ...snapshot,
      basketLines: [{ ...snapshot.basketLines[0], quantity: 0 }],
    })],
  ])("rejects representative nested corruption in %s", (_label, corrupt) => {
    expect(decodePersistedComparisonSnapshot(
      corrupt(validSnapshot()),
      "eggs 12 count",
      "80202",
    )).toBeNull();
  });
});
