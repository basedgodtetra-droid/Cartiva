import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLoopbackBackend, CartivaBackendClient, CartivaComparisonClient } from "../src/backend-client";
import type { ParsedListItem } from "../src/types";

const request: ParsedListItem = {
  id: "takis",
  text: "Takis",
  normalizedText: "takis",
  quantity: 1,
  brand: "Takis",
};

function responseFor(event: unknown) {
  return new Response(`${JSON.stringify(event)}\n`, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function responseForEvents(events: Array<unknown | string>) {
  return new Response(`${events.map((event) => (
    typeof event === "string" ? event : JSON.stringify(event)
  )).join("\n")}\n`, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function verifiedPickupProduct(id: string, title: string, brand = "Great Value") {
  const checkedAt = new Date().toISOString();
  return {
    id,
    itemId: id,
    title,
    brand,
    price: 3.48,
    priceCents: 348,
    link: `https://www.walmart.com/ip/product/${id}`,
    linkType: "product",
    inStock: true,
    verification: "verified",
    checkedAt,
    priceProvenance: {
      sellerType: "walmart",
      localPriceEligible: true,
      localPriceVerified: true,
      verifiedFulfillmentMode: "pickup",
      fulfillment: ["pickup"],
      requestedStoreId: "3014",
      searchStoreId: "3014",
      detailStoreId: "3014",
    },
  };
}

function options() {
  return {
    backendBaseUrl: "http://localhost:3000",
    storeId: "3014",
    zip: "75216",
    fulfillmentMode: "pickup" as const,
    onResult: vi.fn(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("extension backend cache", () => {
  it("routes Target lists to the isolated Target stream without making them cart-ready", async () => {
    const checkedAt = new Date().toISOString();
    const fetchMock = vi.fn(async () => responseFor({
      type: "item",
      retailer: "target",
      phase: "verification",
      mode: "live",
      checkedAt,
      result: {
        retailer: "target",
        status: "matched",
        alternatives: [],
        recommended: {
          retailer: "target",
          id: "92186007",
          productId: "92186007",
          title: "Good & Gather Grade A Large Eggs - 12ct",
          price: 2.99,
          priceCents: 299,
          priceLabel: "Localized price estimate",
          link: "https://www.target.com/p/eggs/-/A-92186007",
          linkType: "product",
          dataSource: "decodo",
          inStock: true,
          availabilityStatus: "in_stock",
          identityVerified: true,
          cartEligible: false,
          verification: "verified",
          checkedAt,
          priceProvenance: {
            retailer: "target",
            sellerType: "unknown",
            priceReliability: "localized_estimate",
            priceScope: "localized",
            fulfillment: ["delivery"],
          },
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const result = await new CartivaBackendClient().prepare([request], {
      backendBaseUrl: "http://localhost:3000",
      retailer: "target",
      zip: "79912",
      fulfillmentMode: "delivery",
      onResult: progress,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://localhost:3000/api/extension/target/search");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      retailer: "target",
      zipCode: "79912",
      fulfillmentMode: "delivery",
    });
    expect(result[0]).toMatchObject({
      retailer: "target",
      matchStatus: "matched",
      cartStatus: "skipped",
      product: { retailer: "target", cartEligible: false },
    });
  });

  it("does not cache transient API-error results", async () => {
    const fetchMock = vi.fn(async () => responseFor({
      type: "item",
      phase: "verification",
      mode: "live",
      checkedAt: new Date().toISOString(),
      result: { status: "review", recommended: null, alternatives: [], error: "Temporary API error" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CartivaBackendClient();
    await client.prepare([request], options());
    await client.prepare([request], options());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a recent fully verified local match", async () => {
    const checkedAt = new Date().toISOString();
    const fetchMock = vi.fn(async () => responseFor({
      type: "item",
      phase: "verification",
      mode: "live",
      checkedAt,
      result: {
        status: "matched",
        alternatives: [],
        recommended: {
          id: "123456789",
          itemId: "123456789",
          title: "Takis Fuego Rolled Tortilla Chips",
          brand: "Takis",
          price: 3.48,
          priceCents: 348,
          link: "https://www.walmart.com/ip/takis-fuego/123456789",
          linkType: "product",
          inStock: true,
          verification: "verified",
          checkedAt,
          priceProvenance: {
            sellerType: "walmart",
            localPriceEligible: true,
            localPriceVerified: true,
            verifiedFulfillmentMode: "pickup",
            fulfillment: ["pickup"],
            requestedStoreId: "3014",
            searchStoreId: "3014",
            detailStoreId: "3014",
          },
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CartivaBackendClient();
    await client.prepare([request], options());
    await client.prepare([request], options());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries a selected live suggestion into Prepare as structured identity", async () => {
    const fetchMock = vi.fn(async () => responseFor({
      type: "item",
      phase: "verification",
      mode: "live",
      result: { status: "no_match", recommended: null, alternatives: [] },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await new CartivaBackendClient().prepare([{
      ...request,
      preferredProductId: "7ENTUU7G5ASG",
      preferredItemId: "37846296",
      preferredTitle: "Takis Fuego 9.9 oz Sharing Size Bag, Rolled Tortilla Chips",
    }], options());

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.items[0]).toMatchObject({
      preferredProductId: "7ENTUU7G5ASG",
      preferredItemId: "37846296",
      preferredTitle: "Takis Fuego 9.9 oz Sharing Size Bag, Rolled Tortilla Chips",
    });
  });

  it("does not reuse a verified cache entry for a different selected product ID", async () => {
    const checkedAt = new Date().toISOString();
    const fetchMock = vi.fn(async () => responseFor({
      type: "item",
      phase: "verification",
      mode: "live",
      checkedAt,
      result: {
        status: "matched",
        alternatives: [],
        recommended: {
          id: "37846296",
          productId: "PRODUCT-A",
          itemId: "37846296",
          title: "Takis Fuego Rolled Tortilla Chips, 9.9 oz",
          brand: "Takis",
          price: 4.08,
          priceCents: 408,
          link: "https://www.walmart.com/ip/takis/37846296",
          linkType: "product",
          inStock: true,
          verification: "verified",
          checkedAt,
          priceProvenance: {
            sellerType: "walmart",
            localPriceEligible: true,
            localPriceVerified: true,
            verifiedFulfillmentMode: "pickup",
            fulfillment: ["pickup"],
            requestedStoreId: "3014",
            searchStoreId: "3014",
            detailStoreId: "3014",
          },
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CartivaBackendClient();

    await client.prepare([{ ...request, preferredProductId: "PRODUCT-A" }], options());
    await client.prepare([{ ...request, preferredProductId: "PRODUCT-B" }], options());

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps cached items out of a later batch without shifting streamed indexes", async () => {
    const eggs: ParsedListItem = {
      id: "eggs",
      text: "eggs",
      normalizedText: "eggs",
      quantity: 1,
    };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1
        ? responseFor({
            type: "item",
            index: 0,
            phase: "verification",
            mode: "live",
            result: {
              status: "matched",
              alternatives: [],
              recommended: verifiedPickupProduct("37846296", "Takis Fuego Rolled Tortilla Chips", "Takis"),
            },
          })
        : responseFor({
            type: "item",
            index: 0,
            phase: "search",
            mode: "live",
            result: { status: "no_match", recommended: null, alternatives: [] },
          });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new CartivaBackendClient();

    await client.prepare([request], options());
    const result = await client.prepare([request, eggs], options());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0].text).toBe("eggs");
    expect(result.map((item) => [item.id, item.matchStatus])).toEqual([
      ["takis", "matched"],
      ["eggs", "no_match"],
    ]);
  });
});

describe("extension batched preparation", () => {
  const eggs: ParsedListItem = {
    id: "eggs",
    text: "eggs",
    normalizedText: "eggs",
    quantity: 1,
  };
  const milk: ParsedListItem = {
    id: "milk",
    text: "milk",
    normalizedText: "milk",
    quantity: 1,
  };

  it("sends the whole uncached list once and routes progressive events by index", async () => {
    const fetchMock = vi.fn(async () => responseForEvents([
      {
        type: "item",
        index: 1,
        phase: "search",
        mode: "live",
        result: {
          status: "matched",
          recommended: verifiedPickupProduct("222222222", "Great Value Whole Milk, 1 Gallon"),
          alternatives: [],
        },
      },
      {
        type: "item",
        index: 0,
        phase: "search",
        mode: "live",
        result: { status: "no_match", recommended: null, alternatives: [] },
      },
      {
        type: "item",
        index: 1,
        phase: "verification",
        mode: "live",
        result: {
          status: "matched",
          recommended: verifiedPickupProduct("222222222", "Great Value Whole Milk, 1 Gallon"),
          alternatives: [],
        },
      },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();

    const result = await new CartivaBackendClient().prepare(
      [eggs, milk],
      { ...options(), onResult: progress },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.items.map((item: { text: string }) => item.text)).toEqual(["eggs", "milk"]);
    expect(result.map((item) => [item.id, item.matchStatus])).toEqual([
      ["eggs", "no_match"],
      ["milk", "matched"],
    ]);
    expect(progress.mock.calls.map(([event]) => [event.item.id, event.phase])).toEqual([
      ["eggs", "search"],
      ["milk", "search"],
      ["milk", "search"],
      ["eggs", "search"],
      ["milk", "verification"],
    ]);
  });

  it("isolates a malformed or missing item event instead of failing valid siblings", async () => {
    const fetchMock = vi.fn(async () => responseForEvents([
      "{malformed-json",
      {
        type: "item",
        index: 0,
        phase: "verification",
        mode: "live",
        result: {
          status: "matched",
          recommended: verifiedPickupProduct("111111111", "Great Value Large White Eggs, 12 Count"),
          alternatives: [],
        },
      },
      {
        type: "item",
        index: 1,
        phase: "search",
        mode: "live",
        result: { status: "no_match", recommended: null, alternatives: [] },
      },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new CartivaBackendClient().prepare([eggs, milk, request], options());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.map((item) => [item.id, item.matchStatus])).toEqual([
      ["eggs", "matched"],
      ["milk", "no_match"],
      ["takis", "api_error"],
    ]);
  });

  it("aborts a superseded batch without publishing stale error results", async () => {
    let firstSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (!firstSignal) {
        firstSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          firstSignal?.addEventListener("abort", () => reject(
            firstSignal?.reason ?? new DOMException("Aborted", "AbortError"),
          ));
        });
      }
      return Promise.resolve(responseFor({
        type: "item",
        index: 0,
        phase: "search",
        mode: "live",
        result: { status: "no_match", recommended: null, alternatives: [] },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new CartivaBackendClient();
    const staleProgress = vi.fn();
    const currentProgress = vi.fn();

    const stale = client.prepare([request], { ...options(), onResult: staleProgress });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const current = client.prepare([eggs], { ...options(), onResult: currentProgress });
    await Promise.all([stale, current]);

    expect(firstSignal?.aborted).toBe(true);
    expect(staleProgress.mock.calls.map(([event]) => event.phase)).toEqual(["search"]);
    expect(currentProgress.mock.calls.map(([event]) => event.item.matchStatus)).toEqual([
      "searching",
      "no_match",
    ]);
  });
});

describe("isolated multi-retailer preparation", () => {
  it("runs only configured retailer streams and lets each finish independently", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => responseFor({
      type: "item",
      index: 0,
      retailer: String(url).includes("/target/") ? "target" : "walmart",
      phase: "verification",
      mode: "live",
      checkedAt: new Date().toISOString(),
      result: { status: "no_match", recommended: null, alternatives: [] },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onResult = vi.fn();
    const onRetailerComplete = vi.fn();
    const onRetailerError = vi.fn();

    const result = await new CartivaComparisonClient().prepare([request], {
      backendBaseUrl: "http://localhost:3000",
      retailers: {
        walmart: { fulfillmentMode: "delivery", storeId: "3014", zip: "75216" },
        target: { fulfillmentMode: "delivery", zip: "75216" },
      },
      onResult,
      onRetailerComplete,
      onRetailerError,
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      "http://localhost:3000/api/extension/search",
      "http://localhost:3000/api/extension/target/search",
    ]);
    expect(Object.keys(result).sort()).toEqual(["target", "walmart"]);
    expect(new Set(onResult.mock.calls.map(([retailer]) => retailer))).toEqual(new Set(["walmart", "target"]));
    expect(new Set(onRetailerComplete.mock.calls.map(([retailer]) => retailer))).toEqual(new Set(["walmart", "target"]));
    expect(onRetailerError).not.toHaveBeenCalled();
    const requestBodies = Object.fromEntries(fetchMock.mock.calls.map(([url, init]) => [
      String(url),
      JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    ]));
    expect(requestBodies["http://localhost:3000/api/extension/target/search"]).toMatchObject({
      retailer: "target",
      zipCode: "75216",
      fulfillmentMode: "delivery",
    });
    expect(requestBodies["http://localhost:3000/api/extension/target/search"]).not.toHaveProperty("storeId");
  });
});

describe("extension backend boundary", () => {
  it("allows only a bare same-computer loopback origin", () => {
    expect(() => assertLoopbackBackend("http://localhost:3000")).not.toThrow();
    expect(() => assertLoopbackBackend("http://127.0.0.1:3000")).not.toThrow();
    expect(() => assertLoopbackBackend("http://[::1]:3000")).not.toThrow();
    expect(() => assertLoopbackBackend("http://192.168.1.129:3000")).toThrow(/loopback/i);
    expect(() => assertLoopbackBackend("http://10.0.0.8:3000")).toThrow(/loopback/i);
    expect(() => assertLoopbackBackend("http://172.16.4.2:3000")).toThrow(/loopback/i);
    expect(() => assertLoopbackBackend("http://127.0.0.2:3000")).toThrow(/loopback/i);
    expect(() => assertLoopbackBackend("https://localhost:3000")).toThrow(/loopback/i);
    expect(() => assertLoopbackBackend("http://localhost:3000/untrusted-path")).toThrow(/origin/i);
    expect(() => assertLoopbackBackend("http://user:secret@localhost:3000")).toThrow(/origin/i);
    expect(() => assertLoopbackBackend("http://localhost.example:3000")).toThrow(/loopback/i);
    expect(() => assertLoopbackBackend("http://8.8.8.8:3000")).toThrow(/loopback/i);
  });

  it("posts the normalized ZIP to the store directory and preserves exact returned addresses", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      zipCode: "75216",
      stores: [{
        storeId: "3014",
        postalCode: "75216",
        address: "200 Short Blvd, Dallas, TX 75216",
        country: "US",
      }],
      totalMatches: 1,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new CartivaBackendClient().findPickupStores(
      "75216-4820",
      "http://localhost:3000",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/extension/stores");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ zipCode: "75216" }),
    });
    expect(result).toEqual({
      zipCode: "75216",
      stores: [{
        id: "3014",
        name: "Walmart pickup store",
        address: "200 Short Blvd, Dallas, TX 75216",
        zip: "75216",
      }],
    });
  });

  it("returns an empty exact-ZIP directory result without inventing a nearby store", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      zipCode: "75216",
      stores: [],
      totalMatches: 0,
    }), { status: 200 })));

    await expect(new CartivaBackendClient().findPickupStores(
      "75216",
      "http://localhost:3000",
    )).resolves.toEqual({ zipCode: "75216", stores: [] });
  });

  it("turns a network failure into a useful main-computer message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    await expect(new CartivaBackendClient().findPickupStores(
      "75216",
      "http://127.0.0.1:8088",
    )).rejects.toThrow(/local backend.*this computer/i);
  });

  it("posts the normalized ZIP for Kroger locations so Chrome includes the extension origin", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      zipCode: "75216",
      locations: [{
        locationId: "03500213",
        name: "Kroger - Wynnewood Village",
        chain: "KROGER",
        address: {
          addressLine1: "752 Wynnewood Village Shp Ctr",
          city: "Dallas",
          state: "TX",
          zipCode: "75224",
        },
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new CartivaBackendClient().findKrogerStores(
      "75216-4820",
      "http://127.0.0.1:8088",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8088/api/extension/kroger/locations",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ zipCode: "75216" }),
      }),
    );
    expect(result).toMatchObject({
      zipCode: "75216",
      stores: [{ id: "03500213", name: "Kroger - Wynnewood Village", zip: "75224" }],
    });
  });

  it("posts Kroger OAuth status checks so Chrome includes the extension origin", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      connected: true,
      configured: true,
      profileId: "customer-profile",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new CartivaBackendClient().getKrogerOAuthStatus(
      "http://127.0.0.1:8088",
    )).resolves.toMatchObject({
      connected: true,
      configured: true,
      profileId: "customer-profile",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8088/api/extension/kroger/auth/status",
      expect.objectContaining({
        method: "POST",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("loads exact live Walmart titles and product identifiers for typeahead", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      query: "Takis",
      mode: "live",
      searchIdeas: [
        { text: "Takis Fuego", evidenceCount: 3 },
        { text: "  Takis   Fuego  ", evidenceCount: 2 },
        { text: "", evidenceCount: 1 },
      ],
      suggestions: [{
        title: "Takis Fuego 9.9 oz Sharing Size Bag, Hot Chili Pepper & Lime Rolled Tortilla Chips",
        productId: "7ENTUU7G5ASG",
        itemId: "37846296",
        brand: "Takis",
        brandSource: "api",
        flavor: "Fuego",
        format: "Bag",
        fulfillment: ["pickup", "in_store"],
        price: 4.08,
        packageSize: "9.9 oz",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new CartivaBackendClient().findProductSuggestions(
      " Takis ",
      "4366",
      "http://localhost:3000",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/extension/suggestions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "Takis", storeId: "4366" }),
      }),
    );
    expect(result).toEqual({
      query: "Takis",
      mode: "live",
      searchIdeas: [{ text: "Takis Fuego", evidenceCount: 3 }],
      suggestions: [{
        title: "Takis Fuego 9.9 oz Sharing Size Bag, Hot Chili Pepper & Lime Rolled Tortilla Chips",
        productId: "7ENTUU7G5ASG",
        itemId: "37846296",
        brand: "Takis",
        brandSource: "api",
        flavor: "Fuego",
        format: "Bag",
        fulfillment: ["pickup", "in_store"],
        price: 4.08,
        packageSize: "9.9 oz",
      }],
    });
  });

  it("waits for three typed characters before requesting Walmart suggestions", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new CartivaBackendClient().findProductSuggestions(
      "ch",
      "4366",
      "http://localhost:3000",
    )).rejects.toThrow(/three characters/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps up to six exact Walmart products for the product-only dropdown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      query: "Pepsi",
      mode: "live",
      suggestions: Array.from({ length: 8 }, (_, index) => ({
        title: `Pepsi product ${index + 1}`,
        productId: `PEPSI-${index + 1}`,
        price: index + 1,
      })),
    }), { status: 200 })));

    const result = await new CartivaBackendClient().findProductSuggestions(
      "Pepsi",
      "4366",
      "http://localhost:3000",
    );

    expect(result.suggestions).toHaveLength(6);
    expect(result.suggestions.map((item) => item.title)).toEqual(
      Array.from({ length: 6 }, (_, index) => `Pepsi product ${index + 1}`),
    );
  });

  it("reuses a recent exact-product lookup for the same store and query", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      query: "Diet Coke",
      mode: "live",
      suggestions: [{
        title: "Diet Coke Soda Pop Cans, 12 fl oz, 12 Pack",
        productId: "DIET-COKE-12",
        itemId: "123456789",
        brand: "Diet Coke",
        price: 7.48,
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CartivaBackendClient();

    const first = await client.findProductSuggestions(
      "Diet   Coke",
      "4366",
      "http://localhost:3000",
    );
    first.suggestions[0].title = "changed by caller";
    const second = await client.findProductSuggestions(
      "diet coke",
      "4366",
      "http://localhost:3000",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.suggestions[0].title).toBe("Diet Coke Soda Pop Cans, 12 fl oz, 12 Pack");
  });

  it("sends the selected ZIP and keeps ZIP-localized suggestion caches separate", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      query: "eggs",
      mode: "live",
      suggestions: [{
        title: "Great Value Large White Eggs, 12 Count",
        productId: "EGGS-12",
        itemId: "123456789",
        price: 1.67,
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CartivaBackendClient();

    await client.findProductSuggestions(
      "eggs",
      "4366",
      "http://localhost:3000",
      undefined,
      "79912",
    );
    await client.findProductSuggestions(
      "eggs",
      "4366",
      "http://localhost:3000",
      undefined,
      "79925",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ query: "eggs", storeId: "4366", zipCode: "79912" }),
    }));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ query: "eggs", storeId: "4366", zipCode: "79925" }),
    }));
  });

  it("drops malformed typeahead products instead of displaying invented data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      query: "Takis",
      mode: "live",
      suggestions: [
        { title: "", productId: "bad", price: 1 },
        { title: "Great Value Takis", productId: "<script>", price: "free" },
      ],
    }), { status: 200 })));

    await expect(new CartivaBackendClient().findProductSuggestions(
      "Takis",
      "4366",
      "http://localhost:3000",
    )).resolves.toMatchObject({ searchIdeas: [], suggestions: [] });
  });
});
