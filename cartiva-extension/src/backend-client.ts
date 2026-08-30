import type {
  BackendItemResult,
  ExtensionProduct,
  FulfillmentMode,
  KrogerStoreLookupResult,
  KrogerStoreOption,
  ParsedListItem,
  PreparedItem,
  Retailer,
  WalmartProductSuggestion,
  WalmartSuggestionResult,
} from "./types.js";
import { isBuildEligible } from "./totals.js";
import { normalizePickupZip, parseStoreLookupResult } from "./store-picker.js";
import type { WalmartStoreLookupResult } from "./types.js";
import {
  isTrustedKrogerAuthorizationUrl,
  isTrustedKrogerCartUrl,
} from "./kroger-hosts.js";

interface SearchResultPayload {
  recommended?: ExtensionProduct | null;
  alternatives?: ExtensionProduct[];
  status?: "matched" | "review" | "no_match";
  explanation?: string;
  assumptions?: string[];
  error?: string;
}

interface SearchEventPayload {
  type: "item" | "performance";
  retailer?: Retailer;
  index?: number;
  phase?: "search" | "verification";
  mode?: "live" | "demo";
  checkedAt?: string;
  result?: SearchResultPayload;
}

interface CacheEntry {
  expiresAt: number;
  item: PreparedItem;
}

interface SuggestionCacheEntry {
  expiresAt: number;
  result: WalmartSuggestionResult;
}

export interface PrepareOptions {
  backendBaseUrl: string;
  retailer?: Retailer;
  storeId?: string;
  zip?: string;
  fulfillmentMode: FulfillmentMode;
  onResult(result: BackendItemResult): void;
}

export interface ComparisonPrepareOptions {
  backendBaseUrl: string;
  retailers: Partial<Record<Retailer, {
    storeId?: string;
    zip?: string;
    fulfillmentMode: FulfillmentMode;
  }>>;
  onResult(retailer: Retailer, result: BackendItemResult): void;
  onRetailerComplete?(retailer: Retailer, items: PreparedItem[]): void;
  onRetailerError?(retailer: Retailer, error: Error): void;
}

export interface KrogerOAuthStatus {
  connected: boolean;
  configured?: boolean;
  profileId?: string;
  expiresAt?: string;
}

export interface KrogerCartResult {
  success: boolean;
  addedCount: number;
  cartUrl: string;
  message?: string;
}

export class KrogerCartError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly retrySafe?: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KrogerCartError";
  }
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const SUGGESTION_CACHE_TTL_MS = 60 * 1000;
const COMPARISON_RETAILERS = ["walmart", "target", "kroger"] as const satisfies readonly Retailer[];

function cloneSuggestionResult(result: WalmartSuggestionResult): WalmartSuggestionResult {
  return {
    ...result,
    searchIdeas: result.searchIdeas.map((idea) => ({ ...idea })),
    suggestions: result.suggestions.map((suggestion) => ({
      ...suggestion,
      fulfillment: suggestion.fulfillment ? [...suggestion.fulfillment] : undefined,
    })),
  };
}

function clonePreparedItem(item: PreparedItem, request: ParsedListItem): PreparedItem {
  return {
    ...item,
    id: request.id,
    request,
    alternatives: item.alternatives.map((product) => ({ ...product })),
    product: item.product ? { ...item.product } : undefined,
  };
}

function isWeightedRequest(request: ParsedListItem, product?: ExtensionProduct) {
  return /\b(?:chicken|beef|pork|steak|meat|turkey|salmon|shrimp)\b/i.test(request.text)
    && product?.size?.kind === "weight";
}

function fulfillmentIsCompatible(product: ExtensionProduct, mode: FulfillmentMode, retailer?: Retailer) {
  if (mode === "unknown") return false;
  const available = product.priceProvenance?.fulfillment ?? [];
  if (retailer === "kroger") {
    return mode === "pickup"
      ? available.includes("pickup")
      : mode === "delivery" && available.includes("delivery");
  }
  if (mode === "pickup") return available.includes("pickup") || available.includes("in_store");
  return available.includes(mode);
}

