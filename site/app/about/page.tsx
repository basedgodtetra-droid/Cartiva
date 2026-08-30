import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Eye, HandCoins, ShieldCheck } from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Reveal } from "@/components/reveal";

export const metadata: Metadata = {
  title: "About",
  description: "Why Cartiva is building an independent, transparent grocery basket comparison assistant.",
};

const principles = [
  { icon: Eye, title: "Show the evidence", body: "Source, store precision, match quality, completeness, and exclusions belong beside the total—not behind fine print." },
  { icon: ShieldCheck, title: "Fail closed", body: "When the data cannot support a complete, equivalent basket, Cartiva says so instead of presenting a misleading comparison." },
  { icon: HandCoins, title: "Keep the choice neutral", body: "Retailers do not buy the lowest badge. The shopper chooses where to continue, and checkout stays with that retailer." },
];

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-transparent text-[#17211b]">
      <SiteHeader />
      <main id="main-content">
        <section className="glass-hero glass-hero--about">
          <div className="mx-auto grid w-full max-w-[1240px] gap-10 px-5 py-14 sm:px-8 sm:py-24 lg:grid-cols-[0.34fr_1fr] lg:items-end lg:gap-16 lg:py-32">
            <div className="page-index-card hero-enter hero-enter--2 glass-interactive glass-surface order-2 rounded-[28px] p-6 sm:p-7 lg:order-1">
              <p className="text-sm font-semibold text-[#315e46]">Company / 04</p>
              <div className="mt-12 grid grid-cols-[1fr_0.4fr_0.65fr] gap-2" aria-hidden="true">
                <span className="h-1.5 rounded-full bg-[#5b8d70]/55" />
                <span className="h-1.5 rounded-full bg-white/80" />
                <span className="h-1.5 rounded-full bg-[#b8df87]/58" />
              </div>
            </div>
            <div className="hero-enter order-1 grid gap-10 lg:order-2 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
              <div>
                <p className="section-kicker">About Cartiva</p>
                <h1 className="internal-hero-title hero-title-gradient mt-5 text-[clamp(2.8rem,7vw,5rem)] font-semibold leading-[0.98] tracking-[-0.06em]">Grocery comparison should earn your trust.</h1>
              </div>
              <div className="glass-interactive glass-field max-w-2xl rounded-[26px] p-6 hover:bg-white/68 sm:p-7">
                <p className="text-lg leading-8 text-[#4f5e55]">Cartiva is an independent grocery comparison and cart-building assistant for a frustratingly ordinary problem: finding the best price for the entire list without rebuilding it in every retailer app.</p>
              </div>
            </div>
          </div>
        </section>

        <Reveal>
        <section className="ambient-section">
          <div className="mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 sm:py-28">
            <div className="mb-12 flex items-end justify-between gap-6">
              <h2 className="text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">The principles behind every result.</h2>
              <span className="glass-field hidden rounded-full px-4 py-2 text-xs font-semibold text-[#627168] sm:block">Operating standard</span>
            </div>
            <div className="reveal-stagger grid gap-5 md:grid-cols-3">
              {principles.map((principle) => {
                const Icon = principle.icon;
                return (
                  <article key={principle.title} className="glass-interactive glass-surface rounded-[28px] p-7 sm:p-8">
                    <span className="grid size-11 place-items-center rounded-[18px] border border-white/80 bg-white/46 text-[#225d40] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]"><Icon className="size-[1.125rem]" aria-hidden="true" /></span>
                    <h3 className="mt-8 text-xl font-semibold tracking-[-0.03em]">{principle.title}</h3>
                    <p className="mt-3 text-sm leading-6 text-[#626e66]">{principle.body}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
        </Reveal>

        <Reveal>
        <section className="emerald-section-light">
          <div className="mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 sm:py-28">
            <div className="glass-surface-strong grid overflow-hidden rounded-[32px] lg:grid-cols-2">
              <div className="p-8 sm:p-10 lg:border-r lg:border-white/70 lg:p-14">
                <p className="text-sm font-semibold text-[#3c6b51]">The product boundary</p>
                <h2 className="mt-4 text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">Cartiva is not another grocery store.</h2>
              </div>
              <div className="space-y-7 border-t border-white/55 bg-white/16 p-8 text-base leading-8 text-[#58645d] sm:p-10 lg:border-t-0 lg:p-14">
                <p>Cartiva organizes one request into comparable retailer baskets. It does not sell groceries, accept payment, place orders, or become the merchant of record.</p>
                <p>When a shopper chooses a retailer, Cartiva hands the decision back to that retailer’s site or app. Retailer inventory, pricing, substitutions, taxes, and fees remain final there.</p>
                <p>This boundary keeps the product focused: clearer evidence before checkout, with no dark pattern pushing a retailer that cannot support the full list.</p>
              </div>
            </div>
          </div>
        </section>
        </Reveal>

        <Reveal>
        <section className="cta-panel-dark glass-interactive mx-auto my-16 flex w-[calc(100%-2.5rem)] max-w-[1176px] flex-col gap-7 rounded-[28px] px-7 py-9 text-white sm:my-24 sm:w-[calc(100%-4rem)] sm:px-9 sm:py-10 md:flex-row md:items-center md:justify-between">
          <div><h2 className="text-2xl font-semibold tracking-[-0.04em]">See what a trustworthy comparison looks like.</h2><p className="mt-2 text-sm leading-6 text-[#c7d9cd]">A representative product preview shows complete baskets, source badges, and an honest exclusion.</p></div>
          <Link href="/compare" className="pressable inline-flex min-h-12 shrink-0 items-center gap-2 self-start rounded-full border border-white/55 bg-gradient-to-b from-[#e3fa9f] to-[#b7e983] px-6 text-sm font-semibold text-[#113b26] shadow-[0_14px_32px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.72)] hover:from-[#ecffb4] hover:to-[#c7f194]">Try the preview <ArrowRight className="size-4" aria-hidden="true" /></Link>
        </section>
        </Reveal>
      </main>
      <SiteFooter />
    </div>
  );
}
