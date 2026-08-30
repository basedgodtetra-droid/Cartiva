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
export interface SerpApiCallDiagnostics {
  cacheHit: boolean;
  deduplicated: boolean;
  apiCall: boolean;
  serpApiCacheUsed: boolean | null;
}

export interface WalmartSearchSuggestionSignal {
  text: string;
  source: "spelling" | "related" | "filter";
  score?: number;
  group?: string;
  itemCount?: number;
}

type LiveSearchPayload = {
  products: WalmartProduct[];
  suggestionSignals: WalmartSearchSuggestionSignal[];
  serpApiCacheUsed: boolean | null;
};
type LiveDetailPayload = { product: WalmartProduct | null; serpApiCacheUsed: boolean | null };
type SearchCacheEntry = LiveSearchPayload & { expiresAt: number };
type DetailCacheEntry = LiveDetailPayload & { expiresAt: number };

declare global {
  var walmartSearchCache: Map<string, SearchCacheEntry> | undefined;
  var walmartDetailCache: Map<string, DetailCacheEntry> | undefined;
  var walmartSearchInFlight: Map<string, Promise<LiveSearchPayload>> | undefined;
  var walmartDetailInFlight: Map<string, Promise<LiveDetailPayload>> | undefined;
}

const searchCache = globalThis.walmartSearchCache ?? new Map<string, SearchCacheEntry>();
const detailCache = globalThis.walmartDetailCache ?? new Map<string, DetailCacheEntry>();
const searchInFlight = globalThis.walmartSearchInFlight ?? new Map<string, Promise<LiveSearchPayload>>();
const detailInFlight = globalThis.walmartDetailInFlight ?? new Map<string, Promise<LiveDetailPayload>>();
globalThis.walmartSearchCache = searchCache;
globalThis.walmartDetailCache = detailCache;
globalThis.walmartSearchInFlight = searchInFlight;
globalThis.walmartDetailInFlight = detailInFlight;

// Location verification no longer trusts search_parameters.store_id. Prefix
// keys so hot-reloaded development servers cannot reuse an entry produced by
// the older request-echo behavior.
const LOCATION_TRUST_CACHE_VERSION = "observed-location-catalog-signals-v5";
const MAX_WALMART_SUGGESTION_SIGNALS = 48;
const MAX_WALMART_SUGGESTION_CANDIDATES = 256;
const MAX_WALMART_FILTER_DEPTH = 5;
const MAX_WALMART_SUGGESTION_TEXT_LENGTH = 160;

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
  }
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function errorCodeFor(message: string): WalmartSearchError["code"] {
  if (/api key|unauthorized|authentication|invalid key/i.test(message)) return "authentication";
  if (/rate|limit|quota/i.test(message)) return "rate_limit";
  return "api_error";
}

function isNoResultsMessage(message: string) {
  return /product\s+(?:has\s+not|could\s+not|couldn't|was\s+not)\s+(?:be\s+)?found|product\s+not\s+found|hasn't\s+returned\s+any\s+results|no\s+(?:product\s+)?results/i
    .test(message);
}

function serpApiCacheWasUsed(payload: unknown): boolean | null {
  const data = asRecord(payload);
  const metadata = asRecord(data?.search_metadata);
  const explicit = [metadata?.cached, metadata?.cache_used, metadata?.is_cached]
    .find((value) => typeof value === "boolean");
  if (typeof explicit === "boolean") return explicit;
  const status = stringValue(metadata?.status, metadata?.source, metadata?.cache_status);
  return status ? /cache/i.test(status) : null;
}

function stringValue(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function numberValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}

function identifierValue(...values: unknown[]) {
  const value = values.find((candidate) =>
    (typeof candidate === "string" && candidate.trim().length > 0) ||
    (typeof candidate === "number" && Number.isFinite(candidate)),
  );
  return value === undefined ? undefined : String(value).trim();
}

function decodeCatalogText(value: string) {
  return value.replace(/&(?:amp|quot|#39|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const named: Record<string, string> = {
      "&amp;": "&",
      "&quot;": "\"",
      "&#39;": "'",
      "&lt;": "<",
      "&gt;": ">",
      "&nbsp;": " ",
    };
    const normalized = entity.toLowerCase();
    if (named[normalized] !== undefined) return named[normalized];
    const numeric = normalized.startsWith("&#x")
      ? Number.parseInt(normalized.slice(3, -1), 16)
      : Number.parseInt(normalized.slice(2, -1), 10);
    return Number.isInteger(numeric) && numeric > 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : entity;
  });
}

