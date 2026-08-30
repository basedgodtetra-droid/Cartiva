import { siteConfig } from "@/config/site";

type UnknownRecord = Record<string, unknown>;

export type RedCircleTargetFulfillmentType = "pickup" | "delivery" | "shipping";

export interface RedCircleTargetOptions {
  deliveryType?: RedCircleTargetFulfillmentType;
  storeId?: string;
  deliveryZip?: string;
}

export interface RedCircleTargetProvenance {
  source: "redcircle_target_search" | "redcircle_target_product";
  requestedStoreId?: string;
  requestedZip?: string;
  observedStoreId?: string;
  observedZip?: string;
  fulfillmentType?: RedCircleTargetFulfillmentType;
  /** Store-stock proves availability, never that the displayed price is store-local. */
  locationVerified: false;
  sellerType: "target" | "marketplace" | "unknown";
  checkedAt: string;
}

export interface RedCircleTargetProduct {
  tcin: string;
  title: string;
  url?: string;
  price?: number;
  priceCents?: number;
  comparisonPrice?: number;
  comparisonPriceCents?: number;
  currency?: string;
  brand?: string;
  seller?: string;
  sponsored?: boolean;
  inStock?: boolean;
  thumbnail?: string;
  checkedAt: string;
  provenance: RedCircleTargetProvenance;
}

export interface RedCircleTargetStoreStock {
  storeId: string;
  storeName?: string;
  inStock: boolean;
  stockLevel?: number;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  distance?: number;
}

export interface RedCircleCallDiagnostics {
  cacheHit: boolean;
  deduplicated: boolean;
  apiCall: boolean;
  durationMs: number;
  creditsRemaining?: number;
}

export interface RedCircleTargetSearchResult {
  products: RedCircleTargetProduct[];
  mode: "live";
  diagnostics: RedCircleCallDiagnostics;
}

export interface RedCircleTargetDetailResult {
  product: RedCircleTargetProduct | null;
  mode: "live";
  diagnostics: RedCircleCallDiagnostics;
}

export interface RedCircleTargetStockResult {
  stores: RedCircleTargetStoreStock[];
  mode: "live";
  diagnostics: RedCircleCallDiagnostics;
}

export type RedCircleTargetErrorCode =
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "not_found"
  | "api_error"
  | "malformed";

export class RedCircleTargetError extends Error {
  constructor(
    message: string,
    public readonly code: RedCircleTargetErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RedCircleTargetError";
  }
}

type CacheEntry<T> = { value: T; expiresAt: number };

declare global {
  var redCircleTargetSearchCacheV1:
    | Map<string, CacheEntry<RedCircleTargetProduct[]>>
    | undefined;
  var redCircleTargetDetailCacheV1:
    | Map<string, CacheEntry<RedCircleTargetProduct | null>>
    | undefined;
  var redCircleTargetStockCacheV1:
    | Map<string, CacheEntry<RedCircleTargetStoreStock[]>>
    | undefined;
  var redCircleTargetSearchInFlightV1:
    | Map<string, Promise<{ value: RedCircleTargetProduct[]; creditsRemaining?: number }>>
    | undefined;
  var redCircleTargetDetailInFlightV1:
    | Map<string, Promise<{ value: RedCircleTargetProduct | null; creditsRemaining?: number }>>
    | undefined;
  var redCircleTargetStockInFlightV1:
    | Map<string, Promise<{ value: RedCircleTargetStoreStock[]; creditsRemaining?: number }>>
    | undefined;
}

const searchCache = globalThis.redCircleTargetSearchCacheV1
  ??= new Map<string, CacheEntry<RedCircleTargetProduct[]>>();
const detailCache = globalThis.redCircleTargetDetailCacheV1
  ??= new Map<string, CacheEntry<RedCircleTargetProduct | null>>();
const stockCache = globalThis.redCircleTargetStockCacheV1
  ??= new Map<string, CacheEntry<RedCircleTargetStoreStock[]>>();
const searchInFlight = globalThis.redCircleTargetSearchInFlightV1
  ??= new Map<string, Promise<{ value: RedCircleTargetProduct[]; creditsRemaining?: number }>>();
const detailInFlight = globalThis.redCircleTargetDetailInFlightV1
  ??= new Map<string, Promise<{ value: RedCircleTargetProduct | null; creditsRemaining?: number }>>();
