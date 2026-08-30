import { rankProducts } from "./matching";
import { extractMeasurement } from "./measurements";
import { isValidTargetProductUrl, resolveTargetLink } from "./target-url";
import type {
  RankedProduct,
  RankedTargetProduct,
  RetailFulfillmentMode,
  RetailLocationEvidence,
  RetailPriceScope,
  TargetMatchResult,
  TargetPriceLabel,
  TargetPriceProvenance,
  TargetProduct,
  TargetSellerType,
  WalmartProduct,
} from "./types";
import type { ProductConstraint } from "./product-facets";

type UnknownRecord = Record<string, unknown>;

export interface TargetNormalizationContext {
  source: "search" | "product";
  dataSource?: "decodo" | "redcircle" | "parsebot";
  fulfillmentMode: RetailFulfillmentMode;
  requestedStoreId?: string;
  requestedPostalCode?: string;
  checkedAt?: string;
}

export const TARGET_CART_AUTOMATION_POLICY = Object.freeze({
  enabled: false as const,
  reason: "No official Target cart API is used; the Cartiva extension can add verified matches through Target's visible controls.",
});

function recordValue(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function stringValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const cleaned = value.replace(/\s+/g, " ").trim();
    if (cleaned) return cleaned;
  }
  return undefined;
}

function numberValue(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.replace(/[$,]/g, ""))
        : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(?:true|false)$/i.test(value.trim())) {
      return value.trim().toLowerCase() === "true";
    }
  }
  return undefined;
}

function normalizedProductId(value: unknown) {
  const cleaned = stringValue(value)?.replace(/^A-/i, "");
  return cleaned && /^(?:\d{8}|\d{10})$/.test(cleaned) ? cleaned : undefined;
}

function normalizedStoreId(value: unknown) {
  const cleaned = stringValue(value);
  return cleaned && /^\d{3,4}$/.test(cleaned) ? cleaned : undefined;
}

function normalizedPostalCode(value: unknown) {
  const cleaned = stringValue(value);
  return cleaned && /^\d{5}$/.test(cleaned) ? cleaned : undefined;
}

function sellerTypeFor(raw: UnknownRecord, provenance: UnknownRecord | undefined): TargetSellerType {
  const explicit = stringValue(provenance?.sellerType, provenance?.seller_type);
  if (explicit === "target" || explicit === "marketplace" || explicit === "unknown") {
    return explicit;
  }

  const seller = stringValue(raw.seller, raw.sellerName, raw.seller_name);
  if (!seller) return "unknown";
  return /^(?:target|target\.com)$/i.test(seller) ? "target" : "marketplace";
}

export function targetExactStoreIsProven(location: RetailLocationEvidence) {
  return Boolean(
    location.requestedStoreId
    && location.observedStoreId
    && location.responseProvesLocation
    && location.storeMatched === true,
  );
}

export function targetPriceScopeFromEvidence(location: RetailLocationEvidence): RetailPriceScope {
  if (targetExactStoreIsProven(location)) return "exact_store";
  if (location.requestedStoreId || location.requestedPostalCode) return "localized";
  return "estimated";
}

export function targetPriceLabelForScope(scope: RetailPriceScope): TargetPriceLabel {
  if (scope === "exact_store") return "Verified exact-store price";
  if (scope === "localized") return "Localized price estimate";
  return "Price estimate";
}

/**
 * Converts a provider DTO into Cartiva's retailer-discriminated product shape.
 * This is deliberately structural so provider parsing can evolve independently.
 */
