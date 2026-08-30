type UnknownRecord = Record<string, unknown>;

export type DecodoTargetFulfillmentType = "pickup" | "delivery" | "shipping";

export interface DecodoTargetOptions {
  deliveryType?: DecodoTargetFulfillmentType;
  storeId?: string;
  deliveryZip?: string;
  /** Enables Decodo's JavaScript renderer by sending `headless: "html"`. */
  headless?: boolean;
}

export interface DecodoTargetParseContext extends DecodoTargetOptions {
  checkedAt?: string;
  requestedTcin?: string;
}

export interface DecodoTargetProvenance {
  source: "decodo_target_search" | "decodo_target_product";
  requestedStoreId?: string;
  requestedZip?: string;
  observedStoreId?: string;
  observedZip?: string;
  fulfillmentType?: DecodoTargetFulfillmentType;
  /**
   * Decodo's parsed Target templates do not identify the store/ZIP that
   * produced a price. Request parameters alone are not verification evidence.
   */
  locationVerified: false;
  requestedTcin?: string;
  tcinSource: "response" | "request";
  checkedAt: string;
}

export interface DecodoTargetProduct {
  tcin: string;
  title: string;
  url?: string;
  price?: number;
  priceCents?: number;
  comparisonPrice?: number;
  comparisonPriceCents?: number;
  currency?: string;
  brand?: string;
  inStock?: boolean;
  thumbnail?: string;
  checkedAt: string;
  provenance: DecodoTargetProvenance;
}

export interface DecodoTargetCallDiagnostics {
  cacheHit: boolean;
  deduplicated: boolean;
  apiCall: boolean;
  durationMs: number;
}

export interface DecodoTargetSearchResult {
  products: DecodoTargetProduct[];
  mode: "live";
  diagnostics: DecodoTargetCallDiagnostics;
}

export interface DecodoTargetDetailResult {
  product: DecodoTargetProduct | null;
  mode: "live";
  diagnostics: DecodoTargetCallDiagnostics;
}

export type DecodoTargetErrorCode =
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "not_found"
  | "api_error"
  | "malformed";

/** A deliberately sanitized error safe to retry, serialize, or return upstream. */
export class DecodoTargetError extends Error {
  constructor(
    message: string,
    public readonly code: DecodoTargetErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DecodoTargetError";
  }
}

type SearchCacheEntry = {
  products: DecodoTargetProduct[];
  expiresAt: number;
};

type DetailCacheEntry = {
  product: DecodoTargetProduct | null;
  expiresAt: number;
};

declare global {
  var decodoTargetSearchCacheV1: Map<string, SearchCacheEntry> | undefined;
  var decodoTargetDetailCacheV1: Map<string, DetailCacheEntry> | undefined;
  var decodoTargetSearchInFlightV1:
    | Map<string, Promise<DecodoTargetProduct[]>>
    | undefined;
  var decodoTargetDetailInFlightV1:
    | Map<string, Promise<DecodoTargetProduct | null>>
    | undefined;
}

const searchCache = globalThis.decodoTargetSearchCacheV1
  ?? new Map<string, SearchCacheEntry>();
const detailCache = globalThis.decodoTargetDetailCacheV1
  ?? new Map<string, DetailCacheEntry>();
const searchInFlight = globalThis.decodoTargetSearchInFlightV1
  ?? new Map<string, Promise<DecodoTargetProduct[]>>();
const detailInFlight = globalThis.decodoTargetDetailInFlightV1
  ?? new Map<string, Promise<DecodoTargetProduct | null>>();

globalThis.decodoTargetSearchCacheV1 = searchCache;
globalThis.decodoTargetDetailCacheV1 = detailCache;
globalThis.decodoTargetSearchInFlightV1 = searchInFlight;
globalThis.decodoTargetDetailInFlightV1 = detailInFlight;

