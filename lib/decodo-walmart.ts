import { extractMeasurement } from "./measurements";
import type {
  WalmartFulfillmentType,
  WalmartPriceProvenance,
  WalmartPriceSource,
  WalmartProduct,
  WalmartResponseLocation,
  WalmartSellerType,
} from "./types";
import { resolveWalmartLink } from "./walmart-url";

type UnknownRecord = Record<string, unknown>;

export type DecodoWalmartDeliveryType = "pickup" | "delivery" | "shipping";

export interface DecodoWalmartOptions {
  deliveryType?: DecodoWalmartDeliveryType;
  storeId?: string;
  deliveryZip?: string;
  /** Enables Decodo's JavaScript renderer by sending `headless: "html"`. */
  headless?: boolean;
}

export interface DecodoWalmartParseContext extends DecodoWalmartOptions {
  checkedAt?: string;
  requestedProductId?: string;
}

export interface DecodoWalmartLocationEvidence {
  requestedStoreId?: string;
  requestedZip?: string;
  observedStoreId?: string;
  observedZip?: string;
  observedCity?: string;
  observedState?: string;
  storeMatched?: boolean;
  zipMatched?: boolean;
  /** True only when Decodo's parsed response identifies the requested location. */
  locationVerified: boolean;
}

export interface DecodoWalmartPriceProvenance {
  source: "decodo_walmart_search" | "decodo_walmart_product";
  priceSource: WalmartPriceSource;
  priceScope: "exact_store" | "localized";
  searchPriceCents?: number;
  productDetailPriceCents?: number;
  regularPriceCents?: number;
  salePriceCents?: number;
  sellerType: WalmartSellerType;
  fulfillment: WalmartFulfillmentType[];
  location: DecodoWalmartLocationEvidence;
  localPriceEligible: boolean;
  localPriceVerified: boolean;
  checkedAt: string;
}

/**
 * Faithful provider DTO. Optional catalog fields stay unknown when Decodo does
 * not return them; use `toWalmartProduct` for Cartiva's stricter contract.
 */
export interface DecodoWalmartProduct {
  id: string;
  productId: string;
  itemId?: string;
  upc?: string;
  idSource: "response" | "request";
  requestedProductId?: string;
  title: string;
  /** Exact Decodo value. Search results commonly return a relative `/ip/...` URL. */
  url?: string;
  price?: number;
  priceCents?: number;
  regularPrice?: number;
  regularPriceCents?: number;
  currency?: string;
  brand?: string;
  thumbnail?: string;
  seller?: string;
  sellerId?: string;
  sellerType: WalmartSellerType;
  inStock?: boolean;
  sponsored?: boolean;
  fulfillment: WalmartFulfillmentType[];
  checkedAt: string;
  priceProvenance: DecodoWalmartPriceProvenance;
}

export interface DecodoWalmartCallDiagnostics {
  cacheHit: boolean;
  deduplicated: boolean;
  apiCall: boolean;
  durationMs: number;
}

export interface DecodoWalmartSearchResult {
  products: DecodoWalmartProduct[];
  mode: "live";
  diagnostics: DecodoWalmartCallDiagnostics;
}

export interface DecodoWalmartDetailResult {
  product: DecodoWalmartProduct | null;
  mode: "live";
  diagnostics: DecodoWalmartCallDiagnostics;
}

export type DecodoWalmartErrorCode =
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "not_found"
  | "api_error"
  | "malformed";

/** A sanitized error whose `retryable` flag is safe for server orchestration. */
export class DecodoWalmartError extends Error {
  constructor(
    message: string,
    public readonly code: DecodoWalmartErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DecodoWalmartError";
  }
}

type SearchCacheEntry = { products: DecodoWalmartProduct[]; expiresAt: number };
type DetailCacheEntry = { product: DecodoWalmartProduct | null; expiresAt: number };

declare global {
  var decodoWalmartSearchCacheV1: Map<string, SearchCacheEntry> | undefined;
  var decodoWalmartDetailCacheV1: Map<string, DetailCacheEntry> | undefined;
  var decodoWalmartSearchInFlightV1:
    | Map<string, Promise<DecodoWalmartProduct[]>>
    | undefined;
  var decodoWalmartDetailInFlightV1:
    | Map<string, Promise<DecodoWalmartProduct | null>>
    | undefined;
}

const searchCache = globalThis.decodoWalmartSearchCacheV1
  ?? new Map<string, SearchCacheEntry>();
