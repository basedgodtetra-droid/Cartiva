import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site";
import { extractMeasurement } from "@/lib/measurements";
import { rankProducts } from "@/lib/matching";
import type { WalmartProduct } from "@/lib/types";
import {
  packageConsistencyIssues,
  verifySelectedProduct,
} from "@/lib/verification";

function yogurt(): WalmartProduct {
  return {
    id: "yogurt",
    title: "FAGE Total Plain Greek Yogurt, 32 oz Tub",
    price: 6.18,
    link: "https://www.walmart.com/ip/fage-yogurt/123456789",
    linkType: "product",
    seller: "Walmart.com",
    brand: "FAGE",
    productType: "Greek yogurt",
    inStock: true,
    sponsored: false,
    size: extractMeasurement("FAGE Total Plain Greek Yogurt, 32 oz Tub"),
    verification: "unverified",
  };
}

function localCokeSearch(): WalmartProduct {
  return {
    id: "2BNVDJDOIX2I",
    productId: "2BNVDJDOIX2I",
    itemId: "13812835",
    title: "Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 24 Pack",
    price: 14.97,
    priceCents: 1497,
    priceProvenance: {
      priceSource: "local_store_search",
      searchPriceCents: 1497,
      unitPriceCents: 5,
      requestedStoreId: "2201",
      searchStoreId: "2201",
      searchStoreMatched: true,
      fulfillment: ["pickup"],
      sellerType: "walmart",
      localPriceEligible: true,
      localPriceVerified: false,
      checkedAt: new Date().toISOString(),
    },
    link: "https://www.walmart.com/ip/Coca-Cola-Zero-Sugar/13812835",
    linkType: "product",
    dataSource: "serpapi",
    seller: "Walmart.com",
    brand: "Coca-Cola",
    productType: "soda",
    inStock: true,
    sponsored: false,
    size: extractMeasurement("Coca-Cola Zero Sugar Soda Pop Cans, 12 fl oz, 24 Pack"),
    reportedUnitPrice: 0.052,
    reportedUnitBasis: "fl oz",
    verification: "unverified",
  };
}

function cokeDetail(options: Partial<WalmartProduct> = {}): WalmartProduct {
  const base = localCokeSearch();
  return {
    ...base,
    price: 33.33,
    priceCents: 3333,
    priceProvenance: {
      priceSource: "product_detail",
      productDetailPriceCents: 3333,
      requestedStoreId: "2201",
      detailStoreId: "2201",
      detailStoreMatched: true,
      fulfillment: ["in_store", "pickup", "shipping"],
      sellerType: "walmart",
      localPriceEligible: false,
      localPriceVerified: false,
      checkedAt: new Date().toISOString(),
    },
    checkedAt: new Date().toISOString(),
    reportedUnitPrice: 33.33 / 288,
    ...options,
  };
}

function localizedCokeSearch(): WalmartProduct {
  const search = localCokeSearch();
  return {
    ...search,
    dataSource: "openwebninja",
    priceProvenance: {
      ...search.priceProvenance!,
      priceScope: "localized",
      searchStoreId: undefined,
      searchStoreMatched: undefined,
    },
  };
}

function localizedCokeDetail(options: Partial<WalmartProduct> = {}): WalmartProduct {
  const detail = cokeDetail();
  return {
    ...detail,
    dataSource: "openwebninja",
    priceProvenance: {
      ...detail.priceProvenance!,
      detailStoreId: undefined,
      detailStoreMatched: undefined,
    },
    ...options,
  };
}