function toPreparedItem(
  request: ParsedListItem,
  payload: SearchResultPayload,
  event: SearchEventPayload,
  fulfillmentMode: FulfillmentMode,
  retailer: Retailer,
): PreparedItem {
  const product = payload.recommended ?? undefined;
  const isFinal = event.phase === "verification" || !product;
  let matchStatus: PreparedItem["matchStatus"] = "searching";
  if (isFinal) {
    matchStatus = payload.error
      ? "api_error"
      : payload.status === "matched"
        ? "matched"
        : payload.status === "review"
          ? "needs_review"
          : "no_match";
  }

  let explanation = payload.explanation;
  if (matchStatus === "matched" && event.mode === "demo") {
    matchStatus = "needs_review";
    const retailerName = retailer === "target" ? "Target" : retailer === "kroger" ? "Kroger" : "Walmart";
    explanation = `Demo data cannot be presented as a live ${retailerName} match.`;
  } else if (matchStatus === "matched" && product && fulfillmentMode === "unknown") {
    matchStatus = "needs_review";
    explanation = "Choose pickup, delivery or shipping before Cartiva verifies fulfillment.";
  } else if (matchStatus === "matched" && product && !fulfillmentIsCompatible(product, fulfillmentMode, retailer)) {
    matchStatus = "needs_review";
    explanation = `This result is not verified for ${fulfillmentMode}.`;
  }

  const prepared: PreparedItem = {
    id: request.id,
    request,
    matchStatus,
    product,
    alternatives: payload.alternatives ?? [],
    explanation,
    assumptions: payload.assumptions,
    checkedAt: event.checkedAt ?? product?.checkedAt,
    dataMode: event.mode,
    cartStatus: retailer === "target"
      ? matchStatus === "matched" ? "skipped" : matchStatus === "no_match" ? "unavailable" : "needs_choice"
      : matchStatus === "matched" ? "ready" : matchStatus === "no_match" ? "unavailable" : "needs_choice",
    estimatedByWeight: isWeightedRequest(request, product),
    retailer,
  };
  if (retailer === "walmart" && prepared.matchStatus === "matched" && !isBuildEligible(prepared, fulfillmentMode)) {
    prepared.matchStatus = "needs_review";
    prepared.cartStatus = "needs_choice";
    prepared.explanation = prepared.explanation
      ?? "This result is not fully verified for a local Walmart cart.";
  }
  return prepared;
}

function backendEndpoint(baseUrl: string, retailer: Retailer) {
  const path = retailer === "target"
    ? "/api/extension/target/search"
    : retailer === "kroger"
      ? "/api/extension/kroger/search"
      : "/api/extension/search";
  return `${backendEndpointBase(baseUrl)}${path}`;
}

function cleanText(value: unknown, maxLength = 300) {
  if (typeof value !== "string") return undefined;
  const text = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return text && text.length <= maxLength ? text : undefined;
}

function parseKrogerStore(value: unknown): KrogerStoreOption | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const id = cleanText(item.id ?? item.locationId, 32);
  const name = cleanText(item.name, 160);
  const chain = cleanText(item.chain ?? item.banner, 80) ?? "Kroger";
  const nestedAddress = item.address && typeof item.address === "object"
    ? item.address as Record<string, unknown>
    : undefined;
  const zip = cleanText(
    item.zip ?? item.zipCode ?? item.postalCode
      ?? nestedAddress?.zipCode ?? nestedAddress?.postalCode,
    10,
  );
  const address = cleanText(item.address, 240)
    ?? cleanText(item.formattedAddress, 240)
    ?? (nestedAddress
      ? [
          cleanText(nestedAddress.addressLine1 ?? nestedAddress.addressLine, 120),
          cleanText(nestedAddress.city, 80),
          cleanText(nestedAddress.state, 8),
          cleanText(nestedAddress.zipCode ?? nestedAddress.postalCode, 10),
        ].filter(Boolean).join(", ")
      : undefined);
  if (!id || !name || !address || !zip || !/^\d{5}(?:-\d{4})?$/.test(zip)) return undefined;
  return { id, name, chain, address, zip: zip.slice(0, 5) };
}