const DECODO_ENDPOINT = "https://scraper-api.decodo.com/v2/scrape";
const CACHE_VERSION = "decodo-target-location-unverified-v1";
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1_000;
const DETAIL_CACHE_TTL_MS = 45 * 60 * 1_000;
const SEARCH_REQUEST_TIMEOUT_MS = 45_000;
const SEARCH_MAX_ATTEMPTS = 2;
// Search already gives Cartiva a useful comparison candidate. Product-detail
// verification is optional and must not hold the stream for two full 45-second
// attempts when Decodo's Target detail template is unavailable.
const DETAIL_REQUEST_TIMEOUT_MS = 20_000;
const DETAIL_MAX_ATTEMPTS = 1;
const DEFAULT_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 1_000;
const MAX_CACHE_ENTRIES = 200;

type NormalizedOptions = {
  deliveryType?: DecodoTargetFulfillmentType;
  storeId?: string;
  deliveryZip?: string;
  headless: boolean;
};

type DecodoRequestBody = {
  target: "target_search" | "target_product";
  parse: true;
  query?: string;
  product_id?: string;
  headless?: "html";
  delivery_type?: DecodoTargetFulfillmentType;
  store_id?: string;
  delivery_zip?: string;
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

/** Returns a non-empty upstream string without trimming or otherwise rewriting it. */
function exactText(...values: unknown[]) {
  return values.find((value): value is string => (
    typeof value === "string" && value.trim().length > 0
  ));
}

/** Keeps string identifiers byte-for-byte; numeric identifiers are stringified. */
function exactIdentifier(...values: unknown[]) {
  const value = values.find((candidate) => (
    (typeof candidate === "string" && candidate.trim().length > 0)
    || (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0)
  ));
  return value === undefined ? undefined : String(value);
}

function moneyValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value !== "string") continue;
    const normalized = value.trim().replace(/,/g, "").replace(/^[\$\u00a3\u20ac]\s*/, "");
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) continue;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function priceCents(value: number | undefined) {
  if (value === undefined || value > Number.MAX_SAFE_INTEGER / 100) return undefined;
  return Math.round(value * 100);
}

function stockValue(...values: unknown[]): boolean | undefined {
  const visited = new Set<object>();
  const visit = (value: unknown): boolean | undefined => {
    if (typeof value === "boolean") return value;
    const record = asRecord(value);
    if (record) {
      if (visited.has(record)) return undefined;
      visited.add(record);
      const nestedValues = [
        record.in_stock,
        record.available,
        record.is_available,
        record.availability_status,
        record.status,
      ];
      for (const nestedValue of nestedValues) {
        const nested = visit(nestedValue);
        if (nested !== undefined) return nested;
      }
    }
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (/out[\s_-]*of[\s_-]*stock|sold[\s_-]*out|unavailable|not[\s_-]*available/.test(normalized)) {
      return false;
    }
    if (/\bin[\s_-]*stock\b|^available$/.test(normalized)) return true;
    return undefined;
  };
  for (const value of values) {
    const stock = visit(value);
    if (stock !== undefined) return stock;
  }
  return undefined;
}

function checkedAtFor(context: DecodoTargetParseContext) {
  return context.checkedAt ?? new Date().toISOString();
}

function provenanceFor(
  source: DecodoTargetProvenance["source"],
  context: DecodoTargetParseContext,
  checkedAt: string,
  tcinSource: DecodoTargetProvenance["tcinSource"],
): DecodoTargetProvenance {
  const requestedStoreId = context.storeId?.trim() || undefined;
  const requestedZip = context.deliveryZip?.trim() || undefined;
  const requestedTcin = context.requestedTcin?.trim() || undefined;
  return {
    source,
    requestedStoreId,
    requestedZip,
    fulfillmentType: context.deliveryType,
    // Neither request echoes nor Target cookies are accepted as location proof.
    locationVerified: false,
    requestedTcin,
    tcinSource,
    checkedAt,
  };
}

function malformed(message: string) {
  return new DecodoTargetError(message, "malformed", true);
}

