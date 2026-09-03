import { extractMeasurement } from "./measurements";
import {
  COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE,
  COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE,
  COUNTED_CONTENT_UNIT_PATTERN_SOURCE,
} from "@/packages/shared/src/package-grammar";
import { getKrogerAuthClient, KrogerAuthClient, KrogerAuthError } from "./kroger-auth";
import {
  KROGER_FAMILY_HOSTS,
  krogerFamilyDisplayName,
  krogerFamilyDomain,
} from "./kroger-family-links";
import type {
  KrogerProduct,
  RetailFulfillmentMode,
} from "./types";

type UnknownRecord = Record<string, unknown>;

const SEARCH_CACHE_TTL_MS = 2 * 60_000;
const LOCATION_CACHE_TTL_MS = 30 * 60_000;
const PHYSICAL_OUTER_PACKAGE_UNIT = "bags?|bottles?|boxes?|canisters?|cans?|cartons?|containers?|jars?|pouches?|trays?|tubs?";
const PHYSICAL_UNIT = "fl\\s*oz|fluid\\s+ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|liters?|litres?|milliliters?|millilitres?|gallons?|gal|quarts?|qt|pints?|pt|ml|l";

interface Cached<T> {
  expiresAt: number;
  value: T;
}

interface KrogerProviderGlobal {
  searchCache: Map<string, Cached<KrogerProduct[]>>;
  locationCache: Map<string, Cached<KrogerLocation>>;
  zipLocationsCache: Map<string, Cached<KrogerLocation[]>>;
  searches: Map<string, Promise<KrogerProduct[]>>;
  locations: Map<string, Promise<KrogerLocation>>;
  zipLocations: Map<string, Promise<KrogerLocation[]>>;
  verifiedCartProducts: Map<string, number>;
}

export interface KrogerLocation {
  locationId: string;
  name: string;
  chain: string;
  address: {
    addressLine1: string;
    city: string;
    state: string;
    zipCode: string;
  };
  phone?: string;
  departments: string[];
}

export interface KrogerProviderDiagnostics {
  apiCall: boolean;
  cacheHit: boolean;
  deduplicated: boolean;
  durationMs: number;
}

export interface KrogerSearchResponse {
  products: KrogerProduct[];
  diagnostics: KrogerProviderDiagnostics;
}

export interface KrogerLocationsResponse {
  zipCode: string;
  locations: KrogerLocation[];
  diagnostics: KrogerProviderDiagnostics;
}

export type KrogerCartModality = "PICKUP" | "DELIVERY";

export interface KrogerCartItem {
  upc: string;
  quantity: number;
  modality: KrogerCartModality;
}

export function isValidKrogerLocationId(value: string) {
  return /^[A-Za-z0-9]{4,16}$/.test(value);
}

export class KrogerProviderError extends Error {
  constructor(
    message: string,
    readonly code: "bad_response" | "not_found" | "rate_limit" | "upstream" | "outcome_unknown",
    readonly status = 502,
  ) {
    super(message);
    this.name = "KrogerProviderError";
  }
}

type ProviderGlobal = typeof globalThis & {
  __cartivaKrogerProvider?: KrogerProviderGlobal;
};

function providerState() {
  const globalState = globalThis as ProviderGlobal;
  globalState.__cartivaKrogerProvider ??= {
    searchCache: new Map(),
    locationCache: new Map(),
    zipLocationsCache: new Map(),
    searches: new Map(),
    locations: new Map(),
    zipLocations: new Map(),
    verifiedCartProducts: new Map(),
  };
  return globalState.__cartivaKrogerProvider;
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function records(value: unknown) {
  const flattened = Array.isArray(value) ? value.flat(1) : [];
  return flattened.length
    ? flattened.map(record).filter((entry): entry is UnknownRecord => Boolean(entry))
    : [];
}

function textValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const cleaned = String(value).replace(/\s+/g, " ").trim();
    if (cleaned) return cleaned;
  }
  return undefined;
}

