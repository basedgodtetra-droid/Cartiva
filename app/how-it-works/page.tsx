import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Database,
  LockKeyhole,
  MapPinCheck,
  PackageCheck,
  ShieldCheck,
} from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Reveal } from "@/components/reveal";

export const metadata: Metadata = {
  title: "How it works",
  description: "How Cartiva matches grocery items, qualifies complete baskets, labels data sources, and hands shoppers off to retailers.",
};

const matchingChecks = [
  { icon: PackageCheck, title: "Equivalent product", body: "The item identity, requested variety, package size or count, and quantity must be reasonably equivalent." },
  { icon: MapPinCheck, title: "Relevant location", body: "The price and availability must apply to the selected store or a clearly identified ZIP-localized estimate." },
  { icon: CheckCircle2, title: "Usable evidence", body: "The result needs a current price, availability signal, fulfillment context, and enough detail for Cartiva to stand behind the match." },
];

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-transparent text-[#17211b]">
      <SiteHeader />
      <main id="main-content">
        <section className="glass-hero glass-hero--method">
          <div className="mx-auto grid w-full max-w-[1240px] gap-10 px-5 py-14 sm:px-8 sm:py-24 lg:grid-cols-[0.34fr_1fr] lg:items-end lg:gap-16 lg:py-32">
            <div className="page-index-card hero-enter hero-enter--2 glass-interactive glass-surface order-2 rounded-[28px] p-6 sm:p-7 lg:order-1">
              <p className="text-sm font-semibold text-[#315e46]">Method / 01</p>
              <div className="mt-12 grid grid-cols-[1fr_0.55fr_0.22fr] gap-2" aria-hidden="true">
                <span className="h-1.5 rounded-full bg-[#5b8d70]/55" />
                <span className="h-1.5 rounded-full bg-[#b8df87]/58" />
                <span className="h-1.5 rounded-full bg-white/80" />
              </div>
            </div>
            <div className="hero-enter order-1 lg:order-2">
              <p className="section-kicker">How Cartiva works</p>
              <h1 className="internal-hero-title hero-title-gradient mt-5 max-w-4xl text-[clamp(2.65rem,6vw,5rem)] font-semibold leading-[0.98] tracking-[-0.055em]">Trust the basket before comparing the total.</h1>
              <p className="mt-7 max-w-3xl text-lg leading-8 text-[#536059] sm:text-xl">Cartiva starts with one list, matches equivalent products retailer by retailer, and only compares a basket when every requested item clears the same trust checks.</p>
            </div>
          </div>
        </section>

        <Reveal>
        <section className="ambient-section mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 sm:py-28">
          <div className="mb-12 flex items-end justify-between gap-6">
            <h2 className="text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">Every match must pass three checks.</h2>
            <span className="glass-field hidden rounded-full px-4 py-2 text-xs font-semibold text-[#627168] sm:block">Qualification standard</span>
          </div>
          <div className="reveal-stagger grid gap-5 md:grid-cols-3">
            {matchingChecks.map((check) => {
              const Icon = check.icon;
              return (
                <article key={check.title} className="glass-interactive glass-surface rounded-[28px] p-7 hover:shadow-[0_34px_90px_rgba(34,64,47,0.16)] sm:p-8">
                  <span className="grid size-11 place-items-center rounded-[18px] border border-white/80 bg-white/46 text-[#225d40] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]"><Icon className="size-[1.125rem]" aria-hidden="true" /></span>
                  <h3 className="mt-8 text-xl font-semibold tracking-[-0.03em]">{check.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-[#626e66]">{check.body}</p>
                </article>
              );
            })}
          </div>
        </section>
        </Reveal>

        <Reveal>
        <section className="emerald-section-light">
          <div className="mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 sm:py-28">
            <div className="glass-surface-strong grid overflow-hidden rounded-[32px] lg:grid-cols-[0.82fr_1.18fr]">
              <div className="p-8 sm:p-10 lg:border-r lg:border-white/70 lg:p-14">
                <p className="text-sm font-semibold text-[#3c6b51]">The complete-basket rule</p>
                <h2 className="mt-4 text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">Five requested items means five reliable matches.</h2>
                <p className="mt-5 leading-7 text-[#5c6860]">Cartiva does not add up four items and let that cheaper-looking partial total compete with a five-item basket.</p>
              </div>
              <div className="grid content-center gap-4 border-t border-white/70 p-7 sm:p-10 lg:border-t-0 lg:p-14">
                <div className="glass-field rounded-[24px] border-l-4 border-l-[#2f7450] px-6 py-6 transition-colors duration-300 ease-out hover:bg-white/68">
                  <p className="flex items-center gap-2 font-extrabold text-[#225d40]"><CheckCircle2 className="size-5 shrink-0" aria-hidden="true" /> Complete — 5 of 5 reliable matches</p>
                  <p className="mt-2 text-sm leading-6 text-[#59665e]">A total may be shown and compared after every row also passes source, location, freshness, availability, and package-equivalence checks.</p>
                </div>
                <div className="rounded-[24px] border border-white/70 border-l-4 border-l-[#a06c2d] bg-[#fff8ee]/65 px-6 py-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl transition-colors duration-300 ease-out hover:bg-[#fffaf2]/85">
                  <p className="flex items-center gap-2 font-extrabold text-[#7a5423]"><CircleAlert className="size-5 shrink-0" aria-hidden="true" /> Excluded — 4 of 5 reliable matches</p>
                  <p className="mt-2 text-sm leading-6 text-[#695f52]">No partial total, savings claim, lowest badge, or primary purchase action appears. The exact gap is stated instead.</p>
                </div>
              </div>
            </div>
          </div>
        </section>
        </Reveal>

        <Reveal>
        <section className="mx-auto w-full max-w-[1240px] px-5 py-24 sm:px-8 sm:py-32">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold text-[#3c6b51]">Two separate labels</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">Where data came from is not the same as where it applies.</h2>
          </div>
          <div className="reveal-stagger mt-12 grid gap-6 md:grid-cols-2">
            <article className="glass-interactive glass-surface rounded-[30px] p-7 hover:shadow-[0_34px_90px_rgba(34,64,47,0.16)] sm:p-9">
              <p className="inline-flex items-center gap-2 rounded-full border border-[#9eb5a5]/70 bg-[#eaf5ed]/70 px-3.5 py-2 text-xs font-semibold text-[#285f42]"><ShieldCheck className="size-3.5" aria-hidden="true" /> Official retailer API</p>
              <h3 className="mt-6 text-2xl font-semibold tracking-[-0.035em]">Source provenance</h3>
              <p className="mt-3 leading-7 text-[#5f6b63]">This badge means the result came through a retailer-owned interface. A separate line still identifies whether the price applies to an exact selected store.</p>
            </article>
            <article className="glass-interactive glass-surface rounded-[30px] bg-[linear-gradient(145deg,rgba(255,255,255,0.78),rgba(247,248,242,0.58))] p-7 hover:shadow-[0_34px_90px_rgba(34,64,47,0.13)] sm:p-9">
              <p className="inline-flex items-center gap-2 rounded-full border border-[#c9ba82]/65 bg-[#f7efd7]/78 px-3.5 py-2 text-xs font-semibold text-[#6d5820]"><Database className="size-3.5" aria-hidden="true" /> Third-party data</p>
              <h3 className="mt-6 text-2xl font-semibold tracking-[-0.035em]">Source provenance</h3>
              <p className="mt-3 leading-7 text-[#5f6b63]">This badge means the listing was sourced outside a retailer API. Cartiva says it is not retailer-verified and labels its location precision, such as a ZIP-localized estimate.</p>
            </article>
          </div>
        </section>
        </Reveal>

        <Reveal>
        <section className="dark-band text-white">
          <div className="mx-auto grid w-full max-w-[1240px] gap-10 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-2 lg:items-center lg:gap-16">
            <div>
              <p className="text-sm font-semibold text-[#a8c2af]">Where Cartiva stops</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">The retailer owns checkout. Always.</h2>
              <p className="mt-5 max-w-xl leading-7 text-[#c3cec6]">When you choose a retailer, Cartiva opens that retailer’s site or app. Cartiva never places your order, never accepts payment, and never asks a retailer to favor one result over another.</p>
            </div>
            <div className="glass-interactive rounded-[30px] border border-white/15 bg-white/8 p-7 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_26px_70px_rgba(0,0,0,0.16)] backdrop-blur-2xl hover:bg-white/10 sm:p-9">
              <p className="flex items-center gap-3 font-extrabold"><LockKeyhole className="size-5 text-[#b9d7c0]" aria-hidden="true" /> Comparison and handoff only</p>
              <p className="mt-3 text-sm leading-6 text-[#c3cec6]">Retailer prices, taxes, fees, substitutions, inventory, and final availability are confirmed with the retailer at checkout.</p>
              <Link href="/compare" className="pressable mt-7 inline-flex min-h-12 items-center gap-2 rounded-full border border-white/55 bg-gradient-to-b from-[#e3fa9f] to-[#b7e983] px-6 text-sm font-semibold text-[#113b26] shadow-[0_14px_32px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.72)] hover:from-[#ecffb4] hover:to-[#c7f194]">Try the comparison preview <ArrowRight className="size-4" aria-hidden="true" /></Link>
            </div>
          </div>
        </section>
        </Reveal>

        <Reveal>
        <section className="glass-interactive glass-surface mx-auto my-16 flex w-[calc(100%-2.5rem)] max-w-[1176px] flex-col gap-6 rounded-[28px] bg-[linear-gradient(135deg,rgba(226,247,231,0.78),rgba(249,249,239,0.68))] px-7 py-8 sm:my-24 sm:w-[calc(100%-4rem)] sm:px-9 sm:py-10 md:flex-row md:items-center md:justify-between">
          <div><h2 className="text-2xl font-semibold tracking-[-0.04em]">Still curious?</h2><p className="mt-2 text-sm leading-6 text-[#626e66]">See straightforward answers about prices, substitutions, privacy, and retailer coverage.</p></div>
          <Link href="/faq" className="primary-cta pressable inline-flex min-h-11 items-center gap-2 self-start rounded-full px-6 text-sm font-semibold text-white">Read the FAQ <ArrowRight className="size-4" aria-hidden="true" /></Link>
        </section>
        </Reveal>
      </main>
      <SiteFooter />
    </div>
  );
}
