import { describe, expect, it } from "vitest";
import {
  createWalmartSearchUrl,
  isValidWalmartProductUrl,
  resolveWalmartLink,
} from "@/lib/walmart-url";

describe("Walmart URL safety", () => {
  it("accepts a canonical product URL containing a returned item identifier", () => {
    const url = "https://www.walmart.com/ip/Takis-Fuego-Chips/123456789";
    expect(isValidWalmartProductUrl(url, ["123456789"])).toBe(true);
    expect(resolveWalmartLink("Takis Fuego Chips", url, ["123456789"]).linkType).toBe("product");
  });

  it.each([
    "https://www.walmart.com/ip/demo-takis",
    "https://www.walmart.com/ip/Takis-Fuego-Chips/999999999",
    "https://example.com/ip/Takis-Fuego-Chips/123456789",
    "not a url",
  ])("falls back to Walmart search for fake, stale, or malformed link %s", (sourceUrl) => {
    const resolved = resolveWalmartLink("Takis Fuego Chips, 9.9 oz", sourceUrl, ["123456789"]);
    expect(resolved.linkType).toBe("search");
    expect(resolved.productPageUnavailable).toBe(true);
    expect(resolved.link).toBe(createWalmartSearchUrl("Takis Fuego Chips, 9.9 oz"));
    expect(resolved.link).not.toContain("/ip/");
  });
});
