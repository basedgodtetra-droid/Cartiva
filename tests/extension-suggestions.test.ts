import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPTIONS as extensionSuggestionsOptions,
  POST as extensionSuggestionsPost,
} from "@/app/api/extension/suggestions/route";
import { extractMeasurement } from "@/lib/measurements";
import {
  getWalmartProductDetails,
  searchWalmart,
  WalmartSearchError,
} from "@/lib/serpapi";
import type { WalmartProduct } from "@/lib/types";

vi.mock("@/lib/serpapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/serpapi")>();
  return {
    ...actual,
    getWalmartProductDetails: vi.fn(),
    searchWalmart: vi.fn(),
  };
});

const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const searchMock = vi.mocked(searchWalmart);
const detailMock = vi.mocked(getWalmartProductDetails);

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/extension/suggestions", {
    method: "POST",
    headers: {
      Origin: extensionOrigin,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function product(
  id: string,
  title: string,
  price: number,
  options: Partial<WalmartProduct> = {},
): WalmartProduct {
  return {
    id,
    productId: `product-${id}`,
    itemId: `item-${id}`,
    title,
    brand: options.brand,
    productType: options.productType,
    price,
    priceCents: Math.round(price * 100),
    link: `https://www.walmart.com/ip/${id}/item-${id}`,
    linkType: "product",
    dataSource: "serpapi",
    seller: "Walmart",
    inStock: true,
    sponsored: false,
    size: extractMeasurement(title),
    verification: "unverified",
    ...options,
  };
}

function successfulSearch(products: WalmartProduct[], mode: "live" | "demo" = "live") {
  return {
    products,
    mode,
    diagnostics: {
      cacheHit: false,
      deduplicated: false,
      apiCall: mode === "live",
      serpApiCacheUsed: null,
    },
  };
}

afterEach(() => {
  searchMock.mockReset();
  detailMock.mockReset();
});

describe("extension Walmart suggestion route", () => {
  it("answers valid preflight requests and rejects untrusted origins", () => {
    const allowed = extensionSuggestionsOptions(new Request(
      "http://localhost:3000/api/extension/suggestions",
      {
        method: "OPTIONS",
        headers: {
          Origin: extensionOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
    ));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);

    const rejected = extensionSuggestionsOptions(new Request(
      "http://localhost:3000/api/extension/suggestions",
      { method: "OPTIONS", headers: { Origin: "https://attacker.example" } },
    ));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns exact ranked Walmart fields without calling product details", async () => {
    const exactTitle = "Takis® Fuego Hot Chili Pepper & Lime Flavored Rolled Tortilla Chips, 9.9 oz Bag";
    searchMock.mockResolvedValue(successfulSearch([
      product("store-brand", "Great Value Takis Style Rolled Tortilla Chips, 9 oz Bag", 2.48, {
        brand: "Great Value",
        productType: "chips",
      }),
      product("takis", exactTitle, 3.48, {
        brand: "Takis",
        productType: "chips",
      }),
    ]));

    const response = await extensionSuggestionsPost(request({ query: "Takis", storeId: "2201" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(searchMock).toHaveBeenCalledWith("takis", "2201", expect.any(AbortSignal));
    expect(detailMock).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      query: "Takis",
      mode: "live",
      suggestions: [{
        title: exactTitle,
        productId: "product-takis",
        itemId: "item-takis",
        brand: "Takis",
        price: 3.48,
        priceCents: 348,
        size: { label: "9.9 oz" },
      }],
    });
  });

  it("accepts ZIP context while searching the selected SerpApi store", async () => {
    searchMock.mockResolvedValue(successfulSearch([
      product("ham", "Black Forest Ham Lunchmeat, 9 oz", 4.98, {
        productType: "lunchmeat",
      }),
    ]));

    const response = await extensionSuggestionsPost(request({
      query: "black forest ham",
      storeId: "2201",
      zipCode: "79912",
    }));

    expect(response.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith(
      "black forest ham",
      "2201",
      expect.any(AbortSignal),
    );
  });

  it("keeps plain Coke on regular Coca-Cola and bounds the response to six", async () => {
    const regular = [6, 8, 10, 12, 15, 18, 24, 30].map((packCount) => product(
      `regular-${packCount}`,
      `Coca-Cola Soda Pop Cans, 12 fl oz, ${packCount} Pack`,
      4 + packCount / 10,
      { brand: "Coca-Cola", productType: "soda" },
    ));
    const zero = product(
      "zero",
      "Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 12 Pack",
      1,
      { brand: "Coca-Cola", productType: "soda" },
    );
    searchMock.mockResolvedValue(successfulSearch([zero, ...regular]));

    const response = await extensionSuggestionsPost(request({ query: "Coke", storeId: "2201" }));
    const payload = await response.json() as {
      suggestions: Array<{ title: string }>;
    };

    expect(searchMock).toHaveBeenCalledWith("coke", "2201", expect.any(AbortSignal));
    expect(payload.suggestions).toHaveLength(6);
    expect(payload.suggestions.every((item) => /coca-cola soda pop/i.test(item.title))).toBe(true);
    expect(payload.suggestions.every((item) => !/zero|diet|cherry/i.test(item.title))).toBe(true);
  });

  it("preserves Diet Coke in Walmart search and returns only the requested variety", async () => {
    const regular = product(
      "regular",
      "Coca-Cola Soda Pop Cans, 12 fl oz, 12 Pack",
      7.48,
      { brand: "Coca-Cola", productType: "soda" },
    );
    const zero = product(
      "zero",
      "Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 12 Pack",
      7.48,
      { brand: "Coca-Cola", productType: "soda" },
    );
    const diet = product(
      "diet",
      "Diet Coke Soda Pop Cans, 12 fl oz, 12 Pack",
      7.48,
      { brand: "Coca-Cola", productType: "soda" },
    );
    searchMock.mockResolvedValue(successfulSearch([regular, zero, diet]));

    const response = await extensionSuggestionsPost(request({
      query: "Diet Coke",
      storeId: "2201",
    }));
    const payload = await response.json() as {
      suggestions: Array<{ title: string }>;
    };

    expect(response.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("diet coke", "2201", expect.any(AbortSignal));
    expect(payload.suggestions).toEqual([
      expect.objectContaining({ title: diet.title }),
    ]);
  });

  it("preserves Coke Zero in Walmart search and excludes regular and diet Coke", async () => {
    const regular = product(
      "regular",
      "Coca-Cola Soda Pop Cans, 12 fl oz, 12 Pack",
      7.48,
      { brand: "Coca-Cola", productType: "soda" },
    );
    const diet = product(
      "diet",
      "Diet Coke Soda Pop Cans, 12 fl oz, 12 Pack",
      7.48,
      { brand: "Coca-Cola", productType: "soda" },
    );
    const zero = product(
      "zero",
      "Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 12 Pack",
      7.48,
      { brand: "Coca-Cola", productType: "soda" },
    );
    searchMock.mockResolvedValue(successfulSearch([regular, diet, zero]));

    const response = await extensionSuggestionsPost(request({
      query: "Coke Zero",
      storeId: "2201",
    }));
    const payload = await response.json() as {
      suggestions: Array<{ title: string }>;
    };

    expect(response.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("coke zero", "2201", expect.any(AbortSignal));
    expect(payload.suggestions).toEqual([
      expect.objectContaining({ title: zero.title }),
    ]);
  });

  it("diversifies broad chip suggestions across exact Walmart brands and flavors", async () => {
    searchMock.mockResolvedValue(successfulSearch([
      product("gv-original", "Great Value Original Potato Chips, 8 oz Bag", 1.98, {
        productType: "chips",
      }),
      product("lays-classic", "Lay's Classic Potato Chips, 8 oz Bag", 3.48, {
        productType: "chips",
      }),
      product("gv-party", "Great Value Original Potato Chips, Party Size, 13 oz Bag", 2.98, {
        productType: "chips",
      }),
      product("lays-sour", "Lay's Sour Cream & Onion Potato Chips, 7.75 oz Bag", 3.48, {
        productType: "chips",
      }),
      product("doritos-hot", "Doritos Flamin' Hot Nacho Flavored Tortilla Chips, 9.25 oz Bag", 3.96, {
        productType: "chips",
      }),
      product("ruffles-cheddar", "Ruffles Cheddar & Sour Cream Potato Chips, 8.5 oz Bag", 4.48, {
        productType: "chips",
      }),
      product("baking", "Nestle Toll House Semi-Sweet Chocolate Chips, 12 oz Bag", 3.97, {
        productType: "Baking Chips",
      }),
    ]));

    const response = await extensionSuggestionsPost(request({ query: "chips", storeId: "2201" }));
    const payload = await response.json() as {
      suggestions: Array<{
        title: string;
        brand?: string;
        brandSource?: string;
        flavor?: string;
        format?: string;
      }>;
    };

    expect(response.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("chips", "2201", expect.any(AbortSignal));
    expect(payload.suggestions.length).toBeLessThanOrEqual(6);
    expect(new Set(payload.suggestions.map((item) => item.brand)).size).toBeGreaterThanOrEqual(3);
    expect(payload.suggestions.filter((item) => item.brand).every((item) => (
      item.brandSource === "title"
    ))).toBe(true);
    expect(payload.suggestions.map((item) => item.flavor)).toEqual(expect.arrayContaining([
      "Original",
      "Sour Cream & Onion",
      "Flamin' Hot",
    ]));
    expect(payload.suggestions.every((item) => item.format === "Bag")).toBe(true);
    expect(payload.suggestions.some((item) => /chocolate/i.test(item.title))).toBe(false);
  });

  it("supports unknown grocery items while rejecting partial-word false positives", async () => {
    searchMock.mockResolvedValue(successfulSearch([
      product("sponges-gv", "Great Value Non-Scratch Dish Sponges, 6 Count", 2.24, {
        brand: "Great Value",
        productType: "Cleaning Tools",
      }),
      product("dish-soap", "Dawn Ultra Dish Soap, Original Scent, 18 fl oz", 3.94, {
        brand: "Dawn",
        productType: "Dish Soap",
      }),
      product("sponges-scotch", "Scotch-Brite Heavy Duty Dish Sponges, 3 Count", 3.48, {
        brand: "Scotch-Brite",
        productType: "Cleaning Tools",
      }),
    ]));

    const response = await extensionSuggestionsPost(request({
      query: "dish sponges",
      storeId: "2201",
    }));
    const payload = await response.json() as {
      suggestions: Array<{ title: string; productId?: string }>;
    };

    expect(response.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("dish sponges", "2201", expect.any(AbortSignal));
    expect(payload.suggestions.map((item) => item.productId)).toEqual(expect.arrayContaining([
      "product-sponges-gv",
      "product-sponges-scotch",
    ]));
    expect(payload.suggestions.some((item) => item.title.includes("Dish Soap"))).toBe(false);
  });

  it("returns a Walmart spelling correction even when the typo cannot pass exact-product filtering", async () => {
    searchMock.mockResolvedValue({
      ...successfulSearch([
        product("ham", "Great Value Black Forest Ham Lunchmeat, 9 oz", 3.97, {
          brand: "Great Value",
          productType: "Lunch Meat",
        }),
      ]),
      suggestionSignals: [{ text: "black forest ham", source: "spelling" as const }],
    });

    const response = await extensionSuggestionsPost(request({
      query: "black forst ham",
      storeId: "2201",
    }));
    const payload = await response.json() as {
      searchIdeas: Array<{ text: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.searchIdeas.map((item) => item.text.toLowerCase())).toContain("black forest ham");
  });

  it("accepts a three-character active fragment and preserves the exact API result", async () => {
    const exactTitle = "StarKist Chunk Light Tuna in Water, 5 oz Can";
    searchMock.mockResolvedValue(successfulSearch([
      product("tuna", exactTitle, 1.14, {
        brand: "StarKist",
        productType: "Canned Seafood",
      }),
    ]));

    const response = await extensionSuggestionsPost(request({ query: "tun", storeId: "2201" }));
    const payload = await response.json() as {
      suggestions: Array<{ title: string; productId?: string }>;
    };

    expect(response.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("tun", "2201", expect.any(AbortSignal));
    expect(payload.suggestions).toEqual([
      expect.objectContaining({ title: exactTitle, productId: "product-tuna" }),
    ]);
  });

  it.each([
    {
      query: "asparagus",
      freshTitle: "Fresh Green Whole Asparagus Bunch, Fresh Produce",
      processedTitle: "Great Value Asparagus Cut Spears, 14.5 oz Can",
      processedType: "Canned Vegetables",
    },
    {
      query: "broccoli",
      freshTitle: "Fresh Whole Green Broccoli Crowns, 1 Each",
      processedTitle: "Great Value Frozen Broccoli Florets Steamable Bag, 12 oz",
      processedType: "Frozen Vegetables",
    },
    {
      query: "tomatoes",
      freshTitle: "Fresh Roma Tomato, Each",
      processedTitle: "Great Value Petite Diced Tomatoes, 14.5 oz Can",
      processedType: "Canned Vegetables",
    },
  ])("defaults concrete $query suggestions to fresh produce", async ({
    query,
    freshTitle,
    processedTitle,
    processedType,
  }) => {
    searchMock.mockResolvedValue(successfulSearch([
      product("processed", processedTitle, 0.88, { productType: processedType }),
      product("fresh", freshTitle, 2.48, { productType: "Fresh Produce" }),
    ]));

    const response = await extensionSuggestionsPost(request({ query, storeId: "2201" }));
    const payload = await response.json() as {
      suggestions: Array<{ title: string; productId?: string }>;
    };

    expect(response.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith(query, "2201", expect.any(AbortSignal));
    expect(payload.suggestions).toEqual([
      expect.objectContaining({ title: freshTitle, productId: "product-fresh" }),
    ]);
    expect(payload.suggestions.some((item) => item.title === processedTitle)).toBe(false);
  });

  it("keeps an explicitly frozen vegetable request frozen", async () => {
    searchMock.mockResolvedValue(successfulSearch([
      product("fresh", "Fresh Whole Green Broccoli Crowns, 1 Each", 1.72, {
        productType: "Fresh Produce",
      }),
      product("frozen", "Great Value Frozen Broccoli Florets, 12 oz Bag", 1.16, {
        productType: "Frozen Vegetables",
      }),
    ]));

    const response = await extensionSuggestionsPost(request({
      query: "frozen broccoli",
      storeId: "2201",
    }));
    const payload = await response.json() as {
      suggestions: Array<{ title: string; productId?: string }>;
    };

    expect(searchMock).toHaveBeenCalledWith("frozen broccoli", "2201", expect.any(AbortSignal));
    expect(payload.suggestions).toEqual([
      expect.objectContaining({ productId: "product-frozen" }),
    ]);
  });

  it("rejects malformed input before Walmart access", async () => {
    const shortQuery = await extensionSuggestionsPost(request({ query: "x", storeId: "2201" }));
    expect(shortQuery.status).toBe(400);
    expect(await shortQuery.json()).toEqual({
      error: "Enter between 3 and 160 characters for one grocery item.",
    });

    const invalidStore = await extensionSuggestionsPost(request({
      query: "Takis",
      storeId: "2201<script>",
    }));
    expect(invalidStore.status).toBe(400);

    const invalidZip = await extensionSuggestionsPost(request({
      query: "Takis",
      storeId: "2201",
      zipCode: "799",
    }));
    expect(invalidZip.status).toBe(400);

    const wrongType = await extensionSuggestionsPost(request(
      { query: "Takis", storeId: "2201" },
      { "Content-Type": "text/plain" },
    ));
    expect(wrongType.status).toBe(415);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("sanitizes upstream failures while preserving a useful status", async () => {
    searchMock.mockRejectedValue(new WalmartSearchError(
      "private upstream quota details",
      "rate_limit",
    ));

    const response = await extensionSuggestionsPost(request({ query: "Takis", storeId: "2201" }));
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(payload.error).toMatch(/rate-limited/i);
    expect(JSON.stringify(payload)).not.toContain("private upstream quota details");
  });
});