const stockInFlight = globalThis.redCircleTargetStockInFlightV1
  ??= new Map<string, Promise<{ value: RedCircleTargetStoreStock[]; creditsRemaining?: number }>>();

const BASE_URL = "https://api.redcircleapi.com/request";
const SEARCH_TIMEOUT_MS = 12_000;
const DETAIL_TIMEOUT_MS = 20_000;
const STOCK_TIMEOUT_MS = 8_000;
const STOCK_CACHE_TTL_MS = 10 * 60 * 1000;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function textValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const decoded = value
      .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => {
        const codePoint = Number.parseInt(digits, 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
      })
      .replace(/&#(\d+);/g, (_, digits: string) => {
        const codePoint = Number.parseInt(digits, 10);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
      })
      .replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (entity) => ({
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
        "&nbsp;": " ",
      })[entity.toLowerCase()] ?? entity);
    const cleaned = decoded.replace(/\s+/g, " ").trim();
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

function normalizedTcin(value: unknown) {
  const cleaned = textValue(value)?.replace(/^A-/i, "");
  return cleaned && /^(?:\d{8}|\d{10})$/.test(cleaned) ? cleaned : undefined;
}

function normalizedStoreId(value: unknown) {
  const cleaned = textValue(value);
  if (!cleaned || !/^\d{3,4}$/.test(cleaned)) return undefined;
  const canonical = cleaned.replace(/^0+(?=\d)/, "");
  return /^\d{1,4}$/.test(canonical) && canonical !== "0" ? canonical : undefined;
}

function normalizedPostalCode(value: unknown) {
  const cleaned = textValue(value)?.match(/^\d{5}/)?.[0];
  return cleaned && /^\d{5}$/.test(cleaned) ? cleaned : undefined;
}

function sellerType(value: unknown) {
  const normalized = textValue(value)?.toLowerCase();
  return normalized === "1p"
    ? "target" as const
    : normalized === "3p"
      ? "marketplace" as const
      : "unknown" as const;
}

function parseCreditsRemaining(payload: unknown) {
  const info = record(record(payload)?.request_info);
  return numberValue(info?.credits_remaining);
}

function baseProvenance(
  source: RedCircleTargetProvenance["source"],
  options: RedCircleTargetOptions,
  checkedAt: string,
  offerType?: unknown,
): RedCircleTargetProvenance {
  return {
    source,
    requestedStoreId: normalizedStoreId(options.storeId),
    requestedZip: normalizedPostalCode(options.deliveryZip),
    fulfillmentType: options.deliveryType,
    locationVerified: false,
    sellerType: sellerType(offerType),
    checkedAt,
  };
}

export function parseRedCircleTargetSearch(
  payload: unknown,
  options: RedCircleTargetOptions = {},
  checkedAt = new Date().toISOString(),
) {
  const results = record(payload)?.search_results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry): RedCircleTargetProduct[] => {
    const row = record(entry);
    const product = record(row?.product);
    const offers = record(row?.offers);
    const primary = record(offers?.primary);
    const fulfillment = record(row?.fulfillment);
    const seller = record(row?.seller);
    const tcin = normalizedTcin(product?.tcin);
    const title = textValue(product?.title);
    const price = numberValue(primary?.price, primary?.min_price);
    if (!tcin || !title || price === undefined || price <= 0) return [];
    const regularPrice = numberValue(primary?.regular_price);
    const offerType = fulfillment?.type;
    return [{
      tcin,
      title,
      url: textValue(product?.link),
      price,
      priceCents: Math.round(price * 100),
      comparisonPrice: regularPrice,
      comparisonPriceCents: regularPrice === undefined ? undefined : Math.round(regularPrice * 100),
      currency: textValue(primary?.currency) ?? "USD",
      brand: textValue(product?.brand),
      seller: sellerType(offerType) === "target" ? "Target" : textValue(seller?.name),
      sponsored: booleanValue(product?.sponsored),
      thumbnail: textValue(product?.main_image),
      checkedAt,
      provenance: baseProvenance("redcircle_target_search", options, checkedAt, offerType),
    }];
  });
}