export function parseKrogerStoreLookupResult(payload: unknown, requestedZip: string): KrogerStoreLookupResult {
  if (!payload || typeof payload !== "object") throw new Error("Cartiva received an invalid Kroger store response.");
  const result = payload as Record<string, unknown>;
  const rawStores = Array.isArray(result.stores)
    ? result.stores
    : Array.isArray(result.locations)
      ? result.locations
      : Array.isArray(result.data)
        ? result.data
        : [];
  const stores = rawStores
    .map(parseKrogerStore)
    .filter((store): store is KrogerStoreOption => Boolean(store))
    .filter((store, index, all) => all.findIndex((candidate) => candidate.id === store.id) === index)
    .slice(0, 12);
  const zipCode = cleanText(result.zipCode, 10)?.slice(0, 5) ?? requestedZip;
  return { zipCode, stores };
}

function suggestionEndpoint(baseUrl: string) {
  return `${backendEndpointBase(baseUrl)}/api/extension/suggestions`;
}

function parseProductSuggestion(value: unknown): WalmartProductSuggestion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const price = typeof item.price === "number" ? item.price : Number.NaN;
  if (!title || title.length > 300 || !Number.isFinite(price) || price <= 0) return undefined;
  const productId = typeof item.productId === "string" && /^[a-z0-9-]{1,64}$/i.test(item.productId)
    ? item.productId
    : undefined;
  const itemId = typeof item.itemId === "string" && /^\d{1,24}$/.test(item.itemId)
    ? item.itemId
    : undefined;
  return {
    title,
    price,
    productId,
    itemId,
    brand: typeof item.brand === "string" && item.brand.trim().length <= 100
      ? item.brand.trim()
      : undefined,
    brandSource: item.brandSource === "api" || item.brandSource === "title"
      ? item.brandSource
      : undefined,
    flavor: typeof item.flavor === "string" && item.flavor.trim().length <= 100
      ? item.flavor.trim()
      : undefined,
    format: typeof item.format === "string" && item.format.trim().length <= 100
      ? item.format.trim()
      : undefined,
    fulfillment: Array.isArray(item.fulfillment)
      ? item.fulfillment.filter((candidate): candidate is "pickup" | "delivery" | "shipping" | "in_store" => (
        candidate === "pickup"
        || candidate === "delivery"
        || candidate === "shipping"
        || candidate === "in_store"
      ))
      : undefined,
    packageSize: typeof item.packageSize === "string" && item.packageSize.trim().length <= 80
      ? item.packageSize.trim()
      : undefined,
  };
}

function parseSearchIdea(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const text = typeof item.text === "string"
    ? item.text.normalize("NFKC").replace(/\s+/g, " ").trim()
    : "";
  if (!text || text.length > 160) return undefined;
  const evidenceCount = Number.isSafeInteger(item.evidenceCount)
    && (item.evidenceCount as number) > 0
    && (item.evidenceCount as number) <= 10_000
    ? item.evidenceCount as number
    : undefined;
  return { text, evidenceCount };
}

function backendEndpointBase(baseUrl: string) {
  assertLoopbackBackend(baseUrl);
  return baseUrl.replace(/\/+$/, "");
}

function permissionPattern(baseUrl: string) {
  const url = new URL(baseUrl);
  return `http://${url.hostname}/*`;
}

export function assertLoopbackBackend(baseUrl: string) {
  const url = new URL(baseUrl);
  const loopbackHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "http:" || !loopbackHost) {
    throw new Error("Cartiva accepts only an HTTP loopback backend on this computer.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use only the local Cartiva backend origin, without credentials, a path, query, or fragment.");
  }
}

