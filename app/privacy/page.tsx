import type { Metadata } from "next";
import Link from "next/link";
import { CartivaInformationPage } from "@/components/cartiva-information-page";

export const metadata: Metadata = { title: "Privacy Policy", description: "How the current Cartiva web app handles grocery lists, local saved data, store location, and Kroger OAuth." };

export default function PrivacyPage() {
  return (
    <CartivaInformationPage eyebrow="Legal" title="Privacy Policy" lede="A plain-language account of the data the current Cartiva web app uses and where it is kept." updated="August 31, 2026" legalReview>
      <section><h2>Information used by Cartiva</h2><p>When you use Cartiva, the app can process grocery-list text, requested quantities, fulfillment preference, ZIP code, selected store, product matches, UPC or product identifiers, package information, price evidence, comparison timestamps, and cart-handoff status.</p></section>
      <section><h2>Saved lists, baskets, and history</h2><p>If you save or compare items, the current account-free experience stores the active workspace, named lists, historical baskets, verified product observations, and recent activity in local browser storage on your device. Local browser storage is not encrypted by Cartiva and does not synchronize to another device.</p><p>Deleting a list removes that saved list, and deleting a basket removes that saved basket. Verified price history intentionally remains so a deleted list or basket does not silently rewrite the historical record. Clearing Cartiva’s site data in your browser removes the local workspace and library records on that browser.</p></section>
      <section><h2>Kroger connection</h2><p>Cartiva uses Kroger OAuth when you choose to add a verified basket to Kroger. Kroger handles its own sign-in screen. Cartiva receives authorization results and tokens, not your Kroger password. In the deployed web app, connection state may be stored in encrypted, secure, HTTP-only cookies so the handoff can continue.</p></section>
      <section><h2>Payments and checkout</h2><p>Checkout remains on the retailer’s service. Cartiva does not receive the retailer payment-card information you enter during checkout. The cart handoff uses the selected store, fulfillment mode, product UPCs, quantities, and an operation identifier.</p></section>
      <section><h2>Cookies, local storage, and retention</h2><p>Cartiva uses local storage for the account-free library described above and essential cookies for OAuth state and connection sessions. OAuth state is short-lived; a connection cookie may persist for up to 30 days unless it expires or is cleared. The current site does not include advertising cookies or a web analytics integration.</p></section>
      <section><h2>Security</h2><p>Cartiva limits cart operations to recently verified products and uses encrypted connection state and secure cookie settings in the deployed OAuth flow. No system can guarantee absolute security. Browser-stored lists and history depend on the security of your device and browser profile.</p></section>
      <section><h2>Your choices</h2><p>You can use the core list and comparison experience without creating a Cartiva account. You can delete individual saved lists and baskets in Cartiva or clear all Cartiva site data using your browser controls. Clearing cookies also removes browser-held connection state and may require a new Kroger authorization.</p></section>
      <section><h2>Contact</h2><p>For privacy questions, use the current channel listed on the <Link href="/contact">Contact page</Link>. Cartiva does not yet advertise a dedicated privacy email address.</p></section>
    </CartivaInformationPage>
  );
}
