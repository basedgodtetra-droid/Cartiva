import type { Metadata } from "next";
import { CartivaInformationPage } from "@/components/cartiva-information-page";

export const metadata: Metadata = { title: "Data & sourcing", description: "How Cartiva labels retailer data, store-specific prices, package matches, and complete baskets." };

export default function DataSourcingPage() {
  return (
    <CartivaInformationPage eyebrow="Trust" title="Data & sourcing" lede="Cartiva is designed to show where a price came from, which store it belongs to, and when it was observed.">
      <section><h2>Current live source</h2><p>The current web comparison uses Kroger’s official public API for supported Kroger-family stores. Saved price history accepts only verified official-API observations that prove the exact selected store. Cartiva does not turn preview or demo values into saved history.</p></section>
      <section><h2>Store and time matter</h2><p>Retail prices and availability can vary by location and fulfillment mode. Cartiva keeps the retailer, exact location, source timestamp, and fulfillment context with a verified observation. “Observed” means the source evidence was checked at that time; opening a cached result later does not create a new price point.</p></section>
      <section><h2>Product and package matching</h2><p>Cartiva compares the requested product with retailer title, identity, UPC, and package measurements. A 12-pack is not grouped with a 24-pack, and different UPCs or structured package sizes remain separate in product history.</p></section>
      <section><h2>Inventory confidence</h2><p>Availability reflects the retailer response and can change before checkout. Cartiva labels match confidence and cart eligibility, while the retailer remains the final source for stock, substitutions, and fulfillment.</p></section>
      <section><h2>Why incomplete baskets are excluded</h2><p>A low total is misleading if one requested product is missing. Cartiva displays a complete basket total only when every requested line has an accepted match. Individually verified products may still begin their own history even when the full basket is incomplete.</p></section>
      <section><h2>Why Cartiva asks questions</h2><p>Details such as brand, flavor, size, count, or dietary preference can change which product is correct. Clarification questions reduce accidental substitutions and make full-cart comparison more trustworthy.</p></section>
    </CartivaInformationPage>
  );
}
