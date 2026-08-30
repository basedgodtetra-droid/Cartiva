import {
  DecodoWalmartError,
  getDecodoWalmartProduct,
  searchDecodoWalmart,
  toWalmartProduct,
  toWalmartProducts,
} from "./decodo-walmart";
import type { DecodoWalmartOptions } from "./decodo-walmart";
import {
  getWalmartProductDetails as getSerpApiWalmartProductDetails,
  searchWalmart as searchSerpApiWalmart,
  WalmartSearchError,
} from "./serpapi";
import type {
  SerpApiCallDiagnostics,
  WalmartSearchSuggestionSignal,
} from "./serpapi";
import type { WalmartProduct } from "./types";

export { WalmartSearchError } from "./serpapi";

export type WalmartDataProvider = "decodo" | "serpapi";

export interface WalmartProviderLocation {
  fulfillmentMode?: "pickup" | "delivery" | "shipping";
  zipCode?: string;
  state?: string;
}

export interface WalmartProviderDiagnostics extends SerpApiCallDiagnostics {
  provider: WalmartDataProvider;
  durationMs?: number;
}

export interface WalmartProviderSearchResult {
  products: WalmartProduct[];
  suggestionSignals?: WalmartSearchSuggestionSignal[];
  mode: "live" | "demo";
  diagnostics: WalmartProviderDiagnostics;
}

export interface WalmartProviderDetailResult {
  product: WalmartProduct | null;
  mode: "live" | "demo";
  diagnostics: WalmartProviderDiagnostics;
}

function configuredProviderValue() {
  return process.env.WALMART_DATA_PROVIDER?.trim().toLowerCase();
}

export function activeWalmartDataProvider(): WalmartDataProvider {
  const configured = configuredProviderValue();
  if (configured === "decodo" || configured === "serpapi") return configured;
  if (configured) {
    throw new WalmartSearchError(
      "Choose decodo or serpapi as the Walmart data provider.",
      "configuration",
    );
  }
  if (process.env.DECODO_AUTH_TOKEN?.trim()) return "decodo";
  return "serpapi";
}

export function hasLiveWalmartProvider() {
  try {
    const provider = activeWalmartDataProvider();
    return provider === "decodo"
      ? Boolean(process.env.DECODO_AUTH_TOKEN?.trim())
      : Boolean(process.env.SERPAPI_API_KEY?.trim());
  } catch {
    return false;
  }
}

function decodoOptions(
  storeId: string,
  location: WalmartProviderLocation = {},
): DecodoWalmartOptions {
  const fulfillmentMode = location.fulfillmentMode ?? "pickup";
  if (fulfillmentMode === "delivery" || fulfillmentMode === "shipping") {
    const deliveryZip = location.zipCode?.trim();
    if (!deliveryZip) {
      throw new WalmartSearchError(
        "Enter a ZIP code before searching Walmart delivery or shipping prices.",
        "configuration",
      );
    }
    return { deliveryType: fulfillmentMode, deliveryZip };
  }
  const deliveryZip = location.zipCode?.trim();
  if (!deliveryZip) {
    throw new WalmartSearchError(
      "Enter a ZIP code before searching Walmart pickup prices.",
      "configuration",
    );
  }
  return {
    deliveryType: "pickup",
    storeId: storeId.trim(),
    deliveryZip,
  };
}

function decodoDiagnostics(
  providerDiagnostics: {
    cacheHit: boolean;
    deduplicated: boolean;
    apiCall: boolean;
    durationMs: number;
  },
): WalmartProviderDiagnostics {
  return {
    ...providerDiagnostics,
    provider: "decodo",
    serpApiCacheUsed: null,
  };
}

function serpApiDiagnostics(
  diagnostics: SerpApiCallDiagnostics,
): WalmartProviderDiagnostics {
  return { ...diagnostics, provider: "serpapi" };
}

function throwProviderError(error: unknown): never {
  if (!(error instanceof DecodoWalmartError)) throw error;
  const code = error.code === "not_found" ? "api_error" : error.code;
  throw new WalmartSearchError(error.message, code);
}

export async function searchWalmart(
  query: string,
  storeId: string,
  requestSignal?: AbortSignal,
  location: WalmartProviderLocation = {},
): Promise<WalmartProviderSearchResult> {
  const provider = activeWalmartDataProvider();
  if (provider === "serpapi") {
    const result = await searchSerpApiWalmart(query, storeId, requestSignal);
    return {
      ...result,
      diagnostics: serpApiDiagnostics(result.diagnostics),
    };
  }

  try {
    const result = await searchDecodoWalmart(
      query,
      decodoOptions(storeId, location),
      requestSignal,
    );
    return {
      products: toWalmartProducts(result.products),
      suggestionSignals: [],
      mode: "live",
      diagnostics: decodoDiagnostics(result.diagnostics),
    };
  } catch (error) {
    throwProviderError(error);
  }
}

export async function getWalmartProductDetails(
  productId: string,
  storeId: string,
  requestSignal?: AbortSignal,
  location: WalmartProviderLocation = {},
): Promise<WalmartProviderDetailResult> {
  const provider = activeWalmartDataProvider();
  if (provider === "serpapi") {
    const result = await getSerpApiWalmartProductDetails(
      productId,
      storeId,
      requestSignal,
    );
    return {
      ...result,
      diagnostics: serpApiDiagnostics(result.diagnostics),
    };
  }

  try {
    const result = await getDecodoWalmartProduct(
      productId,
      decodoOptions(storeId, location),
      requestSignal,
    );
    return {
      product: result.product ? toWalmartProduct(result.product) : null,
      mode: "live",
      diagnostics: decodoDiagnostics(result.diagnostics),
    };
  } catch (error) {
    throwProviderError(error);
  }
}
import "./server-only-guard";
