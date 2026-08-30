import { describe, expect, it } from "vitest";

import {
  AvailabilityStatus,
  BasketCompleteness,
  HandoffCapability,
} from "@/packages/shared/src";
import { krogerAdapter } from "@/lib/retailers/kroger-adapter";
import {
  activeRetailerAdapters,
  anonymousMobileRetailerCapabilities,
  getActiveRetailerAdapter,
} from "@/lib/retailers/registry";

describe("live retailer adapter registry", () => {
  it("registers only the real Kroger vertical", () => {
    expect(activeRetailerAdapters).toEqual([krogerAdapter]);
    expect(getActiveRetailerAdapter("kroger")).toBe(krogerAdapter);
    expect(anonymousMobileRetailerCapabilities()).toEqual([{
      id: "kroger",
      label: "Kroger",
      status: "ACTIVE",
      read: { locations: true, productSearch: true },
      handoff: {
        mode: HandoffCapability.SHOPPING_PAGE_ONLY,
        cartTransferSupported: false,
        requiresRetailerCheckout: true,
        reason: "Kroger cart writing is not explicitly enabled on this Cartiva backend.",
      },
    }]);
  });

  it("keeps verified, likely, missing, and negative availability distinct", () => {
    expect(krogerAdapter.normalizeAvailability("in_stock"))
      .toBe(AvailabilityStatus.VERIFIED_IN_STOCK);
    expect(krogerAdapter.normalizeAvailability("likely_available"))
      .toBe(AvailabilityStatus.LIKELY_AVAILABLE);
    expect(krogerAdapter.normalizeAvailability("out_of_stock"))
      .toBe(AvailabilityStatus.OUT_OF_STOCK);
    expect(krogerAdapter.normalizeAvailability(undefined))
      .toBe(AvailabilityStatus.UNKNOWN);
    expect(krogerAdapter.normalizeAvailability("unexpected"))
      .toBe(AvailabilityStatus.UNKNOWN);
  });

  it("keeps an incomplete basket out of complete-total ranking", () => {
    const basket = krogerAdapter.summarizeBasket([
      { validMatch: true, priceCents: 299 },
      { validMatch: true, priceCents: 449 },
      { validMatch: true, priceCents: 389 },
      { validMatch: true, priceCents: 129 },
      { validMatch: false },
    ]);

    expect(basket).toMatchObject({
      requestedCount: 5,
      validMatchCount: 4,
      completeness: BasketCompleteness.INCOMPLETE,
      eligibleForBestCompleteTotal: false,
      matchedSubtotalCents: 1266,
    });
    expect(basket.completeTotalCents).toBeUndefined();
  });

  it("models trusted cart transfer separately from anonymous mobile handoff", () => {
    const anonymous = krogerAdapter.getHandoffCapabilities("ANONYMOUS_MOBILE");
    const anonymousUrl = krogerAdapter.getHandoffUrl(
      "ANONYMOUS_MOBILE",
      { chain: "King Soopers" },
    );

    expect(anonymous).toEqual({
      mode: HandoffCapability.SHOPPING_PAGE_ONLY,
      cartTransferSupported: false,
      requiresRetailerCheckout: true,
    });
    expect(anonymousUrl).toBe("https://www.kingsoopers.com/");
    expect(new URL(anonymousUrl).pathname).not.toMatch(/\/cart|\/p\//i);

    expect(krogerAdapter.getHandoffCapabilities("TRUSTED_LOCAL_SERVER"))
      .toEqual({
        mode: HandoffCapability.CART_TRANSFER_SUPPORTED,
        cartTransferSupported: true,
        requiresRetailerCheckout: true,
        requiresCustomerAuthorization: true,
        cartApiLocationBound: false,
        requiresStoreConfirmation: true,
      });
    expect(krogerAdapter.getHandoffUrl(
      "TRUSTED_LOCAL_SERVER",
      { chain: "King Soopers" },
    ))
      .toBe("https://www.kingsoopers.com/cart");
  });

  it("keeps anonymous shopping handoffs on a Kroger-family host", () => {
    expect(krogerAdapter.getHandoffUrl("ANONYMOUS_MOBILE", { chain: "Kroger" }))
      .toBe("https://www.kroger.com/");
    expect(krogerAdapter.getHandoffUrl("ANONYMOUS_MOBILE", { chain: "KINGSOOPERS" }))
      .toBe("https://www.kingsoopers.com/");
    expect(krogerAdapter.getHandoffUrl("ANONYMOUS_MOBILE", { chain: "City Market" }))
      .toBe("https://www.citymarket.com/");
    expect(krogerAdapter.getHandoffUrl(
      "ANONYMOUS_MOBILE",
      { chain: "https://attacker.example" },
    )).toBe("https://www.kroger.com/");
  });
});