function suggestionText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = decodeCatalogText(value.normalize("NFKC"))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized && normalized.length <= MAX_WALMART_SUGGESTION_TEXT_LENGTH
    ? normalized
    : undefined;
}

function suggestionNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/,/g, "");
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function extractWalmartSearchSuggestionSignals(payload: unknown) {
  const data = asRecord(payload);
  if (!data) return [];

  const signals: WalmartSearchSuggestionSignal[] = [];
  const seenText = new Set<string>();
  const addSignal = (signal: WalmartSearchSuggestionSignal) => {
    const text = suggestionText(signal.text);
    if (!text) return;
    const key = text.toLocaleLowerCase("en-US");
    if (seenText.has(key) || signals.length >= MAX_WALMART_SUGGESTION_SIGNALS) return;
    seenText.add(key);
    signals.push({ ...signal, text });
  };

  const searchInformation = asRecord(data.search_information);
  const spellingFix = suggestionText(searchInformation?.spelling_fix);
  if (spellingFix) addSignal({ text: spellingFix, source: "spelling" });

  const relatedQueries = Array.isArray(data.related_queries) ? data.related_queries : [];
  for (const value of relatedQueries.slice(0, MAX_WALMART_SUGGESTION_CANDIDATES)) {
    if (signals.length >= MAX_WALMART_SUGGESTION_SIGNALS) break;
    const related = asRecord(value);
    const text = suggestionText(related?.suggested);
    if (!text) continue;
    addSignal({
      text,
      source: "related",
      score: suggestionNumber(related?.score),
    });
  }

  const visitedFilterValues = new Set<UnknownRecord>();
  let inspectedFilterValueCount = 0;
  const visitFilterValues = (values: unknown, group: string | undefined, depth: number) => {
    if (
      !Array.isArray(values)
      || depth >= MAX_WALMART_FILTER_DEPTH
      || signals.length >= MAX_WALMART_SUGGESTION_SIGNALS
    ) return;

    for (const value of values) {
      if (
        signals.length >= MAX_WALMART_SUGGESTION_SIGNALS
        || inspectedFilterValueCount >= MAX_WALMART_SUGGESTION_CANDIDATES
      ) return;
      inspectedFilterValueCount += 1;
      const filterValue = asRecord(value);
      if (!filterValue || visitedFilterValues.has(filterValue)) continue;
      visitedFilterValues.add(filterValue);

      const text = suggestionText(filterValue.name);
      const rawItemCount = suggestionNumber(filterValue.item_count);
      if (text) {
        addSignal({
          text,
          source: "filter",
          group,
          itemCount: rawItemCount === undefined ? undefined : Math.floor(rawItemCount),
        });
      }
      visitFilterValues(filterValue.values, group, depth + 1);
    }
  };

  const filters = Array.isArray(data.filters) ? data.filters : [];
  for (const value of filters.slice(0, MAX_WALMART_SUGGESTION_CANDIDATES)) {
    if (signals.length >= MAX_WALMART_SUGGESTION_SIGNALS) break;
    const filter = asRecord(value);
    if (!filter) continue;
    visitFilterValues(filter.values, suggestionText(filter.name), 0);
  }

  return signals;
}

function normalizedLocationText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= maximumLength ? normalized : undefined;
}

