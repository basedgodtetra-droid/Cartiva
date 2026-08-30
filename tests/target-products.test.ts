import { describe, expect, it } from "vitest";
import {
  normalizeTargetProviderProduct,
  rankTargetProducts,
  targetCandidateReliabilityIssues,
} from "@/lib/target-products";
import { verifyTargetSelectedProduct } from "@/lib/target-verification";
import { verifySelectedProduct } from "@/lib/verification";
import type { MatchResult, TargetProduct, WalmartProduct } from "@/lib/types";

const checkedAt = "2026-08-10T18:00:00.000Z";
const now = new Date("2026-08-10T18:01:00.000Z");

function providerProduct(options: Record<string, unknown> = {}) {
  return {
    tcin: "92186007",
    title: "Grade A Large Eggs - 12ct - Good & Gather",
    url: "https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-92186007",
    price: 3.49,
    brand: "Good & Gather",
    checkedAt,
    ...options,
  };
}

function normalized(
  source: "search" | "product",
  raw: Record<string, unknown> = providerProduct(),
  fulfillmentMode: "pickup" | "delivery" | "shipping" = "pickup",
) {
  return normalizeTargetProviderProduct(raw, {
    source,
    fulfillmentMode,
    requestedStoreId: "1234",
    requestedPostalCode: "79912",
    checkedAt,
  })!;
}

describe("Target product trust", () => {
  it("does not turn an echoed requested store into exact-store evidence", () => {
    const product = normalized("search", providerProduct({
      provenance: {
        requestedStoreId: "1234",
        requestedZip: "79912",
        locationVerified: true,
      },
    }));

    expect(product.priceProvenance).toMatchObject({
      retailer: "target",
      priceScope: "localized",
      priceReliability: "localized_estimate",
      exactStoreVerified: false,
      location: {
        requestedStoreId: "1234",
        observedStoreId: undefined,
        responseProvesLocation: false,
      },
    });
    expect(product.priceLabel).toBe("Localized price estimate");
  });

  it("requires response-body location evidence plus the matching requested store", () => {
    const exact = normalized("search", providerProduct({
      provenance: {
        requestedStoreId: "1234",
        observedStoreId: "1234",
        locationVerified: true,
      },
    }));
    expect(exact.priceProvenance).toMatchObject({
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified: true,
    });
    expect(exact.priceLabel).toBe("Verified exact-store price");

    const mismatch = normalized("search", providerProduct({
      provenance: {
        observedStoreId: "9999",
        locationVerified: true,
      },
    }));
    expect(mismatch.priceProvenance.priceReliability).toBe("unreliable");
    expect(targetCandidateReliabilityIssues(mismatch)).toContain(
      "response store does not match the requested Target store",
    );
    expect(rankTargetProducts("eggs", [mismatch]).recommended).toBeNull();
  });

  it("ignores Walmart-shaped store claims and keeps the price localized", () => {
    const product = normalized("search", providerProduct({
      searchStoreId: "1234",
      searchStoreMatched: true,
      sellerType: "walmart",
    }));
    expect(product.priceProvenance.retailer).toBe("target");
    expect(product.priceProvenance.exactStoreVerified).toBe(false);
    expect(product.priceProvenance.priceScope).toBe("localized");
    expect(product.priceProvenance.sellerType).toBe("unknown");
  });

  it("rejects a provider request context that differs from the route context", () => {
    const product = normalized("search", providerProduct({
      provenance: {
        requestedStoreId: "9999",
        requestedZip: "00000",
        locationVerified: false,
      },
    }));
    expect(product.priceProvenance.location).toMatchObject({
      requestedStoreId: "1234",
      requestedPostalCode: "79912",
    });
    expect(product.priceProvenance.priceReliability).toBe("unreliable");
    expect(rankTargetProducts("eggs", [product]).recommended).toBeNull();
  });

  it("excludes malformed Target URLs and third-party sellers before ranking", () => {
    const wrongUrl = normalized("search", providerProduct({
      url: "https://www.walmart.com/ip/Eggs/92186007",
    }));
    const marketplace = normalized("search", providerProduct({ seller: "Some Target Plus Seller" }));
    expect(wrongUrl.identityVerified).toBe(false);
    expect(marketplace.priceProvenance.sellerType).toBe("marketplace");
    expect(rankTargetProducts("eggs", [wrongUrl, marketplace]).recommended).toBeNull();
  });
});

