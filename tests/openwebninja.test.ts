import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWalmartProductDetails,
  parseOpenWebNinjaProductDetail,
  parseOpenWebNinjaSearchProduct,
  searchWalmart,
  WalmartSearchError,
} from "@/lib/openwebninja";

const originalApiKey = process.env.OPENWEBNINJA_API_KEY;
let sequence = 0;

function unique(value: string) {
  sequence += 1;
  return `${value} provider test ${sequence}`;
}

function walmartSearchProduct(overrides: Record<string, unknown> = {}) {
  return {
    product_id: "4SZSM8SXAAJT",
    us_item_id: "609040889",
    title: "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans",
    brand: "Diet Coke",
    price: 8.48,
    list_price: 9.98,
    price_display: "$8.48",
    price_per_unit_amount: "$0.06",
    price_per_unit_type: "fl oz",
    url: "https://www.walmart.com/ip/Diet-Coke-Soda-Pop/609040889",
    seller: "Walmart.com",
    seller_id: "F55CDC31AB754BB68FE0B39041159D63",
    availability: "In stock",
    out_of_stock: false,
    pickup: true,
    delivery_from_store: true,
    shipping: true,
    sponsored: false,
    ...overrides,
  };
}

function searchResponse(products: unknown[]) {
  return Response.json({
    status: "OK",
    request_id: "sanitized-test-request",
    data: { total_results: String(products.length), total_pages: 1, products },
  });
}

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENWEBNINJA_API_KEY;
  else process.env.OPENWEBNINJA_API_KEY = originalApiKey;
  vi.restoreAllMocks();
});

