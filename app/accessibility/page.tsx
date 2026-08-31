import type { Metadata } from "next";
import { CartivaInformationPage } from "@/components/cartiva-information-page";

export const metadata: Metadata = { title: "Accessibility", description: "Cartiva's accessibility commitment and the interaction patterns supported by the current product." };

export default function AccessibilityPage() {
  return (
    <CartivaInformationPage eyebrow="Trust" title="Accessibility" lede="Cartiva is committed to making grocery planning and comparison usable by as many people as possible.">
      <section><h2>Current design practices</h2><ul><li>Keyboard-operable links, buttons, editable list controls, and navigation.</li><li>Semantic headings, forms, labels, status messages, and descriptive control names.</li><li>Visible, restrained focus indicators that do not rely on a bright decorative glow.</li><li>Readable contrast, responsive layouts, and larger touch targets for core controls.</li><li>Reduced-motion behavior when your device requests it.</li></ul></section>
      <section><h2>Assistive technology</h2><p>Cartiva uses standard web controls and live status regions so screen readers can follow store lookup, basket comparison, validation, and cart handoff. The interface is tested as it evolves, but this statement is a commitment—not a claim of formal conformance certification.</p></section>
      <section><h2>Feedback</h2><p>If a Cartiva feature prevents you from completing a task, please report the page, device, browser, and assistive technology involved through the current options on the Contact page.</p></section>
    </CartivaInformationPage>
  );
}
