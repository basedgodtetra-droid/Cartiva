import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getParseBotTargetProduct,
  getParseBotTargetStoreStock,
  parseParseBotTargetProduct,
  parseParseBotTargetSearch,
  parseParseBotTargetStoreStock,
  searchParseBotTarget,
} from "@/lib/parsebot-target";

const originalKey = process.env.PARSEBOT_API_KEY;

function response(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function searchPayload(products: unknown[] = []) {
  return {
    status: "success",
    data: {
      keyword: "eggs",
      count: products.length,
      offset: 0,
      products,
    },
  };
}

function eggProduct() {
  return {
    tcin: "92186007",
    title: "Grade A Large Eggs - 12ct - Good &#38; Gather&#8482;",
    url: "https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-92186007",
    image_url: "https://target.scene7.com/is/image/Target/GUEST-egg",
    brand: "Good & Gather",
    current_retail: 3.49,
    price: "$3.49",
    regular_price: "$3.99",
    item_type: "Eggs",
  };
}

function stockPayload(tcin = "92186007", zip = "79912") {
  return {
    status: "success",
    data: {
      zipcode: zip,
      product: {
        tcin,
        title: "Grade A Large Eggs - 12ct - Good & Gather",
        url: `https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-${tcin}`,
        sold_out: false,
        stores: [{
          store_id: "0822",
          store_name: "El Paso West Target",
          address: "6001 N Mesa St, El Paso, TX 79912",
          phone: "+1 915-555-0100",
          in_store: "IN_STOCK",
          order_pickup: "IN_STOCK",
          pickup_date: "2026-08-12",
          distance_miles: 1.25,
          quantity_available: 7,
        }],
      },
    },
  };
}

describe("Parse.bot Target provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.PARSEBOT_API_KEY = "test-parsebot-secret";
    globalThis.parseBotTargetSearchCacheV1?.clear();
    globalThis.parseBotTargetDetailCacheV1?.clear();
    globalThis.parseBotTargetStockCacheV1?.clear();
    globalThis.parseBotTargetSearchInFlightV1?.clear();
    globalThis.parseBotTargetDetailInFlightV1?.clear();
    globalThis.parseBotTargetStockInFlightV1?.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.PARSEBOT_API_KEY;
    else process.env.PARSEBOT_API_KEY = originalKey;
  });

  it("parses exact search identity, URL, price, and localized provenance", () => {
    const products = parseParseBotTargetSearch(
      searchPayload([eggProduct()]),
      { zip: "79912", storeId: "0822" },
      "2026-08-11T20:00:00.000Z",
    );

    expect(products).toEqual([expect.objectContaining({
      tcin: "92186007",
      title: "Grade A Large Eggs - 12ct - Good & Gather™",
      url: "https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-92186007",
      price: 3.49,
      priceCents: 349,
      comparisonPriceCents: 399,
      brand: "Good & Gather",
      productType: "Eggs",
      provenance: {
        source: "parsebot_target_search",
        requestedStoreId: "822",
        requestedZip: "79912",
        locationVerified: false,
        sellerType: "unknown",
        checkedAt: "2026-08-11T20:00:00.000Z",
      },
    })]);
  });

  it("rejects search rows whose Target URL does not prove the returned TCIN", () => {
    const products = parseParseBotTargetSearch(searchPayload([{
      ...eggProduct(),
      url: "https://www.target.com/p/different-item/-/A-89199095",
    }]));

    expect(products).toEqual([]);
  });

  it("parses product details from the documented data envelope", () => {
    const product = parseParseBotTargetProduct({
      status: "success",
      data: {
        ...eggProduct(),
        images: ["https://target.scene7.com/is/image/Target/GUEST-detail"],
        online_availability: "IN_STOCK",
      },
    }, { zip: "79912" });

    expect(product).toMatchObject({
      tcin: "92186007",
      priceCents: 349,
      inStock: true,
      thumbnail: "https://target.scene7.com/is/image/Target/GUEST-egg",
      provenance: { source: "parsebot_target_product", requestedZip: "79912" },
    });
  });

  it("parses store stock, quantity, pickup date, address ZIP, and normalized store ID", () => {
    const stores = parseParseBotTargetStoreStock(
      stockPayload(),
      "92186007",
      "79912",
    );

    expect(stores).toEqual([expect.objectContaining({
      storeId: "822",
      storeName: "El Paso West Target",
      inStock: true,
      stockLevel: 7,
      availabilityStatus: "IN_STOCK",
      pickupDate: "2026-08-12",
      postalCode: "79912",
      distance: 1.25,
    })]);
  });

  it("sends the secret only in X-API-Key and uses documented search parameters", async () => {
    let requestedUrl: URL | undefined;
    let requestedHeaders: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
      requestedHeaders = new Headers(init?.headers);
      return response(searchPayload(), 200, { "x-credits-remaining": "197" });
    }));

    const result = await searchParseBotTarget(`unique eggs ${Date.now()}`, { zip: "79912" });

    expect(requestedUrl).toBeDefined();
    expect(`${requestedUrl!.origin}${requestedUrl!.pathname}`).toBe(
      "https://api.parse.bot/scraper/9935e57e-18c2-4c7c-aebe-bc311e983dc8/search_products",
    );
    expect(requestedUrl?.searchParams.get("keyword")).toContain("unique eggs");
    expect(requestedUrl?.searchParams.get("zip")).toBe("79912");
    expect(requestedUrl?.searchParams.get("count")).toBe("24");
    expect(requestedUrl?.searchParams.get("sort_by")).toBe("relevance");
    expect(requestedUrl?.search).not.toContain("test-parsebot-secret");
    expect(requestedHeaders?.get("X-API-Key")).toBe("test-parsebot-secret");
    expect(result.diagnostics).toMatchObject({ apiCall: true, creditsRemaining: 197 });
    expect(JSON.stringify(result)).not.toContain("test-parsebot-secret");
  });

  it("returns response-derived product identity with matching store availability", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(stockPayload())));

    const result = await getParseBotTargetStoreStock("92186007", "79912");

    expect(result).toMatchObject({
      productId: "92186007",
      productTitle: "Grade A Large Eggs - 12ct - Good & Gather",
      productUrl: "https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-92186007",
      zipCode: "79912",
      stores: [expect.objectContaining({ storeId: "822", inStock: true })],
    });
  });

  it("hard rejects the observed live TCIN mismatch instead of applying the wrong stock", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(stockPayload("89199095", "79912"))));

    await expect(
      getParseBotTargetStoreStock("92186007", "79912"),
    ).rejects.toMatchObject({
      code: "malformed",
      message: expect.stringContaining("mismatched"),
    });
  });

  it("hard rejects a response ZIP that does not match the requested pickup area", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(stockPayload("92186007", "10001"))));

    await expect(
      getParseBotTargetStoreStock("92186007", "79912"),
    ).rejects.toMatchObject({ code: "malformed" });
  });

  it("deduplicates identical in-flight searches", async () => {
    let release: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      release = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const query = `dedupe-eggs-${Date.now()}`;

    const first = searchParseBotTarget(query, { zip: "79912" });
    const second = searchParseBotTarget(query, { zip: "79912" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release?.(response(searchPayload([eggProduct()])));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.diagnostics.apiCall).toBe(true);
    expect(secondResult.diagnostics).toMatchObject({
      apiCall: false,
      deduplicated: true,
    });
  });

  it("lets one consumer abort without canceling the shared upstream request", async () => {
    let release: ((value: Response) => void) | undefined;
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const query = `consumer-abort-${Date.now()}`;

    const canceled = searchParseBotTarget(query, { zip: "79912" }, controller.signal);
    const remaining = searchParseBotTarget(query, { zip: "79912" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(false);
    release?.(response(searchPayload([eggProduct()])));
    await expect(remaining).resolves.toMatchObject({ products: [{ tcin: "92186007" }] });
  });

  it("uses the documented product endpoint and preserves exact identity", async () => {
    let requestedUrl: URL | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
      return response({ status: "success", data: eggProduct() });
    }));

    const result = await getParseBotTargetProduct("92186007", { zip: "79912" });

    expect(requestedUrl?.pathname.endsWith("/get_product")).toBe(true);
    expect(requestedUrl?.searchParams.get("tcin")).toBe("92186007");
    expect(requestedUrl?.searchParams.get("zip")).toBe("79912");
    expect(result.product?.tcin).toBe("92186007");
  });

  it("maps authentication and rate-limit errors without leaking provider details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "secret upstream detail" }, 429)));
    await expect(searchParseBotTarget(`rate-limit-${Date.now()}`)).rejects.toMatchObject({
      code: "rate_limit",
      retryable: true,
      status: 429,
      message: expect.not.stringContaining("secret upstream detail"),
    });
  });

  it("fails safely when the server key is missing", async () => {
    delete process.env.PARSEBOT_API_KEY;
    await expect(searchParseBotTarget(`missing-key-${Date.now()}`)).rejects.toMatchObject({
      code: "configuration",
      message: expect.not.stringContaining("X-API-Key"),
    });
  });
});
