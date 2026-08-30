import { siteConfig } from "@/config/site";
import type { ProductConstraint } from "./product-facets";
import {
  rankTargetProducts,
  targetCandidateReliabilityIssues,
  targetExactStoreIsProven,
  targetPriceLabelForScope,
  targetPriceScopeFromEvidence,
} from "./target-products";
import { isValidTargetProductUrl } from "./target-url";
import type {
  RankedTargetProduct,
  RetailFulfillmentMode,
  RetailLocationEvidence,
  TargetMatchResult,
  TargetPriceProvenance,
  TargetProduct,
} from "./types";

export interface TargetVerificationContext {
  fulfillmentMode: RetailFulfillmentMode;
  requestedStoreId?: string;
  requestedPostalCode?: string;
  constraints?: ProductConstraint[];
}

function freshTimestamp(value: string | undefined, now: Date) {
  if (!value) return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime())
    && timestamp.getTime() <= now.getTime() + 60_000
    && now.getTime() - timestamp.getTime() <= siteConfig.detailCacheTtlMs;
}

function priceDifferenceIsUnreliable(searchCents: number, detailCents: number) {
  const difference = Math.abs(searchCents - detailCents);
  return difference > Math.max(100, Math.round(Math.min(searchCents, detailCents) * 0.2));
}

function withoutRecommendation(
  preliminary: TargetMatchResult,
  issues: string[],
  status: "review" | "no_match",
): TargetMatchResult {
  return {
    ...preliminary,
    recommended: null,
    alternatives: [],
    confidence: "low",
    status,
    verifiedAt: undefined,
    explanation: `Target match excluded: ${[...new Set(issues)].join("; ")}.`,
  };
}

function comparisonEstimateWithoutDetails(
  preliminary: TargetMatchResult,
  candidate: RankedTargetProduct,
  context: TargetVerificationContext,
): TargetMatchResult {
  const location = candidate.priceProvenance.location;
  // A Search result remains useful for comparison, but without a successful
  // product-detail check it must never be presented as exact-store verified.
  const priceScope = location.requestedStoreId || location.requestedPostalCode
    ? "localized" as const
    : "estimated" as const;
  const pickupInventoryUnavailable = context.fulfillmentMode === "pickup";
  const issue = pickupInventoryUnavailable
    ? "selected-store Target inventory was unavailable"
    : "current Target product details were unavailable";
  const estimate: RankedTargetProduct = {
    ...candidate,
    priceProvenance: {
      ...candidate.priceProvenance,
      priceScope,
      priceReliability: "localized_estimate",
      exactStoreVerified: false,
      productDetailPriceCents: undefined,
    },
    priceLabel: targetPriceLabelForScope(priceScope),
    inStock: false,
    availabilityStatus: "unknown",
    cartEligible: false,
    verification: "unverified",
    verificationIssues: [issue],
    confidence: "low",
  };
  const assumption = priceScope === "localized"
    ? "Localized Target comparison estimate; product details, availability, and exact-store price were not confirmed"
    : "General Target comparison estimate; product details and availability were not confirmed";

  return {
    ...preliminary,
    recommended: estimate,
    alternatives: preliminary.alternatives.map((product) => ({
      ...product,
      cartEligible: false,
    })),
    assumptions: [...new Set([...(preliminary.assumptions ?? []), assumption])],
    confidence: "low",
    status: "review",
    verifiedAt: undefined,
    explanation: pickupInventoryUnavailable
      ? "Target found this product, but the selected store's inventory check was unavailable. The displayed price remains a comparison estimate, so this item stays out of the cart."
      : priceScope === "localized"
        ? "Target found this product, but product details were unavailable. The displayed price is an unverified localized comparison estimate; availability and the exact-store price are not confirmed, so this item stays out of the cart."
        : "Target found this product, but product details were unavailable. The displayed price is an unverified comparison estimate; availability is not confirmed, so this item stays out of the cart.",
  };
}

