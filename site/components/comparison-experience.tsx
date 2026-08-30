"use client";

import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Database,
  LockKeyhole,
  MapPin,
  ShieldCheck,
} from "lucide-react";
import { type CSSProperties, FormEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  PREVIEW_LIST,
  PREVIEW_ZIP,
  comparableRetailers,
  excludedRetailer,
  loadingStages,
  type PreviewItem,
} from "@/lib/comparison-preview";

type ComparisonExperienceProps = {
  initialList?: string;
  initialZip?: string;
  autoStart?: boolean;
};

type ValidationErrors = {
  list?: string;
  zip?: string;
};

type ViewState = "idle" | "loading" | "results";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function validate(list: string, zip: string): ValidationErrors {
  const errors: ValidationErrors = {};
  const items = list
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (items.length === 0) {
    errors.list = "Add at least one grocery item, one per line.";
  }

  if (!/^\d{5}$/.test(zip.trim())) {
    errors.zip = "Enter a 5-digit ZIP code.";
  }

  return errors;
}

function SourceBadge({ source }: { source: "Official retailer API" | "Third-party data" }) {
  const official = source === "Official retailer API";
  const Icon = official ? ShieldCheck : Database;

  return (
    <span
      className={
        official
          ? "inline-flex items-center gap-1.5 rounded-full border border-[#9fbea8]/45 bg-[#e6f3e8]/72 px-2.5 py-1 text-[0.7rem] font-extrabold text-[#205e3f] shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] backdrop-blur-md"
          : "inline-flex items-center gap-1.5 rounded-full border border-[#cbb889]/45 bg-[#f5ecd8]/72 px-2.5 py-1 text-[0.7rem] font-extrabold text-[#765722] shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] backdrop-blur-md"
      }
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {source}
    </span>
  );
}

function MatchBadge({ quality }: Pick<PreviewItem, "quality">) {
  const uncertain = quality === "Uncertain";
  const label = uncertain ? "Uncertain · not counted" : quality;

  return (
    <span
      className={
        uncertain
          ? "rounded-full border border-[#d7a991]/50 bg-[#fae9df]/72 px-2.5 py-1 text-[0.69rem] font-extrabold text-[#914b31] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] backdrop-blur-md"
          : "rounded-full border border-[#abc1b0]/45 bg-[#eaf2eb]/72 px-2.5 py-1 text-[0.69rem] font-extrabold text-[#486253] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] backdrop-blur-md"
      }
    >
      {label}
    </span>
  );
}

function StatusPill({ tone, children }: { tone: "winner" | "complete" | "excluded"; children: React.ReactNode }) {
  return <span className={`status-enter status-pill status-pill--${tone}`}>{children}</span>;
}

