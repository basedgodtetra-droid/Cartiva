import { describe, expect, it } from "vitest";
import {
  isBackgroundRequest,
  isTrustedSidePanelSender,
} from "../src/messages";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";

function validStartRequest() {
  return {
    type: "CARTIVA_START_CART_BUILD",
    retailer: "walmart",
    confirmed: true,
    items: [{
      id: "eggs",
      requestedText: "large eggs",
      productTitle: "Large Grade A Eggs, 12 count",
      itemId: "123456789",
      productId: "product-123",
      productUrl: "https://www.walmart.com/ip/large-eggs/123456789",
      priceCents: 298,
      checkedAt: new Date().toISOString(),
      quantity: 1,
    }],
    storeId: "3014",
    storeName: "Walmart Supercenter",
    storeAddress: "200 Short Blvd, Dallas, TX 75216",
    zip: "75216",
    fulfillmentMode: "pickup",
  };
}

describe("background message boundary", () => {
  it("accepts only explicit, structurally valid request discriminants", () => {
    expect(isBackgroundRequest({ type: "CARTIVA_GET_CART_BUILD" })).toBe(true);
    expect(isBackgroundRequest({
      type: "CARTIVA_FIND_NEARBY_PICKUP_STORES",
      zipCode: "75216",
      tabId: 42,
    })).toBe(true);
    expect(isBackgroundRequest({
      type: "CARTIVA_SELECT_PICKUP_STORE",
      store: {
        id: "3014",
        name: "Walmart Supercenter",
        address: "200 Short Blvd, Dallas, TX 75216",
        zip: "75216",
      },
    })).toBe(true);
    expect(isBackgroundRequest(validStartRequest())).toBe(true);

    expect(isBackgroundRequest({ type: "CARTIVA_UNRECOGNIZED_COMMAND" })).toBe(false);
    expect(isBackgroundRequest({ type: "CARTIVA_GET_CART_BUILD", injected: true })).toBe(false);
    expect(isBackgroundRequest({
      type: "CARTIVA_FIND_NEARBY_PICKUP_STORES",
      zipCode: "7521A",
    })).toBe(false);
    expect(isBackgroundRequest({
      ...validStartRequest(),
      fulfillmentMode: "curbside",
    })).toBe(false);
    expect(isBackgroundRequest({
      ...validStartRequest(),
      items: [{ ...validStartRequest().items[0], quantity: 25 }],
    })).toBe(false);
  });

  it("accepts sensitive commands only from the exact extension side panel", () => {
    const trusted = {
      id: extensionId,
      url: `chrome-extension://${extensionId}/sidepanel.html`,
    };
    expect(isTrustedSidePanelSender(trusted, extensionId)).toBe(true);

    expect(isTrustedSidePanelSender({
      ...trusted,
      id: "ponmlkjihgfedcbaponmlkjihgfedcba",
    }, extensionId)).toBe(false);
    expect(isTrustedSidePanelSender({
      ...trusted,
      url: `chrome-extension://${extensionId}/sidepanel.html?spoofed=1`,
    }, extensionId)).toBe(false);
    expect(isTrustedSidePanelSender({
      ...trusted,
      url: "https://www.walmart.com/",
      tab: { id: 7, url: "https://www.walmart.com/" },
    }, extensionId)).toBe(false);
    expect(isTrustedSidePanelSender({
      ...trusted,
      url: `chrome-extension://${extensionId}.evil.example/sidepanel.html`,
    }, extensionId)).toBe(false);
    expect(isTrustedSidePanelSender({ id: extensionId }, extensionId)).toBe(false);
  });
});
