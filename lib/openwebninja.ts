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

export interface OpenWebNinjaLocation {
  zip?: string;
  state?: string;
  domain?: "us" | "ca";
}

export interface OpenWebNinjaSearchOptions extends OpenWebNinjaLocation {
  storeId: string;
}

export interface OpenWebNinjaCallDiagnostics {
  cacheHit: boolean;
  deduplicated: boolean;
  apiCall: boolean;
  /** Legacy diagnostics field retained while routes migrate providers. */
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
  diagnostics: OpenWebNinjaCallDiagnostics;
};

type DetailResult = {
  product: WalmartProduct | null;
  mode: "live" | "demo";
  diagnostics: OpenWebNinjaCallDiagnostics;
};

type SearchCacheEntry = {
  products: WalmartProduct[];
  expiresAt: number;
};

type DetailCacheEntry = {
  product: WalmartProduct | null;
  expiresAt: number;
};

type RateLimiterState = {
  tail: Promise<void>;
  nextStartAt: number;
};

declare global {
  var openWebNinjaSearchCache: Map<string, SearchCacheEntry> | undefined;
  var openWebNinjaDetailCache: Map<string, DetailCacheEntry> | undefined;
  var openWebNinjaSearchInFlight: Map<string, Promise<WalmartProduct[]>> | undefined;
  var openWebNinjaDetailInFlight: Map<string, Promise<WalmartProduct | null>> | undefined;
  var openWebNinjaRateLimiter: RateLimiterState | undefined;
}

const searchCache = globalThis.openWebNinjaSearchCache
  ?? new Map<string, SearchCacheEntry>();
const detailCache = globalThis.openWebNinjaDetailCache
  ?? new Map<string, DetailCacheEntry>();
const searchInFlight = globalThis.openWebNinjaSearchInFlight
  ?? new Map<string, Promise<WalmartProduct[]>>();
const detailInFlight = globalThis.openWebNinjaDetailInFlight
  ?? new Map<string, Promise<WalmartProduct | null>>();
const rateLimiter = globalThis.openWebNinjaRateLimiter ?? {
  tail: Promise.resolve(),
  nextStartAt: 0,
};

globalThis.openWebNinjaSearchCache = searchCache;
globalThis.openWebNinjaDetailCache = detailCache;
globalThis.openWebNinjaSearchInFlight = searchInFlight;
globalThis.openWebNinjaDetailInFlight = detailInFlight;
globalThis.openWebNinjaRateLimiter = rateLimiter;

const API_BASE = "https://api.openwebninja.com/real-time-walmart-data";
const CACHE_VERSION = "openwebninja-localized-search-v2";
const REQUEST_TIMEOUT_MS = 8_000;
const MINIMUM_REQUEST_START_INTERVAL_MS = 500;
const WALMART_SELLER_ID = "F55CDC31AB754BB68FE0B39041159D63";

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

export { WalmartSearchError as OpenWebNinjaError };

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

function sellerTypeFor(product: UnknownRecord): WalmartSellerType {
  const seller = stringValue(
    product.seller,
    product.seller_name,
    product.seller_display_name,
  );
  const sellerId = identifierValue(product.seller_id);
  const sellerType = stringValue(product.seller_type);
  const fulfillmentType = stringValue(product.fulfillment_type);
  if (
    sellerId?.toUpperCase() === WALMART_SELLER_ID
    || Boolean(seller && /^walmart(?:\.com)?$/i.test(seller.trim()))
    || /^(?:internal|first_party)$/i.test(sellerType ?? "")
  ) return "walmart";
  if (
    seller
    || sellerId
    || /external|third[_ -]?party/i.test(sellerType ?? "")
    || /marketplace/i.test(fulfillmentType ?? "")
  ) return "marketplace";
  return "unknown";
}

function fulfillmentFor(product: UnknownRecord) {
  const fulfillment: WalmartFulfillmentType[] = [];
  const add = (value: WalmartFulfillmentType) => {
    if (!fulfillment.includes(value)) fulfillment.push(value);
  };
  if (booleanValue(product.pickup) === true || booleanValue(product.pickup_available) === true) {
    add("pickup");
  }
  if (booleanValue(product.delivery_from_store) === true) add("delivery");
  if (booleanValue(product.shipping) === true) add("shipping");
  const offer = asRecord(product.primary_offer);
  const offerType = stringValue(offer?.offer_type, product.offer_type);
  if (/store/i.test(offerType ?? "")) {
    add("in_store");
    add("pickup");
  }
  if (/online|shipping/i.test(offerType ?? "")) add("shipping");
  return fulfillment;
}

