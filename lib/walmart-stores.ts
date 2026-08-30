import type {
  WalmartStoreLookupResult,
  WalmartStoreOption,
} from "./types";

const WALMART_STORE_DIRECTORY_URL = "https://serpapi.com/walmart-stores.json";
const SERPAPI_SEARCH_URL = "https://serpapi.com/search.json";
const STORE_DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000;
const NEARBY_STORE_TTL_MS = 60 * 60 * 1000;
const STORE_DIRECTORY_TIMEOUT_MS = 8_000;
const NEARBY_STORE_TIMEOUT_MS = 10_000;
const MAX_DIRECTORY_BYTES = 8_000_000;
const MAX_DIRECTORY_RECORDS = 10_000;
const MAX_NEARBY_RESPONSE_BYTES = 1_000_000;
export const MAX_STORE_LOOKUP_RESULTS = 12;

type StoreDirectoryCache = {
  stores: WalmartStoreOption[];
  expiresAt: number;
};

type NearbyStoreCache = {
  stores: WalmartStoreOption[];
  expiresAt: number;
};

declare global {
  var walmartStoreDirectoryCache: StoreDirectoryCache | undefined;
  var walmartStoreDirectoryInFlight: Promise<WalmartStoreOption[]> | undefined;
  var walmartNearbyStoreCache: Map<string, NearbyStoreCache> | undefined;
  var walmartNearbyStoreInFlight: Map<string, Promise<WalmartStoreOption[]>> | undefined;
}

export class WalmartStoreDirectoryError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_zip" | "timeout" | "upstream" | "malformed",
  ) {
    super(message);
    this.name = "WalmartStoreDirectoryError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= maximumLength ? normalized : undefined;
}

export function normalizeUsZip(value: unknown) {
  if (typeof value !== "string") {
    throw new WalmartStoreDirectoryError("Enter a five-digit US ZIP code.", "invalid_zip");
  }
  const zipCode = value.trim();
  if (!/^\d{5}$/.test(zipCode)) {
    throw new WalmartStoreDirectoryError("Enter a five-digit US ZIP code.", "invalid_zip");
  }
  return zipCode;
}

function parseStoreRecord(value: unknown): WalmartStoreOption | null {
  const record = asRecord(value);
  if (!record) return null;

  const storeId = typeof record.store_id === "number" && Number.isInteger(record.store_id)
    ? String(record.store_id)
    : normalizedText(record.store_id, 8);
  const postalCode = normalizedText(record.postal_code, 5);
  const address = normalizedText(record.address, 240);
  const country = normalizedText(record.country, 10)?.toUpperCase();

  if (!storeId || !/^\d{1,8}$/.test(storeId)) return null;
  if (!postalCode || !/^\d{5}$/.test(postalCode)) return null;
  if (!address) return null;
  // SerpApi's current US rows commonly omit country, while Mexico rows declare
  // `country: "MX"`. Keep the parser fail-closed for every explicit non-US row
  // and for the documented Mexico address suffix.
  if ((country && country !== "US") || /,\s*MX$/i.test(address)) return null;

  return { storeId, postalCode, address, country: "US" };
}

export function parseWalmartStoreDirectory(payload: unknown) {
  if (!Array.isArray(payload) || payload.length > MAX_DIRECTORY_RECORDS) {
    throw new WalmartStoreDirectoryError(
      "Walmart's supported-store directory returned malformed data.",
      "malformed",
    );
  }

  const stores: WalmartStoreOption[] = [];
  const seenStoreIds = new Set<string>();
  for (const value of payload) {
    const store = parseStoreRecord(value);
    if (!store || seenStoreIds.has(store.storeId)) continue;
    seenStoreIds.add(store.storeId);
    stores.push(store);
  }
  if (!stores.length) {
    throw new WalmartStoreDirectoryError(
      "Walmart's supported-store directory did not contain valid US stores.",
      "malformed",
    );
  }
  return stores;
}

