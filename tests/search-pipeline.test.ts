import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConcurrencyLimiter,
  POST as searchPost,
} from "@/app/api/search/route";
import {
  getWalmartProductDetails,
  searchWalmart,
} from "@/lib/serpapi";
import type { MatchResult, SearchStreamEvent, WalmartProduct } from "@/lib/types";
import { verifySelectedProduct } from "@/lib/verification";

vi.mock("@/lib/serpapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/serpapi")>();
  return {
    ...actual,
    getWalmartProductDetails: vi.fn(),
    searchWalmart: vi.fn(),
  };
});

vi.mock("@/lib/matching", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/matching")>();
  return {
    ...actual,
    rankProducts: vi.fn((request: string, products: WalmartProduct[]): MatchResult => {
      const recommended = products[0]
        ? {
            ...products[0],
            score: 80,
            confidence: "medium" as const,
            comparablePrice: products[0].price,
            matchedTerms: [],
            reasons: [],
          }
        : null;
      return {
        requestedItem: request,
        recommended,
        alternatives: products.slice(1, 4).map((product) => ({
          ...product,
          score: 75,
          confidence: "medium" as const,
          comparablePrice: product.price,
          matchedTerms: [],
          reasons: [],
        })),
        confidence: recommended ? "medium" : "low",
        status: recommended ? "review" : "no_match",
        explanation: recommended ? "Candidate found." : "No candidate found.",
      };
    }),
  };
});

vi.mock("@/lib/verification", () => ({
  verifySelectedProduct: vi.fn((
    request: string,
    preliminary: MatchResult,
  ): MatchResult => ({
    ...preliminary,
    requestedItem: request,
    confidence: "high",
    status: "matched",
    explanation: "Verified.",
  })),
}));

const searchMock = vi.mocked(searchWalmart);
const detailMock = vi.mocked(getWalmartProductDetails);
const verifyMock = vi.mocked(verifySelectedProduct);
const originalSerpApiKey = process.env.SERPAPI_API_KEY;
const originalScrapingBeeApiKey = process.env.SCRAPINGBEE_API_KEY;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for asynchronous work.");
}

function product(id: string): WalmartProduct {
  return {
    id,
    productId: `product-${id}`,
    itemId: `${id.length}001`,
    title: `${id} Walmart product`,
    brand: "Walmart",
    productType: "grocery",
    price: 2.48,
    priceCents: 248,
    link: `https://www.walmart.com/ip/${id}/${id.length}001`,
    linkType: "product",
    dataSource: "serpapi",
    seller: "Walmart",
    inStock: true,
    sponsored: false,
    verification: "unverified",
  };
}

function searchResult(value: WalmartProduct) {
  return {
    products: [value],
    mode: "live" as const,
    diagnostics: {
      cacheHit: false,
      deduplicated: false,
      apiCall: true,
      serpApiCacheUsed: null,
    },
  };
}

function detailResult(value: WalmartProduct) {
  return {
    product: value,
    mode: "live" as const,
    diagnostics: {
      cacheHit: false,
      deduplicated: false,
      apiCall: true,
      serpApiCacheUsed: null,
    },
  };
}

afterEach(() => {
  if (originalSerpApiKey === undefined) delete process.env.SERPAPI_API_KEY;
  else process.env.SERPAPI_API_KEY = originalSerpApiKey;
  if (originalScrapingBeeApiKey === undefined) delete process.env.SCRAPINGBEE_API_KEY;
  else process.env.SCRAPINGBEE_API_KEY = originalScrapingBeeApiKey;
  searchMock.mockReset();
  detailMock.mockReset();
  verifyMock.mockClear();
});