function localLiveProduct(
  title: string,
  options: Partial<WalmartProduct> = {},
): WalmartProduct {
  return {
    id: "live-product",
    productId: "LIVE-PRODUCT",
    itemId: "123456789",
    title,
    price: 2.78,
    priceCents: 278,
    priceProvenance: {
      priceSource: "local_store_search",
      searchPriceCents: 278,
      requestedStoreId: "2201",
      searchStoreId: "2201",
      searchStoreMatched: true,
      fulfillment: ["pickup"],
      sellerType: "walmart",
      localPriceEligible: true,
      localPriceVerified: false,
      checkedAt: new Date().toISOString(),
    },
    link: "https://www.walmart.com/ip/Pepsi-Cola/123456789",
    linkType: "product",
    dataSource: "serpapi",
    seller: "Walmart.com",
    brand: "Pepsi",
    productType: "soda",
    inStock: true,
    sponsored: false,
    size: extractMeasurement(title),
    verification: "unverified",
    ...options,
  };
}

function localLiveDetail(
  searchProduct: WalmartProduct,
  options: Partial<WalmartProduct> = {},
): WalmartProduct {
  return {
    ...searchProduct,
    priceProvenance: {
      priceSource: "product_detail",
      productDetailPriceCents: searchProduct.priceCents,
      requestedStoreId: "2201",
      detailStoreId: "2201",
      detailStoreMatched: true,
      fulfillment: ["pickup"],
      sellerType: "walmart",
      localPriceEligible: false,
      localPriceVerified: false,
      checkedAt: new Date().toISOString(),
    },
    checkedAt: new Date().toISOString(),
    ...options,
  };
}