const detailCache = globalThis.decodoWalmartDetailCacheV1
  ?? new Map<string, DetailCacheEntry>();
const searchInFlight = globalThis.decodoWalmartSearchInFlightV1
  ?? new Map<string, Promise<DecodoWalmartProduct[]>>();
const detailInFlight = globalThis.decodoWalmartDetailInFlightV1
  ?? new Map<string, Promise<DecodoWalmartProduct | null>>();

globalThis.decodoWalmartSearchCacheV1 = searchCache;
globalThis.decodoWalmartDetailCacheV1 = detailCache;
globalThis.decodoWalmartSearchInFlightV1 = searchInFlight;
globalThis.decodoWalmartDetailInFlightV1 = detailInFlight;

const DECODO_ENDPOINT = "https://scraper-api.decodo.com/v2/scrape";
const CACHE_VERSION = "decodo-walmart-fulfillment-handoff-v2";
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1_000;
const DETAIL_CACHE_TTL_MS = 45 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 1_000;
const MAX_CACHE_ENTRIES = 200;
const WALMART_SELLER_ID = "F55CDC31AB754BB68FE0B39041159D63";

type NormalizedOptions = {
  deliveryType?: DecodoWalmartDeliveryType;
  storeId?: string;
  deliveryZip?: string;
  headless: boolean;
};

type DecodoRequestBody = {
  target: "walmart_search" | "walmart_product";
  parse: true;
  query?: string;
  product_id?: string;
  headless?: "html";
  fulfillment_type?: "in_store";
  delivery_type?: DecodoWalmartDeliveryType;
  store_id?: string;
  delivery_zip?: string;
};

