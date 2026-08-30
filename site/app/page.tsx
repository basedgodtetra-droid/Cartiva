import Link from "next/link";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Database,
  ListChecks,
  Scale,
  SearchCheck,
  ShieldCheck,
} from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Reveal } from "@/components/reveal";
import { HeroProductDemo } from "@/components/hero-product-demo";
import { CartivaMotto } from "@/components/cartiva-motto";
import { SmartGroceryNotepad } from "@/components/smart-grocery-notepad";

const steps = [
  {
    number: "01",
    icon: ListChecks,
    title: "Enter one list",
    body: "Paste the list you actually plan to buy, then add your ZIP so Cartiva can look for relevant nearby options.",
  },
  {
    number: "02",
    icon: SearchCheck,
    title: "Match like with like",
    body: "Cartiva checks product identity, package size, location, fulfillment, price freshness, and availability—not just similar names.",
  },
  {
    number: "03",
    icon: Scale,
    title: "Compare the full cart",
    body: "Only complete, trustworthy baskets receive a total. Choose one, then finish with the retailer on its own site or app.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-transparent text-[#17211b]">
      <SiteHeader />
      <main id="main-content">
        <section className="glass-hero home-hero border-b border-white/70">
          <HeroProductDemo>
            <div className="home-hero-copy flex flex-col">
              <p className="hero-enter home-hero-chip glass-chip order-1 inline-flex w-fit items-center gap-2.5 rounded-full px-3.5 py-2 text-xs font-semibold tracking-[-0.01em] text-[#17623f]">
                <span className="hero-badge-dot size-1.5 rounded-full bg-[#0c9a61] shadow-[0_0_0_4px_rgba(12,154,97,0.14),0_0_16px_rgba(12,154,97,0.28)]" aria-hidden="true" />
                Independent grocery comparison
              </p>
              <CartivaMotto className="order-2 mt-8 max-w-[700px]" />
              <p className="hero-enter hero-enter--3 home-hero-intro order-3 mt-8 max-w-[610px] text-lg leading-8 text-[#45584d] sm:text-xl">
                Stop rebuilding the same list across grocery apps. Cartiva matches equivalent products nearby and ranks only the baskets it can verify as complete.
              </p>

              <SmartGroceryNotepad />

              <div className="hero-enter hero-enter--5 hero-trust-bar order-5 mt-8 grid overflow-hidden rounded-2xl text-sm font-bold text-[#314a3b] sm:grid-cols-3">
                {[
                  "No paid placement",
                  "No order handling",
                  "Sources always labeled",
                ].map((promise) => (
                  <span key={promise} className="hero-trust-item flex min-h-14 items-center gap-2.5 border-b border-white/60 px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
                    <Check className="hero-trust-check shrink-0" aria-hidden="true" /> {promise}
                  </span>
                ))}
              </div>

              <p className="hero-disclaimer order-6 mt-3 text-xs leading-5 text-[#596a60]">Comparison only. Checkout always happens with the retailer.</p>
            </div>
          </HeroProductDemo>
        </section>

        <Reveal className="deferred-section">
        <section className="dark-band border-y border-white/10 py-4 text-white" aria-label="Cartiva trust promises">
          <div className="reveal-stagger mx-auto grid w-full max-w-[1240px] gap-3 px-5 sm:grid-cols-3 sm:px-8">
            <div className="glass-interactive flex gap-4 rounded-[22px] border border-white/10 bg-white/[0.08] px-5 py-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"><span className="text-xs font-semibold text-[#cfeaa8]">01</span><div><h2 className="font-semibold">Complete means complete</h2><p className="mt-2 text-sm leading-6 text-[#c1cdc4]">A missing or uncertain item disqualifies a basket from the price comparison.</p></div></div>
            <div className="glass-interactive flex gap-4 rounded-[22px] border border-white/10 bg-white/[0.08] px-5 py-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"><span className="text-xs font-semibold text-[#cfeaa8]">02</span><div><h2 className="font-semibold">Every source disclosed</h2><p className="mt-2 text-sm leading-6 text-[#c1cdc4]">Official retailer data and third-party estimates are always labeled separately.</p></div></div>
            <div className="glass-interactive flex gap-4 rounded-[22px] border border-white/10 bg-white/[0.08] px-5 py-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"><span className="text-xs font-semibold text-[#cfeaa8]">03</span><div><h2 className="font-semibold">Checkout stays private</h2><p className="mt-2 text-sm leading-6 text-[#c1cdc4]">Cartiva never places an order and never receives payment information.</p></div></div>
          </div>
        </section>
        </Reveal>

        <Reveal className="deferred-section">
        <section className="ambient-section mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 sm:py-28">
          <div className="grid gap-8 pb-10 lg:grid-cols-[0.75fr_1.25fr] lg:items-end">
            <p className="flex items-center gap-3 text-sm font-semibold text-[#3c6b51]"><span className="h-px w-8 bg-[#3c6b51]" /> The Cartiva method</p>
            <div>
              <h2 className="text-4xl font-semibold tracking-[-0.055em] sm:text-6xl">A fair total starts<br className="hidden sm:block" /> before the math.</h2>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-[#5a665f]">Product names alone are not enough. Cartiva checks the details that make one basket genuinely comparable to another.</p>
            </div>
          </div>
          <div className="reveal-stagger grid gap-5 md:grid-cols-3">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <article key={step.number} className="glass-interactive glass-surface rounded-[28px] p-6 hover:shadow-[0_30px_80px_rgba(34,64,47,0.16)] sm:p-8">
                  <div className="flex items-center justify-between">
                    <span className="grid size-11 place-items-center rounded-[14px] border border-white/90 bg-white/55 text-[#225d40] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_20px_rgba(36,74,50,0.08)]"><Icon className="size-5" aria-hidden="true" /></span>
                    <span className="text-xs font-semibold text-[#6d786f]">{step.number} of 03</span>
                  </div>
                  <h3 className="mt-10 text-xl font-semibold tracking-[-0.035em]">{step.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-[#626e66]">{step.body}</p>
                </article>
              );
            })}
          </div>
          <Link href="/how-it-works" className="pressable glass-field mt-8 inline-flex min-h-12 items-center gap-3 rounded-full px-5 text-sm font-semibold text-[#174f38] hover:bg-white/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#174f38]">
            Read the matching rules <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </section>
        </Reveal>

        <Reveal className="deferred-section">
        <section className="emerald-section-light border-y border-white/70">
          <div className="mx-auto grid w-full max-w-[1240px] gap-8 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[0.72fr_1.28fr] lg:items-center">
            <div className="lg:pr-12">
              <p className="text-sm font-semibold text-[#3c6b51]">Trust and data sourcing</p>
              <h2 className="mt-6 text-4xl font-semibold tracking-[-0.055em] sm:text-5xl">Know what the number knows.</h2>
              <p className="mt-5 leading-7 text-[#58645c]">A live price is not automatically an official price. Every result separates who supplied the data from how precise the location and price are.</p>
            </div>
            <div className="glass-surface-strong overflow-hidden rounded-[28px]">
              {[
                { icon: ShieldCheck, label: "Official retailer API", index: "A", tone: "text-[#255b3f]", body: "Data supplied through a retailer-owned interface. Exact store and fulfillment scope are still shown separately." },
                { icon: Database, label: "Third-party data", index: "B", tone: "text-[#745f27]", body: "Collected outside a retailer API. Clearly marked as not retailer-verified and possibly a ZIP-localized estimate." },
                { icon: CircleAlert, label: "Excluded basket", index: "C", tone: "text-[#7a3f32]", body: "A size mismatch, missing item, uncertain substitution, stale price, or wrong location keeps a basket out of the totals." },
              ].map((row) => {
                const Icon = row.icon;
                return (
                    <div key={row.label} className="comparison-row grid gap-5 border-b border-white/70 bg-white/22 p-5 last:border-b-0 sm:grid-cols-[40px_0.8fr_1.2fr] sm:items-center sm:p-7">
                    <span className="text-xs font-semibold text-[#7a847d]">{row.index}</span>
                    <p className={`flex items-center gap-2 text-sm font-semibold ${row.tone}`}><Icon className="size-4" aria-hidden="true" /> {row.label}</p>
                    <p className="text-sm leading-6 text-[#626e66]">{row.body}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
        </Reveal>

        <Reveal className="deferred-section">
        <section className="mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 sm:py-28">
          <div className="cta-panel-dark glass-interactive grid gap-10 overflow-hidden rounded-[32px] p-7 text-white sm:p-10 lg:grid-cols-[1fr_auto] lg:items-end lg:p-12">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold text-[#ccefa6]">Independent by design</p>
            <h2 className="mt-6 text-4xl font-semibold tracking-[-0.055em] sm:text-6xl">The result is yours.<br />So is the checkout.</h2>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[#c7d9cd]">Retailers do not buy better placement. Cartiva ranks comparable baskets by the evidence and total shown, then gets out of the way before checkout.</p>
          </div>
          <div className="grid min-w-60 gap-3">
            <Link href="/compare" className="pressable inline-flex min-h-14 items-center justify-between gap-4 rounded-full border border-white/55 bg-gradient-to-b from-[#e3fa9f] to-[#b7e983] px-5 text-sm font-bold text-[#103a25] shadow-[0_16px_36px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.72)] hover:from-[#ecffb4] hover:to-[#c7f194]">Try the product preview <ArrowRight className="size-4" aria-hidden="true" /></Link>
            <Link href="/about" className="pressable inline-flex min-h-14 items-center rounded-full border border-white/20 bg-white/12 px-5 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] hover:bg-white/16">About Cartiva</Link>
          </div>
          </div>
        </section>
        </Reveal>
      </main>
      <SiteFooter />
    </div>
  );
}
