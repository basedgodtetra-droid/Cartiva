import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getParseBotTargetStoreStock,
  searchParseBotTarget,
} from "@/lib/parsebot-target";
import { POST } from "@/app/api/target/search/route";
import {
  OPTIONS as extensionTargetOptions,
  POST as extensionTargetPost,
} from "@/app/api/extension/target/search/route";
import type { TargetSearchStreamEvent } from "@/lib/types";

vi.mock("@/lib/parsebot-target", () => ({
  searchParseBotTarget: vi.fn(),
  getParseBotTargetStoreStock: vi.fn(),
}));

const searchMock = vi.mocked(searchParseBotTarget);
const stockMock = vi.mocked(getParseBotTargetStoreStock);
const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

function diagnostics() {
  return {
    cacheHit: false,
    deduplicated: false,
    apiCall: true,
    durationMs: 10,
  };
}

function parseBotProduct(
  inStock?: boolean,
  overrides: Partial<ReturnType<typeof parseBotProductBase>> = {},
) {
  return { ...parseBotProductBase(inStock), ...overrides };
}

function parseBotProductBase(inStock?: boolean) {
  const checkedAt = new Date().toISOString();
  return {
    tcin: "92186007",
    title: "Grade A Large Eggs - 12ct - Good & Gather",
    url: "https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-92186007",
    price: 3.49,
    priceCents: 349,
    currency: "USD" as const,
    brand: "Good & Gather",
    inStock,
    checkedAt,
    provenance: {
      source: inStock === undefined ? "parsebot_target_search" as const : "parsebot_target_product" as const,
      requestedZip: "79912",
      fulfillmentType: "pickup" as const,
      locationVerified: false as const,
      sellerType: "unknown" as const,
      checkedAt,
    },
  };
}

function request(body: unknown) {
  return new Request("http://localhost:3000/api/target/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function streamEvents(response: Response) {
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TargetSearchStreamEvent);
}

