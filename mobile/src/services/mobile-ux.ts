import type { KrogerMatchResult } from "./cartiva-api";

export type RetailerHandoffMode =
  | "CART_TRANSFER_SUPPORTED"
  | "DEEPLINK_SUPPORTED"
  | "SHOPPING_PAGE_ONLY"
  | "UNAVAILABLE";

export type CartHandoffState =
  | "idle"
  | "connected"
  | "checking"
  | "authorizing"
  | "adding"
  | "confirmed"
  | "cancelled"
  | "unavailable"
  | "failed"
  | "outcome_unknown";

export interface HandoffPresentation {
  kind: "incomplete" | "cart_transfer" | "retailer_app" | "shopping_page" | "unavailable";
  primaryLabel?: string;
  primaryEnabled: boolean;
  statusTitle: string;
  statusDetail: string;
  requiresStoreConfirmation: boolean;
  success: boolean;
}

export function retailerBanner(chain?: string) {
  const normalized = chain?.trim();
  return normalized || "Kroger-family store";
}

export function comparisonHeading(chain?: string) {
  const banner = chain?.trim();
  return banner ? `Building your ${banner} basket…` : "Building your local basket…";
}

export function matchSectionLabel(chain?: string) {
  return `${retailerBanner(chain).toUpperCase()} MATCH`;
}

export interface MatchCandidatePresentation {
  reviewRequired: boolean;
  badgeLabel: string;
  badgeTone: "positive" | "warning";
  explanation?: string;
  fulfillmentLabel?: string;
}

/**
 * A recommended catalog product can still be review-only. Keep that state
 * explicit so product detail surfaces never style unresolved package math as
 * an accepted match.
 */
export function matchCandidatePresentation(
  result: Pick<
    KrogerMatchResult,
    "confidence" | "explanation" | "fulfillment" | "resolution" | "status"
  >,
): MatchCandidatePresentation {
  const reviewRequired = result.status === "review"
    || result.resolution === "needs_choice"
    || result.fulfillment?.approvalRequired === true;
  if (reviewRequired) {
    return {
      reviewRequired: true,
      badgeLabel: "Needs your choice",
      badgeTone: "warning",
      explanation: result.explanation,
      fulfillmentLabel: result.fulfillment?.label,
    };
  }
  return {
    reviewRequired: false,
    badgeLabel: result.confidence === "high" ? "Strong match" : "Compatible match",
    badgeTone: "positive",
  };
}

export function availabilityPresentation(
  availability: "in_stock" | "likely_available" | "out_of_stock" | "unknown",
  chain?: string,
) {
  const banner = retailerBanner(chain);
  if (availability === "in_stock") {
    return {
      statusLabel: "Inventory verified",
      detail: `${banner} reported this item in stock at the selected store.`,
      tone: "positive" as const,
    };
  }
  if (availability === "likely_available") {
    return {
      statusLabel: "Availability not confirmed",
      detail: `${banner} listed this item for pickup but did not report an inventory level.`,
      tone: "warning" as const,
    };
  }
  if (availability === "out_of_stock") {
    return {
      statusLabel: "Out of stock",
      detail: `${banner} reported this item out of stock at the selected store.`,
      tone: "negative" as const,
    };
  }
  return {
    statusLabel: "Availability unknown",
    detail: `${banner} did not provide enough store inventory evidence.`,
    tone: "warning" as const,
  };
}

