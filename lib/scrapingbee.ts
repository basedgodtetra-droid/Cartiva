import { siteConfig } from "@/config/site";
import { extractMeasurement } from "./measurements";
import {
  getMockWalmartProductDetail,
  getMockWalmartResults,
} from "./mock-data";
import type {
  WalmartFulfillmentType,
  WalmartPriceProvenance,
  WalmartProduct,
  WalmartResponseLocation,
  WalmartSellerType,
} from "./types";
import { resolveWalmartLink } from "./walmart-url";

type UnknownRecord = Record<string, unknown>;

export interface ScrapingBeeLocation {
  zip?: string;
  state?: string;
  domain?: "us" | "ca";
}

export interface ScrapingBeeSearchOptions extends ScrapingBeeLocation {
  storeId: string;
}

export interface ScrapingBeeCallDiagnostics {
  cacheHit: boolean;
  deduplicated: boolean;
  apiCall: boolean;
  /** Legacy route field. ScrapingBee does not expose an upstream-cache signal. */
  serpApiCacheUsed: null;
}

export interface WalmartSearchSuggestionSignal {
  text: string;
  source: "spelling" | "related" | "filter";
  score?: number;
  group?: string;
  itemCount?: number;
}

type SearchResult = {
  products: WalmartProduct[];
  suggestionSignals?: WalmartSearchSuggestionSignal[];
  mode: "live" | "demo";
  diagnostics: ScrapingBeeCallDiagnostics;
};

type DetailResult = {
  product: WalmartProduct | null;
  mode: "live" | "demo";
  diagnostics: ScrapingBeeCallDiagnostics;
};

type SearchCacheEntry = { products: WalmartProduct[]; expiresAt: number };
type DetailCacheEntry = { product: WalmartProduct | null; expiresAt: number };

declare global {
  var scrapingBeeSearchCache: Map<string, SearchCacheEntry> | undefined;
  var scrapingBeeDetailCache: Map<string, DetailCacheEntry> | undefined;
  var scrapingBeeSearchInFlight: Map<string, Promise<WalmartProduct[]>> | undefined;
  var scrapingBeeDetailInFlight: Map<string, Promise<WalmartProduct | null>> | undefined;
}

const searchCache = globalThis.scrapingBeeSearchCache
  ?? new Map<string, SearchCacheEntry>();
const detailCache = globalThis.scrapingBeeDetailCache
  ?? new Map<string, DetailCacheEntry>();
const searchInFlight = globalThis.scrapingBeeSearchInFlight
  ?? new Map<string, Promise<WalmartProduct[]>>();
const detailInFlight = globalThis.scrapingBeeDetailInFlight
  ?? new Map<string, Promise<WalmartProduct | null>>();

globalThis.scrapingBeeSearchCache = searchCache;
globalThis.scrapingBeeDetailCache = detailCache;
globalThis.scrapingBeeSearchInFlight = searchInFlight;
globalThis.scrapingBeeDetailInFlight = detailInFlight;

const API_BASE = "https://app.scrapingbee.com/api/v1/walmart";
const CACHE_VERSION = "scrapingbee-localized-walmart-v1";
// ScrapingBee may retry a failed Walmart Search request for up to 30 seconds.
const REQUEST_TIMEOUT_MS = 35_000;
const WALMART_SELLER_ID = "walmart";
const WALMART_US_SELLER_ID = "F55CDC31AB754BB68FE0B39041159D63";

export class WalmartSearchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "configuration"
      | "authentication"
      | "rate_limit"
      | "timeout"
      | "api_error"
      | "malformed",
  ) {
    super(message);
    this.name = "WalmartSearchError";
  }
}

export { WalmartSearchError as ScrapingBeeError };

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function stringValue(...values: unknown[]) {
  return values.find((value): value is string => (
    typeof value === "string" && value.trim().length > 0
  ));
}

function identifierValue(...values: unknown[]) {
  const value = values.find((candidate) => (
    typeof candidate === "string" && candidate.trim().length > 0
  ) || (
    typeof candidate === "number" && Number.isFinite(candidate)
  ));
  return value === undefined ? undefined : String(value).trim();
}

function booleanValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (/^true$/i.test(value.trim())) return true;
  if (/^false$/i.test(value.trim())) return false;
  return undefined;
}

function numberValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value !== "string") continue;
    const normalized = value.trim().replace(/,/g, "");
    const match = normalized.match(/(?:^|[^\d])-?\$?\s*(\d+(?:\.\d+)?)(?:[^\d]|$)/);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function nonNegativeNumberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return undefined;
  const match = value.trim().replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function hasFinancingPriceDisplay(...values: unknown[]) {
  return values.some((value) => typeof value === "string" && (
    /(?:\/|per\s+)(?:mo(?:nth)?|wk|week)\b|\bmonthly\b|\bfinanc(?:e|ing)\b|\binstallments?\b|\blease\b/i
      .test(value)
  ));
}

function normalizedUnitBasis(value: unknown): WalmartProduct["reportedUnitBasis"] {
  if (typeof value !== "string") return undefined;
  const unit = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^(?:oz|ounce|ounces)$/.test(unit)) return "oz";
  if (/^(?:fl oz|fluid ounce|fluid ounces)$/.test(unit)) return "fl oz";
  if (/^(?:lb|lbs|pound|pounds)$/.test(unit)) return "lb";
  if (/^(?:ea|each|count|ct|unit)$/.test(unit)) return "each";
  return undefined;
}

function sellerFields(product: UnknownRecord) {
  const sellerRecord = asRecord(product.seller);
  return {
    name: stringValue(
      sellerRecord?.name,
      product.seller,
      product.seller_name,
      product.seller_display_name,
    ),
    id: identifierValue(sellerRecord?.id, product.seller_id),
    type: stringValue(product.seller_type),
  };
}

function sellerTypeFor(product: UnknownRecord): WalmartSellerType {
  const seller = sellerFields(product);
  if (
    seller.id?.toLowerCase() === WALMART_SELLER_ID
    || seller.id?.toUpperCase() === WALMART_US_SELLER_ID
    || Boolean(seller.name && /^walmart(?:\.com)?$/i.test(seller.name.trim()))
    || /^(?:internal|first_party)$/i.test(seller.type ?? "")
  ) return "walmart";
  return seller.name || seller.id || seller.type ? "marketplace" : "unknown";
}

function addFulfillment(
  values: WalmartFulfillmentType[],
  value: WalmartFulfillmentType,
) {
  if (!values.includes(value)) values.push(value);
}

function searchFulfillmentFor(product: UnknownRecord) {
  const fulfillment: WalmartFulfillmentType[] = [];
  const live = asRecord(product.fulfillment);
  if (
    booleanValue(live?.pickup) === true
    || booleanValue(product.pickup) === true
  ) {
    addFulfillment(fulfillment, "in_store");
    addFulfillment(fulfillment, "pickup");
  }
  if (
    booleanValue(live?.delivery) === true
    || booleanValue(product.delivery) === true
  ) addFulfillment(fulfillment, "delivery");
  if (
    booleanValue(live?.shipping) === true
    || booleanValue(live?.free_shipping) === true
    || booleanValue(product.free_shipping) === true
    || booleanValue(product.two_day_shipping) === true
  ) addFulfillment(fulfillment, "shipping");
  return fulfillment;
}

function detailFulfillmentFor(product: UnknownRecord) {
  const fulfillment = searchFulfillmentFor(product);
  const availability = asRecord(product.availability);
  const deliveryOptions = asRecord(availability?.delivery_options);
  const shipping = asRecord(product.shipping);
  const pickup = stringValue(
    deliveryOptions?.pickup,
    availability?.pickup,
    product.pickup,
  );
  if (
    booleanValue(availability?.pickup) === true
    || booleanValue(product.pickup) === true
    || /available|today|ready/i.test(pickup ?? "")
  ) {
    addFulfillment(fulfillment, "in_store");
    addFulfillment(fulfillment, "pickup");
  }
  if (
    stringValue(deliveryOptions?.standard, deliveryOptions?.express)
    || booleanValue(shipping?.free) !== undefined
    || numberValue(shipping?.price)
  ) addFulfillment(fulfillment, "shipping");
  if (booleanValue(availability?.delivery) === true) {
    addFulfillment(fulfillment, "delivery");
  }
  return fulfillment;
}