describe("OpenWeb Ninja Walmart provider", () => {
  it("uses curated demo data without making a request when the key is missing", async () => {
    delete process.env.OPENWEBNINJA_API_KEY;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await searchWalmart("eggs", "4366", undefined, {
      zip: "79912",
      state: "TX",
    });

    expect(result.mode).toBe("demo");
    expect(result.products[0]?.dataSource).toBe("mock");
    expect(result.diagnostics).toEqual({
      cacheHit: false,
      deduplicated: false,
      apiCall: false,
      serpApiCacheUsed: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the exact query and localization server-side and preserves exact catalog fields", async () => {
    process.env.OPENWEBNINJA_API_KEY = "private-test-key";
    const exactTitle = "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans";
    const exactUrl = "https://www.walmart.com/ip/Diet-Coke-Soda-Pop/609040889";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(searchResponse([
      walmartSearchProduct({ title: exactTitle, url: exactUrl }),
      walmartSearchProduct({
        product_id: "FINANCE",
        us_item_id: "123456789",
        title: "Financed Product",
        price: 15.25,
        price_display: "$15.25/month",
        url: "https://www.walmart.com/ip/Financed-Product/123456789",
      }),
    ]));

    const result = await searchWalmart(unique("diet coke"), "4366", undefined, {
      zip: "79912",
      state: "tx",
      domain: "us",
    });

    expect(result.mode).toBe("live");
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({
      title: exactTitle,
      productId: "4SZSM8SXAAJT",
      itemId: "609040889",
      price: 8.48,
      sourceUrl: exactUrl,
      link: exactUrl,
      linkType: "product",
      dataSource: "openwebninja",
      seller: "Walmart.com",
      brand: "Diet Coke",
      inStock: true,
    });
    expect(result.products[0]?.priceProvenance).toMatchObject({
      priceSource: "walmart_search",
      priceScope: "localized",
      searchPriceCents: 848,
      regularPriceCents: 998,
      requestedStoreId: "4366",
      searchLocation: { postalCode: "79912", provinceCode: "TX", country: "US" },
      fulfillment: ["pickup", "delivery", "shipping"],
      sellerType: "walmart",
      localPriceEligible: true,
      localPriceVerified: false,
    });
    expect(result.products[0]?.priceProvenance?.searchStoreMatched).toBeUndefined();

    const [request, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.origin + url.pathname).toBe(
      "https://api.openwebninja.com/real-time-walmart-data/search",
    );
    expect(url.searchParams.get("query")).toContain("diet coke");
    expect(url.searchParams.get("store_id")).toBe("4366");
    expect(url.searchParams.get("zip")).toBe("79912");
    expect(url.searchParams.get("state")).toBe("TX");
    expect(url.searchParams.get("domain")).toBe("us");
    expect(url.searchParams.get("sort_by")).toBe("best_match");
    expect(url.searchParams.has("x-api-key")).toBe(false);
    expect(new Headers(init?.headers).get("x-api-key")).toBe("private-test-key");
  });

  it("rejects financing prices without rewriting the returned product", () => {
    const context = { storeId: "4366", zip: "79912", state: "TX" };
    expect(parseOpenWebNinjaSearchProduct(walmartSearchProduct({
      price: 12.5,
      price_display: "$12.50 per month",
    }), context)).toBeNull();
    expect(parseOpenWebNinjaProductDetail(walmartSearchProduct({
      price: 12.5,
      price_display: "$12.50/month",
    }), context)).toBeNull();
  });

  it.each([
    ["5.3 ¢/fl oz", "fl oz", 0.053, "fl oz"],
    ["12.3 Â¢/ea", "each", 0.123, "each"],
    ["$5.16/100 ct", "count", 0.0516, "each"],
  ] as const)(
    "normalizes retailer unit-price display %s",
    (amount, type, expectedPrice, expectedBasis) => {
      const product = parseOpenWebNinjaSearchProduct(walmartSearchProduct({
        price_per_unit_amount: amount,
        price_per_unit_type: type,
      }), { storeId: "4366", zip: "79912", state: "TX" });

      expect(product?.reportedUnitPrice).toBe(expectedPrice);
      expect(product?.reportedUnitBasis).toBe(expectedBasis);
      expect(product?.priceProvenance?.unitPrice).toBe(expectedPrice);
    },
  );

  it("caches a successful localized search and reports the cache hit", async () => {
    process.env.OPENWEBNINJA_API_KEY = "private-test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      searchResponse([walmartSearchProduct()]),
    );
    const query = unique("cached coke");

    const first = await searchWalmart(query, "4366", undefined, { zip: "79912", state: "TX" });
    const second = await searchWalmart(query, "4366", undefined, { zip: "79912", state: "TX" });

    expect(first.diagnostics).toMatchObject({ cacheHit: false, apiCall: true });
    expect(second.diagnostics).toEqual({
      cacheHit: true,
      deduplicated: false,
      apiCall: false,
      serpApiCacheUsed: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates an in-flight request while one caller can abort independently", async () => {
    process.env.OPENWEBNINJA_API_KEY = "private-test-key";
    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pendingResponse);
    const query = unique("shared ham");
    const firstController = new AbortController();

    const first = searchWalmart(query, "4366", firstController.signal, { zip: "79912" });
    const second = searchWalmart(query, "4366", undefined, { zip: "79912" });
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    resolveResponse(searchResponse([walmartSearchProduct()]));
    const surviving = await second;

    expect(surviving.products).toHaveLength(1);
    expect(surviving.diagnostics).toEqual({
      cacheHit: true,
      deduplicated: true,
      apiCall: false,
      serpApiCacheUsed: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gets product details by ID without pretending the detail request is store-scoped", async () => {
    process.env.OPENWEBNINJA_API_KEY = "private-test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      status: "OK",
      request_id: "detail-test-request",
      data: {
        ...walmartSearchProduct(),
        upc: "049000028911",
        type: "Soda Pop",
        seller_type: "INTERNAL",
        fulfillment_type: "WFS",
      },
    }));

    const result = await getWalmartProductDetails(
      unique("609040889"),
      "4366",
      undefined,
      { zip: "79912", state: "TX", domain: "us" },
    );

    expect(result.product).toMatchObject({
      title: "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans",
      upc: "049000028911",
      productType: "Soda Pop",
      dataSource: "openwebninja",
    });
    expect(result.product?.priceProvenance).toMatchObject({
      priceSource: "product_detail",
      requestedStoreId: "4366",
      sellerType: "walmart",
      localPriceEligible: false,
      localPriceVerified: false,
    });
    expect(result.product?.priceProvenance?.detailStoreMatched).toBeUndefined();

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe("/real-time-walmart-data/product-details");
    expect(requestUrl.searchParams.get("product_id")).toContain("609040889");
    expect(requestUrl.searchParams.get("domain")).toBe("us");
    expect(requestUrl.searchParams.has("store_id")).toBe(false);
    expect(requestUrl.searchParams.has("zip")).toBe(false);
    expect(requestUrl.searchParams.has("state")).toBe(false);
  });

  it.each([
    [401, "authentication"],
    [429, "rate_limit"],
    [503, "api_error"],
  ] as const)("classifies HTTP %s safely as %s", async (status, code) => {
    process.env.OPENWEBNINJA_API_KEY = "private-test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ message: "provider details must not be reflected" }),
      { status, headers: { "Content-Type": "application/json" } },
    ));

    const request = searchWalmart(unique(`error ${status}`), "4366");

    await expect(request).rejects.toMatchObject({ code });
    await expect(request).rejects.not.toThrow(/provider details/i);
  });

  it("classifies an invalid success payload as malformed", async () => {
    process.env.OPENWEBNINJA_API_KEY = "private-test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "OK" }));

    const error = await searchWalmart(unique("malformed"), "4366").catch((reason) => reason);
    expect(error).toBeInstanceOf(WalmartSearchError);
    expect((error as WalmartSearchError).code).toBe("malformed");
  });

  it("limits all live provider request starts to two per second globally", async () => {
    process.env.OPENWEBNINJA_API_KEY = "private-test-key";
    const starts: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      starts.push(Date.now());
      return searchResponse([walmartSearchProduct()]);
    });

    await Promise.all([
      searchWalmart(unique("rate one"), "4366"),
      searchWalmart(unique("rate two"), "4366"),
      searchWalmart(unique("rate three"), "4366"),
    ]);

    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(450);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(450);
  });
});