export function handoffPresentation({
  complete,
  mode,
  chain,
  locationName,
  hasDestination,
  cartState = "idle",
  locationBoundByCartApi = false,
  cartWriteReady = true,
  hasCartReviewDestination = false,
}: {
  complete: boolean;
  mode?: RetailerHandoffMode;
  chain?: string;
  locationName?: string;
  hasDestination: boolean;
  cartState?: CartHandoffState;
  locationBoundByCartApi?: boolean;
  cartWriteReady?: boolean;
  hasCartReviewDestination?: boolean;
}): HandoffPresentation {
  const banner = retailerBanner(chain);
  const selectedStore = locationName?.trim() || "the store shown above";

  if (!complete) {
    return {
      kind: "incomplete",
      primaryEnabled: false,
      statusTitle: "Finish your basket before continuing",
      statusDetail: "Review the unmatched items, choose a valid alternative, or edit your grocery list.",
      requiresStoreConfirmation: false,
      success: false,
    };
  }

  if (mode === "CART_TRANSFER_SUPPORTED") {
    // A submitted mutation outcome is historical evidence, not a fresh-write
    // eligibility check. Receipt age or later inventory uncertainty must not
    // hide a confirmed add or turn an ambiguous add into a retry surface.
    if (cartState === "confirmed") {
      return {
        kind: "cart_transfer",
        primaryLabel: hasDestination ? `Open ${banner}` : undefined,
        primaryEnabled: hasDestination,
        statusTitle: `Added to your ${banner} cart`,
        statusDetail: locationBoundByCartApi
          ? `The retailer accepted the exact selected products for ${selectedStore}. Review every item and check out with ${banner}.`
          : `The retailer accepted the exact product identifiers, but its cart API did not bind the cart to ${selectedStore}. Verify the active store, items, and quantities before checkout.`,
        requiresStoreConfirmation: !locationBoundByCartApi,
        success: true,
      };
    }
    if (cartState === "outcome_unknown") {
      return {
        kind: "cart_transfer",
        primaryLabel: hasDestination
          ? hasCartReviewDestination ? `Check your ${banner} cart` : `Continue at ${banner}`
          : undefined,
        primaryEnabled: hasDestination,
        statusTitle: "The cart update could not be confirmed",
        statusDetail: `Do not retry yet because that could add duplicates. Open ${banner} and review the cart before taking another action.`,
        requiresStoreConfirmation: true,
        success: false,
      };
    }
    if (!cartWriteReady) {
      return {
        kind: "cart_transfer",
        primaryLabel: "Recompare this basket",
        primaryEnabled: true,
        statusTitle: "Fresh store verification is required",
        statusDetail: "Recompare these selections at the same store before Cartiva can add them to a retailer cart.",
        requiresStoreConfirmation: false,
        success: false,
      };
    }
    if (cartState === "unavailable") {
      return {
        kind: "shopping_page",
        primaryLabel: hasDestination ? `Continue at ${banner}` : undefined,
        primaryEnabled: hasDestination,
        statusTitle: "Retailer cart transfer is unavailable here",
        statusDetail: `Your complete matched basket is safe in Cartiva. Continue to ${banner} without claiming a transfer.`,
        requiresStoreConfirmation: true,
        success: false,
      };
    }
    if (cartState === "connected") {
      return {
        kind: "cart_transfer",
        primaryLabel: `Add to ${banner} cart`,
        primaryEnabled: true,
        statusTitle: `${banner} is connected`,
        statusDetail: "Your complete matched basket is ready. Cartiva will wait for retailer confirmation before reporting success.",
        requiresStoreConfirmation: false,
        success: false,
      };
    }
    if (cartState === "checking") {
      return {
        kind: "cart_transfer",
        primaryLabel: `Checking ${banner} connection…`,
        primaryEnabled: false,
        statusTitle: "Checking retailer connection",
        statusDetail: "Cartiva is verifying the connection before any cart action. Nothing has been transferred yet.",
        requiresStoreConfirmation: false,
        success: false,
      };
    }
    if (cartState === "authorizing") {
      return {
        kind: "cart_transfer",
        primaryLabel: `Connecting to ${banner}…`,
        primaryEnabled: false,
        statusTitle: "Waiting for retailer authorization",
        statusDetail: "Return to Cartiva after you approve access. Your basket will stay here.",
        requiresStoreConfirmation: false,
        success: false,
      };
    }
    if (cartState === "adding") {
      return {
        kind: "cart_transfer",
        primaryLabel: "Adding your basket…",
        primaryEnabled: false,
        statusTitle: `Adding items to ${banner}`,
        statusDetail: "Cartiva will show success only after the retailer confirms the cart update.",
        requiresStoreConfirmation: false,
        success: false,
      };
    }
    if (cartState === "failed") {
      return {
        kind: "cart_transfer",
        primaryLabel: `Try adding to ${banner} again`,
        primaryEnabled: true,
        statusTitle: `We couldn’t add your cart to ${banner}`,
        statusDetail: `Your Cartiva basket is safe. Try again, or continue to ${banner} without claiming a transfer.`,
        requiresStoreConfirmation: false,
        success: false,
      };
    }
    if (cartState === "cancelled") {
      return {
        kind: "cart_transfer",
        primaryLabel: `Connect and add to ${banner}`,
        primaryEnabled: true,
        statusTitle: "Retailer sign-in was cancelled",
        statusDetail: "Nothing was transferred. Your Cartiva basket is still here.",
        requiresStoreConfirmation: false,
        success: false,
      };
    }
    return {
      kind: "cart_transfer",
      primaryLabel: `Add to ${banner} cart`,
      primaryEnabled: true,
      statusTitle: `Ready to add your complete basket`,
      statusDetail: `You may be asked to sign in to ${banner}. The retailer will confirm final availability during cart review, and Cartiva never receives your payment information.`,
      requiresStoreConfirmation: false,
      success: false,
    };
  }

  if (mode === "DEEPLINK_SUPPORTED") {
    return {
      kind: "retailer_app",
      primaryLabel: hasDestination ? `Continue in ${banner}` : undefined,
      primaryEnabled: hasDestination,
      statusTitle: `Continue with ${banner}`,
      statusDetail: `No cart transfer was confirmed. Review the complete matched basket in Cartiva before checkout.`,
      requiresStoreConfirmation: true,
      success: false,
    };
  }

  if (mode === "SHOPPING_PAGE_ONLY" && hasDestination) {
    return {
      kind: "shopping_page",
      primaryLabel: `Continue at ${banner}`,
      primaryEnabled: true,
      statusTitle: "Matched basket ready to review",
      statusDetail: `Cartiva cannot transfer this basket with the current retailer connection. ${banner} may use a saved store, so confirm ${selectedStore} before shopping.`,
      requiresStoreConfirmation: true,
      success: false,
    };
  }

  return {
    kind: "unavailable",
    primaryEnabled: false,
    statusTitle: "Retailer handoff is unavailable",
    statusDetail: `Your matched basket is safe in Cartiva. Try the comparison again before continuing to ${banner}.`,
    requiresStoreConfirmation: false,
    success: false,
  };
}

