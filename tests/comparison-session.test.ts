import { describe, expect, it } from "vitest";

import {
  AttributeOrigin,
  AvailabilityStatus,
  BasketCompleteness,
  assertComparisonStoreInvariant,
  createComparisonHydrationGuard,
  comparisonCanReuseLocation,
  comparisonCartMutationReadiness,
  comparisonSearchItem,
  isRetailerHandoffAcceptedMatch,
  krogerRetailerBanner,
  parseRetailerPackageQuantity,
  type ComparisonSessionReceipt,
} from "@/packages/shared/src";

function receipt(): ComparisonSessionReceipt {
  return {
    schemaVersion: 1,
    comparisonId: "cmp_01J_STORE_BOUND",
    retailer: "kroger",
    retailerChain: "KINGSOOPERS",
    retailerBanner: "King Soopers",
    locationId: "62000115",
    locationName: "King Soopers - Union Station",
    locationAddress: "1950 Chestnut Pl, Denver, CO 80202",
    zipCode: "80202",
    fulfillmentMode: "pickup",
    requestedItemIds: ["milk-line"],
    basketLines: [{
      lineId: "cmp_01J_STORE_BOUND:milk-line",
      requestedItemId: "milk-line",
      requestedItem: "2 gallons of milk",
      normalizedIntent: "milk 1 gallon",
      quantity: 2,
      packageSizeText: "1 gallon",
      status: "ACCEPTED",
      retailerProductId: "0001111041700",
      upc: "0001111041700",
      matchedProduct: "Kroger 2% Reduced Fat Milk",
      matchedPackage: "1 gallon",
      priceCents: 349,
      locationId: "62000115",
      availabilityStatus: AvailabilityStatus.VERIFIED_IN_STOCK,
      matchConfidence: "high",
      provenance: {
        dataSource: "kroger_public_api",
        priceSource: "kroger_location_product",
        priceScope: "exact_store",
        priceReliability: "verified",
        exactStoreVerified: true,
        sourceLocationId: "62000115",
        fulfillment: ["pickup"],
        checkedAt: "2026-08-24T15:00:00.000Z",
      },
    }],
    completeness: BasketCompleteness.COMPLETE,
    checkedAt: "2026-08-24T15:00:00.000Z",
    createdAt: "2026-08-24T15:00:00.000Z",
  };
}

