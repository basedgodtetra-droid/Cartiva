import { describe, expect, it } from "vitest";
import {
  comparisonContextSignature,
  comparisonListSignature,
  emptyComparisonSearchState,
  evaluateComparison,
} from "../src/comparison";
import type { ComparisonRetailerContext } from "../src/comparison";
import type {
  ComparisonSearchState,
  ExtensionProduct,
  ParsedListItem,
  PreparedItem,
  ProductMeasurement,
  Retailer,
} from "../src/types";

const now = Date.parse("2026-08-14T20:00:00.000Z");
const checkedAt = "2026-08-14T19:55:00.000Z";
const contexts: Record<Retailer, ComparisonRetailerContext> = {
  walmart: { fulfillmentMode: "pickup", storeId: "3014", zip: "79912" },
  target: { fulfillmentMode: "pickup", storeId: "1234", zip: "79912" },
  kroger: { fulfillmentMode: "pickup", storeId: "70500576", zip: "79912" },
};
const request: ParsedListItem = {
  id: "eggs",
  text: "eggs",
  normalizedText: "eggs",
  quantity: 1,
};

function measurement(count: number): ProductMeasurement {
  return {
    amount: count,
    unit: "count",
    kind: "count",
    baseAmount: count,
    baseUnit: "each",
    label: `${count} count`,
  };
}

function weightMeasurement(
  totalOunces: number,
  packCount?: number,
  perPackageAmount?: number,
): ProductMeasurement {
  return {
    amount: totalOunces,
    unit: "oz",
    kind: "weight",
    baseAmount: totalOunces,
    baseUnit: "oz",
    packCount,
    perPackageAmount,
    label: packCount && perPackageAmount
      ? `${packCount} pack, ${perPackageAmount} oz each`
      : `${totalOunces} oz`,
  };
}

function copyContexts(): Record<Retailer, ComparisonRetailerContext> {
  return {
    walmart: { ...contexts.walmart },
    target: { ...contexts.target },
    kroger: { ...contexts.kroger },
  };
}

function product(retailer: Retailer, cents: number, size = measurement(12)): ExtensionProduct {
  if (retailer === "target") {
    return {
      retailer,
      id: "92186007",
      productId: "92186007",
      title: "Grade A Large Eggs, 12ct",
      price: cents / 100,
      priceCents: cents,
      link: "https://www.target.com/p/eggs/-/A-92186007",
      linkType: "product",
      inStock: true,
      availabilityStatus: "in_stock",
      identityVerified: true,
      verification: "verified",
      checkedAt,
      size,
      priceProvenance: {
        retailer,
        fulfillment: ["pickup"],
        sellerType: "target",
        priceScope: "localized",
        priceReliability: "localized_estimate",
        exactStoreVerified: false,
      },
    };
  }
  if (retailer === "kroger") {
    return {
      retailer,
      id: "0001111041700",
      upc: "0001111041700",
      title: "Kroger Large Eggs, 12 Count",
      price: cents / 100,
      priceCents: cents,
      link: "https://www.kroger.com/p/large-eggs/0001111041700",
      linkType: "product",
      inStock: true,
      availabilityStatus: "in_stock",
      identityVerified: true,
      cartEligible: true,
      verification: "verified",
      checkedAt,
      size,
      priceProvenance: {
        retailer,
        fulfillment: ["pickup"],
        sellerType: "kroger",
        priceScope: "exact_store",
        priceReliability: "verified",
        exactStoreVerified: true,
        location: {
          requestedStoreId: "70500576",
          observedStoreId: "70500576",
          responseProvesLocation: true,
          storeMatched: true,
        },
      },
    };
  }
  return {
    retailer,
    id: "123456789",
    itemId: "123456789",
    title: "Large White Eggs, 12 Count",
    price: cents / 100,
    priceCents: cents,
    link: "https://www.walmart.com/ip/eggs/123456789",
    linkType: "product",
    inStock: true,
    verification: "verified",
    checkedAt,
    size,
    priceProvenance: {
      retailer,
      fulfillment: ["pickup"],
      sellerType: "walmart",
      verifiedFulfillmentMode: "pickup",
      localPriceEligible: true,
      localPriceVerified: true,
      priceScope: "exact_store",
      requestedStoreId: "3014",
      searchStoreId: "3014",
      detailStoreId: "3014",
      searchStoreMatched: true,
      detailStoreMatched: true,
    },
  };
}

