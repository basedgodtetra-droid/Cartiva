import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CartivaComparison } from "@/components/cartiva-comparison";
import { getKrogerCartReadiness } from "@/lib/cartiva-kroger-cart";
import type { GroceryNotepadItem } from "@/lib/grocery-notepad";
import type { KrogerMatchResult, KrogerProduct } from "@/lib/types";
import type { CartivaKrogerConnectionState } from "@/lib/cartiva-kroger-connection";

const grocery: GroceryNotepadItem = {
  id: "eggs",
  raw: "Large eggs, 18 count",
  name: "Large eggs",
  detail: "18 count",
  canonicalText: "Large eggs, 18 count",
  status: "ready",
};

const product = {
  retailer: "kroger",
  id: "0001111011111",
  productId: "0001111011111",
  upc: "0001111011111",
  title: "Kroger Large Grade A Eggs",
  price: 4.79,
  priceCents: 479,
  link: "https://www.kroger.com/p/product/0001111011111",
  linkType: "product",
  seller: "Kroger",
  inStock: true,
  availabilityStatus: "in_stock",
  sponsored: false,
  checkedAt: "2026-08-31T20:00:00.000Z",
  verification: "verified",
  verificationIssues: [],
  cartEligible: true,
  dataSource: "kroger_public_api",
  identityVerified: true,
  priceProvenance: {
    retailer: "kroger",
    priceSource: "kroger_location_product",
    priceScope: "exact_store",
    priceReliability: "verified",
    exactStoreVerified: true,
    locationId: "01400912",
    location: {
      requestedStoreId: "01400912",
      observedStoreId: "01400912",
      responseProvesLocation: true,
      storeMatched: true,
    },
    fulfillment: ["pickup"],
    checkedAt: "2026-08-31T20:00:00.000Z",
  },
  score: 100,
  confidence: "high",
  comparablePrice: 4.79,
  matchedTerms: [],
  reasons: [],
} satisfies KrogerProduct & {
  score: number;
  confidence: "high";
  comparablePrice: number;
  matchedTerms: string[];
  reasons: string[];
};

const result: KrogerMatchResult = {
  retailer: "kroger",
  requestedItem: grocery.canonicalText,
  recommended: product,
  alternatives: [],
  confidence: "high",
  status: "matched",
  explanation: "Verified exact-store match.",
};

function markup(
  cart: Parameters<typeof CartivaComparison>[0]["cart"],
  connected = false,
  connectionState: CartivaKrogerConnectionState = connected ? "connected" : "required",
  comparisonResult: KrogerMatchResult = result,
  quantity = 1,
  plannedBudgetDollars?: number,
  onReviewPlan = vi.fn(),
  extraManualItem?: { item: GroceryNotepadItem; result: KrogerMatchResult; quantity: number },
  basketSaved = false,
) {
  const items = extraManualItem ? [grocery, extraManualItem.item] : [grocery];
  const results = extraManualItem ? [comparisonResult, extraManualItem.result] : [comparisonResult];
  const quantities = extraManualItem
    ? { eggs: quantity, [extraManualItem.item.id]: extraManualItem.quantity }
    : { eggs: quantity };
  const comparison = {
    phase: "complete" as const,
    results,
    completedItems: items.length,
    checkedAt: "2026-08-31T20:00:00.000Z",
  };
  const props: Parameters<typeof CartivaComparison>[0] = {
    items,
    quantities,
    comparison,
    selectedLocation: {
      locationId: "01400912",
      name: "Mockingbird Kroger",
      chain: "Kroger",
      address: { addressLine1: "5665 E Mockingbird Ln", city: "Dallas", state: "TX", zipCode: "75206" },
    },
    fulfillmentMode: "pickup",
    cart,
    cartReadiness: getKrogerCartReadiness({
      items,
      results,
      quantities,
      comparisonComplete: true,
      customerConnected: connected,
      cartCapability: true,
    }),
    basketSaved,
    connectionChecking: false,
    connectionState,
    onChangeStore: vi.fn(),
    onRetry: vi.fn(),
    onReviewItem: vi.fn(),
    onSaveBasket: vi.fn(),
    onAddToKroger: vi.fn(),
    onContinueWithoutTransfer: vi.fn(),
    onResolveCartReview: vi.fn(),
    plannedBudgetDollars,
    plannedItemIds: plannedBudgetDollars ? new Set(["eggs"]) : undefined,
    onReviewPlan,
  };
  return renderToStaticMarkup(createElement(CartivaComparison, props));
}

