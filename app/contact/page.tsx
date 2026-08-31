import type { Metadata } from "next";
import { CartivaInformationPage } from "@/components/cartiva-information-page";

export const metadata: Metadata = { title: "Contact", description: "Current ways to share Cartiva product, accessibility, privacy, or technical feedback." };

export default function ContactPage() {
  return (
    <CartivaInformationPage eyebrow="Cartiva" title="Contact" lede="Share a product issue, accessibility barrier, privacy question, or data-quality concern.">
      <section><h2>Current support channel</h2><p>Cartiva does not yet advertise a public support email or postal address. During this development release, use the project’s GitHub issue tracker or the same invitation/testing channel through which you received access.</p><p><a href="https://github.com/basedgodtetra-droid/Cartiva/issues" target="_blank" rel="noreferrer">Open the Cartiva issue tracker</a></p></section>
      <section><h2>What to include</h2><p>For comparison issues, include the requested item, ZIP or store area, selected store, approximate time, and what looked incorrect. Do not post Kroger passwords, OAuth codes, payment details, or other sensitive account information.</p></section>
      <section><h2>Legal and privacy contact</h2><p>A dedicated legal/privacy contact must be added before public launch. Until then, label an issue as a privacy or legal question and avoid including personal information in a public report.</p></section>
    </CartivaInformationPage>
  );
}