function BasketItems({ items, showPrices }: { items: PreviewItem[]; showPrices: boolean }) {
  return (
    <div className="grid gap-3 border-t border-white/75 py-4 md:grid-cols-2">
      {items.map((item) => {
        const uncertain = item.quality === "Uncertain";
        const ItemIcon = uncertain ? CircleAlert : CheckCircle2;

        return (
          <div key={item.request} className={`basket-item-card flex min-w-0 items-start gap-3 rounded-[20px] border p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] ${uncertain ? "basket-item-card--uncertain border-[#dfc7aa]/65 bg-[#fff3e1]/58" : "border-white/70 bg-white/32"}`}>
            <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full ${uncertain ? "bg-[#f3ddc5] text-[#895428]" : "bg-[#e5f1e7] text-[#276447]"}`}>
              <ItemIcon className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[#5f6d64]">Requested: {item.request}</p>
                  <p className="mt-1.5 text-sm font-semibold leading-5 text-[#202d25]">{item.match}</p>
                </div>
                {showPrices && typeof item.price === "number" ? (
                  <p className="shrink-0 text-base font-bold tabular-nums text-[#202d25]">{money.format(item.price)}</p>
                ) : null}
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <MatchBadge quality={item.quality} />
                <span className="text-xs font-semibold tabular-nums text-[#5f6d64]">{item.size}</span>
              </div>
              {item.note ? <p className="mt-2 border-l-2 border-[#c88769] pl-2 text-xs font-semibold leading-5 text-[#8a4b32]">{item.note}</p> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ComparisonExperience({
  initialList = PREVIEW_LIST,
  initialZip = PREVIEW_ZIP,
  autoStart = false,
}: ComparisonExperienceProps) {
  const [list, setList] = useState(initialList || PREVIEW_LIST);
  const [zip, setZip] = useState(initialZip || PREVIEW_ZIP);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [view, setView] = useState<ViewState>("idle");
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const didAutoStart = useRef(false);

  const beginComparison = useCallback(
    (nextList = list, nextZip = zip) => {
      const nextErrors = validate(nextList, nextZip);
      setErrors(nextErrors);

      if (Object.keys(nextErrors).length > 0) {
        setView("idle");
        return false;
      }

      setView("loading");
      return true;
    },
    [list, zip],
  );

  useEffect(() => {
    if (!autoStart || didAutoStart.current) return;
    didAutoStart.current = true;
    beginComparison(initialList, initialZip);
  }, [autoStart, beginComparison, initialList, initialZip]);

  useEffect(() => {
    if (Object.keys(errors).length > 0) {
      errorSummaryRef.current?.focus();
    }
  }, [errors]);

  useEffect(() => {
    if (view !== "loading") return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => {
      setView("results");
    }, prefersReducedMotion ? 50 : 700);

    return () => window.clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    if (view === "results") {
      resultsHeadingRef.current?.focus();
    }
  }, [view]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    beginComparison();
  }

  function resetViewAfterEdit() {
    if (view !== "idle") {
      setView("idle");
    }
    if (Object.keys(errors).length > 0) setErrors({});
  }

  return (
    <div className="space-y-12">
      <section aria-labelledby="list-heading" className="grid gap-10 pb-4 lg:grid-cols-[0.82fr_1.18fr] lg:items-start lg:gap-14">
        <div className="hero-enter pt-1">
          <p className="text-[0.7rem] font-black uppercase tracking-[0.2em] text-[#397052]">Interactive product preview</p>
          <h1 id="list-heading" className="hero-title-gradient mt-5 max-w-xl text-[clamp(2.55rem,5vw,4.6rem)] font-semibold leading-[0.94] tracking-[-0.06em]">
            One list. Only complete baskets compared.
          </h1>
          <p className="mt-6 max-w-xl border-l-2 border-[#7f9b88] pl-5 text-lg leading-8 text-[#515e56]">
            Paste a grocery list and ZIP code to walk through Cartiva&apos;s matching flow. This preview uses a fixed example basket so every claim stays clear and verifiable.
          </p>
          <div className="glass-surface mt-8 divide-y divide-white/60 overflow-hidden rounded-[24px] text-sm font-semibold leading-6 text-[#3f4d44]">
            <p className="flex gap-3 bg-white/20 px-4 py-3.5 transition-colors duration-300 ease-out hover:bg-white/38 motion-reduce:transition-none"><Check className="mt-1 size-4 shrink-0 text-[#2b7250]" aria-hidden="true" />Retailer totals appear only after every requested item has a trustworthy match.</p>
            <p className="flex gap-3 bg-white/12 px-4 py-3.5 transition-colors duration-300 ease-out hover:bg-white/34 motion-reduce:transition-none"><Database className="mt-1 size-4 shrink-0 text-[#2b7250]" aria-hidden="true" />Official API data and third-party data are labeled separately.</p>
            <p className="flex gap-3 bg-white/20 px-4 py-3.5 transition-colors duration-300 ease-out hover:bg-white/38 motion-reduce:transition-none"><LockKeyhole className="mt-1 size-4 shrink-0 text-[#2b7250]" aria-hidden="true" />Cartiva never places an order or receives payment information.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} noValidate className="comparison-input-card hero-enter hero-enter--2 hero-product-shell glass-surface-strong relative overflow-hidden rounded-[28px] p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/75 bg-white/18 pb-5">
            <div>
              <p className="text-xs font-bold text-[#6d7870]">Your inputs</p>
              <h2 className="mt-1.5 text-xl font-semibold tracking-[-0.035em] text-[#1c2921]">Build a comparison</h2>
            </div>
            <span className="rounded-full border border-white/70 bg-white/46 px-3 py-1.5 text-xs font-extrabold text-[#526158] shadow-[inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-md">No checkout</span>
          </div>

          {Object.keys(errors).length > 0 ? (
            <div ref={errorSummaryRef} tabIndex={-1} role="alert" className="mt-5 rounded-2xl border border-[#dfb9a7]/70 bg-[#fff2ec]/78 px-4 py-3 text-sm font-bold text-[#833f29] shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] backdrop-blur-md outline-none focus:ring-2 focus:ring-[#a45c42]/55">
              Check the highlighted field{Object.keys(errors).length > 1 ? "s" : ""} and try again.
            </div>
          ) : null}

          <div className="mt-5">
            <label htmlFor="comparison-list" className="text-sm font-black text-[#28372e]">Grocery list</label>
            <p id="comparison-list-help" className="mt-1 text-xs leading-5 text-[#6b756e]">One item per line. Include package size when it matters.</p>
            <textarea
              id="comparison-list"
              value={list}
              onChange={(event) => {
                setList(event.target.value);
                resetViewAfterEdit();
              }}
              rows={7}
              aria-invalid={Boolean(errors.list)}
              aria-describedby={`comparison-list-help${errors.list ? " comparison-list-error" : ""}`}
              className="structured-list-field comparison-list-field glass-field mt-2 w-full resize-y rounded-2xl px-4 py-3 text-sm leading-6 text-[#26342b] outline-none transition-[background-color,border-color,box-shadow] duration-300 ease-out focus:border-[#4f8165]/65 focus:bg-white/72 focus:ring-2 focus:ring-[#8fb39a]/35 aria-[invalid=true]:border-[#b86345] aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-[#d3937b]/35 motion-reduce:transition-none"
            />
            {errors.list ? <p id="comparison-list-error" className="mt-2 text-sm font-semibold text-[#97492e]">{errors.list}</p> : null}
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div>
              <label htmlFor="comparison-zip" className="text-sm font-black text-[#28372e]">ZIP code</label>
              <p id="comparison-zip-help" className="mt-1 text-xs leading-5 text-[#6b756e]">Used to determine local retailer coverage.</p>
              <div className="comparison-zip-control relative mt-2">
                <MapPin className="comparison-zip-icon pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2" aria-hidden="true" />
                <input
                  id="comparison-zip"
                  value={zip}
                  onChange={(event) => {
                    setZip(event.target.value.replace(/\D/g, "").slice(0, 5));
                    resetViewAfterEdit();
                  }}
                  inputMode="numeric"
                  autoComplete="postal-code"
                  maxLength={5}
                  aria-invalid={Boolean(errors.zip)}
                  aria-describedby={`comparison-zip-help${errors.zip ? " comparison-zip-error" : ""}`}
                  className="comparison-zip-input glass-field min-h-12 w-full rounded-2xl pl-12 pr-4 text-sm font-bold tabular-nums text-[#26342b] outline-none transition-[background-color,border-color,box-shadow] duration-300 ease-out focus:border-[#4f8165]/65 focus:bg-white/72 focus:ring-2 focus:ring-[#8fb39a]/35 aria-[invalid=true]:border-[#b86345] aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-[#d3937b]/35 motion-reduce:transition-none"
                />
              </div>
              {errors.zip ? <p id="comparison-zip-error" className="mt-2 text-sm font-semibold text-[#97492e]">{errors.zip}</p> : null}
            </div>
            <button
              type="submit"
              disabled={view === "loading"}
              className="comparison-primary-cta primary-cta pressable inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl px-6 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#08754d] disabled:cursor-wait disabled:opacity-65"
            >
              {view === "loading" ? <span className="comparison-pulse" aria-hidden="true"><span /><span /><span /></span> : null}
              {view === "loading" ? "Matching…" : "Preview comparison"}
            </button>
          </div>

          <div className="mt-5 rounded-2xl border border-[#d5c69e]/55 bg-[#fff8e8]/68 px-4 py-3 text-xs leading-5 text-[#665d45] shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-md">
            <strong className="font-black text-[#554a2f]">Preview disclosure:</strong> no live retailer lookup happens here. Results are fixed representative data for a five-item basket in ZIP {PREVIEW_ZIP}, regardless of the inputs above.
          </div>
        </form>
      </section>

      {view === "loading" ? (
        <section aria-labelledby="matching-heading" className="result-enter glass-surface overflow-hidden rounded-[30px] p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-white/80 bg-white/52 text-[#246044] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_24px_rgba(39,85,58,0.08)] backdrop-blur-lg">
              <span className="comparison-pulse" aria-hidden="true"><span /><span /><span /></span>
            </span>
            <div>
              <p className="text-xs font-semibold text-[#5f6d64]">Fixed example · not a live retailer lookup</p>
              <h2 id="matching-heading" className="mt-1.5 text-2xl font-semibold tracking-[-0.045em]">Preparing the example comparison</h2>
              <p className="mt-2 text-sm leading-6 text-[#5f6d64]">These are the checks Cartiva applies before a retailer total can appear.</p>
            </div>
          </div>

          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            Preparing the fixed example comparison. No live retailer request is being made.
          </div>

          <ol className="mt-7 grid gap-3 min-[360px]:grid-cols-2 lg:grid-cols-4">
            {loadingStages.map((stage, index) => {
              return (
                <li
                  key={stage.label}
                  style={{ "--row-delay": `${index * 45}ms` } as CSSProperties}
                  className="loading-stage-card result-row min-h-32 rounded-[24px] border border-white/70 bg-white/38 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.88)] backdrop-blur-lg"
                >
                  <div className="flex items-center gap-2">
                    <span className="grid size-6 place-items-center rounded-full border border-[#91aa99]/55 bg-[#e5f1e7]/78 text-xs font-bold text-[#2d684b] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                      {index + 1}
                    </span>
                    <p className="text-sm font-semibold text-[#334239]">{stage.label}</p>
                  </div>
                  <p className="mt-3 text-xs leading-5 text-[#626e66]">{stage.detail}</p>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {view === "results" ? (
        <section aria-labelledby="results-heading" className="space-y-8">
          <div className="results-celebration result-enter glass-surface-strong rounded-[30px] p-5 sm:flex sm:items-start sm:justify-between sm:gap-8 sm:p-7">
            <div>
              <p className="text-xs font-bold text-[#326349]">Example results · not live</p>
              <h2 ref={resultsHeadingRef} tabIndex={-1} id="results-heading" className="mt-2.5 text-3xl font-semibold tracking-[-0.05em] text-[#18261d] outline-none focus-visible:ring-2 focus-visible:ring-[#326349]">
                2 complete baskets can be compared
              </h2>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-[#526158]">
                This fixed preview uses five representative items in ZIP {PREVIEW_ZIP}. Walmart and King Soopers matched all five; Target is shown separately because one package size is uncertain.
              </p>
            </div>
            <div className="mt-5 shrink-0 sm:mt-0">
              <StatusPill tone="complete">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Completeness gate passed: 2
              </StatusPill>
            </div>
          </div>

          <div className="comparison-results-shell result-enter glass-surface-strong overflow-hidden rounded-[30px]" style={{ animationDelay: "80ms" }}>
            <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(10rem,0.55fr)_minmax(11rem,0.45fr)] gap-6 border-b border-white/70 bg-white/24 px-7 py-3 text-[0.72rem] font-bold uppercase tracking-[0.13em] text-[#57685e] lg:grid">
              <span>Retailer and evidence</span><span>Status</span><span className="text-right">Basket total</span>
            </div>
            {comparableRetailers.map((retailer, index) => {
              const winner = index === 0;

              return (
                <article key={retailer.id} style={{ "--row-delay": `${140 + index * 70}ms` } as CSSProperties} className={`result-row comparison-row border-b border-white/70 ${winner ? "comparison-winner bg-[#dcf3e2]/82" : "comparison-complete bg-white/16"}`}>
                  <div className="p-5 sm:p-6 lg:p-7">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(10rem,0.55fr)_minmax(11rem,0.45fr)] lg:items-start lg:gap-6">
                      <div>
                        <h3 className="text-2xl font-semibold tracking-[-0.045em]">{retailer.name}</h3>
                        <div className="mt-2.5"><SourceBadge source={retailer.source} /></div>
                      </div>
                      <div className="col-span-2 row-start-2 lg:col-span-1 lg:row-auto lg:pt-1">
                        <StatusPill tone={winner ? "winner" : "complete"}>{winner ? "Lowest complete total" : "Complete"}</StatusPill>
                        <p className="mt-2 text-xs font-semibold text-[#397052]">5 of 5 items matched</p>
                      </div>
                      <div className="col-start-2 row-start-1 text-right lg:col-auto lg:row-auto lg:text-right">
                        <p className="text-xs font-semibold text-[#66736b] lg:hidden">Basket total</p>
                        <p className={`price-reveal mt-1 text-4xl font-bold tracking-[-0.055em] tabular-nums lg:mt-0 ${winner ? "text-[#08754d]" : "text-[#173f2c]"}`}>{money.format(retailer.total)}</p>
                      </div>
                    </div>

                    <dl className="mt-5 grid divide-y divide-white/65 overflow-hidden rounded-[22px] border border-white/65 bg-white/30 text-xs leading-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] backdrop-blur-lg sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                      <div className="px-4 py-3.5">
                        <dt className="font-semibold text-[#5f6d64]">Data source</dt>
                        <dd className="mt-1.5 font-semibold text-[#45534a]">{retailer.sourceDetail}</dd>
                      </div>
                      <div className="px-4 py-3.5">
                        <dt className="flex items-center gap-1.5 font-semibold text-[#5f6d64]"><MapPin className="size-3.5" aria-hidden="true" />Scope</dt>
                        <dd className="mt-1.5 font-semibold text-[#45534a]">{retailer.scope}</dd>
                      </div>
                    </dl>

                    <details className="group mt-5 rounded-[24px] border border-white/65 bg-white/34 px-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.84)] backdrop-blur-lg transition-colors duration-300 hover:bg-white/46 motion-reduce:transition-none">
                      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#397052] [&::-webkit-details-marker]:hidden">
                        Review all five item matches
                        <ChevronDown className="size-4 transition-transform duration-300 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
                      </summary>
                      <BasketItems items={retailer.items} showPrices />
                    </details>
                  </div>

                  <div className="grid gap-3 border-t border-white/75 bg-white/24 p-5 backdrop-blur-lg sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:p-6 lg:px-7">
                    <a
                      href={retailer.handoffUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="primary-cta pressable inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl px-5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#08754d] sm:w-auto"
                    >
                      {retailer.handoffLabel}
                      <ArrowUpRight className="size-4" aria-hidden="true" />
                    </a>
                    <p className="text-left text-xs font-semibold leading-5 text-[#5f6d64]">
                      Opens the retailer&apos;s site. This example basket is not transferred. Cartiva stops before checkout and never receives order or payment information.
                    </p>
                  </div>
                </article>
              );
            })}

            <article style={{ "--row-delay": "280ms" } as CSSProperties} className="result-row comparison-row comparison-excluded bg-[#fff8ec]/58 p-5 shadow-[inset_3px_0_0_#bd8951] sm:p-6 lg:p-7">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(10rem,0.55fr)_minmax(11rem,0.45fr)] lg:items-start lg:gap-6">
              <div className="flex min-w-0 items-start gap-3.5">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl border border-[#d5bd99]/65 bg-[#f8ead4]/72 text-[#855d24] shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-md">
                  <CircleAlert className="size-5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-2xl font-semibold tracking-[-0.045em]">{excludedRetailer.name}</h3>
                  <div className="mt-2.5"><SourceBadge source={excludedRetailer.source} /></div>
                  <p className="mt-3 text-sm font-bold leading-6 text-[#665b4c]">{excludedRetailer.exclusionReason}</p>
                </div>
              </div>
              <div className="col-span-2 row-start-2 lg:col-span-1 lg:row-auto lg:pt-1">
                <StatusPill tone="excluded">Excluded · no total</StatusPill>
                <p className="mt-2 text-xs font-semibold leading-5 text-[#7a6e5e]">{excludedRetailer.matchedCount} of {excludedRetailer.requestedCount} items matched</p>
              </div>
              <div className="col-start-2 row-start-1 text-right lg:col-auto lg:row-auto lg:text-right">
                <p className="text-xs font-semibold text-[#836c4d]">Basket total</p>
                <p className="mt-1.5 text-lg font-bold text-[#684b25]">Not shown</p>
              </div>
            </div>

            <p className="mt-4 rounded-[18px] border border-white/70 bg-white/34 px-4 py-3 text-xs font-semibold leading-5 text-[#6d604f]">{excludedRetailer.scope}. {excludedRetailer.sourceDetail}</p>

            <details className="group mt-5 rounded-[24px] border border-white/65 bg-white/38 px-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.86)] backdrop-blur-lg transition-colors duration-300 hover:bg-white/50 motion-reduce:transition-none">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3.5 text-sm font-semibold text-[#5f513f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8b642b] [&::-webkit-details-marker]:hidden">
                Review 4 matches and 1 unaccepted substitute
                <ChevronDown className="size-4 transition-transform duration-300 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
              </summary>
              <BasketItems items={excludedRetailer.items} showPrices={false} />
            </details>
            </article>
          </div>

          <div className="result-enter glass-surface rounded-[28px] p-5 sm:flex sm:items-start sm:justify-between sm:gap-6" style={{ animationDelay: "340ms" }}>
            <div className="flex items-start gap-3">
              <LockKeyhole className="mt-0.5 size-5 shrink-0 text-[#2c684a]" aria-hidden="true" />
              <div>
                <h3 className="font-semibold tracking-[-0.015em]">The handoff is Cartiva&apos;s finish line</h3>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-[#617067]">You choose a retailer, then review availability, substitutions, fees, and checkout entirely on that retailer&apos;s site or app. Cartiva never places the order and never touches payment information.</p>
              </div>
            </div>
            <button type="button" onClick={() => setView("idle")} className="pressable mt-4 min-h-11 shrink-0 rounded-2xl border border-white/75 bg-white/52 px-4 text-sm font-semibold text-[#315b46] shadow-[inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-lg hover:bg-white/78 hover:opacity-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315b46] sm:mt-0">
              Edit list
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
