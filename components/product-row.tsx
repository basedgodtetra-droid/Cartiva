"use client";

import {
  AlertCircle,
  Check,
  ChevronDown,
  ExternalLink,
  Image as ImageIcon,
  LoaderCircle,
} from "lucide-react";
import { useState } from "react";
import type { MatchResult, RankedProduct } from "@/lib/types";
import { createWalmartSearchUrl } from "@/lib/walmart-url";

export type ItemStatus = "pending" | "verifying" | "matched" | "review" | "no-match" | "error";

interface ProductRowProps {
  result?: MatchResult;
  requestedItem: string;
  quantity: number;
  itemId: string;
  status: ItemStatus;
  storeName: string;
  storeLocation: string;
  selectedFacetLabels?: string[];
  onSelect: (product: RankedProduct) => void;
  onSearchAgain: () => void;
}

function formatPrice(price: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(price);
}

function formatCheckedAt(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function RowSkeleton({ requestedItem }: { requestedItem: string }) {
  return (
    <article className="rounded-[1.35rem] border border-black/[0.06] bg-white/70 p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[#253229]">{requestedItem}</p>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#eef4f1] px-2.5 py-1 text-[0.68rem] font-bold text-[#33584a]">
          <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
          Searching
        </span>
      </div>
      <div className="animate-pulse space-y-3 motion-reduce:animate-none">
        <div className="h-4 w-3/4 rounded-full bg-[#e8e9e1]" />
        <div className="h-3 w-1/3 rounded-full bg-[#edeee8]" />
        <div className="flex items-center justify-between pt-2">
          <div className="h-7 w-20 rounded-full bg-[#e8e9e1]" />
          <div className="h-9 w-28 rounded-xl bg-[#edeee8]" />
        </div>
      </div>
    </article>
  );
}

export function ProductRow({
  result,
  requestedItem,
  quantity,
  itemId,
  status,
  storeName,
  storeLocation,
  selectedFacetLabels = [],
  onSelect,
  onSearchAgain,
}: ProductRowProps) {
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);

  if (status === "pending") {
    return <div id={itemId}><RowSkeleton requestedItem={requestedItem} /></div>;
  }

  const product = result?.recommended;
  if (!product) {
    return (
      <article
        id={itemId}
        tabIndex={-1}
        className="rounded-[1.35rem] border border-amber-200/80 bg-[#fffaf0] p-4 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 sm:p-5"
      >
        <div className="flex gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-amber-700" aria-hidden="true" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-[#1c2820]">{requestedItem}</p>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.66rem] font-bold uppercase tracking-[0.08em] text-amber-900">
                {status === "no-match" ? "No result" : status === "error" ? "API error" : "Couldn’t verify"}
              </span>
            </div>
            <p className="mt-1 text-sm leading-6 text-[#6a6657]">
              {result?.clarification ?? result?.error ?? result?.explanation ?? "No reasonable match was found."}
            </p>
            <button
              type="button"
              onClick={onSearchAgain}
              className="mt-3 min-h-10 rounded-xl border border-amber-300 bg-white px-3 text-xs font-bold text-amber-900 hover:border-amber-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
            >
              Search Walmart again
            </button>
          </div>
        </div>
      </article>
    );
  }

  const needsReview = status === "review";
  const verifying = status === "verifying";
  const priceNeedsConfirmation = needsReview && Boolean(
    product.verificationIssues?.some((issue) =>
      /(?:local|localized) Walmart .*price needs confirmation/i.test(issue),
    ),
  );
  const bestReasonableMatch = status === "matched" && Boolean(result?.assumptions?.length);
  const productPriceCents = product.priceCents ?? Math.round(product.price * 100);
  const lineTotal = (productPriceCents * quantity) / 100;
  const priceProvenance = product.priceProvenance;
  const regularPrice = priceProvenance?.regularPriceCents === undefined
    ? undefined
    : priceProvenance.regularPriceCents / 100;
  const productDetailPrice = priceProvenance?.productDetailPriceCents === undefined
    ? undefined
    : priceProvenance.productDetailPriceCents / 100;
  const detailPriceDiffers = productDetailPrice !== undefined
    && Math.abs(productDetailPrice - product.price) >= 0.01;
  const usesLocalizedPrice = priceProvenance?.priceScope === "localized";
  const localPriceLabel = usesLocalizedPrice
    ? priceProvenance?.priceSource === "local_store_sale"
      ? "localized Walmart sale price"
      : "localized Walmart pickup/search price"
    : priceProvenance?.priceSource === "local_store_sale"
      ? "local Walmart sale price"
      : priceProvenance?.localPriceVerified
        ? "local Walmart pickup price"
        : priceProvenance?.sellerType === "marketplace"
          ? "marketplace price"
          : product.dataSource === "mock"
            ? "demo sample price"
            : "Walmart search price";
  const canOpenProductPage = status === "matched" && product.linkType === "product";
  const walmartHref = canOpenProductPage
    ? product.link
    : createWalmartSearchUrl(product.title);

  return (
    <article
      id={itemId}
      tabIndex={-1}
      className="rounded-[1.35rem] border border-black/[0.07] bg-white p-4 shadow-[0_10px_30px_rgba(24,47,33,0.045)] outline-none focus-visible:ring-2 focus-visible:ring-[#a8d231] sm:p-5"
    >
      <div className="flex items-start justify-between gap-4 border-b border-[#ebece6] pb-3">
        <div className="min-w-0">
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.15em] text-[#7b827b]">
            You asked for
          </p>
          <h3 className="mt-1 text-[0.95rem] font-semibold leading-5 text-[#17231b]">
            {requestedItem}
          </h3>
          {selectedFacetLabels.length ? (
            <p className="mt-1 text-[0.7rem] font-semibold leading-4 text-[#557061]">
              Smart options: {selectedFacetLabels.join(" · ")}
            </p>
          ) : null}
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-bold ${
            needsReview
              ? "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200"
              : verifying
                ? "bg-[#eef4f1] text-[#33584a] ring-1 ring-inset ring-[#d5e2db]"
              : "bg-[#edf7ef] text-[#17603d] ring-1 ring-inset ring-[#cce5d3]"
          }`}
        >
          {needsReview ? <AlertCircle className="size-3.5" /> : verifying ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Check className="size-3.5" />}
          {priceNeedsConfirmation ? "Price needs confirmation" : needsReview ? "Couldn’t verify" : verifying ? "Verifying" : bestReasonableMatch ? "Best reasonable match" : "Matched"}
        </span>
      </div>

      {result?.assumptions?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Matching assumptions">
          {result.assumptions.map((assumption) => (
            <span
              key={assumption}
              className="rounded-full bg-[#eff5dc] px-2.5 py-1 text-[0.68rem] font-bold text-[#3d5a31] ring-1 ring-inset ring-[#dce8b9]"
            >
              {assumption}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex gap-4">
        {showPhoto && product.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.thumbnail}
            alt=""
            loading="lazy"
            className="size-16 shrink-0 rounded-xl border border-[#eaebe6] object-contain"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-semibold leading-6 text-[#17231b]">{product.title}</p>
              <p className="mt-1 text-xs text-[#6e776f]">
                {[product.size?.label, product.seller].filter(Boolean).join(" · ")}
              </p>
              {product.dataSource === "mock" ? (
                <p className="mt-1 text-[0.7rem] font-bold uppercase tracking-[0.08em] text-[#66745f]">
                  Demo sample product
                </p>
              ) : null}
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xl font-bold tracking-[-0.035em] text-[#17231b]">
                {formatPrice(lineTotal)}
              </p>
              <p className="mt-0.5 max-w-44 text-xs font-semibold leading-4 text-[#4f6859]">
                {quantity > 1 ? `${quantity} × ${formatPrice(product.price)} · ` : ""}{localPriceLabel}
              </p>
              {product.unitLabel ? (
                <p className="mt-0.5 text-xs font-medium text-[#667068]">
                  {product.unitLabel}
                </p>
              ) : null}
              {regularPrice !== undefined && regularPrice > product.price ? (
                <p className="mt-0.5 text-[0.68rem] text-[#788078]">Regular {formatPrice(regularPrice)}</p>
              ) : null}
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-[#6a726b]">
            {status === "matched" ? (
              <span className="font-bold text-[#405248]">Why this matched: </span>
            ) : null}
            {result?.explanation}
          </p>
          {status === "matched" && result?.verifiedAt ? (
            <div className="mt-1.5 text-[0.7rem] font-semibold leading-5 text-[#68766d]">
              <p>
                {usesLocalizedPrice ? "Price localized for" : "Price checked at"} {storeName} · {storeLocation}
              </p>
              <p>
                {usesLocalizedPrice
                  ? `Localized Walmart pickup/search price checked at ${formatCheckedAt(priceProvenance?.checkedAt ?? result.verifiedAt)}. Exact-store price is not confirmed; product details verified separately.`
                  : `Local Walmart price checked at ${formatCheckedAt(priceProvenance?.checkedAt ?? result.verifiedAt)}. Product details verified separately.`}
              </p>
              {detailPriceDiffers ? (
                <p className="text-[#7a6840]">
                  Product-detail price was {formatPrice(productDetailPrice!)}; the {usesLocalizedPrice ? "localized" : "store-specific"} search price is used for this basket.
                </p>
              ) : null}
            </div>
          ) : null}
          {verifying ? (
            <p className="mt-1.5 text-[0.7rem] font-semibold text-[#537064]">
              Verifying current price, package, and Walmart product page…
            </p>
          ) : !canOpenProductPage ? (
            <p className="mt-1.5 text-[0.7rem] font-semibold text-amber-800">
              Product page unavailable — Walmart search will be used.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setAlternativesOpen((open) => !open)}
          disabled={verifying}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-[#dfe3dc] bg-[#fbfcf8] px-3 text-xs font-bold text-[#26342b] transition hover:border-[#b8c5bb] hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f] motion-reduce:transition-none"
          aria-expanded={alternativesOpen}
        >
          Change item
          <ChevronDown
            className={`size-4 transition-transform motion-reduce:transition-none ${alternativesOpen ? "rotate-180" : ""}`}
          />
        </button>
        <a
          href={walmartHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-[#0e5b39] hover:bg-[#f0f7ef] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]"
        >
          {canOpenProductPage ? "Open at Walmart" : "Search at Walmart"}
          <ExternalLink className="size-3.5" />
        </a>
        {product.thumbnail ? (
          <button
            type="button"
            onClick={() => setShowPhoto((show) => !show)}
            className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold text-[#707870] hover:bg-[#f5f6f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f]"
          >
            <ImageIcon className="size-3.5" />
            {showPhoto ? "Hide photo" : "Show photo"}
          </button>
        ) : null}
      </div>

      {alternativesOpen ? (
        <div className="mt-3 rounded-2xl bg-[#f7f8f3] p-2.5">
          {result?.alternatives.length ? (
            <div className="space-y-1.5">
              <p className="px-2 py-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[#737c74]">
                Other reasonable matches
              </p>
              {result.alternatives.map((alternative) => (
                <button
                  key={alternative.id}
                  type="button"
                  onClick={() => {
                    onSelect(alternative);
                    setAlternativesOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-4 rounded-xl bg-white px-3 py-3 text-left ring-1 ring-black/[0.05] transition hover:ring-[#a8b8ab] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f] motion-reduce:transition-none"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold leading-5 text-[#243128]">
                      {alternative.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-[#707870]">
                      {[alternative.size?.label, alternative.unitLabel, "Verification required"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-bold text-[#17231b]">
                    {formatPrice(alternative.price)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="px-2 py-3 text-sm text-[#6d756e]">No other reasonable matches found.</p>
          )}
        </div>
      ) : null}
    </article>
  );
}
