import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Reveal } from "@/components/reveal";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Answers about Cartiva grocery prices, data sources, complete baskets, substitutions, checkout, and retailer placement.",
};

const questions = [
  {
    question: "Does Cartiva place my grocery order?",
    answer: "No. Cartiva compares eligible baskets and sends you to the retailer you choose. Your order and checkout happen on that retailer’s site or app. Cartiva never handles payment information.",
  },
  {
    question: "Why might the final retailer total be different?",
    answer: "Prices and inventory can change, and a retailer may add taxes, fees, deposits, or substitutions at checkout. Cartiva shows the source, location scope, and comparison context for its basket; the retailer confirms the final amount.",
  },
  {
    question: "What happens when an item cannot be matched?",
    answer: "That retailer is excluded from the full-cart price comparison, or the gap is called out explicitly. Cartiva does not show a partial total as if it covered the whole list.",
  },
  {
    question: "How does Cartiva treat substitutions?",
    answer: "A product must be reasonably equivalent in identity, variety, size or count, and quantity. An uncertain substitution or package mismatch keeps the basket from being marked complete.",
  },
  {
    question: "Where do prices and availability come from?",
    answer: "Some results come from official retailer APIs; others may come from third-party data services. Cartiva labels those sources separately and also states whether a price is tied to an exact store or is a localized estimate.",
  },
  {
    question: "Do retailers pay for higher placement?",
    answer: "No. Cartiva is designed as an independent comparison tool. Paid placement does not decide which eligible basket is called lowest or shown first.",
  },
  {
    question: "Why is a retailer missing from my comparison?",
    answer: "The retailer may not serve the ZIP, its data may be unavailable, or Cartiva may not have enough reliable evidence for every item. The comparison should state the reason instead of inventing a total.",
  },
  {
    question: "Is third-party data the same as retailer-verified data?",
    answer: "No. Third-party data is explicitly marked as not retailer-verified. It can still be useful, but Cartiva keeps its provenance distinct from an official retailer API result.",
  },
];

export default function FaqPage() {
  return (
    <div className="min-h-screen bg-transparent text-[#17211b]">
      <SiteHeader />
      <main id="main-content">
        <section className="glass-hero glass-hero--faq">
          <div className="mx-auto grid w-full max-w-[1240px] gap-10 px-5 py-14 sm:px-8 sm:py-24 lg:grid-cols-[0.34fr_1fr] lg:items-end lg:gap-16 lg:py-32">
            <div className="page-index-card hero-enter hero-enter--2 glass-interactive glass-surface order-2 rounded-[28px] p-6 sm:p-7 lg:order-1">
              <p className="text-sm font-semibold text-[#315e46]">Reference / 03</p>
              <div className="mt-12 grid grid-cols-[0.7fr_1fr_0.28fr] gap-2" aria-hidden="true">
                <span className="h-1.5 rounded-full bg-[#b8df87]/58" />
                <span className="h-1.5 rounded-full bg-[#5b8d70]/38" />
                <span className="h-1.5 rounded-full bg-white/80" />
              </div>
            </div>
            <div className="hero-enter order-1 lg:order-2">
              <p className="section-kicker">Frequently asked questions</p>
              <h1 className="internal-hero-title hero-title-gradient mt-5 max-w-4xl text-[clamp(2.65rem,6vw,5rem)] font-semibold leading-[0.98] tracking-[-0.055em]">Straight answers, before you compare.</h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-[#58645d]">How totals qualify, what source labels mean, and exactly where Cartiva’s role ends.</p>
            </div>
          </div>
        </section>

        <section className="ambient-section mx-auto grid w-full max-w-[1240px] gap-10 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[280px_1fr] lg:gap-14">
          <Reveal className="h-fit lg:sticky lg:top-28">
          <div className="glass-interactive glass-surface rounded-[28px] p-7 hover:shadow-[0_30px_80px_rgba(34,64,47,0.15)]">
            <p className="text-sm font-semibold text-[#315e46]">Eight answers</p>
            <h2 className="mt-4 text-2xl font-semibold tracking-[-0.04em]">The comparison rules, in plain language.</h2>
            <p className="mt-4 text-sm leading-6 text-[#626e66]">Open any question for the exact policy Cartiva follows.</p>
          </div>
          </Reveal>
          <div>
            <div className="grid gap-4">
              {questions.map((item, index) => (
                <Reveal key={item.question} delay={Math.min(index * 35, 140)}>
                <details className="faq-item glass-interactive glass-surface group overflow-hidden rounded-[26px] hover:shadow-[0_28px_76px_rgba(34,64,47,0.14)] open:bg-[linear-gradient(145deg,rgba(255,255,255,0.92),rgba(228,245,232,0.76))]" open={index === 0}>
                  <summary className="grid min-h-20 cursor-pointer list-none grid-cols-[36px_1fr_24px] items-center gap-4 px-5 py-5 font-semibold tracking-[-0.02em] focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[#174f38] sm:min-h-24 sm:px-7 [&::-webkit-details-marker]:hidden">
                    <span className="faq-index grid size-8 place-items-center rounded-full border border-white/80 bg-white/46 text-xs font-semibold tabular-nums text-[#68766d] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">{String(index + 1).padStart(2, "0")}</span>
                    <span>{item.question}</span>
                    <ChevronDown className="size-5 shrink-0 text-[#617068] transition-transform duration-300 ease-out group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
                  </summary>
                  <p className="max-w-3xl border-t border-white/55 px-5 py-7 text-sm leading-7 text-[#5f6b63] sm:px-[84px]">{item.answer}</p>
                </details>
                </Reveal>
              ))}
            </div>

            <Reveal>
            <div className="glass-interactive glass-surface-strong mt-10 rounded-[30px] bg-[linear-gradient(135deg,rgba(215,244,224,0.82),rgba(247,249,237,0.72))] p-8 hover:shadow-[0_36px_96px_rgba(34,64,47,0.17)] sm:flex sm:items-center sm:justify-between sm:gap-8 sm:p-10">
              <div><h2 className="text-2xl font-semibold tracking-[-0.035em]">See the rules in action.</h2><p className="mt-2 text-sm leading-6 text-[#59675e]">Try the interactive comparison preview with a transparent example basket.</p></div>
              <Link href="/compare" className="primary-cta pressable mt-6 inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full px-6 text-sm font-semibold text-white sm:mt-0">Try the preview <ArrowRight className="size-4" aria-hidden="true" /></Link>
            </div>
            </Reveal>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