describe("package and price verification", () => {
  it("flags pack-size and reported unit-price inconsistencies over 15%", () => {
    const issues = packageConsistencyIssues({
      id: "drink",
      title: "Gatorade Lemon Lime, 12 Pack, 12 fl oz Bottles",
      price: 8.78,
      link: "https://www.walmart.com/ip/drink",
      brand: "Gatorade",
      productType: "sports drink",
      seller: "Walmart.com",
      inStock: true,
      sponsored: false,
      size: extractMeasurement("Gatorade Lemon Lime, 12 Pack, 12 fl oz Bottles"),
      reportedUnitPrice: 0.12,
      reportedUnitBasis: "each",
    });
    expect(issues).toContain("reported unit price is inconsistent with the total price");
  });

  it.each([
    ["Great Value Everyday Disposable Foam Plates, 9 in, 50 ct", 2.58, 0.0516],
    ["Parent's Choice Fragrance Free Baby Wipes, Travel-Pack, 50 Count", 1.17, 0.0234],
  ])("accepts a consistent normalized per-count price for %s", (title, price, unitPrice) => {
    const issues = packageConsistencyIssues({
      id: "count-item",
      title,
      price,
      link: "https://www.walmart.com/search?q=count-item",
      seller: "Walmart.com",
      inStock: true,
      sponsored: false,
      size: extractMeasurement(title),
      reportedUnitPrice: unitPrice,
      reportedUnitBasis: "each",
    });

    expect(issues).toEqual([]);
  });

  it("marks a missing product-detail response for review", () => {
    const product = yogurt();
    const result = verifySelectedProduct("FAGE plain Greek yogurt 32 oz", rankProducts(
      "FAGE plain Greek yogurt 32 oz",
      [product],
    ), null);
    expect(result.status).toBe("review");
    expect(result.recommended?.verification).toBe("unverified");
  });

  it("rejects stale product-detail prices", () => {
    const product = yogurt();
    const now = new Date();
    const checkedAt = new Date(now.getTime() - siteConfig.detailCacheTtlMs - 1).toISOString();
    const result = verifySelectedProduct(
      "FAGE plain Greek yogurt 32 oz",
      rankProducts("FAGE plain Greek yogurt 32 oz", [product]),
      { ...product, checkedAt },
      now,
    );
    expect(result.status).toBe("review");
    expect(result.recommended?.verificationIssues).toContain("product-detail price is stale");
    expect(result.recommended?.linkType).toBe("search");
    expect(result.recommended?.link).toMatch(/^https:\/\/www\.walmart\.com\/search\?q=/);
  });

  it("accepts product details throughout the configured detail-cache lifetime", () => {
    const product = yogurt();
    const now = new Date();
    const checkedAt = new Date(now.getTime() - siteConfig.cacheTtlMs - 1).toISOString();
    const result = verifySelectedProduct(
      "FAGE plain Greek yogurt 32 oz",
      rankProducts("FAGE plain Greek yogurt 32 oz", [product]),
      { ...product, checkedAt },
      now,
    );

    expect(siteConfig.detailCacheTtlMs).toBeGreaterThan(siteConfig.cacheTtlMs);
    expect(result.status).toBe("matched");
    expect(result.recommended?.verificationIssues).toEqual([]);
  });

  it.each([
    ["asparagus", "Fresh Green Whole Asparagus Bunch, Fresh Produce", "1 bunch"],
    ["broccoli", "Fresh Whole Green Broccoli Crowns, 1 Each", "1 each"],
    ["tomatoes", "Fresh Roma Tomato, Each", "1 each"],
    ["cilantro", "Fresh Whole Green Cilantro Bunch, Fresh Produce", "1 bunch"],
  ])("verifies fresh produce sold as a retailer unit: %s", (request, title, sizeLabel) => {
    const product: WalmartProduct = {
      id: "fresh-produce",
      productId: "FRESH-PRODUCE",
      itemId: "123456789",
      title,
      price: 3.27,
      link: "https://www.walmart.com/ip/Fresh-Produce/123456789",
      linkType: "product",
      seller: "Walmart.com",
      productType: "Fresh Produce",
      inStock: true,
      sponsored: false,
      size: extractMeasurement(title),
      verification: "unverified",
    };

    const result = verifySelectedProduct(
      request,
      rankProducts(request, [product]),
      { ...product, checkedAt: new Date().toISOString() },
    );

    expect(result.status).toBe("matched");
    expect(result.recommended?.size?.label).toBe(sizeLabel);
    expect(result.recommended?.verificationIssues).toEqual([]);
  });

  it("rejects missing product-detail prices", () => {
    const product = yogurt();
    const result = verifySelectedProduct(
      "FAGE plain Greek yogurt 32 oz",
      rankProducts("FAGE plain Greek yogurt 32 oz", [product]),
      { ...product, price: Number.NaN, checkedAt: new Date().toISOString() },
    );
    expect(result.status).toBe("review");
    expect(result.recommended?.verificationIssues).toContain("current product-detail price is missing");
  });

  it("keeps the store-specific search price when product details return a higher online price", () => {
    const searchProduct = localCokeSearch();
    const result = verifySelectedProduct(
      "Coke Zero 24 pack",
      rankProducts("Coke Zero 24 pack", [searchProduct]),
      cokeDetail(),
    );

    expect(result.status).toBe("matched");
    expect(result.recommended?.price).toBe(14.97);
    expect(result.recommended?.priceCents).toBe(1497);
    expect(result.recommended?.priceProvenance?.productDetailPriceCents).toBe(3333);
    expect(result.recommended?.priceProvenance?.localPriceVerified).toBe(true);
    expect(result.explanation).toContain("Product details verified separately");
  });

  it("verifies a Decodo exact-store result only when search and detail both confirm the store", () => {
    const searchProduct = {
      ...localCokeSearch(),
      dataSource: "decodo" as const,
    };
    const detail = {
      ...cokeDetail(),
      dataSource: "decodo" as const,
    };
    const result = verifySelectedProduct(
      "Coke Zero 24 pack",
      rankProducts("Coke Zero 24 pack", [searchProduct]),
      detail,
    );

    expect(result.status).toBe("matched");
    expect(result.recommended?.price).toBe(14.97);
    expect(result.recommended?.priceProvenance?.localPriceVerified).toBe(true);
  });

  it("does not verify a Decodo exact-store price when product details report another store", () => {
    const searchProduct = {
      ...localCokeSearch(),
      dataSource: "decodo" as const,
    };
    const detail = {
      ...cokeDetail(),
      dataSource: "decodo" as const,
      priceProvenance: {
        ...cokeDetail().priceProvenance!,
        detailStoreId: "9999",
        detailStoreMatched: false,
      },
    };
    const result = verifySelectedProduct(
      "Coke Zero 24 pack",
      rankProducts("Coke Zero 24 pack", [searchProduct]),
      detail,
    );

    expect(result.status).toBe("review");
    expect(result.recommended?.priceProvenance?.localPriceVerified).toBe(false);
    expect(result.recommended?.verificationIssues).toContain(
      "product details did not confirm the selected store",
    );
  });

  it("keeps an eligible localized Decodo price labeled as an estimate", () => {
    const searchProduct = {
      ...localizedCokeSearch(),
      dataSource: "decodo" as const,
    };
    const detail = {
      ...localizedCokeDetail(),
      dataSource: "decodo" as const,
    };
    const result = verifySelectedProduct(
      "Coke Zero 24 pack",
      rankProducts("Coke Zero 24 pack", [searchProduct]),
      detail,
    );

    expect(result.status).toBe("matched");
    expect(result.confidence).toBe("medium");
    expect(result.recommended?.priceProvenance?.localPriceVerified).toBe(false);
    expect(result.assumptions).toContain(
      "Localized Walmart pickup/search price; exact-store checkout price may differ",
    );
  });

  it("requires product details before trusting a Decodo local price", () => {
    const searchProduct = {
      ...localCokeSearch(),
      dataSource: "decodo" as const,
    };
    const result = verifySelectedProduct(
      "Coke Zero 24 pack",
      rankProducts("Coke Zero 24 pack", [searchProduct]),
      null,
    );

    expect(result.status).toBe("review");
    expect(result.recommended?.verificationIssues).toContain(
      "current Walmart product details were unavailable",
    );
    expect(result.recommended?.verificationIssues).toContain(
      "local Walmart price needs confirmation",
    );
  });

  it("uses an eligible localized Walmart search price without claiming exact-store verification", () => {
    const searchProduct = localizedCokeSearch();
    const result = verifySelectedProduct(
      "Coke Zero 24 pack",
      rankProducts("Coke Zero 24 pack", [searchProduct]),
      localizedCokeDetail(),
    );

    expect(result.status).toBe("matched");
    expect(result.confidence).toBe("medium");
    expect(result.recommended?.price).toBe(14.97);
    expect(result.recommended?.priceProvenance).toMatchObject({
      priceScope: "localized",
      localPriceEligible: true,
      localPriceVerified: false,
      verifiedFulfillmentMode: "pickup",
    });
    expect(result.assumptions).toContain(
      "Localized Walmart pickup/search price; exact-store checkout price may differ",
    );
    expect(result.explanation).toContain("localized Walmart pickup/search price");
    expect(result.explanation).toContain("exact-store checkout price is not confirmed");
    expect(result.explanation).not.toContain("verified local Walmart store price");
    expect(result.recommended?.verificationIssues).toEqual([]);
  });

  it("keeps a localized shipping-only result out of matching", () => {
    const searchProduct = localizedCokeSearch();
    searchProduct.priceProvenance = {
      ...searchProduct.priceProvenance!,
      fulfillment: ["shipping"],
    };
    const result = verifySelectedProduct(
      "Coke Zero 24 pack",
      rankProducts("Coke Zero 24 pack", [searchProduct]),
      localizedCokeDetail({
        priceProvenance: {
          ...localizedCokeDetail().priceProvenance!,
          fulfillment: ["shipping"],
        },
      }),
    );

    expect(result.status).toBe("no_match");
    expect(result.recommended).toBeNull();
  });

  it("verifies an exact Pepsi 2-liter local product instead of treating liters as unknown", () => {
    const searchProduct = localLiveProduct("Pepsi Cola Soda Pop, 2 Liter Bottle", {
      brand: undefined,
    });
    const result = verifySelectedProduct(
      "Pepsi 2 liter",
      rankProducts("Pepsi 2 liter", [searchProduct]),
      localLiveDetail(searchProduct),
    );

    expect(result.status).toBe("matched");
    expect(result.assumptions).toEqual([]);
    expect(result.recommended?.size).toMatchObject({
      baseAmount: 67.628,
      baseUnit: "fl oz",
      label: "2 L",
    });
    expect(result.recommended?.verificationIssues).toEqual([]);
  });

  it("returns a safe best reasonable match when only an unrequested package measurement is absent", () => {
    const searchProduct = localLiveProduct("Pepsi Cola Soda Pop Bottle", {
      brand: undefined,
      size: undefined,
    });
    const result = verifySelectedProduct(
      "Pepsi",
      rankProducts("Pepsi", [searchProduct]),
      localLiveDetail(searchProduct, { size: undefined }),
    );

    expect(result.status).toBe("matched");
    expect(result.confidence).toBe("medium");
    expect(result.assumptions).toContain("Assumed a common package size");
    expect(result.explanation).toContain("best reasonable standard option");
    expect(result.recommended?.verification).toBe("verified");
    expect(result.recommended?.verificationIssues).toEqual([]);
  });

  it("does not soften a missing package measurement when the shopper requested an exact size", () => {
    const searchProduct = localLiveProduct("Pepsi Cola Soda Pop, 2 Liter Bottle");
    const result = verifySelectedProduct(
      "Pepsi 2 liter",
      rankProducts("Pepsi 2 liter", [searchProduct]),
      localLiveDetail(searchProduct, {
        title: "Pepsi Cola Soda Pop Bottle",
        size: undefined,
      }),
    );

    expect(result.status).toBe("review");
    expect(result.recommended?.verificationIssues).toContain("package size could not be verified");
  });

  it("marks a store price for confirmation when pickup or in-store fulfillment is not verified", () => {
    const searchProduct = {
      ...localCokeSearch(),
      priceProvenance: {
        ...localCokeSearch().priceProvenance!,
        fulfillment: [],
      },
    };
    const detail = cokeDetail({
      priceProvenance: {
        ...cokeDetail().priceProvenance!,
        fulfillment: ["shipping"],
      },
    });
    const result = verifySelectedProduct(
      "Coke Zero 24 pack",
      rankProducts("Coke Zero 24 pack", [searchProduct]),
      detail,
    );

    expect(result.status).toBe("review");
    expect(result.recommended?.verificationIssues).toContain("the offer is shipping-only");
    expect(result.recommended?.verificationIssues).toContain("local Walmart price needs confirmation");
  });

  it("does not treat product-detail delivery metadata as proof of a delivery search price", () => {
    const searchProduct = localCokeSearch();
    const detail = cokeDetail({
      priceProvenance: {
        ...cokeDetail().priceProvenance!,
        fulfillment: ["delivery"],
      },
    });
    const result = verifySelectedProduct(
      "Coke Zero 24 pack",
      rankProducts("Coke Zero 24 pack", [searchProduct]),
      detail,
      undefined,
      [],
      "delivery",
    );

    expect(result.status).toBe("review");
    expect(result.recommended?.priceProvenance?.localPriceVerified).toBe(false);
    expect(result.recommended?.verificationIssues).toContain(
      "delivery availability was not attached to the selected search price",
    );
  });

  it("records the exact fulfillment mode verified on the selected search offer", () => {
    const searchProduct = {
      ...localCokeSearch(),
      priceProvenance: {
        ...localCokeSearch().priceProvenance!,
        fulfillment: ["delivery" as const],
      },
    };
    const result = verifySelectedProduct(
      "Coke Zero 24 pack",
      rankProducts("Coke Zero 24 pack", [searchProduct]),
      cokeDetail({
        priceProvenance: {
          ...cokeDetail().priceProvenance!,
          fulfillment: ["delivery"],
        },
      }),
      undefined,
      [],
      "delivery",
    );

    expect(result.status).toBe("matched");
    expect(result.recommended?.priceProvenance?.verifiedFulfillmentMode).toBe("delivery");
  });
});