function parseStatusCodes(payload: unknown) {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.results)) return [];
  const codes: number[] = [];
  for (const resultValue of root.results) {
    const result = asRecord(resultValue);
    const content = asRecord(result?.content);
    const parsed = asRecord(content?.results);
    for (const value of [content?.status_code, parsed?.parse_status_code]) {
      if (typeof value === "number" && Number.isInteger(value)) codes.push(value);
    }
  }
  return codes;
}

function throwForParsedStatus(payload: unknown) {
  for (const code of parseStatusCodes(payload)) {
    if (code === 12000 || code === 12004 || code === 12005 || code === 12007) continue;
    if (code === 12009) {
      throw new DecodoTargetError("The Target product was not found.", "not_found", false);
    }
    if (code === 12003) {
      throw new DecodoTargetError(
        "Decodo does not support parsing this Target request.",
        "configuration",
        false,
      );
    }
    if (code >= 12000 && code < 13000) {
      throw malformed("Decodo could not parse the Target response.");
    }
  }
}

function contentRecords(payload: unknown) {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.results)) {
    throw malformed("Decodo returned malformed Target data.");
  }
  const records = root.results
    .map((result) => asRecord(asRecord(result)?.content))
    .filter((content): content is UnknownRecord => Boolean(content));
  if (records.length === 0) throw malformed("Decodo returned malformed Target data.");
  return records;
}

function parseSearchItem(
  value: unknown,
  context: DecodoTargetParseContext,
): DecodoTargetProduct | null {
  const item = asRecord(value);
  if (!item) return null;
  const tcin = exactIdentifier(item.product_id, item.tcin);
  const title = exactText(item.title);
  if (!tcin || !title) return null;

  const priceData = asRecord(item.price_data);
  const price = moneyValue(priceData?.price, item.price);
  const comparisonPrice = moneyValue(
    priceData?.comparison_price,
    item.comparison_price,
    item.regular_price,
  );
  const checkedAt = checkedAtFor(context);
  return {
    tcin,
    title,
    url: exactText(item.url),
    price,
    priceCents: priceCents(price),
    comparisonPrice,
    comparisonPriceCents: priceCents(comparisonPrice),
    currency: exactText(priceData?.currency, item.currency),
    brand: exactText(item.brand_name, asRecord(item.brand)?.name),
    inStock: stockValue(item.in_stock, item.availability, item.availability_status),
    thumbnail: exactText(item.thumbnail, item.image, asRecord(item.images)?.main),
    checkedAt,
    provenance: provenanceFor("decodo_target_search", context, checkedAt, "response"),
  };
}

/** Parses Decodo's documented `target_search` response envelope. */
export function parseDecodoTargetSearch(
  payload: unknown,
  context: DecodoTargetParseContext = {},
): DecodoTargetProduct[] {
  throwForParsedStatus(payload);
  const checkedAt = checkedAtFor(context);
  const parseContext = { ...context, checkedAt };
  const products: DecodoTargetProduct[] = [];
  let foundOrganicResults = false;

  for (const content of contentRecords(payload)) {
    const parsed = asRecord(content.results);
    const nestedResults = asRecord(parsed?.results);
    const organic = nestedResults?.organic ?? parsed?.organic;
    if (!Array.isArray(organic)) continue;
    foundOrganicResults = true;
    for (const item of organic) {
      const product = parseSearchItem(item, parseContext);
      if (product) products.push(product);
    }
  }

  if (!foundOrganicResults) throw malformed("Decodo returned malformed Target search data.");
  return products;
}