describe("Cartiva comparison handoff UI", () => {
  it("stops at a reviewable Cartiva basket before any retailer authentication", () => {
    const html = markup({ phase: "idle" });
    expect(html).toContain("Connect to Kroger to add your items");
    expect(html).toContain("Kroger basket receipt");
    expect(html).toContain("Connect Kroger");
    expect(html).toContain("Save this basket");
    expect(html).toContain("Open Kroger without transfer");
    expect(html).toContain("will not be transferred");
    expect(html).not.toContain("Your Kroger cart is ready");
  });

  it("explains that an already-connected shopper can add immediately", () => {
    const html = markup({ phase: "idle" }, true);
    expect(html).toContain("Kroger API connection is active");
    expect(html).toContain("Add basket to Kroger");
  });

  it("keeps basket saving compact, stateful, and accessible", () => {
    const unsaved = markup({ phase: "idle" });
    const saved = markup({ phase: "idle" }, false, "required", result, 1, undefined, vi.fn(), undefined, true);

    expect(unsaved).toContain('aria-label="Save this basket"');
    expect(unsaved).toContain('aria-pressed="false"');
    expect(saved).toContain('aria-label="Remove basket from saved baskets"');
    expect(saved).toContain('aria-pressed="true"');
    expect(saved).toContain('title="Saved"');
    expect(saved).not.toContain(">Basket saved<");
  });

  it("shows the resolved multi-package plan and prices every retailer package", () => {
    const multiPackage: KrogerMatchResult = {
      ...result,
      resolution: "multi_package_fulfillment",
      fulfillment: {
        kind: "multi_package",
        cartQuantity: 3,
        packageCount: 3,
        requestedBaseAmount: 28.8,
        suppliedBaseAmount: 36,
        baseUnit: "oz",
        overageBaseAmount: 7.2,
        overagePercent: 25,
        label: "3 × 12 oz boxes · 36 oz total",
        approvalRequired: false,
      },
    };

    const html = markup({ phase: "idle" }, true, "connected", multiPackage);
    expect(html).toContain("3 × 12 oz boxes · 36 oz total");
    expect(html).toContain("$14.37");
    expect(html).not.toContain("Qty 1");
  });

  it("keeps a verified product visible when Kroger availability is unknown", () => {
    const checkAvailability: KrogerMatchResult = {
      ...result,
      recommended: {
        ...product,
        inStock: false,
        availabilityStatus: "unknown",
        cartEligible: true,
      },
      resolution: "matched_check_availability",
      fulfillment: {
        kind: "single_package",
        cartQuantity: 1,
        packageCount: 1,
        label: "18 count",
        approvalRequired: false,
      },
      explanation: "Product and price verified; check current availability.",
    };

    const html = markup({ phase: "idle" }, false, "required", checkAvailability);
    expect(html).toContain("Kroger Large Grade A Eggs");
    expect(html).toContain("Check availability");
    expect(html).toContain('data-complete="true"');
    expect(html).toContain("Kroger basket receipt");
    expect(html).toContain("1 item needs availability confirmation at Kroger");
    expect(html).toContain("Kroger will confirm final availability when you review your cart");
    expect(html).toContain("$4.79");
    expect(html).toContain("Connect Kroger");
    expect(html).not.toContain("No match");
  });

  it("keeps the current ten-item basket complete with three inventory warnings", () => {
    const currentBasket = [
      ["Springdale Whole Milk", 3.49, "in_stock"],
      ["Kroger Cookies & Cream Ice Cream", 4.99, "in_stock"],
      ["Coca-Cola Zero Sugar", 8.99, "in_stock"],
      ["Kroger Spring Water", 5.49, "in_stock"],
      ["Oscar Mayer Honey Ham", 6.99, "in_stock"],
      ["Kroger 93/7 Ground Beef", 9.79, "unknown"],
      ["Simple Truth Chicken Breast", 5.99, "likely_available"],
      ["Kroger Turkey Bacon", 4.49, "unknown"],
      ["Mustard", 1.99, "in_stock"],
      ["Ketchup", 2.49, "in_stock"],
    ] as const;
    const basketItems: GroceryNotepadItem[] = currentBasket.map(([name], index) => ({
      id: `basket-${index}`,
      raw: name,
      name,
      canonicalText: name,
      status: "ready",
    }));
    const basketResults: KrogerMatchResult[] = currentBasket.map(([title, price, availabilityStatus], index) => {
      const upc = String(1111000000 + index).padStart(13, "0");
      return {
        ...result,
        requestedItem: title,
        resolution: availabilityStatus === "in_stock" ? "matched" : "matched_check_availability",
        fulfillment: {
          kind: "single_package",
          cartQuantity: 1,
          packageCount: 1,
          label: "1 retailer package",
          approvalRequired: false,
        },
        recommended: {
          ...product,
          id: upc,
          productId: upc,
          upc,
          title,
          price,
          priceCents: Math.round(price * 100),
          inStock: availabilityStatus === "in_stock",
          availabilityStatus,
          cartEligible: true,
        },
      };
    });
    const quantities = Object.fromEntries(basketItems.map((item) => [item.id, 1]));
    const cartReadiness = getKrogerCartReadiness({
      items: basketItems,
      results: basketResults,
      quantities,
      comparisonComplete: true,
      customerConnected: false,
      cartCapability: true,
    });
    const html = renderToStaticMarkup(createElement(CartivaComparison, {
      items: basketItems,
      quantities,
      comparison: {
        phase: "complete",
        results: basketResults,
        completedItems: basketItems.length,
        checkedAt: "2026-09-03T20:00:00.000Z",
      },
      selectedLocation: {
        locationId: "01400912",
        name: "Mockingbird Kroger",
        chain: "Kroger",
        address: { addressLine1: "5665 E Mockingbird Ln", city: "Dallas", state: "TX", zipCode: "75206" },
      },
      fulfillmentMode: "pickup",
      cart: { phase: "idle" },
      cartReadiness,
      basketSaved: false,
      connectionChecking: false,
      connectionState: "required",
      onChangeStore: vi.fn(),
      onRetry: vi.fn(),
      onReviewItem: vi.fn(),
      onSaveBasket: vi.fn(),
      onAddToKroger: vi.fn(),
      onContinueWithoutTransfer: vi.fn(),
      onResolveCartReview: vi.fn(),
    }));

    expect(cartReadiness).toMatchObject({
      basketComplete: true,
      acceptedLineCount: 10,
      cartEligibleLineCount: 10,
      pricedLineCount: 10,
      availabilityUnconfirmedCount: 3,
      canAddToKroger: true,
    });
    expect(html).toContain("10 of 10");
    expect(html).toContain("3 items need availability confirmation at Kroger");
    expect(html).toContain("$54.70");
    expect(html.match(/Check availability/g)).toHaveLength(3);
    const connectButton = html.match(/<button[^>]*>Connect Kroger/)?.[0];
    expect(connectButton).toBeTruthy();
    expect(connectButton).not.toContain("disabled");
  });

  it("labels explicit unavailability and keeps handoff blocked", () => {
    const unavailable: KrogerMatchResult = {
      ...result,
      recommended: {
        ...product,
        inStock: false,
        availabilityStatus: "out_of_stock",
        cartEligible: false,
      },
    };

    const html = markup({ phase: "idle" }, true, "connected", unavailable);
    expect(html).toContain("Out of stock");
    expect(html).toContain('data-complete="false"');
    const addButton = html.match(/<button[^>]*>Add basket to Kroger/)?.[0];
    expect(addButton).toContain("disabled");
  });

  it("shows a safe, editable review candidate without treating it as cart-ready", () => {
    const reviewCandidate: KrogerMatchResult = {
      ...result,
      status: "review",
      resolution: "needs_choice",
      fulfillment: {
        kind: "single_package",
        cartQuantity: 1,
        packageCount: 1,
        requestedBaseAmount: 8,
        suppliedBaseAmount: 14,
        baseUnit: "oz",
        overageBaseAmount: 6,
        overagePercent: 75,
        label: "1 × 14 oz package · 14 oz total (75% extra)",
        approvalRequired: true,
      },
      explanation: "This package supplies 75% more than requested, so Cartiva will not add it automatically. Edit the amount or choose another package.",
    };

    const html = markup({ phase: "idle" }, true, "connected", reviewCandidate);
    expect(html).toContain("Kroger Large Grade A Eggs");
    expect(html).toContain("75% more than requested");
    expect(html).toContain("Needs your choice");
    expect(html).toContain("Review 1 item");
    expect(html).toContain('data-state="review"');
    expect(html).toContain('data-complete="false"');
    expect(html).not.toContain("Kroger basket receipt");
    expect(html).not.toContain(">Available<");
  });

  it("shows an expired connection as reconnectable without claiming transfer success", () => {
    const html = markup({
      phase: "error",
      code: "auth_expired",
      retrySafe: true,
      message: "Your Kroger connection expired.",
    }, false, "expired");
    expect(html).toContain("Your Kroger connection expired");
    expect(html).toContain("Reconnect Kroger");
    expect(html).toContain("Not transferred");
    expect(html).not.toContain("Your Kroger cart is ready");
  });

  it("preserves the basket after OAuth cancellation and offers a safe retry", () => {
    const html = markup({ phase: "error", code: "oauth_cancelled", retrySafe: true, message: "Kroger sign-in was cancelled." });
    expect(html).toContain("Your Cartiva basket is still ready");
    expect(html).toContain("Connect Kroger");
    expect(html).toContain("Kroger basket receipt");
    expect(html).toContain("Not transferred");
  });

  it("does not offer a no-transfer exit while authorization or cart writing is active", () => {
    expect(markup({ phase: "authorizing", retrySafe: true })).not.toContain("Open Kroger without transfer");
    expect(markup({ phase: "adding", retrySafe: true }, true)).not.toContain("Open Kroger without transfer");
    expect(markup({ phase: "error", code: "outcome_unknown", retrySafe: false })).not.toContain("Open Kroger without transfer");
  });

  it("claims a Kroger cart only after confirmed transfer success", () => {
    const html = markup({
      phase: "success",
      cartUrl: "https://www.kroger.com/cart",
      itemCount: 1,
      message: "1 item was added to Kroger.",
    }, true);
    expect(html).toContain("Your Kroger cart is ready");
    expect(html).toContain("Open Kroger cart");
    expect(html).toContain('href="https://www.kroger.com/cart"');
    expect(html).toContain("Accepted by Kroger");
    expect(html).toContain("Review availability and checkout with Kroger");
    expect(html).toContain("confirm Kroger&#x27;s active store before checkout");
    expect(html).not.toContain("Add basket to Kroger");
  });

  it("fails closed when Kroger's batch outcome is unconfirmed", () => {
    const html = markup({
      phase: "error",
      code: "outcome_unknown",
      retrySafe: false,
      message: "Cartiva could not confirm Kroger's response.",
    }, true);
    expect(html).toContain("Confirmation needed");
    expect(html).toContain("Items are in Kroger");
    expect(html).toContain("Items were not added");
    expect(html).not.toContain("Your Kroger cart is ready");
  });

  it("records a shopper-resolved unknown outcome without claiming API-confirmed success", () => {
    const html = markup({
      phase: "reviewed",
      cartUrl: "https://www.kroger.com/cart",
      retrySafe: false,
      message: "You confirmed these items are already in the retailer cart. Cartiva will not send them again.",
    }, true);
    expect(html).toContain("Cart review recorded");
    expect(html).toContain("Open Kroger cart");
    expect(html).not.toContain("Your Kroger cart is ready");
    expect(html).not.toContain("Add basket to Kroger");
  });

  it("shows the real matched basket against the planning budget and only offers lowering when over", () => {
    const pricedResult = (price: number): KrogerMatchResult => ({
      ...result,
      recommended: { ...product, price, priceCents: Math.round(price * 100), comparablePrice: price },
    });
    const under = markup({ phase: "idle" }, true, "connected", pricedResult(76.42), 1, 80);
    expect(under).toContain("$3.58 under budget");
    expect(under).toContain("Planned $80.00 · matched plan groceries $76.42");
    expect(under).not.toContain("Lower my basket");

    const over = markup({ phase: "idle" }, true, "connected", pricedResult(87.30), 1, 80);
    expect(over).toContain("$7.30 over budget");
    expect(over).toContain("Lower my basket");

    const exact = markup({ phase: "idle" }, true, "connected", pricedResult(80), 1, 80);
    expect(exact).toContain("On budget");
    expect(exact).not.toContain("Lower my basket");
  });

  it("keeps unrelated manual groceries out of the planning-budget subtotal", () => {
    const paperTowels: GroceryNotepadItem = {
      id: "paper-towels",
      raw: "Paper towels",
      name: "Paper towels",
      detail: "",
      canonicalText: "Paper towels",
      status: "ready",
    };
    const planResult: KrogerMatchResult = {
      ...result,
      recommended: { ...product, price: 76.42, priceCents: 7642, comparablePrice: 76.42 },
    };
    const manualResult: KrogerMatchResult = {
      ...result,
      requestedItem: "Paper towels",
      recommended: {
        ...product,
        id: "0001111022222",
        productId: "0001111022222",
        upc: "0001111022222",
        title: "Kroger Paper Towels",
        price: 20,
        priceCents: 2000,
        comparablePrice: 20,
      },
    };

    const html = markup(
      { phase: "idle" },
      true,
      "connected",
      planResult,
      1,
      80,
      vi.fn(),
      { item: paperTowels, result: manualResult, quantity: 1 },
    );

    expect(html).toContain("$3.58 under budget");
    expect(html).toContain("matched plan groceries $76.42");
    expect(html).toContain("$96.42");
    expect(html).not.toContain("$16.42 over budget");
  });

  it("does not compare an incomplete basket with a plan budget", () => {
    const noMatch: KrogerMatchResult = {
      retailer: "kroger",
      requestedItem: grocery.canonicalText,
      recommended: null,
      alternatives: [],
      confidence: "low",
      status: "no_match",
      explanation: "No verified match.",
    };
    const html = markup({ phase: "idle" }, true, "connected", noMatch, 1, 80);
    expect(html).not.toContain("Plan budget check");
    expect(html).not.toContain("Lower my basket");
  });
});