export function findWalmartStoresByZip(
  stores: WalmartStoreOption[],
  zipCode: string,
  limit = MAX_STORE_LOOKUP_RESULTS,
): WalmartStoreLookupResult {
  const normalizedZip = normalizeUsZip(zipCode);
  const safeLimit = Number.isInteger(limit)
    ? Math.max(1, Math.min(limit, MAX_STORE_LOOKUP_RESULTS))
    : MAX_STORE_LOOKUP_RESULTS;
  const matches = stores
    .filter((store) => store.postalCode === normalizedZip)
    .sort((left, right) => left.address.localeCompare(right.address, "en-US")
      || left.storeId.localeCompare(right.storeId, "en-US", { numeric: true }));

  return {
    zipCode: normalizedZip,
    stores: matches.slice(0, safeLimit),
    totalMatches: matches.length,
  };
}

function walmartStoreIdFromUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "walmart.com" && hostname !== "www.walmart.com") return undefined;
    return url.pathname.match(/^\/store\/(\d{1,8})(?:-|\/|$)/)?.[1];
  } catch {
    return undefined;
  }
}

export function parseNearbyWalmartStores(
  payload: unknown,
  directory: WalmartStoreOption[],
  zipCode: string,
  limit = 10,
) {
  const normalizedZip = normalizeUsZip(zipCode);
  const root = asRecord(payload);
  const metadata = asRecord(root?.search_metadata);
  const parameters = asRecord(root?.search_parameters);
  const locationUsed = normalizedText(parameters?.location_used, 160);
  if (!root || metadata?.status !== "Success"
    || !locationUsed || !locationUsed.startsWith(`${normalizedZip},`)
    || !Array.isArray(root.local_results)) {
    throw new WalmartStoreDirectoryError(
      "Nearby Walmart lookup returned malformed data.",
      "malformed",
    );
  }

  const directoryById = new Map(directory.map((store) => [store.storeId, store]));
  const seen = new Set<string>();
  const stores: WalmartStoreOption[] = [];
  const safeLimit = Number.isInteger(limit)
    ? Math.max(1, Math.min(limit, MAX_STORE_LOOKUP_RESULTS))
    : 10;

  for (const value of root.local_results.slice(0, 30)) {
    const result = asRecord(value);
    const title = normalizedText(result?.title, 160);
    if (!result || !title || !/^Walmart\b/i.test(title)) continue;
    const links = asRecord(result.links);
    const storeId = walmartStoreIdFromUrl(links?.website ?? result.website);
    const canonicalStore = storeId ? directoryById.get(storeId) : undefined;
    if (!canonicalStore || seen.has(canonicalStore.storeId)) continue;

    seen.add(canonicalStore.storeId);
    stores.push({
      ...canonicalStore,
      address: normalizedText(result.address, 240) ?? canonicalStore.address,
    });
    if (stores.length >= safeLimit) break;
  }
  return stores;
}

