import { rankProducts } from "./matching";
import type { ProductConstraint } from "./product-facets";
import type {
  KrogerMatchResult,
  KrogerProduct,
  RankedKrogerProduct,
  RankedProduct,
  WalmartProduct,
} from "./types";

function rankingProjection(product: KrogerProduct): WalmartProduct {
  return {
    id: product.id,
    productId: product.productId,
    itemId: product.itemId,
    upc: product.upc,
    title: product.title,
    price: product.price,
    priceCents: product.priceCents,
    link: product.link,
    linkType: product.linkType,
    sourceUrl: product.sourceUrl,
    thumbnail: product.thumbnail,
    // rankProducts contains Walmart marketplace heuristics. Kroger candidates
    // are already proven official and exact-store scoped before projection,
    // so do not mislabel a Kroger-family banner as a marketplace seller.
    seller: undefined,
    brand: product.brand,
    productType: product.productType,
    inStock: product.inStock,
    availabilityStatus: product.availabilityStatus,
    sponsored: false,
    size: product.size,
    checkedAt: product.checkedAt,
  };
}

function restoreRankedProduct(
  ranked: RankedProduct,
  originals: Map<string, KrogerProduct>,
): RankedKrogerProduct | null {
  const product = originals.get(ranked.id);
  if (!product) return null;
  return {
    ...product,
    score: ranked.score,
    confidence: ranked.confidence,
    unitPrice: ranked.unitPrice,
    unitLabel: ranked.unitLabel,
    comparablePrice: ranked.comparablePrice,
    matchedTerms: ranked.matchedTerms,
    // The shared legacy ranker describes its preferred-identity bonus as a
    // Walmart suggestion. Kroger uses that same bonus only to preserve an
    // already verified product during same-store revalidation, so never leak
    // another retailer's provenance into Kroger evidence.
    reasons: ranked.reasons.map((reason) => (
      reason === "selected from live Walmart suggestions"
        ? "preserves the previously verified product"
        : reason
    )),
  };
}

function isAcceptedConfidence(product: RankedProduct | RankedKrogerProduct) {
  return product.confidence === "medium" || product.confidence === "high";
}

function hasMatchEligibleStoreEvidence(product: KrogerProduct) {
  return (product.availabilityStatus === "in_stock"
      || product.availabilityStatus === "likely_available")
    && Number.isFinite(product.price)
    && product.price > 0
    && product.priceProvenance.exactStoreVerified
    && product.priceProvenance.priceReliability === "verified"
    && product.priceProvenance.fulfillment.length > 0;
}

function normalizedIdentity(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * A shopper selection may reorder already-credible candidates, but it must
 * never manufacture semantic confidence. In particular, rankProducts' large
 * preferred-identity bonus is not an acceptance signal on its own.
 */
function safePreferredIdentity(
  preferredIdentity: { productId?: string; title?: string } | undefined,
  credibleCandidates: RankedProduct[],
) {
  if (!preferredIdentity) return undefined;
  const productId = preferredIdentity.productId
    && credibleCandidates.some((candidate) => candidate.productId === preferredIdentity.productId)
    ? preferredIdentity.productId
    : undefined;
  const title = preferredIdentity.title
    && credibleCandidates.some((candidate) => (
      normalizedIdentity(candidate.title) === normalizedIdentity(preferredIdentity.title!)
    ))
    ? preferredIdentity.title
    : undefined;
  return productId || title ? { productId, title } : undefined;
}

export function rankKrogerProducts(
  request: string,
  products: KrogerProduct[],
  constraints: ProductConstraint[] = [],
  preferredIdentity?: { productId?: string; title?: string },
): KrogerMatchResult {
  // Product matching and cart mutation remain separate decisions. Kroger may
  // provide an exact-store price and selected-fulfillment listing while
  // omitting an inventory level. That is truthfully labeled likely available;
  // the Cart API still accepts its verified UPC, quantity, and modality.
  const eligible = products.filter(hasMatchEligibleStoreEvidence);
  const originals = new Map(eligible.map((product) => [product.id, product]));
  const projections = eligible.map(rankingProjection);
  const baseline = rankProducts(
    request,
    projections,
    constraints,
  );
  const baselineCandidates = [
    ...(baseline.recommended ? [baseline.recommended] : []),
    ...baseline.alternatives,
  ];
  const credibleBaselineCandidates = baselineCandidates.filter(isAcceptedConfidence);
  const safePreference = safePreferredIdentity(
    preferredIdentity,
    credibleBaselineCandidates,
  );
  const ranked = safePreference
    ? rankProducts(request, projections, constraints, safePreference)
    : baseline;
  const baselineConfidence = new Map(
    baselineCandidates.map((candidate) => [candidate.id, candidate.confidence]),
  );
  const possibleRecommended = ranked.recommended
    ? restoreRankedProduct(ranked.recommended, originals)
    : null;
  if (possibleRecommended) {
    possibleRecommended.confidence = baselineConfidence.get(possibleRecommended.id) ?? "low";
  }
  const recommended = possibleRecommended && isAcceptedConfidence(possibleRecommended)
    ? possibleRecommended
    : null;
  const alternatives = ranked.alternatives
    .map((product) => restoreRankedProduct(product, originals))
    .filter((product): product is RankedKrogerProduct => Boolean(product));
  for (const alternative of alternatives) {
    alternative.confidence = baselineConfidence.get(alternative.id) ?? "low";
  }
  const credibleAlternatives = alternatives.filter(isAcceptedConfidence);
  const rejectedForLowConfidence = Boolean(possibleRecommended && !recommended);

  return {
    retailer: "kroger",
    requestedItem: request,
    recommended,
    alternatives: credibleAlternatives,
    assumptions: ranked.assumptions,
    confidence: recommended ? recommended.confidence : "low",
    status: recommended
      ? "matched"
      : ranked.clarification ? ranked.status : "no_match",
    clarification: ranked.clarification,
    explanation: recommended
      ? "Verified against the official Kroger catalog at the selected location."
      : ranked.clarification
        ?? (rejectedForLowConfidence
          ? "Kroger found a possible product, but Cartiva could not verify it strongly enough against your request."
          : "No in-stock Kroger match met the product and package requirements."),
    verifiedAt: recommended?.checkedAt,
  };
}
