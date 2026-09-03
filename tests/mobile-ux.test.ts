import { describe, expect, it } from "vitest";
import {
  availabilityPresentation,
  authorizationFailureState,
  basketLineQuantityPresentation,
  cartAddFailureState,
  comparisonHeading,
  comparisonRecovery,
  handoffPresentation,
  matchCandidatePresentation,
  matchSectionLabel,
  retailerBanner,
} from "../mobile/src/services/mobile-ux";

describe("mobile shopper-facing retailer presentation", () => {
  it("keeps the selected Kroger-family banner visible", () => {
    expect(retailerBanner(" King Soopers ")).toBe("King Soopers");
    expect(comparisonHeading("King Soopers")).toBe("Building your King Soopers basket…");
    expect(matchSectionLabel("Ralphs")).toBe("RALPHS MATCH");
    expect(retailerBanner("  ")).toBe("Kroger-family store");
  });

  it("distinguishes verified inventory from a pickup listing", () => {
    expect(availabilityPresentation("in_stock", "King Soopers")).toMatchObject({
      statusLabel: "Inventory verified",
      tone: "positive",
    });
    expect(availabilityPresentation("likely_available", "King Soopers")).toMatchObject({
      statusLabel: "Availability not confirmed",
      tone: "warning",
    });
    expect(availabilityPresentation("unknown", "King Soopers").detail).toContain("did not provide enough");
    expect(availabilityPresentation("out_of_stock", "King Soopers").statusLabel).toBe("Out of stock");
  });

  it("presents a recommended review candidate as a warning with its package overage", () => {
    const presentation = matchCandidatePresentation({
      confidence: "high",
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
      explanation: "This package supplies 75% more than requested. Cartiva will not add it automatically.",
    });

    expect(presentation).toEqual({
      reviewRequired: true,
      badgeLabel: "Needs your choice",
      badgeTone: "warning",
      fulfillmentLabel: "1 × 14 oz package · 14 oz total (75% extra)",
      explanation: "This package supplies 75% more than requested. Cartiva will not add it automatically.",
    });
  });

  it("keeps an accepted candidate's positive match presentation", () => {
    expect(matchCandidatePresentation({
      confidence: "high",
      status: "matched",
      resolution: "matched",
      fulfillment: {
        kind: "single_package",
        cartQuantity: 1,
        packageCount: 1,
        label: "14 oz",
        approvalRequired: false,
      },
      explanation: "Verified match.",
    })).toEqual({
      reviewRequired: false,
      badgeLabel: "Strong match",
      badgeTone: "positive",
    });
  });
});