export function parseRedCircleTargetProduct(
  payload: unknown,
  options: RedCircleTargetOptions = {},
  checkedAt = new Date().toISOString(),
) {
  const product = record(record(payload)?.product);
  if (!product) return null;
  const buybox = record(product.buybox_winner);
  const priceObject = record(buybox?.price);
  const wasPrice = record(buybox?.was_price);
  const availability = record(buybox?.availability);
  const fulfillment = record(buybox?.fulfillment);
  const seller = record(buybox?.seller);
  const mainImage = record(product.main_image);
  const tcin = normalizedTcin(product.tcin);
  const title = textValue(product.title);
  const price = numberValue(priceObject?.value);
  if (!tcin || !title || price === undefined || price <= 0) return null;
  const comparisonPrice = numberValue(wasPrice?.value);
  const offerType = fulfillment?.type;
  return {
    tcin,
    title,
    url: textValue(product.link),
    price,
    priceCents: Math.round(price * 100),
    comparisonPrice,
    comparisonPriceCents: comparisonPrice === undefined
      ? undefined
      : Math.round(comparisonPrice * 100),
    currency: textValue(priceObject?.currency) ?? "USD",
    brand: textValue(product.brand),
    seller: sellerType(offerType) === "target" ? "Target" : textValue(seller?.name),
    inStock: booleanValue(availability?.in_stock),
    thumbnail: textValue(mainImage?.link),
    checkedAt,
    provenance: baseProvenance("redcircle_target_product", options, checkedAt, offerType),
  } satisfies RedCircleTargetProduct;
}

export function parseRedCircleTargetStoreStock(payload: unknown) {
  const rows = record(payload)?.store_stock_results;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((entry): RedCircleTargetStoreStock[] => {
    const row = record(entry);
    const storeId = normalizedStoreId(row?.store_id);
    const inStock = booleanValue(row?.in_stock);
    if (!storeId || inStock === undefined) return [];
    return [{
      storeId,
      storeName: textValue(row?.store_name),
      inStock,
      stockLevel: numberValue(row?.stock_level),
      address: textValue(row?.address),
      city: textValue(row?.city),
      state: textValue(row?.state),
      postalCode: normalizedPostalCode(row?.zipcode),
      distance: numberValue(row?.distance),
    }];
  });
}

function abortError() {
  return new DOMException("The request was canceled.", "AbortError");
}

function waitForConsumer<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

async function requestRedCircle(
  params: Record<string, string>,
  timeoutMs = SEARCH_TIMEOUT_MS,
) {
  const apiKey = process.env.REDCIRCLE_API_KEY?.trim();
  if (!apiKey) {
    throw new RedCircleTargetError(
      "Target data is not configured on the Cartiva server.",
      "configuration",
      false,
    );
  }
  const url = new URL(BASE_URL);
  url.searchParams.set("api_key", apiKey);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new RedCircleTargetError(
        "Target took too long to respond.",
        "timeout",
        true,
      );
    }
    throw new RedCircleTargetError(
      "Target data could not be reached.",
      "api_error",
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new RedCircleTargetError("Target data credentials were rejected.", "authentication", false, response.status);
  }
  if (response.status === 429) {
    throw new RedCircleTargetError("Target data request limit was reached.", "rate_limit", true, 429);
  }
  if (response.status === 404) {
    throw new RedCircleTargetError("Target did not return this product.", "not_found", false, 404);
  }
  if (!response.ok) {
    throw new RedCircleTargetError(
      "Target data returned an upstream error.",
      "api_error",
      response.status >= 500,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RedCircleTargetError("Target returned malformed data.", "malformed", false, response.status);
  }
  const info = record(record(payload)?.request_info);
  if (info?.success === false) {
    throw new RedCircleTargetError("Target data request was not successful.", "api_error", true, response.status);
  }
  return payload;
}

