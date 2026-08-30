import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearWalmartStoreDirectoryCache,
  findWalmartStoresByZip,
  getWalmartStoresByZip,
  MAX_STORE_LOOKUP_RESULTS,
  normalizeUsZip,
  parseNearbyWalmartStores,
  parseWalmartStoreDirectory,
} from "@/lib/walmart-stores";

const directoryFixture = [
  { store_id: "2201", postal_code: "79925", address: "7101 Gateway Blvd W" },
  { store_id: "3661", postal_code: "79936", address: "1551 N Zaragoza Rd" },
  { store_id: "5108", postal_code: "79936", address: "3000 Saul Kleinfeld Dr" },
  { store_id: "2612", postal_code: "79936", address: "1850 N Zaragoza Rd" },
  { store_id: "1762", postal_code: "03874", address: "700 Lafayette Rd, Seabrook, NH 03874" },
  {
    store_id: "2344",
    postal_code: "11220",
    address: "Blvd. Manuel Ávila Camacho No. 491, Ciudad De Mexico, 11220, MX",
    country: "MX",
  },
  { store_id: "not-a-store", postal_code: "79925", address: "Malformed" },
  { store_id: "9999", postal_code: "7992", address: "Malformed ZIP" },
];

afterEach(() => {
  clearWalmartStoreDirectoryCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Walmart supported-store directory", () => {
  it("filters exact ZIP matches, excludes Mexico and malformed rows, and orders deterministically", () => {
    const stores = parseWalmartStoreDirectory(directoryFixture);

    expect(findWalmartStoresByZip(stores, "79925")).toEqual({
      zipCode: "79925",
      stores: [{
        storeId: "2201",
        postalCode: "79925",
        address: "7101 Gateway Blvd W",
        country: "US",
      }],
      totalMatches: 1,
    });
    expect(findWalmartStoresByZip(stores, "79936").stores.map((store) => store.storeId))
      .toEqual(["3661", "2612", "5108"]);
    expect(stores.some((store) => store.storeId === "2344")).toBe(false);
  });

  it("preserves leading-zero ZIP codes and rejects malformed input", () => {
    const stores = parseWalmartStoreDirectory(directoryFixture);
    expect(normalizeUsZip("03874")).toBe("03874");
    expect(findWalmartStoresByZip(stores, "03874").stores[0].storeId).toBe("1762");
    expect(() => normalizeUsZip("3874")).toThrow(/five-digit/i);
    expect(() => normalizeUsZip("79925-1234")).toThrow(/five-digit/i);
    expect(() => normalizeUsZip("7992A")).toThrow(/five-digit/i);
  });

  it("bounds returned matches without hiding the exact total", () => {
    const stores = Array.from({ length: MAX_STORE_LOOKUP_RESULTS + 5 }, (_, index) => ({
      storeId: String(10_000 + index),
      postalCode: "79936",
      address: `${index.toString().padStart(2, "0")} Test Rd`,
      country: "US" as const,
    }));
    const result = findWalmartStoresByZip(stores, "79936", 1_000);
    expect(result.stores).toHaveLength(MAX_STORE_LOOKUP_RESULTS);
    expect(result.totalMatches).toBe(MAX_STORE_LOOKUP_RESULTS + 5);
  });

  it("parses distance-ranked nearby Walmart results and rejects non-Walmart links", () => {
    const stores = parseWalmartStoreDirectory([
      { store_id: "3014", postal_code: "75232", address: "200 Short Blvd" },
      { store_id: "5147", postal_code: "75211", address: "1521 N Cockrell Hill Rd" },
    ]);
    const result = parseNearbyWalmartStores({
      search_metadata: { status: "Success" },
      search_parameters: { location_used: "75216,Texas,United States" },
      local_results: [
        {
          title: "Walmart Supercenter",
          address: "200 Short Blvd, Dallas, TX 75232",
          links: { website: "https://www.walmart.com/store/3014-dallas-tx" },
        },
        {
          title: "Walmart Supercenter",
          address: "1521 N Cockrell Hill Rd, Dallas, TX 75211",
          links: { website: "https://www.walmart.com/store/5147-dallas-tx" },
        },
        {
          title: "Not Walmart",
          links: { website: "https://example.com/store/3014" },
        },
      ],
    }, stores, "75216");

    expect(result.map((store) => store.storeId)).toEqual(["3014", "5147"]);
    expect(result[0].address).toBe("200 Short Blvd, Dallas, TX 75232");
  });

  it("rejects a nearby response resolved for a different ZIP", () => {
    expect(() => parseNearbyWalmartStores({
      search_metadata: { status: "Success" },
      search_parameters: { location_used: "79925,Texas,United States" },
      local_results: [],
    }, parseWalmartStoreDirectory(directoryFixture), "75216")).toThrow(/malformed/i);
  });

  it("fails closed for a malformed or empty root payload", () => {
    expect(() => parseWalmartStoreDirectory({ stores: directoryFixture })).toThrow(/malformed/i);
    expect(() => parseWalmartStoreDirectory([])).toThrow(/valid US stores/i);
    expect(() => parseWalmartStoreDirectory(Array.from({ length: 10_001 })))
      .toThrow(/malformed/i);
  });

  it("deduplicates an in-flight download and caches successful directory data", async () => {
    let releaseFetch!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchMock = vi.fn(async () => {
      await blocked;
      return Response.json(directoryFixture);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = getWalmartStoresByZip("79925");
    const shared = getWalmartStoresByZip("79936");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFetch();

    const [firstResult, sharedResult] = await Promise.all([first, shared]);
    const cachedResult = await getWalmartStoresByZip("03874");
    expect(firstResult.stores[0].storeId).toBe("2201");
    expect(sharedResult.totalMatches).toBe(3);
    expect(cachedResult.stores[0].storeId).toBe("1762");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache malformed upstream data", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("not json", { status: 200 }))
      .mockResolvedValueOnce(Response.json(directoryFixture));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getWalmartStoresByZip("79925")).rejects.toMatchObject({ code: "malformed" });
    await expect(getWalmartStoresByZip("79925")).resolves.toMatchObject({ totalMatches: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out a stalled directory download", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));

    const assertion = expect(getWalmartStoresByZip("79925"))
      .rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(8_001);
    await assertion;
  });
});