type ParsedLocation = {
  storeId?: string;
  zip?: string;
  city?: string;
  state?: string;
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

/** Preserves a non-empty upstream string without trimming or normalization. */
function exactText(...values: unknown[]) {
  return values.find((value): value is string => (
    typeof value === "string" && value.trim().length > 0
  ));
}

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

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function stockValue(...values: unknown[]): boolean | undefined {
  const visited = new Set<object>();
  const visit = (value: unknown): boolean | undefined => {
    if (typeof value === "boolean") return value;
    const record = asRecord(value);
    if (record) {
      if (visited.has(record)) return undefined;
      visited.add(record);
      for (const nested of [
        record.in_stock,
        record.available,
        record.is_available,
        record.availability_status,
        record.status,
        record.state,
      ]) {
        const parsed = visit(nested);
        if (parsed !== undefined) return parsed;
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
    const parsed = visit(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function fulfillmentFor(value: unknown) {
  const fulfillment = asRecord(value);
  const types: WalmartFulfillmentType[] = [];
  const add = (type: WalmartFulfillmentType) => {
    if (!types.includes(type)) types.push(type);
  };
  if (booleanValue(fulfillment?.in_store) === true) add("in_store");
  if (booleanValue(fulfillment?.pickup) === true) add("pickup");
  if (booleanValue(fulfillment?.delivery) === true) add("delivery");
  if (booleanValue(fulfillment?.shipping) === true) add("shipping");
  const typeText = exactText(fulfillment?.type, fulfillment?.fulfillment_type) ?? "";
  if (/in[\s_-]*store/i.test(typeText)) add("in_store");
  if (/pickup/i.test(typeText)) add("pickup");
  if (/delivery/i.test(typeText)) add("delivery");
  if (/shipping/i.test(typeText)) add("shipping");
  return types;
}

function sellerTypeFor(seller: UnknownRecord | undefined): WalmartSellerType {
  const id = exactIdentifier(seller?.id, seller?.seller_id);
  const name = exactText(seller?.name, seller?.official_name);
  if (
    id?.trim().toUpperCase() === WALMART_SELLER_ID
    || /^(?:walmart(?:\.com)?|wal-mart)$/i.test(name?.trim() ?? "")
  ) return "walmart";
  return id || name ? "marketplace" : "unknown";
}

function parseLocation(value: unknown): ParsedLocation | undefined {
  const location = asRecord(value);
  if (!location) return undefined;
  const parsed = {
    storeId: exactIdentifier(location.store_id, location.storeId),
    zip: exactText(location.zip_code, location.zipcode, location.postal_code),
    city: exactText(location.city),
    state: exactText(location.state, location.state_code),
  };
  return parsed.storeId || parsed.zip || parsed.city || parsed.state ? parsed : undefined;
}

function locationEvidenceFor(
  context: DecodoWalmartParseContext,
  observed?: ParsedLocation,
): DecodoWalmartLocationEvidence {
  const requestedStoreId = context.storeId?.trim() || undefined;
  const requestedZip = context.deliveryZip?.trim() || undefined;
  const observedStoreId = observed?.storeId;
  const observedZip = observed?.zip;
  const storeMatched = requestedStoreId && observedStoreId
    ? requestedStoreId === observedStoreId.trim()
    : undefined;
  const zipMatched = requestedZip && observedZip
    ? requestedZip.slice(0, 5) === observedZip.trim().slice(0, 5)
    : undefined;
  return {
    requestedStoreId,
    requestedZip,
    observedStoreId,
    observedZip,
    observedCity: observed?.city,
    observedState: observed?.state,
    storeMatched,
    zipMatched,
    locationVerified: storeMatched === true || zipMatched === true,
  };
}

function checkedAtFor(context: DecodoWalmartParseContext) {
  return context.checkedAt ?? new Date().toISOString();
}

function priceProvenanceFor(args: {
  source: DecodoWalmartPriceProvenance["source"];
  context: DecodoWalmartParseContext;
  observedLocation?: ParsedLocation;
  price?: number;
  regularPrice?: number;
  sellerType: WalmartSellerType;
  fulfillment: WalmartFulfillmentType[];
  inStock?: boolean;
  checkedAt: string;
}): DecodoWalmartPriceProvenance {
  const location = locationEvidenceFor(args.context, args.observedLocation);
  const requestedPickupAvailable = args.context.deliveryType === "pickup"
    && (args.fulfillment.includes("pickup") || args.fulfillment.includes("in_store"));
  // Decodo's parsed Walmart Search response can identify the exact store and
  // stock state while leaving every fulfillment flag false. Product details
  // for the selected item supply the pickup signal. Allow that exact-store
  // Search offer to reach verification, but never mark it verified until the
  // detail response confirms pickup/in-store availability at the same store.
  const pickupAwaitsProductDetail = Boolean(
    args.source === "decodo_walmart_search"
    && args.context.deliveryType === "pickup"
    && args.fulfillment.length === 0
    && location.storeMatched === true,
  );
  const responseMatchesRequestedStore = location.storeMatched === true;
  const localPriceEligible = Boolean(
    args.sellerType === "walmart"
    && args.inStock === true
    && responseMatchesRequestedStore
    && (requestedPickupAvailable || pickupAwaitsProductDetail),
  );
  const localPriceVerified = Boolean(localPriceEligible && requestedPickupAvailable);
  const exactStoreScoped = args.source === "decodo_walmart_search"
    ? responseMatchesRequestedStore
    : localPriceVerified;
  const amountCents = priceCents(args.price);
  const regularPriceCents = priceCents(args.regularPrice);
  const isSale = Boolean(
    args.price !== undefined
    && args.regularPrice !== undefined
    && args.regularPrice > args.price,
  );
  let priceSource: WalmartPriceSource;
  if (args.source === "decodo_walmart_product") priceSource = "product_detail";
  else if (args.sellerType === "marketplace") priceSource = "marketplace_search";
  else if (exactStoreScoped) priceSource = isSale ? "local_store_sale" : "local_store_search";
  else priceSource = "walmart_search";
  return {
    source: args.source,
    priceSource,
    priceScope: exactStoreScoped ? "exact_store" : "localized",
    searchPriceCents: args.source === "decodo_walmart_search" ? amountCents : undefined,
    productDetailPriceCents: args.source === "decodo_walmart_product" ? amountCents : undefined,
    regularPriceCents,
    salePriceCents: isSale ? amountCents : undefined,
    sellerType: args.sellerType,
    fulfillment: [...args.fulfillment],
    location,
    localPriceEligible,
    localPriceVerified,
    checkedAt: args.checkedAt,
  };
}

function malformed(message: string) {
  return new DecodoWalmartError(message, "malformed", true);
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
      throw new DecodoWalmartError("The Walmart product was not found.", "not_found", false);
    }
    if (code === 12003) {
      throw new DecodoWalmartError(
        "Decodo does not support parsing this Walmart request.",
        "configuration",
        false,
      );
    }
    if (code >= 12000 && code < 13000) {
      throw malformed("Decodo could not parse the Walmart response.");
    }
  }
}

function contentRecords(payload: unknown) {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.results)) {
    throw malformed("Decodo returned malformed Walmart data.");
  }
  const records = root.results
    .map((result) => asRecord(asRecord(result)?.content))
    .filter((content): content is UnknownRecord => Boolean(content));
  if (records.length === 0) throw malformed("Decodo returned malformed Walmart data.");
  return records;
}

function parseSearchItem(
  value: unknown,
  context: DecodoWalmartParseContext,
  observedLocation?: ParsedLocation,
): DecodoWalmartProduct | null {
  const product = asRecord(value);
  const general = asRecord(product?.general);
  if (!product || !general) return null;
  const meta = asRecord(general.meta);
  const productId = exactIdentifier(general.product_id, meta?.sku, product.product_id);
  const title = exactText(general.title, product.title);
  if (!productId || !title) return null;

  const priceRecord = asRecord(product.price);
  const price = moneyValue(priceRecord?.price, product.current_price);
  const regularPrice = moneyValue(
    priceRecord?.price_strikethrough,
    priceRecord?.regular_price,
    product.regular_price,
  );
  const seller = asRecord(product.seller);
  const sellerType = sellerTypeFor(seller);
  const fulfillment = fulfillmentFor(product.fulfillment);
  const explicitStock = stockValue(
    general.in_stock,
    typeof general.out_of_stock === "boolean" ? !general.out_of_stock : undefined,
    product.in_stock,
  );
  const inStock = explicitStock ?? (fulfillment.length > 0 ? true : undefined);
  const checkedAt = checkedAtFor(context);
  const priceProvenance = priceProvenanceFor({
    source: "decodo_walmart_search",
    context,
    observedLocation,
    price,
    regularPrice,
    sellerType,
    fulfillment,
    inStock,
    checkedAt,
  });
  return {
    id: productId,
    productId,
    itemId: exactIdentifier(general.item_id, meta?.sku, productId),
    upc: exactIdentifier(meta?.gtin, general.gtin, general.upc),
    idSource: "response",
    title,
    url: exactText(general.url, product.url),
    price,
    priceCents: priceCents(price),
    regularPrice,
    regularPriceCents: priceCents(regularPrice),
    currency: exactText(priceRecord?.currency, product.currency),
    brand: exactText(general.brand, product.brand),
    thumbnail: exactText(general.image, general.thumbnail, general.main_image),
    seller: exactText(seller?.name, seller?.official_name),
    sellerId: exactIdentifier(seller?.id, seller?.seller_id),
    sellerType,
    inStock,
    sponsored: booleanValue(general.sponsored),
    fulfillment,
    checkedAt,
    priceProvenance,
  };
}

/** Parses Decodo's documented `walmart_search` response envelope. */
export function parseDecodoWalmartSearch(
  payload: unknown,
  context: DecodoWalmartParseContext = {},
): DecodoWalmartProduct[] {
  throwForParsedStatus(payload);
  const checkedAt = checkedAtFor(context);
  const parseContext = { ...context, checkedAt };
  const products: DecodoWalmartProduct[] = [];
  let foundResultList = false;

  for (const content of contentRecords(payload)) {
    const parsed = asRecord(content.results);
    if (!parsed) continue;
    const nested = asRecord(parsed.results);
    const rawProducts = Array.isArray(parsed.results)
      ? parsed.results
      : Array.isArray(parsed.organic)
        ? parsed.organic
        : Array.isArray(nested?.organic)
          ? nested.organic
          : undefined;
    if (!rawProducts) continue;
    foundResultList = true;
    const observedLocation = parseLocation(parsed.location);
    for (const productValue of rawProducts) {
      const product = parseSearchItem(productValue, parseContext, observedLocation);
      if (product) products.push(product);
    }
  }

  if (!foundResultList) throw malformed("Decodo returned malformed Walmart search data.");
  return products;
}

/** Parses Decodo's documented `walmart_product` response envelope. */
export function parseDecodoWalmartProduct(
  payload: unknown,
  context: DecodoWalmartParseContext = {},
): DecodoWalmartProduct | null {
  try {
    throwForParsedStatus(payload);
  } catch (error) {
    if (error instanceof DecodoWalmartError && error.code === "not_found") return null;
    throw error;
  }

  const product = contentRecords(payload)
    .map((content) => asRecord(content.results))
    .find((candidate): candidate is UnknownRecord => Boolean(candidate));
  if (!product) throw malformed("Decodo returned malformed Walmart product data.");
  const general = asRecord(product.general);
  if (!general) throw malformed("Decodo returned incomplete Walmart product data.");
  const meta = asRecord(general.meta);
  const returnedProductId = exactIdentifier(
    meta?.sku,
    general.product_id,
    product.product_id,
  );
  const requestedProductId = context.requestedProductId?.trim() || undefined;
  const productId = returnedProductId ?? requestedProductId;
  const title = exactText(general.title, product.title);
  if (!productId || !title) throw malformed("Decodo returned incomplete Walmart product data.");

  const priceRecord = asRecord(product.price);
  const price = moneyValue(priceRecord?.price, product.current_price);
  const regularPrice = moneyValue(
    priceRecord?.price_strikethrough,
    priceRecord?.regular_price,
    product.regular_price,
  );
  const seller = asRecord(product.seller);
  const sellerType = sellerTypeFor(seller);
  const fulfillment = fulfillmentFor(product.fulfillment);
  const explicitStock = stockValue(
    general.in_stock,
    typeof general.out_of_stock === "boolean" ? !general.out_of_stock : undefined,
    product.in_stock,
    product.availability,
    product.availability_status,
  );
  const inStock = explicitStock ?? (fulfillment.length > 0 ? true : undefined);
  const observedLocation = parseLocation(product.location);
  const checkedAt = checkedAtFor(context);
  const priceProvenance = priceProvenanceFor({
    source: "decodo_walmart_product",
    context,
    observedLocation,
    price,
    regularPrice,
    sellerType,
    fulfillment,
    inStock,
    checkedAt,
  });
  const images = Array.isArray(general.images) ? general.images : [];
  return {
    id: productId,
    productId,
    itemId: exactIdentifier(general.item_id, meta?.sku, productId),
    upc: exactIdentifier(meta?.gtin, general.gtin, general.upc),
    idSource: returnedProductId ? "response" : "request",
    requestedProductId,
    title,
    url: exactText(general.url, product.url),
    price,
    priceCents: priceCents(price),
    regularPrice,
    regularPriceCents: priceCents(regularPrice),
    currency: exactText(priceRecord?.currency, product.currency),
    brand: exactText(general.brand, product.brand),
    thumbnail: exactText(general.image, images[0], general.main_image),
    seller: exactText(seller?.name, seller?.official_name),
    sellerId: exactIdentifier(seller?.id, seller?.seller_id),
    sellerType,
    inStock,
    sponsored: false,
    fulfillment,
    checkedAt,
    priceProvenance,
  };
}

function responseLocationFor(
  evidence: DecodoWalmartLocationEvidence,
): WalmartResponseLocation | undefined {
  if (
    !evidence.observedStoreId
    && !evidence.observedZip
    && !evidence.observedCity
    && !evidence.observedState
  ) return undefined;
  return {
    storeId: evidence.observedStoreId,
    postalCode: evidence.observedZip,
    city: evidence.observedCity,
    provinceCode: evidence.observedState,
    country: "US",
  };
}

function adapterProductUrl(sourceUrl: string | undefined) {
  if (!sourceUrl?.startsWith("/")) return sourceUrl;
  try {
    return new URL(sourceUrl, "https://www.walmart.com").toString();
  } catch {
    return sourceUrl;
  }
}

/**
 * Converts a faithful Decodo DTO into Cartiva's stricter Walmart contract.
 * Returns null rather than inventing a missing price or stock state.
 */
export function toWalmartProduct(product: DecodoWalmartProduct): WalmartProduct | null {
  if (product.price === undefined || product.inStock === undefined) return null;
  const provenance = product.priceProvenance;
  const responseLocation = responseLocationFor(provenance.location);
  const isSearch = provenance.source === "decodo_walmart_search";
  const resolvedLink = resolveWalmartLink(
    product.title,
    adapterProductUrl(product.url),
    [product.itemId, product.productId],
  );
  const walmartProvenance: WalmartPriceProvenance = {
    priceSource: provenance.priceSource,
    priceScope: provenance.priceScope,
    searchPriceCents: provenance.searchPriceCents,
    productDetailPriceCents: provenance.productDetailPriceCents,
    regularPriceCents: provenance.regularPriceCents,
    salePriceCents: provenance.salePriceCents,
    requestedStoreId: provenance.location.requestedStoreId,
    searchStoreId: isSearch ? provenance.location.observedStoreId : undefined,
    detailStoreId: isSearch ? undefined : provenance.location.observedStoreId,
    searchLocation: isSearch ? responseLocation : undefined,
    detailLocation: isSearch ? undefined : responseLocation,
    searchStoreMatched: isSearch ? provenance.location.storeMatched : undefined,
    detailStoreMatched: isSearch ? undefined : provenance.location.storeMatched,
    fulfillment: [...provenance.fulfillment],
    sellerType: provenance.sellerType,
    localPriceEligible: provenance.localPriceEligible,
    localPriceVerified: provenance.localPriceVerified,
    verifiedFulfillmentMode: provenance.localPriceVerified ? "pickup" : undefined,
    checkedAt: provenance.checkedAt,
  };
  return {
    retailer: "walmart",
    id: product.id,
    productId: product.productId,
    itemId: product.itemId,
    upc: product.upc,
    title: product.title,
    price: product.price,
    priceCents: product.priceCents,
    priceProvenance: walmartProvenance,
    ...resolvedLink,
    // Keep the exact provider URL even when `link` normalizes a relative value.
    sourceUrl: product.url,
    thumbnail: product.thumbnail,
    seller: product.seller,
    brand: product.brand,
    inStock: product.inStock,
    sponsored: product.sponsored === true,
    size: extractMeasurement(product.title),
    checkedAt: product.checkedAt,
    verification: "unverified",
    dataSource: "decodo",
  };
}

export function toWalmartProducts(products: DecodoWalmartProduct[]) {
  return products
    .map(toWalmartProduct)
    .filter((product): product is WalmartProduct => Boolean(product));
}

function normalizeOptions(options: DecodoWalmartOptions): NormalizedOptions {
  const deliveryType = options.deliveryType;
  const storeId = options.storeId?.trim() || undefined;
  const deliveryZip = options.deliveryZip?.trim() || undefined;
  if (options.headless !== undefined && typeof options.headless !== "boolean") {
    throw new DecodoWalmartError("Choose a valid Decodo rendering mode.", "configuration", false);
  }
  if (
    deliveryType !== undefined
    && deliveryType !== "pickup"
    && deliveryType !== "delivery"
    && deliveryType !== "shipping"
  ) {
    throw new DecodoWalmartError("Choose a valid Walmart fulfillment type.", "configuration", false);
  }
  if (!deliveryType && (storeId || deliveryZip)) {
    throw new DecodoWalmartError(
      "Choose a Walmart fulfillment type for the requested location.",
      "configuration",
      false,
    );
  }
  if (deliveryType === "pickup") {
    if (
      !storeId
      || !/^[A-Za-z0-9]{3,4}$/.test(storeId)
      || !deliveryZip
      || !/^\d{5}(?:-\d{4})?$/.test(deliveryZip)
    ) {
      throw new DecodoWalmartError(
        "Choose one valid Walmart pickup store and ZIP code.",
        "configuration",
        false,
      );
    }
  }
  if (deliveryType === "delivery" || deliveryType === "shipping") {
    if (!deliveryZip || !/^\d{5}(?:-\d{4})?$/.test(deliveryZip) || storeId) {
      throw new DecodoWalmartError(
        "Enter one valid delivery ZIP for Walmart.",
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
    throw new DecodoWalmartError("Enter one Walmart item to search.", "configuration", false);
  }
}

function normalizedProductId(value: string) {
  return value.trim();
}

function validateProductId(value: string) {
  if (!value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DecodoWalmartError("Choose a valid Walmart product ID.", "configuration", false);
  }
}

function getAuthorizationToken() {
  if (typeof window !== "undefined") {
    throw new DecodoWalmartError(
      "Decodo Walmart requests can only run on the Cartiva server.",
      "configuration",
      false,
    );
  }
  const token = process.env.DECODO_AUTH_TOKEN?.trim();
  if (!token || /\s/.test(token)) {
    throw new DecodoWalmartError(
      "Decodo Walmart is not configured on the Cartiva server.",
      "configuration",
      false,
    );
  }
  return token;
}

function requestBodyOptions(
  body: DecodoRequestBody,
  options: NormalizedOptions,
) {
  if (options.headless) body.headless = "html";
  if (!options.deliveryType) return body;
  if (body.target === "walmart_search") {
    // Decodo currently rejects `store_id` even for valid Walmart stores. ZIP
    // localization returns an observed store in the parsed response, which we
    // compare against the requested store before trusting a local price.
    if (options.deliveryType === "pickup") {
      body.delivery_zip = options.deliveryZip;
    } else {
      body.delivery_zip = options.deliveryZip;
    }
    return body;
  }
  if (options.deliveryType === "pickup") {
    body.delivery_zip = options.deliveryZip;
  } else {
    body.delivery_type = options.deliveryType;
    body.delivery_zip = options.deliveryZip;
  }
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
    return new DecodoWalmartError(
      "Decodo authentication failed. Check the server-side credential.",
      "authentication",
      false,
      status,
    );
  }
  if (status === 400 || status === 422) {
    return new DecodoWalmartError(
      "Decodo rejected the Walmart request parameters.",
      "configuration",
      false,
      status,
    );
  }
  if (status === 404) {
    return new DecodoWalmartError("The Walmart product was not found.", "not_found", false, status);
  }
  if (status === 429) {
    return new DecodoWalmartError(
      "Decodo request limit reached. Wait a moment and try again.",
      "rate_limit",
      true,
      status,
      retryAfterMs(response),
    );
  }
  if (status === 408 || status === 524) {
    return new DecodoWalmartError(
      "Walmart data took too long to respond. Please try again.",
      "timeout",
      true,
      status,
    );
  }
  return new DecodoWalmartError(
    "Decodo Walmart data is temporarily unavailable.",
    "api_error",
    status === 202 || status === 204 || status >= 500,
    status,
  );
}

async function fetchDecodoOnce(body: DecodoRequestBody, token: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
    if (response.status === 202 || response.status === 204 || !response.ok) {
      throw responseError(response);
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw malformed("Decodo returned malformed Walmart data.");
    }
  } catch (error) {
    if (error instanceof DecodoWalmartError) throw error;
    if (controller.signal.aborted) {
      throw new DecodoWalmartError(
        "Walmart data request timed out. Please try again.",
        "timeout",
        true,
      );
    }
    // Never reflect a fetch error: runtime messages may include request details.
    throw new DecodoWalmartError(
      "Decodo Walmart data is temporarily unavailable.",
      "api_error",
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function safeRequestError(error: unknown) {
  return error instanceof DecodoWalmartError
    ? error
    : new DecodoWalmartError(
      "Decodo Walmart data is temporarily unavailable.",
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
  let lastError = new DecodoWalmartError(
    "Decodo Walmart data is temporarily unavailable.",
    "api_error",
    true,
  );
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const payload = await fetchDecodoOnce(body, token);
      return parse(payload);
    } catch (error) {
      lastError = safeRequestError(error);
      if (!lastError.retryable || attempt === MAX_ATTEMPTS) throw lastError;
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

function cloneProduct(product: DecodoWalmartProduct): DecodoWalmartProduct {
  return {
    ...product,
    fulfillment: [...product.fulfillment],
    priceProvenance: {
      ...product.priceProvenance,
      fulfillment: [...product.priceProvenance.fulfillment],
      location: { ...product.priceProvenance.location },
    },
  };
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
): DecodoWalmartCallDiagnostics {
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

export async function searchDecodoWalmart(
  queryValue: string,
  optionsValue: DecodoWalmartOptions = {},
  requestSignal?: AbortSignal,
): Promise<DecodoWalmartSearchResult> {
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

  const body = requestBodyOptions({ target: "walmart_search", query, parse: true }, options);
  const liveRequest = requestDecodo(body, token, (payload) => parseDecodoWalmartSearch(payload, {
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

export async function getDecodoWalmartProduct(
  productIdValue: string,
  optionsValue: DecodoWalmartOptions = {},
  requestSignal?: AbortSignal,
): Promise<DecodoWalmartDetailResult> {
  const startedAt = Date.now();
  if (requestSignal?.aborted) throw consumerAbortError();
  const productId = normalizedProductId(productIdValue);
  validateProductId(productId);
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
    { target: "walmart_product", product_id: productId, parse: true },
    options,
  );
  const liveRequest = requestDecodo(body, token, (payload) => parseDecodoWalmartProduct(payload, {
    ...options,
    requestedProductId: productId,
    checkedAt: new Date().toISOString(),
  })).catch((error: unknown) => {
    if (error instanceof DecodoWalmartError && error.code === "not_found") return null;
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