describe("retailer package quantity semantics", () => {
  it("keeps package count separate from the number of packages", () => {
    expect(parseRetailerPackageQuantity("Coke Zero 12 pack x2")).toEqual({
      quantity: 2,
      searchText: "Coke Zero 12 pack",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
  });

  it("turns two gallons into two one-gallon packages", () => {
    expect(parseRetailerPackageQuantity("2 gallons of milk")).toEqual({
      quantity: 2,
      searchText: "milk 1 gallon",
      packageSizeText: "1 gallon",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
  });

  it("preserves three cans as retailer quantity three", () => {
    expect(parseRetailerPackageQuantity("3 cans black beans")).toEqual({
      quantity: 3,
      searchText: "black beans",
      packageSizeText: "1 can",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
  });

  it("treats household roll counts as one exact retailer package", () => {
    expect(parseRetailerPackageQuantity("Paper Towels, 6 rolls")).toEqual({
      quantity: 1,
      searchText: "Paper Towels, 6 rolls",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
    expect(parseRetailerPackageQuantity("12 rolls toilet paper")).toEqual({
      quantity: 1,
      searchText: "12 rolls toilet paper",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
  });

  it("preserves dozen package identity and a separate cart multiplier", () => {
    expect(parseRetailerPackageQuantity("2 dozen eggs")).toEqual({
      quantity: 2,
      searchText: "eggs 12 count",
      packageSizeText: "12 count",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
  });

  it.each([
    ["Chickpeas 3 cans", 3, "Chickpeas"],
    ["Diced Tomatoes 8 cans", 8, "Diced Tomatoes"],
    ["Kidney Beans 4 cans", 4, "Kidney Beans"],
    ["Light Coconut Milk 2 cans", 2, "Light Coconut Milk"],
  ])("treats a trailing container total as retailer quantity: %s", (
    request,
    quantity,
    searchText,
  ) => {
    expect(parseRetailerPackageQuantity(request)).toEqual({
      quantity,
      searchText,
      packageSizeText: "1 can",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
  });

  it.each([
    "Ground Turkey 93/7 3 lb",
    "Red Lentil Pasta 1.8 lb",
    "White Rice",
  ])("does not reinterpret a physical total or plain identity as cart quantity: %s", (request) => {
    expect(parseRetailerPackageQuantity(request)).toMatchObject({
      quantity: 1,
      searchText: request,
      origin: AttributeOrigin.INFERRED,
    });
  });

  it("supports natural package quantities before a product", () => {
    expect(parseRetailerPackageQuantity("2 loaves white bread")).toEqual({
      quantity: 2,
      searchText: "white bread",
      packageSizeText: "1 loaf",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
    expect(parseRetailerPackageQuantity("2 cartons eggs 18 count")).toEqual({
      quantity: 2,
      searchText: "eggs 18 count",
      packageSizeText: "1 carton",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
  });

  it("does not reinterpret physical sizes or milk percentages as cart quantities", () => {
    expect(parseRetailerPackageQuantity("2 lb chicken")).toMatchObject({
      quantity: 1,
      searchText: "2 lb chicken",
    });
    expect(parseRetailerPackageQuantity("2% milk")).toMatchObject({
      quantity: 1,
      searchText: "2% milk",
    });
    expect(parseRetailerPackageQuantity("18 count eggs")).toMatchObject({
      quantity: 1,
      searchText: "18 count eggs",
    });
  });

  it("does not confuse an 18-count package with eighteen packages", () => {
    expect(parseRetailerPackageQuantity("eggs 18 count")).toEqual({
      quantity: 1,
      searchText: "eggs 18 count",
      origin: AttributeOrigin.INFERRED,
    });
    expect(parseRetailerPackageQuantity("18 eggs")).toEqual({
      quantity: 1,
      searchText: "18 eggs",
      origin: AttributeOrigin.INFERRED,
    });
  });

  it("preserves ambiguous leading numbers as product identity and one retailer unit", () => {
    const numericProducts = [
      "7 Up",
      "3 Musketeers",
      "5 Hour Energy",
      "7 grain bread",
      "4 cheese pizza",
      "3 bean salad",
      "5 cheese tortellini",
      "12 grain bread",
      "8 O'Clock coffee",
      "9 Lives cat food",
      "2 Coke Zero 24 pack",
    ];

    for (const [index, productName] of numericProducts.entries()) {
      expect(parseRetailerPackageQuantity(productName)).toEqual({
        quantity: 1,
        searchText: productName,
        origin: AttributeOrigin.INFERRED,
      });
      expect(comparisonSearchItem({ id: `numeric-product-${index}`, raw: productName })).toEqual({
        text: productName,
        requestedItemId: `numeric-product-${index}`,
        quantity: 1,
      });
    }
  });

  it("honors explicit retailer quantities for numeric product names", () => {
    expect(parseRetailerPackageQuantity("7 Up x2")).toMatchObject({
      quantity: 2,
      searchText: "7 Up",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
    expect(parseRetailerPackageQuantity("2 x 3 Musketeers")).toMatchObject({
      quantity: 2,
      searchText: "3 Musketeers",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
    expect(parseRetailerPackageQuantity("2 5 Hour Energy")).toMatchObject({
      quantity: 1,
      searchText: "2 5 Hour Energy",
      origin: AttributeOrigin.INFERRED,
    });
    expect(parseRetailerPackageQuantity("2 x 5 Hour Energy")).toMatchObject({
      quantity: 2,
      searchText: "5 Hour Energy",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
    expect(parseRetailerPackageQuantity("2 x Coke Zero 24 pack")).toMatchObject({
      quantity: 2,
      searchText: "Coke Zero 24 pack",
      origin: AttributeOrigin.USER_EXPLICIT,
    });
  });
});

describe("one comparison equals one Kroger-family location", () => {
  it("uses one strict acceptance rule for every retailer handoff surface", () => {
    const accepted = {
      status: "matched" as const,
      resolution: "matched",
      recommended: {
        availabilityStatus: "in_stock" as const,
        cartEligible: true,
      },
      fulfillment: { approvalRequired: false },
    };

    expect(isRetailerHandoffAcceptedMatch(accepted)).toBe(true);
    expect(isRetailerHandoffAcceptedMatch({
      ...accepted,
      recommended: { ...accepted.recommended, availabilityStatus: "likely_available" },
      resolution: "matched_check_availability",
    })).toBe(false);
    expect(isRetailerHandoffAcceptedMatch({
      ...accepted,
      recommended: { ...accepted.recommended, availabilityStatus: "unknown" },
      resolution: "matched_check_availability",
    })).toBe(false);
    expect(isRetailerHandoffAcceptedMatch({
      ...accepted,
      recommended: { ...accepted.recommended, cartEligible: false },
    })).toBe(false);
    expect(isRetailerHandoffAcceptedMatch({
      ...accepted,
      fulfillment: { approvalRequired: true },
    })).toBe(false);
    expect(isRetailerHandoffAcceptedMatch({
      ...accepted,
      resolution: "multi_package_fulfillment",
      fulfillment: undefined,
    })).toBe(false);
    expect(isRetailerHandoffAcceptedMatch({
      ...accepted,
      resolution: "multi_package_fulfillment",
      fulfillment: { approvalRequired: false, kind: "multi_package" },
    })).toBe(true);
  });

  it("preserves official Kroger-family banner names", () => {
    expect(krogerRetailerBanner("KINGSOOPERS")).toBe("King Soopers");
    expect(krogerRetailerBanner("Ralphs")).toBe("Ralphs");
    expect(krogerRetailerBanner("FRYSFOOD")).toBe("Fry's");
  });

  it("accepts a complete receipt only when every line has exact same-store evidence", () => {
    expect(assertComparisonStoreInvariant(receipt())).toMatchObject({
      comparisonId: "cmp_01J_STORE_BOUND",
      locationId: "62000115",
      retailerBanner: "King Soopers",
      completeness: BasketCompleteness.COMPLETE,
      basketLines: [{ quantity: 2, upc: "0001111041700" }],
    });
  });

  it("requires verified in-stock evidence for an accepted handoff receipt", () => {
    const verified = receipt();
    expect(comparisonCartMutationReadiness(
      verified,
      Date.parse("2026-08-24T15:10:00.000Z"),
    )).toEqual({ ready: true });

    const likely = receipt();
    likely.basketLines[0].availabilityStatus = AvailabilityStatus.LIKELY_AVAILABLE;
    expect(() => assertComparisonStoreInvariant(likely)).toThrow(/availability evidence/i);

    expect(comparisonCartMutationReadiness(
      verified,
      Date.parse("2026-08-24T15:16:00.000Z"),
    )).toEqual({ ready: false, reason: "RECEIPT_STALE" });

    const missingEvidenceTime = receipt();
    missingEvidenceTime.basketLines[0].provenance!.checkedAt = undefined;
    expect(comparisonCartMutationReadiness(
      missingEvidenceTime,
      Date.parse("2026-08-24T15:10:00.000Z"),
    )).toEqual({ ready: false, reason: "RECEIPT_STALE" });
  });

  it("rejects a handoff basket line silently sourced from another store", () => {
    const wrongStore = receipt();
    wrongStore.basketLines[0].locationId = "62000001";
    expect(() => assertComparisonStoreInvariant(wrongStore)).toThrow(/different retailer location/i);
  });

  it("rejects false complete status when a required line is unmatched", () => {
    const incomplete = receipt();
    incomplete.basketLines[0] = {
      ...incomplete.basketLines[0],
      status: "UNMATCHED",
      retailerProductId: undefined,
      upc: undefined,
      provenance: undefined,
    };
    expect(() => assertComparisonStoreInvariant(incomplete)).toThrow(/completeness/i);
  });

  it("rejects swapped line identity and non-positive accepted prices", () => {
    const swapped = receipt();
    swapped.requestedItemIds[0] = "different-line";
    expect(() => assertComparisonStoreInvariant(swapped)).toThrow(/line identity/i);

    const free = receipt();
    free.basketLines[0].priceCents = 0;
    expect(() => assertComparisonStoreInvariant(free)).toThrow(/positive verified price/i);
  });

  it("rejects duplicate basket line IDs", () => {
    const duplicate = receipt();
    duplicate.requestedItemIds.push("bread-line");
    duplicate.basketLines.push({
      ...duplicate.basketLines[0],
      requestedItemId: "bread-line",
      // Deliberately duplicates the first line's ID.
      lineId: duplicate.basketLines[0].lineId,
    });
    expect(() => assertComparisonStoreInvariant(duplicate)).toThrow(/line identity/i);
  });
});

describe("comparison persistence hydration", () => {
  it("does not overwrite the shopper's first edit when storage resolves later", async () => {
    const guard = createComparisonHydrationGuard();
    let release!: (value: string) => void;
    const slowStorage = new Promise<string>((resolve) => {
      release = resolve;
    });

    guard.markEdited();
    release("old persisted grocery list");
    expect(guard.finish(await slowStorage)).toBeNull();
    expect(guard.hydrated).toBe(true);
  });

  it("restores persisted state when no edit happened during loading", () => {
    const guard = createComparisonHydrationGuard();
    expect(guard.finish("saved basket")).toBe("saved basket");
  });
});

describe("same-store revalidation", () => {
  it("pins the existing location only while ZIP and requested line identities are unchanged", () => {
    const comparison = receipt();
    expect(comparisonCanReuseLocation(comparison, "80202", ["milk-line"])).toBe(true);
    expect(comparisonCanReuseLocation(comparison, "79912", ["milk-line"])).toBe(false);
    expect(comparisonCanReuseLocation(comparison, "80202", ["changed-line"])).toBe(false);
  });

  it("carries the shopper's chosen exact candidate into strict server revalidation", () => {
    expect(comparisonSearchItem(
      { id: "coke-zero-line", raw: "Coke Zero 12 pack x2" },
      { productId: "0004900003714", title: "Coca-Cola Zero Sugar Soda 12 Pack" },
    )).toEqual({
      text: "Coke Zero 12 pack x2",
      requestedItemId: "coke-zero-line",
      quantity: 2,
      preferredProductId: "0004900003714",
      preferredTitle: "Coca-Cola Zero Sugar Soda 12 Pack",
    });
  });
});
