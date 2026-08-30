import type { ExtensionProduct, FulfillmentMode, PreparedItem } from "./types.js";
import { isTrustedKrogerFamilyUrl } from "./kroger-hosts.js";

const VERIFIED_PRICE_MAX_AGE_MS = 30 * 60 * 1000;

export function isFreshVerification(value?: string, nowMs = Date.now()) {
  if (!value) return false;
  const checkedAt = Date.parse(value);
  return Number.isFinite(checkedAt)
    && checkedAt <= nowMs + 60_000
    && nowMs - checkedAt <= VERIFIED_PRICE_MAX_AGE_MS;
}

const BRAND_ALIASES: Record<string, string[]> = {
  "coca cola": ["coca cola", "coke", "coke zero"],
  sprite: ["sprite"],
  "7 up": ["7 up", "7up"],
  gatorade: ["gatorade"],
  takis: ["takis"],
  pepsi: ["pepsi"],
  fage: ["fage"],
  doritos: ["doritos"],
  lays: ["lays"],
  "dr pepper": ["dr pepper"],
};

function normalizeBrand(value: string) {
  return value.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export function productMatchesExplicitBrand(item: PreparedItem) {
  const requested = item.request.brand;
  if (!requested || !item.product) return true;
  const canonical = normalizeBrand(requested);
  const aliases = BRAND_ALIASES[canonical] ?? [canonical];
  const titleAndBrand = normalizeBrand(`${item.product.brand ?? ""} ${item.product.title}`);
  if (["great value", "equate", "marketside", "bettergoods", "sams choice"]
    .some((storeBrand) => titleAndBrand.includes(storeBrand))) {
    return false;
  }
  // An explicit API brand is authoritative. This prevents synthesized-looking
  // titles such as "Great Value Coke Zero" from passing a Coca-Cola request.
  const candidate = normalizeBrand(item.product.brand ?? item.product.title);
  return aliases.some((alias) => {
    const normalizedAlias = normalizeBrand(alias);
    return candidate === normalizedAlias
      || candidate.startsWith(`${normalizedAlias} `)
      || candidate.endsWith(` ${normalizedAlias}`)
      || candidate.includes(` ${normalizedAlias} `);
  });
}

export function isValidWalmartProductUrl(value: string, itemId?: string) {
  if (!itemId || !/^\d{6,20}$/.test(itemId)) return false;
  try {
    const url = new URL(value);
    const pathIdentifier = url.pathname.match(/^\/ip\/(?:[^/]+\/)?(\d+)\/?$/i)?.[1];
    return url.protocol === "https:"
      && (url.hostname === "www.walmart.com" || url.hostname === "walmart.com")
      && !url.username
      && !url.password
      && !url.port
      && pathIdentifier === itemId;
  } catch {
    return false;
  }
}

export function isValidTargetProductUrl(value: string, productId?: string) {
  const normalizedId = productId?.replace(/^A-/i, "");
  if (!normalizedId || !/^\d{6,12}$/.test(normalizedId)) return false;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/-\/A-(\d{6,12})(?:\/|$)/i);
    return url.protocol === "https:"
      && (url.hostname === "www.target.com" || url.hostname === "target.com")
      && !url.username
      && !url.password
      && !url.port
      && match?.[1] === normalizedId;
  } catch {
    return false;
  }
}

export function isValidKrogerProductUrl(value: string) {
  try {
    const url = new URL(value);
    return isTrustedKrogerFamilyUrl(value)
      && (url.pathname.startsWith("/p/") || url.pathname === "/search");
  } catch {
    return false;
  }
}

export function isKrogerBuildEligible(
  item: PreparedItem,
  fulfillmentMode?: FulfillmentMode,
  nowMs = Date.now(),
  expectedLocationId?: string,
) {
  const product = item.product;
  const provenance = product?.priceProvenance;
  const fulfillment = provenance?.fulfillment ?? [];
  const fulfillsMode = fulfillmentMode === "pickup"
    ? fulfillment.includes("pickup")
    : fulfillmentMode === "delivery"
      ? fulfillment.includes("delivery")
      : false;
  const requestedLocationId = provenance?.location?.requestedStoreId?.trim();
  const observedLocationId = provenance?.location?.observedStoreId?.trim();
  const exactLocation = Boolean(requestedLocationId && observedLocationId)
    && requestedLocationId === observedLocationId
    && (!expectedLocationId?.trim() || requestedLocationId === expectedLocationId.trim())
    && provenance?.priceScope === "exact_store"
    && provenance?.exactStoreVerified === true
    && provenance?.priceReliability === "verified"
    && provenance?.location?.responseProvesLocation === true
    && provenance?.location?.storeMatched === true;
  return item.retailer === "kroger"
    && item.matchStatus === "matched"
    && item.dataMode === "live"
    && product?.retailer === "kroger"
    && product.verification === "verified"
    && product.identityVerified === true
    && productMatchesExplicitBrand(item)
    && isFreshVerification(item.checkedAt ?? product.checkedAt, nowMs)
    && product.inStock === true
    && product.availabilityStatus === "in_stock"
    && Number.isInteger(product.priceCents)
    && product.priceCents! > 0
    && /^\d{8,14}$/.test(product.upc ?? "")
    && product.cartEligible === true
    && provenance?.retailer === "kroger"
    && exactLocation
    && fulfillsMode;
}

