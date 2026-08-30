import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DecodoWalmartError,
  getDecodoWalmartProduct,
  parseDecodoWalmartProduct,
  parseDecodoWalmartSearch,
  searchDecodoWalmart,
  toWalmartProduct,
} from "@/lib/decodo-walmart";

const testAuthToken = "test-only-decodo-walmart-auth";
const walmartSellerId = "F55CDC31AB754BB68FE0B39041159D63";
let sequence = 0;

function uniqueQuery(label: string) {
  sequence += 1;
  return `${label} decodo walmart test ${sequence}`;
}

function uniqueProductId() {
  sequence += 1;
  return String(896_000_000 + sequence);
}

function envelope(results: unknown, statusCode = 12000) {
  return {
    results: [{
      content: {
        results,
        errors: [],
        status_code: statusCode,
        task_id: "sanitized-walmart-test-task",
      },
      status_code: 200,
    }],
  };
}

function searchItem(overrides: Record<string, unknown> = {}) {
  return {
    price: {
      price: 8.48,
      currency: "USD",
      price_strikethrough: 9.98,
    },
    seller: { id: walmartSellerId, name: "Walmart.com" },
    general: {
      pos: 1,
      url: "/ip/Diet-Coke-Soda-Pop/609040889?classType=REGULAR",
      image: "https://i5.walmartimages.com/seo/diet-coke.jpeg",
      title: "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans",
      sponsored: false,
      product_id: "609040889",
      out_of_stock: false,
    },
    fulfillment: {
      pickup: true,
      delivery: true,
      shipping: true,
      free_shipping: true,
    },
    ...overrides,
  };
}

function searchEnvelope(items: unknown[], location: unknown = {
  city: "El Paso",
  state: "TX",
  zipcode: "79912",
  store_id: "4366",
}) {
  return envelope({
    url: "https://www.walmart.com/search?q=diet+coke",
    results: items,
    location,
    parse_status_code: 12000,
  });
}

