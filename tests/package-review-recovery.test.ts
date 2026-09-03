import { describe, expect, it } from "vitest";

import { buildKrogerCartLines } from "@/lib/cartiva-kroger-cart";
import { interpretGroceryInput } from "@/lib/grocery-notepad";
import { rankKrogerProducts } from "@/lib/kroger-products";
import { extractMeasurement } from "@/lib/measurements";
import {
  packageFulfillmentForProduct,
  packageReviewForProduct,
} from "@/lib/package-fulfillment";
import { parseProductIntent } from "@/lib/product-search-intent";
import type { KrogerProduct, Measurement } from "@/lib/types";
import { isRetailerHandoffAcceptedMatch } from "@/packages/shared/src";

function size(amount: number, kind: "weight" | "volume" = "weight"): Measurement {
  return {
    amount,
    unit: kind === "weight" ? "oz" : "fl oz",
    kind,
    baseAmount: amount,
    baseUnit: kind === "weight" ? "oz" : "fl oz",
    label: `${amount} ${kind === "weight" ? "oz" : "fl oz"}`,
  };
}

function product(overrides: Partial<KrogerProduct>): KrogerProduct {
  const checkedAt = "2026-09-02T20:00:00.000Z";
  return {
    retailer: "kroger",
    id: "review-product",
    productId: "review-product",
    upc: "0001111099999",
    title: "Kroger Product",
    price: 3.99,
    priceCents: 399,
    link: "https://www.kroger.com/p/review-product",
    sourceUrl: "https://www.kroger.com/p/review-product",
    inStock: true,
    availabilityStatus: "in_stock",
    sponsored: false,
    checkedAt,
    verification: "verified",
    cartEligible: true,
    dataSource: "kroger_public_api",
    identityVerified: true,
    priceProvenance: {
      retailer: "kroger",
      priceSource: "kroger_location_product",
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified: true,
      locationId: "03500529",
      location: {
        requestedStoreId: "03500529",
        observedStoreId: "03500529",
        responseProvesLocation: true,
        storeMatched: true,
      },
      fulfillment: ["pickup"],
      checkedAt,
    },
    ...overrides,
  };
}

