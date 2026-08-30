import { describe, expect, it } from "vitest";
import { calculateBasketTotal, calculateBasketTotalCents } from "@/lib/basket";
import type { RankedProduct } from "@/lib/types";

function item(price: number): RankedProduct {
  return {
    id: String(price),
    title: "Test product",
    price,
    link: "https://www.walmart.com/",
    seller: "Walmart.com",
    inStock: true,
    sponsored: false,
    score: 80,
    confidence: "high",
    comparablePrice: price,
    matchedTerms: ["test"],
    reasons: [],
  };
}

describe("basket total", () => {
  it("adds selected products and ignores unmatched rows", () => {
    expect(calculateBasketTotal([item(2.48), null, item(3.54), item(0.98)])).toBe(7);
  });

  it("multiplies selected products by their reviewed quantities", () => {
    expect(calculateBasketTotal([item(2.48), item(3.54)], [2, 1])).toBe(8.5);
  });

  it("uses integer cents internally and respects an authoritative cent price", () => {
    const authoritative = { ...item(14.969), priceCents: 1497 };
    expect(calculateBasketTotalCents([authoritative, item(0.1)], [2, 3])).toBe(3024);
    expect(calculateBasketTotal([authoritative, item(0.1)], [2, 3])).toBe(30.24);
  });
});