export function comparisonRecovery(error: {
  code?: string;
  status?: number;
  message?: string;
}) {
  if (error.status === 404) {
    return {
      title: "No nearby Kroger-family store was found",
      detail: error.message || "Try another ZIP code.",
      primaryLabel: "Change ZIP code",
      action: "edit" as const,
    };
  }
  if (error.status === 409) {
    return {
      title: "Cartiva could not keep this basket on one store",
      detail: error.message || "Your list is safe. Retry to select one store and rebuild its basket.",
      primaryLabel: "Rebuild at one store",
      action: "retry" as const,
    };
  }
  if (error.status === 400 || error.status === 410) {
    return {
      title: error.status === 410 ? "This comparison expired" : "Your list needs a quick update",
      detail: error.message || "Return to your list and try again.",
      primaryLabel: "Return to my list",
      action: "edit" as const,
    };
  }
  if (error.code === "network") {
    return {
      title: "You appear to be offline",
      detail: error.message || "Keep editing your list and retry when you’re connected.",
      primaryLabel: "Try again",
      action: "retry" as const,
    };
  }
  if (error.code === "timeout") {
    return {
      title: "The retailer took too long to respond",
      detail: error.message || "Your list is safe. Try the comparison again.",
      primaryLabel: "Try again",
      action: "retry" as const,
    };
  }
  return {
    title: "We couldn’t finish this comparison",
    detail: error.message || "Kroger couldn’t be checked right now.",
    primaryLabel: "Try again",
    action: "retry" as const,
  };
}

export function basketLineQuantityPresentation({
  quantity,
  unitPriceCents,
  packageSizeText,
}: {
  quantity: number;
  unitPriceCents: number;
  packageSizeText?: string;
}) {
  const safeQuantity = Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1;
  const safeUnitPriceCents = Number.isSafeInteger(unitPriceCents) && unitPriceCents >= 0
    ? unitPriceCents
    : 0;
  return {
    quantity: safeQuantity,
    quantityLabel: `${safeQuantity} retailer ${safeQuantity === 1 ? "unit" : "units"}`,
    packageSizeLabel: packageSizeText?.trim() || undefined,
    unitPriceCents: safeUnitPriceCents,
    lineTotalCents: safeUnitPriceCents * safeQuantity,
  };
}

export function cartAddFailureState(outcome: {
  status: "FAILED" | "OUTCOME_UNKNOWN";
  code: string;
  retrySafe: boolean;
}) {
  if (outcome.code === "comparison_already_submitted") {
    return { cartState: "unavailable" as const, requiresRecompare: false };
  }
  if (outcome.status === "OUTCOME_UNKNOWN" || !outcome.retrySafe) {
    return { cartState: "outcome_unknown" as const, requiresRecompare: false };
  }
  if (["cart_transfer_unavailable", "inventory_unverified"].includes(outcome.code)) {
    return { cartState: "unavailable" as const, requiresRecompare: false };
  }
  if ([
    "comparison_unavailable",
    "comparison_stale",
    "comparison_previously_added",
    "basket_incomplete",
    "invalid_basket",
  ].includes(outcome.code)) {
    return { cartState: "failed" as const, requiresRecompare: true };
  }
  if (outcome.code === "not_connected") {
    return { cartState: "cancelled" as const, requiresRecompare: false };
  }
  return { cartState: "failed" as const, requiresRecompare: false };
}

export function authorizationFailureState(code?: string) {
  if (code === "already_connected") {
    return { cartState: "connected" as const, requiresRecompare: false };
  }
  if ([
    "comparison_unavailable",
    "comparison_stale",
    "comparison_previously_added",
    "basket_incomplete",
  ].includes(code ?? "")) {
    return { cartState: "failed" as const, requiresRecompare: true };
  }
  if ([
    "cart_transfer_unavailable",
    "comparison_already_submitted",
    "inventory_unverified",
    "outcome_unknown",
  ].includes(code ?? "")) {
    return { cartState: "unavailable" as const, requiresRecompare: false };
  }
  return { cartState: "failed" as const, requiresRecompare: false };
}
