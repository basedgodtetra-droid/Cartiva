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
) {
  const comparison = {
    phase: "complete" as const,
    results: [result],
    completedItems: 1,
    checkedAt: "2026-08-31T20:00:00.000Z",
  };
  const props: Parameters<typeof CartivaComparison>[0] = {
    items: [grocery],
    quantities: { eggs: 1 },
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
      items: [grocery],
      results: [result],
      quantities: { eggs: 1 },
      comparisonComplete: true,
      customerConnected: connected,
      cartCapability: true,
    }),
    basketSaved: false,
    connectionChecking: false,
    connectionState,
    onChangeStore: vi.fn(),
    onRetry: vi.fn(),
    onReviewItem: vi.fn(),
    onSaveBasket: vi.fn(),
    onAddToKroger: vi.fn(),
    onContinueWithoutTransfer: vi.fn(),
    onResolveCartReview: vi.fn(),
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
    expect(html).toContain("If Kroger asks you to sign in in this browser");
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
});