async function fetchNearbyWalmartStores(
  zipCode: string,
  directory: WalmartStoreOption[],
) {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  if (!apiKey) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), NEARBY_STORE_TIMEOUT_MS);
  try {
    const url = new URL(SERPAPI_SEARCH_URL);
    url.searchParams.set("engine", "google_local");
    url.searchParams.set("q", "Walmart");
    url.searchParams.set("location", `${zipCode}, United States`);
    url.searchParams.set("gl", "us");
    url.searchParams.set("hl", "en");
    url.searchParams.set("output", "json");
    url.searchParams.set("json_restrictor", "search_metadata.status,error,search_parameters.location_used,local_results[0:10].{position,title,address,links}");
    url.searchParams.set("api_key", apiKey);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new WalmartStoreDirectoryError(
        "Nearby Walmart lookup is temporarily unavailable.",
        "upstream",
      );
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_NEARBY_RESPONSE_BYTES) {
      throw new WalmartStoreDirectoryError(
        "Nearby Walmart lookup returned malformed data.",
        "malformed",
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new WalmartStoreDirectoryError(
        "Nearby Walmart lookup returned malformed data.",
        "malformed",
      );
    }
    return parseNearbyWalmartStores(payload, directory, zipCode);
  } catch (error) {
    if (error instanceof WalmartStoreDirectoryError) throw error;
    if (controller.signal.aborted) {
      throw new WalmartStoreDirectoryError(
        "Nearby Walmart lookup timed out.",
        "timeout",
      );
    }
    throw new WalmartStoreDirectoryError(
      "Nearby Walmart lookup is temporarily unavailable.",
      "upstream",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function loadNearbyWalmartStores(
  zipCode: string,
  directory: WalmartStoreOption[],
) {
  const now = Date.now();
  const cache = globalThis.walmartNearbyStoreCache ??= new Map();
  const cached = cache.get(zipCode);
  if (cached && cached.expiresAt > now) return cached.stores;

  const inFlight = globalThis.walmartNearbyStoreInFlight ??= new Map();
  const existing = inFlight.get(zipCode);
  if (existing) return existing;

  const pending = fetchNearbyWalmartStores(zipCode, directory);
  inFlight.set(zipCode, pending);
  try {
    const stores = await pending;
    cache.set(zipCode, { stores, expiresAt: Date.now() + NEARBY_STORE_TTL_MS });
    return stores;
  } finally {
    if (inFlight.get(zipCode) === pending) inFlight.delete(zipCode);
  }
}

async function fetchWalmartStoreDirectory() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), STORE_DIRECTORY_TIMEOUT_MS);
  try {
    const response = await fetch(WALMART_STORE_DIRECTORY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new WalmartStoreDirectoryError(
        "Walmart store lookup is temporarily unavailable.",
        "upstream",
      );
    }

    const reportedLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(reportedLength) && reportedLength > MAX_DIRECTORY_BYTES) {
      throw new WalmartStoreDirectoryError(
        "Walmart's supported-store directory was unexpectedly large.",
        "malformed",
      );
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_DIRECTORY_BYTES) {
      throw new WalmartStoreDirectoryError(
        "Walmart's supported-store directory was unexpectedly large.",
        "malformed",
      );
    }
    const text = new TextDecoder().decode(bytes);

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WalmartStoreDirectoryError(
        "Walmart's supported-store directory returned malformed data.",
        "malformed",
      );
    }
    return parseWalmartStoreDirectory(payload);
  } catch (error) {
    if (error instanceof WalmartStoreDirectoryError) throw error;
    if (controller.signal.aborted) {
      throw new WalmartStoreDirectoryError(
        "Walmart store lookup timed out. Please try again.",
        "timeout",
      );
    }
    throw new WalmartStoreDirectoryError(
      "Walmart store lookup is temporarily unavailable.",
      "upstream",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function loadWalmartStoreDirectory() {
  const now = Date.now();
  const cached = globalThis.walmartStoreDirectoryCache;
  if (cached && cached.expiresAt > now) return cached.stores;

  const existingRequest = globalThis.walmartStoreDirectoryInFlight;
  if (existingRequest) return existingRequest;

  const pending = fetchWalmartStoreDirectory();
  globalThis.walmartStoreDirectoryInFlight = pending;
  try {
    const stores = await pending;
    globalThis.walmartStoreDirectoryCache = {
      stores,
      expiresAt: Date.now() + STORE_DIRECTORY_TTL_MS,
    };
    return stores;
  } finally {
    if (globalThis.walmartStoreDirectoryInFlight === pending) {
      globalThis.walmartStoreDirectoryInFlight = undefined;
    }
  }
}

export async function getWalmartStoresByZip(zipCode: string) {
  const normalizedZip = normalizeUsZip(zipCode);
  const stores = await loadWalmartStoreDirectory();
  const exact = findWalmartStoresByZip(stores, normalizedZip);
  if (exact.stores.length) return exact;

  try {
    const nearby = await loadNearbyWalmartStores(normalizedZip, stores);
    return {
      zipCode: normalizedZip,
      stores: nearby,
      totalMatches: nearby.length,
    };
  } catch {
    // The extension can still use Walmart's visible store finder. Returning a
    // successful empty result keeps a temporary nearby-search failure usable.
    return exact;
  }
}

export function clearWalmartStoreDirectoryCache() {
  globalThis.walmartStoreDirectoryCache = undefined;
  globalThis.walmartStoreDirectoryInFlight = undefined;
  globalThis.walmartNearbyStoreCache = undefined;
  globalThis.walmartNearbyStoreInFlight = undefined;
}
import "./server-only-guard";