function inStockFor(product: UnknownRecord) {
  const availability = asRecord(product.availability);
  const outOfStock = booleanValue(product.out_of_stock);
  if (outOfStock !== undefined) return !outOfStock;
  const explicit = booleanValue(availability?.in_stock)
    ?? booleanValue(product.in_stock);
  if (explicit !== undefined) return explicit;
  const text = stringValue(product.availability, product.availability_status);
  return text ? /\bin[ -]?stock\b|available/i.test(text) : false;
}

function normalizeOptions(options: ScrapingBeeSearchOptions): ScrapingBeeSearchOptions {
  return {
    storeId: options.storeId.trim(),
    zip: options.zip?.trim() || undefined,
    state: options.state?.trim().toUpperCase() || undefined,
    domain: options.domain ?? "us",
  };
}

function normalizedQuery(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function requestedLocation(options: ScrapingBeeSearchOptions): WalmartResponseLocation {
  return {
    postalCode: options.zip,
    provinceCode: options.state,
    country: options.domain === "ca" ? "CA" : "US",
  };
}

function responseLocation(value: unknown) {
  const location = asRecord(value);
  if (!location) return undefined;
  const normalized: WalmartResponseLocation = {
    storeId: identifierValue(location.store_id, location.storeId),
    postalCode: identifierValue(
      location.zipcode,
      location.zip_code,
      location.postal_code,
      location.postalCode,
    ),
    city: stringValue(location.city),
    provinceCode: stringValue(location.state, location.province_code, location.provinceCode),
    country: stringValue(location.country),
  };
  return Object.values(normalized).some(Boolean) ? normalized : undefined;
}

function normalizedWalmartSourceUrl(value: unknown) {
  const source = stringValue(value)?.trim();
  if (!source) return undefined;
  return /^\/ip(?:\/|$)/i.test(source)
    ? `https://www.walmart.com${source}`
    : source;
}

function mergedLocation(
  options: ScrapingBeeSearchOptions,
  returned?: WalmartResponseLocation,
) {
  const requested = requestedLocation(options);
  return {
    storeId: returned?.storeId,
    postalCode: returned?.postalCode ?? requested.postalCode,
    city: returned?.city,
    provinceCode: returned?.provinceCode ?? requested.provinceCode,
    country: returned?.country ?? requested.country,
  } satisfies WalmartResponseLocation;
}

function diagnostics(
  cacheHit: boolean,
  deduplicated: boolean,
  apiCall: boolean,
): ScrapingBeeCallDiagnostics {
  return { cacheHit, deduplicated, apiCall, serpApiCacheUsed: null };
}

function cloneProduct(product: WalmartProduct): WalmartProduct {
  return {
    ...product,
    size: product.size ? { ...product.size } : undefined,
    priceProvenance: product.priceProvenance ? {
      ...product.priceProvenance,
      fulfillment: [...product.priceProvenance.fulfillment],
      searchLocation: product.priceProvenance.searchLocation
        ? { ...product.priceProvenance.searchLocation }
        : undefined,
      detailLocation: product.priceProvenance.detailLocation
        ? { ...product.priceProvenance.detailLocation }
        : undefined,
    } : undefined,
    verificationIssues: product.verificationIssues
      ? [...product.verificationIssues]
      : undefined,
  };
}

function pruneCache(cache: Map<string, { expiresAt: number }>) {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > 200) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function consumerAbortError() {
  return new DOMException("The Cartiva request was cancelled.", "AbortError");
}

/** A caller may stop waiting without cancelling a request shared by other callers. */
function waitForSharedRequest<T>(request: Promise<T>, signal?: AbortSignal) {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject<T>(consumerAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(consumerAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function fetchScrapingBee(path: "/search" | "/product", parameters: URLSearchParams) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY?.trim();
  if (!apiKey) {
    throw new WalmartSearchError(
      "ScrapingBee is not configured on the Cartiva server.",
      "configuration",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}?${parameters}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (path === "/product" && (response.status === 404 || response.status === 410)) {
      return null;
    }
    if (response.status === 401 || response.status === 403) {
      throw new WalmartSearchError(
        "ScrapingBee authentication failed. Check the server-side API key.",
        "authentication",
      );
    }
    if (response.status === 429) {
      throw new WalmartSearchError(
        "Walmart data concurrency limit reached. Wait a moment and search again.",
        "rate_limit",
      );
    }
    if (response.status === 408 || response.status === 504) {
      throw new WalmartSearchError(
        "Walmart data took too long to respond. Please try again.",
        "timeout",
      );
    }
    if ([400, 413, 422].includes(response.status)) {
      throw new WalmartSearchError(
        "ScrapingBee rejected the Walmart request parameters.",
        "configuration",
      );
    }
    if (!response.ok) {
      throw new WalmartSearchError(
        `Walmart data request failed with status ${response.status}.`,
        "api_error",
      );
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new WalmartSearchError(
        "ScrapingBee returned malformed Walmart data.",
        "malformed",
      );
    }
  } catch (error) {
    if (error instanceof WalmartSearchError) throw error;
    if (controller.signal.aborted) {
      throw new WalmartSearchError(
        "Walmart data request timed out. Please try again.",
        "timeout",
      );
    }
    throw new WalmartSearchError(
      "Walmart data is temporarily unavailable.",
      "api_error",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function reportedUnitFields(product: UnknownRecord) {
  const unitRecord = asRecord(product.unit_price);
  const rawAmount = stringValue(
    product.price_per_unit,
    product.price_per_unit_amount,
    unitRecord?.display,
  );
  const numeric = numberValue(
    unitRecord?.price,
    unitRecord?.amount,
    product.price_per_unit_amount,
    rawAmount,
  );
  if (!numeric) return {};
  const basisText = `${stringValue(
    unitRecord?.unit,
    product.price_per_unit_type,
  ) ?? ""} ${rawAmount ?? ""}`.toLowerCase();
  const basis = normalizedUnitBasis(unitRecord?.unit)
    ?? normalizedUnitBasis(product.price_per_unit_type)
    ?? (/fl\s*oz|fluid ounce/.test(basisText)
      ? "fl oz"
      : /(?:\/|per\s*)oz|\bounce\b/.test(basisText)
        ? "oz"
        : /(?:\/|per\s*)lb|pound/.test(basisText)
          ? "lb"
          : /each|\/ea|\bct\b|\bcount\b/.test(basisText)
            ? "each"
            : undefined);
  if (!basis) return {};
  const cents = /¢|\bcents?\b/i.test(rawAmount ?? "");
  const unitPrice = Number((numeric / (cents ? 100 : 1)).toFixed(6));
  return { reportedUnitPrice: unitPrice, reportedUnitBasis: basis };
}

export function parseScrapingBeeSearchProduct(
  value: unknown,
  options: ScrapingBeeSearchOptions & {
    checkedAt?: string;
    responseLocation?: WalmartResponseLocation;
  },
): WalmartProduct | null {
  const product = asRecord(value);
  if (!product) return null;
  const title = stringValue(product.title);
  const productId = identifierValue(
    product.product_id,
    product.id,
    product.item_id,
    product.us_item_id,
  );
  const itemId = identifierValue(product.us_item_id, product.item_id, productId);
  const priceRecord = asRecord(product.price);
  if (!title || !productId || hasFinancingPriceDisplay(
    product.price_display,
    product.price,
    priceRecord?.display,
    priceRecord?.current_display,
  )) return null;
  const price = numberValue(priceRecord?.current, product.price);
  if (!price) return null;
  const priceCents = Math.round(price * 100);
  const inStock = inStockFor(product);
  const seller = sellerFields(product);
  const sellerType = sellerTypeFor(product);
  const fulfillment = searchFulfillmentFor(product);
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const returnedStoreId = options.responseLocation?.storeId;
  const searchStoreMatched = returnedStoreId
    ? returnedStoreId === options.storeId
    : undefined;
  const localPriceEligible = Boolean(
    inStock
    && sellerType === "walmart"
    && searchStoreMatched !== false
    && (searchStoreMatched === true
      || fulfillment.includes("pickup")
      || fulfillment.includes("in_store")),
  );
  const sourceUrl = normalizedWalmartSourceUrl(
    stringValue(product.url, product.product_url, product.canonical_url),
  );
  const link = resolveWalmartLink(title, sourceUrl, [itemId, productId]);
  const reportedUnit = reportedUnitFields(product);
  const originalPrice = numberValue(
    priceRecord?.original,
    product.price_strikethrough,
    product.original_price,
  );
  const isSale = Boolean(originalPrice && originalPrice > price);
  const shippingPrice = booleanValue(product.free_shipping) === true
    ? 0
    : nonNegativeNumberValue(product.shipping_price);
  const priceProvenance: WalmartPriceProvenance = {
    priceSource: searchStoreMatched === true && sellerType === "walmart"
      ? isSale ? "local_store_sale" : "local_store_search"
      : sellerType === "marketplace" ? "marketplace_search" : "walmart_search",
    priceScope: searchStoreMatched === true ? "exact_store" : "localized",
    searchPriceCents: priceCents,
    regularPriceCents: originalPrice ? Math.round(originalPrice * 100) : undefined,
    salePriceCents: isSale ? priceCents : undefined,
    shippingPriceCents: shippingPrice === undefined
      ? undefined
      : Math.round(shippingPrice * 100),
    unitPriceCents: reportedUnit.reportedUnitPrice
      ? Math.round(reportedUnit.reportedUnitPrice * 100)
      : undefined,
    unitPrice: reportedUnit.reportedUnitPrice,
    requestedStoreId: options.storeId,
    searchStoreId: returnedStoreId,
    searchLocation: mergedLocation(options, options.responseLocation),
    searchStoreMatched,
    fulfillment,
    sellerType,
    localPriceEligible,
    localPriceVerified: false,
    checkedAt,
  };
  return {
    id: productId,
    productId,
    itemId,
    title,
    price,
    priceCents,
    priceProvenance,
    ...link,
    dataSource: "scrapingbee",
    thumbnail: stringValue(product.image, product.thumbnail),
    seller: seller.name,
    brand: stringValue(product.brand),
    productType: stringValue(product.product_type, product.category),
    inStock,
    sponsored: booleanValue(product.sponsored) === true,
    size: extractMeasurement(title),
    ...reportedUnit,
    checkedAt,
    verification: "unverified",
  };
}

export function parseScrapingBeeProductDetail(
  value: unknown,
  options: ScrapingBeeSearchOptions & {
    checkedAt?: string;
    responseLocation?: WalmartResponseLocation;
  },
): WalmartProduct | null {
  const product = asRecord(value);
  if (!product) return null;
  const priceRecord = asRecord(product.price);
  const specifications = asRecord(product.specifications);
  const title = stringValue(product.title);
  const productId = identifierValue(
    product.product_id,
    product.id,
    product.item_id,
    product.us_item_id,
  );
  const itemId = identifierValue(product.us_item_id, product.item_id, productId);
  if (!title || !productId || hasFinancingPriceDisplay(
    priceRecord?.display,
    priceRecord?.current_display,
    product.price_display,
  )) return null;
  const price = numberValue(priceRecord?.current, product.price);
  if (!price) return null;
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const seller = sellerFields(product);
  const sellerType = sellerTypeFor(product);
  const fulfillment = detailFulfillmentFor(product);
  const returnedStoreId = options.responseLocation?.storeId;
  const detailStoreMatched = returnedStoreId
    ? returnedStoreId === options.storeId
    : undefined;
  const sourceUrl = normalizedWalmartSourceUrl(
    stringValue(product.url, product.product_url, product.canonical_url),
  );
  const link = resolveWalmartLink(title, sourceUrl, [itemId, productId]);
  const reportedUnit = reportedUnitFields(product);
  const originalPrice = numberValue(
    priceRecord?.original,
    product.price_strikethrough,
    product.original_price,
  );
  const isSale = Boolean(originalPrice && originalPrice > price);
  const shipping = asRecord(product.shipping);
  const shippingPrice = nonNegativeNumberValue(shipping?.price);
  const priceCents = Math.round(price * 100);
  const priceProvenance: WalmartPriceProvenance = {
    priceSource: "product_detail",
    priceScope: detailStoreMatched === true ? "exact_store" : undefined,
    productDetailPriceCents: priceCents,
    regularPriceCents: originalPrice ? Math.round(originalPrice * 100) : undefined,
    salePriceCents: isSale ? priceCents : undefined,
    shippingPriceCents: shippingPrice === undefined
      ? undefined
      : Math.round(shippingPrice * 100),
    requestedStoreId: options.storeId,
    detailStoreId: returnedStoreId,
    detailLocation: options.responseLocation
      ? mergedLocation(options, options.responseLocation)
      : undefined,
    detailStoreMatched,
    fulfillment,
    sellerType,
    localPriceEligible: false,
    localPriceVerified: false,
    checkedAt,
  };
  const images = Array.isArray(product.images) ? product.images : [];
  return {
    id: productId,
    productId,
    itemId,
    upc: identifierValue(product.upc, specifications?.upc, specifications?.UPC),
    title,
    price,
    priceCents,
    priceProvenance,
    ...link,
    dataSource: "scrapingbee",
    thumbnail: stringValue(product.image, images[0]),
    seller: seller.name,
    brand: stringValue(product.brand, specifications?.brand, specifications?.Brand),
    productType: stringValue(
      product.product_type,
      product.category,
      specifications?.product_type,
      specifications?.category,
    ),
    inStock: inStockFor(product),
    sponsored: false,
    size: extractMeasurement(title),
    ...reportedUnit,
    checkedAt,
    verification: "unverified",
  };
}

function validateSearch(query: string, options: ScrapingBeeSearchOptions) {
  if (!query || query.length > 160) {
    throw new WalmartSearchError("Enter one Walmart item to search.", "configuration");
  }
  if (!/^\d{1,8}$/.test(options.storeId)) {
    throw new WalmartSearchError("Choose a valid Walmart pickup store.", "configuration");
  }
}

function domainParameter(domain: ScrapingBeeLocation["domain"]) {
  return domain === "ca" ? "ca" : "com";
}

export async function searchScrapingBeeWalmart(
  queryValue: string,
  optionsValue: ScrapingBeeSearchOptions,
  requestSignal?: AbortSignal,
): Promise<SearchResult> {
  const query = normalizedQuery(queryValue);
  const options = normalizeOptions(optionsValue);
  if (!process.env.SCRAPINGBEE_API_KEY?.trim()) {
    return {
      products: getMockWalmartResults(query),
      suggestionSignals: [],
      mode: "demo",
      diagnostics: diagnostics(false, false, false),
    };
  }
  validateSearch(query, options);
  if (requestSignal?.aborted) throw consumerAbortError();
  const cacheKey = [
    CACHE_VERSION,
    options.domain,
    options.storeId,
    options.zip ?? "",
    options.state ?? "",
    query.toLocaleLowerCase("en-US"),
  ].join("::");
  pruneCache(searchCache);
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      products: cached.products.map(cloneProduct),
      suggestionSignals: [],
      mode: "live",
      diagnostics: diagnostics(true, false, false),
    };
  }
  const existing = searchInFlight.get(cacheKey);
  if (existing) {
    const products = await waitForSharedRequest(existing, requestSignal);
    return {
      products: products.map(cloneProduct),
      suggestionSignals: [],
      mode: "live",
      diagnostics: diagnostics(true, true, false),
    };
  }
  const liveRequest = (async () => {
    const parameters = new URLSearchParams({
      query,
      store_id: options.storeId,
      domain: domainParameter(options.domain),
      sort_by: "best_match",
      start_page: "1",
      light_request: "true",
      device: "desktop",
    });
    if (options.zip) parameters.set("delivery_zip", options.zip);
    const payload = asRecord(await fetchScrapingBee("/search", parameters));
    if (!payload || !Array.isArray(payload.products)) {
      throw new WalmartSearchError(
        "ScrapingBee returned malformed Walmart search data.",
        "malformed",
      );
    }
    const checkedAt = new Date().toISOString();
    const location = responseLocation(payload.location);
    return payload.products
      .map((product) => parseScrapingBeeSearchProduct(product, {
        ...options,
        checkedAt,
        responseLocation: location,
      }))
      .filter((product): product is WalmartProduct => Boolean(product));
  })().then((products) => {
    searchCache.set(cacheKey, {
      products: products.map(cloneProduct),
      expiresAt: Date.now() + siteConfig.cacheTtlMs,
    });
    return products;
  }).finally(() => {
    searchInFlight.delete(cacheKey);
  });
  searchInFlight.set(cacheKey, liveRequest);
  const products = await waitForSharedRequest(liveRequest, requestSignal);
  return {
    products: products.map(cloneProduct),
    suggestionSignals: [],
    mode: "live",
    diagnostics: diagnostics(false, false, true),
  };
}

export async function getScrapingBeeWalmartProductDetails(
  productIdValue: string,
  optionsValue: ScrapingBeeSearchOptions,
  requestSignal?: AbortSignal,
): Promise<DetailResult> {
  const productId = productIdValue.trim();
  const options = normalizeOptions(optionsValue);
  if (!process.env.SCRAPINGBEE_API_KEY?.trim()) {
    return {
      product: getMockWalmartProductDetail(productId),
      mode: "demo",
      diagnostics: diagnostics(false, false, false),
    };
  }
  if (!productId || !/^\d{1,8}$/.test(options.storeId)) {
    return {
      product: null,
      mode: "live",
      diagnostics: diagnostics(false, false, false),
    };
  }
  if (requestSignal?.aborted) throw consumerAbortError();
  const cacheKey = [
    CACHE_VERSION,
    options.domain,
    options.storeId,
    options.zip ?? "",
    options.state ?? "",
    productId,
  ].join("::");
  pruneCache(detailCache);
  const cached = detailCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      product: cached.product ? cloneProduct(cached.product) : null,
      mode: "live",
      diagnostics: diagnostics(true, false, false),
    };
  }
  const existing = detailInFlight.get(cacheKey);
  if (existing) {
    const product = await waitForSharedRequest(existing, requestSignal);
    return {
      product: product ? cloneProduct(product) : null,
      mode: "live",
      diagnostics: diagnostics(true, true, false),
    };
  }
  const liveRequest = (async () => {
    const parameters = new URLSearchParams({
      product_id: productId,
      domain: domainParameter(options.domain),
      light_request: "true",
      device: "desktop",
    });
    const payload = await fetchScrapingBee("/product", parameters);
    if (payload === null) return null;
    const record = asRecord(payload);
    if (!record) {
      throw new WalmartSearchError(
        "ScrapingBee returned malformed Walmart product data.",
        "malformed",
      );
    }
    const location = responseLocation(record.location);
    const parsed = parseScrapingBeeProductDetail(record, {
      ...options,
      checkedAt: new Date().toISOString(),
      responseLocation: location,
    });
    if (!parsed) {
      throw new WalmartSearchError(
        "ScrapingBee returned malformed Walmart product data.",
        "malformed",
      );
    }
    return parsed;
  })().then((product) => {
    detailCache.set(cacheKey, {
      product: product ? cloneProduct(product) : null,
      expiresAt: Date.now() + siteConfig.detailCacheTtlMs,
    });
    return product;
  }).finally(() => {
    detailInFlight.delete(cacheKey);
  });
  detailInFlight.set(cacheKey, liveRequest);
  const product = await waitForSharedRequest(liveRequest, requestSignal);
  return {
    product: product ? cloneProduct(product) : null,
    mode: "live",
    diagnostics: diagnostics(false, false, true),
  };
}

/** Route-compatible aliases keep the progressive search pipeline unchanged. */
export function searchWalmart(
  query: string,
  storeId: string,
  requestSignal?: AbortSignal,
  location: ScrapingBeeLocation = {},
) {
  return searchScrapingBeeWalmart(query, { storeId, ...location }, requestSignal);
}

export function getWalmartProductDetails(
  productId: string,
  storeId: string,
  requestSignal?: AbortSignal,
  location: ScrapingBeeLocation = {},
) {
  return getScrapingBeeWalmartProductDetails(
    productId,
    { storeId, ...location },
    requestSignal,
  );
}
import "./server-only-guard";