describe("Target verification", () => {
  it("keeps a fast search-only delivery comparison when availability is unknown", () => {
    const search = normalized("search", providerProduct(), "delivery");
    const result = verifyTargetSelectedProduct(
      "eggs",
      rankTargetProducts("eggs", [search]),
      search,
      { fulfillmentMode: "delivery", requestedPostalCode: "79912" },
      now,
    );

    expect(result).toMatchObject({
      status: "matched",
      confidence: "medium",
      recommended: {
        productId: "92186007",
        availabilityStatus: "unknown",
        inStock: false,
        cartEligible: false,
        verification: "verified",
        priceLabel: "Localized price estimate",
        verificationIssues: ["Target delivery availability was not confirmed"],
        priceProvenance: {
          priceSource: "target_search",
          priceScope: "localized",
          priceReliability: "localized_estimate",
          exactStoreVerified: false,
          productDetailPriceCents: undefined,
        },
      },
    });
    expect(result.explanation).toContain("did not confirm delivery availability");
    expect(result.explanation).toContain("check Target before buying");
  });

  it("still excludes an explicitly out-of-stock delivery product", () => {
    const search = normalized("search", providerProduct(), "delivery");
    const detail = normalized(
      "search",
      providerProduct({ inStock: false, availabilityStatus: "out_of_stock" }),
      "delivery",
    );
    const result = verifyTargetSelectedProduct(
      "eggs",
      rankTargetProducts("eggs", [search]),
      detail,
      { fulfillmentMode: "delivery", requestedPostalCode: "79912" },
      now,
    );

    expect(result.status).not.toBe("matched");
    expect(result.recommended).toBeNull();
  });

  it("keeps a valid Search candidate as an unverified comparison estimate when details are unavailable", () => {
    const search = normalized("search", providerProduct({
      inStock: true,
      provenance: {
        requestedStoreId: "1234",
        observedStoreId: "1234",
        locationVerified: true,
      },
    }));
    const result = verifyTargetSelectedProduct(
      "eggs",
      rankTargetProducts("eggs", [search]),
      null,
      {
        fulfillmentMode: "pickup",
        requestedStoreId: "1234",
        requestedPostalCode: "79912",
      },
      now,
    );

    expect(result).toMatchObject({
      status: "review",
      confidence: "low",
      verifiedAt: undefined,
      recommended: {
        productId: "92186007",
        cartEligible: false,
        availabilityStatus: "unknown",
        inStock: false,
        priceLabel: "Localized price estimate",
        verification: "unverified",
        verificationIssues: ["selected-store Target inventory was unavailable"],
        priceProvenance: {
          priceScope: "localized",
          priceReliability: "localized_estimate",
          exactStoreVerified: false,
          productDetailPriceCents: undefined,
        },
      },
    });
    expect(result.explanation).toContain("selected store's inventory check was unavailable");
    expect(result.explanation).toContain("comparison estimate");
  });

  it("keeps an unproven store price labeled as a localized estimate", () => {
    const search = normalized("search", providerProduct({
      provenance: { requestedStoreId: "1234", locationVerified: false },
    }));
    const detail = normalized("product", providerProduct({
      inStock: true,
      provenance: { requestedStoreId: "1234", locationVerified: false },
    }));
    const result = verifyTargetSelectedProduct(
      "eggs",
      rankTargetProducts("eggs", [search]),
      detail,
      {
        fulfillmentMode: "pickup",
        requestedStoreId: "1234",
        requestedPostalCode: "79912",
      },
      now,
    );

    expect(result).toMatchObject({
      retailer: "target",
      status: "matched",
      confidence: "medium",
      recommended: {
        retailer: "target",
        price: 3.49,
        priceLabel: "Localized price estimate",
        cartEligible: false,
        priceProvenance: {
          exactStoreVerified: false,
          priceReliability: "localized_estimate",
        },
      },
    });
    expect(result.explanation).toContain("did not prove the requested store");
  });

  it("uses the exact-store label only when Search proves the requested store", () => {
    const provenance = {
      requestedStoreId: "1234",
      observedStoreId: "1234",
      locationVerified: true,
    };
    const search = normalized("search", providerProduct({ provenance }));
    const detail = normalized("product", providerProduct({ inStock: true, provenance }));
    const result = verifyTargetSelectedProduct(
      "eggs",
      rankTargetProducts("eggs", [search]),
      detail,
      { fulfillmentMode: "pickup", requestedStoreId: "1234" },
      now,
    );

    expect(result.status).toBe("matched");
    expect(result.confidence).toBe("high");
    expect(result.recommended?.priceLabel).toBe("Verified exact-store price");
    expect(result.recommended?.priceProvenance.exactStoreVerified).toBe(true);
  });

  it("excludes cross-retailer, wrong-identity, and unknown-stock details", () => {
    const search = normalized("search");
    const preliminary = rankTargetProducts("eggs", [search]);
    const validDetail = normalized("product", providerProduct({ inStock: true }));
    const walmartDetail = {
      ...validDetail,
      retailer: "walmart",
    } as unknown as TargetProduct;
    const wrongIdentity = normalized("product", providerProduct({
      tcin: "11111111",
      url: "https://www.target.com/p/-/A-11111111",
      inStock: true,
    }));
    const unknownStock = normalized("product");
    const context = { fulfillmentMode: "pickup" as const, requestedStoreId: "1234" };

    for (const detail of [walmartDetail, wrongIdentity, unknownStock]) {
      const result = verifyTargetSelectedProduct("eggs", preliminary, detail, context, now);
      expect(result.recommended).toBeNull();
      expect(result.status).not.toBe("matched");
    }
  });

  it("cannot be verified by the Walmart verifier even through an unsafe cast", () => {
    const search = normalized("search");
    const detail = normalized("product", providerProduct({ inStock: true }));
    const targetPreliminary = rankTargetProducts("eggs", [search]);
    const result = verifySelectedProduct(
      "eggs",
      targetPreliminary as unknown as MatchResult,
      detail as unknown as WalmartProduct,
      now,
    );
    expect(result.status).not.toBe("matched");
    expect(result.recommended?.verificationIssues).toContain(
      "the Walmart product page is unavailable",
    );
  });
});
