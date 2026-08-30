import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  AvailabilityStatus,
  BasketCompleteness,
  type ComparisonSessionReceipt,
} from "@/packages/shared/src";
import { comparisonBasketDigest } from "@/lib/mobile-comparison-receipts";

vi.mock("../mobile/src/services/mobile-session", () => ({
  mobileSessionFetch: vi.fn(),
}));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: vi.fn(async (_algorithm: string, value: string) => (
    createHash("sha256").update(value).digest("hex")
  )),
}));

import { krogerComparisonReceiptMatches } from "../mobile/src/services/cartiva-api";

function receipt(upc = "0001111012345"): ComparisonSessionReceipt {
  const comparisonId = "cmp_digest_binding_0001";
  const requestedItemId = "requested-eggs-01";
  const locationId = "62000115";
  const checkedAt = "2026-08-25T18:00:00.000Z";
  return {
    schemaVersion: 1,
    comparisonId,
    retailer: "kroger",
    retailerChain: "KINGSOOPERS",
    retailerBanner: "King Soopers",
    locationId,
    locationName: "King Soopers Test",
    locationAddress: "1 Main St, Denver, CO 80202",
    zipCode: "80202",
    fulfillmentMode: "pickup",
    requestedItemIds: [requestedItemId],
    basketLines: [{
      lineId: `${comparisonId}:${requestedItemId}`,
      requestedItemId,
      requestedItem: "eggs 12 count",
      normalizedIntent: "eggs 12 count",
      quantity: 1,
      status: "ACCEPTED",
      retailerProductId: upc,
      upc,
      matchedProduct: "Kroger Grade A Large Eggs 12 Count",
      matchedPackage: "12 count",
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
  };
}

describe("mobile/server comparison basket binding", () => {
  it("accepts the exact persisted basket and rejects an A-vs-B product mismatch", async () => {
    const serverBasket = receipt();
    const confirmation = {
      comparisonId: serverBasket.comparisonId,
      locationId: serverBasket.locationId,
      retailerBanner: serverBasket.retailerBanner,
      completeness: serverBasket.completeness,
      basketDigest: comparisonBasketDigest(serverBasket),
      persisted: true as const,
    };

    await expect(krogerComparisonReceiptMatches(confirmation, serverBasket)).resolves.toBe(true);
    await expect(krogerComparisonReceiptMatches(
      confirmation,
      receipt("0001111099999"),
    )).resolves.toBe(false);
  });
});
