import { describe, expect, it } from "vitest";
import { getMockWalmartProductDetail, getMockWalmartResults } from "@/lib/mock-data";

describe("honest demo links", () => {
  it("uses a valid Walmart search URL instead of an invented demo product page", () => {
    const [result] = getMockWalmartResults("7 up 12 pack soda");
    const detail = getMockWalmartProductDetail(result.id);

    expect(result.brand).toBe("7UP");
    expect(result.title).not.toContain("Great Value");
    expect(result.linkType).toBe("search");
    expect(result.link).toMatch(/^https:\/\/www\.walmart\.com\/search\?q=/);
    expect(result.link).not.toContain("/ip/demo-");
    expect(detail?.linkType).toBe("search");
  });

  it("does not synthesize products for unknown demo requests", () => {
    expect(getMockWalmartResults("a completely unknown grocery request")).toEqual([]);
  });

  it("contains no fabricated Great Value named-brand products", () => {
    for (const query of ["takis", "7 up 12 pack soda", "coke zero"]) {
      expect(getMockWalmartResults(query).some((product) =>
        /great value/i.test(product.title),
      )).toBe(false);
    }
  });
});