function numberValue(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === "number"
      ? value
      : typeof value === "string" ? Number(value.replace(/[$,]/g, "")) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanValue(value: unknown) {
  return value === true || value === "true";
}

function productImage(raw: UnknownRecord) {
  const images = records(raw.images);
  const prioritized = [...images].sort((a, b) => Number(booleanValue(b.featured) || booleanValue(b.default))
    - Number(booleanValue(a.featured) || booleanValue(a.default)));
  for (const image of prioritized) {
    const direct = textValue(image.url);
    if (direct) return direct;
    const sizes = records(image.sizes);
    const preferred = sizes.find((size) => /large|medium/i.test(textValue(size.size) ?? "")) ?? sizes[0];
    const url = textValue(preferred?.url);
    if (url) return url;
  }
  return undefined;
}

function fulfillmentFor(item: UnknownRecord) {
  const fulfillment = record(item.fulfillment);
  const modes: RetailFulfillmentMode[] = [];
  if (booleanValue(fulfillment?.curbside)) modes.push("pickup");
  if (booleanValue(fulfillment?.delivery)) modes.push("delivery");
  if (booleanValue(fulfillment?.shipping)) modes.push("shipping");
  return modes;
}

type RequestedFulfillmentEvidence = "supported" | "unsupported" | "unknown";

/**
 * Retailer omission is not a negative signal. Kroger may return a product from
 * a fulfillment-filtered search without repeating the requested boolean on
 * every item. Only an explicit false value is treated as unsupported.
 */
function requestedFulfillmentEvidence(
  item: UnknownRecord,
  mode: RetailFulfillmentMode,
): RequestedFulfillmentEvidence {
  const fulfillment = record(item.fulfillment);
  if (!fulfillment) return "unknown";
  const key = mode === "pickup" ? "curbside" : mode;
  const value = fulfillment[key];
  if (value === true || value === "true") return "supported";
  if (value === false || value === "false") return "unsupported";
  return "unknown";
}

function requestedFulfillmentFilter(mode: RetailFulfillmentMode) {
  if (mode === "pickup") return "csp";
  if (mode === "delivery") return "dth";
  return "sth";
}

function safeProductLink(
  raw: UnknownRecord,
  chain: string | undefined,
  title: string,
  expectedIds: readonly string[],
) {
  const domain = krogerFamilyDomain(chain) ?? "www.kroger.com";
  const supplied = textValue(raw.productPageURI, raw.productPageUri, raw.productPageUrl);
  if (supplied) {
    try {
      const parsed = new URL(supplied, `https://${domain}`);
      const pathId = parsed.pathname.match(/\/p\/[^/]+\/(\d{8,14})\/?$/i)?.[1];
      if (
        parsed.protocol === "https:"
        && KROGER_FAMILY_HOSTS.has(parsed.hostname.toLowerCase())
        && pathId
        && expectedIds.includes(pathId)
      ) {
        const sourceUrl = parsed.toString();
        parsed.hostname = domain;
        parsed.search = "";
        parsed.hash = "";
        return {
          link: parsed.toString(),
          linkType: "product" as const,
          sourceUrl,
        };
      }
    } catch {
      // Fall through to a banner-safe search URL.
    }
  }
  return {
    link: `https://${domain}/search?query=${encodeURIComponent(title)}`,
    linkType: "search" as const,
    sourceUrl: undefined,
  };
}

function normalizeKrogerProduct(
  raw: UnknownRecord,
  context: {
    locationId: string;
    /** True only after GET /locations/{id} echoed the same official ID. */
    locationVerified: true;
    locationName?: string;
    chain?: string;
    fulfillmentMode: RetailFulfillmentMode;
    checkedAt: string;
  },
): KrogerProduct | null {
  const productId = textValue(raw.productId);
  // Kroger's Products contract exposes productId and UPC independently, while
  // Cart API writes specifically require `upc`. Never relabel productId as a
  // shopper-cart identifier when the provider omitted explicit UPC evidence.
  const upc = textValue(raw.upc);
  const title = textValue(raw.description);
  if (!productId || !upc || !title || !/^\d{8,14}$/.test(upc)) return null;

  const items = records(raw.items);
  const selectedItem = items.find((item) => (
    requestedFulfillmentEvidence(item, context.fulfillmentMode) === "supported"
  )) ?? items.find((item) => (
    requestedFulfillmentEvidence(item, context.fulfillmentMode) === "unknown"
  )) ?? items[0];
  if (!selectedItem) return null;
  const price = record(selectedItem.price);
  const regularPrice = numberValue(price?.regular);
  const promoPrice = numberValue(price?.promo);
  // The Products response exposes a promo amount but no normalized evidence
  // here that it is unconditional (rather than loyalty-, coupon-, or
  // quantity-dependent). Keep it as provenance, but use only the regular
  // amount as Cartiva's truthful comparison baseline.
  const currentPrice = regularPrice && regularPrice > 0 ? regularPrice : undefined;
  if (!currentPrice || currentPrice <= 0) return null;

  const stockLevel = textValue(record(selectedItem.inventory)?.stockLevel)?.toUpperCase();
  const reportedFulfillment = fulfillmentFor(selectedItem);
  const fulfillmentEvidence = requestedFulfillmentEvidence(
    selectedItem,
    context.fulfillmentMode,
  );
  // Inclusion in a request filtered to this fulfillment mode is sufficient to
  // attempt the UPC when the per-item boolean is omitted. Preserve that scope
  // in provenance without turning the missing inventory signal into stock.
  const fulfillment = fulfillmentEvidence === "unknown"
    ? [...new Set([...reportedFulfillment, context.fulfillmentMode])]
    : reportedFulfillment;
  const availabilityStatus = fulfillmentEvidence === "unsupported"
    ? "out_of_stock"
    : stockLevel === "HIGH" || stockLevel === "LOW"
      ? "in_stock"
      : stockLevel && /OUT_OF_STOCK|TEMPORARILY_OUT|UNAVAILABLE|ZERO|NONE|^0$/.test(stockLevel)
      ? "out_of_stock"
      : fulfillmentEvidence === "supported"
        ? "likely_available"
        : "unknown";
  const sizeText = textValue(selectedItem.size) ?? "";
  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter((value): value is string => typeof value === "string")
    : [];
  const brand = textValue(raw.brand);
  const productType = categories[0];
  // The selected item size is retailer metadata for the sellable UPC and is
  // more authoritative than numbers embedded in marketing/nutrition title
  // text. Fall back to the title only when Kroger omits that field.
  const retailerSize = extractMeasurement(sizeText);
  const titleSize = extractMeasurement(title);
  const titleNamedOuterCount = Number(title.match(new RegExp(
    `\\b(\\d+(?:\\.\\d+)?)\\s+(?:of\\s+)?(?:${PHYSICAL_OUTER_PACKAGE_UNIT})\\b`,
    "i",
  ))?.[1]);
  const trailingPhysicalTotal = title.match(new RegExp(
    `\\b(\\d+(?:\\.\\d+)?\\s*(?:${PHYSICAL_UNIT}))\\b\\s+total\\b`,
    "i",
  ))?.[1];
  const netPhysicalTotal = title.match(new RegExp(
    `\\bnet\\s*(?:wt|weight|contents?)\\s*[:.,-]?\\s*(\\d+(?:\\.\\d+)?\\s*(?:${PHYSICAL_UNIT}))\\b`,
    "i",
  ))?.[1];
  const explicitPhysicalTotalSize = extractMeasurement(
    trailingPhysicalTotal ?? netPhysicalTotal ?? "",
  );
  const titleDeclaresPhysicalTotal = Boolean(explicitPhysicalTotalSize);
  const namedOuterPhysicalSize = Number.isFinite(titleNamedOuterCount)
    && titleNamedOuterCount > 1
    && retailerSize
    && retailerSize.kind !== "count"
    && !titleDeclaresPhysicalTotal
    && (!titleSize || titleSize.kind === "count")
      ? extractMeasurement(`${title} ${sizeText} each`)
      : undefined;
  const titleHasMeasuredCountedContents = new RegExp(
    `\\b\\d+(?:\\.\\d+)?${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(?:${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b`,
    "i",
  ).test(title);
  const titleHasExplicitCount = /\b\d+(?:\.\d+)?[\s-]*(?:count|ct)\b/i.test(title);
  const titleExplicitCount = Number(title.match(
    /\b(\d+(?:\.\d+)?)[\s-]*(?:count|ct)\b/i,
  )?.[1]);
  const explicitTitleCountSize = Number.isFinite(titleExplicitCount) && titleExplicitCount > 1
    ? extractMeasurement(`${titleExplicitCount} count`)
    : undefined;
  const titleHasDozen = /\b(?:one|a)\s+dozen\b/i.test(title);
  const titleExplainsOuterCount = titleSize?.kind === "count"
    && retailerSize?.kind === "count"
    && (
      (Boolean(titleSize.packCount) && retailerSize.baseAmount === titleSize.packCount)
      || (
        retailerSize.baseAmount === 1
        && titleSize.baseAmount > 1
        && (titleHasMeasuredCountedContents || titleHasExplicitCount || titleHasDozen)
      )
    );
  const titleExplainsPerUnitSize = Boolean(
    titleSize?.packCount
    && retailerSize
    && retailerSize.kind === titleSize.kind
    // Compare normalized units. `perPackageAmount` retains the display unit
    // (for example 2 lb), while baseAmount is always ounces/fluid ounces.
    && Math.abs(
      retailerSize.baseAmount - titleSize.baseAmount / titleSize.packCount,
    ) <= 0.0001,
  );
  const titleConfirmsRetailerTotal = Boolean(
    titleSize?.packCount
    && retailerSize
    && retailerSize.kind === titleSize.kind
    && Math.abs(retailerSize.baseAmount - titleSize.baseAmount) <= 0.0001,
  );
  const titleExplainsBareOuterItem = retailerSize?.kind === "count"
    && retailerSize.baseAmount === 1
    && explicitTitleCountSize;
  // When Kroger gives a physical size but the title also says N Count without
  // "each" or another verified per-unit relationship, the two dimensions
  // cannot safely be collapsed into one measurement. Preserve the proven
  // count axis and refuse automatic physical-total arithmetic.
  const unresolvedCountWithPhysicalSize = explicitTitleCountSize
    && retailerSize
    && retailerSize.kind !== "count"
    && (
      titleSize?.kind === "count"
      || (titleSize?.kind === retailerSize.kind && !titleSize.packCount)
    );
  const size = explicitPhysicalTotalSize
    ? explicitPhysicalTotalSize
    : titleConfirmsRetailerTotal
      ? retailerSize
    : namedOuterPhysicalSize?.packCount === titleNamedOuterCount
      ? namedOuterPhysicalSize
    : titleExplainsBareOuterItem || unresolvedCountWithPhysicalSize
      ? explicitTitleCountSize
      : titleExplainsOuterCount || titleExplainsPerUnitSize
        ? titleSize
        : retailerSize ?? titleSize;
  const { link, linkType, sourceUrl } = safeProductLink(
    raw,
    context.chain,
    title,
    [productId, upc],
  );
  // This ID was first echoed by official location detail, then reused in the
  // documented product location filter that scopes price and availability.
  const exactStoreVerified = context.locationVerified;

  return {
    retailer: "kroger",
    id: productId,
    productId,
    itemId: textValue(selectedItem.itemId),
    upc,
    title,
    price: currentPrice,
    priceCents: Math.round(currentPrice * 100),
    link,
    linkType,
    sourceUrl: sourceUrl ?? link,
    thumbnail: productImage(raw),
    seller: context.chain || "Kroger",
    brand,
    productType,
    inStock: availabilityStatus === "in_stock",
    availabilityStatus,
    sponsored: false,
    size,
    attributeOrigins: {
      title: "RETAILER_METADATA",
      ...(brand ? { brand: "RETAILER_METADATA" as const } : {}),
      ...(productType ? { productType: "RETAILER_METADATA" as const } : {}),
      ...(size ? { size: "RETAILER_METADATA" as const } : {}),
    },
    checkedAt: context.checkedAt,
    verification: "verified",
    verificationIssues: [],
    // Kroger's public Cart API accepts UPC, quantity, and modality. The
    // Products API sometimes omits stockLevel while still listing the item for
    // the selected fulfillment method. Keep that distinction in
    // availabilityStatus/inStock, but do not turn missing inventory metadata
    // into a false cart-ineligible state for an otherwise verified UPC.
    cartEligible: fulfillmentEvidence !== "unsupported"
      && availabilityStatus !== "out_of_stock",
    dataSource: "kroger_public_api",
    identityVerified: true,
    priceProvenance: {
      retailer: "kroger",
      priceSource: "kroger_location_product",
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified,
      regularPriceCents: regularPrice ? Math.round(regularPrice * 100) : undefined,
      promoPriceCents: promoPrice && promoPrice > 0 ? Math.round(promoPrice * 100) : undefined,
      locationId: context.locationId,
      locationName: context.locationName,
      chain: context.chain,
      location: {
        requestedStoreId: context.locationId,
        observedStoreId: context.locationId,
        responseProvesLocation: true,
        storeMatched: true,
      },
      fulfillment,
      checkedAt: context.checkedAt,
    },
  };
}

function normalizeLocation(value: unknown): KrogerLocation | null {
  const raw = record(value);
  const address = record(raw?.address);
  const locationId = textValue(raw?.locationId);
  const name = textValue(raw?.name);
  const chain = krogerFamilyDisplayName(textValue(raw?.chain) ?? "Kroger");
  const addressLine1 = textValue(address?.addressLine1);
  const city = textValue(address?.city);
  const state = textValue(address?.state);
  const zipCode = textValue(address?.zipCode)?.slice(0, 5);
  if (!locationId || !isValidKrogerLocationId(locationId) || !name || !addressLine1 || !city || !state || !zipCode) return null;
  if (/\bshell\b|fuel\s*(?:center|station)/i.test(`${chain} ${name}`)) return null;
  return {
    locationId,
    name,
    chain,
    address: { addressLine1, city, state, zipCode },
    phone: textValue(raw?.phone),
    departments: records(raw?.departments)
      .map((department) => textValue(department.name))
      .filter((department): department is string => Boolean(department)),
  };
}

async function checkedJson(response: Response, operation: string) {
  if (!response.ok) {
    const code = response.status === 404
      ? "not_found" as const
      : response.status === 429 ? "rate_limit" as const : "upstream" as const;
    throw new KrogerProviderError(
      response.status === 429
        ? "Kroger's request limit was reached. Try again shortly."
        : `Kroger could not ${operation}.`,
      code,
      response.status === 404 ? 404 : response.status === 429 ? 429 : 502,
    );
  }
  try {
    return await response.json() as unknown;
  } catch {
    throw new KrogerProviderError("Kroger returned an invalid response.", "bad_response");
  }
}

export async function findKrogerLocations(
  zipCode: string,
  auth: KrogerAuthClient = getKrogerAuthClient(),
): Promise<KrogerLocationsResponse> {
  const startedAt = performance.now();
  const cacheKey = zipCode;
  const state = providerState();
  const cached = state.zipLocationsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      zipCode,
      locations: cached.value,
      diagnostics: { apiCall: false, cacheHit: true, deduplicated: false, durationMs: 0 },
    };
  }
  const existing = state.zipLocations.get(cacheKey);
  if (existing) {
    return {
      zipCode,
      locations: await existing,
      diagnostics: { apiCall: false, cacheHit: false, deduplicated: true, durationMs: Math.round(performance.now() - startedAt) },
    };
  }

  const query = new URLSearchParams({
    "filter.zipCode.near": zipCode,
    "filter.radiusInMiles": "20",
    "filter.limit": "10",
  });
  const operation = (async () => {
    const payload = record(await checkedJson(
      await auth.fetchPublic(`/v1/locations?${query}`, { signal: AbortSignal.timeout(12_000) }),
      "find nearby stores",
    ));
    return records(payload?.data)
      .map(normalizeLocation)
      .filter((location): location is KrogerLocation => Boolean(location));
  })();
  state.zipLocations.set(cacheKey, operation);
  // ZIP searches return multiple stores, so keep this request-level promise
  // separate from the single-location detail cache.
  try {
    const locations = await operation;
    // Do not place ZIP-search summaries into the verified detail cache. Before
    // product search, getKrogerLocation must make (or reuse) the official
    // /locations/{id} detail call that echoes the exact selected ID.
    state.zipLocationsCache.set(cacheKey, {
      expiresAt: Date.now() + LOCATION_CACHE_TTL_MS,
      value: locations,
    });
    return {
      zipCode,
      locations,
      diagnostics: { apiCall: true, cacheHit: false, deduplicated: false, durationMs: Math.round(performance.now() - startedAt) },
    };
  } finally {
    state.zipLocations.delete(cacheKey);
  }
}

