"use client";

import {
  AlertCircle,
  ArrowRight,
  Check,
  Info,
  LoaderCircle,
  MapPin,
  Mic,
  Minus,
  PencilLine,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingBasket,
  Sparkles,
  Store,
  Trash2,
  X,
} from "lucide-react";
import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { siteConfig } from "@/config/site";
import { calculateBasketTotal } from "@/lib/basket";
import { parseShoppingList } from "@/lib/list-parser";
import {
  analyzeProductFacets,
  selectedFacetLabels,
} from "@/lib/product-facets";
import type {
  MatchResult,
  RankedProduct,
  SearchPerformanceDiagnostics,
  SearchStreamEvent,
  WalmartCandidateDiagnostic,
} from "@/lib/types";
import { ItemStatus, ProductRow } from "./product-row";
import { ProductFacetChips } from "./product-facet-chips";

interface StoreSelection {
  id: string;
  name: string;
  location: string;
}

interface AssistantAppProps {
  initialStore: StoreSelection;
  initialDemoMode: boolean;
}

type DataMode = "live" | "demo" | "partial" | "error";

interface BasketItemState {
  requestedItem: string;
  quantity: number;
  status: ItemStatus;
  result?: MatchResult;
  checkedAt?: string;
  candidateDiagnostics?: WalmartCandidateDiagnostic[];
  facetOptionIds: string[];
}

interface ReviewItem {
  id: number;
  text: string;
  quantity: number;
  facetOptionIds: string[];
}