function inStockFor(product: UnknownRecord) {
  const outOfStock = booleanValue(product.out_of_stock);
  if (outOfStock !== undefined) return !outOfStock;
  const explicit = booleanValue(product.in_stock);
  if (explicit !== undefined) return explicit;
  const availability = stringValue(product.availability, product.availability_status);
  return availability ? /\bin[ -]?stock\b|available/i.test(availability) : false;
}

function searchLocationFor(options: OpenWebNinjaSearchOptions): WalmartResponseLocation {
  return {
    postalCode: options.zip?.trim() || undefined,
    provinceCode: options.state?.trim().toUpperCase() || undefined,
    country: (options.domain ?? "us") === "us" ? "US" : "CA",
  };
}

function diagnostics(
  cacheHit: boolean,
  deduplicated: boolean,
  apiCall: boolean,
): OpenWebNinjaCallDiagnostics {
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

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Reserve only the upstream request start time. The request itself is not held
 * in the queue, so two slow Walmart requests may remain in flight together.
 */
async function waitForRateSlot() {
  const previous = rateLimiter.tail;
  let release: () => void = () => {};
  rateLimiter.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const waitMs = Math.max(0, rateLimiter.nextStartAt - Date.now());
    if (waitMs > 0) await delay(waitMs);
    rateLimiter.nextStartAt = Date.now() + MINIMUM_REQUEST_START_INTERVAL_MS;
  } finally {
    release();
  }
}

function consumerAbortError() {
  return new DOMException("The Cartiva request was cancelled.", "AbortError");
}

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

async function fetchOpenWebNinja(path: "/search" | "/product-details", parameters: URLSearchParams) {
  const apiKey = process.env.OPENWEBNINJA_API_KEY?.trim();
  if (!apiKey) {
    throw new WalmartSearchError(
      "OpenWeb Ninja is not configured on the Cartiva server.",
      "configuration",
    );
  }
  await waitForRateSlot();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}?${parameters}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "x-api-key": apiKey,
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new WalmartSearchError(
        "OpenWeb Ninja authentication failed. Check the server-side API key.",
        "authentication",
      );
    }
    if (response.status === 429) {
      throw new WalmartSearchError(
        "OpenWeb Ninja rate limit reached. Wait a moment and search again.",
        "rate_limit",
      );
    }
    if (response.status === 408 || response.status === 504) {
      throw new WalmartSearchError(
        "Walmart data took too long to respond. Please try again.",
        "timeout",
      );
    }
    if (response.status === 400 || response.status === 422) {
      throw new WalmartSearchError(
        "OpenWeb Ninja rejected the Walmart request parameters.",
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
        "OpenWeb Ninja returned malformed Walmart data.",
        "malformed",
      );
    }
  } catch (error) {
    if (error instanceof WalmartSearchError) throw error;
    if (controller.signal.aborted) {
      throw new WalmartSearchError("Walmart data request timed out. Please try again.", "timeout");
    }
    throw new WalmartSearchError("Walmart data is temporarily unavailable.", "api_error");
  } finally {
    clearTimeout(timeout);
  }
}

function reportedUnitFields(product: UnknownRecord) {
  const rawAmount = stringValue(product.price_per_unit_amount, product.price_per_unit);
  const explicitAmount = typeof product.price_per_unit_amount === "number"
    ? numberValue(product.price_per_unit_amount)
    : undefined;
  const rawNumeric = rawAmount?.match(/\d+(?:\.\d+)?/)?.[0];
  const numeric = explicitAmount ?? (rawNumeric ? Number(rawNumeric) : undefined);
  if (!numeric || !Number.isFinite(numeric)) return {};

  const basisText = `${stringValue(product.price_per_unit_type) ?? ""} ${rawAmount ?? ""}`
    .toLowerCase();
  const basis = normalizedUnitBasis(product.price_per_unit_type)
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

  const denominatorMatch = basisText.match(
    /(?:\/|\bper\s+)(\d+(?:\.\d+)?)\s*(?:fl\s*oz|fluid ounces?|oz|ounces?|lbs?|pounds?|ct|count|each|ea)\b/i,
  );
  const denominator = denominatorMatch ? Number(denominatorMatch[1]) : 1;
  const currencyDivisor = /\u00a2|\bcents?\b/i.test(rawAmount ?? "") ? 100 : 1;
  const unitPrice = Number(
    (numeric / currencyDivisor / Math.max(denominator, 1)).toFixed(6),
  );

  return { reportedUnitPrice: unitPrice, reportedUnitBasis: basis };
}

