"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  ArrowRight,
  Check,
  Database,
  MapPin,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import {
  comparableRetailers,
  excludedRetailer,
  PREVIEW_ZIP,
} from "@/lib/comparison-preview";
import {
  getHeroDemoSavingsCents,
  HERO_DEMO_CHECKS,
  HERO_DEMO_ITEMS,
  HERO_DEMO_TIMELINE,
  type HeroDemoAction,
  type HeroDemoPhase,
} from "@/lib/home-hero-demo";

const walmart = comparableRetailers.find((retailer) => retailer.id === "walmart")!;
const kingSoopers = comparableRetailers.find(
  (retailer) => retailer.id === "king-soopers",
)!;
const finalSavingsCents = getHeroDemoSavingsCents();

const panelCopy: Record<HeroDemoPhase, { title: string; status: string }> = {
  idle: { title: "One list becomes comparable carts", status: "Example demo" },
  typing: { title: "Building one grocery list", status: "Example demo" },
  location: { title: "Adding the pickup area", status: "Example demo" },
  pressing: { title: "Ready to compare full carts", status: "Example demo" },
  comparing: { title: "Comparing your basket...", status: "Checking 80202" },
  results: { title: "Complete baskets found", status: "2 complete baskets" },
  winner: { title: "Lowest complete cart wins", status: "2 complete baskets" },
  complete: { title: "Your complete carts, compared.", status: "Demo complete" },
  manual: { title: "Your list is in your hands", status: "Demo paused" },
};

function phaseProgress(phase: HeroDemoPhase) {
  switch (phase) {
    case "typing":
      return 0.14;
    case "location":
      return 0.26;
    case "pressing":
      return 0.36;
    case "comparing":
      return 0.6;
    case "results":
      return 0.78;
    case "winner":
      return 0.92;
    case "complete":
      return 1;
    default:
      return 0;
  }
}

function liveAnnouncement(phase: HeroDemoPhase) {
  if (phase === "comparing") {
    return "Comparing a fixed example basket for ZIP 80202.";
  }

  if (phase === "results") {
    return "Example results found two complete baskets. Target is excluded because only four of five items matched.";
  }

  if (phase === "complete") {
    return `Example complete. Walmart is the lowest complete basket at $${walmart.total.toFixed(2)}, saving $${(
      finalSavingsCents / 100
    ).toFixed(2)} compared with King Soopers. Target remains excluded.`;
  }

  if (phase === "manual") {
    return "Automatic example paused. Your current entries are preserved and you are in control.";
  }

  return "";
}

