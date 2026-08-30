import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWalmartProductDetails,
  parseScrapingBeeProductDetail,
  parseScrapingBeeSearchProduct,
  searchWalmart,
  WalmartSearchError,
} from "@/lib/scrapingbee";
import { rankProducts } from "@/lib/matching";
import { verifySelectedProduct } from "@/lib/verification";

const originalApiKey = process.env.SCRAPINGBEE_API_KEY;
let sequence = 9_000_000_000;

function uniqueQuery(value: string) {
  sequence += 1;
  return `${value} provider test ${sequence}`;
}

function nextId() {
  sequence += 1;
  return String(sequence);
}

function searchProduct(overrides: Record<string, unknown> = {}) {
  const productId = nextId();
  return {
    position: 1,
    product_id: productId,
    title: "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans",
    price: 8.48,
    currency: "USD",
    availability: "In stock",
    image: "https://i5.walmartimages.com/example.jpg",
    url: `https://www.walmart.com/ip/Diet-Coke-Soda-Pop/${productId}`,
    brand: "Diet Coke",
    seller: "Walmart",
    fulfillment: {
      pickup: true,
      delivery: true,
      shipping: true,
      free_shipping: true,
    },
    free_shipping: true,
    two_day_shipping: true,
    sponsored: false,
    ...overrides,
  };
}

function searchResponse(
  products: unknown[],
  location: Record<string, unknown> = { zip_code: "79912", store_id: "4366" },
) {
  return Response.json({
    meta_data: {
      url: "https://www.walmart.com/search?q=diet%20coke",
      number_of_results: products.length,
      number_of_products: products.length,
      page: 1,
      total_pages: 1,
    },
    products,
    facets: {},
    location,
  });
}

function productDetail(overrides: Record<string, unknown> = {}) {
  const productId = nextId();
  return {
    product_id: productId,
    title: "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans",
    description: "Diet Coke cans.",
    url: `https://www.walmart.com/ip/Diet-Coke-Soda-Pop/${productId}`,
    price: {
      current: 8.48,
      original: 9.98,
      currency: "USD",
      discount_percentage: 15,
    },
    availability: {
      in_stock: true,
      quantity: 7,
      delivery_options: {
        standard: "3-5 business days",
        pickup: "Available today",
      },
    },
    images: ["https://i5.walmartimages.com/example.jpg"],
    specifications: {
      brand: "Diet Coke",
      category: "Soda Pop",
      UPC: "049000028911",
    },
    seller: { name: "Walmart", id: "walmart", rating: null },
    shipping: { free: true, price: 0, two_day: true },
    ...overrides,
  };
}

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.SCRAPINGBEE_API_KEY;
  else process.env.SCRAPINGBEE_API_KEY = originalApiKey;
  vi.restoreAllMocks();
});

