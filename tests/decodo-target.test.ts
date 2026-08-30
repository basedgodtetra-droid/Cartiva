import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DecodoTargetError,
  getDecodoTargetProduct,
  parseDecodoTargetProduct,
  parseDecodoTargetSearch,
  searchDecodoTarget,
} from "@/lib/decodo-target";

const testAuthToken = "test-only-decodo-auth-value";
let sequence = 0;

function uniqueQuery(label: string) {
  sequence += 1;
  return `${label} decodo target test ${sequence}`;
}

function uniqueTcin() {
  sequence += 1;
  return String(92_000_000 + sequence);
}

function envelope(results: unknown, statusCode = 12000) {
  return {
    results: [{
      content: {
        results,
        errors: [],
        status_code: statusCode,
        task_id: "sanitized-test-task",
      },
    }],
  };
}

function searchEnvelope(items: unknown[]) {
  return envelope({
    url: "https://www.target.com/s?searchTerm=test",
    results: { organic: items },
    // Request echoes are deliberately not trusted as observed location proof.
    store_id: "1234",
    delivery_zip: "79912",
  });
}

function searchItem(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://www.target.com/p/example/-/A-92186007#lnk=sametab",
    title: "Example Target Product",
    brand_name: "Example Brand",
    price_data: {
      price: 4.99,
      comparison_price: 5.99,
      currency: "USD",
    },
    product_id: "92186007",
    in_stock: true,
    ...overrides,
  };
}

