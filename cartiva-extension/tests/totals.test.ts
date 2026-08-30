import { describe, expect, it } from "vitest";
import {
  isBuildEligible,
  isFreshVerification,
  isReliableTargetMatch,
  isTargetBuildEligible,
  isValidTargetProductUrl,
  isValidWalmartProductUrl,
  targetEstimateSubtotalCents,
  usesLocalizedWalmartPrice,
  verifiedSubtotalCents,
} from "../src/totals";
import type { PreparedItem } from "../src/types";

function item(overrides: Partial<PreparedItem> = {}): PreparedItem {
  return {
    id: "eggs",
    request: { id: "eggs", text: "eggs", normalizedText: "eggs", quantity: 1 },
    matchStatus: "matched",
    alternatives: [],
    cartStatus: "ready",
    dataMode: "live",
    checkedAt: new Date().toISOString(),
    product: {
      id: "123456789",
      itemId: "123456789",
      title: "Large White Eggs, 12 Count",
      price: 2.48,
      priceCents: 248,
      link: "https://www.walmart.com/ip/large-eggs/123456789",
      linkType: "product",
      inStock: true,
      verification: "verified",
      priceProvenance: {
        localPriceEligible: true,
        localPriceVerified: true,
        verifiedFulfillmentMode: "pickup",
        sellerType: "walmart",
        fulfillment: ["pickup"],
        requestedStoreId: "3014",
        searchStoreId: "3014",
        detailStoreId: "3014",
      },
    },
    ...overrides,
  };
}