export class CartivaBackendClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly suggestionCache = new Map<string, SuggestionCacheEntry>();
  private activeController?: AbortController;

  cancel() {
    this.activeController?.abort();
    this.activeController = undefined;
  }

  async ensureBackendPermission(baseUrl: string) {
    assertLoopbackBackend(baseUrl);
    const origin = permissionPattern(baseUrl);
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return chrome.permissions.request({ origins: [origin] });
  }

  async findPickupStores(
    zipValue: string,
    backendBaseUrl: string,
    signal?: AbortSignal,
  ): Promise<WalmartStoreLookupResult> {
    const zipCode = normalizePickupZip(zipValue);
    let response: Response;
    try {
      response = await fetch(`${backendEndpointBase(backendBaseUrl)}/api/extension/stores`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ zipCode }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Cartiva could not reach the local backend. Keep Cartiva running on this computer.");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Cartiva received an invalid Walmart store response.");
    }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload
        && typeof payload.error === "string"
        ? payload.error
        : `Cartiva store lookup returned ${response.status}.`;
      throw new Error(message);
    }
    return parseStoreLookupResult(payload, zipCode);
  }

  async findKrogerStores(
    zipValue: string,
    backendBaseUrl: string,
    signal?: AbortSignal,
  ): Promise<KrogerStoreLookupResult> {
    const zipCode = normalizePickupZip(zipValue);
    let response: Response;
    try {
      response = await fetch(`${backendEndpointBase(backendBaseUrl)}/api/extension/kroger/locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ zipCode }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Cartiva could not reach Kroger's store service. Keep the local Cartiva server running.");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Cartiva received an invalid Kroger store response.");
    }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload
        && typeof payload.error === "string"
        ? payload.error
        : `Kroger store lookup returned ${response.status}.`;
      throw new Error(message);
    }
    return parseKrogerStoreLookupResult(payload, zipCode);
  }

  async startKrogerOAuth(backendBaseUrl: string, signal?: AbortSignal) {
    const response = await fetch(`${backendEndpointBase(backendBaseUrl)}/api/extension/kroger/auth/start`, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Cartiva received an invalid Kroger sign-in response.");
    }
    const authorizationUrl = payload && typeof payload === "object"
      ? cleanText((payload as Record<string, unknown>).authorizationUrl, 1_500)
        ?? cleanText((payload as Record<string, unknown>).url, 1_500)
      : undefined;
    if (!response.ok || !authorizationUrl) throw new Error("Kroger sign-in is temporarily unavailable.");
    if (!isTrustedKrogerAuthorizationUrl(authorizationUrl)) {
      throw new Error("Cartiva blocked an unexpected Kroger sign-in link.");
    }
    return new URL(authorizationUrl).toString();
  }

  async getKrogerOAuthStatus(
    backendBaseUrl: string,
    signal?: AbortSignal,
  ): Promise<KrogerOAuthStatus> {
    const response = await fetch(`${backendEndpointBase(backendBaseUrl)}/api/extension/kroger/auth/status`, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Cartiva received an invalid Kroger connection response.");
    }
    if (!response.ok || !payload || typeof payload !== "object") {
      throw new Error(response.ok ? "Cartiva received an invalid Kroger connection response." : "Kroger connection status is unavailable.");
    }
    const item = payload as Record<string, unknown>;
    return {
      connected: item.connected === true,
      configured: item.configured === true,
      profileId: cleanText(item.profileId, 100),
      expiresAt: cleanText(item.expiresAt, 80),
    };
  }

  async disconnectKrogerOAuth(
    backendBaseUrl: string,
    signal?: AbortSignal,
  ): Promise<KrogerOAuthStatus> {
    const response = await fetch(`${backendEndpointBase(backendBaseUrl)}/api/extension/kroger/auth/disconnect`, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Cartiva received an invalid Kroger disconnect response.");
    }
    if (!response.ok || !payload || typeof payload !== "object") {
      throw new Error(response.ok ? "Cartiva received an invalid Kroger disconnect response." : "Kroger could not disconnect this account.");
    }
    const item = payload as Record<string, unknown>;
    return {
      connected: item.connected === true,
      configured: item.configured === true,
    };
  }

  async addKrogerCart(
    backendBaseUrl: string,
    input: {
      locationId: string;
      fulfillmentMode: Exclude<FulfillmentMode, "unknown">;
      operationId: string;
      items: Array<{ upc: string; quantity: number }>;
    },
    signal?: AbortSignal,
  ): Promise<KrogerCartResult> {
    let response: Response;
    try {
      response = await fetch(`${backendEndpointBase(backendBaseUrl)}/api/extension/kroger/cart`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new KrogerCartError(
        "Cartiva lost contact while Kroger was processing the cart. Check the cart before doing anything else.",
        "outcome_unknown",
        false,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new KrogerCartError(
        "Kroger did not return a complete cart receipt. Check the cart before doing anything else.",
        "outcome_unknown",
        false,
        response.status,
      );
    }
    if (!response.ok || !payload || typeof payload !== "object") {
      const item = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
      const message = item && typeof item.error === "string"
        ? item.error
        : response.status === 401
          ? "Connect your Kroger account before Cartiva adds products."
          : `Kroger cart returned ${response.status}.`;
      const code = item ? cleanText(item.code, 80) : undefined;
      const retrySafe = typeof item?.retrySafe === "boolean"
        ? item.retrySafe
        : response.status === 401
          ? true
          : false;
      throw new KrogerCartError(message, code, retrySafe, response.status);
    }
    const item = payload as Record<string, unknown>;
    const addedCount = Number.isSafeInteger(item.addedCount)
      ? item.addedCount as number
      : input.items.length;
    const returnedCartUrl = cleanText(item.cartUrl, 500);
    let cartUrl = "https://www.kroger.com/cart";
    if (returnedCartUrl) {
      try {
        const parsed = new URL(returnedCartUrl);
        if (isTrustedKrogerCartUrl(parsed.toString())) {
          cartUrl = parsed.toString();
        }
      } catch {
        // Keep the fixed Kroger cart fallback; never open an untrusted URL.
      }
    }
    return {
      success: item.success !== false,
      addedCount,
      cartUrl,
      message: cleanText(item.message, 300),
    };
  }

  async findProductSuggestions(
    queryValue: string,
    storeIdValue: string,
    backendBaseUrl: string,
    signal?: AbortSignal,
    zipCodeValue?: string,
  ): Promise<WalmartSuggestionResult> {
    const query = queryValue.replace(/\s+/g, " ").trim();
    const storeId = storeIdValue.trim();
    const zipCode = zipCodeValue?.trim();
    if (query.length < 3 || query.length > 160) {
      throw new Error("Enter at least three characters for Walmart suggestions.");
    }
    if (!/^\d{1,8}$/.test(storeId)) {
      throw new Error("Choose a Walmart pickup store before loading live suggestions.");
    }

    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("The request was cancelled.", "AbortError");
    }
    const cacheKey = [
      backendEndpointBase(backendBaseUrl).toLowerCase(),
      storeId,
      zipCode && /^\d{5}$/.test(zipCode) ? zipCode : "",
      query.toLocaleLowerCase("en-US"),
    ].join("::");
    const cached = this.suggestionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cloneSuggestionResult(cached.result);
    }
    if (cached) this.suggestionCache.delete(cacheKey);

    let response: Response;
    try {
      response = await fetch(suggestionEndpoint(backendBaseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query,
          storeId,
          ...(zipCode && /^\d{5}$/.test(zipCode) ? { zipCode } : {}),
        }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Live Walmart suggestions are temporarily unavailable.");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Cartiva received an invalid Walmart suggestion response.");
    }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload
        && typeof payload.error === "string"
        ? payload.error
        : `Walmart suggestions returned ${response.status}.`;
      throw new Error(message);
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("Cartiva received an invalid Walmart suggestion response.");
    }
    const result = payload as Record<string, unknown>;
    const mode = result.mode === "live" || result.mode === "demo" ? result.mode : undefined;
    if (!mode || !Array.isArray(result.suggestions)) {
      throw new Error("Cartiva received an invalid Walmart suggestion response.");
    }
    const parsedResult: WalmartSuggestionResult = {
      query: typeof result.query === "string" ? result.query : query,
      mode,
      searchIdeas: (Array.isArray(result.searchIdeas) ? result.searchIdeas : [])
        .map(parseSearchIdea)
        .filter((item): item is NonNullable<ReturnType<typeof parseSearchIdea>> => Boolean(item))
        .filter((item, index, items) => (
          items.findIndex((candidate) => candidate.text.toLowerCase() === item.text.toLowerCase()) === index
        ))
        .slice(0, 5),
      suggestions: result.suggestions
        .map(parseProductSuggestion)
        .filter((item): item is WalmartProductSuggestion => Boolean(item))
        .slice(0, 6),
    };
    this.suggestionCache.set(cacheKey, {
      expiresAt: Date.now() + SUGGESTION_CACHE_TTL_MS,
      result: cloneSuggestionResult(parsedResult),
    });
    return parsedResult;
  }

  async prepare(items: ParsedListItem[], options: PrepareOptions) {
    this.cancel();
    const controller = new AbortController();
    this.activeController = controller;
    const output = new Map<string, PreparedItem>();
    const pendingItems: ParsedListItem[] = [];

    for (const item of items) {
      const cacheKey = this.cacheKey(item, options);
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        const restored = clonePreparedItem(cached.item, item);
        output.set(item.id, restored);
        options.onResult({ item: restored, phase: "verification" });
        continue;
      }
      if (cached) this.cache.delete(cacheKey);
      const searching: PreparedItem = {
        id: item.id,
        request: item,
        retailer: options.retailer ?? "walmart",
        matchStatus: "searching",
        alternatives: [],
        cartStatus: options.retailer === "target" ? "skipped" : "ready",
      };
      pendingItems.push(item);
      output.set(item.id, searching);
      options.onResult({ item: searching, phase: "search" });
    }

    if (pendingItems.length) {
      await this.searchBatch(pendingItems, options, controller.signal, output);
    }
    if (this.activeController === controller) this.activeController = undefined;
    return items
      .map((item) => output.get(item.id))
      .filter((item): item is PreparedItem => Boolean(item));
  }

  private cacheKey(item: ParsedListItem, options: PrepareOptions) {
    return [
      options.backendBaseUrl.replace(/\/+$/, ""),
      options.retailer ?? "walmart",
      options.storeId ?? "configured-store",
      options.zip ?? "",
      options.fulfillmentMode,
      item.normalizedText,
      item.preferredProductId ?? "",
      item.preferredItemId ?? "",
      item.preferredTitle ?? "",
    ].join("::");
  }

  private async searchBatch(
    items: ParsedListItem[],
    options: PrepareOptions,
    signal: AbortSignal,
    output: Map<string, PreparedItem>,
  ) {
    try {
      const requestItems = items.map((item) => ({
        text: item.text,
        quantity: item.quantity,
        explicitBrand: item.brand,
        explicitSize: item.size,
        explicitPackCount: item.packCount,
        preferredProductId: item.preferredProductId,
        preferredItemId: item.preferredItemId,
        preferredTitle: item.preferredTitle,
      }));
      const body: Record<string, unknown> = {
        retailer: options.retailer ?? "walmart",
        items: requestItems,
        zipCode: options.zip,
        fulfillmentMode: options.fulfillmentMode,
      };
      // An empty ID overrides the backend's configured store, so omit it entirely.
      if (options.storeId?.trim()) body.storeId = options.storeId.trim();

      const retailer = options.retailer ?? "walmart";
      const response = await fetch(backendEndpoint(options.backendBaseUrl, retailer), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Cartiva backend returned ${response.status}.`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const applyEvent = (value: unknown) => {
        if (signal.aborted) return;
        if (!value || typeof value !== "object") return;
        const event = value as SearchEventPayload;
        if (event.type !== "item" || !event.result) return;
        const index = Number.isInteger(event.index)
          ? event.index!
          : items.length === 1
            ? 0
            : -1;
        const item = items[index];
        if (!item) return;
        const latest = toPreparedItem(item, event.result, event, options.fulfillmentMode, retailer);
        output.set(item.id, latest);
        const phase = event.phase === "verification" ? "verification" : "search";
        options.onResult({ item: latest, phase });
        if (latest.matchStatus === "matched") {
          this.cache.set(this.cacheKey(item, options), {
            item: latest,
            expiresAt: Date.now() + CACHE_TTL_MS,
          });
        }
      };
      const applyLine = (line: string) => {
        if (!line.trim()) return;
        try {
          applyEvent(JSON.parse(line));
        } catch {
          // A malformed line must not hide valid results for the other items.
        }
      };
      while (true) {
        if (signal.aborted) return;
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) applyLine(line);
        if (done) break;
      }
      if (signal.aborted) return;
      applyLine(buffer);
      this.finishUnresolvedItems(items, output, options, "Verification did not finish.");
    } catch (error) {
      if (signal.aborted) return;
      this.finishUnresolvedItems(
        items,
        output,
        options,
        error instanceof Error ? error.message : "Cartiva could not reach the backend.",
      );
    }
  }

  private finishUnresolvedItems(
    items: ParsedListItem[],
    output: Map<string, PreparedItem>,
    options: PrepareOptions,
    explanation: string,
  ) {
    for (const item of items) {
      const latest = output.get(item.id);
      if (!latest || latest.matchStatus !== "searching") continue;
      const failed: PreparedItem = {
        ...latest,
        matchStatus: "api_error",
        cartStatus: "failed",
        explanation,
      };
      output.set(item.id, failed);
      options.onResult({ item: failed, phase: "error" });
    }
  }
}

