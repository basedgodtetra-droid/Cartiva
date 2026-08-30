import { describe, expect, it } from "vitest";

import {
  comparableRetailers,
  excludedRetailer,
} from "../lib/comparison-preview";

describe("comparison preview trust contract", () => {
  it("only gives totals and handoffs to complete baskets", () => {
    expect(comparableRetailers).toHaveLength(2);

    for (const retailer of comparableRetailers) {
      expect(retailer.status).toBe("comparable");
      expect(retailer.items).toHaveLength(5);
      expect(retailer.items.every((item) => typeof item.price === "number")).toBe(true);
      expect(retailer.total).toBeGreaterThan(0);
      expect(retailer.handoffUrl).toMatch(/^https:\/\//);
    }
  });

  it("keeps the incomplete Target basket out of totals and handoff", () => {
    expect(excludedRetailer.status).toBe("excluded");
    expect(excludedRetailer.matchedCount).toBe(4);
    expect(excludedRetailer.requestedCount).toBe(5);
    expect("total" in excludedRetailer).toBe(false);
    expect("handoffUrl" in excludedRetailer).toBe(false);
    expect(excludedRetailer.items.some((item) => item.quality === "Uncertain")).toBe(true);
  });

  it("discloses official and third-party provenance separately", () => {
    expect(comparableRetailers.map((retailer) => retailer.source)).toEqual([
      "Third-party data",
      "Official retailer API",
    ]);
    expect(excludedRetailer.source).toBe("Third-party data");
  });
});
