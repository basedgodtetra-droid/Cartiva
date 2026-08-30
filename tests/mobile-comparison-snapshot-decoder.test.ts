import { describe, expect, it } from "vitest";
import {
  AvailabilityStatus,
  BasketCompleteness,
  interpretGroceryInput,
  parseRetailerPackageQuantity,
} from "@/packages/shared/src";
import { decodePersistedComparisonSnapshot } from "@/mobile/src/state/comparison-snapshot-decoder";

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