describe("verified extension subtotal", () => {
  it("uses integer cents and multiplies requested cart quantity", () => {
    const eggs = item({ request: { id: "eggs", text: "eggs", normalizedText: "eggs", quantity: 3 } });
    expect(verifiedSubtotalCents([eggs], "pickup")).toBe(744);
  });

  it("excludes Needs review, demo, unverified and search-fallback results", () => {
    const needsReview = item({ id: "review", matchStatus: "needs_review" });
    const demo = item({ id: "demo", dataMode: "demo" });
    const searchFallback = item({ id: "search", product: { ...item().product!, linkType: "search" } });
    const unverified = item({ id: "unverified", product: { ...item().product!, verification: "unverified" } });
    expect(verifiedSubtotalCents([needsReview, demo, searchFallback, unverified], "pickup")).toBe(0);
  });

  it("rejects marketplace offers even when they have a price", () => {
    const marketplace = item({
      product: {
        ...item().product!,
        price: 33.33,
        priceCents: 3333,
        priceProvenance: {
          ...item().product!.priceProvenance,
          sellerType: "marketplace",
        },
      },
    });
    expect(isBuildEligible(marketplace, "pickup")).toBe(false);
    expect(verifiedSubtotalCents([marketplace], "pickup")).toBe(0);
  });

  it("requires the exact numeric item ID in a canonical Walmart product URL", () => {
    expect(isValidWalmartProductUrl("https://www.walmart.com/ip/large-eggs/123456789", "123456789")).toBe(true);
    expect(isValidWalmartProductUrl("https://www.walmart.com/ip/large-eggs/999999999", "123456789")).toBe(false);
    expect(isValidWalmartProductUrl("https://www.walmart.com/search?q=eggs", "123456789")).toBe(false);
    expect(isValidWalmartProductUrl("https://user@www.walmart.com/ip/large-eggs/123456789", "123456789")).toBe(false);
  });

  it("rejects shipping-only offers for a pickup basket", () => {
    const shippingOnly = item({
      product: {
        ...item().product!,
        priceProvenance: {
          ...item().product!.priceProvenance!,
          fulfillment: ["shipping"],
        },
      },
    });
    expect(isBuildEligible(shippingOnly, "pickup")).toBe(false);
    expect(isBuildEligible(shippingOnly, "shipping")).toBe(false);
  });

  it("accepts a locally verified Walmart delivery offer for delivery", () => {
    const delivery = item({
      product: {
        ...item().product!,
        priceProvenance: {
          ...item().product!.priceProvenance!,
          fulfillment: ["delivery"],
          verifiedFulfillmentMode: "delivery",
        },
      },
    });
    expect(isBuildEligible(delivery, "delivery")).toBe(true);
    expect(isBuildEligible(delivery, "pickup")).toBe(false);
  });

  it("allows an identity-verified OpenWeb match with an honestly localized pickup price", () => {
    const localized = item({
      product: {
        ...item().product!,
        dataSource: "openwebninja",
        priceProvenance: {
          ...item().product!.priceProvenance!,
          priceScope: "localized",
          localPriceVerified: false,
          searchStoreId: undefined,
          detailStoreId: undefined,
        },
      },
    });

    expect(isBuildEligible(localized, "pickup", Date.now(), "3014")).toBe(true);
    expect(verifiedSubtotalCents([localized], "pickup", Date.now(), "3014")).toBe(248);
  });

  it("treats the replacement provider as localized without exposing provider branding", () => {
    const localized = item({
      product: {
        ...item().product!,
        dataSource: "scrapingbee",
        priceProvenance: {
          ...item().product!.priceProvenance!,
          priceScope: "localized",
          localPriceVerified: false,
          searchStoreId: undefined,
          detailStoreId: undefined,
        },
      },
    });

    expect(usesLocalizedWalmartPrice(localized.product)).toBe(true);
    expect(isBuildEligible(localized, "pickup", Date.now(), "3014")).toBe(true);
    expect(verifiedSubtotalCents([localized], "pickup", Date.now(), "3014")).toBe(248);
  });

  it("rejects delivery metadata when the selected price was not verified for delivery", () => {
    const deliveryOnlyMetadata = item({
      product: {
        ...item().product!,
        priceProvenance: {
          ...item().product!.priceProvenance!,
          fulfillment: ["delivery"],
          verifiedFulfillmentMode: "pickup",
        },
      },
    });
    expect(isBuildEligible(deliveryOnlyMetadata, "delivery")).toBe(false);
    expect(verifiedSubtotalCents([deliveryOnlyMetadata], "delivery")).toBe(0);
  });

  it("rejects conflicting or unexpected Walmart store provenance", () => {
    const mismatch = item({
      product: {
        ...item().product!,
        priceProvenance: {
          ...item().product!.priceProvenance!,
          requestedStoreId: "3014",
          searchStoreId: "9999",
        },
      },
    });
    expect(isBuildEligible(mismatch, "pickup")).toBe(false);
    expect(isBuildEligible(item(), "pickup", Date.now(), "9999")).toBe(false);
    expect(isBuildEligible(item(), "pickup", Date.now(), "3014")).toBe(true);
  });

  it("enforces named brands at the final cart boundary", () => {
    const takisRequest = item({
      request: { id: "takis", text: "Takis", normalizedText: "takis", quantity: 1, brand: "Takis" },
      product: { ...item().product!, title: "Great Value Rolled Tortilla Chips", brand: "Great Value" },
    });
    const validTakis = item({
      request: { id: "takis", text: "Takis", normalizedText: "takis", quantity: 1, brand: "Takis" },
      product: { ...item().product!, title: "Takis Fuego Rolled Tortilla Chips", brand: "Takis" },
    });
    const cokeSubstitution = item({
      request: { id: "coke", text: "Coke Zero", normalizedText: "coke zero", quantity: 1, brand: "Coca-Cola" },
      product: { ...item().product!, title: "Great Value Coke Zero", brand: "Great Value" },
    });
    const unlabeledCokeSubstitution = item({
      request: { id: "coke", text: "Coke Zero", normalizedText: "coke zero", quantity: 1, brand: "Coca-Cola" },
      product: { ...item().product!, title: "Great Value Coke Zero", brand: undefined },
    });
    const genericBread = item({
      request: { id: "bread", text: "bread", normalizedText: "bread", quantity: 1 },
      product: { ...item().product!, title: "Great Value White Sandwich Bread", brand: "Great Value" },
    });
    expect(isBuildEligible(takisRequest, "pickup")).toBe(false);
    expect(isBuildEligible(validTakis, "pickup")).toBe(true);
    expect(isBuildEligible(cokeSubstitution, "pickup")).toBe(false);
    expect(isBuildEligible(unlabeledCokeSubstitution, "pickup")).toBe(false);
    expect(isBuildEligible(genericBread, "pickup")).toBe(true);
  });

  it("fails closed when fulfillment mode is missing or unknown", () => {
    expect(isBuildEligible(item())).toBe(false);
    expect(isBuildEligible(item(), "unknown")).toBe(false);
  });

  it("rejects missing or stale price verification timestamps", () => {
    const now = Date.parse("2026-08-06T18:00:00.000Z");
    expect(isFreshVerification("2026-08-06T17:40:00.000Z", now)).toBe(true);
    expect(isFreshVerification("2026-08-06T17:29:59.000Z", now)).toBe(false);
    expect(isBuildEligible(item({ checkedAt: undefined }), "pickup", now)).toBe(false);
    expect(isBuildEligible(item({ checkedAt: "2026-08-06T17:20:00.000Z" }), "pickup", now)).toBe(false);
  });

  it("keeps Target matches out of Walmart eligibility while allowing canonical Target cart use", () => {
    const target = item({
      retailer: "target",
      product: {
        id: "92186007",
        productId: "92186007",
        retailer: "target",
        title: "Good & Gather Grade A Large Eggs - 12ct",
        brand: "Good & Gather",
        price: 2.99,
        priceCents: 299,
        link: "https://www.target.com/p/good-gather-eggs/-/A-92186007",
        linkType: "product",
        dataSource: "decodo",
        inStock: true,
        availabilityStatus: "in_stock",
        identityVerified: true,
        cartEligible: false,
        verification: "verified",
        checkedAt: new Date().toISOString(),
        priceLabel: "Localized price estimate",
        priceProvenance: {
          retailer: "target",
          priceSource: "target_search",
          priceScope: "localized",
          priceReliability: "localized_estimate",
          exactStoreVerified: false,
          sellerType: "unknown",
          fulfillment: ["delivery"],
          location: {
            requestedPostalCode: "79912",
            responseProvesLocation: false,
          },
        },
      },
    });

    expect(isValidTargetProductUrl(target.product!.link, "92186007")).toBe(true);
    expect(isReliableTargetMatch(target, "delivery")).toBe(true);
    expect(isTargetBuildEligible(target, "delivery")).toBe(true);
    expect(targetEstimateSubtotalCents([target], "delivery")).toBe(299);
    expect(isBuildEligible(target, "delivery")).toBe(false);
  });

  it("includes delivery comparisons with unknown availability, but keeps pickup strict", () => {
    const target = item({
      retailer: "target",
      product: {
        id: "92186007",
        productId: "92186007",
        retailer: "target",
        title: "Good & Gather Grade A Large Eggs - 12ct",
        price: 2.99,
        priceCents: 299,
        link: "https://www.target.com/p/good-gather-eggs/-/A-92186007",
        linkType: "product",
        dataSource: "parsebot",
        inStock: false,
        availabilityStatus: "unknown",
        identityVerified: true,
        cartEligible: false,
        verification: "verified",
        checkedAt: new Date().toISOString(),
        priceLabel: "Localized price estimate",
        priceProvenance: {
          retailer: "target",
          priceSource: "target_search",
          priceScope: "localized",
          priceReliability: "localized_estimate",
          exactStoreVerified: false,
          sellerType: "unknown",
          fulfillment: ["delivery", "pickup"],
          location: {
            requestedPostalCode: "79912",
            responseProvesLocation: false,
          },
        },
      },
    });

    expect(isReliableTargetMatch(target, "delivery")).toBe(true);
    expect(targetEstimateSubtotalCents([target], "delivery")).toBe(299);
    expect(isReliableTargetMatch(target, "pickup")).toBe(false);
    expect(isTargetBuildEligible(target, "pickup")).toBe(false);
    expect(isReliableTargetMatch({
      ...target,
      product: { ...target.product!, availabilityStatus: "out_of_stock" },
    }, "delivery")).toBe(false);
  });

  it("rejects Target marketplace offers and malformed product links", () => {
    const base = item({
      retailer: "target",
      product: {
        id: "92186007",
        productId: "92186007",
        retailer: "target",
        title: "Target product",
        price: 4.99,
        priceCents: 499,
        link: "https://www.target.com/p/item/-/A-92186007",
        linkType: "product",
        dataSource: "decodo",
        inStock: true,
        availabilityStatus: "in_stock",
        identityVerified: true,
        cartEligible: false,
        verification: "verified",
        checkedAt: new Date().toISOString(),
        priceProvenance: {
          retailer: "target",
          priceReliability: "localized_estimate",
          sellerType: "marketplace",
          fulfillment: ["shipping"],
        },
      },
    });
    expect(isReliableTargetMatch(base, "shipping")).toBe(false);
    expect(isReliableTargetMatch({
      ...base,
      product: { ...base.product!, link: "https://example.com/p/item/-/A-92186007" },
    }, "shipping")).toBe(false);
  });
});