function observedLocationMismatch(
  location: RetailLocationEvidence,
  context: TargetVerificationContext,
) {
  if (
    context.requestedStoreId
    && location.observedStoreId
    && location.observedStoreId !== context.requestedStoreId
  ) return "response store does not match the requested Target store";
  if (
    context.requestedPostalCode
    && location.observedPostalCode
    && location.observedPostalCode !== context.requestedPostalCode
  ) return "response ZIP does not match the requested delivery ZIP";
  return undefined;
}

function mergedLocation(
  search: RetailLocationEvidence,
  detail: RetailLocationEvidence,
  context: TargetVerificationContext,
): RetailLocationEvidence {
  const requestedStoreId = context.requestedStoreId
    ?? search.requestedStoreId
    ?? detail.requestedStoreId;
  const requestedPostalCode = context.requestedPostalCode
    ?? search.requestedPostalCode
    ?? detail.requestedPostalCode;
  // The basket price comes from Search, so only Search response evidence can
  // upgrade its scope. Detail evidence is still checked for contradictions.
  return {
    requestedStoreId,
    observedStoreId: search.observedStoreId,
    requestedPostalCode,
    observedPostalCode: search.observedPostalCode,
    responseProvesLocation: search.responseProvesLocation,
    storeMatched: requestedStoreId && search.observedStoreId
      ? requestedStoreId === search.observedStoreId
      : undefined,
    postalCodeMatched: requestedPostalCode && search.observedPostalCode
      ? requestedPostalCode === search.observedPostalCode
      : undefined,
  };
}