export function parseOpenWebNinjaSearchProduct(
  value: unknown,
  options: OpenWebNinjaSearchOptions & { checkedAt?: string },
): WalmartProduct | null {
  const product = asRecord(value);
  if (!product) return null;
  const title = stringValue(product.title);
  const productId = identifierValue(product.product_id);
  const itemId = identifierValue(product.us_item_id);
  const id = productId ?? itemId;
  const primaryOffer = asRecord(product.primary_offer);
  if (
    !title
    || !id
    || hasFinancingPriceDisplay(product.price_display, primaryOffer?.price_display)
  ) return null;
  const price = numberValue(product.price, primaryOffer?.offer_price);
  if (!price) return null;
  const priceCents = Math.round(price * 100);
  const sellerType = sellerTypeFor(product);
  const fulfillment = fulfillmentFor(product);
  const inStock = inStockFor(product);
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const sourceUrl = stringValue(product.url, product.product_url);
  const link = resolveWalmartLink(title, sourceUrl, [itemId, productId]);
  const reportedUnit = reportedUnitFields(product);
  const localPriceEligible = Boolean(
    inStock
    && sellerType === "walmart"
    && (fulfillment.includes("pickup")
      || fulfillment.includes("in_store")
      || fulfillment.includes("delivery"))
    && !(fulfillment.length === 1 && fulfillment[0] === "shipping"),
  );
  const priceProvenance: WalmartPriceProvenance = {
    priceSource: sellerType === "marketplace" ? "marketplace_search" : "walmart_search",
    priceScope: "localized",
    searchPriceCents: priceCents,
    regularPriceCents: numberValue(product.list_price)
      ? Math.round(numberValue(product.list_price)! * 100)
      : undefined,
    unitPriceCents: reportedUnit.reportedUnitPrice
      ? Math.round(reportedUnit.reportedUnitPrice * 100)
      : undefined,
    unitPrice: reportedUnit.reportedUnitPrice,
    requestedStoreId: options.storeId.trim(),
    searchLocation: searchLocationFor(options),
    // OpenWeb Ninja accepts store/ZIP localization but does not return proof
    // that the price belongs to that exact store.
    searchStoreMatched: undefined,
    fulfillment,
    sellerType,
    localPriceEligible,
    localPriceVerified: false,
    checkedAt,
  };
  return {
    id,
    productId,
    itemId,
    title,
    price,
    priceCents,
    priceProvenance,
    ...link,
    dataSource: "openwebninja",
    thumbnail: stringValue(product.thumbnail, product.image),
    seller: stringValue(product.seller, product.seller_name),
    brand: stringValue(product.brand),
    inStock,
    sponsored: booleanValue(product.sponsored) === true,
    size: extractMeasurement(title),
    ...reportedUnit,
    checkedAt,
    verification: "unverified",
  };
}