async function cachedCall<T>(args: {
  key: string;
  cache: Map<string, CacheEntry<T>>;
  inFlight: Map<string, Promise<{ value: T; creditsRemaining?: number }>>;
  ttlMs: number;
  signal?: AbortSignal;
  load: () => Promise<{ value: T; creditsRemaining?: number }>;
}) {
  const startedAt = performance.now();
  const cached = args.cache.get(args.key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      value: structuredClone(cached.value),
      diagnostics: {
        cacheHit: true,
        deduplicated: false,
        apiCall: false,
        durationMs: Math.round(performance.now() - startedAt),
      } satisfies RedCircleCallDiagnostics,
    };
  }
  if (cached) args.cache.delete(args.key);

  const existing = args.inFlight.get(args.key);
  const upstream = existing ?? args.load().then((result) => {
    args.cache.set(args.key, {
      value: structuredClone(result.value),
      expiresAt: Date.now() + args.ttlMs,
    });
    return result;
  }).finally(() => args.inFlight.delete(args.key));
  if (!existing) args.inFlight.set(args.key, upstream);
  const result = await waitForConsumer(upstream, args.signal);
  return {
    value: structuredClone(result.value),
    diagnostics: {
      cacheHit: false,
      deduplicated: Boolean(existing),
      apiCall: !existing,
      durationMs: Math.round(performance.now() - startedAt),
      creditsRemaining: result.creditsRemaining,
    } satisfies RedCircleCallDiagnostics,
  };
}

function normalizedQuery(query: string) {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function optionsCacheKey(options: RedCircleTargetOptions) {
  return [
    options.deliveryType ?? "none",
    normalizedStoreId(options.storeId) ?? "no-store",
    normalizedPostalCode(options.deliveryZip) ?? "no-zip",
  ].join(":");
}

export async function searchRedCircleTarget(
  query: string,
  options: RedCircleTargetOptions = {},
  signal?: AbortSignal,
): Promise<RedCircleTargetSearchResult> {
  const normalized = normalizedQuery(query);
  if (!normalized) return {
    products: [],
    mode: "live",
    diagnostics: { cacheHit: false, deduplicated: false, apiCall: false, durationMs: 0 },
  };
  const key = `search:${normalized}:${optionsCacheKey(options)}`;
  const result = await cachedCall({
    key,
    cache: searchCache,
    inFlight: searchInFlight,
    ttlMs: siteConfig.cacheTtlMs,
    signal,
    load: async () => {
      const payload = await requestRedCircle({ type: "search", search_term: query.trim() });
      return {
        value: parseRedCircleTargetSearch(payload, options),
        creditsRemaining: parseCreditsRemaining(payload),
      };
    },
  });
  return { products: result.value, mode: "live", diagnostics: result.diagnostics };
}

export async function getRedCircleTargetProduct(
  tcin: string,
  options: RedCircleTargetOptions = {},
  signal?: AbortSignal,
): Promise<RedCircleTargetDetailResult> {
  const productId = normalizedTcin(tcin);
  if (!productId) throw new RedCircleTargetError("Target product ID is invalid.", "not_found", false);
  const key = `product:${productId}:${optionsCacheKey(options)}`;
  const result = await cachedCall({
    key,
    cache: detailCache,
    inFlight: detailInFlight,
    ttlMs: siteConfig.detailCacheTtlMs,
    signal,
    load: async () => {
      const payload = await requestRedCircle(
        { type: "product", tcin: productId },
        DETAIL_TIMEOUT_MS,
      );
      return {
        value: parseRedCircleTargetProduct(payload, options),
        creditsRemaining: parseCreditsRemaining(payload),
      };
    },
  });
  return { product: result.value, mode: "live", diagnostics: result.diagnostics };
}

export async function getRedCircleTargetStoreStock(
  tcin: string,
  zipCode: string,
  signal?: AbortSignal,
): Promise<RedCircleTargetStockResult> {
  const productId = normalizedTcin(tcin);
  const postalCode = normalizedPostalCode(zipCode);
  if (!productId || !postalCode) {
    throw new RedCircleTargetError("Target product ID or ZIP is invalid.", "not_found", false);
  }
  const key = `stock:${productId}:${postalCode}`;
  const result = await cachedCall({
    key,
    cache: stockCache,
    inFlight: stockInFlight,
    ttlMs: STOCK_CACHE_TTL_MS,
    signal,
    load: async () => {
      const payload = await requestRedCircle(
        {
          type: "store_stock",
          tcin: productId,
          store_stock_zipcode: postalCode,
        },
        STOCK_TIMEOUT_MS,
      );
      return {
        value: parseRedCircleTargetStoreStock(payload),
        creditsRemaining: parseCreditsRemaining(payload),
      };
    },
  });
  return { stores: result.value, mode: "live", diagnostics: result.diagnostics };
}
import "./server-only-guard";