function prepared(retailer: Retailer, cents: number, size = measurement(12)): PreparedItem {
  return {
    id: request.id,
    request,
    retailer,
    matchStatus: "matched",
    alternatives: [],
    dataMode: "live",
    checkedAt,
    cartStatus: "ready",
    product: product(retailer, cents, size),
  };
}

function comparison(
  states: Partial<Record<Retailer, {
    status: "searching" | "complete" | "error";
    items: PreparedItem[];
    error?: string;
  }>>,
  requests: ParsedListItem[] = [request],
  stateContexts: Record<Retailer, ComparisonRetailerContext> = contexts,
): ComparisonSearchState {
  const result = emptyComparisonSearchState(
    comparisonListSignature(requests),
    stateContexts,
    requests.length,
  );
  for (const retailer of ["walmart", "target", "kroger"] as const) {
    const update = states[retailer];
    result.retailers[retailer] = {
      ...result.retailers[retailer],
      status: update?.status ?? "complete",
      items: update?.items ?? [],
      error: update?.error,
    };
  }
  result.status = Object.values(result.retailers).every((entry) => entry.status !== "searching")
    ? "complete"
    : "searching";
  return result;
}

describe("safe multi-retailer comparison", () => {
  it("never lets a cheap preliminary searching result win", () => {
    const state = comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      target: { status: "searching", items: [prepared("target", 99)] },
      kroger: { status: "complete", items: [prepared("kroger", 349)] },
    });
    const result = evaluateComparison(state, [request], contexts, now);
    expect(result.status).toBe("waiting");
    expect(result.baskets.target.totalCents).toBe(99);
    expect(result.lowestComparableRetailer).toBeUndefined();
  });

  it("allows two configured retailers to finish when an unconfigured retailer is terminal", () => {
    const availableContexts = copyContexts();
    availableContexts.target = { fulfillmentMode: "pickup" };
    const state = comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      target: { status: "error", items: [], error: "Choose a Target store." },
      kroger: { status: "complete", items: [prepared("kroger", 349)] },
    }, [request], availableContexts);
    const result = evaluateComparison(state, [request], availableContexts, now);
    expect(result.status).toBe("ready");
    expect(result.completeBasketCount).toBe(2);
    expect(result.comparableBasketCount).toBe(2);
    expect(result.baskets.target.reason).toBe("Choose a Target store.");
    expect(result.lowestComparableRetailer).toBe("walmart");
  });

  it("fails closed when a requested quantity changes after the run", () => {
    const state = comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      kroger: { status: "complete", items: [prepared("kroger", 349)] },
    });
    const changedRequest = { ...request, quantity: 2 };
    const result = evaluateComparison(state, [changedRequest], contexts, now);
    expect(result.status).toBe("no_comparable_basket");
    expect(result.lowestComparableRetailer).toBeUndefined();
    expect(Object.values(result.baskets).every((basket) => !basket.comparable)).toBe(true);
    expect(result.baskets.walmart.reason).toMatch(/list or store setup changed/i);
  });

  it("fails closed when the persisted requested count is stale", () => {
    const state = comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      kroger: { status: "complete", items: [prepared("kroger", 349)] },
    });
    state.requestedCount = 2;
    const result = evaluateComparison(state, [request], contexts, now);
    expect(result.completeBasketCount).toBe(0);
    expect(result.comparableBasketCount).toBe(0);
    expect(result.lowestComparableRetailer).toBeUndefined();
  });

  it("fails closed when a store changes after the run", () => {
    const state = comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      kroger: { status: "complete", items: [prepared("kroger", 349)] },
    });
    const changedContexts = copyContexts();
    changedContexts.walmart.storeId = "3015";
    expect(comparisonContextSignature(changedContexts)).not.toBe(state.contextSignature);
    const result = evaluateComparison(state, [request], changedContexts, now);
    expect(result.status).toBe("no_comparable_basket");
    expect(Object.values(result.baskets).every((basket) => !basket.comparable)).toBe(true);
    expect(result.lowestComparableRetailer).toBeUndefined();
  });

  it("fails closed when a ZIP changes after the run", () => {
    const state = comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      kroger: { status: "complete", items: [prepared("kroger", 349)] },
    });
    const changedContexts = copyContexts();
    changedContexts.target.zip = "79913";
    const result = evaluateComparison(state, [request], changedContexts, now);
    expect(result.status).toBe("no_comparable_basket");
    expect(result.baskets.kroger.reason).toMatch(/list or store setup changed/i);
    expect(result.lowestComparableRetailer).toBeUndefined();
  });

  it("fails closed when fulfillment changes after the run", () => {
    const state = comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      kroger: { status: "complete", items: [prepared("kroger", 349)] },
    });
    const changedContexts = copyContexts();
    changedContexts.kroger.fulfillmentMode = "delivery";
    const result = evaluateComparison(state, [request], changedContexts, now);
    expect(result.status).toBe("no_comparable_basket");
    expect(result.completeBasketCount).toBe(0);
    expect(result.lowestComparableRetailer).toBeUndefined();
  });

  it("fails closed when one retailer context signature is stale", () => {
    const state = comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      kroger: { status: "complete", items: [prepared("kroger", 349)] },
    });
    state.retailers.kroger.contextSignature = "stale-kroger-context";
    const result = evaluateComparison(state, [request], contexts, now);
    expect(result.status).toBe("no_comparable_basket");
    expect(result.comparableBasketCount).toBe(0);
    expect(result.lowestComparableRetailer).toBeUndefined();
  });

  it("never calls a cheap partial basket the lowest", () => {
    const partial = { ...prepared("target", 99), matchStatus: "needs_review" as const };
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      target: { status: "complete", items: [partial] },
      kroger: { status: "complete", items: [prepared("kroger", 349)] },
    }), [request], contexts, now);
    expect(result.lowestComparableRetailer).toBe("walmart");
    expect(result.baskets.target.comparable).toBe(false);
  });

  it("multiplies requested quantities using integer cents", () => {
    const quantityRequest = { ...request, quantity: 3 };
    const walmart = { ...prepared("walmart", 299), request: quantityRequest };
    const kroger = { ...prepared("kroger", 349), request: quantityRequest };
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [walmart] },
      kroger: { status: "complete", items: [kroger] },
    }, [quantityRequest]), [quantityRequest], contexts, now);
    expect(result.baskets.walmart.totalCents).toBe(897);
    expect(result.lowestComparableRetailer).toBe("walmart");
  });

  it("rejects 12-count versus 18-count baskets as an unfair comparison", () => {
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299, measurement(12))] },
      kroger: { status: "complete", items: [prepared("kroger", 279, measurement(18))] },
    }), [request], contexts, now);
    expect(result.status).toBe("no_comparable_basket");
    expect(result.lowestComparableRetailer).toBeUndefined();
    expect(result.baskets.kroger.reason).toMatch(/sizes differ/i);
  });

  it("rejects products that do not satisfy an explicit requested count", () => {
    const explicit = { ...request, text: "18 count eggs", normalizedText: "18 count eggs", packCount: 18 };
    const walmart = { ...prepared("walmart", 299, measurement(12)), request: explicit };
    const kroger = { ...prepared("kroger", 349, measurement(12)), request: explicit };
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [walmart] },
      kroger: { status: "complete", items: [kroger] },
    }, [explicit]), [explicit], contexts, now);
    expect(result.status).toBe("no_comparable_basket");
    expect(result.baskets.walmart.comparable).toBe(false);
  });

  it("excludes weighted products when the shopper did not request an explicit weight", () => {
    const walmart = prepared("walmart", 299, weightMeasurement(16));
    walmart.estimatedByWeight = true;
    const kroger = prepared("kroger", 249, weightMeasurement(16));
    kroger.estimatedByWeight = true;
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [walmart] },
      kroger: { status: "complete", items: [kroger] },
    }), [request], contexts, now);
    expect(result.status).toBe("no_comparable_basket");
    expect(result.baskets.walmart.reliableCount).toBe(0);
    expect(result.baskets.kroger.reliableCount).toBe(0);
    expect(result.lowestComparableRetailer).toBeUndefined();
  });

  it("compares an explicit 6 pack of 12 oz using the per-package amount", () => {
    const multiPackRequest: ParsedListItem = {
      ...request,
      text: "6 pack 12 oz drinks",
      normalizedText: "6 pack 12 oz drinks",
      size: "12 oz",
      packCount: 6,
    };
    const walmart = {
      ...prepared("walmart", 599, weightMeasurement(72, 6, 12)),
      request: multiPackRequest,
    };
    const kroger = {
      ...prepared("kroger", 649, weightMeasurement(72, 6, 12)),
      request: multiPackRequest,
    };
    const state = comparison({
      walmart: { status: "complete", items: [walmart] },
      kroger: { status: "complete", items: [kroger] },
    }, [multiPackRequest]);
    const result = evaluateComparison(state, [multiPackRequest], contexts, now);
    expect(result.status).toBe("ready");
    expect(result.baskets.walmart.coveragePercent).toBe(100);
    expect(result.baskets.kroger.coveragePercent).toBe(100);
    expect(result.lowestComparableRetailer).toBe("walmart");
  });

  it("uses Kroger regular price when a lower promo is not proven unconditional", () => {
    const kroger = prepared("kroger", 199);
    kroger.product!.priceProvenance = {
      ...kroger.product!.priceProvenance,
      regularPriceCents: 399,
      promoPriceCents: 199,
    };
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      kroger: { status: "complete", items: [kroger] },
    }), [request], contexts, now);
    expect(result.baskets.kroger.totalCents).toBe(399);
    expect(result.baskets.kroger.hasConditionalPromo).toBe(true);
    expect(result.lowestComparableRetailer).toBe("walmart");
  });

  it("excludes a Kroger promo when its regular baseline is missing", () => {
    const kroger = prepared("kroger", 199);
    kroger.product!.priceProvenance = {
      ...kroger.product!.priceProvenance,
      promoPriceCents: 199,
      promoUnconditional: false,
    };
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      kroger: { status: "complete", items: [kroger] },
    }), [request], contexts, now);
    expect(result.status).toBe("only_complete");
    expect(result.baskets.kroger.reliableCount).toBe(0);
    expect(result.baskets.kroger.comparable).toBe(false);
    expect(result.baskets.kroger.hasConditionalPromo).toBe(false);
    expect(result.lowestComparableRetailer).toBeUndefined();
  });

  it("uses an unconditional Kroger promo as the comparison baseline", () => {
    const kroger = prepared("kroger", 199);
    kroger.product!.priceProvenance = {
      ...kroger.product!.priceProvenance,
      regularPriceCents: 399,
      promoPriceCents: 199,
      promoUnconditional: true,
    };
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      kroger: { status: "complete", items: [kroger] },
    }), [request], contexts, now);
    expect(result.status).toBe("ready");
    expect(result.baskets.kroger.totalCents).toBe(199);
    expect(result.baskets.kroger.promoSavingsCents).toBe(200);
    expect(result.baskets.kroger.hasConditionalPromo).toBe(false);
    expect(result.lowestComparableRetailer).toBe("kroger");
  });

  it("excludes a stale or wrong-store result", () => {
    const stale = prepared("walmart", 199);
    stale.checkedAt = "2026-08-14T18:00:00.000Z";
    const wrongStore = prepared("kroger", 199);
    wrongStore.product!.priceProvenance!.location!.observedStoreId = "other";
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [stale] },
      kroger: { status: "complete", items: [wrongStore] },
    }), [request], contexts, now);
    expect(result.status).toBe("no_comparable_basket");
    expect(result.lowestComparableRetailer).toBeUndefined();
  });

  it("excludes an otherwise valid product whose fulfillment evidence is wrong", () => {
    const wrongFulfillment = prepared("kroger", 199);
    wrongFulfillment.product!.priceProvenance = {
      ...wrongFulfillment.product!.priceProvenance,
      fulfillment: ["delivery"],
    };
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      kroger: { status: "complete", items: [wrongFulfillment] },
    }), [request], contexts, now);
    expect(result.status).toBe("only_complete");
    expect(result.baskets.kroger.reliableCount).toBe(0);
    expect(result.baskets.kroger.comparable).toBe(false);
    expect(result.lowestComparableRetailer).toBeUndefined();
  });

  it("refuses to choose between ambiguous equal maximal size-equivalence groups", () => {
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299, weightMeasurement(100))] },
      target: { status: "complete", items: [prepared("target", 199, weightMeasurement(101.9))] },
      kroger: { status: "complete", items: [prepared("kroger", 99, weightMeasurement(103.8))] },
    }), [request], contexts, now);
    expect(result.status).toBe("no_comparable_basket");
    expect(result.completeBasketCount).toBe(3);
    expect(result.comparableBasketCount).toBe(0);
    expect(result.lowestComparableRetailer).toBeUndefined();
    expect(result.tiedLowestRetailers).toEqual([]);
    expect(Object.values(result.baskets).every((basket) => (
      basket.reason?.includes("Package sizes differ")
    ))).toBe(true);
  });

  it("uses verified before estimate on an exact-price tie and discloses ties", () => {
    const result = evaluateComparison(comparison({
      walmart: { status: "complete", items: [prepared("walmart", 299)] },
      target: { status: "complete", items: [prepared("target", 299)] },
      kroger: { status: "complete", items: [prepared("kroger", 349)] },
    }), [request], contexts, now);
    expect(result.lowestComparableRetailer).toBe("walmart");
    expect(result.tiedLowestRetailers).toEqual(["walmart", "target"]);
  });
});