describe("search and verification pipeline", () => {
  it("starts verification for a completed item while slower searches continue", async () => {
    const fast = product("fast");
    const slow = product("slow");
    const slowSearch = deferred<ReturnType<typeof searchResult>>();
    let slowSearchFinished = false;

    searchMock.mockImplementation((query) => {
      if (query === "slow item") {
        return slowSearch.promise.then((value) => {
          slowSearchFinished = true;
          return value;
        });
      }
      if (query === "broken item") return Promise.reject(new Error("Search failed"));
      return Promise.resolve(searchResult(fast));
    });
    detailMock.mockImplementation((identifier) => Promise.resolve(
      detailResult(identifier === slow.itemId ? slow : fast),
    ));

    const response = await searchPost(new Request("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: ["fast item", "slow item", "broken item"],
        storeId: "2201",
      }),
    }));
    const bodyPromise = response.text();

    await waitFor(() => detailMock.mock.calls.length > 0);
    expect(slowSearchFinished).toBe(false);
    expect(detailMock).toHaveBeenCalledWith(fast.itemId, "2201", expect.any(AbortSignal));

    slowSearch.resolve(searchResult(slow));
    const events = (await bodyPromise)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SearchStreamEvent);

    const phasesFor = (index: number) => events
      .filter((event) => event.type === "item" && event.index === index)
      .map((event) => event.type === "item" ? event.phase : undefined);
    expect(phasesFor(0)).toEqual(["search", "verification"]);
    expect(phasesFor(1)).toEqual(["search", "verification"]);
    expect(phasesFor(2)).toEqual(["search"]);
    expect(events.at(-1)).toMatchObject({
      type: "performance",
      performance: {
        searchApiCalls: 3,
        productApiCalls: 2,
      },
    });
  });

  it("uses the selected store while keeping ZIP and state as request validation context", async () => {
    const value = product("localized");
    searchMock.mockResolvedValue(searchResult(value));
    detailMock.mockResolvedValue(detailResult(value));

    const response = await searchPost(new Request("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: ["localized item"],
        storeId: "2201",
        zipCode: "79912",
        state: "TX",
      }),
    }));
    await response.text();

    expect(searchMock).toHaveBeenCalledWith(
      "localized item",
      "2201",
      expect.any(AbortSignal),
    );
    expect(detailMock).toHaveBeenCalledWith(
      value.itemId,
      "2201",
      expect.any(AbortSignal),
    );
  });

  it("reports live mode from the SerpApi server configuration", async () => {
    process.env.SERPAPI_API_KEY = "private-test-key";
    const value = product("live-mode");
    searchMock.mockResolvedValue(searchResult(value));
    detailMock.mockResolvedValue(detailResult(value));

    const response = await searchPost(new Request("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: ["eggs"], storeId: "2201" }),
    }));
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SearchStreamEvent);

    expect(events.at(-1)).toMatchObject({ type: "performance", mode: "live" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "item",
      mode: "live",
      result: expect.objectContaining({
        recommended: expect.objectContaining({ dataSource: "serpapi" }),
      }),
    }));
  });

  it("does not report live mode from the retired ScrapingBee configuration", async () => {
    delete process.env.SERPAPI_API_KEY;
    process.env.SCRAPINGBEE_API_KEY = "retired-private-test-key";
    searchMock.mockRejectedValue(new Error("Search failed"));

    const response = await searchPost(new Request("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: ["eggs"], storeId: "2201" }),
    }));
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SearchStreamEvent);

    expect(events).toHaveLength(2);
    expect(events.every((event) => event.mode === "demo")).toBe(true);
    expect(events[0]).toMatchObject({
      type: "item",
      mode: "demo",
      result: { status: "review" },
    });
    expect(events.at(-1)).toMatchObject({ type: "performance", mode: "demo" });
  });

  it("broadens package-light discovery while keeping the 12-count verification exact", async () => {
    const eggs = product("eggs-12");
    eggs.title = "Grade A Large Eggs, 12 Count";
    eggs.productType = "eggs";
    eggs.size = {
      amount: 12,
      unit: "count",
      kind: "count",
      baseAmount: 12,
      baseUnit: "each",
      label: "12 count",
    };
    searchMock
      .mockResolvedValueOnce({
        products: [],
        mode: "live",
        diagnostics: {
          cacheHit: false,
          deduplicated: false,
          apiCall: true,
          serpApiCacheUsed: null,
        },
      })
      .mockResolvedValue(searchResult(eggs));
    detailMock.mockResolvedValue(detailResult(eggs));

    const response = await searchPost(new Request("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: ["Grade A Large Eggs, 12 count"],
        storeId: "2201",
      }),
    }));
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SearchStreamEvent);

    expect(searchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(searchMock.mock.calls[0]?.[0]).not.toMatch(/12|count/i);
    expect(events).toContainEqual(expect.objectContaining({
      type: "item",
      phase: "verification",
      result: expect.objectContaining({ status: "matched" }),
    }));
    expect(events.at(-1)).toMatchObject({
      type: "performance",
      performance: { searchApiCalls: 2 },
    });
  });

  it("does not turn a broader 18-count Walmart result into a 12-count match", async () => {
    const eggs = product("eggs-18");
    eggs.title = "Grade A Large Eggs, 18 Count";
    eggs.productType = "eggs";
    eggs.size = {
      amount: 18,
      unit: "count",
      kind: "count",
      baseAmount: 18,
      baseUnit: "each",
      label: "18 count",
    };
    searchMock.mockResolvedValue(searchResult(eggs));

    const response = await searchPost(new Request("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: ["Grade A Large Eggs, 12 count"],
        storeId: "2201",
      }),
    }));
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SearchStreamEvent);
    const itemEvents = events.filter((event) => event.type === "item");

    expect(itemEvents).toHaveLength(1);
    expect(itemEvents[0]).toMatchObject({
      phase: "search",
      result: { status: "no_match", recommended: null },
    });
    expect(detailMock).not.toHaveBeenCalled();
  });

  it("tries the next compatible Walmart candidate when the first one fails verification", async () => {
    const first = product("first-eggs");
    const second = product("second-eggs");
    first.title = "Large Grade A Eggs";
    second.title = "Large Grade A Eggs Store Brand";
    searchMock.mockResolvedValue({
      ...searchResult(first),
      products: [first, second],
    });
    detailMock.mockImplementation((identifier) => Promise.resolve(
      detailResult(identifier === second.itemId ? second : first),
    ));
    verifyMock.mockImplementationOnce((request, preliminary) => ({
      ...preliminary,
      requestedItem: request,
      recommended: null,
      alternatives: [],
      confidence: "low",
      status: "no_match",
      explanation: "First candidate failed current stock verification.",
    }));

    const response = await searchPost(new Request("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: ["eggs"], storeId: "2201" }),
    }));
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SearchStreamEvent);
    const verification = events.find(
      (event) => event.type === "item" && event.phase === "verification",
    );

    expect(detailMock).toHaveBeenNthCalledWith(
      1,
      first.itemId,
      "2201",
      expect.any(AbortSignal),
    );
    expect(detailMock).toHaveBeenNthCalledWith(
      2,
      second.itemId,
      "2201",
      expect.any(AbortSignal),
    );
    expect(verification).toMatchObject({
      result: {
        status: "matched",
        recommended: { id: second.id },
      },
    });
  });

  it("limits an independent verification queue to four active tasks", async () => {
    const schedule = createConcurrencyLimiter(4);
    const gates = Array.from({ length: 9 }, () => deferred<void>());
    let active = 0;
    let maximumActive = 0;

    const work = gates.map((gate) => schedule(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate.promise;
      active -= 1;
    }));

    await waitFor(() => active === 4);
    expect(maximumActive).toBe(4);
    expect(active).toBe(4);

    for (const gate of gates) gate.resolve();
    await Promise.all(work);

    expect(maximumActive).toBe(4);
    expect(active).toBe(0);
  });
});