beforeEach(() => {
  vi.stubEnv("TARGET_DATA_PROVIDER", "parsebot");
  vi.stubEnv("PARSEBOT_API_KEY", "parsebot-test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Target search route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchMock.mockResolvedValue({
      products: [parseBotProduct()],
      mode: "live",
      diagnostics: diagnostics(),
    });
    stockMock.mockResolvedValue({
      productId: "92186007",
      productTitle: "Grade A Large Eggs - 12ct - Good & Gather",
      productUrl: "https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-92186007",
      zipCode: "79912",
      stores: [{ storeId: "1234", inStock: true, postalCode: "79912" }],
      mode: "live",
      diagnostics: diagnostics(),
    });
  });

  it("streams a localized Target result without enabling cart automation", async () => {
    const response = await POST(request({
      retailer: "target",
      items: ["eggs"],
      fulfillmentMode: "pickup",
      storeId: "1234",
      zipCode: "79912",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("X-Cartiva-Cart-Automation")).toBe("disabled");

    const events = await streamEvents(response);
    expect(events.map((event) => event.type)).toEqual(["item", "item", "performance"]);
    const verification = events.find(
      (event) => event.type === "item" && event.phase === "verification",
    );
    expect(verification).toMatchObject({
      retailer: "target",
      cartAutomation: { enabled: false },
      result: {
        retailer: "target",
        status: "matched",
        recommended: {
          retailer: "target",
          productId: "92186007",
          dataSource: "parsebot",
          priceLabel: "Localized price estimate",
          cartEligible: false,
          priceProvenance: {
            exactStoreVerified: false,
            priceReliability: "localized_estimate",
            sellerType: "unknown",
          },
        },
      },
      diagnostics: { verificationStatus: "localized_estimate" },
    });
    expect(searchMock).toHaveBeenCalledWith(
      "eggs",
      { zip: "79912" },
      expect.any(AbortSignal),
    );
    expect(stockMock).toHaveBeenCalledWith(
      "92186007",
      "79912",
      expect.any(AbortSignal),
    );
    if (verification?.type !== "item") throw new Error("Missing verification event");
    expect(verification.result.recommended?.seller).toBeUndefined();
    const performanceEvent = events.find((event) => event.type === "performance");
    expect(performanceEvent).toMatchObject({
      performance: {
        searchApiCalls: 1,
        productApiCalls: 1,
      },
    });
  });

  it("does not use availability from a different Target store", async () => {
    stockMock.mockResolvedValue({
      productId: "92186007",
      productTitle: "Grade A Large Eggs - 12ct - Good & Gather",
      productUrl: "https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-92186007",
      zipCode: "79912",
      stores: [{ storeId: "5678", inStock: true, postalCode: "79912" }],
      mode: "live",
      diagnostics: diagnostics(),
    });
    const response = await POST(request({
      retailer: "target",
      items: ["eggs"],
      fulfillmentMode: "pickup",
      storeId: "1234",
      zipCode: "79912",
    }));

    const events = await streamEvents(response);
    const verification = events.find(
      (event) => event.type === "item" && event.phase === "verification",
    );
    expect(verification).toMatchObject({
      result: {
        status: "review",
        recommended: {
          productId: "92186007",
          dataSource: "parsebot",
          cartEligible: false,
          availabilityStatus: "unknown",
          priceProvenance: {
            exactStoreVerified: false,
            priceReliability: "localized_estimate",
          },
        },
      },
      diagnostics: { verificationStatus: "needs_review" },
    });
  });

  it("rejects availability returned for a different Target product", async () => {
    stockMock.mockResolvedValue({
      productId: "89199095",
      productTitle: "Different Target Product",
      productUrl: "https://www.target.com/p/different-target-product/-/A-89199095",
      zipCode: "79912",
      stores: [{ storeId: "1234", inStock: true, postalCode: "79912" }],
      mode: "live",
      diagnostics: diagnostics(),
    });
    const response = await POST(request({
      retailer: "target",
      items: ["eggs"],
      fulfillmentMode: "pickup",
      storeId: "1234",
      zipCode: "79912",
    }));

    const events = await streamEvents(response);
    const verification = events.find(
      (event) => event.type === "item" && event.phase === "verification",
    );
    expect(verification).toMatchObject({
      result: {
        status: "review",
        recommended: {
          productId: "92186007",
          cartEligible: false,
          verification: "unverified",
          availabilityStatus: "unknown",
        },
        explanation: expect.stringContaining("returned a different product"),
      },
      diagnostics: { verificationStatus: "needs_review" },
    });
  });

  it("keeps the Search candidate visible when selected-store stock times out", async () => {
    stockMock.mockRejectedValue(new Error("Target stock request timed out. Please try again."));
    const response = await POST(request({
      retailer: "target",
      items: ["eggs"],
      fulfillmentMode: "pickup",
      storeId: "1234",
      zipCode: "79912",
    }));

    const events = await streamEvents(response);
    const verification = events.find(
      (event) => event.type === "item" && event.phase === "verification",
    );
    expect(verification).toMatchObject({
      cartAutomation: { enabled: false },
      result: {
        status: "review",
        confidence: "low",
        recommended: {
          productId: "92186007",
          priceLabel: "Localized price estimate",
          cartEligible: false,
          verification: "unverified",
          priceProvenance: {
            exactStoreVerified: false,
            priceReliability: "localized_estimate",
          },
        },
        explanation: expect.stringContaining("selected store's inventory check was unavailable"),
      },
      diagnostics: {
        selectedProductId: "92186007",
        verificationStatus: "needs_review",
      },
    });
  });

  it("uses progressive package-light discovery without relaxing exact count matching", async () => {
    searchMock
      .mockResolvedValueOnce({
        products: [],
        mode: "live",
        diagnostics: diagnostics(),
      })
      .mockResolvedValue({
        products: [parseBotProduct()],
        mode: "live",
        diagnostics: diagnostics(),
      });

    const response = await POST(request({
      retailer: "target",
      items: ["Grade A Large Eggs, 12 count"],
      fulfillmentMode: "pickup",
      storeId: "1234",
      zipCode: "79912",
    }));
    const events = await streamEvents(response);

    expect(searchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(searchMock.mock.calls[0]?.[0]).not.toMatch(/12|count/i);
    expect(events.find((event) => event.type === "item" && event.phase === "verification"))
      .toMatchObject({
        result: {
          status: "matched",
          recommended: { productId: "92186007", cartEligible: false },
        },
      });
    expect(events.find((event) => event.type === "performance")).toMatchObject({
      performance: { searchApiCalls: 2 },
    });
  });

  it("keeps an 18-count Target result out of a requested 12-count match", async () => {
    searchMock.mockResolvedValue({
      products: [parseBotProduct(undefined, {
        title: "Grade A Large Eggs - 18ct - Good & Gather",
        url: "https://www.target.com/p/grade-a-large-eggs-18ct-good-gather/-/A-92186007",
      })],
      mode: "live",
      diagnostics: diagnostics(),
    });

    const response = await POST(request({
      retailer: "target",
      items: ["Grade A Large Eggs, 12 count"],
      fulfillmentMode: "pickup",
      storeId: "1234",
      zipCode: "79912",
    }));
    const events = await streamEvents(response);
    const itemEvents = events.filter((event) => event.type === "item");

    expect(itemEvents).toHaveLength(1);
    expect(itemEvents[0]).toMatchObject({
      phase: "search",
      result: { status: "no_match", recommended: null },
    });
    expect(stockMock).not.toHaveBeenCalled();
  });

  it("tries the next compatible Target candidate after a product-identity stock failure", async () => {
    const second = parseBotProduct(undefined, {
      tcin: "89199095",
      title: "Grade A Large Eggs - 12ct - Market Pantry",
      url: "https://www.target.com/p/grade-a-large-eggs-12ct-market-pantry/-/A-89199095",
      brand: "Market Pantry",
      price: 3.59,
      priceCents: 359,
    });
    searchMock.mockResolvedValue({
      products: [parseBotProduct(), second],
      mode: "live",
      diagnostics: diagnostics(),
    });
    stockMock.mockImplementation(async (productId) => {
      if (productId === "92186007") {
        return {
          productId: "99999999",
          productTitle: "Different product",
          productUrl: "https://www.target.com/p/different-product/-/A-99999999",
          zipCode: "79912",
          stores: [{ storeId: "1234", inStock: true, postalCode: "79912" }],
          mode: "live" as const,
          diagnostics: diagnostics(),
        };
      }
      return {
        productId: "89199095",
        productTitle: second.title,
        productUrl: second.url,
        zipCode: "79912",
        stores: [{ storeId: "1234", inStock: true, postalCode: "79912" }],
        mode: "live" as const,
        diagnostics: diagnostics(),
      };
    });

    const response = await POST(request({
      retailer: "target",
      items: [{ text: "eggs", preferredProductId: "92186007" }],
      fulfillmentMode: "pickup",
      storeId: "1234",
      zipCode: "79912",
    }));
    const events = await streamEvents(response);
    const verification = events.find(
      (event) => event.type === "item" && event.phase === "verification",
    );

    expect(stockMock).toHaveBeenNthCalledWith(
      1,
      "92186007",
      "79912",
      expect.any(AbortSignal),
    );
    expect(stockMock).toHaveBeenNthCalledWith(
      2,
      "89199095",
      "79912",
      expect.any(AbortSignal),
    );
    expect(verification).toMatchObject({
      result: {
        status: "matched",
        recommended: { productId: "89199095", cartEligible: false },
      },
    });
  });

  it("requires Target-specific localization and rejects Walmart-shaped routing", async () => {
    const missingPickupStore = await POST(request({
      items: ["eggs"],
      fulfillmentMode: "pickup",
      zipCode: "79912",
    }));
    expect(missingPickupStore.status).toBe(400);
    expect(await missingPickupStore.json()).toMatchObject({
      error: expect.stringContaining("Target store ID"),
      cartAutomation: { enabled: false },
    });

    const missingPickupZip = await POST(request({
      items: ["eggs"],
      fulfillmentMode: "pickup",
      storeId: "1234",
    }));
    expect(missingPickupZip.status).toBe(400);
    expect(await missingPickupZip.json()).toMatchObject({
      error: expect.stringContaining("ZIP code"),
      cartAutomation: { enabled: false },
    });

    const walmartLengthStore = await POST(request({
      items: ["eggs"],
      fulfillmentMode: "pickup",
      storeId: "12345678",
    }));
    expect(walmartLengthStore.status).toBe(400);
    expect(await walmartLengthStore.json()).toEqual({
      error: "Enter a valid 3- or 4-digit Target store ID.",
    });

    const missingDeliveryZip = await POST(request({
      items: ["eggs"],
      fulfillmentMode: "delivery",
    }));
    expect(missingDeliveryZip.status).toBe(400);
    expect(await missingDeliveryZip.json()).toEqual({
      error: "Enter a 5-digit ZIP code for Target delivery.",
    });

    const wrongRetailer = await POST(request({
      retailer: "walmart",
      items: ["eggs"],
      fulfillmentMode: "pickup",
      storeId: "1234",
    }));
    expect(wrongRetailer.status).toBe(400);
    expect(await wrongRetailer.json()).toEqual({
      error: "Use this route only for Target searches.",
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("does not treat a leftover RedCircle key as live Target configuration", async () => {
    vi.stubEnv("PARSEBOT_API_KEY", "");
    vi.stubEnv("REDCIRCLE_API_KEY", "legacy-redcircle-key");
    const response = await POST(request({
      retailer: "target",
      items: ["eggs"],
      fulfillmentMode: "pickup",
      storeId: "1234",
      zipCode: "79912",
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("PARSEBOT_API_KEY"),
      cartAutomation: { enabled: false },
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("passes delivery ZIP localization without inventing a Target store", async () => {
    const response = await POST(request({
      items: ["eggs"],
      fulfillmentMode: "shipping",
      zipCode: "79912",
    }));
    expect(response.status).toBe(200);
    const events = await streamEvents(response);
    expect(searchMock).toHaveBeenCalledWith(
      "eggs",
      { zip: "79912" },
      expect.any(AbortSignal),
    );
    expect(stockMock).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === "item" && event.phase === "verification"))
      .toMatchObject({
        result: {
          status: "matched",
          recommended: {
            productId: "92186007",
            dataSource: "parsebot",
            availabilityStatus: "unknown",
            cartEligible: false,
          },
        },
      });
    expect(events.find((event) => event.type === "performance")).toMatchObject({
      performance: {
        searchApiCalls: 1,
        productApiCalls: 0,
      },
    });
  });
});

describe("Target extension route", () => {
  it("provides the same stream behind the extension CORS boundary", async () => {
    searchMock.mockResolvedValue({
      products: [],
      mode: "live",
      diagnostics: diagnostics(),
    });
    const preflight = extensionTargetOptions(new Request(
      "http://localhost:3000/api/extension/target/search",
      {
        method: "OPTIONS",
        headers: {
          Origin: extensionOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
    ));
    expect(preflight.status).toBe(204);

    const response = await extensionTargetPost(new Request(
      "http://localhost:3000/api/extension/target/search",
      {
        method: "POST",
        headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({
          retailer: "target",
          items: ["eggs"],
          fulfillmentMode: "pickup",
          storeId: "1234",
          zipCode: "79912",
        }),
      },
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);
    expect(response.headers.get("X-Cartiva-Cart-Automation")).toBe("disabled");
    await response.text();
  });
});