describe("safe package review recovery", () => {
  it("preserves a Unicode multiplication sign as strict multipack intent", () => {
    const item = interpretGroceryInput("rice 2 × 500 g").items[0];
    const oneBag = product({
      id: "rice-500",
      productId: "rice-500",
      upc: "0001111050001",
      title: "Long Grain Rice 500 g Bag",
      productType: "Rice",
      size: extractMeasurement("Long Grain Rice 500 g Bag"),
    });
    const twoPack = product({
      id: "rice-2x500",
      productId: "rice-2x500",
      upc: "0001111050002",
      title: "Long Grain Rice 2 × 500 g Bags",
      productType: "Rice",
      size: extractMeasurement("Long Grain Rice 2 × 500 g Bags"),
    });

    expect(item.canonicalText).toBe("Rice, 2 × 500 g");
    expect(rankKrogerProducts(item.canonicalText, [oneBag])).toMatchObject({
      status: "no_match",
      recommended: null,
    });
    expect(rankKrogerProducts(item.canonicalText, [oneBag, twoPack])).toMatchObject({
      status: "matched",
      recommended: { id: "rice-2x500" },
      fulfillment: { cartQuantity: 1, packageCount: 1 },
    });
  });

  it.each([
    "Long Grain Rice 500 g x 2",
    "Long Grain Rice 500 g × 2",
    "Long Grain Rice 500 g Pack of 2",
  ])("uses one verified reverse-notation multipack for %s", (title) => {
    const rice = product({
      id: "rice-reverse-2x500",
      productId: "rice-reverse-2x500",
      title,
      productType: "Rice",
      size: extractMeasurement(title),
    });
    const result = rankKrogerProducts("rice 1 kg total", [rice]);

    expect(result).toMatchObject({
      status: "matched",
      fulfillment: {
        cartQuantity: 1,
        packageCount: 1,
        requestedBaseAmount: 35.274,
        suppliedBaseAmount: 35.274,
        approvalRequired: false,
      },
    });
    expect(isRetailerHandoffAcceptedMatch(result)).toBe(true);
  });

  it("hands one verified count multipack to the cart for an explicit item total", () => {
    const interpreted = interpretGroceryInput("cleaning wipes 225 wipes total");
    const item = interpreted.items[0];
    const wipes = product({
      id: "wipes-225",
      productId: "wipes-225",
      upc: "0001111022525",
      title: "Cleaning Wipes 3 Pack 75 Wipes Each",
      productType: "Cleaning Wipes",
      size: extractMeasurement("Cleaning Wipes 3 Pack 75 Wipes Each"),
    });
    const result = rankKrogerProducts(item.canonicalText, [wipes]);

    expect(result).toMatchObject({
      status: "matched",
      recommended: { id: "wipes-225" },
      fulfillment: {
        cartQuantity: 1,
        packageCount: 1,
        requestedBaseAmount: 225,
        suppliedBaseAmount: 225,
      },
    });
    expect(buildKrogerCartLines(
      interpreted.items,
      [result],
      { [item.id]: 1 },
    )).toEqual([{ upc: "0001111022525", quantity: 1 }]);
  });

  it("fulfills a multiplied total as one aggregate instead of rounding each copy", () => {
    const item = interpretGroceryInput("two dozen eggs total").items[0];
    const eggs = product({
      id: "eggs-8",
      productId: "eggs-8",
      title: "Kroger Large Eggs 8 Count",
      productType: "Eggs",
      size: extractMeasurement("Kroger Large Eggs 8 Count"),
    });
    const result = rankKrogerProducts(item.canonicalText, [eggs]);

    expect(item.canonicalText).toBe("Eggs, 12 ct total x2");
    expect(result).toMatchObject({
      status: "matched",
      fulfillment: {
        cartQuantity: 3,
        packageCount: 3,
        requestedBaseAmount: 24,
        suppliedBaseAmount: 24,
        approvalRequired: false,
      },
    });
    expect(isRetailerHandoffAcceptedMatch(result)).toBe(true);
  });

  it.each([
    ["hummus 4 tubs total", "Classic Hummus Snack Tubs 4 Count", "Hummus"],
    ["water 24 bottles total", "Kroger Purified Water 24 Count Bottles", "Water"],
    ["cat food 12 pouches total", "Purina Cat Food 12 Count Pouches", "Cat Food"],
  ])("adds one verified multipack for an aggregate container total: %s", (
    request,
    title,
    productType,
  ) => {
    const candidate = product({
      id: `aggregate-${productType}`,
      productId: `aggregate-${productType}`,
      title,
      productType,
      size: extractMeasurement(title),
    });
    const result = rankKrogerProducts(request, [candidate]);

    expect(result).toMatchObject({
      status: "matched",
      fulfillment: {
        cartQuantity: 1,
        packageCount: 1,
        approvalRequired: false,
      },
    });
    expect(isRetailerHandoffAcceptedMatch(result)).toBe(true);
  });

  it("calculates an excessive same-unit option without approving it", () => {
    const intent = parseProductIntent("Extra firm tofu 8 oz total");
    const candidate = { price: 3.49, title: "Extra Firm Tofu 14 oz", size: size(14) };

    expect(packageFulfillmentForProduct(intent, candidate)).toBeNull();
    expect(packageReviewForProduct(intent, candidate)).toMatchObject({
      kind: "single_package",
      cartQuantity: 1,
      packageCount: 1,
      requestedBaseAmount: 8,
      suppliedBaseAmount: 14,
      overageBaseAmount: 6,
      overagePercent: 75,
      approvalRequired: true,
    });
  });

  it("never invents a weight-to-volume conversion for a review", () => {
    expect(packageReviewForProduct(
      parseProductIntent("Peanut butter 16 fl oz total"),
      { price: 1.99, title: "Creamy Peanut Butter 4 oz Jar", size: size(4) },
    )).toBeNull();
  });

  it("leaves an within-cap package plan automatically approved", () => {
    const intent = parseProductIntent("Shredded cheddar cheese 12 oz total");
    const candidate = { price: 2.99, title: "Shredded Cheddar Cheese 8 oz Bag", size: size(8) };

    expect(packageFulfillmentForProduct(intent, candidate)).toMatchObject({
      cartQuantity: 2,
      suppliedBaseAmount: 16,
      approvalRequired: false,
    });
    expect(packageReviewForProduct(intent, candidate)).toBeNull();
  });

  it("returns excessive overage as an editable review, never an automatic match", () => {
    const tofu = product({
      id: "tofu-14",
      productId: "tofu-14",
      title: "Simple Truth Organic Extra Firm Tofu 14 oz",
      productType: "Tofu",
      size: size(14),
    });

    expect(rankKrogerProducts("Extra firm tofu 8 oz total", [tofu])).toMatchObject({
      status: "review",
      resolution: "needs_choice",
      recommended: { id: "tofu-14" },
      fulfillment: {
        requestedBaseAmount: 8,
        suppliedBaseAmount: 14,
        overagePercent: 75,
        approvalRequired: true,
      },
    });
  });

  it("retains a dimension-mismatched identity only as a no-conversion review", () => {
    const peanutButter = product({
      id: "peanut-butter-4",
      productId: "peanut-butter-4",
      title: "Kroger Creamy Peanut Butter 4 oz Jar",
      productType: "Peanut Butter",
      size: size(4),
    });
    const result = rankKrogerProducts("Peanut butter 16 fl oz total", [peanutButter]);

    expect(result).toMatchObject({
      status: "review",
      resolution: "needs_choice",
      recommended: { id: "peanut-butter-4" },
    });
    expect(result.fulfillment).toBeUndefined();
    expect(result.explanation).toMatch(/will not guess a weight-to-volume conversion/i);
  });

  it("does not promote strict-size or wrong-container candidates into review", () => {
    const undersizedTofu = product({
      id: "tofu-14",
      productId: "tofu-14",
      title: "Simple Truth Organic Extra Firm Tofu 14 oz",
      productType: "Tofu",
      size: size(14),
    });
    const tunaPouch = product({
      id: "tuna-pouch",
      productId: "tuna-pouch",
      title: "Chicken of the Sea Canned Tuna 5 oz Pouch",
      productType: "Canned Seafood",
      size: size(5),
    });

    expect(rankKrogerProducts("Extra firm tofu 16 oz", [undersizedTofu])).toMatchObject({
      status: "no_match",
      recommended: null,
    });
    expect(rankKrogerProducts("Canned tuna 5 oz can total", [tunaPouch])).toMatchObject({
      status: "no_match",
      recommended: null,
    });
  });

  it("never turns nutrition grams or the Total cereal name into automatic fulfillment", () => {
    const protein = product({
      id: "protein-no-size",
      productId: "protein-no-size",
      title: "Whey Protein Powder 25 g per Serving",
      productType: "Protein Powder",
      size: extractMeasurement("Whey Protein Powder 25 g per Serving"),
      price: 29.99,
    });
    const cheerios = product({
      id: "cheerios-12",
      productId: "cheerios-12",
      title: "General Mills Cheerios Original Cereal 12 oz",
      productType: "Cereal",
      size: size(12),
    });
    const bcaa = product({
      id: "bcaa-no-size",
      productId: "bcaa-no-size",
      title: "BCAA Powder 5 g BCAAs",
      productType: "BCAA Powder",
      size: extractMeasurement("BCAA Powder 5 g BCAAs"),
      price: 24.99,
    });

    const proteinResult = rankKrogerProducts("Whey protein powder 2 lb total", [protein]);
    expect(proteinResult.status).not.toBe("matched");
    expect(proteinResult.fulfillment).toBeUndefined();
    expect(isRetailerHandoffAcceptedMatch(proteinResult)).toBe(false);

    const bcaaResult = rankKrogerProducts("BCAA powder 100 g total", [bcaa]);
    expect(bcaaResult.status).not.toBe("matched");
    expect(bcaaResult.fulfillment).toBeUndefined();
    expect(isRetailerHandoffAcceptedMatch(bcaaResult)).toBe(false);

    const cerealResult = rankKrogerProducts("Total cereal 18 oz", [cheerios]);
    expect(cerealResult.status).not.toBe("matched");
    expect(isRetailerHandoffAcceptedMatch(cerealResult)).toBe(false);
  });
});
