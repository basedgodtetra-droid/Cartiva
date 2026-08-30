import { siteConfig } from "@/config/site";

type UnknownRecord = Record<string, unknown>;

export interface ParseBotTargetOptions {
  /** Parse's Target API localizes catalog prices by ZIP, not by store ID. */
  zip?: string;
  storeId?: string;
}

export interface ParseBotTargetProvenance {
  source: "parsebot_target_search" | "parsebot_target_product";
  requestedStoreId?: string;
  requestedZip?: string;
  observedZip?: string;
  /** Search and product responses do not prove that a price belongs to one store. */
  locationVerified: false;
  /** Parse.bot does not expose an offer seller in the documented Target schema. */
  sellerType: "unknown";
  checkedAt: string;
}

export interface ParseBotTargetProduct {
  tcin: string;
  title: string;
  url: string;
  price: number;
  priceCents: number;
  comparisonPrice?: number;
  comparisonPriceCents?: number;
  currency: "USD";
  brand?: string;
  seller?: string;
  productType?: string;
  inStock?: boolean;
  sponsored?: boolean;
  thumbnail?: string;
  checkedAt: string;
  provenance: ParseBotTargetProvenance;
}

export interface ParseBotTargetStoreStock {
  storeId: string;
  storeName?: string;
  inStock: boolean;
  stockLevel?: number;
  availabilityStatus?: string;
  pickupDate?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  distance?: number;
  phone?: string;
}

export interface ParseBotCallDiagnostics {
  cacheHit: boolean;
  deduplicated: boolean;
  apiCall: boolean;
  durationMs: number;
  creditsRemaining?: number;
}

export interface ParseBotTargetSearchResult {
  products: ParseBotTargetProduct[];
  mode: "live";
  diagnostics: ParseBotCallDiagnostics;
}

export interface ParseBotTargetDetailResult {
  product: ParseBotTargetProduct | null;
  mode: "live";
  diagnostics: ParseBotCallDiagnostics;
}

export interface ParseBotTargetStockResult {
  /** Parsed from Parse's response and validated against the requested TCIN. */
  productId: string;
  productTitle: string;
  productUrl: string;
  zipCode: string;
  stores: ParseBotTargetStoreStock[];
  mode: "live";
  diagnostics: ParseBotCallDiagnostics;
}

export type ParseBotTargetErrorCode =
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "not_found"
  | "api_error"
  | "malformed";

export class ParseBotTargetError extends Error {
  constructor(
    message: string,
    public readonly code: ParseBotTargetErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ParseBotTargetError";
  }
}

type CacheEntry<T> = { value: T; expiresAt: number };
type LoadedValue<T> = { value: T; creditsRemaining?: number };
type ParseBotTargetStockSnapshot = Pick<
  ParseBotTargetStockResult,
  "productId" | "productTitle" | "productUrl" | "zipCode" | "stores"
>;

declare global {
  var parseBotTargetSearchCacheV1:
    | Map<string, CacheEntry<ParseBotTargetProduct[]>>
    | undefined;
  var parseBotTargetDetailCacheV1:
    | Map<string, CacheEntry<ParseBotTargetProduct | null>>
    | undefined;
  var parseBotTargetStockCacheV1:
    | Map<string, CacheEntry<ParseBotTargetStockSnapshot>>
    | undefined;
  var parseBotTargetSearchInFlightV1:
    | Map<string, Promise<LoadedValue<ParseBotTargetProduct[]>>>
    | undefined;
  var parseBotTargetDetailInFlightV1:
    | Map<string, Promise<LoadedValue<ParseBotTargetProduct | null>>>
    | undefined;
  var parseBotTargetStockInFlightV1:
    | Map<string, Promise<LoadedValue<ParseBotTargetStockSnapshot>>>
    | undefined;
}

const searchCache = globalThis.parseBotTargetSearchCacheV1
  ??= new Map<string, CacheEntry<ParseBotTargetProduct[]>>();
const detailCache = globalThis.parseBotTargetDetailCacheV1
  ??= new Map<string, CacheEntry<ParseBotTargetProduct | null>>();