function productEnvelope(overrides: Record<string, unknown> = {}) {
  return envelope({
    price: { price: 29.99, currency: "USD" },
    seller: {
      id: "22063D98FBBD4EAE9E93364F0597F233",
      name: "Keenstone",
      official_name: "Keenstone Corp.",
    },
    general: {
      url: "https://www.walmart.com/ip/Cat-Carrier/896171304",
      meta: { sku: "896171304", gtin: "684079207050" },
      brand: "Morpilot",
      title: "Cat Carrier MORPILOT® Extra Large Cat Bag",
      images: ["https://i5.walmartimages.com/seo/cat-carrier.jpeg"],
    },
    location: {
      city: "Sacramento",
      state: "CA",
      store_id: "3081",
      zip_code: "95829",
    },
    parse_status_code: 12000,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Decodo Walmart provider", () => {
  it("preserves exact search fields and records verified response location evidence", () => {
    const exactTitle = "Diet Coke Soda Pop — exact title  ";
    const exactUrl = "/ip/Diet-Coke-Soda-Pop/609040889?classType=REGULAR&athbdg=L1100";
    const products = parseDecodoWalmartSearch(searchEnvelope([
      searchItem({
        general: {
          pos: 1,
          url: exactUrl,
          image: "https://i5.walmartimages.com/seo/diet-coke.jpeg",
          title: exactTitle,
          sponsored: true,
          product_id: "609040889",
          out_of_stock: false,
        },
      }),
      { general: { product_id: "123456789" } },
    ]), {
      deliveryType: "pickup",
      storeId: "4366",
      deliveryZip: "79912",
      checkedAt: "2026-08-10T12:00:00.000Z",
    });

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      id: "609040889",
      productId: "609040889",
      title: exactTitle,
      url: exactUrl,
      price: 8.48,
      priceCents: 848,
      regularPrice: 9.98,
      regularPriceCents: 998,
      seller: "Walmart.com",
      sellerId: walmartSellerId,
      sellerType: "walmart",
      inStock: true,
      sponsored: true,
      fulfillment: ["pickup", "delivery", "shipping"],
      priceProvenance: {
        source: "decodo_walmart_search",
        priceSource: "local_store_sale",
        priceScope: "exact_store",
        searchPriceCents: 848,
        regularPriceCents: 998,
        salePriceCents: 848,
        localPriceEligible: true,
        localPriceVerified: true,
        location: {
          requestedStoreId: "4366",
          requestedZip: "79912",
          observedStoreId: "4366",
          observedZip: "79912",
          observedCity: "El Paso",
          observedState: "TX",
          storeMatched: true,
          zipMatched: true,
          locationVerified: true,
        },
      },
    });
  });

  it("does not treat requested location as observed when search omits location", () => {
    const [product] = parseDecodoWalmartSearch(searchEnvelope(
      [searchItem()],
      null,
    ), {
      deliveryType: "pickup",
      storeId: "4366",
      deliveryZip: "79912",
    });

    expect(product?.priceProvenance).toMatchObject({
      priceSource: "walmart_search",
      priceScope: "localized",
      localPriceVerified: false,
      location: {
        requestedStoreId: "4366",
        requestedZip: "79912",
        locationVerified: false,
      },
    });
    expect(product?.priceProvenance.location.observedStoreId).toBeUndefined();
  });

  it("defers missing search pickup flags to exact-store product verification", () => {
    const [product] = parseDecodoWalmartSearch(searchEnvelope([
      searchItem({
        fulfillment: {
          pickup: false,
          delivery: false,
          shipping: false,
        },
      }),
    ]), {
      deliveryType: "pickup",
      storeId: "4366",
      deliveryZip: "79912",
      checkedAt: "2026-08-10T12:15:00.000Z",
    });

    expect(product).toMatchObject({
      inStock: true,
      fulfillment: [],
      priceProvenance: {
        priceSource: "local_store_sale",
        priceScope: "exact_store",
        localPriceEligible: true,
        localPriceVerified: false,
        location: {
          observedStoreId: "4366",
          observedZip: "79912",
          storeMatched: true,
          zipMatched: true,
        },
      },
    });

    expect(toWalmartProduct(product!)).toMatchObject({
      priceProvenance: {
        searchStoreMatched: true,
        localPriceEligible: true,
        localPriceVerified: false,
        verifiedFulfillmentMode: undefined,
      },
    });
  });

  it("rejects an observed pickup store mismatch even when the ZIP matches", () => {
    const [product] = parseDecodoWalmartSearch(searchEnvelope(
      [searchItem()],
      {
        city: "El Paso",
        state: "TX",
        zipcode: "79912",
        store_id: "1015",
      },
    ), {
      deliveryType: "pickup",
      storeId: "4366",
      deliveryZip: "79912",
    });

    expect(product?.priceProvenance).toMatchObject({
      priceSource: "walmart_search",
      priceScope: "localized",
      localPriceEligible: false,
      localPriceVerified: false,
      location: {
        requestedStoreId: "4366",
        requestedZip: "79912",
        observedStoreId: "1015",
        observedZip: "79912",
        storeMatched: false,
        zipMatched: true,
      },
    });
  });

  it("parses product identity, marketplace seller, and location without inventing stock", () => {
    const product = parseDecodoWalmartProduct(productEnvelope(), {
      requestedProductId: "896171304",
      deliveryType: "pickup",
      storeId: "3081",
      checkedAt: "2026-08-10T12:30:00.000Z",
    });

    expect(product).toMatchObject({
      id: "896171304",
      productId: "896171304",
      itemId: "896171304",
      upc: "684079207050",
      idSource: "response",
      requestedProductId: "896171304",
      title: "Cat Carrier MORPILOT® Extra Large Cat Bag",
      url: "https://www.walmart.com/ip/Cat-Carrier/896171304",
      price: 29.99,
      priceCents: 2999,
      brand: "Morpilot",
      seller: "Keenstone",
      sellerId: "22063D98FBBD4EAE9E93364F0597F233",
      sellerType: "marketplace",
      thumbnail: "https://i5.walmartimages.com/seo/cat-carrier.jpeg",
      fulfillment: [],
      priceProvenance: {
        source: "decodo_walmart_product",
        priceSource: "product_detail",
        priceScope: "localized",
        productDetailPriceCents: 2999,
        localPriceEligible: false,
        localPriceVerified: false,
        location: {
          requestedStoreId: "3081",
          observedStoreId: "3081",
          observedZip: "95829",
          storeMatched: true,
          locationVerified: true,
        },
      },
    });
    expect(product?.inStock).toBeUndefined();
    expect(toWalmartProduct(product!)).toBeNull();
  });

  it("adapts relative URLs while retaining the exact provider source URL", () => {
    const [dto] = parseDecodoWalmartSearch(searchEnvelope([searchItem()]), {
      deliveryType: "pickup",
      storeId: "4366",
      checkedAt: "2026-08-10T13:00:00.000Z",
    });
    const product = toWalmartProduct(dto!);

    expect(product).toMatchObject({
      retailer: "walmart",
      id: "609040889",
      productId: "609040889",
      itemId: "609040889",
      title: "Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans",
      price: 8.48,
      sourceUrl: "/ip/Diet-Coke-Soda-Pop/609040889?classType=REGULAR",
      link: "https://www.walmart.com/ip/Diet-Coke-Soda-Pop/609040889?classType=REGULAR",
      linkType: "product",
      productPageUnavailable: false,
      seller: "Walmart.com",
      inStock: true,
      sponsored: false,
      verification: "unverified",
      priceProvenance: {
        priceSource: "local_store_sale",
        priceScope: "exact_store",
        requestedStoreId: "4366",
        searchStoreId: "4366",
        searchStoreMatched: true,
        localPriceVerified: true,
        verifiedFulfillmentMode: "pickup",
      },
    });
    expect(product?.link).toBe(
      "https://www.walmart.com/ip/Diet-Coke-Soda-Pop/609040889?classType=REGULAR",
    );
    expect(product?.dataSource).toBe("decodo");
  });

  it("sends the official pickup search parameters and credential in the header only", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(searchEnvelope([searchItem()])),
    );

    const result = await searchDecodoWalmart(uniqueQuery("pickup body"), {
      deliveryType: "pickup",
      storeId: "4366",
      deliveryZip: "79912",
      headless: true,
    });

    expect(result.products).toHaveLength(1);
    const [request, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(request)).toBe("https://scraper-api.decodo.com/v2/scrape");
    expect(String(request)).not.toContain(testAuthToken);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${testAuthToken}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      target: "walmart_search",
      parse: true,
      headless: "html",
      delivery_zip: "79912",
    });
    expect(body).not.toHaveProperty("delivery_type");
    expect(body).not.toHaveProperty("fulfillment_type");
    expect(body).not.toHaveProperty("store_id");
    expect(JSON.stringify(body)).not.toContain(testAuthToken);
  });

  it.each(["delivery", "shipping"] as const)(
    "sends product %s localization with delivery_zip",
    async (deliveryType) => {
      vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
      const productId = uniqueProductId();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json(productEnvelope({
          general: {
            url: `https://www.walmart.com/ip/Test/${productId}`,
            meta: { sku: productId },
            title: "Test Walmart Product",
          },
        })),
      );

      await getDecodoWalmartProduct(productId, {
        deliveryType,
        deliveryZip: "79912",
      });

      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        target: "walmart_product",
        product_id: productId,
        parse: true,
        delivery_type: deliveryType,
        delivery_zip: "79912",
      });
      expect(body).not.toHaveProperty("store_id");
    },
  );

  it("sends pickup product verification by ZIP without exposing the requested store", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const productId = uniqueProductId();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(productEnvelope({
        general: {
          url: `https://www.walmart.com/ip/Test/${productId}`,
          meta: { sku: productId },
          title: "Test Walmart Product",
        },
      })),
    );

    await getDecodoWalmartProduct(productId, {
      deliveryType: "pickup",
      storeId: "4366",
      deliveryZip: "79912",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      target: "walmart_product",
      product_id: productId,
      parse: true,
      delivery_zip: "79912",
    });
    expect(body).not.toHaveProperty("store_id");
    expect(body).not.toHaveProperty("delivery_type");
  });

  it("validates credentials and localization before starting upstream work", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", "");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(searchDecodoWalmart(uniqueQuery("missing auth"))).rejects.toMatchObject({
      code: "configuration",
      retryable: false,
    });

    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    await expect(searchDecodoWalmart(uniqueQuery("bad store"), {
      deliveryType: "pickup",
      storeId: "12",
      deliveryZip: "79912",
    })).rejects.toMatchObject({ code: "configuration", retryable: false });
    await expect(searchDecodoWalmart(uniqueQuery("missing pickup zip"), {
      deliveryType: "pickup",
      storeId: "4366",
    })).rejects.toMatchObject({ code: "configuration", retryable: false });
    await expect(searchDecodoWalmart(uniqueQuery("bad zip"), {
      deliveryType: "shipping",
      deliveryZip: "799",
    })).rejects.toMatchObject({ code: "configuration", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses immutable 30-minute search and 45-minute detail caches", async () => {
    let now = Date.parse("2026-08-10T10:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const productId = uniqueProductId();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return body.target === "walmart_search"
        ? Response.json(searchEnvelope([searchItem()]))
        : Response.json(productEnvelope({
          general: {
            url: `https://www.walmart.com/ip/Test/${productId}`,
            meta: { sku: productId },
            title: "Cached Detail Product",
          },
        }));
    });
    const query = uniqueQuery("cache ttl");

    const firstSearch = await searchDecodoWalmart(query, {
      deliveryType: "pickup",
      storeId: "4366",
      deliveryZip: "79912",
    });
    firstSearch.products[0]!.title = "consumer mutation";
    await getDecodoWalmartProduct(productId);
    now += 30 * 60 * 1_000 - 1;
    const cachedSearch = await searchDecodoWalmart(query, {
      deliveryType: "pickup",
      storeId: "4366",
      deliveryZip: "79912",
    });
    const cachedDetail = await getDecodoWalmartProduct(productId);
    expect(cachedSearch.products[0]?.title).toBe("Diet Coke Soda Pop, 12 fl oz, 12 Pack Cans");
    expect(cachedSearch.diagnostics).toMatchObject({ cacheHit: true, apiCall: false });
    expect(cachedDetail.diagnostics).toMatchObject({ cacheHit: true, apiCall: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now += 1;
    await searchDecodoWalmart(query, {
      deliveryType: "pickup",
      storeId: "4366",
      deliveryZip: "79912",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    now += 15 * 60 * 1_000;
    await getDecodoWalmartProduct(productId);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("deduplicates search work while an initiating consumer aborts independently", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    let resolveResponse!: (response: Response) => void;
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_request, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    });
    const controller = new AbortController();
    const query = uniqueQuery("abort isolated");

    const cancelled = searchDecodoWalmart(
      query,
      { deliveryType: "pickup", storeId: "4366", deliveryZip: "79912" },
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(false);

    const survivor = searchDecodoWalmart(query, {
      deliveryType: "pickup",
      storeId: "4366",
      deliveryZip: "79912",
    });
    resolveResponse(Response.json(searchEnvelope([searchItem()])));
    const result = await survivor;
    expect(result.products).toHaveLength(1);
    expect(result.diagnostics).toMatchObject({ cacheHit: true, deduplicated: true, apiCall: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("negative-caches missing product details and keeps detail aborts isolated", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const missingId = uniqueProductId();
    const missingFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      Response.json(envelope(null, 12009))
    ));
    const first = await getDecodoWalmartProduct(missingId);
    const cached = await getDecodoWalmartProduct(missingId);
    expect(first.product).toBeNull();
    expect(cached.product).toBeNull();
    expect(cached.diagnostics.cacheHit).toBe(true);
    expect(missingFetch).toHaveBeenCalledTimes(1);

    missingFetch.mockRestore();
    let resolveResponse!: (response: Response) => void;
    let upstreamSignal: AbortSignal | undefined;
    const detailFetch = vi.spyOn(globalThis, "fetch").mockImplementation((_request, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    });
    const productId = uniqueProductId();
    const controller = new AbortController();
    const cancelled = getDecodoWalmartProduct(productId, {}, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(false);
    const survivor = getDecodoWalmartProduct(productId);
    resolveResponse(Response.json(productEnvelope({
      general: {
        url: `https://www.walmart.com/ip/Test/${productId}`,
        meta: { sku: productId },
        title: "Shared Detail Product",
      },
    })));
    const result = await survivor;
    expect(result.product?.productId).toBe(productId);
    expect(result.diagnostics.deduplicated).toBe(true);
    expect(detailFetch).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures but sanitizes non-retryable authentication errors", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(searchEnvelope([searchItem()])));

    const recovered = await searchDecodoWalmart(uniqueQuery("retry"));
    expect(recovered.products).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockResolvedValue(new Response(
      JSON.stringify({ message: testAuthToken }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    ));
    const error = await searchDecodoWalmart(uniqueQuery("auth error")).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DecodoWalmartError);
    expect(error).toMatchObject({ code: "authentication", retryable: false, status: 401 });
    expect(String((error as Error).message)).not.toContain(testAuthToken);
    expect(JSON.stringify(error)).not.toContain(testAuthToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out twice without cancelling through a consumer signal or exposing auth", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_request, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("provider timeout", "AbortError"));
        }, { once: true });
      })
    ));
    const request = searchDecodoWalmart(uniqueQuery("timeout")).catch(
      (reason: unknown) => reason,
    );

    await vi.advanceTimersByTimeAsync(45_000);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(45_000);
    const error = await request;
    expect(error).toBeInstanceOf(DecodoWalmartError);
    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expect(String((error as Error).message)).not.toContain(testAuthToken);
    expect(JSON.stringify(error)).not.toContain(testAuthToken);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