export async function getKrogerLocation(
  locationId: string,
  auth: KrogerAuthClient = getKrogerAuthClient(),
) {
  const state = providerState();
  const cached = state.locationCache.get(locationId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = state.locations.get(locationId);
  if (existing) return existing;
  const pending = (async () => {
    const payload = record(await checkedJson(
      await auth.fetchPublic(`/v1/locations/${encodeURIComponent(locationId)}`, { signal: AbortSignal.timeout(12_000) }),
      "load the selected store",
    ));
    const location = normalizeLocation(payload?.data);
    if (!location || location.locationId !== locationId) {
      throw new KrogerProviderError("Kroger did not confirm the selected store.", "bad_response");
    }
    state.locationCache.set(locationId, {
      expiresAt: Date.now() + LOCATION_CACHE_TTL_MS,
      value: location,
    });
    return location;
  })();
  state.locations.set(locationId, pending);
  try {
    return await pending;
  } finally {
    state.locations.delete(locationId);
  }
}

export async function searchKrogerProducts(
  query: string,
  context: {
    locationId: string;
    locationVerified: true;
    locationName?: string;
    chain?: string;
    fulfillmentMode: RetailFulfillmentMode;
  },
  auth: KrogerAuthClient = getKrogerAuthClient(),
): Promise<KrogerSearchResponse> {
  const startedAt = performance.now();
  const cacheKey = `${context.locationId}|${context.fulfillmentMode}|${query.toLowerCase()}`;
  const state = providerState();
  const cached = state.searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      products: cached.value,
      diagnostics: { apiCall: false, cacheHit: true, deduplicated: false, durationMs: 0 },
    };
  }
  const existing = state.searches.get(cacheKey);
  if (existing) {
    return {
      products: await existing,
      diagnostics: { apiCall: false, cacheHit: false, deduplicated: true, durationMs: Math.round(performance.now() - startedAt) },
    };
  }
  const parameters = new URLSearchParams({
    "filter.term": query,
    "filter.locationId": context.locationId,
    "filter.fulfillment": requestedFulfillmentFilter(context.fulfillmentMode),
    "filter.limit": "20",
  });
  const pending = (async () => {
    const payload = record(await checkedJson(
      await auth.fetchPublic(`/v1/products?${parameters}`, { signal: AbortSignal.timeout(12_000) }),
      "search products",
    ));
    const checkedAt = new Date().toISOString();
    const products = records(payload?.data)
      .map((product) => normalizeKrogerProduct(product, { ...context, checkedAt }))
      .filter((product): product is KrogerProduct => Boolean(product));
    for (const product of products) {
      if (!product.cartEligible) continue;
      state.verifiedCartProducts.set(
        `${context.locationId}|${context.fulfillmentMode}|${product.upc}`,
        Date.now() + SEARCH_CACHE_TTL_MS,
      );
    }
    state.searchCache.set(cacheKey, {
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
      value: products,
    });
    return products;
  })();
  state.searches.set(cacheKey, pending);
  try {
    return {
      products: await pending,
      diagnostics: { apiCall: true, cacheHit: false, deduplicated: false, durationMs: Math.round(performance.now() - startedAt) },
    };
  } finally {
    state.searches.delete(cacheKey);
  }
}

