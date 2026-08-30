import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRedCircleTargetStoreStock,
  parseRedCircleTargetProduct,
  parseRedCircleTargetSearch,
  parseRedCircleTargetStoreStock,
  searchRedCircleTarget,
} from "@/lib/redcircle-target";

const originalKey = process.env.REDCIRCLE_API_KEY;

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RedCircle Target provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.REDCIRCLE_API_KEY = "test-redcircle-secret";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.REDCIRCLE_API_KEY;
    else process.env.REDCIRCLE_API_KEY = originalKey;
  });

  it("parses exact Search identity, Target seller, and current price", () => {
    const products = parseRedCircleTargetSearch({
      search_results: [{
        product: {
          title: "Grade A Large Eggs - 12ct - Good &#38; Gather&#8482;",
          tcin: "92186007",
          link: "https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-92186007",
          brand: "Good & Gather",
          main_image: "https://target.scene7.com/example.jpg",
        },
        offers: { primary: { price: 3.49, currency: "USD" } },
        fulfillment: { type: "1p" },
      }],
    }, { storeId: "1234", deliveryZip: "79912", deliveryType: "pickup" });

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      tcin: "92186007",
      title: "Grade A Large Eggs - 12ct - Good & Gather™",
      priceCents: 349,
      seller: "Target",
      provenance: {
        requestedStoreId: "1234",
        requestedZip: "79912",
        locationVerified: false,
        sellerType: "target",
      },
    });
  });

  it("parses Product details and arbitrary-ZIP store stock separately", () => {
    const product = parseRedCircleTargetProduct({
      product: {
        tcin: "92186007",
        title: "Grade A Large Eggs - 12ct - Good & Gather",
        link: "https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-92186007",
        brand: "Good & Gather",
        buybox_winner: {
          price: { value: 3.49, currency: "USD" },
          availability: { in_stock: true },
          fulfillment: { type: "1p" },
        },
      },
    });
    const stores = parseRedCircleTargetStoreStock({
      store_stock_results: [{
        store_id: "0822",
        store_name: "El Paso Target",
        in_stock: true,
        stock_level: 7,
        zipcode: "79912-1234",
        distance: 1.2,
      }],
    });

    expect(product).toMatchObject({ tcin: "92186007", priceCents: 349, inStock: true });
    expect(stores).toEqual([expect.objectContaining({
      storeId: "822",
      inStock: true,
      stockLevel: 7,
      postalCode: "79912",
    })]);
    expect(product?.provenance.locationVerified).toBe(false);
  });

  it("keeps the key server-side and sends only the active product query", async () => {
    const seen: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      seen.push(url);
      return response({
        request_info: { success: true, credits_remaining: 99 },
        search_results: [],
      });
    }));

    const result = await searchRedCircleTarget(`unique eggs ${Date.now()}`);
    expect(result.diagnostics.apiCall).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].origin + seen[0].pathname).toBe("https://api.redcircleapi.com/request");
    expect(seen[0].searchParams.get("type")).toBe("search");
    expect(seen[0].searchParams.get("api_key")).toBe("test-redcircle-secret");
    expect(JSON.stringify(result)).not.toContain("test-redcircle-secret");
    vi.unstubAllGlobals();
  });

  it("uses store_stock_zipcode without requiring a registered customer ZIP", async () => {
    let requested: URL | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requested = new URL(input instanceof Request ? input.url : input.toString());
      return response({
        request_info: { success: true },
        store_stock_results: [{ store_id: "1234", in_stock: true }],
      });
    }));

    const result = await getRedCircleTargetStoreStock("92186007", "79912");
    expect(result.stores[0]).toMatchObject({ storeId: "1234", inStock: true });
    expect(requested?.searchParams.get("store_stock_zipcode")).toBe("79912");
    expect(requested?.searchParams.has("customer_zipcode")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("keeps cached request context separated by store and ZIP", async () => {
    const fetchMock = vi.fn(async () => response({
      request_info: { success: true },
      search_results: [],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const query = `context-separated-${Date.now()}`;

    await searchRedCircleTarget(query, {
      deliveryType: "pickup",
      storeId: "822",
      deliveryZip: "79912",
    });
    await searchRedCircleTarget(query, {
      deliveryType: "pickup",
      storeId: "849",
      deliveryZip: "79925",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("fails safely when the server key is missing", async () => {
    delete process.env.REDCIRCLE_API_KEY;
    await expect(searchRedCircleTarget(`missing-key-${Date.now()}`)).rejects.toMatchObject({
      code: "configuration",
      message: expect.not.stringContaining("api_key"),
    });
  });
});