function detailEnvelope(overrides: Record<string, unknown> = {}) {
  return envelope({
    ean: "840216312395",
    url: "https://www.target.com/p/-/A-92186007",
    brand: { name: "Retrospec Bicycles" },
    price: { current: 49.99, discounted: false },
    title: "Retrospec Bicycles Cricket Mini 6\" Kids' Balance Bike",
    images: { main: "https://target.scene7.com/is/image/Target/example" },
    currency: "USD",
    in_stock: true,
    parse_status_code: 12000,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Decodo Target provider", () => {
  it("preserves exact search identity fields and parses price, brand, and stock", () => {
    const exactTitle = "Target Product  – exact punctuation  ";
    const exactUrl = "https://www.target.com/p/exact-product/-/A-1006276479#lnk=sametab";
    const exactTcin = "1006276479";
    const products = parseDecodoTargetSearch(searchEnvelope([
      searchItem({
        title: exactTitle,
        url: exactUrl,
        product_id: exactTcin,
        availability_status: "OUT_OF_STOCK",
        in_stock: undefined,
      }),
      { product_id: "1006955175", url: "/p/incomplete" },
    ]), {
      deliveryType: "pickup",
      storeId: "1234",
      deliveryZip: "79912",
      checkedAt: "2026-08-10T12:00:00.000Z",
    });

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      tcin: exactTcin,
      title: exactTitle,
      url: exactUrl,
      price: 4.99,
      priceCents: 499,
      comparisonPrice: 5.99,
      comparisonPriceCents: 599,
      currency: "USD",
      brand: "Example Brand",
      inStock: false,
      checkedAt: "2026-08-10T12:00:00.000Z",
      provenance: {
        source: "decodo_target_search",
        requestedStoreId: "1234",
        requestedZip: "79912",
        fulfillmentType: "pickup",
        locationVerified: false,
        tcinSource: "response",
      },
    });
    expect(products[0]?.provenance.observedStoreId).toBeUndefined();
    expect(products[0]?.provenance.observedZip).toBeUndefined();
  });

  it("parses the documented product shape without inventing a returned TCIN", () => {
    const product = parseDecodoTargetProduct(detailEnvelope(), {
      requestedTcin: "92186007",
      deliveryType: "delivery",
      deliveryZip: "79912",
      checkedAt: "2026-08-10T12:30:00.000Z",
    });

    expect(product).toMatchObject({
      tcin: "92186007",
      title: "Retrospec Bicycles Cricket Mini 6\" Kids' Balance Bike",
      url: "https://www.target.com/p/-/A-92186007",
      price: 49.99,
      priceCents: 4999,
      currency: "USD",
      brand: "Retrospec Bicycles",
      inStock: true,
      thumbnail: "https://target.scene7.com/is/image/Target/example",
      provenance: {
        source: "decodo_target_product",
        requestedTcin: "92186007",
        requestedZip: "79912",
        fulfillmentType: "delivery",
        locationVerified: false,
        tcinSource: "request",
      },
    });
    expect(product?.provenance.observedZip).toBeUndefined();
  });

  it("sends ZIP-only pickup comparison and optional rendering in the JSON body", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      Response.json(searchEnvelope([searchItem()]))
    ));

    const result = await searchDecodoTarget(uniqueQuery("exact query"), {
      deliveryType: "pickup",
      storeId: "1234",
      deliveryZip: "79912",
      headless: true,
    });

    expect(result.products).toHaveLength(1);
    expect(result.diagnostics).toMatchObject({
      cacheHit: false,
      deduplicated: false,
      apiCall: true,
      durationMs: expect.any(Number),
    });
    const [request, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(request)).toBe("https://scraper-api.decodo.com/v2/scrape");
    expect(String(request)).not.toContain(testAuthToken);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Basic ${testAuthToken}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      target: "target_search",
      parse: true,
      headless: "html",
      delivery_zip: "79912",
    });
    expect(body).not.toHaveProperty("delivery_type");
    expect(body).not.toHaveProperty("store_id");
    expect(JSON.stringify(body)).not.toContain(testAuthToken);
  });

  it.each(["delivery", "shipping"] as const)(
    "sends ZIP-only %s comparison localization for product detail",
    async (deliveryType) => {
      vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
      const tcin = uniqueTcin();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json(detailEnvelope({ url: `https://www.target.com/p/-/A-${tcin}` })),
      );

      const result = await getDecodoTargetProduct(tcin, {
        deliveryType,
        deliveryZip: "79912",
      });

      expect(result.product?.provenance).toMatchObject({
        requestedZip: "79912",
        fulfillmentType: deliveryType,
        locationVerified: false,
      });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        target: "target_product",
        product_id: tcin,
        parse: true,
        delivery_zip: "79912",
      });
      expect(body).not.toHaveProperty("store_id");
      expect(body).not.toHaveProperty("delivery_type");
      expect(body).not.toHaveProperty("headless");
    },
  );

  it("uses ZIP-only Target pickup detail comparison and keeps location unverified", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const tcin = uniqueTcin();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(detailEnvelope({ url: `https://www.target.com/p/-/A-${tcin}` })),
    );

    const result = await getDecodoTargetProduct(tcin, {
      deliveryType: "pickup",
      storeId: "1234",
      deliveryZip: "79912",
    });

    expect(result.product?.provenance).toMatchObject({
      requestedStoreId: "1234",
      requestedZip: "79912",
      fulfillmentType: "pickup",
      locationVerified: false,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      target: "target_product",
      product_id: tcin,
      parse: true,
      delivery_zip: "79912",
    });
    expect(body).not.toHaveProperty("store_id");
    expect(body).not.toHaveProperty("delivery_type");
  });

  it("fails closed for missing credentials and invalid localization", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", "");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(searchDecodoTarget(uniqueQuery("missing auth"))).rejects.toMatchObject({
      code: "configuration",
      retryable: false,
    });
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    await expect(searchDecodoTarget(uniqueQuery("bad pickup"), {
      deliveryType: "pickup",
      storeId: "12",
      deliveryZip: "79912",
    })).rejects.toMatchObject({ code: "configuration", retryable: false });
    await expect(searchDecodoTarget(uniqueQuery("missing pickup zip"), {
      deliveryType: "pickup",
      storeId: "1234",
    })).rejects.toMatchObject({ code: "configuration", retryable: false });
    await expect(searchDecodoTarget(uniqueQuery("bad zip"), {
      deliveryType: "shipping",
      deliveryZip: "799",
    })).rejects.toMatchObject({ code: "configuration", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches immutable search results and expires them after 30 minutes", async () => {
    let now = Date.parse("2026-08-10T10:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      Response.json(searchEnvelope([searchItem()]))
    ));
    const query = uniqueQuery("search cache");

    const first = await searchDecodoTarget(query, {
      deliveryType: "pickup",
      storeId: "1234",
      deliveryZip: "79912",
    });
    first.products[0]!.title = "consumer mutation";
    first.products[0]!.provenance.requestedStoreId = "9999";
    now += 30 * 60 * 1_000 - 1;
    const cached = await searchDecodoTarget(query, {
      deliveryType: "pickup",
      storeId: "1234",
      deliveryZip: "79912",
    });

    expect(cached.products[0]?.title).toBe("Example Target Product");
    expect(cached.products[0]?.provenance.requestedStoreId).toBe("1234");
    expect(cached.diagnostics).toMatchObject({ cacheHit: true, apiCall: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 1;
    const expired = await searchDecodoTarget(query, {
      deliveryType: "pickup",
      storeId: "1234",
      deliveryZip: "79912",
    });
    expect(expired.diagnostics).toMatchObject({ cacheHit: false, apiCall: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("negative-caches missing product details for 45 minutes", async () => {
    let now = Date.parse("2026-08-10T11:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      Response.json(envelope(null, 12009))
    ));
    const tcin = uniqueTcin();

    const first = await getDecodoTargetProduct(tcin);
    now += 45 * 60 * 1_000 - 1;
    const cached = await getDecodoTargetProduct(tcin);

    expect(first.product).toBeNull();
    expect(cached.product).toBeNull();
    expect(cached.diagnostics).toMatchObject({ cacheHit: true, apiCall: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 1;
    await getDecodoTargetProduct(tcin);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates shared work while each consumer can abort independently", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    let resolveResponse!: (response: Response) => void;
    let upstreamSignal: AbortSignal | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_request, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return pendingResponse;
    });
    const controller = new AbortController();
    const query = uniqueQuery("abort isolated");

    const cancelled = searchDecodoTarget(
      query,
      { deliveryType: "pickup", storeId: "1234", deliveryZip: "79912" },
      controller.signal,
    );
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const survivor = searchDecodoTarget(query, {
      deliveryType: "pickup",
      storeId: "1234",
      deliveryZip: "79912",
    });
    resolveResponse(Response.json(searchEnvelope([searchItem()])));

    const result = await survivor;
    expect(result.products).toHaveLength(1);
    expect(result.diagnostics).toMatchObject({
      cacheHit: true,
      deduplicated: true,
      apiCall: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared product-detail request alive when its initiating consumer aborts", async () => {
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
    const tcin = uniqueTcin();

    const cancelled = getDecodoTargetProduct(
      tcin,
      { deliveryType: "pickup", storeId: "1234", deliveryZip: "79912" },
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(false);

    const survivor = getDecodoTargetProduct(tcin, {
      deliveryType: "pickup",
      storeId: "1234",
      deliveryZip: "79912",
    });
    resolveResponse(Response.json(detailEnvelope({
      url: `https://www.target.com/p/-/A-${tcin}`,
    })));
    const result = await survivor;

    expect(result.product?.tcin).toBe(tcin);
    expect(result.diagnostics).toMatchObject({
      cacheHit: true,
      deduplicated: true,
      apiCall: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure once and does not retry authentication failures", async () => {
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const transientFetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(searchEnvelope([searchItem()])));

    const recovered = await searchDecodoTarget(uniqueQuery("retry success"));
    expect(recovered.products).toHaveLength(1);
    expect(transientFetch).toHaveBeenCalledTimes(2);

    transientFetch.mockReset().mockResolvedValue(new Response(
      JSON.stringify({ message: testAuthToken }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    ));
    const error = await searchDecodoTarget(uniqueQuery("auth failure")).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DecodoTargetError);
    expect(error).toMatchObject({ code: "authentication", retryable: false, status: 401 });
    expect(String((error as Error).message)).not.toContain(testAuthToken);
    expect(JSON.stringify(error)).not.toContain(testAuthToken);
    expect(transientFetch).toHaveBeenCalledTimes(1);
  });

  it("times out and retries shared upstream work without exposing the credential", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_request, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("provider timeout", "AbortError"));
        }, { once: true });
      })
    ));

    const request = searchDecodoTarget(uniqueQuery("timeout")).catch(
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(45_000);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(45_000);
    const error = await request;

    expect(error).toBeInstanceOf(DecodoTargetError);
    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expect(String((error as Error).message)).not.toContain(testAuthToken);
    expect(JSON.stringify(error)).not.toContain(testAuthToken);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps optional product-detail verification at one 20-second attempt", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DECODO_AUTH_TOKEN", testAuthToken);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_request, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("provider timeout", "AbortError"));
        }, { once: true });
      })
    ));

    const request = getDecodoTargetProduct(uniqueTcin()).catch(
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await request;

    expect(error).toBeInstanceOf(DecodoTargetError);
    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