export function parseSerpApiResponseLocation(value: unknown): WalmartResponseLocation | undefined {
  const location = asRecord(value);
  if (!location) return undefined;

  const rawStoreId = identifierValue(location.store_id, location.storeId);
  const rawPostalCode = normalizedLocationText(
    stringValue(location.postal_code, location.postalCode),
    10,
  );
  const storeId = rawStoreId && /^\d{1,8}$/.test(rawStoreId) ? rawStoreId : undefined;
  const postalCode = rawPostalCode?.match(/^(\d{5})(?:-\d{4})?$/)?.[1];
  const city = normalizedLocationText(location.city, 100);
  const provinceCode = normalizedLocationText(
    stringValue(location.province_code, location.provinceCode, location.state_code),
    20,
  );
  const country = normalizedLocationText(
    stringValue(location.country, location.country_code),
    40,
  );

  if (!storeId && !postalCode && !city && !provinceCode && !country) return undefined;
  return { storeId, postalCode, city, provinceCode, country };
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function cents(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.round(value * 100);
}

function optionAvailable(value: unknown) {
  if (typeof value === "boolean") return value;
  return booleanValue(asRecord(value)?.available);
}

function sellerTypeFor(seller?: string): WalmartSellerType {
  if (!seller) return "unknown";
  return /^(?:walmart(?:\.com)?|wal-mart)$/i.test(seller.trim())
    ? "walmart"
    : "marketplace";
}

function fulfillmentTypes(value: UnknownRecord): WalmartFulfillmentType[] {
  const types = new Set<WalmartFulfillmentType>();
  const offerType = stringValue(value.offer_type, value.fulfillment_type) ?? "";
  if (/store/i.test(offerType)) types.add("in_store");
  if (optionAvailable(value.pickup_option) === true || optionAvailable(value.pickup) === true) {
    types.add("pickup");
  }
  if (optionAvailable(value.delivery_option) === true || optionAvailable(value.delivery) === true) {
    types.add("delivery");
  }
  if (
    optionAvailable(value.shipping_option) === true
    || optionAvailable(value.shipping) === true
    || booleanValue(value.two_day_shipping) === true
    || booleanValue(value.free_shipping) === true
  ) {
    types.add("shipping");
  }
  return [...types];
}

function parseReportedUnitPrice(value: unknown) {
  const record = asRecord(value);
  const raw = stringValue(record?.amount, record?.price, typeof value === "string" ? value : undefined);
  const explicitNumber = numberValue(
    typeof record?.amount === "number" ? record.amount : undefined,
    typeof record?.price === "number" ? record.price : undefined,
    typeof value === "number" ? value : undefined,
  );
  if (!raw && explicitNumber === undefined) return {};

  // Do not feed a compound value such as "$5.16/100 ct" through the generic
  // numeric parser. Stripping its punctuation would join the numerator and
  // denominator into 5.16100. Walmart commonly reports count items per 100,
  // so preserve the first number as the price and normalize the denominator.
  const rawNumeric = raw?.match(/\d+(?:\.\d+)?/)?.[0];
  const numeric = explicitNumber ?? (rawNumeric ? Number(rawNumeric) : undefined);
  if (numeric === undefined) return {};
  const basisText = `${stringValue(record?.unit) ?? ""} ${raw ?? ""}`.toLowerCase();
  const basis = /fl\s*oz|fluid ounce/.test(basisText)
    ? "fl oz"
    : /(?:\/|per\s*)oz|\bounce\b/.test(basisText)
      ? "oz"
      : /(?:\/|per\s*)lb|pound/.test(basisText)
        ? "lb"
        : /each|\/ea|\bct\b|\bcount\b/.test(basisText)
          ? "each"
          : undefined;

  // A bare Product API number has no comparable basis and must not be used as
  // proof of a package-price conflict. Search results usually include the
  // useful unit text (for example "$2.34/100 ct" or "35.2 ¢/oz").
  if (!basis) return {};

  const denominatorMatch = basisText.match(
    /(?:\/|\bper\s+)(\d+(?:\.\d+)?)\s*(?:fl\s*oz|fluid ounces?|oz|ounces?|lbs?|pounds?|ct|count|each|ea)\b/i,
  );
  const denominator = denominatorMatch ? Number(denominatorMatch[1]) : 1;
  const currencyDivisor = /\u00a2|\bcents?\b/i.test(raw ?? "") ? 100 : 1;
  const unitPrice = Number(
    (numeric / currencyDivisor / Math.max(denominator, 1)).toFixed(6),
  );

  return {
    reportedUnitPrice: unitPrice,
    reportedUnitBasis: basis as WalmartProduct["reportedUnitBasis"],
  };
}

interface SearchParseContext {
  requestedStoreId?: string;
  responseLocation?: WalmartResponseLocation;
  checkedAt?: string;
}

export function parseSerpApiSearchProduct(
  value: unknown,
  index: number,
  context: SearchParseContext = {},
): WalmartProduct | null {
  const item = asRecord(value);
  if (!item) return null;

  const offer = asRecord(item.primary_offer) ?? asRecord(item.offer);
  const sellerRecord = asRecord(item.seller);
  const rawTitle = stringValue(item.title, item.name, item.product_title);
  const title = rawTitle ? decodeCatalogText(rawTitle) : undefined;
  const price = numberValue(
    offer?.offer_price,
    offer?.price,
    item.sale_price,
    item.current_price,
    item.price,
    item.extracted_price,
  );
  const regularPrice = numberValue(
    asRecord(offer?.was_price)?.price,
    offer?.was_price,
    item.regular_price,
    item.was_price,
  );
  const explicitSalePrice = numberValue(item.sale_price, offer?.sale_price);
  const salePrice = explicitSalePrice
    ?? (regularPrice !== undefined && price !== undefined && price < regularPrice
      ? price
      : undefined);
  const shippingPrice = numberValue(item.shipping_price, offer?.shipping_price);
  const productId = identifierValue(item.product_id);
  const itemId = identifierValue(item.us_item_id, item.item_id);
  const upc = identifierValue(item.upc, item.upc_code, item.gtin);
  const id = productId ?? itemId ?? upc ?? `result-${index}`;
  const sourceUrl = stringValue(item.product_page_url, item.link, item.url);
  if (!title || price === undefined) return null;
  const resolvedLink = resolveWalmartLink(title, sourceUrl, [productId, itemId, upc]);

  const availability = stringValue(item.availability, offer?.availability) ?? "";
  const seller = stringValue(
    item.seller_name,
    sellerRecord?.name,
    offer?.seller_name,
    typeof item.seller === "string" ? item.seller : undefined,
  );
  const sellerType = sellerTypeFor(seller);
  const requestedStoreId = context.requestedStoreId?.trim() || undefined;
  const responseStoreId = context.responseLocation?.storeId;
  const searchStoreMatched = Boolean(
    requestedStoreId
    && responseStoreId
    && requestedStoreId === responseStoreId,
  );
  const fulfillment = fulfillmentTypes(item);
  const outOfStock =
    booleanValue(item.out_of_stock) === true ||
    booleanValue(offer?.out_of_stock) === true ||
    /out of stock|unavailable/i.test(availability);

  const reportedUnit = parseReportedUnitPrice(item.price_per_unit);
  const localPriceEligible = price > 0
    && searchStoreMatched
    && sellerType === "walmart"
    && !outOfStock
    && !(fulfillment.length === 1 && fulfillment[0] === "shipping");
  const priceProvenance: WalmartPriceProvenance = {
    priceSource: sellerType === "marketplace"
      ? "marketplace_search"
      : searchStoreMatched
        ? salePrice !== undefined
          ? "local_store_sale"
          : "local_store_search"
        : "walmart_search",
    searchPriceCents: cents(price),
    salePriceCents: cents(salePrice),
    regularPriceCents: cents(regularPrice),
    shippingPriceCents: cents(shippingPrice),
    unitPriceCents: cents(reportedUnit.reportedUnitPrice),
    unitPrice: reportedUnit.reportedUnitPrice,
    requestedStoreId,
    searchStoreId: responseStoreId,
    searchLocation: context.responseLocation,
    searchStoreMatched,
    fulfillment,
    sellerType,
    localPriceEligible,
    localPriceVerified: false,
    checkedAt: context.checkedAt,
  };

  return {
    id,
    productId,
    itemId,
    upc,
    title,
    price,
    priceCents: cents(price),
    priceProvenance,
    ...resolvedLink,
    dataSource: "serpapi",
    thumbnail: stringValue(item.thumbnail, item.image, item.product_image),
    seller,
    brand: stringValue(item.brand, item.brand_name),
    productType: stringValue(item.product_type, item.productType),
    inStock: !outOfStock,
    sponsored:
      booleanValue(item.sponsored) === true ||
      booleanValue(item.is_sponsored) === true ||
      /sponsored/i.test(String(item.badge ?? "")),
    size: extractMeasurement(
      `${title} ${stringValue(item.product_size, item.size, item.variant) ?? ""}`,
    ),
    ...reportedUnit,
    checkedAt: context.checkedAt,
    verification: "unverified",
  };
}

function extractSearchProducts(payload: unknown, requestedStoreId: string, checkedAt: string) {
  const data = asRecord(payload);
  if (!data) throw new WalmartSearchError("SerpApi returned malformed data.", "malformed");
  const error = stringValue(data.error);
  if (error) {
    if (isNoResultsMessage(error)) return [];
    throw new WalmartSearchError(error, errorCodeFor(error));
  }

  const searchInformation = asRecord(data.search_information);
  const responseLocation = parseSerpApiResponseLocation(searchInformation?.location);
  const rawResults = [data.organic_results, data.products, data.shopping_results].find(Array.isArray);
  if (!Array.isArray(rawResults)) return [];
  return rawResults
    .map((value, index) => parseSerpApiSearchProduct(value, index, {
      requestedStoreId,
      responseLocation,
      checkedAt,
    }))
    .filter((product): product is WalmartProduct => product !== null);
}

function specificationEntries(product: UnknownRecord) {
  const highlights = Array.isArray(product.specification_highlights)
    ? product.specification_highlights
    : [];
  return highlights.flatMap((value) => {
    const item = asRecord(value);
    const name = stringValue(item?.display_name, item?.key);
    const specificationValue = stringValue(item?.value);
    return name && specificationValue ? [{ name, value: specificationValue }] : [];
  });
}

function specificationValue(product: UnknownRecord, name: RegExp) {
  for (const entry of specificationEntries(product)) {
    if (name.test(entry.name)) return entry.value;
  }
  return undefined;
}

function measurementFromSpecification(name: string, value: string) {
  const measurement = extractMeasurement(value);
  if (measurement) return measurement;

  // Some Walmart specifications put a bare number in a count-labelled field.
  // Keep that value isolated from neighboring specifications so a weight in a
  // different row can never be interpreted as the size of each counted item.
  if (/\b(?:count|quantity|number of (?:items|pieces))\b/i.test(name)) {
    const count = value.match(/^\s*(\d+(?:\.\d+)?)\s*$/)?.[1];
    if (count) return extractMeasurement(`${count} count`);
  }
  return undefined;
}

function productDetailMeasurement(product: UnknownRecord, title: string) {
  // The retailer title describes the sellable package and is safer than a
  // concatenation of unrelated catalog rows such as shipping weight followed
  // by "Net content statement 12 Count".
  const titleMeasurement = extractMeasurement(title);
  if (titleMeasurement) return titleMeasurement;

  const directValues = [
    stringValue(product.net_content_statement),
    stringValue(product.net_content),
    stringValue(product.product_size),
    stringValue(product.package_size),
    typeof product.size === "string" ? product.size : undefined,
  ].filter((value): value is string => Boolean(value));
  for (const value of directValues) {
    const measurement = extractMeasurement(value);
    if (measurement) return measurement;
  }

  const specifications = specificationEntries(product);
  const preferredNames = [
    /^net content(?: statement)?$/i,
    /^(?:egg )?count$/i,
    /^(?:package )?quantity$/i,
    /^(?:product |package )?size$/i,
    /^(?:net |product |package )?(?:weight|volume)$/i,
  ];
  for (const pattern of preferredNames) {
    for (const entry of specifications) {
      if (!pattern.test(entry.name)) continue;
      const measurement = measurementFromSpecification(entry.name, entry.value);
      if (measurement) return measurement;
    }
  }
  return undefined;
}

interface DetailParseContext {
  requestedStoreId?: string;
  checkedAt?: string;
}

export function parseSerpApiProductDetail(
  payload: unknown,
  context: DetailParseContext = {},
): WalmartProduct | null {
  const data = asRecord(payload);
  if (!data) throw new WalmartSearchError("SerpApi returned malformed product details.", "malformed");
  const error = stringValue(data.error);
  if (error) {
    if (isNoResultsMessage(error)) return null;
    if (/product could not be found|product not found|hasn['’]?t returned any results|no (?:product )?results/i.test(error)) {
      return null;
    }
    throw new WalmartSearchError(error, errorCodeFor(error));
  }

  const product = asRecord(data.product_result);
  if (!product) return null;
  const priceMap = asRecord(product.price_map);
  const rawTitle = stringValue(product.title);
  const title = rawTitle ? decodeCatalogText(rawTitle) : undefined;
  const price = numberValue(priceMap?.price);
  const regularPrice = numberValue(
    asRecord(priceMap?.was_price)?.price,
    priceMap?.was_price,
    priceMap?.regular_price,
  );
  const salePrice = regularPrice !== undefined && price !== undefined && price < regularPrice
    ? price
    : undefined;
  const productId = identifierValue(product.product_id);
  const itemId = identifierValue(product.us_item_id, product.item_id);
  const upc = identifierValue(product.upc, product.upc_code, product.gtin);
  const sourceUrl = stringValue(product.product_page_url, product.link, product.url);
  if (!title || price === undefined) return null;
  const resolvedLink = resolveWalmartLink(title, sourceUrl, [productId, itemId, upc]);

  const images = Array.isArray(product.images) ? product.images : [];
  const offers = Array.isArray(product.offers) ? product.offers : [];
  const primaryOffer = asRecord(offers[0]);
  const brand = specificationValue(product, /^brand$/i)
    ?? stringValue(product.brand, product.manufacturer);
  const reportedUnit = parseReportedUnitPrice(priceMap?.unit_price);
  const seller = stringValue(
    product.seller_name,
    primaryOffer?.seller_name,
    primaryOffer?.seller_display_name,
  );
  const sellerType = sellerTypeFor(seller);
  const searchInformation = asRecord(data.search_information);
  const detailLocation = parseSerpApiResponseLocation(searchInformation?.location);
  const detailStoreId = detailLocation?.storeId;
  const requestedStoreId = context.requestedStoreId?.trim() || undefined;
  const detailStoreMatched = Boolean(
    requestedStoreId
    && detailStoreId
    && requestedStoreId === detailStoreId,
  );
  const fulfillment = fulfillmentTypes(product);
  const checkedAt = context.checkedAt ?? new Date().toISOString();

  return {
    id: productId ?? itemId ?? upc ?? "product-detail",
    productId,
    itemId,
    upc,
    title,
    price,
    priceCents: cents(price),
    priceProvenance: {
      priceSource: "product_detail",
      productDetailPriceCents: cents(price),
      salePriceCents: cents(salePrice),
      regularPriceCents: cents(regularPrice),
      shippingPriceCents: cents(numberValue(asRecord(product.shipping_option)?.price)),
      unitPriceCents: cents(reportedUnit.reportedUnitPrice),
      unitPrice: reportedUnit.reportedUnitPrice,
      requestedStoreId,
      detailStoreId,
      detailLocation,
      detailStoreMatched,
      fulfillment,
      sellerType,
      localPriceEligible: false,
      localPriceVerified: false,
      checkedAt,
    },
    ...resolvedLink,
    dataSource: "serpapi",
    thumbnail: stringValue(images[0]),
    seller,
    brand,
    productType: stringValue(product.product_type),
    inStock: booleanValue(product.in_stock) === true,
    sponsored: false,
    size: productDetailMeasurement(product, title),
    ...reportedUnit,
    checkedAt,
    verification: "unverified",
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

async function fetchSerpApi(parameters: URLSearchParams) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 9_000);

  try {
    const response = await fetch(`https://serpapi.com/search.json?${parameters}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (response.status === 429) {
      throw new WalmartSearchError(
        "SerpApi rate limit reached. Wait a moment and search again.",
        "rate_limit",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new WalmartSearchError(
        "SerpApi authentication failed. Check the server-side API key.",
        "authentication",
      );
    }
    if (!response.ok) {
      throw new WalmartSearchError(
        `Walmart request failed with status ${response.status}.`,
        "api_error",
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof WalmartSearchError) throw error;
    if (controller.signal.aborted) {
      throw new WalmartSearchError("Walmart request timed out. Please try again.", "timeout");
    }
    throw new WalmartSearchError(
      "Walmart data could not be reached.",
      "api_error",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function consumerAbortError() {
  return new DOMException("The Cartiva request was cancelled.", "AbortError");
}

/**
 * A cached upstream request can have several consumers: live typeahead,
 * Prepare, or another identical list item. Cancelling one consumer must not
 * abort the shared SerpApi request after it has already been paid for and must
 * not make the other consumers fail. The upstream fetch keeps its own bounded
 * timeout; this helper only stops the cancelled caller from waiting for it.
 */
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

export async function searchWalmart(
  query: string,
  storeId: string,
  requestSignal?: AbortSignal,
): Promise<{
  products: WalmartProduct[];
  // Runtime results always include this array. Keep it optional in the public
  // type so existing typed search fixtures remain source-compatible.
  suggestionSignals?: WalmartSearchSuggestionSignal[];
  mode: "live" | "demo";
  diagnostics: SerpApiCallDiagnostics;
}> {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  if (!apiKey) {
    return {
      products: getMockWalmartResults(query),
      suggestionSignals: [],
      mode: "demo",
      diagnostics: { cacheHit: false, deduplicated: false, apiCall: false, serpApiCacheUsed: null },
    };
  }
  if (!storeId.trim()) {
    throw new WalmartSearchError("Add a Walmart store ID before searching live prices.", "configuration");
  }
  if (requestSignal?.aborted) throw consumerAbortError();

  const cacheKey = `${LOCATION_TRUST_CACHE_VERSION}::${storeId.trim()}::${query.toLowerCase().replace(/\s+/g, " ").trim()}`;
  pruneCache(searchCache);
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      products: cached.products,
      suggestionSignals: cached.suggestionSignals,
      mode: "live",
      diagnostics: {
        cacheHit: true,
        deduplicated: false,
        apiCall: false,
        serpApiCacheUsed: cached.serpApiCacheUsed,
      },
    };
  }

  const existingRequest = searchInFlight.get(cacheKey);
  if (existingRequest) {
    const shared = await waitForSharedRequest(existingRequest, requestSignal);
    return {
      products: shared.products,
      suggestionSignals: shared.suggestionSignals,
      mode: "live",
      diagnostics: {
        cacheHit: true,
        deduplicated: true,
        apiCall: false,
        serpApiCacheUsed: shared.serpApiCacheUsed,
      },
    };
  }

  const liveRequest = (async (): Promise<LiveSearchPayload> => {
    const checkedAt = new Date().toISOString();
    const payload = await fetchSerpApi(new URLSearchParams({
      engine: "walmart",
      query,
      store_id: storeId.trim(),
      spelling: "true",
      include_filters: "true",
      api_key: apiKey,
      output: "json",
    }));
    return {
      products: extractSearchProducts(payload, storeId.trim(), checkedAt),
      suggestionSignals: extractWalmartSearchSuggestionSignals(payload),
      serpApiCacheUsed: serpApiCacheWasUsed(payload),
    };
  })().then((live) => {
    searchCache.set(cacheKey, {
      ...live,
      expiresAt: Date.now() + siteConfig.cacheTtlMs,
    });
    return live;
  }).finally(() => {
    searchInFlight.delete(cacheKey);
  });
  searchInFlight.set(cacheKey, liveRequest);

  const live = await waitForSharedRequest(liveRequest, requestSignal);
  return {
    products: live.products,
    suggestionSignals: live.suggestionSignals,
    mode: "live",
    diagnostics: {
      cacheHit: false,
      deduplicated: false,
      apiCall: true,
      serpApiCacheUsed: live.serpApiCacheUsed,
    },
  };
}

export async function getWalmartProductDetails(
  productId: string,
  storeId: string,
  requestSignal?: AbortSignal,
): Promise<{
  product: WalmartProduct | null;
  mode: "live" | "demo";
  diagnostics: SerpApiCallDiagnostics;
}> {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  if (!apiKey) {
    return {
      product: getMockWalmartProductDetail(productId),
      mode: "demo",
      diagnostics: { cacheHit: false, deduplicated: false, apiCall: false, serpApiCacheUsed: null },
    };
  }
  if (!productId.trim() || !storeId.trim()) {
    return {
      product: null,
      mode: "live",
      diagnostics: { cacheHit: false, deduplicated: false, apiCall: false, serpApiCacheUsed: null },
    };
  }
  if (requestSignal?.aborted) throw consumerAbortError();

  const cacheKey = `${LOCATION_TRUST_CACHE_VERSION}::${storeId.trim()}::${productId.trim()}`;
  pruneCache(detailCache);
  const cached = detailCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      product: cached.product,
      mode: "live",
      diagnostics: {
        cacheHit: true,
        deduplicated: false,
        apiCall: false,
        serpApiCacheUsed: cached.serpApiCacheUsed,
      },
    };
  }

  const existingRequest = detailInFlight.get(cacheKey);
  if (existingRequest) {
    const shared = await waitForSharedRequest(existingRequest, requestSignal);
    return {
      product: shared.product,
      mode: "live",
      diagnostics: {
        cacheHit: true,
        deduplicated: true,
        apiCall: false,
        serpApiCacheUsed: shared.serpApiCacheUsed,
      },
    };
  }

  const liveRequest = (async (): Promise<LiveDetailPayload> => {
    const checkedAt = new Date().toISOString();
    const payload = await fetchSerpApi(new URLSearchParams({
      engine: "walmart_product",
      product_id: productId.trim(),
      store_id: storeId.trim(),
      api_key: apiKey,
      output: "json",
    }));
    return {
      product: parseSerpApiProductDetail(payload, {
        requestedStoreId: storeId.trim(),
        checkedAt,
      }),
      serpApiCacheUsed: serpApiCacheWasUsed(payload),
    };
  })().then((live) => {
    detailCache.set(cacheKey, {
      ...live,
      expiresAt: Date.now() + siteConfig.detailCacheTtlMs,
    });
    return live;
  }).finally(() => {
    detailInFlight.delete(cacheKey);
  });
  detailInFlight.set(cacheKey, liveRequest);

  const live = await waitForSharedRequest(liveRequest, requestSignal);
  return {
    product: live.product,
    mode: "live",
    diagnostics: {
      cacheHit: false,
      deduplicated: false,
      apiCall: true,
      serpApiCacheUsed: live.serpApiCacheUsed,
    },
  };
}
import "./server-only-guard";