export function normalizeTargetProviderProduct(
  value: unknown,
  context: TargetNormalizationContext,
): TargetProduct | null {
  const raw = recordValue(value);
  if (!raw) return null;
  const providerProvenance = recordValue(raw.provenance);

  const productId = normalizedProductId(raw.tcin)
    ?? normalizedProductId(raw.productId)
    ?? normalizedProductId(raw.product_id);
  const title = stringValue(raw.title, raw.name);
  const centsValue = numberValue(raw.priceCents, raw.price_cents);
  const directPrice = numberValue(raw.price, raw.currentPrice, raw.current_price);
  const priceCents = centsValue !== undefined
    ? Math.round(centsValue)
    : directPrice !== undefined
      ? Math.round(directPrice * 100)
      : undefined;
  if (!productId || !title || priceCents === undefined || priceCents <= 0) return null;

  const sourceUrl = stringValue(raw.url, raw.link, raw.productUrl, raw.product_url);
  const resolvedLink = resolveTargetLink(title, sourceUrl, [productId]);
  const identityVerified = isValidTargetProductUrl(sourceUrl, [productId]);

  const providerRequestedStoreId = normalizedStoreId(providerProvenance?.requestedStoreId)
    ?? normalizedStoreId(providerProvenance?.requested_store_id);
  const providerRequestedPostalCode = normalizedPostalCode(providerProvenance?.requestedPostalCode)
    ?? normalizedPostalCode(providerProvenance?.requestedZip)
    ?? normalizedPostalCode(providerProvenance?.requestedDeliveryZip)
    ?? normalizedPostalCode(providerProvenance?.requested_zip);
  const contextStoreId = normalizedStoreId(context.requestedStoreId);
  const contextPostalCode = normalizedPostalCode(context.requestedPostalCode);
  const requestedStoreId = contextStoreId ?? providerRequestedStoreId;
  const requestedPostalCode = contextPostalCode ?? providerRequestedPostalCode;
  const observedStoreId = normalizedStoreId(providerProvenance?.observedStoreId)
    ?? normalizedStoreId(providerProvenance?.responseStoreId)
    ?? normalizedStoreId(providerProvenance?.observed_store_id);
  const observedPostalCode = normalizedPostalCode(providerProvenance?.observedPostalCode)
    ?? normalizedPostalCode(providerProvenance?.observedZip)
    ?? normalizedPostalCode(providerProvenance?.responseZip)
    ?? normalizedPostalCode(providerProvenance?.observed_zip);
  const providerClaimsLocation = booleanValue(
    providerProvenance?.locationVerified,
    providerProvenance?.responseProvesLocation,
    providerProvenance?.location_verified,
  ) === true;
  // An echoed request value is not store evidence. Require an observed response
  // location in addition to the provider's evidence flag.
  const responseProvesLocation = providerClaimsLocation
    && Boolean(observedStoreId || observedPostalCode);
  const storeMatched = requestedStoreId && observedStoreId
    ? requestedStoreId === observedStoreId
    : undefined;
  const postalCodeMatched = requestedPostalCode && observedPostalCode
    ? requestedPostalCode === observedPostalCode
    : undefined;
  const location: RetailLocationEvidence = {
    requestedStoreId,
    observedStoreId,
    requestedPostalCode,
    observedPostalCode,
    responseProvesLocation,
    storeMatched,
    postalCodeMatched,
  };
  const priceScope = targetPriceScopeFromEvidence(location);
  const sellerType = sellerTypeFor(raw, providerProvenance);
  const requestContextMismatch = Boolean(
    (contextStoreId && providerRequestedStoreId && contextStoreId !== providerRequestedStoreId)
    || (
      contextPostalCode
      && providerRequestedPostalCode
      && contextPostalCode !== providerRequestedPostalCode
    ),
  );
  const locationMismatch = requestContextMismatch
    || storeMatched === false
    || postalCodeMatched === false;
  const priceReliability = !identityVerified || locationMismatch || sellerType === "marketplace"
    ? "unreliable" as const
    : priceScope === "exact_store"
      ? "verified" as const
      : "localized_estimate" as const;
  const upstreamStock = booleanValue(raw.inStock, raw.in_stock);
  const availabilityStatus = upstreamStock === true
    ? "in_stock" as const
    : upstreamStock === false
      ? "out_of_stock" as const
      : "unknown" as const;
  const checkedAt = stringValue(
    raw.checkedAt,
    raw.checked_at,
    providerProvenance?.checkedAt,
    context.checkedAt,
  ) ?? new Date().toISOString();
  const fulfillment = [context.fulfillmentMode];
  const priceProvenance: TargetPriceProvenance = {
    retailer: "target",
    priceSource: context.source === "search" ? "target_search" : "target_product",
    priceScope,
    priceReliability,
    exactStoreVerified: targetExactStoreIsProven(location),
    location,
    fulfillment,
    sellerType,
    searchPriceCents: context.source === "search" ? priceCents : undefined,
    productDetailPriceCents: context.source === "product" ? priceCents : undefined,
    checkedAt,
  };

  return {
    retailer: "target",
    id: productId,
    productId,
    title,
    price: priceCents / 100,
    priceCents,
    priceProvenance,
    ...resolvedLink,
    dataSource: context.dataSource ?? "decodo",
    thumbnail: stringValue(raw.thumbnail, raw.image, raw.imageUrl, raw.image_url),
    seller: stringValue(raw.seller, raw.sellerName, raw.seller_name),
    brand: stringValue(raw.brand),
    productType: stringValue(raw.productType, raw.product_type, raw.category),
    inStock: upstreamStock === true,
    availabilityStatus,
    sponsored: booleanValue(raw.sponsored) === true,
    size: extractMeasurement(title),
    checkedAt,
    identityVerified,
    priceLabel: targetPriceLabelForScope(priceScope),
    cartEligible: false,
    verification: "unverified",
  };
}