const stockCache = globalThis.parseBotTargetStockCacheV1
  ??= new Map<string, CacheEntry<ParseBotTargetStockSnapshot>>();
const searchInFlight = globalThis.parseBotTargetSearchInFlightV1
  ??= new Map<string, Promise<LoadedValue<ParseBotTargetProduct[]>>>();
const detailInFlight = globalThis.parseBotTargetDetailInFlightV1
  ??= new Map<string, Promise<LoadedValue<ParseBotTargetProduct | null>>>();
const stockInFlight = globalThis.parseBotTargetStockInFlightV1
  ??= new Map<string, Promise<LoadedValue<ParseBotTargetStockSnapshot>>>();

const BASE_URL = "https://api.parse.bot/scraper/9935e57e-18c2-4c7c-aebe-bc311e983dc8";
const SEARCH_TIMEOUT_MS = 12_000;
const DETAIL_TIMEOUT_MS = 15_000;
const STOCK_TIMEOUT_MS = 15_000;
const STOCK_CACHE_TTL_MS = 5 * 60 * 1000;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function dataRecord(payload: unknown) {
  const root = record(payload);
  return record(root?.data) ?? root;
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
        "&quot;": "\"",
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
    if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
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
  if (!cleaned || !/^\d{1,4}$/.test(cleaned)) return undefined;
  const canonical = cleaned.replace(/^0+(?=\d)/, "");
  return canonical !== "0" ? canonical : undefined;
}

function normalizedPostalCode(...values: unknown[]) {
  for (const value of values) {
    const cleaned = textValue(value)?.match(/\b\d{5}\b/)?.[0];
    if (cleaned && /^\d{5}$/.test(cleaned)) return cleaned;
  }
  return undefined;
}

