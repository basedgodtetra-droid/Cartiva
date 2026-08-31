import type { Metadata } from "next";
import { CartivaInformationPage } from "@/components/cartiva-information-page";

export const metadata: Metadata = { title: "Retailer independence", description: "How Cartiva keeps retailer comparison separate from sponsorship and paid placement." };

export default function RetailerIndependencePage() {
  return (
    <CartivaInformationPage eyebrow="Trust" title="Retailer independence" lede="Cartiva's comparison methodology is meant to reflect the actual basket evidence—not who pays for placement.">
      <section><h2>No paid-placement ranking</h2><p>Cartiva does not rank retailers based on paid placement. When multiple complete, comparable retailer baskets are available, order and recommendations should follow the disclosed comparison methodology, including completeness, product match, location, and price evidence.</p></section>
      <section><h2>Retailer relationships</h2><p>A retailer connection or API is a way to obtain product data or hand a cart back to that retailer. It does not by itself mean the retailer sponsors, endorses, or owns Cartiva.</p></section>
      <section><h2>Current product scope</h2><p>The current live web workspace has one connected retailer comparison: Kroger. Walmart and Target are shown as not connected rather than being assigned invented totals. Cartiva will only present additional live comparisons when a source and complete-basket method are available.</p></section>
      <section><h2>Trademarks</h2><p>Retailer names and trademarks belong to their respective owners. Cartiva uses retailer references to identify data sources and handoff destinations; those references do not necessarily imply sponsorship or endorsement.</p></section>
    </CartivaInformationPage>
  );
}