/**
 * Runs the existing retailer endpoints independently. Each retailer owns its
 * AbortController and cache so one completed or failed request cannot cancel
 * either of the other price checks.
 */
export class CartivaComparisonClient {
  private readonly clients: Record<Retailer, CartivaBackendClient> = {
    walmart: new CartivaBackendClient(),
    target: new CartivaBackendClient(),
    kroger: new CartivaBackendClient(),
  };

  cancel() {
    for (const client of Object.values(this.clients)) client.cancel();
  }

  async prepare(items: ParsedListItem[], options: ComparisonPrepareOptions) {
    const configured = COMPARISON_RETAILERS.filter((retailer) => Boolean(options.retailers[retailer]));
    const settled = await Promise.all(configured.map(async (retailer) => {
      const retailerOptions = options.retailers[retailer];
      if (!retailerOptions) throw new Error(`Missing ${retailer} comparison settings.`);
      try {
        const prepared = await this.clients[retailer].prepare(items, {
          backendBaseUrl: options.backendBaseUrl,
          retailer,
          storeId: retailerOptions.storeId,
          zip: retailerOptions.zip,
          fulfillmentMode: retailerOptions.fulfillmentMode,
          onResult: (result) => options.onResult(retailer, result),
        });
        options.onRetailerComplete?.(retailer, prepared);
        return [retailer, prepared] as const;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Cartiva could not compare this retailer.");
        options.onRetailerError?.(retailer, failure);
        return [retailer, []] as const;
      }
    }));
    return Object.fromEntries(settled) as Partial<Record<Retailer, PreparedItem[]>>;
  }
}
