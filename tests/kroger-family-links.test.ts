import { describe, expect, it } from "vitest";
import { isKrogerFamilyCartUrl, krogerCartUrl, krogerShoppingUrl } from "@/lib/kroger-family-links";

describe("Kroger-family destinations", () => {
  it("uses the selected Kroger-family brand for cart and public shopping links", () => {
    expect(krogerCartUrl("King Soopers")).toBe("https://www.kingsoopers.com/cart");
    expect(krogerShoppingUrl("King Soopers")).toBe("https://www.kingsoopers.com/");
  });

  it("accepts only HTTPS cart paths on known Kroger-family hosts", () => {
    expect(isKrogerFamilyCartUrl("https://www.kroger.com/cart")).toBe(true);
    expect(isKrogerFamilyCartUrl("https://www.ralphs.com/cart/")).toBe(true);
    expect(isKrogerFamilyCartUrl("http://www.kroger.com/cart")).toBe(false);
    expect(isKrogerFamilyCartUrl("https://www.kroger.com.evil.example/cart")).toBe(false);
    expect(isKrogerFamilyCartUrl("https://www.kroger.com/account")).toBe(false);
  });
});
