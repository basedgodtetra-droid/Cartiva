import { rankProducts } from "./matching";
import {
  packageFulfillmentForProduct,
  rankFulfillmentCandidates,
  retailerContainerCompatible,
} from "./package-fulfillment";
import {
  isPackageConstraint,
  parseProductIntent,
  type ProductIntent,
} from "./product-search-intent";
import { inferProductCategory } from "./product-knowledge";
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
    cartEligible: product.cartEligible && product.availabilityStatus !== "unknown",
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
  return product.availabilityStatus !== "out_of_stock"
    && Number.isFinite(product.price)
    && product.price > 0
    && product.priceProvenance.exactStoreVerified
    && product.priceProvenance.priceReliability === "verified";
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

function rankEligibleKrogerProducts(
  request: string,
  eligible: KrogerProduct[],
  constraints: ProductConstraint[],
  preferredIdentity?: { productId?: string; title?: string },
): KrogerMatchResult {
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
    resolution: recommended
      ? "matched"
      : ranked.clarification ? "needs_choice" : "truly_unavailable",
    clarification: ranked.clarification,
    explanation: recommended
      ? "Verified against the official Kroger catalog at the selected location."
      : ranked.clarification
        ?? (rejectedForLowConfidence
          ? "Kroger found a possible product, but Cartiva could not verify it strongly enough against your request."
          : "No Kroger match met the product and package requirements."),
    verifiedAt: recommended?.checkedAt,
  };
}

function validCartQuantity(value: number | undefined) {
  return Number.isInteger(value) && (value ?? 0) >= 1 && (value ?? 0) <= 99
    ? value as number
    : undefined;
}

function resolutionFor(
  product: RankedKrogerProduct,
  fulfillment: NonNullable<KrogerMatchResult["fulfillment"]>,
): NonNullable<KrogerMatchResult["resolution"]> {
  if (product.availabilityStatus !== "in_stock") return "matched_check_availability";
  if (fulfillment.kind === "multi_package") return "multi_package_fulfillment";
  return "matched";
}

function explanationFor(
  product: RankedKrogerProduct,
  fulfillment: NonNullable<KrogerMatchResult["fulfillment"]>,
) {
  if (product.availabilityStatus === "unknown") {
    return "Product identity and exact-store price are verified. Kroger did not confirm current availability, so check availability before checkout.";
  }
  if (product.availabilityStatus === "likely_available") {
    return "Product identity and exact-store price are verified. Kroger lists it for this fulfillment method; confirm final availability at checkout.";
  }
  if (fulfillment.kind === "multi_package") {
    return `${fulfillment.label} fulfills the requested total without undersupplying it.`;
  }
  if (fulfillment.kind === "variable_weight") {
    return `${fulfillment.label} is a reasonable variable-weight fulfillment for the requested amount.`;
  }
  return "Verified against the official Kroger catalog at the selected location.";
}

function identityVerificationText(intent: ProductIntent) {
  const container = intent.requestedContainer;
  const containerCarriesProduceForm = container === "can"
    && inferProductCategory(intent.verificationText) === "produce";
  if (
    !container
    || container === "each"
    || (container === "can" && !containerCarriesProduceForm)
    || !/^(?:can|bottle|jar|bag|box|carton|roll|bunch|loaf)$/.test(container)
    || new RegExp(`\\b${container}\\b`, "i").test(intent.verificationText)
  ) return intent.verificationText;
  return `${intent.verificationText} ${container}`;
}

export interface KrogerRankingOptions {
  cartQuantity?: number;
  intent?: ProductIntent;
}

export function rankKrogerProducts(
  request: string,
  products: KrogerProduct[],
  constraints: ProductConstraint[] = [],
  preferredIdentity?: { productId?: string; title?: string },
  options: KrogerRankingOptions = {},
): KrogerMatchResult {
  const intent = options.intent ?? parseProductIntent(request);
  const cartQuantity = validCartQuantity(options.cartQuantity)
    ?? intent.requestedCartQuantity;
  // Product matching and cart mutation remain separate decisions. A verified
  // identity and price may remain useful when Kroger omits inventory details;
  // cartEligible continues to enforce the stricter handoff boundary.
  const eligible = products.filter((product) => (
    hasMatchEligibleStoreEvidence(product)
    && retailerContainerCompatible(intent, product)
  ));
  const sourceConstraints = constraints.length ? constraints : intent.constraints;
  const effectiveConstraints = intent.strictPackageRequest
    ? sourceConstraints
    : sourceConstraints.filter((constraint) => !isPackageConstraint(constraint));
  const exact = rankEligibleKrogerProducts(
    identityVerificationText(intent),
    eligible,
    effectiveConstraints,
    preferredIdentity,
  );

  if (exact.recommended) {
    const fulfillment = packageFulfillmentForProduct(
      intent,
      exact.recommended,
      cartQuantity,
    );
    if (fulfillment) {
      const recommended = {
        ...exact.recommended,
        comparablePrice: Number((exact.recommended.price * fulfillment.cartQuantity).toFixed(2)),
      };
      return {
        ...exact,
        requestedItem: request,
        recommended,
        fulfillment,
        resolution: resolutionFor(recommended, fulfillment),
        explanation: explanationFor(recommended, fulfillment),
      };
    }
  }

  if (intent.requestedTotal) {
    const identityConstraints = effectiveConstraints.filter((constraint) => (
      !isPackageConstraint(constraint)
    ));
    const fulfillmentCandidates = eligible.flatMap((product) => {
      const identity = rankEligibleKrogerProducts(
        identityVerificationText({ ...intent, verificationText: intent.fulfillmentText }),
        [product],
        identityConstraints,
        preferredIdentity,
      );
      if (!identity.recommended) return [];
      const fulfillment = packageFulfillmentForProduct(
        intent,
        identity.recommended,
        cartQuantity,
        true,
      );
      return fulfillment ? [{
        product: {
          ...identity.recommended,
          comparablePrice: Number((identity.recommended.price * fulfillment.cartQuantity).toFixed(2)),
        },
        confidence: identity.recommended.confidence,
        score: identity.recommended.score,
        fulfillment,
      }] : [];
    });
    const rankedFulfillments = rankFulfillmentCandidates(fulfillmentCandidates);
    const selected = rankedFulfillments[0];
    if (selected) {
      return {
        retailer: "kroger",
        requestedItem: request,
        recommended: selected.product,
        alternatives: rankedFulfillments
          .slice(1, 4)
          .map((candidate) => candidate.product),
        assumptions: [],
        confidence: selected.confidence,
        status: "matched",
        resolution: resolutionFor(selected.product, selected.fulfillment),
        fulfillment: selected.fulfillment,
        explanation: explanationFor(selected.product, selected.fulfillment),
        verifiedAt: selected.product.checkedAt,
      };
    }
  }

  return {
    ...exact,
    requestedItem: request,
    resolution: exact.status === "review" ? "needs_choice" : "truly_unavailable",
  };
}