describe("ScrapingBee Walmart provider", () => {
  it("uses curated demo data without an upstream request when the key is missing", async () => {
    delete process.env.SCRAPINGBEE_API_KEY;
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

  it("uses the official search envelope, Bearer auth, and exact store/ZIP localization", async () => {
    process.env.SCRAPINGBEE_API_KEY = "private-test-key";
    const productId = nextId();
    const exactTitle = "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans";
    const exactUrl = `https://www.walmart.com/ip/Diet-Coke-Soda-Pop/${productId}`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(searchResponse([
      searchProduct({ product_id: productId, title: exactTitle, url: exactUrl }),
    ]));

    const result = await searchWalmart(uniqueQuery("diet coke"), "4366", undefined, {
      zip: "79912",
      state: "tx",
      domain: "us",
    });

    expect(result.mode).toBe("live");
    expect(result.products[0]).toMatchObject({
      title: exactTitle,
      id: productId,
      productId,
      itemId: productId,
      price: 8.48,
      sourceUrl: exactUrl,
      link: exactUrl,
      linkType: "product",
      dataSource: "scrapingbee",
      seller: "Walmart",
      brand: "Diet Coke",
      inStock: true,
    });
    expect(result.products[0]?.priceProvenance).toMatchObject({
      priceSource: "local_store_search",
      priceScope: "exact_store",
      searchPriceCents: 848,
      requestedStoreId: "4366",
      searchStoreId: "4366",
      searchStoreMatched: true,
      searchLocation: {
        storeId: "4366",
        postalCode: "79912",
        provinceCode: "TX",
        country: "US",
      },
      fulfillment: ["in_store", "pickup", "delivery", "shipping"],
      sellerType: "walmart",
      localPriceEligible: true,
      localPriceVerified: false,
    });

    const [request, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.origin + url.pathname).toBe(
      "https://app.scrapingbee.com/api/v1/walmart/search",
    );
    expect(url.searchParams.get("query")).toContain("diet coke");
    expect(url.searchParams.get("store_id")).toBe("4366");
    expect(url.searchParams.get("delivery_zip")).toBe("79912");
    expect(url.searchParams.get("domain")).toBe("com");
    expect(url.searchParams.has("fulfillment_type")).toBe(false);
    expect(url.searchParams.get("device")).toBe("desktop");
    expect(url.searchParams.get("light_request")).toBe("true");
    expect(url.searchParams.has("api_key")).toBe(false);
    expect(url.href).not.toContain("private-test-key");
    expect(new Headers(init?.headers).get("Authorization"))
      .toBe("Bearer private-test-key");
  });

  it("parses the live ScrapingBee Search shape without synthesized identifiers", async () => {
    process.env.SCRAPINGBEE_API_KEY = "private-test-key";
    const id = nextId();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(searchResponse([
      {
        id,
        title: "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans",
        price: 8.48,
        out_of_stock: false,
        seller_id: "F55CDC31AB754BB68FE0B39041159D63",
        seller_name: "Walmart.com",
        sponsored: false,
        url: `/ip/Diet-Coke-Soda-Pop/${id}`,
        fulfillment: {
          pickup: true,
          delivery: true,
          shipping: true,
          free_shipping: true,
        },
      },
    ], {
      store_id: "4366",
      zipcode: "79912",
      city: "El Paso",
      state: "TX",
    }));

    const result = await searchWalmart(uniqueQuery("live diet coke"), "4366", undefined, {
      zip: "79912",
      state: "TX",
    });

    expect(result.products[0]).toMatchObject({
      id,
      productId: id,
      itemId: id,
      title: "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans",
      price: 8.48,
      inStock: true,
      seller: "Walmart.com",
      link: `https://www.walmart.com/ip/Diet-Coke-Soda-Pop/${id}`,
      linkType: "product",
    });
    expect(result.products[0]?.priceProvenance).toMatchObject({
      searchStoreMatched: true,
      localPriceEligible: true,
      sellerType: "walmart",
      searchLocation: {
        storeId: "4366",
        postalCode: "79912",
        city: "El Paso",
        provinceCode: "TX",
      },
      fulfillment: ["in_store", "pickup", "delivery", "shipping"],
    });
  });

  it("allows an exact echoed-store price to proceed before fulfillment verification", () => {
    const product = parseScrapingBeeSearchProduct({
      id: nextId(),
      title: "Great Value Large White Eggs, 12 Count",
      price: 1.67,
      out_of_stock: false,
      seller_name: "Walmart.com",
      url: "/ip/Great-Value-Large-White-Eggs/123456789",
      fulfillment: { shipping: true },
    }, {
      storeId: "4366",
      zip: "79912",
      responseLocation: { storeId: "4366", postalCode: "79912" },
    });

    expect(product?.priceProvenance).toMatchObject({
      searchStoreMatched: true,
      localPriceEligible: true,
      fulfillment: ["shipping"],
    });
    expect(rankProducts("eggs", [product!]).recommended?.id).toBe(product?.id);
  });

  it("preserves a returned store mismatch so the matcher can reject it", async () => {
    process.env.SCRAPINGBEE_API_KEY = "private-test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(searchResponse(
      [searchProduct()],
      { zip_code: "79912", store_id: "9999" },
    ));

    const result = await searchWalmart(uniqueQuery("mismatched eggs"), "4366", undefined, {
      zip: "79912",
      state: "TX",
    });

    expect(result.products[0]?.priceProvenance).toMatchObject({
      requestedStoreId: "4366",
      searchStoreId: "9999",
      searchStoreMatched: false,
      localPriceEligible: false,
    });
  });

  it("preserves third-party seller provenance without treating it as a local basket offer", () => {
    const product = parseScrapingBeeSearchProduct(searchProduct({
      seller: "Third Party Deals",
    }), {
      storeId: "4366",
      zip: "79912",
      responseLocation: { storeId: "4366", postalCode: "79912" },
    });

    expect(product?.seller).toBe("Third Party Deals");
    expect(product?.priceProvenance).toMatchObject({
      sellerType: "marketplace",
      priceSource: "marketplace_search",
      localPriceEligible: false,
    });
  });

  it("rejects financing price displays", () => {
    expect(parseScrapingBeeSearchProduct(searchProduct({
      price_display: "$8.48/month",
    }), { storeId: "4366" })).toBeNull();

    expect(parseScrapingBeeProductDetail(productDetail({
      price: { current: 8.48, current_display: "$8.48 per month" },
    }), { storeId: "4366" })).toBeNull();
  });

  it("localizes product verification and parses nested detail fields defensively", async () => {
    process.env.SCRAPINGBEE_API_KEY = "private-test-key";
    const productId = nextId();
    const exactUrl = `https://www.walmart.com/ip/Diet-Coke-Soda-Pop/${productId}`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      ...productDetail({ product_id: productId, url: exactUrl }),
      location: { zip_code: "79912", store_id: "4366" },
    }));

    const result = await getWalmartProductDetails(productId, "4366", undefined, {
      zip: "79912",
      state: "TX",
      domain: "us",
    });

    expect(result.product).toMatchObject({
      productId,
      itemId: productId,
      upc: "049000028911",
      brand: "Diet Coke",
      productType: "Soda Pop",
      link: exactUrl,
      linkType: "product",
      dataSource: "scrapingbee",
      inStock: true,
    });
    expect(result.product?.priceProvenance).toMatchObject({
      priceSource: "product_detail",
      priceScope: "exact_store",
      productDetailPriceCents: 848,
      regularPriceCents: 998,
      requestedStoreId: "4366",
      detailStoreId: "4366",
      detailStoreMatched: true,
      detailLocation: {
        storeId: "4366",
        postalCode: "79912",
        provinceCode: "TX",
      },
      fulfillment: ["in_store", "pickup", "shipping"],
      sellerType: "walmart",
    });

    const [request, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.pathname).toBe("/api/v1/walmart/product");
    expect(url.searchParams.get("product_id")).toBe(productId);
    expect(url.searchParams.has("store_id")).toBe(false);
    expect(url.searchParams.has("delivery_zip")).toBe(false);
    expect(url.searchParams.get("device")).toBe("desktop");
    expect(url.searchParams.has("api_key")).toBe(false);
    expect(new Headers(init?.headers).get("Authorization"))
      .toBe("Bearer private-test-key");
  });

  it("parses the live unlocalized Product shape and strikethrough price", () => {
    const id = nextId();
    const detail = parseScrapingBeeProductDetail({
      id,
      title: "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans",
      price: 8.48,
      price_strikethrough: 9.98,
      out_of_stock: false,
      seller_id: "F55CDC31AB754BB68FE0B39041159D63",
      seller_name: "Walmart.com",
      url: `/ip/Diet-Coke-Soda-Pop/${id}`,
      fulfillment: {
        pickup: true,
        delivery: true,
        shipping: true,
        free_shipping: true,
      },
    }, { storeId: "4366", zip: "79912", state: "TX" });

    expect(detail).toMatchObject({
      id,
      productId: id,
      itemId: id,
      price: 8.48,
      inStock: true,
      seller: "Walmart.com",
      link: `https://www.walmart.com/ip/Diet-Coke-Soda-Pop/${id}`,
      linkType: "product",
    });
    expect(detail?.priceProvenance).toMatchObject({
      productDetailPriceCents: 848,
      regularPriceCents: 998,
      salePriceCents: 848,
      requestedStoreId: "4366",
      detailStoreMatched: undefined,
      fulfillment: ["in_store", "pickup", "delivery", "shipping"],
    });
  });

  it("keeps unlocalized product details separate from the exact-store Search price", () => {
    const detail = parseScrapingBeeProductDetail(productDetail(), {
      storeId: "4366",
      zip: "79912",
      state: "TX",
    });

    expect(detail?.priceProvenance).toMatchObject({
      requestedStoreId: "4366",
    });
    expect(detail?.priceProvenance?.priceScope).toBeUndefined();
    expect(detail?.priceProvenance?.detailLocation).toBeUndefined();
    expect(detail?.priceProvenance?.detailStoreId).toBeUndefined();
    expect(detail?.priceProvenance?.detailStoreMatched).toBeUndefined();
  });

  it("verifies an echoed store Search price using separately localized product details", () => {
    const raw = searchProduct();
    const candidate = parseScrapingBeeSearchProduct(raw, {
      storeId: "4366",
      zip: "79912",
      state: "TX",
      responseLocation: { storeId: "4366", postalCode: "79912" },
    });
    const detail = parseScrapingBeeProductDetail(productDetail({
      product_id: candidate?.productId,
      url: undefined,
      price: { current: 33.33, original: 39.99, currency: "USD" },
    }), {
      storeId: "4366",
      zip: "79912",
      state: "TX",
    });
    expect(candidate).not.toBeNull();
    expect(detail).not.toBeNull();

    const result = verifySelectedProduct(
      "Diet Coke 12 pack",
      rankProducts("Diet Coke 12 pack", [candidate!]),
      detail,
    );

    expect(result.status).toBe("matched");
    expect(result.recommended?.price).toBe(8.48);
    expect(result.recommended?.priceProvenance?.productDetailPriceCents).toBe(3333);
    expect(result.recommended?.link).toBe(candidate?.link);
    expect(result.recommended?.linkType).toBe("product");
    expect(result.recommended?.priceProvenance).toMatchObject({
      searchStoreMatched: true,
      detailStoreMatched: undefined,
      localPriceVerified: true,
      verifiedFulfillmentMode: "pickup",
    });
  });

  it("caches successful localized searches", async () => {
    process.env.SCRAPINGBEE_API_KEY = "private-test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      searchResponse([searchProduct()]),
    );
    const query = uniqueQuery("cached coke");

    const first = await searchWalmart(query, "4366", undefined, { zip: "79912" });
    const second = await searchWalmart(query, "4366", undefined, { zip: "79912" });

    expect(first.diagnostics).toMatchObject({ cacheHit: false, apiCall: true });
    expect(second.diagnostics).toEqual({
      cacheHit: true,
      deduplicated: false,
      apiCall: false,
      serpApiCacheUsed: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates in-flight searches while callers can abort independently", async () => {
    process.env.SCRAPINGBEE_API_KEY = "private-test-key";
    let resolveResponse!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pending);
    const query = uniqueQuery("shared ham");
    const controller = new AbortController();

    const aborted = searchWalmart(query, "4366", controller.signal, { zip: "79912" });
    const surviving = searchWalmart(query, "4366", undefined, { zip: "79912" });
    controller.abort();

    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveResponse(searchResponse([searchProduct()]));
    const result = await surviving;

    expect(result.products).toHaveLength(1);
    expect(result.diagnostics).toEqual({
      cacheHit: true,
      deduplicated: true,
      apiCall: false,
      serpApiCacheUsed: null,
    });
  });

  it.each([
    [401, "authentication"],
    [429, "rate_limit"],
    [500, "api_error"],
  ] as const)("classifies HTTP %s safely as %s", async (status, code) => {
    process.env.SCRAPINGBEE_API_KEY = "private-test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ message: "provider internals must not be reflected" }),
      { status, headers: { "Content-Type": "application/json" } },
    ));

    const error = await searchWalmart(uniqueQuery(`error ${status}`), "4366")
      .catch((reason) => reason);
    expect(error).toBeInstanceOf(WalmartSearchError);
    expect((error as WalmartSearchError).code).toBe(code);
    expect((error as Error).message).not.toMatch(/provider internals/i);
  });

  it("rejects a success payload outside the documented top-level envelope", async () => {
    process.env.SCRAPINGBEE_API_KEY = "private-test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      data: { products: [searchProduct()] },
    }));

    const error = await searchWalmart(uniqueQuery("malformed envelope"), "4366")
      .catch((reason) => reason);
    expect(error).toBeInstanceOf(WalmartSearchError);
    expect((error as WalmartSearchError).code).toBe("malformed");
  });
});