/** Parses Decodo's documented `target_product` response envelope. */
export function parseDecodoTargetProduct(
  payload: unknown,
  context: DecodoTargetParseContext = {},
): DecodoTargetProduct | null {
  try {
    throwForParsedStatus(payload);
  } catch (error) {
    if (error instanceof DecodoTargetError && error.code === "not_found") return null;
    throw error;
  }

  const product = contentRecords(payload)
    .map((content) => asRecord(content.results))
    .find((candidate): candidate is UnknownRecord => Boolean(candidate));
  if (!product) throw malformed("Decodo returned malformed Target product data.");

  const returnedTcin = exactIdentifier(product.product_id, product.tcin);
  const requestedTcin = context.requestedTcin?.trim() || undefined;
  const tcin = returnedTcin ?? requestedTcin;
  const title = exactText(product.title);
  if (!tcin || !title) throw malformed("Decodo returned incomplete Target product data.");

  const priceData = asRecord(product.price);
  const price = moneyValue(
    priceData?.current,
    priceData?.price,
    product.current_price,
    typeof product.price === "number" || typeof product.price === "string"
      ? product.price
      : undefined,
  );
  const comparisonPrice = moneyValue(
    priceData?.comparison,
    priceData?.comparison_price,
    priceData?.regular,
    priceData?.original,
    product.comparison_price,
    product.regular_price,
  );
  const checkedAt = checkedAtFor(context);
  return {
    tcin,
    title,
    url: exactText(product.url),
    price,
    priceCents: priceCents(price),
    comparisonPrice,
    comparisonPriceCents: priceCents(comparisonPrice),
    currency: exactText(priceData?.currency, product.currency),
    brand: exactText(asRecord(product.brand)?.name, product.brand_name),
    inStock: stockValue(product.in_stock, product.availability, product.availability_status),
    thumbnail: exactText(asRecord(product.images)?.main, product.thumbnail, product.image),
    checkedAt,
    provenance: provenanceFor(
      "decodo_target_product",
      context,
      checkedAt,
      returnedTcin ? "response" : "request",
    ),
  };
}

function normalizeOptions(options: DecodoTargetOptions): NormalizedOptions {
  const deliveryType = options.deliveryType;
  const storeId = options.storeId?.trim() || undefined;
  const deliveryZip = options.deliveryZip?.trim() || undefined;
  if (options.headless !== undefined && typeof options.headless !== "boolean") {
    throw new DecodoTargetError("Choose a valid Decodo rendering mode.", "configuration", false);
  }
  if (
    deliveryType !== undefined
    && deliveryType !== "pickup"
    && deliveryType !== "delivery"
    && deliveryType !== "shipping"
  ) {
    throw new DecodoTargetError("Choose a valid Target fulfillment type.", "configuration", false);
  }
  if (!deliveryType && (storeId || deliveryZip)) {
    throw new DecodoTargetError(
      "Choose a Target fulfillment type for the requested location.",
      "configuration",
      false,
    );
  }
  if (deliveryType === "pickup") {
    if (
      !storeId
      || !/^\d{3,4}$/.test(storeId)
      || !deliveryZip
      || !/^\d{5}(?:-\d{4})?$/.test(deliveryZip)
    ) {
      throw new DecodoTargetError(
        "Choose one valid Target pickup store and ZIP code.",
        "configuration",
        false,
      );
    }
  }
  if (deliveryType === "delivery" || deliveryType === "shipping") {
    if (!deliveryZip || !/^\d{5}(?:-\d{4})?$/.test(deliveryZip) || storeId) {
      throw new DecodoTargetError(
        "Enter one valid delivery ZIP for Target.",
        "configuration",
        false,
      );
    }
  }
  return { deliveryType, storeId, deliveryZip, headless: options.headless === true };
}

function normalizedQuery(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function validateQuery(value: string) {
  if (!value || value.length > 160) {
    throw new DecodoTargetError("Enter one Target item to search.", "configuration", false);
  }
}

function normalizedTcin(value: string) {
  return value.trim();
}

function validateTcin(value: string) {
  if (!/^(?:\d{8}|\d{10})$/.test(value)) {
    throw new DecodoTargetError("Choose a valid Target product ID.", "configuration", false);
  }
}

function getAuthorizationToken() {
  if (typeof window !== "undefined") {
    throw new DecodoTargetError(
      "Decodo Target requests can only run on the Cartiva server.",
      "configuration",
      false,
    );
  }
  const token = process.env.DECODO_AUTH_TOKEN?.trim();
  if (!token || /\s/.test(token)) {
    throw new DecodoTargetError(
      "Decodo Target is not configured on the Cartiva server.",
      "configuration",
      false,
    );
  }
  return token;
}

function requestBodyOptions(body: DecodoRequestBody, options: NormalizedOptions) {
  if (options.headless) body.headless = "html";
  if (!options.deliveryType) return body;
  // Decodo currently rejects valid Target `store_id` values and also rejects
  // `delivery_type: "delivery"`. ZIP-only requests return comparison
  // candidates for every mode, but Target responses do not prove an exact
  // store or fulfillment method, so provenance remains deliberately
  // unverified; only verified extension matches may use Target's visible controls.
  body.delivery_zip = options.deliveryZip;
  return body;
}

function retryAfterMs(response: Response) {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1_000));
  }
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - Date.now()));
}