export function parseOpenWebNinjaProductDetail(
  value: unknown,
  options: OpenWebNinjaSearchOptions & { checkedAt?: string },
): WalmartProduct | null {
  const product = asRecord(value);
  if (!product) return null;
  const title = stringValue(product.title);
  const productId = identifierValue(product.product_id);
  const itemId = identifierValue(product.us_item_id);
  const id = productId ?? itemId;
  const primaryOffer = asRecord(product.primary_offer);
  if (
    !title
    || !id
    || hasFinancingPriceDisplay(product.price_display, primaryOffer?.price_display)
  ) return null;
  const price = numberValue(product.price, primaryOffer?.offer_price);
  if (!price) return null;
  const priceCents = Math.round(price * 100);
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const sellerType = sellerTypeFor(product);
  const fulfillment = fulfillmentFor(product);
  const sourceUrl = stringValue(product.url, product.product_url);
  const link = resolveWalmartLink(title, sourceUrl, [itemId, productId]);
  const reportedUnit = reportedUnitFields(product);
  const priceProvenance: WalmartPriceProvenance = {
    priceSource: "product_detail",
    productDetailPriceCents: priceCents,
    regularPriceCents: numberValue(product.list_price)
      ? Math.round(numberValue(product.list_price)! * 100)
      : undefined,
    requestedStoreId: options.storeId.trim(),
    detailStoreMatched: undefined,
    fulfillment,
    sellerType,
    localPriceEligible: false,
    localPriceVerified: false,
    checkedAt,
  };
  return {
    id,
    productId,
    itemId,
    upc: identifierValue(product.upc),
    title,
    price,
    priceCents,
    priceProvenance,
    ...link,
    dataSource: "openwebninja",
    thumbnail: stringValue(product.thumbnail, product.image),
    seller: stringValue(product.seller, product.seller_name),
    brand: stringValue(product.brand),
    productType: stringValue(product.type),
    inStock: inStockFor(product),
    sponsored: false,
    size: extractMeasurement(title),
    ...reportedUnit,
    checkedAt,
    verification: "unverified",
  };
}

function normalizeOptions(options: OpenWebNinjaSearchOptions): OpenWebNinjaSearchOptions {
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

function validateSearch(query: string, options: OpenWebNinjaSearchOptions) {
  if (!query || query.length > 160) {
    throw new WalmartSearchError("Enter one Walmart item to search.", "configuration");
  }
  if (!/^\d{1,8}$/.test(options.storeId)) {
    throw new WalmartSearchError("Choose a valid Walmart pickup store.", "configuration");
  }
}

export async function searchOpenWebNinjaWalmart(
  queryValue: string,
  optionsValue: OpenWebNinjaSearchOptions,
  requestSignal?: AbortSignal,
): Promise<SearchResult> {
  const query = normalizedQuery(queryValue);
  const options = normalizeOptions(optionsValue);
  const apiKey = process.env.OPENWEBNINJA_API_KEY?.trim();
  if (!apiKey) {
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
    const checkedAt = new Date().toISOString();
    const parameters = new URLSearchParams({
      query,
      page: "1",
      sort_by: "best_match",
      store_id: options.storeId,
      domain: options.domain ?? "us",
    });
    if (options.zip) parameters.set("zip", options.zip);
    if (options.state) parameters.set("state", options.state);
    const payload = asRecord(await fetchOpenWebNinja("/search", parameters));
    const data = asRecord(payload?.data);
    if (!payload || !data || !Array.isArray(data.products)) {
      throw new WalmartSearchError("OpenWeb Ninja returned malformed Walmart data.", "malformed");
    }
    return data.products
      .map((product) => parseOpenWebNinjaSearchProduct(product, { ...options, checkedAt }))
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

export async function getOpenWebNinjaWalmartProductDetails(
  productIdValue: string,
  optionsValue: OpenWebNinjaSearchOptions,
  requestSignal?: AbortSignal,
): Promise<DetailResult> {
  const productId = productIdValue.trim();
  const options = normalizeOptions(optionsValue);
  const apiKey = process.env.OPENWEBNINJA_API_KEY?.trim();
  if (!apiKey) {
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
      domain: options.domain ?? "us",
    });
    const payload = asRecord(await fetchOpenWebNinja("/product-details", parameters));
    if (!payload || !("data" in payload)) {
      throw new WalmartSearchError("OpenWeb Ninja returned malformed Walmart data.", "malformed");
    }
    if (payload.data === null) return null;
    return parseOpenWebNinjaProductDetail(payload.data, {
      ...options,
      checkedAt: new Date().toISOString(),
    });
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

/** Route-compatible aliases for a low-risk provider migration. */
export function searchWalmart(
  query: string,
  storeId: string,
  requestSignal?: AbortSignal,
  location: OpenWebNinjaLocation = {},
) {
  return searchOpenWebNinjaWalmart(query, { storeId, ...location }, requestSignal);
}

export function getWalmartProductDetails(
  productId: string,
  storeId: string,
  requestSignal?: AbortSignal,
  location: OpenWebNinjaLocation = {},
) {
  return getOpenWebNinjaWalmartProductDetails(productId, { storeId, ...location }, requestSignal);
}
import "./server-only-guard";
