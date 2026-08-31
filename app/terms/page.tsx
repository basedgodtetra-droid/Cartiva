import type { Metadata } from "next";
import Link from "next/link";
import { CartivaInformationPage } from "@/components/cartiva-information-page";

export const metadata: Metadata = { title: "Terms of Service", description: "Terms for using Cartiva's grocery comparison and retailer cart handoff service." };

export default function TermsPage() {
  return (
    <CartivaInformationPage eyebrow="Legal" title="Terms of Service" lede="These terms describe Cartiva's comparison, saved-library, and retailer handoff service." updated="August 31, 2026" legalReview>
      <section><h2>What Cartiva provides</h2><p>Cartiva helps shoppers organize grocery lists, compare supported retailer products, build a complete basket, and hand verified items to a retailer. Cartiva is not the retailer, seller, delivery provider, or payment processor.</p></section>
      <section><h2>Retailer prices and availability</h2><p>Displayed prices and availability reflect the source, store, fulfillment mode, and time identified in Cartiva. They can change after a comparison. The retailer determines the final products, substitutions, taxes, fees, availability, order terms, and amount charged at checkout.</p><p>Historical baskets and price observations are records of an earlier comparison, not current offers. Use “Check prices again” before relying on an older result.</p></section>
      <section><h2>Checkout and third-party services</h2><p>Checkout occurs with the retailer. Cartiva does not receive retailer payment-card details and does not guarantee that a retailer will accept a cart handoff or fulfill an order. Retailer sites, accounts, loyalty programs, and orders are governed by the retailer’s own terms and policies.</p></section>
      <section><h2>Data sources and matching</h2><p>Cartiva may use official retailer APIs and other clearly labeled sources. Product matching considers the requested item, package, store, and available evidence, but a match may still require shopper review. Incomplete baskets are not shown as complete totals.</p></section>
      <section><h2>Saved data</h2><p>Without an account, the current web app saves lists, historical baskets, and verified price observations in the shopper’s browser. That data may be lost if the browser’s site data is cleared, storage is unavailable, or the device is replaced. Cartiva does not currently promise cross-device synchronization or recovery.</p></section>
      <section><h2>Acceptable use</h2><p>Use Cartiva for lawful personal shopping and evaluation. Do not interfere with the service, attempt unauthorized access, evade retailer or Cartiva safeguards, misuse OAuth connections, scrape at disruptive scale, or use Cartiva to violate another service’s terms or another person’s rights.</p></section>
      <section><h2>Intellectual property</h2><p>Cartiva’s name, interface, original copy, and software are protected by applicable intellectual-property laws. Retailer names, product information, and trademarks remain the property of their respective owners; references identify retailers and do not necessarily imply sponsorship or endorsement.</p></section>
      <section><h2>Service availability and limitations</h2><p>Cartiva may change, suspend, or discontinue features and may be unavailable because of maintenance, retailer changes, network failures, or other conditions. Use the service as an aid to shopping decisions and verify important details with the retailer before checkout.</p></section>
      <section><h2>Changes and contact</h2><p>Cartiva may update these terms as the product changes. The updated date above will identify the current version. Questions can be directed through the current options on the <Link href="/contact">Contact page</Link>.</p></section>
    </CartivaInformationPage>
  );
}
