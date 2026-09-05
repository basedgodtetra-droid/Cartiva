import { describe, expect, it } from "vitest";
import { knowledgeCatalogProduct } from "./support/knowledge-catalog";
import { rankKrogerProducts } from "@/lib/kroger-products";
import { parseProductIntent, isPlausibleDiscoveryCandidate } from "@/lib/product-search-intent";
import { discoverWithKnowledge } from "@/lib/knowledge/pipeline";
import { isRetailerHandoffAcceptedMatch } from "@/packages/shared/src";
import type { KrogerProduct, Measurement } from "@/lib/types";

function product(title: string, size: Measurement, productType = "Produce"): KrogerProduct {
  return { ...knowledgeCatalogProduct("ground-beef-93-1lb"), title, brand: "Kroger", productType, size };
}
const weight = (amount: number): Measurement => ({ amount, unit: "oz", kind: "weight", baseAmount: amount, baseUnit: "oz", label: `${amount} oz` });
const each: Measurement = { amount: 1, unit: "count", kind: "count", baseAmount: 1, baseUnit: "each", label: "1 each" };
const rank = (request: string, products: KrogerProduct[]) => {
  const intent = parseProductIntent(request);
  return rankKrogerProducts(request, products, intent.constraints, undefined, { intent });
};

describe("permanent regressions from the deployed knowledge pass", () => {
  it.each([
    ["baby spinach", "Happy Tot Stage 4 Organic Pears Blueberries & Spinach Pouch", "Baby"],
    ["baby spinach", "Happy Tot Spinach Pouches", "Baby"],
    ["spinach", "Spinach Soup", "Produce"],
    ["spinach", "Spinach Dip", "Produce"],
    ["spinach", "Creamed Spinach", "Produce"],
    ["spinach", "Spinach Purée", "Produce"],
    ["frozen spinach", "Frozen Spinach Baby Food Pouch", "Baby"],
    ["frozen spinach", "Frozen Happy Tot Stage 4 Spinach Pouch", "Baby"],
    ["canned spinach", "Canned Spinach Soup", "Canned Vegetables"],
    ["frozen spinach puree", "Frozen Spinach Dip", "Frozen Vegetables"],
    ["frozen spinach puree", "Canned Spinach Puree", "Canned Vegetables"],
    ["frozen creamed spinach", "Frozen Spinach Puree", "Frozen Vegetables"],
    ["frozen creamed spinach", "Frozen Spinach Dip", "Frozen Vegetables"],
  ])("does not confuse produce with a prepared ingredient: %s / %s", (request, title, taxonomy) => {
    expect(isRetailerHandoffAcceptedMatch(rank(request, [product(title, weight(4), taxonomy)]))).toBe(false);
  });

  it.each([
    ["baby spinach", "Kroger Tender Baby Spinach Bag Salad", "Produce"],
    ["baby carrots", "Baby Carrots", "Produce"],
    ["frozen spinach", "Frozen Spinach Pouch", "Frozen Vegetables"],
    ["frozen spinach puree", "Organic Frozen Spinach Puree", "Frozen Vegetables"],
    ["frozen creamed spinach", "Frozen Creamed Spinach", "Frozen Vegetables"],
    ["frozen creamed spinach", "Frozen Creamed Spinach Pouch", "Frozen Vegetables"],
  ])("preserves genuine produce and explicitly requested preparation: %s", (request, title, taxonomy) => {
    expect(isRetailerHandoffAcceptedMatch(rank(request, [product(title, weight(10), taxonomy)]))).toBe(true);
  });

  it("revalidates a formerly remembered baby-food identity instead of repeating the bad match", async () => {
    const intent = parseProductIntent("baby spinach");
    const wrong = product("Happy Tot Stage 4 Organic Pears Blueberries & Spinach Pouch", weight(4), "Baby");
    const verify = (products: KrogerProduct[]) => rank("baby spinach", products);
    const found = await discoverWithKnowledge({ intent, verify, plausible: p => isPlausibleDiscoveryCandidate(intent, p),
      search: async () => [], memory: { conceptId: "old-spinach", queries: [], aliases: [], relationships: [],
        products: [{ upc: wrong.upc, title: wrong.title, brand: "Happy Baby", package: "4 oz", lastObservedAt: Date.now() }] },
      refreshIdentity: async () => wrong,
    });
    expect(isRetailerHandoffAcceptedMatch(verify(found.candidates))).toBe(false);
  });

  it("accepts a factual gluten-free descriptor on explicitly requested lentil pasta", () => {
    const result = rank("red lentil pasta 1.8 lb", [product("Simple Truth Gluten Free Organic Red Lentil Penne Pasta", weight(8), "Pasta, Sauces, Grain")]);
    expect(result.status).toBe("matched");
    expect(result.fulfillment?.cartQuantity).toBe(4);
    expect(result.fulfillment?.suppliedBaseAmount).toBe(32);
  });

  it.each(["pasta", "red lentil pasta"])("does not treat gluten-free as permission for a different pasta ingredient: %s", request => {
    expect(isRetailerHandoffAcceptedMatch(rank(request, [product("Gluten Free Rice Pasta", weight(8), "Pasta")]))).toBe(false);
  });
  it.each(["Rice", "Corn", "Red Lentil"])("keeps a dietary-only request open to compatible %s pasta", ingredient => {
    expect(isRetailerHandoffAcceptedMatch(rank("gluten free pasta", [product(`Gluten Free ${ingredient} Pasta`, weight(8), "Pasta")]))).toBe(true);
  });

  it.each(["yellow onions 2 each", "red onions 2 each", "Gala apples 2 each"])("keeps explicit loose-produce quantity separate from package: %s", request => {
    const intent = parseProductIntent(request);
    expect(intent.requestedCartQuantity).toBe(2);
    expect(intent.requestedContainer).toBe("each");
    expect(intent.discoveryQueries[0].query).not.toMatch(/2|each/);
    const result = rank(request, [product(request.replace(/ 2 each$/, ""), each)]);
    expect(result.fulfillment?.cartQuantity).toBe(2);
    expect(result.status).toBe("matched");
  });
  it("does not silently turn two onions into two pounds or a three-pound bag", () => {
    const result = rank("yellow onions 2 each", [product("Jumbo Yellow Onions", weight(16)), product("Yellow Onion 3 lb Bag", weight(48))]);
    expect(isRetailerHandoffAcceptedMatch(result)).toBe(false);
    expect(result.status).toBe("review");
    expect(result.explanation).toMatch(/weight|count|each|amount/i);
    expect(result.recommended).toBeNull();
    expect(result.fulfillment).toBeUndefined();
    expect(result.alternatives.every(p => !/bag/i.test(p.title))).toBe(true);
  });
});