function responseError(response: Response) {
  const status = response.status;
  if (status === 401 || status === 403) {
    return new DecodoTargetError(
      "Decodo authentication failed. Check the server-side credential.",
      "authentication",
      false,
      status,
    );
  }
  if (status === 400 || status === 422) {
    return new DecodoTargetError(
      "Decodo rejected the Target request parameters.",
      "configuration",
      false,
      status,
    );
  }
  if (status === 404) {
    return new DecodoTargetError("The Target product was not found.", "not_found", false, status);
  }
  if (status === 429) {
    return new DecodoTargetError(
      "Decodo request limit reached. Wait a moment and try again.",
      "rate_limit",
      true,
      status,
      retryAfterMs(response),
    );
  }
  if (status === 408 || status === 524) {
    return new DecodoTargetError(
      "Target data took too long to respond. Please try again.",
      "timeout",
      true,
      status,
    );
  }
  return new DecodoTargetError(
    "Decodo Target data is temporarily unavailable.",
    "api_error",
    status === 204 || status >= 500,
    status,
  );
}

async function fetchDecodoOnce(
  body: DecodoRequestBody,
  token: string,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(DECODO_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 204 || !response.ok) throw responseError(response);
    try {
      return await response.json() as unknown;
    } catch {
      throw malformed("Decodo returned malformed Target data.");
    }
  } catch (error) {
    if (error instanceof DecodoTargetError) throw error;
    if (controller.signal.aborted) {
      throw new DecodoTargetError(
        "Target data request timed out. Please try again.",
        "timeout",
        true,
      );
    }
    // Never reflect a provider/network error: it may contain request details.
    throw new DecodoTargetError(
      "Decodo Target data is temporarily unavailable.",
      "api_error",
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function safeRequestError(error: unknown) {
  return error instanceof DecodoTargetError
    ? error
    : new DecodoTargetError(
      "Decodo Target data is temporarily unavailable.",
      "api_error",
      true,
    );
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function requestDecodo<T>(
  body: DecodoRequestBody,
  token: string,
  parse: (payload: unknown) => T,
): Promise<T> {
  const isDetail = body.target === "target_product";
  const timeoutMs = isDetail ? DETAIL_REQUEST_TIMEOUT_MS : SEARCH_REQUEST_TIMEOUT_MS;
  const maxAttempts = isDetail ? DETAIL_MAX_ATTEMPTS : SEARCH_MAX_ATTEMPTS;
  let lastError = new DecodoTargetError(
    "Decodo Target data is temporarily unavailable.",
    "api_error",
    true,
  );
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await fetchDecodoOnce(body, token, timeoutMs);
      return parse(payload);
    } catch (error) {
      lastError = safeRequestError(error);
      if (!lastError.retryable || attempt === maxAttempts) throw lastError;
      await delay(lastError.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS);
    }
  }
  throw lastError;
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

function cloneProduct(product: DecodoTargetProduct): DecodoTargetProduct {
  return { ...product, provenance: { ...product.provenance } };
}

function pruneCache(cache: Map<string, { expiresAt: number }>) {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function diagnostics(
  startedAt: number,
  cacheHit: boolean,
  deduplicated: boolean,
  apiCall: boolean,
): DecodoTargetCallDiagnostics {
  return {
    cacheHit,
    deduplicated,
    apiCall,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function cacheKey(kind: "search" | "detail", identifier: string, options: NormalizedOptions) {
  return JSON.stringify([
    CACHE_VERSION,
    kind,
    options.deliveryType ?? "",
    options.storeId ?? "",
    options.deliveryZip ?? "",
    options.headless,
    identifier,
  ]);
}

export async function searchDecodoTarget(
  queryValue: string,
  optionsValue: DecodoTargetOptions = {},
  requestSignal?: AbortSignal,
): Promise<DecodoTargetSearchResult> {
  const startedAt = Date.now();
  if (requestSignal?.aborted) throw consumerAbortError();
  const query = normalizedQuery(queryValue);
  validateQuery(query);
  const options = normalizeOptions(optionsValue);
  const token = getAuthorizationToken();
  const key = cacheKey("search", query.toLocaleLowerCase("en-US"), options);

  pruneCache(searchCache);
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      products: cached.products.map(cloneProduct),
      mode: "live",
      diagnostics: diagnostics(startedAt, true, false, false),
    };
  }

  const existing = searchInFlight.get(key);
  if (existing) {
    const products = await waitForSharedRequest(existing, requestSignal);
    return {
      products: products.map(cloneProduct),
      mode: "live",
      diagnostics: diagnostics(startedAt, true, true, false),
    };
  }

  const body = requestBodyOptions({ target: "target_search", query, parse: true }, options);
  const liveRequest = requestDecodo(body, token, (payload) => parseDecodoTargetSearch(payload, {
    ...options,
    checkedAt: new Date().toISOString(),
  })).then((products) => {
    searchCache.set(key, {
      products: products.map(cloneProduct),
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    });
    return products;
  }).finally(() => {
    searchInFlight.delete(key);
  });
  searchInFlight.set(key, liveRequest);

  const products = await waitForSharedRequest(liveRequest, requestSignal);
  return {
    products: products.map(cloneProduct),
    mode: "live",
    diagnostics: diagnostics(startedAt, false, false, true),
  };
}

export async function getDecodoTargetProduct(
  productIdValue: string,
  optionsValue: DecodoTargetOptions = {},
  requestSignal?: AbortSignal,
): Promise<DecodoTargetDetailResult> {
  const startedAt = Date.now();
  if (requestSignal?.aborted) throw consumerAbortError();
  const productId = normalizedTcin(productIdValue);
  validateTcin(productId);
  const options = normalizeOptions(optionsValue);
  const token = getAuthorizationToken();
  const key = cacheKey("detail", productId, options);

  pruneCache(detailCache);
  const cached = detailCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      product: cached.product ? cloneProduct(cached.product) : null,
      mode: "live",
      diagnostics: diagnostics(startedAt, true, false, false),
    };
  }

  const existing = detailInFlight.get(key);
  if (existing) {
    const product = await waitForSharedRequest(existing, requestSignal);
    return {
      product: product ? cloneProduct(product) : null,
      mode: "live",
      diagnostics: diagnostics(startedAt, true, true, false),
    };
  }

  const body = requestBodyOptions(
    { target: "target_product", product_id: productId, parse: true },
    options,
  );
  const liveRequest = requestDecodo(body, token, (payload) => parseDecodoTargetProduct(payload, {
    ...options,
    requestedTcin: productId,
    checkedAt: new Date().toISOString(),
  })).catch((error: unknown) => {
    if (error instanceof DecodoTargetError && error.code === "not_found") return null;
    throw error;
  }).then((product) => {
    detailCache.set(key, {
      product: product ? cloneProduct(product) : null,
      expiresAt: Date.now() + DETAIL_CACHE_TTL_MS,
    });
    return product;
  }).finally(() => {
    detailInFlight.delete(key);
  });
  detailInFlight.set(key, liveRequest);

  const product = await waitForSharedRequest(liveRequest, requestSignal);
  return {
    product: product ? cloneProduct(product) : null,
    mode: "live",
    diagnostics: diagnostics(startedAt, false, false, true),
  };
}
import "./server-only-guard";