export function krogerCartItemsWereVerified(
  locationId: string,
  fulfillmentMode: "pickup" | "delivery",
  items: Array<{ upc: string }>,
) {
  const now = Date.now();
  const verified = providerState().verifiedCartProducts;
  for (const [key, expiry] of verified) {
    if (expiry <= now) verified.delete(key);
  }
  return items.every((item) => (
    verified.get(`${locationId}|${fulfillmentMode}|${item.upc}`) ?? 0
  ) > now);
}

/**
 * Re-verifies exact UPCs when a comparison and cart request are handled by
 * different serverless functions. This preserves the same fail-closed rule as
 * the short-lived in-process verification cache without trusting browser data.
 */
export async function verifyKrogerCartItemsAtLocation(
  locationId: string,
  fulfillmentMode: "pickup" | "delivery",
  items: Array<{ upc: string }>,
  auth: KrogerAuthClient = getKrogerAuthClient(),
) {
  const location = await getKrogerLocation(locationId, auth);
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(items.map(async ({ upc }) => {
    const parameters = new URLSearchParams({ "filter.locationId": locationId });
    const payload = record(await checkedJson(
      await auth.fetchPublic(
        `/v1/products/${encodeURIComponent(upc)}?${parameters}`,
        { signal: AbortSignal.timeout(12_000) },
      ),
      "verify a cart product",
    ));
    const product = normalizeKrogerProduct(record(payload?.data) ?? {}, {
      locationId,
      locationVerified: true,
      locationName: location.name,
      chain: location.chain,
      fulfillmentMode,
      checkedAt,
    });
    return Boolean(
      product
      && product.upc === upc
      && product.cartEligible
      && product.priceProvenance.exactStoreVerified
      && product.priceProvenance.locationId === locationId,
    );
  }));
  return results.every(Boolean);
}

export { krogerCartUrl, krogerShoppingUrl } from "./kroger-family-links";

export async function addToKrogerCart(
  items: KrogerCartItem[],
  auth: KrogerAuthClient = getKrogerAuthClient(),
) {
  const response = await auth.fetchCustomer("/v1/cart/add", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
    // An add-semantics PUT must never be replayed automatically at a redirect
    // target or expose its UPC payload to another origin. Any redirect remains
    // an unconfirmed outcome under the durable operation guard.
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status !== 204) {
    if (response.status === 401) {
      throw new KrogerAuthError(
        "Your Kroger connection expired or was revoked. Reconnect Kroger.",
        "not_connected",
        401,
      );
    }
    if (![400, 401, 403, 404, 409, 422, 429].includes(response.status)) {
      throw new KrogerProviderError(
        "Kroger's cart response did not confirm whether items were added.",
        "outcome_unknown",
        502,
      );
    }
    throw new KrogerProviderError(
      "Kroger could not add these items to the cart.",
      "upstream",
      response.status === 429 ? 429 : 400,
    );
  }
}

export function resetKrogerProviderForTests() {
  delete (globalThis as ProviderGlobal).__cartivaKrogerProvider;
}
