import { describe, expect, it } from "vitest";
import { createPendingKrogerCart } from "@/lib/cartiva-kroger-cart";
import { verifiedKrogerCartReceipt } from "@/lib/cartiva-kroger-receipt";

const pending = createPendingKrogerCart({
  operationId: "cartiva_receipt_test_0001",
  locationId: "01400912",
  fulfillmentMode: "pickup",
  items: [
    { upc: "0001111011111", quantity: 2 },
    { upc: "0001111022222", quantity: 1 },
  ],
  itemCount: 2,
  comparisonId: "comparison_1",
  createdAt: 1,
});

const receipt = {
  success: true,
  operationId: pending.operationId,
  cartUrl: "https://www.kroger.com/cart",
  addedCount: 3,
  itemCount: 2,
  message: "Kroger accepted these items.",
  selectedSearchLocation: { locationId: pending.locationId, name: "Mockingbird Kroger" },
  locationBoundByCartApi: false,
};

describe("Cartiva Kroger transfer receipt", () => {
  it("accepts only the exact confirmed basket and trusted cart route", () => {
    expect(verifiedKrogerCartReceipt(receipt, pending)).toEqual({
      cartUrl: "https://www.kroger.com/cart",
      message: "Kroger accepted these items.",
      itemCount: 2,
      addedCount: 3,
    });
  });

  it("rejects a partial count instead of displaying false success", () => {
    expect(verifiedKrogerCartReceipt({ ...receipt, addedCount: 2 }, pending)).toBeNull();
    expect(verifiedKrogerCartReceipt({ ...receipt, itemCount: 1 }, pending)).toBeNull();
  });

  it("rejects a different store or an untrusted destination", () => {
    expect(verifiedKrogerCartReceipt({
      ...receipt,
      selectedSearchLocation: { locationId: "different" },
    }, pending)).toBeNull();
    expect(verifiedKrogerCartReceipt({
      ...receipt,
      cartUrl: "https://example.com/cart",
    }, pending)).toBeNull();
  });
});