export function HeroProductDemo({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runTokenRef = useRef(0);
  const hasAutoPlayedRef = useRef(false);
  const userInteractedRef = useRef(false);
  const completedRef = useRef(false);

  const [phase, setPhase] = useState<HeroDemoPhase>("idle");
  const [lineCount, setLineCount] = useState(0);
  const [zipCount, setZipCount] = useState(0);
  const [checkCount, setCheckCount] = useState(0);
  const [retailerCount, setRetailerCount] = useState(0);
  const [runId, setRunId] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  const clearPlayback = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

  }, []);

  const cancelDemo = useCallback(() => {
    if (userInteractedRef.current) return;
    userInteractedRef.current = true;
    completedRef.current = false;
    runTokenRef.current += 1;
    clearPlayback();
    setPhase("manual");
  }, [clearPlayback]);

  const beginDemo = useCallback(() => {
    if (userInteractedRef.current) return;

    completedRef.current = false;
    setRunId((current) => current + 1);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(mediaQuery.matches);

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    const stage = rootRef.current?.querySelector<HTMLElement>(".hero-demo-stage");
    if (!stage) return;

    let observer: IntersectionObserver | null = null;

    const isVisible = () => {
      const rect = stage.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    };

    const startOnce = () => {
      if (
        hasAutoPlayedRef.current ||
        userInteractedRef.current ||
        document.visibilityState !== "visible"
      ) {
        return;
      }

      hasAutoPlayedRef.current = true;
      observer?.disconnect();
      beginDemo();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible" && isVisible()) startOnce();
    };

    document.addEventListener("visibilitychange", handleVisibility);

    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) startOnce();
        },
        { threshold: 0.25 },
      );
      observer.observe(stage);
    } else if (isVisible()) {
      startOnce();
    }

    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [beginDemo]);

  useEffect(() => {
    if (runId === 0 || userInteractedRef.current || completedRef.current) return;

    clearPlayback();
    const token = runTokenRef.current + 1;
    runTokenRef.current = token;

    const applyAction = (action: HeroDemoAction) => {
      if (action.kind === "phase") {
        setPhase(action.phase);
        if (action.phase === "complete") {
          completedRef.current = true;
        }
        return true;
      }

      if (action.kind === "lines") {
        setLineCount(action.count);
        return true;
      }

      if (action.kind === "zip") {
        setZipCount(action.count);
        return true;
      }

      if (action.kind === "checks") {
        setCheckCount(action.count);
        return true;
      }

      setRetailerCount(action.count);
      return true;
    };

    const runAction = (index: number) => {
      if (runTokenRef.current !== token || index >= HERO_DEMO_TIMELINE.length) {
        return;
      }

      const action = HERO_DEMO_TIMELINE[index];
      const previousTime = index === 0 ? 0 : HERO_DEMO_TIMELINE[index - 1].at;
      const delay = Math.max(0, action.at - previousTime);

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (runTokenRef.current !== token) return;

        applyAction(action);

        runAction(index + 1);
      }, delay);
    };

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (runTokenRef.current !== token) return;

      setPhase("idle");
      setLineCount(reducedMotion ? HERO_DEMO_ITEMS.length : 0);
      setZipCount(reducedMotion ? PREVIEW_ZIP.length : 0);
      setCheckCount(reducedMotion ? HERO_DEMO_CHECKS.length : 0);
      setRetailerCount(reducedMotion ? 3 : 0);

      if (reducedMotion) {
        setPhase("complete");
        completedRef.current = true;
        return;
      }

      runAction(0);
    }, 0);

    return () => {
      if (runTokenRef.current === token) runTokenRef.current += 1;
      clearPlayback();
    };
  }, [clearPlayback, reducedMotion, runId]);

  const replayDemo = () => {
    if (phase !== "complete" || userInteractedRef.current) return;
    beginDemo();
  };

  const handleNotepadInteraction = (event: SyntheticEvent<HTMLDivElement>) => {
    if (userInteractedRef.current) return;
    const form = rootRef.current?.querySelector("[data-hero-comparison-form]");
    if (form && event.target instanceof Node && form.contains(event.target)) cancelDemo();
  };

  const startYourComparison = () => {
    cancelDemo();
    const list = rootRef.current?.querySelector<HTMLTextAreaElement>("#grocery-list");
    list?.focus();
  };

  const isComparing = phase === "comparing";
  const showsResults = phase === "results" || phase === "winner" || phase === "complete";
  const showsWinner = phase === "winner" || phase === "complete";
  const isRunning = !["idle", "manual", "complete"].includes(phase);
  const copy = panelCopy[phase];
  const progress = phaseProgress(phase);

  return (
    <div
      ref={rootRef}
      className="home-hero-layout hero-demo-layout mx-auto grid w-full max-w-[1240px] gap-12 px-5 py-14 sm:px-8 sm:py-20 lg:grid-cols-[1.14fr_0.86fr] lg:items-start lg:gap-12 lg:py-24"
      data-demo-phase={phase}
      data-demo-running={isRunning ? "true" : "false"}
      onFocusCapture={handleNotepadInteraction}
      onPointerDownCapture={handleNotepadInteraction}
    >
      {children}

      <section
        className="hero-demo-stage relative min-w-0 lg:flex lg:items-center lg:pt-32"
        aria-labelledby="hero-demo-title"
        aria-describedby="hero-demo-disclosure"
        aria-busy={isComparing}
      >
        <div className="absolute -left-5 top-32 hidden h-[76%] w-[88%] rotate-[-3deg] rounded-[34px] border border-[#95c9a6]/28 bg-[#dff3e4]/48 shadow-[0_26px_64px_rgba(3,73,45,0.12)] lg:block" aria-hidden="true" />
        <div className="hero-enter hero-enter--3 hero-product-float hero-product-shell consumer-comparison hero-demo-panel glass-surface-strong relative flex w-full min-w-0 flex-col overflow-hidden rounded-[32px]">
          <header className="hero-demo-panel-header grid gap-4 border-b border-white/70 bg-white/26 p-5 sm:grid-cols-[1fr_auto] sm:items-start sm:p-6">
            <div className="min-w-0">
              <p id="hero-demo-disclosure" className="hero-demo-disclosure text-xs font-semibold tracking-[-0.01em] text-[#68736c]">
                Example comparison · fixed sample data · not live prices
              </p>
              <h2 id="hero-demo-title" className="mt-2 text-2xl font-semibold tracking-[-0.045em]">
                {copy.title}
              </h2>
            </div>
            <div className={`status-pill ${showsWinner ? "status-pill--complete" : ""}`}>
              {copy.status}
            </div>
          </header>

          <div className="hero-demo-panel-body">
            {phase === "manual" ? (
              <div className="hero-demo-manual grid place-items-center px-5 py-10 text-center sm:px-8">
                <div className="max-w-sm">
                  <span className="mx-auto grid size-12 place-items-center rounded-2xl border border-[#76b68e]/30 bg-[#e3f5e8]/78 text-[#17623f] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                    <Check className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold tracking-[-0.025em]">Automatic demo paused</h3>
                  <p className="mt-2 text-sm leading-6 text-[#617068]">
                    Your current list and ZIP are preserved. Use the real comparison button whenever you are ready.
                  </p>
                </div>
              </div>
            ) : isComparing ? (
              <div className="hero-demo-checking px-5 py-6 sm:px-6 sm:py-7">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold text-[#68736c]">Fixed example · ZIP 80202</p>
                    <p className="mt-1 text-sm font-semibold text-[#244632]">Checking all 5 requested items</p>
                  </div>
                  <span className="hero-demo-check-count tabular-nums">{checkCount}/4</span>
                </div>
                <ol className="hero-demo-check-list mt-6 grid gap-3">
                  {HERO_DEMO_CHECKS.map((label, index) => {
                    const visible = index < checkCount;
                    return (
                      <li
                        key={label}
                        className="hero-demo-check-item flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-sm font-semibold"
                        data-visible={visible ? "true" : "false"}
                        aria-hidden={!visible}
                      >
                        <span className="grid size-7 shrink-0 place-items-center rounded-full">
                          <Check className="size-4" aria-hidden="true" />
                        </span>
                        {label}
                      </li>
                    );
                  })}
                </ol>
              </div>
            ) : showsResults ? (
              <div className="hero-demo-results">
                <div className="hero-demo-column-labels hidden grid-cols-[1.2fr_1.1fr_0.8fr] border-b border-white/65 bg-white/18 px-5 py-2.5 text-[0.7rem] font-bold uppercase tracking-[0.11em] text-[#596960] sm:grid sm:px-6">
                  <span>Retailer / evidence</span><span>Status</span><span className="text-right">Basket total</span>
                </div>
                <div className="hero-demo-results-stack">
                  {retailerCount >= 1 ? (
                    <article className={`demo-retailer-row comparison-row grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-white/70 p-5 sm:grid-cols-[1.2fr_1.1fr_0.8fr] sm:items-center sm:px-6 ${showsWinner ? "comparison-winner demo-winner-active bg-[#dcf2e2]/76" : "comparison-complete bg-white/32"}`}>
                      <div className="min-w-0">
                        <p className="font-semibold">{walmart.name}</p>
                        <p className="mt-1 flex items-center gap-1.5 text-[0.68rem] font-semibold text-[#705c26]"><Database className="size-3.5 shrink-0" aria-hidden="true" /> {walmart.source}</p>
                      </div>
                      <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-auto">
                        <span key={showsWinner ? "winner" : "complete"} className={`status-pill ${showsWinner ? "status-pill--winner demo-winner-badge" : "status-pill--complete"}`}>
                          {showsWinner ? "Lowest complete" : "Complete"}
                        </span>
                        <p className="mt-1.5 text-xs text-[#68736c]">5/5 · localized estimate</p>
                      </div>
                      <div className="col-start-2 row-start-1 text-right sm:col-auto sm:row-auto">
                        <span className="text-xs font-semibold text-[#52655a] sm:hidden">Basket total</span>
                        <p className={`tabular-nums sm:text-right ${showsWinner ? "demo-winning-price text-3xl font-bold tracking-[-0.045em] text-[#08754d]" : "text-2xl font-bold tracking-[-0.04em]"}`}>${walmart.total.toFixed(2)}</p>
                      </div>
                    </article>
                  ) : null}

                  {retailerCount >= 2 ? (
                    <article className="demo-retailer-row comparison-row comparison-complete grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-white/65 bg-white/32 p-5 sm:grid-cols-[1.2fr_1.1fr_0.8fr] sm:items-center sm:px-6">
                      <div className="min-w-0">
                        <p className="font-semibold">{kingSoopers.name}</p>
                        <p className="mt-1 flex items-center gap-1.5 text-[0.68rem] font-semibold text-[#2f694a]"><ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" /> {kingSoopers.source}</p>
                      </div>
                      <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-auto">
                        <span className="status-pill status-pill--complete">Complete</span>
                        <p className="mt-1.5 text-xs text-[#68736c]">5/5 · selected store</p>
                      </div>
                      <div className="col-start-2 row-start-1 text-right sm:col-auto sm:row-auto">
                        <span className="text-xs font-semibold text-[#52655a] sm:hidden">Basket total</span>
                        <p className="text-2xl font-bold tracking-[-0.04em] tabular-nums sm:text-right">${kingSoopers.total.toFixed(2)}</p>
                      </div>
                    </article>
                  ) : null}

                  {retailerCount >= 3 ? (
                    <article className="demo-retailer-row comparison-row comparison-excluded grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-white/65 bg-[#fff5e8]/46 p-5 sm:grid-cols-[1.2fr_1.1fr_0.8fr] sm:items-center sm:px-6">
                      <div className="min-w-0">
                        <p className="font-semibold">{excludedRetailer.name}</p>
                        <p className="mt-1 flex items-center gap-1.5 text-[0.68rem] font-semibold text-[#705c26]"><Database className="size-3.5 shrink-0" aria-hidden="true" /> {excludedRetailer.source}</p>
                      </div>
                      <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-auto">
                        <span className="status-pill status-pill--excluded">Excluded · {excludedRetailer.matchedCount} of {excludedRetailer.requestedCount}</span>
                        <p className="mt-1.5 text-xs text-[#6a6256]">Yogurt package mismatch</p>
                      </div>
                      <div className="col-start-2 row-start-1 text-right sm:col-auto sm:row-auto">
                        <span className="text-xs font-semibold text-[#77521f] sm:hidden">Basket total</span>
                        <p className="text-sm font-semibold text-[#77521f] sm:text-right">No total shown</p>
                      </div>
                    </article>
                  ) : null}
                </div>

                {showsWinner ? (
                  <div className="hero-demo-savings flex items-center justify-between gap-4 px-5 py-4 sm:px-6" aria-label={`Example savings versus the next complete basket: $${(finalSavingsCents / 100).toFixed(2)}`}>
                    <span className="text-xs font-semibold leading-5 text-[#4e6256]">Versus the next complete basket</span>
                    <strong className="text-lg tracking-[-0.025em] tabular-nums text-[#08754d]" aria-hidden="true">Save ${(finalSavingsCents / 100).toFixed(2)}</strong>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="hero-demo-prep px-5 py-6 sm:px-6 sm:py-7">
                <div className="grid gap-4 sm:grid-cols-[1fr_0.72fr]">
                  <div className="hero-demo-mini-card rounded-[22px] border border-white/75 bg-white/36 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold text-[#65736a]">One grocery list</p>
                      <span className="text-xs font-bold tabular-nums text-[#17623f]">{lineCount}/5</span>
                    </div>
                    <ul className="mt-3 grid gap-2.5" aria-hidden="true">
                      {HERO_DEMO_ITEMS.map((item, index) => {
                        const visible = index < lineCount;
                        return (
                          <li key={item} className="hero-demo-list-line flex min-h-5 items-center gap-2" data-visible={visible ? "true" : "false"}>
                            {visible ? <Check className="size-3.5 shrink-0 text-[#24805a]" /> : <span className="size-3.5 shrink-0 rounded-full border border-[#a9c6b3]/55" />}
                            {visible ? <span className="truncate text-xs font-semibold text-[#3e5146]">{item}</span> : <span className="hero-demo-placeholder-line" />}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  <div className="grid gap-4">
                    <div className="hero-demo-mini-card rounded-[22px] border border-white/75 bg-white/36 p-4">
                      <p className="text-xs font-semibold text-[#65736a]">Pickup area</p>
                      <p className="mt-3 flex items-center gap-2 text-lg font-bold tracking-[0.08em] tabular-nums text-[#244632]">
                        <MapPin className="size-4 text-[#24805a]" aria-hidden="true" />
                        {zipCount ? PREVIEW_ZIP.slice(0, zipCount) : "— — — — —"}
                      </p>
                    </div>
                    <div className="hero-demo-mini-card rounded-[22px] border border-white/75 bg-[#e6f6e9]/55 p-4">
                      <p className="text-xs font-semibold text-[#65736a]">Cartiva checks</p>
                      <p className="mt-2 text-sm font-semibold leading-5 text-[#244632]">Every item before any total</p>
                    </div>
                  </div>
                </div>
                <div className="hero-demo-flow mt-5 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 text-center text-[0.68rem] font-bold text-[#52665a]">
                  <span>One list</span><ArrowRight className="size-3.5 text-[#72917e]" aria-hidden="true" /><span>Full carts</span><ArrowRight className="size-3.5 text-[#72917e]" aria-hidden="true" /><span>Lowest total</span>
                </div>
              </div>
            )}
          </div>

          <footer className="hero-demo-footer border-t border-white/70 bg-white/28 px-5 py-4 sm:px-6">
            {phase === "complete" ? (
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
                <p className="text-sm font-semibold text-[#294936]">Ready to compare your own complete carts?</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={startYourComparison} aria-controls="grocery-list" className="hero-demo-start pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#0a6d48] px-4 text-xs font-bold text-white shadow-[0_10px_24px_rgba(5,94,57,0.22)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#174f38]">
                    Start your comparison <ArrowRight className="size-3.5" aria-hidden="true" />
                  </button>
                  <button type="button" onClick={replayDemo} className="hero-demo-replay inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-semibold text-[#56675d] hover:bg-white/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#174f38]">
                    <RotateCcw className="size-3.5" aria-hidden="true" /> Replay demo
                  </button>
                </div>
              </div>
            ) : phase === "manual" ? (
              <p className="text-center text-xs font-semibold text-[#5e7065]">Demo stopped · your input will not be overwritten</p>
            ) : (
              <div className="flex items-center gap-3" aria-hidden="true">
                <div className="hero-demo-progress-track h-1.5 flex-1 overflow-hidden rounded-full bg-[#b8d4c0]/34">
                  <span className="block h-full origin-left rounded-full bg-gradient-to-r from-[#1a9a64] to-[#a4cf55]" style={{ transform: `scaleX(${progress})` }} />
                </div>
                <span className="text-[0.68rem] font-bold text-[#637269]">Product walkthrough</span>
              </div>
            )}
          </footer>
        </div>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {liveAnnouncement(phase)}
        </p>
      </section>
    </div>
  );
}
