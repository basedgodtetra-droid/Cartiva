import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SavedBasketProductRow } from "@/components/cartiva-library-pages";
import type { CartivaSavedProduct } from "@/lib/cartiva-library";

const savedProduct: CartivaSavedProduct = {
  requestedItem: "Ground beef, 3 lb",
  quantity: 3,
  retailer: "kroger",
  productId: "000000000030",
  upc: "000000000030",
  title: "Ground Beef",
  packageLabel: "1 lb",
  fulfillmentLabel: "3 × 1 lb packages · 3 lb total",
  packageKey: "weight:oz:16:1:",
  unitPriceCents: 549,
  lineTotalCents: 1_647,
  availabilityStatus: "in_stock",
  confidence: "high",
  observedAt: "2026-08-31T12:00:00.000Z",
  provenance: {
    dataSource: "kroger_public_api",
    priceSource: "kroger_location_product",
    priceScope: "exact_store",
    priceReliability: "verified",
    exactStoreVerified: true,
    locationId: "store-1",
    fulfillment: ["pickup"],
    checkedAt: "2026-08-31T12:00:00.000Z",
  },
};

describe("saved basket product details", () => {
  it("renders the resolved fulfillment beside the extended line total context", () => {
    const html = renderToStaticMarkup(createElement(SavedBasketProductRow, { product: savedProduct }));

    expect(html).toContain("3 × 1 lb packages · 3 lb total");
    expect(html).toContain("UPC 000000000030");
    expect(html).toContain("$16.47");
    expect(html).not.toContain(">1 lb · UPC");
  });

  it("shows the resolved quantity for a legacy product without a fulfillment label", () => {
    const legacyProduct = structuredClone(savedProduct);
    delete legacyProduct.fulfillmentLabel;
    const html = renderToStaticMarkup(createElement(SavedBasketProductRow, { product: legacyProduct }));

    expect(html).toContain("3 × 1 lb");
    expect(html).toContain("$16.47");
  });
});