function normalizedTargetUrl(value: unknown, tcin: string) {
  const raw = textValue(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw, "https://www.target.com");
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "target.com" && !hostname.endsWith(".target.com")) return undefined;
    if (!new RegExp(`(?:^|/)A-${tcin}(?:$|[/?#])`, "i").test(`${url.pathname}${url.search}${url.hash}`)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function imageUrl(value: unknown) {
  if (typeof value === "string") return textValue(value);
  const image = record(value);
  return textValue(image?.url, image?.link, image?.image_url, image?.src);
}

function availabilityValue(...values: unknown[]) {
  const direct = booleanValue(...values);
  if (direct !== undefined) return direct;
  for (const value of values) {
    const status = textValue(value)?.toUpperCase().replace(/[\s-]+/g, "_");
    if (!status) continue;
    if (["IN_STOCK", "AVAILABLE", "LIMITED_STOCK", "READY_FOR_PICKUP"].includes(status)) {
      return true;
    }
    if ([
      "OUT_OF_STOCK",
      "UNAVAILABLE",
      "NOT_AVAILABLE",
      "NOT_SOLD",
      "SOLD_OUT",
    ].includes(status)) {
      return false;
    }
  }
  return undefined;
}

function baseProvenance(
  source: ParseBotTargetProvenance["source"],
  options: ParseBotTargetOptions,
  checkedAt: string,
  observedZip?: unknown,
): ParseBotTargetProvenance {
  return {
    source,
    requestedStoreId: normalizedStoreId(options.storeId),
    requestedZip: normalizedPostalCode(options.zip),
    observedZip: normalizedPostalCode(observedZip),
    locationVerified: false,
    sellerType: "unknown",
    checkedAt,
  };
}

function parseProductRow(
  value: unknown,
  source: ParseBotTargetProvenance["source"],
  options: ParseBotTargetOptions,
  checkedAt: string,
  observedZip?: unknown,
): ParseBotTargetProduct | null {
  const row = record(value);
  if (!row) return null;
  const tcin = normalizedTcin(row.tcin);
  const title = textValue(row.title);
  const url = tcin ? normalizedTargetUrl(row.url, tcin) : undefined;
  const price = numberValue(row.current_retail, row.currentRetail, row.price);
  if (!tcin || !title || !url || price === undefined || price <= 0) return null;

  const comparisonPrice = numberValue(row.regular_price, row.regularPrice);
  const images = Array.isArray(row.images) ? row.images : [];
  const explicitStock = availabilityValue(
    row.in_stock,
    row.inStock,
    row.online_availability,
    row.availability,
    row.availability_status,
  );
  const soldOut = booleanValue(row.sold_out, row.soldOut);
  return {
    tcin,
    title,
    url,
    price,
    priceCents: Math.round(price * 100),
    comparisonPrice: comparisonPrice && comparisonPrice > 0 ? comparisonPrice : undefined,
    comparisonPriceCents: comparisonPrice && comparisonPrice > 0
      ? Math.round(comparisonPrice * 100)
      : undefined,
    currency: "USD",
    brand: textValue(row.brand),
    productType: textValue(row.item_type, row.itemType, row.product_type, row.category),
    inStock: explicitStock ?? (soldOut === undefined ? undefined : !soldOut),
    sponsored: booleanValue(row.sponsored),
    thumbnail: imageUrl(row.image_url) ?? imageUrl(row.image) ?? imageUrl(images[0]),
    checkedAt,
    provenance: baseProvenance(source, options, checkedAt, observedZip),
  };
}

export function parseParseBotTargetSearch(
  payload: unknown,
  options: ParseBotTargetOptions = {},
  checkedAt = new Date().toISOString(),
) {
  const data = dataRecord(payload);
  const products = data?.products;
  if (!Array.isArray(products)) return [];
  const observedZip = data?.zipcode ?? data?.zip;
  return products.flatMap((value): ParseBotTargetProduct[] => {
    const product = parseProductRow(
      value,
      "parsebot_target_search",
      options,
      checkedAt,
      observedZip,
    );
    return product ? [product] : [];
  });
}

export function parseParseBotTargetProduct(
  payload: unknown,
  options: ParseBotTargetOptions = {},
  checkedAt = new Date().toISOString(),
) {
  const data = dataRecord(payload);
  const product = record(data?.product) ?? data;
  return parseProductRow(
    product,
    "parsebot_target_product",
    options,
    checkedAt,
    data?.zipcode ?? data?.zip,
  );
}

function addressParts(row: UnknownRecord) {
  const addressObject = record(row.address);
  const address = textValue(
    typeof row.address === "string" ? row.address : undefined,
    addressObject?.formatted_address,
    addressObject?.address_line,
    row.formatted_address,
  );
  const city = textValue(row.city, addressObject?.city);
  const state = textValue(row.state, addressObject?.state);
  const postalCode = normalizedPostalCode(
    row.postal_code,
    row.zipcode,
    row.zip,
    addressObject?.postal_code,
    addressObject?.zipcode,
    address,
  );
  return { address, city, state, postalCode };
}

function stockEnvelope(payload: unknown) {
  const data = dataRecord(payload);
  const product = record(data?.product) ?? data;
  return { data, product };
}

export function parseParseBotTargetStoreStock(
  payload: unknown,
  expectedTcin?: string,
  expectedZip?: string,
) {
  const { data, product } = stockEnvelope(payload);
  if (!data || !product) return [];

  const requestedTcin = expectedTcin ? normalizedTcin(expectedTcin) : undefined;
  const responseTcin = normalizedTcin(product.tcin);
  if (requestedTcin && responseTcin && requestedTcin !== responseTcin) return [];
  const requestedZip = expectedZip ? normalizedPostalCode(expectedZip) : undefined;
  const responseZip = normalizedPostalCode(data.zipcode, data.zip);
  if (requestedZip && responseZip && requestedZip !== responseZip) return [];
  if (responseTcin && product.url && !normalizedTargetUrl(product.url, responseTcin)) return [];

  const rows = product.stores ?? data.stores;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((value): ParseBotTargetStoreStock[] => {
    const row = record(value);
    if (!row) return [];
    const storeId = normalizedStoreId(row.store_id ?? row.storeId);
    const stockLevel = numberValue(
      row.quantity_available,
      row.quantityAvailable,
      row.stock_level,
      row.stockLevel,
      row.quantity,
    );
    const status = textValue(row.order_pickup, row.orderPickup);
    // `in_store` describes shelf inventory, not whether Target will accept a
    // pickup order. Cartiva only treats an explicit order-pickup status as
    // pickup evidence.
    const pickupAvailability = availabilityValue(
      row.order_pickup,
      row.orderPickup,
    );
    const inStock = pickupAvailability === undefined
      ? undefined
      : pickupAvailability && (stockLevel === undefined || stockLevel > 0);
    if (!storeId || inStock === undefined) return [];
    const address = addressParts(row);
    return [{
      storeId,
      storeName: textValue(row.store_name, row.storeName, row.name),
      inStock,
      stockLevel,
      availabilityStatus: status,
      pickupDate: textValue(row.pickup_date, row.pickupDate, row.estimated_pickup_date),
      ...address,
      distance: numberValue(row.distance_miles, row.distanceMiles, row.distance),
      phone: textValue(row.phone),
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

function creditsRemaining(response: Response) {
  return numberValue(
    response.headers.get("x-credits-remaining"),
    response.headers.get("x-ratelimit-remaining"),
    response.headers.get("ratelimit-remaining"),
  );
}

async function requestParseBot(
  endpoint: "search_products" | "get_product" | "check_store_availability",
  params: Record<string, string>,
  timeoutMs: number,
) {
  const apiKey = process.env.PARSEBOT_API_KEY?.trim();
  if (!apiKey) {
    throw new ParseBotTargetError(
      "Target data is not configured on the Cartiva server.",
      "configuration",
      false,
    );
  }

  const url = new URL(`${BASE_URL}/${endpoint}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey,
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new ParseBotTargetError("Target took too long to respond.", "timeout", true);
    }
    throw new ParseBotTargetError("Target data could not be reached.", "api_error", true);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ParseBotTargetError(
      "Target data credentials were rejected.",
      "authentication",
      false,
      response.status,
    );
  }
  if (response.status === 429) {
    throw new ParseBotTargetError(
      "Target data request limit was reached.",
      "rate_limit",
      true,
      response.status,
    );
  }
  if (response.status === 404) {
    throw new ParseBotTargetError(
      "Target did not return this product.",
      "not_found",
      false,
      response.status,
    );
  }
  if (!response.ok) {
    throw new ParseBotTargetError(
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
    throw new ParseBotTargetError(
      "Target returned malformed data.",
      "malformed",
      false,
      response.status,
    );
  }
  const root = record(payload);
  const status = textValue(root?.status)?.toLowerCase();
  if (status && status !== "success") {
    throw new ParseBotTargetError(
      "Target data request was not successful.",
      "api_error",
      true,
      response.status,
    );
  }
  return { payload, creditsRemaining: creditsRemaining(response) };
}

async function cachedCall<T>(args: {
  key: string;
  cache: Map<string, CacheEntry<T>>;
  inFlight: Map<string, Promise<LoadedValue<T>>>;
  ttlMs: number;
  signal?: AbortSignal;
  load: () => Promise<LoadedValue<T>>;
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
      } satisfies ParseBotCallDiagnostics,
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
    } satisfies ParseBotCallDiagnostics,
  };
}

function normalizedQuery(query: string) {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function optionsCacheKey(options: ParseBotTargetOptions) {
  return [
    normalizedStoreId(options.storeId) ?? "no-store",
    normalizedPostalCode(options.zip) ?? "no-zip",
  ].join(":");
}

export async function searchParseBotTarget(
  query: string,
  options: ParseBotTargetOptions = {},
  signal?: AbortSignal,
): Promise<ParseBotTargetSearchResult> {
  const normalized = normalizedQuery(query);
  if (!normalized) {
    return {
      products: [],
      mode: "live",
      diagnostics: { cacheHit: false, deduplicated: false, apiCall: false, durationMs: 0 },
    };
  }
  const zip = options.zip ? normalizedPostalCode(options.zip) : undefined;
  if (options.zip && !zip) {
    throw new ParseBotTargetError("Target ZIP is invalid.", "not_found", false);
  }
  const key = `search:${normalized}:${optionsCacheKey(options)}`;
  const result = await cachedCall({
    key,
    cache: searchCache,
    inFlight: searchInFlight,
    ttlMs: siteConfig.cacheTtlMs,
    signal,
    load: async () => {
      const request = await requestParseBot(
        "search_products",
        {
          keyword: query.replace(/\s+/g, " ").trim(),
          ...(zip ? { zip } : {}),
          count: "24",
          offset: "0",
          sort_by: "relevance",
        },
        SEARCH_TIMEOUT_MS,
      );
      return {
        value: parseParseBotTargetSearch(request.payload, { ...options, zip }),
        creditsRemaining: request.creditsRemaining,
      };
    },
  });
  return { products: result.value, mode: "live", diagnostics: result.diagnostics };
}

export async function getParseBotTargetProduct(
  tcin: string,
  options: ParseBotTargetOptions = {},
  signal?: AbortSignal,
): Promise<ParseBotTargetDetailResult> {
  const productId = normalizedTcin(tcin);
  const zip = options.zip ? normalizedPostalCode(options.zip) : undefined;
  if (!productId) {
    throw new ParseBotTargetError("Target product ID is invalid.", "not_found", false);
  }
  if (options.zip && !zip) {
    throw new ParseBotTargetError("Target ZIP is invalid.", "not_found", false);
  }
  const normalizedOptions = { ...options, zip };
  const key = `product:${productId}:${optionsCacheKey(normalizedOptions)}`;
  const result = await cachedCall({
    key,
    cache: detailCache,
    inFlight: detailInFlight,
    ttlMs: siteConfig.detailCacheTtlMs,
    signal,
    load: async () => {
      const request = await requestParseBot(
        "get_product",
        { tcin: productId, ...(zip ? { zip } : {}) },
        DETAIL_TIMEOUT_MS,
      );
      const product = parseParseBotTargetProduct(request.payload, normalizedOptions);
      if (product && product.tcin !== productId) {
        throw new ParseBotTargetError("Target returned mismatched product data.", "malformed", false);
      }
      return { value: product, creditsRemaining: request.creditsRemaining };
    },
  });
  return { product: result.value, mode: "live", diagnostics: result.diagnostics };
}

export async function getParseBotTargetStoreStock(
  tcin: string,
  zipCode: string,
  signal?: AbortSignal,
): Promise<ParseBotTargetStockResult> {
  const productId = normalizedTcin(tcin);
  const zip = normalizedPostalCode(zipCode);
  if (!productId || !zip) {
    throw new ParseBotTargetError("Target product ID or ZIP is invalid.", "not_found", false);
  }
  const key = `stock:${productId}:${zip}`;
  const result = await cachedCall({
    key,
    cache: stockCache,
    inFlight: stockInFlight,
    ttlMs: STOCK_CACHE_TTL_MS,
    signal,
    load: async () => {
      const request = await requestParseBot(
        "check_store_availability",
        { tcin: productId, zip },
        STOCK_TIMEOUT_MS,
      );
      const { data, product } = stockEnvelope(request.payload);
      const responseTcin = normalizedTcin(product?.tcin);
      const responseTitle = textValue(product?.title);
      const responseZip = normalizedPostalCode(data?.zipcode, data?.zip);
      if (responseTcin !== productId || responseZip !== zip) {
        throw new ParseBotTargetError(
          "Target returned mismatched store availability data.",
          "malformed",
          false,
        );
      }
      const responseUrl = normalizedTargetUrl(product?.url, responseTcin);
      if (!responseTitle || !responseUrl) {
        throw new ParseBotTargetError(
          "Target returned malformed product identity data.",
          "malformed",
          false,
        );
      }
      return {
        value: {
          productId: responseTcin,
          productTitle: responseTitle,
          productUrl: responseUrl,
          zipCode: responseZip,
          stores: parseParseBotTargetStoreStock(request.payload, productId, zip),
        },
        creditsRemaining: request.creditsRemaining,
      };
    },
  });
  return { ...result.value, mode: "live", diagnostics: result.diagnostics };
}
import "./server-only-guard";
