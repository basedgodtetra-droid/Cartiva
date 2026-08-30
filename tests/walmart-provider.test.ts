import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDecodoWalmartProduct,
  searchDecodoWalmart,
  toWalmartProduct,
  toWalmartProducts,
} from "@/lib/decodo-walmart";
import {
  searchWalmart as searchSerpApi,
} from "@/lib/serpapi";
import {
  activeWalmartDataProvider,
  getWalmartProductDetails,
  hasLiveWalmartProvider,
  searchWalmart,
} from "@/lib/walmart-provider";
import type { WalmartProduct } from "@/lib/types";

vi.mock("@/lib/decodo-walmart", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/decodo-walmart")>();
  return {
    ...actual,
    getDecodoWalmartProduct: vi.fn(),
    searchDecodoWalmart: vi.fn(),
    toWalmartProduct: vi.fn(),
    toWalmartProducts: vi.fn(),
  };
});

vi.mock("@/lib/serpapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/serpapi")>();
  return {
    ...actual,
    getWalmartProductDetails: vi.fn(),
    searchWalmart: vi.fn(),
  };
});

const decodoSearchMock = vi.mocked(searchDecodoWalmart);
const decodoDetailMock = vi.mocked(getDecodoWalmartProduct);
const toProductsMock = vi.mocked(toWalmartProducts);
const toProductMock = vi.mocked(toWalmartProduct);
const serpSearchMock = vi.mocked(searchSerpApi);
const originalProvider = process.env.WALMART_DATA_PROVIDER;
const originalDecodoToken = process.env.DECODO_AUTH_TOKEN;
const originalSerpApiKey = process.env.SERPAPI_API_KEY;

function walmartProduct(id = "12345"): WalmartProduct {
  return {
    retailer: "walmart",
    id,
    productId: id,
    itemId: id,
    title: "Great Value Large White Eggs, 12 Count",
    price: 1.67,
    priceCents: 167,
    link: `https://www.walmart.com/ip/eggs/${id}`,
    linkType: "product",
    seller: "Walmart",
    inStock: true,
    sponsored: false,
    dataSource: "decodo",
  };
}

afterEach(() => {
  vi.clearAllMocks();
  if (originalProvider === undefined) delete process.env.WALMART_DATA_PROVIDER;
  else process.env.WALMART_DATA_PROVIDER = originalProvider;
  if (originalDecodoToken === undefined) delete process.env.DECODO_AUTH_TOKEN;
  else process.env.DECODO_AUTH_TOKEN = originalDecodoToken;
  if (originalSerpApiKey === undefined) delete process.env.SERPAPI_API_KEY;
  else process.env.SERPAPI_API_KEY = originalSerpApiKey;
});

describe("Walmart provider facade", () => {
  it("uses Decodo for pickup when its server token is configured", async () => {
    delete process.env.WALMART_DATA_PROVIDER;
    process.env.DECODO_AUTH_TOKEN = "private-test-token";
    const product = walmartProduct();
    decodoSearchMock.mockResolvedValue({
      products: [] as never[],
      mode: "live",
      diagnostics: { cacheHit: false, deduplicated: false, apiCall: true, durationMs: 12 },
    });
    toProductsMock.mockReturnValue([product]);

    const result = await searchWalmart("eggs", "4366", undefined, {
      fulfillmentMode: "pickup",
      zipCode: "79912",
    });

    expect(activeWalmartDataProvider()).toBe("decodo");
    expect(decodoSearchMock).toHaveBeenCalledWith(
      "eggs",
      { deliveryType: "pickup", storeId: "4366", deliveryZip: "79912" },
      undefined,
    );
    expect(result.products).toEqual([product]);
    expect(result.suggestionSignals).toEqual([]);
    expect(result.diagnostics).toMatchObject({ provider: "decodo", apiCall: true });
  });

  it("localizes Decodo delivery by ZIP instead of inventing a store match", async () => {
    process.env.WALMART_DATA_PROVIDER = "decodo";
    process.env.DECODO_AUTH_TOKEN = "private-test-token";
    decodoSearchMock.mockResolvedValue({
      products: [] as never[],
      mode: "live",
      diagnostics: { cacheHit: false, deduplicated: false, apiCall: true, durationMs: 8 },
    });
    toProductsMock.mockReturnValue([]);

    await searchWalmart("milk", "4366", undefined, {
      fulfillmentMode: "delivery",
      zipCode: "79912",
    });

    expect(decodoSearchMock).toHaveBeenCalledWith(
      "milk",
      { deliveryType: "delivery", deliveryZip: "79912" },
      undefined,
    );
  });

  it("uses the same Decodo location context for selected-product verification", async () => {
    process.env.WALMART_DATA_PROVIDER = "decodo";
    process.env.DECODO_AUTH_TOKEN = "private-test-token";
    const product = walmartProduct();
    decodoDetailMock.mockResolvedValue({
      product: {} as never,
      mode: "live",
      diagnostics: { cacheHit: true, deduplicated: false, apiCall: false, durationMs: 1 },
    });
    toProductMock.mockReturnValue(product);

    const result = await getWalmartProductDetails("12345", "4366", undefined, {
      fulfillmentMode: "pickup",
      zipCode: "79912",
    });

    expect(decodoDetailMock).toHaveBeenCalledWith(
      "12345",
      { deliveryType: "pickup", storeId: "4366", deliveryZip: "79912" },
      undefined,
    );
    expect(result.product).toEqual(product);
  });

  it("keeps SerpApi available through explicit configuration", async () => {
    process.env.WALMART_DATA_PROVIDER = "serpapi";
    process.env.DECODO_AUTH_TOKEN = "private-decodo-token";
    process.env.SERPAPI_API_KEY = "private-serp-key";
    const product = walmartProduct();
    serpSearchMock.mockResolvedValue({
      products: [product],
      suggestionSignals: [],
      mode: "live",
      diagnostics: {
        cacheHit: true,
        deduplicated: false,
        apiCall: false,
        serpApiCacheUsed: true,
      },
    });

    const result = await searchWalmart("eggs", "4366");

    expect(serpSearchMock).toHaveBeenCalledWith("eggs", "4366", undefined);
    expect(decodoSearchMock).not.toHaveBeenCalled();
    expect(result.diagnostics).toMatchObject({ provider: "serpapi", serpApiCacheUsed: true });
  });

  it("reports whether the selected provider has a live credential", () => {
    process.env.WALMART_DATA_PROVIDER = "decodo";
    delete process.env.DECODO_AUTH_TOKEN;
    process.env.SERPAPI_API_KEY = "unused-serp-key";
    expect(hasLiveWalmartProvider()).toBe(false);
    process.env.DECODO_AUTH_TOKEN = "private-test-token";
    expect(hasLiveWalmartProvider()).toBe(true);
  });
});