export function targetCandidateReliabilityIssues(product: TargetProduct) {
  const issues: string[] = [];
  const provenance = product.priceProvenance;
  if (product.retailer !== "target" || provenance.retailer !== "target") {
    issues.push("retailer identity is not Target");
  }
  if (!product.identityVerified || !isValidTargetProductUrl(
    product.link,
    [product.productId],
  )) {
    issues.push("Target product identity or URL is not verified");
  }
  if (!Number.isFinite(product.price) || product.price <= 0) {
    issues.push("Target price is missing or invalid");
  }
  if (provenance.priceReliability === "unreliable") {
    issues.push("Target price provenance is unreliable");
  }
  if (provenance.location.storeMatched === false) {
    issues.push("response store does not match the requested Target store");
  }
  if (provenance.location.postalCodeMatched === false) {
    issues.push("response ZIP does not match the requested delivery ZIP");
  }
  if (provenance.sellerType === "marketplace") {
    issues.push("third-party marketplace offer is not eligible");
  }
  if (product.availabilityStatus === "out_of_stock") {
    issues.push("product is out of stock");
  }
  return [...new Set(issues)];
}

function rankingProjection(product: TargetProduct): WalmartProduct {
  return {
    id: product.id,
    productId: product.productId,
    title: product.title,
    price: product.price,
    priceCents: product.priceCents,
    link: product.link,
    linkType: product.linkType,
    sourceUrl: product.sourceUrl,
    productPageUnavailable: product.productPageUnavailable,
    thumbnail: product.thumbnail,
    brand: product.brand,
    productType: product.productType,
    // Unknown Search availability is allowed only into preliminary ranking;
    // product details must explicitly prove stock before final verification.
    inStock: product.availabilityStatus !== "out_of_stock",
    sponsored: product.sponsored,
    size: product.size,
    checkedAt: product.checkedAt,
  };
}

function restoreTargetRank(
  ranked: RankedProduct,
  originals: Map<string, TargetProduct>,
): RankedTargetProduct | null {
  const original = originals.get(ranked.id);
  if (!original) return null;
  const reasons = original.availabilityStatus === "unknown"
    ? ranked.reasons
      .filter((reason) => reason !== "in stock")
      .concat("availability awaiting Target product verification")
    : ranked.reasons;
  return {
    ...original,
    score: ranked.score,
    confidence: ranked.confidence,
    unitPrice: ranked.unitPrice,
    unitLabel: ranked.unitLabel,
    comparablePrice: ranked.comparablePrice,
    matchedTerms: ranked.matchedTerms,
    reasons,
  };
}

export function rankTargetProducts(
  request: string,
  products: TargetProduct[],
  constraints: ProductConstraint[] = [],
  preferredIdentity?: { productId?: string; title?: string },
): TargetMatchResult {
  const eligible = products.filter((product) => !targetCandidateReliabilityIssues(product).length);
  const originals = new Map(eligible.map((product) => [product.id, product]));
  const ranked = rankProducts(
    request,
    eligible.map(rankingProjection),
    constraints,
    preferredIdentity,
  );
  const recommended = ranked.recommended
    ? restoreTargetRank(ranked.recommended, originals)
    : null;
  const alternatives = ranked.alternatives
    .map((product) => restoreTargetRank(product, originals))
    .filter((product): product is RankedTargetProduct => Boolean(product));

  return {
    retailer: "target",
    requestedItem: request,
    recommended,
    alternatives,
    assumptions: ranked.assumptions,
    confidence: "low",
    status: recommended ? "review" : ranked.status,
    clarification: ranked.clarification,
    explanation: recommended
      ? "Possible Target match found. Cartiva is verifying current product details and price location."
      : ranked.clarification ?? "No reliable Target match met the identity, price, and package requirements.",
  };
}