describe("mobile handoff presentation", () => {
  it("does not offer retailer handoff for an incomplete basket", () => {
    const state = handoffPresentation({
      complete: false,
      mode: "SHOPPING_PAGE_ONLY",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
    });
    expect(state.kind).toBe("incomplete");
    expect(state.primaryEnabled).toBe(false);
    expect(state.primaryLabel).toBeUndefined();
  });

  it("uses honest banner-aware wording for shopping-page-only handoff", () => {
    const state = handoffPresentation({
      complete: true,
      mode: "SHOPPING_PAGE_ONLY",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
    });
    expect(state.primaryLabel).toBe("Continue at King Soopers");
    expect(state.statusDetail).toContain("cannot transfer");
    expect(state.statusDetail).toContain("Union Station");
    expect(state.requiresStoreConfirmation).toBe(true);
    expect(state.success).toBe(false);
  });

  it("never shows cart success for cancelled, failed, or unknown outcomes", () => {
    for (const cartState of ["cancelled", "unavailable", "failed", "outcome_unknown"] as const) {
      const state = handoffPresentation({
        complete: true,
        mode: "CART_TRANSFER_SUPPORTED",
        chain: "King Soopers",
        locationName: "Union Station",
        hasDestination: true,
        cartState,
      });
      expect(state.success).toBe(false);
      expect(state.statusTitle).not.toMatch(/^Added to/);
      expect(state.statusDetail).not.toMatch(/confirmed the cart update/);
    }
  });

  it("does not retry an ambiguous cart mutation that could create duplicates", () => {
    const state = handoffPresentation({
      complete: true,
      mode: "CART_TRANSFER_SUPPORTED",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
      cartState: "outcome_unknown",
    });
    expect(state.primaryLabel).toBe("Continue at King Soopers");
    expect(state.statusDetail).toContain("Do not retry");
    expect(state.statusDetail).toContain("duplicates");
  });

  it("labels a validated retailer cart review URL without claiming success", () => {
    const state = handoffPresentation({
      complete: true,
      mode: "CART_TRANSFER_SUPPORTED",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
      hasCartReviewDestination: true,
      cartState: "outcome_unknown",
    });
    expect(state.primaryLabel).toBe("Check your King Soopers cart");
    expect(state.success).toBe(false);
  });

  it("shows cart success only after a confirmed outcome", () => {
    const state = handoffPresentation({
      complete: true,
      mode: "CART_TRANSFER_SUPPORTED",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
      cartState: "confirmed",
    });
    expect(state.success).toBe(true);
    expect(state.statusTitle).toBe("Added to your King Soopers cart");
    expect(state.primaryLabel).toBe("Open King Soopers");
    expect(state.statusDetail).toContain("did not bind the cart to Union Station");
    expect(state.requiresStoreConfirmation).toBe(true);
  });

  it("keeps submitted outcomes visible after write eligibility becomes stale", () => {
    const confirmed = handoffPresentation({
      complete: true,
      mode: "CART_TRANSFER_SUPPORTED",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
      cartState: "confirmed",
      cartWriteReady: false,
      cartInventoryVerified: false,
    });
    expect(confirmed.statusTitle).toBe("Added to your King Soopers cart");
    expect(confirmed.success).toBe(true);

    const unknown = handoffPresentation({
      complete: true,
      mode: "CART_TRANSFER_SUPPORTED",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
      cartState: "outcome_unknown",
      cartWriteReady: false,
      cartInventoryVerified: false,
    });
    expect(unknown.statusTitle).toBe("The cart update could not be confirmed");
    expect(unknown.statusDetail).toContain("Do not retry");
    expect(unknown.primaryLabel).toBe("Continue at King Soopers");
  });

  it("keeps a connected retailer one explicit tap away from cart mutation", () => {
    const state = handoffPresentation({
      complete: true,
      mode: "CART_TRANSFER_SUPPORTED",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
      cartState: "connected",
    });
    expect(state.primaryLabel).toBe("Add to King Soopers cart");
    expect(state.statusTitle).toBe("King Soopers is connected");
    expect(state.success).toBe(false);
  });

  it("shows a visible disabled progress state while checking retailer authorization", () => {
    const state = handoffPresentation({
      complete: true,
      mode: "CART_TRANSFER_SUPPORTED",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
      cartState: "checking",
    });
    expect(state.primaryLabel).toBe("Checking King Soopers connection…");
    expect(state.primaryEnabled).toBe(false);
    expect(state.statusDetail).toContain("Nothing has been transferred");
  });

  it("keeps a complete but inventory-unverified basket out of cart mutation", () => {
    const state = handoffPresentation({
      complete: true,
      mode: "CART_TRANSFER_SUPPORTED",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
      cartInventoryVerified: false,
    });
    expect(state.kind).toBe("shopping_page");
    expect(state.primaryLabel).toBe("Continue at King Soopers");
    expect(state.statusTitle).toContain("confirmed inventory");
    expect(state.statusDetail).toContain("nothing will be transferred automatically");
    expect(state.success).toBe(false);
  });

  it("does not expose a dead handoff button without a destination", () => {
    const state = handoffPresentation({
      complete: true,
      mode: "SHOPPING_PAGE_ONLY",
      chain: "King Soopers",
      hasDestination: false,
    });
    expect(state.kind).toBe("unavailable");
    expect(state.primaryEnabled).toBe(false);
    expect(state.primaryLabel).toBeUndefined();
  });

  it("requires a fresh server receipt after a shopper changes a match", () => {
    const state = handoffPresentation({
      complete: true,
      mode: "CART_TRANSFER_SUPPORTED",
      chain: "King Soopers",
      locationName: "Union Station",
      hasDestination: true,
      cartWriteReady: false,
    });
    expect(state.primaryLabel).toBe("Recompare this basket");
    expect(state.statusTitle).toContain("Fresh store verification");
    expect(state.success).toBe(false);
  });
});

describe("comparison recovery", () => {
  it("sends store-not-found failures back to ZIP editing", () => {
    expect(comparisonRecovery({ status: 404, message: "No store." })).toMatchObject({
      primaryLabel: "Change ZIP code",
      action: "edit",
    });
  });

  it("offers retry for network and timeout failures without losing the list", () => {
    expect(comparisonRecovery({ code: "network" })).toMatchObject({
      title: "You appear to be offline",
      action: "retry",
    });
    expect(comparisonRecovery({ code: "timeout" })).toMatchObject({
      title: "The retailer took too long to respond",
      action: "retry",
    });
  });

  it("rebuilds instead of asking the shopper to fix their list after a store-invariant failure", () => {
    expect(comparisonRecovery({ status: 409 })).toMatchObject({
      title: "Cartiva could not keep this basket on one store",
      primaryLabel: "Rebuild at one store",
      action: "retry",
    });
  });
});