export function isReliableTargetMatch(
  item: PreparedItem,
  fulfillmentMode?: FulfillmentMode,
  nowMs = Date.now(),
) {
  const product = item.product;
  const provenance = product?.priceProvenance;
  const fulfillment = provenance?.fulfillment ?? [];
  const fulfillsMode = fulfillmentMode === "pickup"
    ? fulfillment.includes("pickup") || fulfillment.includes("in_store")
    : fulfillmentMode === "delivery" || fulfillmentMode === "shipping"
      ? fulfillment.includes(fulfillmentMode)
      : false;
  const availabilityFitsMode = fulfillmentMode === "pickup"
    ? product?.inStock === true && product.availabilityStatus === "in_stock"
    : product?.availabilityStatus !== "out_of_stock";
  return item.retailer === "target"
    && item.matchStatus === "matched"
    && item.dataMode === "live"
    && Boolean(product)
    && product!.retailer === "target"
    && product!.verification === "verified"
    && product!.identityVerified === true
    && productMatchesExplicitBrand(item)
    && isFreshVerification(item.checkedAt ?? product!.checkedAt, nowMs)
    && availabilityFitsMode
    && Number.isInteger(product!.priceCents)
    && product!.priceCents! > 0
    && isValidTargetProductUrl(product!.link, product!.productId)
    && !product!.productPageUnavailable
    && provenance?.sellerType !== "marketplace"
    && provenance?.priceReliability !== "unreliable"
    && fulfillsMode;
}

/**
 * Target cart automation is allowed only for the same strict live comparison
 * matches Cartiva displays. The content script still verifies the canonical
 * TCIN and visible product title before it can click any Target control.
 */
export function isTargetBuildEligible(
  item: PreparedItem,
  fulfillmentMode?: FulfillmentMode,
  nowMs = Date.now(),
) {
  return isReliableTargetMatch(item, fulfillmentMode, nowMs)
    && item.product?.linkType === "product"
    && !item.product.productPageUnavailable;
}

export function usesLocalizedWalmartPrice(product?: ExtensionProduct) {
  return (product?.dataSource === "openwebninja" || product?.dataSource === "scrapingbee")
    && product.priceProvenance?.priceScope === "localized"
    && product.priceProvenance.localPriceEligible === true;
}

export function isBuildEligible(
  item: PreparedItem,
  fulfillmentMode?: FulfillmentMode,
  nowMs = Date.now(),
  expectedStoreId?: string,
) {
  const product = item.product;
  const fulfillment = product?.priceProvenance?.fulfillment ?? [];
  const provenance = product?.priceProvenance;
  const hasLocalizedWalmartPrice = usesLocalizedWalmartPrice(product);
  const requestedStoreId = provenance?.requestedStoreId?.trim();
  const observedStoreIds = [
    requestedStoreId,
    provenance?.searchStoreId?.trim(),
    provenance?.detailStoreId?.trim(),
  ].filter((value): value is string => Boolean(value));
  const storesAgree = /^\d+$/.test(requestedStoreId ?? "")
    && new Set(observedStoreIds).size === 1
    && (!expectedStoreId?.trim() || observedStoreIds.every((value) => value === expectedStoreId.trim()))
    && provenance?.searchStoreMatched !== false
    && provenance?.detailStoreMatched !== false;
  // Local verification covers pickup/in-store and Walmart delivery offers.
  // Shipping remains planning-only until shipping-specific price provenance
  // is available from the backend.
  const fulfillsMode = fulfillmentMode === "pickup"
    ? provenance?.verifiedFulfillmentMode === "pickup"
      && (fulfillment.includes("pickup") || fulfillment.includes("in_store"))
    : fulfillmentMode === "delivery"
      ? provenance?.verifiedFulfillmentMode === "delivery"
        && fulfillment.includes("delivery")
      : false;
  return item.matchStatus === "matched"
    && item.dataMode === "live"
    && Boolean(product)
    && product!.verification === "verified"
    && productMatchesExplicitBrand(item)
    && isFreshVerification(item.checkedAt ?? product!.checkedAt, nowMs)
    && product!.inStock
    && Number.isInteger(product!.priceCents)
    && product!.priceCents! > 0
    && /^\d{6,20}$/.test(product!.itemId ?? "")
    && product!.linkType === "product"
    && isValidWalmartProductUrl(product!.link, product!.itemId)
    && !product!.productPageUnavailable
    && product!.priceProvenance?.sellerType === "walmart"
    && product!.priceProvenance?.localPriceEligible === true
    && (product!.priceProvenance?.localPriceVerified === true || hasLocalizedWalmartPrice)
    && storesAgree
    && fulfillsMode;
}

export function verifiedSubtotalCents(
  items: PreparedItem[],
  fulfillmentMode?: FulfillmentMode,
  nowMs = Date.now(),
  expectedStoreId?: string,
) {
  return items.reduce((total, item) => {
    if (!isBuildEligible(item, fulfillmentMode, nowMs, expectedStoreId) || !item.product) return total;
    const cents = item.product.priceCents!;
    return total + cents * item.request.quantity;
  }, 0);
}

export function targetEstimateSubtotalCents(
  items: PreparedItem[],
  fulfillmentMode?: FulfillmentMode,
  nowMs = Date.now(),
) {
  return items.reduce((total, item) => {
    if (!isReliableTargetMatch(item, fulfillmentMode, nowMs) || !item.product) return total;
    return total + item.product.priceCents! * item.request.quantity;
  }, 0);
}

export function krogerSubtotalCents(
  items: PreparedItem[],
  fulfillmentMode?: FulfillmentMode,
  nowMs = Date.now(),
  expectedLocationId?: string,
) {
  return items.reduce((total, item) => {
    if (!isKrogerBuildEligible(item, fulfillmentMode, nowMs, expectedLocationId) || !item.product) return total;
    return total + item.product.priceCents! * item.request.quantity;
  }, 0);
}

export function formatCurrency(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}
