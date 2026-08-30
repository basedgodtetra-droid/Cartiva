import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWalmartProductDetails,
  parseSerpApiProductDetail,
  parseSerpApiResponseLocation,
  parseSerpApiSearchProduct,
  searchWalmart,
} from "@/lib/serpapi";

const originalApiKey = process.env.SERPAPI_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.SERPAPI_API_KEY;
  else process.env.SERPAPI_API_KEY = originalApiKey;
  vi.restoreAllMocks();
});

describe("SerpApi Walmart data handling", () => {
  it("preserves product-detail store, seller, fulfillment, and price provenance", () => {
    const product = parseSerpApiProductDetail({
      search_parameters: { store_id: "2201" },
      search_information: { location: { store_id: "2201" } },
      product_result: {
        title: "Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 24 Pack",
        product_id: "2BNVDJDOIX2I",
        us_item_id: "13812835",
        product_page_url: "https://www.walmart.com/ip/Coca-Cola-Zero-Sugar/13812835",
        manufacturer: "Coca-Cola",
        price_map: { price: 14.97, unit_price: 0.052 },
        in_stock: true,
        offer_type: "ONLINE_AND_STORE",
        offers: [{ seller_name: "Walmart.com", price: 14.97 }],
        pickup_option: { available: true },
        shipping_option: { available: true },
      },
    }, { requestedStoreId: "2201", checkedAt: "2026-08-05T12:00:00.000Z" });

    expect(product?.priceProvenance).toMatchObject({
      priceSource: "product_detail",
      productDetailPriceCents: 1497,
      requestedStoreId: "2201",
      detailStoreId: "2201",
      detailLocation: {
        storeId: "2201",
      },
      detailStoreMatched: true,
      fulfillment: ["in_store", "pickup", "shipping"],
      sellerType: "walmart",
    });
  });

  it("keeps an egg title count separate from unrelated product-detail weight specifications", () => {
    const product = parseSerpApiProductDetail({
      product_result: {
        title: "Marketside Organic Cage Free Large Brown Eggs, 12 Count",
        product_id: "EGGS12",
        us_item_id: "123456789",
        product_page_url: "https://www.walmart.com/ip/eggs/123456789",
        price_map: { price: 3.97 },
        in_stock: true,
        specification_highlights: [
          { display_name: "Assembled Product Weight", value: "1.69 lb" },
          { display_name: "Net content statement", value: "12 Count" },
        ],
      },
    });

    expect(product?.size).toMatchObject({
      kind: "count",
      baseAmount: 12,
      baseUnit: "each",
      label: "12 count",
    });
    expect(product?.size?.packCount).toBeUndefined();
  });

  it("uses an explicit net-content count when a product-detail title omits package size", () => {
    const product = parseSerpApiProductDetail({
      product_result: {
        title: "Marketside Organic Cage Free Large Brown Eggs",
        product_id: "EGGS12-NO-TITLE-SIZE",
        us_item_id: "987654321",
        product_page_url: "https://www.walmart.com/ip/eggs/987654321",
        price_map: { price: 3.97 },
        in_stock: true,
        specification_highlights: [
          { display_name: "Assembled Product Weight", value: "1.69 lb" },
          { display_name: "Net content statement", value: "12 Count" },
        ],
      },
    });

    expect(product?.size).toMatchObject({
      kind: "count",
      baseAmount: 12,
      baseUnit: "each",
      label: "12 count",
    });
    expect(product?.size?.packCount).toBeUndefined();
  });

  it("treats an unavailable Product API identifier as a null detail for item-ID fallback", () => {
    expect(parseSerpApiProductDetail({ error: "The product could not be found." })).toBeNull();
    expect(parseSerpApiProductDetail({ error: "The product has not found." })).toBeNull();
  });

  it("treats SerpApi's product-has-not-found search response as an empty result", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: "The product has not found.",
    }));

    const result = await searchWalmart(`definitive empty result ${Date.now()}`, "2201");

    expect(result).toMatchObject({ mode: "live", products: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns supported Walmart spelling, related-query, and recursive filter signals", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      search_information: {
        spelling_fix: "black forest ham",
      },
      related_queries: [
        { suggested: "  BLACK   FOREST HAM ", score: "0.9" },
        { suggested: "black forest ham lunch meat", score: "0.75" },
        { suggested: "black forest ham deli", score: 0.5 },
        { suggested: "black forest ham sliced", score: "not-a-score" },
        { suggested: 42, score: 1 },
      ],
      filters: [
        {
          name: "Departments",
          values: [
            {
              name: "Food",
              item_count: "1,234",
              values: [{ name: "Deli", item_count: 25 }],
            },
            { name: "black forest ham lunch meat", item_count: 10 },
          ],
        },
        {
          name: "Brand",
          values: [{ name: "Great Value", item_count: "80" }],
        },
        { name: "Malformed", values: "not-an-array" },
      ],
      organic_results: [],
    }));

    const result = await searchWalmart(`supported suggestion signals ${Date.now()}`, "2201");

    expect(result.suggestionSignals).toEqual([
      { text: "black forest ham", source: "spelling" },
      { text: "black forest ham lunch meat", source: "related", score: 0.75 },
      { text: "black forest ham deli", source: "related", score: 0.5 },
      { text: "black forest ham sliced", source: "related", score: undefined },
      { text: "Food", source: "filter", group: "Departments", itemCount: 1234 },
      { text: "Deli", source: "filter", group: "Departments", itemCount: 25 },
      { text: "Great Value", source: "filter", group: "Brand", itemCount: 80 },
    ]);

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get("engine")).toBe("walmart");
    expect(requestUrl.searchParams.get("store_id")).toBe("2201");
    expect(requestUrl.searchParams.get("spelling")).toBe("true");
    expect(requestUrl.searchParams.get("include_filters")).toBe("true");
    expect(requestUrl.searchParams.has("no_cache")).toBe(false);
  });

  it("bounds malformed Walmart filter signals without traversing unbounded depth", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    const tooDeep = {
      name: "Level 1",
      values: [{
        name: "Level 2",
        values: [{
          name: "Level 3",
          values: [{
            name: "Level 4",
            values: [{
              name: "Level 5",
              values: [{ name: "Level 6 should be omitted" }],
            }],
          }],
        }],
      }],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      related_queries: null,
      filters: [{
        name: "Options",
        values: [
          tooDeep,
          ...Array.from({ length: 80 }, (_, index) => ({
            name: `Option ${index + 1}`,
            item_count: index,
          })),
          null,
          { name: "x".repeat(161) },
        ],
      }],
      organic_results: [],
    }));

    const result = await searchWalmart(`bounded suggestion signals ${Date.now()}`, "2201");
    const signals = result.suggestionSignals ?? [];

    expect(signals).toHaveLength(48);
    expect(signals[0]).toEqual({
      text: "Level 1",
      source: "filter",
      group: "Options",
      itemCount: undefined,
    });
    expect(signals.some(({ text }) => text === "Level 5")).toBe(true);
    expect(signals.some(({ text }) => text === "Level 6 should be omitted")).toBe(false);
  });

  it("preserves normalized response-location metadata", () => {
    expect(parseSerpApiResponseLocation({
      store_id: "2201",
      postal_code: "79925-1234",
      city: "  El   Paso ",
      province_code: "TX",
      country_code: "US",
    })).toEqual({
      storeId: "2201",
      postalCode: "79925",
      city: "El Paso",
      provinceCode: "TX",
      country: "US",
    });
  });

  it("does not treat an echoed Product API store parameter as location verification", () => {
    const product = parseSerpApiProductDetail({
      search_parameters: { store_id: "2201" },
      product_result: {
        title: "Great Value Large White Eggs, 12 Count",
        product_id: "ABC123",
        us_item_id: "123456789",
        product_page_url: "https://www.walmart.com/ip/eggs/123456789",
        price_map: { price: 2.48 },
        in_stock: true,
      },
    }, { requestedStoreId: "2201" });

    expect(product?.priceProvenance?.detailStoreId).toBeUndefined();
    expect(product?.priceProvenance?.detailStoreMatched).toBe(false);
  });

  it("preserves the exact returned title, identifiers, brand, price, and source URL", () => {
    const exactTitle = "Takis® Fuego Hot Chili Pepper & Lime Chips, 9.9 oz";
    const sourceUrl = "https://www.walmart.com/ip/Takis-Fuego/987654321";
    const product = parseSerpApiSearchProduct({
      title: exactTitle,
      product_id: "123456789",
      us_item_id: "987654321",
      upc: "075200012345",
      product_page_url: sourceUrl,
      brand: "Takis",
      price: 3.48,
      availability: "In stock",
      seller_name: "Walmart.com",
      primary_offer: { offer_price: 3.48, was_price: 3.98 },
      price_per_unit: { amount: "35.2 ¢/oz", unit: "each" },
    }, 0, {
      requestedStoreId: "2201",
      responseLocation: { storeId: "2201" },
      checkedAt: "2026-08-05T12:00:00.000Z",
    });

    expect(product?.title).toBe(exactTitle);
    expect(product?.productId).toBe("123456789");
    expect(product?.itemId).toBe("987654321");
    expect(product?.upc).toBe("075200012345");
    expect(product?.brand).toBe("Takis");
    expect(product?.price).toBe(3.48);
    expect(product?.sourceUrl).toBe(sourceUrl);
    expect(product?.link).toBe(sourceUrl);
    expect(product?.linkType).toBe("product");
    expect(product?.priceCents).toBe(348);
    expect(product?.priceProvenance).toMatchObject({
      priceSource: "local_store_sale",
      searchPriceCents: 348,
      regularPriceCents: 398,
      salePriceCents: 348,
      requestedStoreId: "2201",
      searchStoreId: "2201",
      searchStoreMatched: true,
      sellerType: "walmart",
      localPriceEligible: true,
    });
  });

  it("decodes transport-safe catalog entities without rewriting the product name", () => {
    const product = parseSerpApiSearchProduct({
      title: "Takis Fuego, Hot Chili Pepper &amp; Lime Rolled Tortilla Chips",
      product_id: "TAKIS-ENTITY",
      price: 4.08,
      availability: "In stock",
      seller_name: "Walmart.com",
    }, 0);

    expect(product?.title).toBe("Takis Fuego, Hot Chili Pepper & Lime Rolled Tortilla Chips");
  });

  it.each([
    ["Great Value Everyday Disposable Foam Plates, 9 in, 50 ct", 2.58, "$5.16/100 ct", 0.0516],
    ["Parent's Choice Fragrance Free Baby Wipes, Travel-Pack, 50 Count", 1.17, "$2.34/100 ct", 0.0234],
  ])("normalizes Walmart per-100 count prices for %s", (title, price, amount, expected) => {
    const product = parseSerpApiSearchProduct({
      title,
      product_id: "COUNT-ITEM",
      price,
      price_per_unit: { unit: "each", amount },
      availability: "In stock",
      seller_name: "Walmart.com",
    }, 0);

    expect(product?.reportedUnitPrice).toBe(expected);
    expect(product?.reportedUnitBasis).toBe("each");
    expect(product?.priceProvenance?.unitPriceCents).toBe(Math.round(expected * 100));
  });

  it("does not treat a basis-free Product API unit-price number as comparable", () => {
    const product = parseSerpApiProductDetail({
      product_result: {
        title: "Great Value Everyday Disposable Foam Plates, 9 in, 50 ct",
        product_id: "PLATES50",
        product_page_url: "https://www.walmart.com/ip/plates/123456789",
        price_map: { price: 2.58, unit_price: 5.16 },
        in_stock: true,
      },
    });

    expect(product?.reportedUnitPrice).toBeUndefined();
    expect(product?.reportedUnitBasis).toBeUndefined();
  });

  it("never invents an /ip/ URL when SerpApi omits the canonical link", () => {
    const product = parseSerpApiSearchProduct({
      title: "7UP Lemon Lime Soda, 12 Pack, 12 fl oz Cans",
      product_id: "123456789",
      brand: "7UP",
      price: 7.97,
      availability: "In stock",
    }, 0);

    expect(product?.linkType).toBe("search");
    expect(product?.link).toMatch(/^https:\/\/www\.walmart\.com\/search\?q=/);
    expect(product?.link).not.toContain("/ip/");
  });

  it("reports an authentication error instead of pretending failed live data is demo data", async () => {
    process.env.SERPAPI_API_KEY = "expired-test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));

    await expect(searchWalmart("authentication failure test item", "1234"))
      .rejects.toMatchObject({ code: "authentication" });
  });

  it("does not treat an echoed Search API store parameter as location verification", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      search_parameters: { store_id: "2201" },
      organic_results: [{
        title: "Great Value Large White Eggs, 12 Count",
        product_id: "ABC123",
        us_item_id: "123456789",
        product_page_url: "https://www.walmart.com/ip/eggs/123456789",
        price: 2.48,
        availability: "In stock",
        seller_name: "Walmart.com",
        pickup_option: { available: true },
      }],
    }));

    const result = await searchWalmart(`echo-only store test ${Date.now()}`, "2201");
    expect(result.products[0].priceProvenance).toMatchObject({
      requestedStoreId: "2201",
      searchStoreMatched: false,
      localPriceEligible: false,
    });
    expect(result.products[0].priceProvenance?.searchStoreId).toBeUndefined();
  });

  it("uses the observed response store even when the echoed parameter differs", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      search_parameters: { store_id: "2201" },
      search_information: {
        location: { store_id: "512", postal_code: "79935", city: "El Paso", province_code: "TX" },
      },
      organic_results: [{
        title: "Great Value Large White Eggs, 12 Count",
        product_id: "ABC123",
        us_item_id: "123456789",
        product_page_url: "https://www.walmart.com/ip/eggs/123456789",
        price: 2.48,
        availability: "In stock",
        seller_name: "Walmart.com",
        pickup_option: { available: true },
      }],
    }));

    const result = await searchWalmart(`mismatched observed store test ${Date.now()}`, "2201");
    expect(result.products[0].priceProvenance).toMatchObject({
      requestedStoreId: "2201",
      searchStoreId: "512",
      searchStoreMatched: false,
      searchLocation: {
        storeId: "512",
        postalCode: "79935",
        city: "El Paso",
        provinceCode: "TX",
      },
      localPriceEligible: false,
    });
  });

  it("deduplicates identical in-flight searches and then serves the local cache", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({
        search_metadata: { status: "Success" },
        organic_results: [{
          title: "Test Grocery Product, 12 oz",
          product_id: "123456789",
          product_page_url: "https://www.walmart.com/ip/Test-Grocery-Product/123456789",
          price: 2.48,
          availability: "In stock",
        }],
      });
    });

    const query = `dedupe cache test ${Date.now()}`;
    const [first, shared] = await Promise.all([
      searchWalmart(query, "1234"),
      searchWalmart(query, "1234"),
    ]);
    const cached = await searchWalmart(query, "1234");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([first, shared].some((result) => result.diagnostics.deduplicated)).toBe(true);
    expect(cached.diagnostics.cacheHit).toBe(true);
    expect(cached.diagnostics.apiCall).toBe(false);
  });

  it("lets one search consumer abort without cancelling its joiner or cache fill", async () => {
    const privateKey = "abort-search-private-key";
    process.env.SERPAPI_API_KEY = privateKey;
    let resolveUpstream!: (response: Response) => void;
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveUpstream = resolve;
      });
    });
    const query = `abort-safe shared search ${Date.now()}`;
    const cancelledConsumer = new AbortController();

    const first = searchWalmart(query, "1234", cancelledConsumer.signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cancelledConsumer.abort();
    const cancellation = await first.catch((error: unknown) => error);

    expect(cancellation).toMatchObject({ name: "AbortError" });
    expect(String((cancellation as Error).message)).not.toContain(privateKey);
    expect(JSON.stringify(cancellation)).not.toContain(privateKey);
    expect(upstreamSignal?.aborted).toBe(false);

    // The initiating UI caller is gone, but Prepare can still join the exact
    // request instead of starting over or inheriting that cancellation.
    const joined = searchWalmart(query, "1234");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveUpstream(Response.json({
      search_metadata: { status: "Success" },
      organic_results: [{
        title: "Shared Search Grocery Product, 12 oz",
        product_id: "SHARED-SEARCH-PRODUCT",
        product_page_url: "https://www.walmart.com/ip/shared-search/123456789",
        price: 2.48,
        availability: "In stock",
      }],
    }));

    const joinedResult = await joined;
    const cached = await searchWalmart(query, "1234");

    expect(joinedResult.products[0]?.title).toBe("Shared Search Grocery Product, 12 oz");
    expect(joinedResult.diagnostics.deduplicated).toBe(true);
    expect(cached.diagnostics).toMatchObject({ cacheHit: true, apiCall: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start Walmart work for an already-cancelled consumer", async () => {
    process.env.SERPAPI_API_KEY = "already-cancelled-private-key";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cancelledConsumer = new AbortController();
    cancelledConsumer.abort();

    await expect(searchWalmart(
      `already cancelled search ${Date.now()}`,
      "1234",
      cancelledConsumer.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    await expect(getWalmartProductDetails(
      String(Date.now()),
      "1234",
      cancelledConsumer.signal,
    )).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets one product-detail consumer abort without cancelling its joiner or cache fill", async () => {
    const privateKey = "abort-detail-private-key";
    process.env.SERPAPI_API_KEY = privateKey;
    let resolveUpstream!: (response: Response) => void;
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveUpstream = resolve;
      });
    });
    const productId = `shared-detail-${Date.now()}`;
    const cancelledConsumer = new AbortController();

    const first = getWalmartProductDetails(productId, "1234", cancelledConsumer.signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cancelledConsumer.abort();
    const cancellation = await first.catch((error: unknown) => error);

    expect(cancellation).toMatchObject({ name: "AbortError" });
    expect(String((cancellation as Error).message)).not.toContain(privateKey);
    expect(JSON.stringify(cancellation)).not.toContain(privateKey);
    expect(upstreamSignal?.aborted).toBe(false);

    const joined = getWalmartProductDetails(productId, "1234");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveUpstream(Response.json({
      search_information: { location: { store_id: "1234" } },
      product_result: {
        title: "Shared Detail Grocery Product, 12 oz",
        product_id: productId,
        us_item_id: "987654321",
        product_page_url: "https://www.walmart.com/ip/shared-detail/987654321",
        price_map: { price: 3.48 },
        in_stock: true,
        offers: [{ seller_name: "Walmart.com", price: 3.48 }],
        pickup_option: { available: true },
      },
    }));

    const joinedResult = await joined;
    const cached = await getWalmartProductDetails(productId, "1234");

    expect(joinedResult.product?.title).toBe("Shared Detail Grocery Product, 12 oz");
    expect(joinedResult.diagnostics.deduplicated).toBe(true);
    expect(cached.diagnostics).toMatchObject({ cacheHit: true, apiCall: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("negative-caches unavailable product details instead of repeatedly calling SerpApi", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: "The product could not be found.",
    }));
    const productId = `missing-detail-${Date.now()}`;

    const first = await getWalmartProductDetails(productId, "1234");
    const cached = await getWalmartProductDetails(productId, "1234");

    expect(first.product).toBeNull();
    expect(cached.product).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached.diagnostics.cacheHit).toBe(true);
    expect(cached.diagnostics.apiCall).toBe(false);
  });
});