describe("basket line quantity presentation", () => {
  it("keeps package size separate from the number of retailer units", () => {
    expect(basketLineQuantityPresentation({
      quantity: 2,
      unitPriceCents: 749,
      packageSizeText: "12 pack",
    })).toEqual({
      quantity: 2,
      quantityLabel: "2 retailer units",
      packageSizeLabel: "12 pack",
      unitPriceCents: 749,
      lineTotalCents: 1498,
    });
  });

  it("normalizes an invalid cart quantity to one retailer unit", () => {
    expect(basketLineQuantityPresentation({ quantity: 0, unitPriceCents: 399 })).toMatchObject({
      quantity: 1,
      quantityLabel: "1 retailer unit",
      lineTotalCents: 399,
    });
  });
});

describe("cart add failure recovery", () => {
  it("never permits a direct retry after an ambiguous or non-retry-safe write", () => {
    expect(cartAddFailureState({
      status: "OUTCOME_UNKNOWN",
      code: "outcome_unknown",
      retrySafe: false,
    })).toEqual({ cartState: "outcome_unknown", requiresRecompare: false });
    expect(cartAddFailureState({
      status: "FAILED",
      code: "operation_conflict",
      retrySafe: false,
    })).toEqual({ cartState: "outcome_unknown", requiresRecompare: false });
    expect(cartAddFailureState({
      status: "FAILED",
      code: "comparison_already_submitted",
      retrySafe: false,
    })).toEqual({ cartState: "unavailable", requiresRecompare: false });
  });

  it("requires a fresh comparison when its server receipt is unavailable", () => {
    expect(cartAddFailureState({
      status: "FAILED",
      code: "comparison_unavailable",
      retrySafe: true,
    })).toEqual({ cartState: "failed", requiresRecompare: true });
  });

  it("requires a fresh comparison when cart evidence has expired", () => {
    expect(cartAddFailureState({
      status: "FAILED",
      code: "comparison_stale",
      retrySafe: true,
    })).toEqual({ cartState: "failed", requiresRecompare: true });
  });

  it("never presents an explicitly reviewed comparison as freshly confirmed", () => {
    expect(cartAddFailureState({
      status: "FAILED",
      code: "comparison_previously_added",
      retrySafe: true,
    })).toEqual({ cartState: "failed", requiresRecompare: true });
    expect(authorizationFailureState("comparison_previously_added"))
      .toEqual({ cartState: "failed", requiresRecompare: true });
  });

  it("distinguishes expired authorization from a safe cart failure", () => {
    expect(cartAddFailureState({
      status: "FAILED",
      code: "not_connected",
      retrySafe: true,
    }).cartState).toBe("cancelled");
    expect(cartAddFailureState({
      status: "FAILED",
      code: "cart_add_failed",
      retrySafe: true,
    }).cartState).toBe("failed");
    expect(cartAddFailureState({
      status: "FAILED",
      code: "cart_transfer_unavailable",
      retrySafe: true,
    }).cartState).toBe("unavailable");
    expect(cartAddFailureState({
      status: "FAILED",
      code: "inventory_unverified",
      retrySafe: true,
    }).cartState).toBe("unavailable");
  });
});

describe("authorization failure recovery", () => {
  it("recompares stale evidence and never retries unverified inventory automatically", () => {
    expect(authorizationFailureState("comparison_stale"))
      .toEqual({ cartState: "failed", requiresRecompare: true });
    expect(authorizationFailureState("comparison_unavailable"))
      .toEqual({ cartState: "failed", requiresRecompare: true });
    expect(authorizationFailureState("basket_incomplete"))
      .toEqual({ cartState: "failed", requiresRecompare: true });
    expect(authorizationFailureState("inventory_unverified"))
      .toEqual({ cartState: "unavailable", requiresRecompare: false });
    expect(authorizationFailureState("comparison_already_submitted"))
      .toEqual({ cartState: "unavailable", requiresRecompare: false });
    expect(authorizationFailureState("outcome_unknown"))
      .toEqual({ cartState: "unavailable", requiresRecompare: false });
    expect(authorizationFailureState("already_connected"))
      .toEqual({ cartState: "connected", requiresRecompare: false });
  });
});