export function verifyTargetSelectedProduct(
  request: string,
  preliminary: TargetMatchResult,
  detail: TargetProduct | null,
  context: TargetVerificationContext,
  now = new Date(),
): TargetMatchResult {
  const candidate = preliminary.recommended;
  if (!candidate) return preliminary;

  const candidateIssues = targetCandidateReliabilityIssues(candidate);
  if (candidateIssues.length) {
    return withoutRecommendation(preliminary, candidateIssues, "no_match");
  }
  if (!detail) {
    return comparisonEstimateWithoutDetails(preliminary, candidate, context);
  }

  const issues = targetCandidateReliabilityIssues(detail);
  if (candidate.retailer !== "target" || detail.retailer !== "target") {
    issues.push("retailer identity changed during verification");
  }
  if (candidate.productId !== detail.productId) {
    issues.push("Target product identity does not match the selected search result");
  }
  if (!isValidTargetProductUrl(detail.link, [candidate.productId, detail.productId])) {
    issues.push("verified Target product page is unavailable or belongs to another item");
  }
  const availabilityConfirmed = detail.availabilityStatus === "in_stock" && detail.inStock;
  if (detail.availabilityStatus === "out_of_stock") {
    issues.push("product is out of stock");
  } else if (context.fulfillmentMode === "pickup" && !availabilityConfirmed) {
    issues.push("selected-store pickup availability was not confirmed");
  }
  if (!freshTimestamp(detail.checkedAt, now)) {
    issues.push("Target product details are missing a fresh check time");
  }
  if (!freshTimestamp(candidate.priceProvenance.checkedAt ?? candidate.checkedAt, now)) {
    issues.push("Target search price is missing a fresh check time");
  }

  const searchPriceCents = candidate.priceCents ?? Math.round(candidate.price * 100);
  const detailPriceCents = detail.priceCents ?? Math.round(detail.price * 100);
  if (
    !Number.isFinite(searchPriceCents)
    || searchPriceCents <= 0
    || !Number.isFinite(detailPriceCents)
    || detailPriceCents <= 0
  ) {
    issues.push("current Target price is missing or invalid");
  } else if (priceDifferenceIsUnreliable(searchPriceCents, detailPriceCents)) {
    issues.push("Target search and product-detail prices conflict");
  }

  const searchLocation = candidate.priceProvenance.location;
  const detailLocation = detail.priceProvenance.location;
  const searchMismatch = observedLocationMismatch(searchLocation, context);
  const detailMismatch = observedLocationMismatch(detailLocation, context);
  if (searchMismatch) issues.push(searchMismatch);
  if (detailMismatch) issues.push(detailMismatch);

  const detailMatch = rankTargetProducts(
    request,
    [detail],
    context.constraints ?? [],
    { productId: candidate.productId, title: candidate.title },
  );
  if (!detailMatch.recommended) {
    issues.push("Target product details do not reliably match the requested item");
  }

  if (issues.length) {
    return withoutRecommendation(preliminary, issues, "no_match");
  }

  const location = mergedLocation(searchLocation, detailLocation, context);
  const priceScope = targetPriceScopeFromEvidence(location);
  const exactStoreVerified = targetExactStoreIsProven(location);
  const checkedAt = candidate.priceProvenance.checkedAt
    ?? candidate.checkedAt
    ?? detail.checkedAt
    ?? now.toISOString();
  const fulfillment = [...new Set([
    ...candidate.priceProvenance.fulfillment,
    ...detail.priceProvenance.fulfillment,
    context.fulfillmentMode,
  ])];
  const priceProvenance: TargetPriceProvenance = {
    ...candidate.priceProvenance,
    retailer: "target",
    priceSource: "target_search",
    priceScope,
    priceReliability: exactStoreVerified ? "verified" : "localized_estimate",
    exactStoreVerified,
    location,
    fulfillment,
    searchPriceCents,
    productDetailPriceCents: detail.priceProvenance.priceSource === "target_product"
      ? detailPriceCents
      : undefined,
    checkedAt,
  };
  const verifiedProduct: RankedTargetProduct = {
    ...candidate,
    brand: detail.brand ?? candidate.brand,
    productType: detail.productType ?? candidate.productType,
    thumbnail: detail.thumbnail ?? candidate.thumbnail,
    size: detail.size ?? candidate.size,
    inStock: availabilityConfirmed,
    availabilityStatus: availabilityConfirmed ? "in_stock" : "unknown",
    price: searchPriceCents / 100,
    priceCents: searchPriceCents,
    priceProvenance,
    priceLabel: targetPriceLabelForScope(priceScope),
    link: detail.link,
    linkType: "product",
    sourceUrl: detail.sourceUrl,
    productPageUnavailable: false,
    identityVerified: true,
    cartEligible: false,
    checkedAt,
    verification: "verified",
    verificationIssues: availabilityConfirmed
      ? []
      : [`Target ${context.fulfillmentMode} availability was not confirmed`],
    confidence: exactStoreVerified ? "high" : "medium",
  };
  const assumptions = [...(preliminary.assumptions ?? [])];
  if (priceScope === "localized") {
    assumptions.push("Localized Target price estimate; exact-store checkout price may differ");
  } else if (priceScope === "estimated") {
    assumptions.push("General Target price estimate; local checkout price may differ");
  }
  if (!availabilityConfirmed) {
    assumptions.push(`Target ${context.fulfillmentMode} availability was not confirmed; check Target before buying`);
  }

  return {
    ...preliminary,
    retailer: "target",
    recommended: verifiedProduct,
    alternatives: preliminary.alternatives.map((product) => ({
      ...product,
      cartEligible: false,
    })),
    assumptions: [...new Set(assumptions)],
    confidence: exactStoreVerified ? "high" : "medium",
    status: "matched",
    verifiedAt: checkedAt,
    explanation: !availabilityConfirmed
      ? `Verified Target product identity and comparison price. Target did not confirm ${context.fulfillmentMode} availability, so check Target before buying; Cartiva will require Target's visible Add control to confirm the item.`
      : exactStoreVerified
      ? "Verified Target product identity and exact requested-store price evidence; the product response also reported it in stock. Cartiva can add it through Target's visible controls."
      : priceScope === "localized"
        ? "Verified Target product identity; the localized response reported it in stock. The displayed price is an estimate because the response did not prove the requested store. Cartiva will confirm the add through Target's visible controls."
        : "Verified Target product identity; the response reported it in stock. The displayed price is an estimate because no exact store was proven. Cartiva will confirm the add through Target's visible controls.",
  };
}
