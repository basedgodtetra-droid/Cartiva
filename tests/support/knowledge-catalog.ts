import catalog from "../fixtures/cartiva-500-catalog.json";
import type { KrogerProduct, Measurement } from "@/lib/types";

export function knowledgeCatalogProduct(id: string, options: { priceIncrease?: number; store?: string; fulfillment?: "pickup" | "delivery"; checkedAt?: string; outOfStock?: boolean } = {}): KrogerProduct {
  const index = catalog.products.findIndex(p => p.id === id);
  const p = catalog.products[index];
  if (!p) throw new Error(`Missing fixture ${id}`);
  const upc = `00999${String(index).padStart(8, "0")}`;
  const store = options.store ?? "03500529";
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const priceCents = p.priceCents + (options.priceIncrease ?? 0);
  return { retailer: "kroger", id: upc, productId: upc, upc, title: p.title, brand: p.brand,
    productType: p.productType, price: priceCents / 100, priceCents, size: p.size as Measurement,
    link: `https://www.kroger.com/p/fixture/${upc}`, linkType: "product", seller: "Kroger",
    inStock: !options.outOfStock, availabilityStatus: options.outOfStock ? "out_of_stock" : "unknown",
    sponsored: false, checkedAt, verification: "verified", verificationIssues: [],
    cartEligible: !options.outOfStock, dataSource: "kroger_public_api", identityVerified: true,
    priceProvenance: { retailer: "kroger", priceSource: "kroger_location_product", priceScope: "exact_store",
      priceReliability: "verified", exactStoreVerified: true, regularPriceCents: priceCents, locationId: store,
      location: { requestedStoreId: store, observedStoreId: store, responseProvesLocation: true, storeMatched: true },
      fulfillment: [options.fulfillment ?? "pickup"], checkedAt },
  };
}
