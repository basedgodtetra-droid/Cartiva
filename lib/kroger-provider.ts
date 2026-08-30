import { extractMeasurement } from "./measurements";
import { getKrogerAuthClient, KrogerAuthClient } from "./kroger-auth";
import type {
  KrogerProduct,
  RetailFulfillmentMode,
} from "./types";

type UnknownRecord = Record<string, unknown>;

const SEARCH_CACHE_TTL_MS = 2 * 60_000;
const LOCATION_CACHE_TTL_MS = 30 * 60_000;

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

function requestedFulfillmentFilter(mode: RetailFulfillmentMode) {
  if (mode === "pickup") return "csp";
  if (mode === "delivery") return "dth";
  return "sth";
}

const FAMILY_DOMAINS: Record<string, string> = {
  KROGER: "www.kroger.com",
  RALPHS: "www.ralphs.com",
  "FRED MEYER": "www.fredmeyer.com",
  "KING SOOPERS": "www.kingsoopers.com",
  "FRY'S": "www.frysfood.com",
  "SMITH'S": "www.smithsfoodanddrug.com",
  QFC: "www.qfc.com",
  DILLONS: "www.dillons.com",
  "HARRIS TEETER": "www.harristeeter.com",
  "MARIANO'S": "www.marianos.com",
  "PICK 'N SAVE": "www.picknsave.com",
  "FOOD 4 LESS": "www.food4less.com",
  "CITY MARKET": "www.citymarket.com",
  "BAKER'S": "www.bakersplus.com",
  "BAKERS": "www.bakersplus.com",
  "FOODS CO": "www.foodsco.net",
  GERBES: "www.gerbes.com",
  "JAY C": "www.jaycfoods.com",
  "METRO MARKET": "www.metromarket.net",
  "PAY-LESS": "www.pay-less.com",
  "PAY LESS": "www.pay-less.com",
  RULER: "www.rulerfoods.com",
};

function familyKey(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

const FAMILY_DOMAIN_BY_KEY = new Map(
  Object.entries(FAMILY_DOMAINS).map(([name, domain]) => [familyKey(name), domain]),
);

const FAMILY_DISPLAY_NAMES: Record<string, string> = {
  KROGER: "Kroger",
  RALPHS: "Ralphs",
  FREDMEYER: "Fred Meyer",
  KINGSOOPERS: "King Soopers",
  FRYS: "Fry's",
  SMITHS: "Smith's",
  QFC: "QFC",
  DILLONS: "Dillons",
  HARRISTEETER: "Harris Teeter",
  MARIANOS: "Mariano's",
  PICKNSAVE: "Pick 'n Save",
  FOOD4LESS: "Food 4 Less",
  CITYMARKET: "City Market",
  BAKERS: "Baker's",
  FOODSCO: "Foods Co",
  GERBES: "Gerbes",
  JAYC: "Jay C",
  METROMARKET: "Metro Market",
  PAYLESS: "Pay-Less",
  RULER: "Ruler",
};

const FAMILY_HOSTS = new Set(Object.values(FAMILY_DOMAINS));

function familyDomain(chain?: string) {
  return chain ? FAMILY_DOMAIN_BY_KEY.get(familyKey(chain)) : undefined;
}

function familyDisplayName(chain: string) {
  return FAMILY_DISPLAY_NAMES[familyKey(chain)] ?? chain;
}

function safeProductLink(
  raw: UnknownRecord,
  chain: string | undefined,
  title: string,
  expectedIds: readonly string[],
) {
  const domain = familyDomain(chain) ?? "www.kroger.com";
  const supplied = textValue(raw.productPageURI, raw.productPageUri, raw.productPageUrl);
  if (supplied) {
    try {
      const parsed = new URL(supplied, `https://${domain}`);
      const pathId = parsed.pathname.match(/\/p\/[^/]+\/(\d{8,14})\/?$/i)?.[1];
      if (
        parsed.protocol === "https:"
        && FAMILY_HOSTS.has(parsed.hostname.toLowerCase())
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
  const selectedItem = items.find((item) => fulfillmentFor(item).includes(context.fulfillmentMode))
    ?? items[0];
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
  const fulfillment = fulfillmentFor(selectedItem);
  const supportsRequestedFulfillment = fulfillment.includes(context.fulfillmentMode);
  const availabilityStatus = stockLevel === "HIGH" || stockLevel === "LOW"
    ? "in_stock"
    : stockLevel && /OUT_OF_STOCK|TEMPORARILY_OUT/.test(stockLevel)
      ? "out_of_stock"
      : supportsRequestedFulfillment
        ? "likely_available"
        : "unknown";
  const sizeText = textValue(selectedItem.size) ?? "";
  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter((value): value is string => typeof value === "string")
    : [];
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
    brand: textValue(raw.brand),
    productType: categories[0],
    inStock: availabilityStatus === "in_stock",
    availabilityStatus,
    sponsored: false,
    size: extractMeasurement(`${title} ${sizeText}`),
    checkedAt: context.checkedAt,
    verification: "verified",
    verificationIssues: [],
    cartEligible: availabilityStatus === "in_stock"
      && supportsRequestedFulfillment,
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
  const chain = familyDisplayName(textValue(raw?.chain) ?? "Kroger");
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

export function krogerCartUrl(chain?: string) {
  const domain = familyDomain(chain);
  return `https://${domain ?? "www.kroger.com"}/cart`;
}

/**
 * A banner-safe public shopping destination. Anonymous clients must never be
 * sent to /cart because no cart mutation or customer authorization occurred.
 * Unknown or untrusted chain text fails closed to Kroger's public home page.
 */
export function krogerShoppingUrl(chain?: string) {
  const domain = familyDomain(chain);
  return `https://${domain ?? "www.kroger.com"}/`;
}

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
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status !== 204) {
    if (![400, 401, 403, 404, 409, 422, 429].includes(response.status)) {
      throw new KrogerProviderError(
        "Kroger's cart response did not confirm whether items were added.",
        "outcome_unknown",
        502,
      );
    }
    throw new KrogerProviderError(
      response.status === 401
        ? "Reconnect Kroger before adding items to the cart."
        : "Kroger could not add these items to the cart.",
      "upstream",
      response.status === 401 ? 401 : response.status === 429 ? 429 : 400,
    );
  }
}

export function resetKrogerProviderForTests() {
  delete (globalThis as ProviderGlobal).__cartivaKrogerProvider;
}