interface SpeechRecognitionResultEvent {
  results: { 0: { 0: { transcript: string } } };
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const subscribeToBrowserCapabilities = () => () => undefined;

function browserSupportsSpeechRecognition() {
  if (typeof window === "undefined") return false;
  const browserWindow = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return Boolean(browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition);
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function timeLabel(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function zipFromStoreLocation(location: string) {
  return location.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]?.slice(0, 5);
}

function stateFromStoreLocation(location: string) {
  return location.match(/,\s*([A-Z]{2})\b/i)?.[1]?.toUpperCase();
}

function appliedFacetLabels(text: string, optionIds: string[]) {
  return selectedFacetLabels(analyzeProductFacets(text, optionIds));
}

function DataStatusBadge({ mode }: { mode: DataMode }) {
  const label = mode === "demo"
    ? "Demo data"
    : mode === "error"
      ? "Walmart data unavailable"
      : mode === "partial"
        ? "Live data · some failed"
        : "Live Walmart data";
  const StatusIcon = mode === "error" ? AlertCircle : Sparkles;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.66rem] font-extrabold uppercase tracking-[0.09em] ring-1 ring-inset ${
      mode === "demo"
        ? "bg-[#d6f23f] text-[#1c2a18] ring-black/5"
        : mode === "error"
          ? "bg-[#fff1ee] text-[#a12e21] ring-[#f0b8af]"
          : mode === "partial"
            ? "bg-[#fff8e6] text-[#795500] ring-[#ead99c]"
            : "bg-[#edf7ef] text-[#17603d] ring-[#cce5d3]"
    }`}>
      <StatusIcon className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

function BrandHeader({ dataMode }: { dataMode: DataMode }) {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8 sm:py-6">
      <div className="flex items-center gap-3">
        <span className="relative grid size-10 place-items-center rounded-[0.85rem] bg-[#0d5c3b] text-[#d7f54c] shadow-[0_7px_18px_rgba(13,92,59,0.18)] ring-1 ring-inset ring-white/10">
          <ShoppingBasket className="size-[1.15rem]" strokeWidth={2.4} aria-hidden="true" />
          <span className="absolute -right-1 -top-1 size-3 rounded-full border-2 border-[#f7f6ef] bg-[#d6f23f]" />
        </span>
        <span>
          <span className="block text-[0.95rem] font-bold tracking-[-0.02em] text-[#17231b]">
            {siteConfig.name}
          </span>
          <span className="mt-0.5 block text-[0.66rem] font-medium tracking-[-0.01em] text-[#707970]">
            {siteConfig.tagline}
          </span>
        </span>
      </div>
      <DataStatusBadge mode={dataMode} />
    </header>
  );
}

export function AssistantApp({ initialStore, initialDemoMode }: AssistantAppProps) {
  const [view, setView] = useState<"home" | "review" | "results">("home");
  const [input, setInput] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [facetSelectionsByIndex, setFacetSelectionsByIndex] = useState<Record<number, string[]>>({});
  const [store, setStore] = useState(initialStore);
  const [storeDraft, setStoreDraft] = useState(initialStore);
  const [storeOpen, setStoreOpen] = useState(false);
  const [items, setItems] = useState<BasketItemState[]>([]);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [performanceDiagnostics, setPerformanceDiagnostics] = useState<SearchPerformanceDiagnostics | null>(null);
  const [dataMode, setDataMode] = useState<DataMode>(
    initialDemoMode ? "demo" : "live",
  );
  const [formError, setFormError] = useState("");
  const [listening, setListening] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const nextReviewId = useRef(1);

  const speechSupported = useSyncExternalStore(
    subscribeToBrowserCapabilities,
    browserSupportsSpeechRecognition,
    () => false,
  );

  useEffect(() => () => recognitionRef.current?.stop(), []);

  const activeParsedItems = useMemo(
    () => parseShoppingList(input.slice(0, Math.max(0, cursorPosition))),
    [cursorPosition, input],
  );
  const activeFacetIndex = Math.max(0, activeParsedItems.length - 1);
  const activeFacetQuery = activeParsedItems.at(-1) ?? "";
  const activeFacetOptionIds = facetSelectionsByIndex[activeFacetIndex] ?? [];

  const checkedCount = items.filter((item) => item.status !== "pending").length;
  const completedCount = items.filter(
    (item) => item.status !== "pending" && item.status !== "verifying",
  ).length;
  const matchedCount = items.filter((item) => item.status === "matched").length;
  const reviewCount = items.filter(
    (item) => item.status === "review" || item.status === "no-match" || item.status === "error",
  ).length;
  const allVerified =
    !searching && items.length > 0 && matchedCount === items.length && reviewCount === 0;
  const hasLocalizedPrices = items.some((item) =>
    item.status === "matched"
    && item.result?.recommended?.priceProvenance?.priceScope === "localized",
  );
  const total = useMemo(
    () => calculateBasketTotal(
      items.map((item) => item.status === "matched" ? item.result?.recommended : null),
      items.map((item) => item.quantity),
    ),
    [items],
  );
  const latestCheck = items
    .map((item) => item.checkedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const cokeCandidateDiagnostics = items.flatMap((item) =>
    item.candidateDiagnostics?.map((candidate) => ({
      requestedItem: item.requestedItem,
      candidate,
    })) ?? [],
  );

  async function runSearch(list: ReviewItem[]) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setView("results");
    setSearching(true);
    setPerformanceDiagnostics(null);
    setFormError("");
    setItems(list.map((item) => ({
      requestedItem: item.text,
      quantity: item.quantity,
      status: "pending",
      facetOptionIds: item.facetOptionIds,
    })));

    try {
      let usedDemoData = false;
      let sawLiveResult = false;
      let sawLiveError = false;
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: list.map((item) => ({
            text: item.text,
            facetOptionIds: item.facetOptionIds,
          })),
          storeId: store.id,
          zipCode: zipFromStoreLocation(store.location),
          state: stateFromStoreLocation(store.location),
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "The Walmart search could not start.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as SearchStreamEvent;
          usedDemoData = usedDemoData || event.mode === "demo";
          if (event.type === "performance") {
            setPerformanceDiagnostics(event.performance);
            if (usedDemoData) setDataMode("demo");
            continue;
          }
          if (event.mode === "live") {
            if (event.result.error) sawLiveError = true;
            else sawLiveResult = true;
          }
          setDataMode(usedDemoData
            ? "demo"
            : sawLiveResult && sawLiveError
              ? "partial"
              : sawLiveResult
                ? "live"
                : sawLiveError ? "error" : "live");
          setItems((current) => current.map((item, index) => {
            if (index !== event.index) return item;
            const status: ItemStatus = event.phase === "search" && event.result.recommended
              ? "verifying"
              : event.result.error
              ? "error"
              : event.result.status === "matched"
                ? "matched"
                : event.result.status === "no_match"
                  ? "no-match"
                  : "review";
            return {
              ...item,
              status,
              result: event.result,
              checkedAt: event.checkedAt,
              candidateDiagnostics: event.diagnostics?.candidates ?? item.candidateDiagnostics,
            };
          }));
        }

        if (done) break;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Walmart search failed.";
      setDataMode("error");
      setItems((current) => current.map((item) => item.status === "pending" || item.status === "verifying"
        ? {
            ...item,
            status: "error",
            result: {
              requestedItem: item.requestedItem,
              recommended: null,
              alternatives: [],
              confidence: "low",
              status: "review",
              explanation: "We could not check this item.",
              error: message,
            },
          }
        : item));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  function submitList(event: FormEvent) {
    event.preventDefault();
    const parsed = parseShoppingList(input);
    if (!parsed.length) {
      setFormError("Add at least one grocery item to get started.");
      return;
    }
    setReviewItems(parsed.map((text, index) => ({
      id: nextReviewId.current++,
      text,
      quantity: 1,
      facetOptionIds: analyzeProductFacets(
        text,
        facetSelectionsByIndex[index] ?? [],
      ).selectedOptionIds,
    })));
    setFormError("");
    setView("review");
  }

  function startListening() {
    const browserWindow = window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition = browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition;
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript.trim();
      const nextInput = `${input.trim()}${input.trim() ? "\n" : ""}${transcript}`;
      setInput(nextInput);
      setCursorPosition(nextInput.length);
      setFormError("");
    };
    recognition.onerror = () => {
      setFormError("Voice input did not come through. You can keep typing your list.");
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  function selectAlternative(index: number, product: RankedProduct) {
    setItems((current) => current.map((item, itemIndex) => {
      if (itemIndex !== index || !item.result) return item;
      const previous = item.result.recommended;
      const alternatives = [previous, ...item.result.alternatives]
        .filter((candidate): candidate is RankedProduct => Boolean(candidate) && candidate?.id !== product.id)
        .slice(0, 3);
      return {
        ...item,
        status: "review",
        result: {
          ...item.result,
          alternatives,
          recommended: {
            ...product,
            confidence: "low",
            verification: "unverified",
          },
          confidence: "low",
          status: "review",
          verifiedAt: undefined,
          assumptions: [],
          explanation: "This alternative has not completed a current Walmart product-detail check, so it is excluded from the verified subtotal.",
        },
      };
    }));
  }

  function updateReviewItem(id: number, text: string) {
    setReviewItems((current) => current.map((item) => item.id === id
      ? {
          ...item,
          text,
          facetOptionIds: analyzeProductFacets(text, item.facetOptionIds).selectedOptionIds,
        }
      : item));
    setFormError("");
  }

  function changeReviewQuantity(id: number, change: number) {
    setReviewItems((current) => current.map((item) => item.id === id
      ? { ...item, quantity: Math.min(20, Math.max(1, item.quantity + change)) }
      : item));
  }

  function removeReviewItem(id: number) {
    setReviewItems((current) => current.filter((item) => item.id !== id));
    setFormError("");
  }

  function addReviewItem() {
    if (reviewItems.length >= 24) return;
    setReviewItems((current) => [
      ...current,
      { id: nextReviewId.current++, text: "", quantity: 1, facetOptionIds: [] },
    ]);
    setFormError("");
  }

  function confirmReview() {
    if (!reviewItems.length) {
      setFormError("Add at least one item before searching Walmart.");
      return;
    }
    if (reviewItems.some((item) => !item.text.trim())) {
      setFormError("Finish or delete the empty item before searching.");
      return;
    }
    if (!initialDemoMode && !store.id.trim()) {
      setFormError("Add a Walmart store ID before searching live prices.");
      return;
    }

    const reviewed = reviewItems.map((item) => ({ ...item, text: item.text.trim() }));
    setReviewItems(reviewed);
    void runSearch(reviewed);
  }

  function editList() {
    abortRef.current?.abort();
    setSearching(false);
    setReviewItems(items.map((item) => ({
      id: nextReviewId.current++,
      text: item.requestedItem,
      quantity: item.quantity,
      facetOptionIds: item.facetOptionIds,
    })));
    setFormError("");
    setView("review");
  }

  function scrollToFirstReview() {
    const index = items.findIndex((item) => item.status !== "matched" && item.status !== "pending");
    if (index < 0) return;
    const target = document.getElementById(`basket-item-${index}`);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    window.setTimeout(() => target?.focus({ preventScroll: true }), reducedMotion ? 0 : 350);
  }

  if (view === "review") {
    return (
      <main className="min-h-screen overflow-x-hidden bg-[#f7f6ef] text-[#17231b]">
        <BrandHeader dataMode={dataMode} />
        <div className="mx-auto w-full max-w-3xl px-5 pb-14 pt-7 sm:px-8 sm:pt-12">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#557061]">
                Review before searching
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-[-0.045em] text-[#142119] sm:text-4xl">
                Check your list
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-[#667068] sm:text-base">
                We found {reviewItems.length} {reviewItems.length === 1 ? "item" : "items"}. Fix anything that looks combined, then confirm the quantities.
              </p>
            </div>
          </div>

          <section className="mt-7 rounded-[1.65rem] border border-black/[0.06] bg-[#fffefa] p-4 shadow-[0_22px_60px_rgba(33,53,39,0.09)] sm:p-6">
            {reviewItems.length ? (
              <ol className="space-y-3">
                {reviewItems.map((item, index) => (
                  <li
                    key={item.id}
                    className="rounded-2xl border border-[#e0e4dd] bg-white p-3.5 sm:grid sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end sm:gap-3 sm:p-4"
                  >
                    <label className="block min-w-0 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-[#758078]">
                      Item {index + 1}
                      <input
                        value={item.text}
                        onChange={(event) => updateReviewItem(item.id, event.target.value)}
                        className="mt-1.5 h-11 w-full rounded-xl border border-[#d8ddd6] bg-[#fbfcf8] px-3 text-sm font-semibold normal-case tracking-normal text-[#243128] hover:border-[#bdc8bf] focus:border-[#1b7049] focus:bg-white focus:outline-none focus:ring-4 focus:ring-[#1b7049]/10"
                        aria-label={`Shopping item ${index + 1}`}
                      />
                      {appliedFacetLabels(item.text, item.facetOptionIds).length ? (
                        <span className="mt-2 block text-[0.68rem] font-semibold normal-case tracking-normal text-[#567060]">
                          Smart options: {appliedFacetLabels(item.text, item.facetOptionIds).join(" · ")}
                        </span>
                      ) : null}
                    </label>

                    <div className="mt-3 sm:mt-0">
                      <p className="mb-1.5 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-[#758078]">
                        Quantity
                      </p>
                      <div className="inline-flex h-11 items-center rounded-xl border border-[#d8ddd6] bg-[#fbfcf8] p-1">
                        <button
                          type="button"
                          onClick={() => changeReviewQuantity(item.id, -1)}
                          disabled={item.quantity <= 1}
                          className="grid size-8 place-items-center rounded-lg text-[#405047] hover:bg-white disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#14613f]"
                          aria-label={`Decrease quantity for ${item.text || `item ${index + 1}`}`}
                        >
                          <Minus className="size-3.5" />
                        </button>
                        <span className="w-8 text-center text-sm font-bold tabular-nums" aria-live="polite">
                          {item.quantity}
                        </span>
                        <button
                          type="button"
                          onClick={() => changeReviewQuantity(item.id, 1)}
                          disabled={item.quantity >= 20}
                          className="grid size-8 place-items-center rounded-lg text-[#405047] hover:bg-white disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#14613f]"
                          aria-label={`Increase quantity for ${item.text || `item ${index + 1}`}`}
                        >
                          <Plus className="size-3.5" />
                        </button>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => removeReviewItem(item.id)}
                      className="mt-3 grid size-11 place-items-center rounded-xl border border-transparent text-[#8a615d] hover:border-red-100 hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9c2f26] sm:mt-0"
                      aria-label={`Delete ${item.text || `item ${index + 1}`}`}
                    >
                      <Trash2 className="size-[1.05rem]" />
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="rounded-2xl border border-dashed border-[#ccd3cb] bg-[#f8f9f4] px-5 py-10 text-center">
                <ShoppingBasket className="mx-auto size-6 text-[#7a887e]" />
                <p className="mt-3 text-sm font-bold text-[#354239]">Your review list is empty</p>
                <p className="mt-1 text-sm text-[#747c75]">Add an item to continue.</p>
              </div>
            )}

            <button
              type="button"
              onClick={addReviewItem}
              disabled={reviewItems.length >= 24}
              className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-[#bfc9c0] px-4 text-sm font-bold text-[#0d5c3b] hover:border-[#819b87] hover:bg-[#f4f8f1] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]"
            >
              <Plus className="size-4" />
              Add item
            </button>

            {formError ? (
              <p role="alert" className="mt-4 flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm font-medium text-red-800">
                <X className="size-4 shrink-0" />
                {formError}
              </p>
            ) : null}

            <div className="mt-5 rounded-2xl bg-[#f1f4ed] p-4 sm:flex sm:items-center sm:justify-between sm:gap-4">
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white text-[#0d5c3b] ring-1 ring-[#dfe4dc]">
                  <MapPin className="size-4" />
                </span>
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#788178]">Searching</p>
                  <p className="mt-0.5 text-sm font-bold text-[#2b382f]">{store.name}</p>
                  <p className="mt-0.5 text-xs text-[#717b72]">{store.location}</p>
                </div>
              </div>
              <p className="mt-3 text-xs font-semibold text-[#687269] sm:mt-0">
                {reviewItems.length} requested {reviewItems.length === 1 ? "item" : "items"}
              </p>
            </div>

            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <button
                type="button"
                onClick={() => {
                  setFormError("");
                  setView("home");
                }}
                className="min-h-12 rounded-xl px-4 text-sm font-bold text-[#516057] hover:bg-[#f3f5f0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]"
              >
                Back to list entry
              </button>
              <button
                type="button"
                onClick={confirmReview}
                disabled={!reviewItems.length}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#0d5c3b] px-5 text-sm font-bold text-white shadow-[0_10px_24px_rgba(13,92,59,0.18)] hover:bg-[#094d31] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]"
              >
                Confirm and search Walmart
                <ArrowRight className="size-4" />
              </button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (view === "results") {
    return (
      <main className="min-h-screen overflow-x-hidden bg-[#f7f6ef] text-[#17231b]">
        <BrandHeader dataMode={dataMode} />
        <div className="mx-auto w-full max-w-6xl px-5 pb-14 pt-5 sm:px-8 sm:pt-9">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.15em] text-[#587064]">
                <MapPin className="size-3.5" aria-hidden="true" />
                {store.name} · {store.location}
              </p>
              <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-[-0.045em] text-[#142119] sm:text-4xl">
                Your Walmart list results
              </h1>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={editList}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#d8ddd6] bg-white px-4 text-sm font-bold text-[#27342c] hover:border-[#aebcb1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]"
              >
                <PencilLine className="size-4" />
                Edit list
              </button>
              <button
                type="button"
                onClick={() => void runSearch(items.map((item) => ({
                  id: nextReviewId.current++,
                  text: item.requestedItem,
                  quantity: item.quantity,
                  facetOptionIds: item.facetOptionIds,
                })))}
                disabled={searching}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#0d5c3b] px-4 text-sm font-bold text-white shadow-[0_8px_20px_rgba(13,92,59,0.16)] hover:bg-[#094b30] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]"
              >
                <RotateCcw className="size-4" />
                Search again
              </button>
            </div>
          </div>

          <section className="mt-7 grid gap-4 rounded-[1.6rem] border border-black/[0.06] bg-[#0f3324] p-5 text-white shadow-[0_20px_55px_rgba(20,43,29,0.12)] sm:grid-cols-[1.45fr_1fr] sm:p-7">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#afc4b7]">
                {allVerified
                  ? hasLocalizedPrices ? "Localized Walmart basket estimate" : "Verified basket total"
                  : hasLocalizedPrices ? "Localized Walmart subtotal" : "Verified subtotal"}
              </p>
              <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-5xl font-semibold tracking-[-0.055em] sm:text-6xl">
                  {money(total)}
                </span>
                {!allVerified ? (
                  <span className="text-sm font-bold text-[#c9d8cf] sm:text-base">
                    {hasLocalizedPrices ? "localized subtotal" : "verified subtotal"}
                  </span>
                ) : null}
              </p>
              {reviewCount > 0 ? (
                <p className="mt-3 text-sm font-bold text-[#e7efea]">
                  {reviewCount} {reviewCount === 1 ? "item was" : "items were"} not added because Cartiva couldn’t verify {reviewCount === 1 ? "it" : "them"}
                </p>
              ) : null}
              <p className="mt-3 max-w-md text-sm leading-6 text-[#c8d5cd]">
                {hasLocalizedPrices
                  ? "Localized Walmart pickup/search prices are estimates; the exact-store price is confirmed at checkout. Walmart’s checkout price is final."
                  : "Retailer availability, taxes, substitutions, and checkout prices can change. Walmart’s checkout price is final."}
              </p>
              {reviewCount > 0 ? (
                <button
                  type="button"
                  onClick={scrollToFirstReview}
                  className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#d6f23f] px-4 text-sm font-extrabold text-[#1d2b1d] shadow-[0_8px_18px_rgba(0,0,0,0.12)] hover:bg-[#e0fa55] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  <AlertCircle className="size-4" />
                  See {reviewCount} not added
                </button>
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-2 self-stretch">
              <div className="rounded-2xl bg-white/[0.08] p-3.5 ring-1 ring-inset ring-white/10 sm:p-4">
                <p className="text-2xl font-bold">{items.length}</p>
                <p className="mt-1 text-[0.7rem] font-medium text-[#bbcec2] sm:text-xs">Requested</p>
              </div>
              <div className="rounded-2xl bg-white/[0.08] p-4 ring-1 ring-inset ring-white/10">
                <p className="text-2xl font-bold">{matchedCount}</p>
                <p className="mt-1 text-[0.7rem] font-medium text-[#bbcec2] sm:text-xs">Matched</p>
              </div>
              <div className="rounded-2xl bg-white/[0.08] p-4 ring-1 ring-inset ring-white/10">
                <p className="text-2xl font-bold">{reviewCount}</p>
                <p className="mt-1 text-[0.7rem] font-medium text-[#bbcec2] sm:text-xs">Not added</p>
              </div>
              <div className="col-span-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl bg-white/[0.08] px-4 py-3 text-xs text-[#c7d5cc] ring-1 ring-inset ring-white/10">
                <Store className="size-4 text-[#d6f23f]" />
                <span>{store.name} · {store.location}</span>
                <span className="text-[#9fb4a7]">Prices checked at {timeLabel(latestCheck)}</span>
              </div>
            </div>
          </section>

          {searching ? (
            <section className="mt-5 rounded-2xl border border-[#dfe3db] bg-white/70 px-4 py-3" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 font-semibold text-[#26342b]">
                  <LoaderCircle className="size-4 animate-spin text-[#0d5c3b] motion-reduce:animate-none" />
                  {checkedCount < items.length
                    ? `Searching Walmart… ${checkedCount} of ${items.length} items checked`
                    : `Verifying Walmart products… ${completedCount} of ${items.length} complete`}
                </span>
                <span className="text-xs font-bold text-[#647067]">
                  {Math.round(((checkedCount < items.length ? checkedCount : completedCount) / Math.max(items.length, 1)) * 100)}%
                </span>
              </div>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[#e2e6de]">
                <div
                  className="h-full rounded-full bg-[#9cc92d] transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${((checkedCount < items.length ? checkedCount : completedCount) / Math.max(items.length, 1)) * 100}%` }}
                />
              </div>
            </section>
          ) : null}

          {process.env.NODE_ENV === "development" && performanceDiagnostics ? (
            <section className="mt-5 rounded-2xl border border-[#d8dfd7] bg-[#f4f6f1] p-4" aria-label="Development performance diagnostics">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-[#405449]">
                  Development performance
                </p>
                <p className="text-xs font-bold text-[#5e6d64]">
                  Total {(performanceDiagnostics.totalDurationMs / 1000).toFixed(2)}s
                </p>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                {[
                  ["Cache hits", performanceDiagnostics.cacheHits],
                  ["Search calls", performanceDiagnostics.searchApiCalls],
                  ["Product calls", performanceDiagnostics.productApiCalls],
                  ["Deduplicated", performanceDiagnostics.deduplicatedRequests],
                  ["Upstream cache", performanceDiagnostics.upstreamCacheUsed],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl bg-white px-3 py-2.5 ring-1 ring-black/[0.05]">
                    <p className="font-bold text-[#203027]">{value}</p>
                    <p className="mt-0.5 text-[#758078]">{label}</p>
                  </div>
                ))}
              </div>
              <details className="mt-3 text-xs text-[#5e6b63]">
                <summary className="cursor-pointer font-bold text-[#355043] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]">
                  Per-item timings
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {performanceDiagnostics.items.map((timing) => (
                    <li key={`${timing.index}-${timing.item}`} className="flex flex-wrap justify-between gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-black/[0.04]">
                      <span className="font-semibold text-[#29382f]">{timing.item}</span>
                      <span>search {timing.searchDurationMs}ms · verify {timing.verificationDurationMs}ms · total {timing.totalDurationMs}ms</span>
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          ) : null}

          {process.env.NODE_ENV === "development" && cokeCandidateDiagnostics.length ? (
            <section className="mt-5 rounded-2xl border border-[#d8dfd7] bg-[#f4f6f1] p-4" aria-label="Development Coke Zero candidate diagnostics">
              <details>
                <summary className="cursor-pointer text-xs font-extrabold uppercase tracking-[0.12em] text-[#405449] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]">
                  Coke Zero candidate audit ({cokeCandidateDiagnostics.length})
                </summary>
                <p className="mt-2 text-xs leading-5 text-[#647067]">
                  Sanitized live fields only. No API key or authenticated request URL is shown.
                </p>
                <ol className="mt-3 space-y-2">
                  {cokeCandidateDiagnostics.map(({ requestedItem, candidate }, index) => (
                    <li key={`${candidate.productId ?? candidate.itemId ?? index}-${index}`} className="rounded-xl bg-white p-3 text-xs ring-1 ring-black/[0.05]">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-bold leading-5 text-[#203027]">{candidate.title}</p>
                          <p className="mt-0.5 break-words text-[#6c776e]">
                            Request: {requestedItem} · Brand: {candidate.brand ?? "not returned"} · Product ID: {candidate.productId ?? "not returned"} · Item ID: {candidate.itemId ?? "not returned"}
                          </p>
                        </div>
                        <span className={`rounded-full px-2 py-1 font-bold ${candidate.rejectionReason ? "bg-amber-50 text-amber-800" : "bg-[#edf7ef] text-[#17603d]"}`}>
                          {candidate.rejectionReason ? "Rejected" : "Eligible"}
                        </span>
                      </div>
                      <dl className="mt-2 grid gap-x-4 gap-y-1 text-[#5f6d64] sm:grid-cols-2 lg:grid-cols-4">
                        <div><dt className="inline font-bold">Seller: </dt><dd className="inline">{candidate.seller ?? "not returned"} ({candidate.sellerType})</dd></div>
                        <div><dt className="inline font-bold">Current: </dt><dd className="inline">{candidate.currentPrice === undefined ? "not returned" : money(candidate.currentPrice)}</dd></div>
                        <div><dt className="inline font-bold">Regular: </dt><dd className="inline">{candidate.regularPrice === undefined ? "not returned" : money(candidate.regularPrice)}</dd></div>
                        <div><dt className="inline font-bold">Sale: </dt><dd className="inline">{candidate.salePrice === undefined ? "not returned" : money(candidate.salePrice)}</dd></div>
                        <div><dt className="inline font-bold">Unit: </dt><dd className="inline">{candidate.unitPrice === undefined ? "not returned" : `${money(candidate.unitPrice)}/${candidate.unitPriceBasis ?? "unit"}`}</dd></div>
                        <div><dt className="inline font-bold">Fulfillment: </dt><dd className="inline">{candidate.fulfillment.length ? candidate.fulfillment.join(", ") : "not returned by search"}</dd></div>
                        <div><dt className="inline font-bold">Store ID: </dt><dd className="inline">{candidate.storeId ?? "not returned"}</dd></div>
                        <div><dt className="inline font-bold">Price source: </dt><dd className="inline">{candidate.priceSource ?? "unknown"}</dd></div>
                      </dl>
                      <p className={`mt-2 font-semibold leading-5 ${candidate.rejectionReason ? "text-amber-800" : "text-[#17603d]"}`}>
                        {candidate.rejectionReason ?? "Eligible store-specific Walmart candidate."}
                      </p>
                    </li>
                  ))}
                </ol>
              </details>
            </section>
          ) : null}

          <section className="mt-5 space-y-3" aria-label="Basket items">
            {items.map((item, index) => (
              <ProductRow
                key={`${item.requestedItem}-${index}`}
                requestedItem={item.requestedItem}
                quantity={item.quantity}
                itemId={`basket-item-${index}`}
                status={item.status}
                result={item.result}
                storeName={store.name}
                storeLocation={store.location}
                selectedFacetLabels={appliedFacetLabels(item.requestedItem, item.facetOptionIds)}
                onSelect={(product) => selectAlternative(index, product)}
                onSearchAgain={() => void runSearch(items.map((current) => ({
                  id: nextReviewId.current++,
                  text: current.requestedItem,
                  quantity: current.quantity,
                  facetOptionIds: current.facetOptionIds,
                })))}
              />
            ))}
          </section>

          <section className="mt-6 rounded-[1.35rem] border border-dashed border-[#cbd2ca] bg-[#f1f2ea] p-5 sm:flex sm:items-center sm:justify-between sm:gap-6">
            <div>
              <p className="flex items-center gap-2 text-sm font-bold text-[#2a372f]">
                <Info className="size-4 text-[#0d5c3b]" />
                Full-cart transfer is not available yet
              </p>
              <p className="mt-1.5 max-w-2xl text-sm leading-6 text-[#697169]">
                For now, open each matched product at Walmart. Full-cart transfer requires an approved retailer integration.
              </p>
            </div>
            <button
              type="button"
              disabled
              className="mt-4 min-h-11 w-full cursor-not-allowed rounded-xl bg-[#dfe2da] px-4 text-sm font-bold text-[#7b817c] sm:mt-0 sm:w-auto"
            >
              Send full basket to checkout — coming after retailer integration
            </button>
          </section>
          <p className="mx-auto mt-6 max-w-3xl text-center text-xs leading-5 text-[#747d75]">
            Cartiva is independent and is not affiliated with or endorsed by Walmart. Prices are estimates until Walmart checkout.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f7f6ef] text-[#17231b]">
      <BrandHeader dataMode={dataMode} />
      <div className="mx-auto grid w-full max-w-6xl items-start gap-10 px-5 pb-12 pt-8 sm:px-8 sm:pt-14 lg:grid-cols-[0.78fr_1.22fr] lg:gap-14 lg:pt-20">
        <section className="lg:sticky lg:top-16">
          <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-[#557061]">
            <span className="size-2 rounded-full bg-[#a8d231]" />
            Walmart grocery matching, simplified
          </p>
          <h1 className="mt-5 text-[2.85rem] font-semibold leading-[0.96] tracking-[-0.06em] text-[#142119] sm:text-6xl lg:text-[4.35rem]">
            What do you need?
          </h1>
          <p className="mt-5 text-sm font-extrabold tracking-[-0.01em] text-[#0d5c3b]">
            {siteConfig.tagline}
          </p>
          <p className="mt-2 max-w-lg text-[1.05rem] leading-7 text-[#5e685f]">
            Add your list. We’ll find one sensible, low-price Walmart match for each item and total it up.
          </p>
          <div className="mt-7 hidden space-y-3 lg:block">
            {[
              "No account or signup",
              "One selected Walmart store",
              "Transparent product matching",
            ].map((benefit) => (
              <p key={benefit} className="flex items-center gap-2.5 text-sm font-semibold text-[#435048]">
                <span className="grid size-5 place-items-center rounded-full bg-[#e2edca] text-[#27603f]">
                  <Check className="size-3.5" strokeWidth={2.7} />
                </span>
                {benefit}
              </p>
            ))}
          </div>
        </section>

        <section className="rounded-[1.75rem] border border-black/[0.06] bg-[#fffefa] p-4 shadow-[0_26px_70px_rgba(33,53,39,0.10)] sm:p-6 lg:p-7">
          <form onSubmit={submitList}>
            <label htmlFor="shopping-list" className="text-sm font-bold text-[#26342b]">
              Your grocery list
            </label>
            <div className="relative mt-2.5">
              <textarea
                id="shopping-list"
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  setCursorPosition(event.target.selectionStart);
                  setFormError("");
                }}
                onSelect={(event) => setCursorPosition(event.currentTarget.selectionStart)}
                placeholder={"eggs\nplain Greek yogurt 32 oz\nbroccoli 1 lb"}
                rows={8}
                className="w-full resize-none rounded-[1.35rem] border border-[#d8ddd6] bg-white px-4 py-4 pr-14 text-base leading-7 text-[#17231b] shadow-inner shadow-black/[0.015] placeholder:text-[#a3aaa4] hover:border-[#bdc8bf] focus:border-[#1b7049] focus:outline-none focus:ring-4 focus:ring-[#1b7049]/10"
                aria-describedby={formError ? "list-error" : "list-help"}
              />
              <button
                type="button"
                onClick={startListening}
                disabled={!speechSupported || listening}
                className={`absolute right-3 top-3 grid size-10 place-items-center rounded-xl border transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f] motion-reduce:transition-none ${
                  listening
                    ? "border-[#a9ce40] bg-[#dcf45c] text-[#1d391f]"
                    : "border-[#dce1db] bg-[#f8f9f5] text-[#48554c] hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                }`}
                aria-label={listening ? "Listening for grocery items" : "Add grocery items by voice"}
                title={speechSupported ? "Add items by voice" : "Voice input is not supported in this browser"}
              >
                {listening ? <LoaderCircle className="size-[1.15rem] animate-spin motion-reduce:animate-none" /> : <Mic className="size-[1.15rem]" />}
              </button>
            </div>
            <ProductFacetChips
              query={activeFacetQuery}
              selectedOptionIds={activeFacetOptionIds}
              onChange={(optionIds) => setFacetSelectionsByIndex((current) => ({
                ...current,
                [activeFacetIndex]: optionIds,
              }))}
            />
            <div className="mt-2 flex min-h-6 flex-wrap items-center justify-between gap-2">
              <p id="list-help" className="text-xs leading-5 text-[#788078]">
                Use commas, new lines, or a simple sentence. Keep brands and sizes if they matter.
              </p>
              <button
                type="button"
                onClick={() => {
                  setInput(siteConfig.sampleList);
                  setCursorPosition(siteConfig.sampleList.length);
                  setFacetSelectionsByIndex({});
                  setFormError("");
                }}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-bold text-[#0d5c3b] hover:bg-[#eef5ea] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]"
              >
                <Sparkles className="size-3.5" />
                Try a sample list
              </button>
            </div>

            {formError ? (
              <p id="list-error" role="alert" className="mt-3 flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm font-medium text-red-800">
                <X className="size-4 shrink-0" />
                {formError}
              </p>
            ) : null}

            <div className="mt-5 rounded-2xl border border-[#e2e5df] bg-[#f7f8f3] p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white text-[#0d5c3b] ring-1 ring-[#dfe4dc]">
                    <MapPin className="size-[1.05rem]" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-[#26342b]">{store.name}</p>
                    <p className="mt-0.5 text-xs text-[#747c75]">
                      {store.location} · {store.id ? `Store ID ${store.id}` : "Store ID not set"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setStoreOpen((open) => !open)}
                  className="min-h-9 rounded-lg px-2.5 text-xs font-bold text-[#0d5c3b] hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]"
                  aria-expanded={storeOpen}
                >
                  {storeOpen ? "Close" : "Change"}
                </button>
              </div>

              {storeOpen ? (
                <div className="mt-3 grid gap-3 border-t border-[#e0e4dd] pt-3 sm:grid-cols-2">
                  <label className="text-xs font-bold text-[#5e685f]">
                    Store display name
                    <input
                      value={storeDraft.name}
                      onChange={(event) => setStoreDraft((current) => ({ ...current, name: event.target.value }))}
                      className="mt-1.5 h-10 w-full rounded-xl border border-[#d7ddd5] bg-white px-3 text-sm font-medium text-[#253229] focus:border-[#1b7049] focus:outline-none focus:ring-3 focus:ring-[#1b7049]/10"
                    />
                  </label>
                  <label className="text-xs font-bold text-[#5e685f]">
                    Walmart store ID
                    <input
                      value={storeDraft.id}
                      onChange={(event) => setStoreDraft((current) => ({ ...current, id: event.target.value.replace(/[^0-9]/g, "") }))}
                      inputMode="numeric"
                      placeholder="e.g. 512"
                      className="mt-1.5 h-10 w-full rounded-xl border border-[#d7ddd5] bg-white px-3 text-sm font-medium text-[#253229] focus:border-[#1b7049] focus:outline-none focus:ring-3 focus:ring-[#1b7049]/10"
                    />
                  </label>
                  <label className="text-xs font-bold text-[#5e685f] sm:col-span-2">
                    Store location
                    <input
                      value={storeDraft.location}
                      onChange={(event) => setStoreDraft((current) => ({ ...current, location: event.target.value }))}
                      placeholder="City, state"
                      className="mt-1.5 h-10 w-full rounded-xl border border-[#d7ddd5] bg-white px-3 text-sm font-medium text-[#253229] focus:border-[#1b7049] focus:outline-none focus:ring-3 focus:ring-[#1b7049]/10"
                    />
                  </label>
                  <div className="sm:col-span-2 flex items-center justify-between gap-3">
                    <p className="text-[0.7rem] leading-4 text-[#7b837c]">Testing override for this browser session only.</p>
                    <button
                      type="button"
                      onClick={() => {
                        setStore({
                          id: storeDraft.id.trim(),
                          name: storeDraft.name.trim() || "Selected Walmart",
                          location: storeDraft.location.trim() || "Location not set",
                        });
                        setStoreOpen(false);
                      }}
                      className="min-h-9 rounded-lg bg-[#e6eddd] px-3 text-xs font-bold text-[#1f5438] hover:bg-[#dce7d2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]"
                    >
                      Use this store
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <button
              type="submit"
              className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#0d5c3b] px-5 text-base font-bold text-white shadow-[0_12px_28px_rgba(13,92,59,0.20)] transition hover:-translate-y-0.5 hover:bg-[#094d31] hover:shadow-[0_16px_32px_rgba(13,92,59,0.24)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f] active:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none"
            >
              <Search className="size-[1.1rem]" />
              Find my Walmart basket
              <ArrowRight className="size-[1.1rem]" />
            </button>
          </form>
        </section>
      </div>

      <footer className="mx-auto flex w-full max-w-6xl flex-col gap-3 border-t border-[#dddfd8] px-5 py-6 text-xs text-[#707970] sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-4 text-[#0d5c3b]" />
          No signup, payment, or purchase is made here.
        </p>
        <p className="max-w-lg sm:text-right">
          Cartiva is independent and is not affiliated with or endorsed by Walmart. Walmart checkout pricing is final.
        </p>
      </footer>
    </main>
  );
}
