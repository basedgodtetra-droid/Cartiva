import { describe, expect, it } from "vitest";
import {
  CARTIVA_PRODUCT_EVENT_NAMES,
  buildCartivaProductEvent,
} from "@/lib/cartiva-product-events";

describe("privacy-conscious Cartiva product events", () => {
  it("defines the requested funnel without sending shopper text or identifiers", () => {
    expect(CARTIVA_PRODUCT_EVENT_NAMES).toEqual([
      "page_view",
      "list_started",
      "item_added",
      "list_pasted",
      "clarification_requested",
      "clarification_completed",
      "zip_entered",
      "store_selected",
      "comparison_started",
      "comparison_completed",
      "comparison_failed",
      "basket_saved",
      "list_saved",
      "price_history_viewed",
      "kroger_handoff_started",
      "kroger_cart_added",
    ]);
  });

  it("keeps only coarse bounded metadata and strips query strings", () => {
    expect(buildCartivaProductEvent("comparison_completed", {
      route: "/compare?list=private-id",
      retailer: "kroger",
      fulfillmentMode: "pickup",
      itemCount: 5.9,
      matchedCount: 5,
      directMatchedCount: 3,
      multiPackageFulfilledCount: 2,
      availabilityCheckCount: 1,
      shopperChoiceRequiredCount: 0,
      trulyUnavailableCount: 0,
      complete: true,
    }, "2026-08-31T12:00:00.000Z")).toEqual({
      schemaVersion: 1,
      name: "comparison_completed",
      occurredAt: "2026-08-31T12:00:00.000Z",
      properties: {
        route: "/compare",
        retailer: "kroger",
        fulfillmentMode: "pickup",
        itemCount: 5,
        matchedCount: 5,
        directMatchedCount: 3,
        multiPackageFulfilledCount: 2,
        availabilityCheckCount: 1,
        shopperChoiceRequiredCount: 0,
        trulyUnavailableCount: 0,
        complete: true,
      },
    });
  });
});
