import { describe, expect, it } from "vitest";
import {
  createTargetSearchUrl,
  isValidTargetProductUrl,
  resolveTargetLink,
  targetProductIdFromUrl,
} from "@/lib/target-url";
import { isValidWalmartProductUrl } from "@/lib/walmart-url";

describe("Target URL identity", () => {
  it("accepts an HTTPS Target product URL only when its TCIN matches", () => {
    const url = "https://www.target.com/p/grade-a-large-eggs-12ct-good-gather/-/A-92186007?preselect=92186007";
    expect(targetProductIdFromUrl(url)).toBe("92186007");
    expect(isValidTargetProductUrl(url, ["92186007"])).toBe(true);
    expect(isValidTargetProductUrl(url, ["11111111"])).toBe(false);
  });

  it("never treats Walmart, non-HTTPS, search, or lookalike hosts as Target product pages", () => {
    expect(isValidTargetProductUrl("https://www.walmart.com/ip/Eggs/92186007", ["92186007"]))
      .toBe(false);
    expect(isValidTargetProductUrl("http://www.target.com/p/-/A-92186007", ["92186007"]))
      .toBe(false);
    expect(isValidTargetProductUrl("https://www.target.com/s?searchTerm=eggs", ["92186007"]))
      .toBe(false);
    expect(isValidTargetProductUrl("https://target.com.example.test/p/-/A-92186007", ["92186007"]))
      .toBe(false);
  });

  it("keeps retailer URL checks mutually exclusive", () => {
    const target = "https://www.target.com/p/-/A-92186007";
    const walmart = "https://www.walmart.com/ip/Eggs/92186007";
    expect(isValidTargetProductUrl(target, ["92186007"])).toBe(true);
    expect(isValidWalmartProductUrl(target, ["92186007"])).toBe(false);
    expect(isValidWalmartProductUrl(walmart, ["92186007"])).toBe(true);
    expect(isValidTargetProductUrl(walmart, ["92186007"])).toBe(false);
  });

  it("uses a safe Target search fallback when exact identity cannot be proven", () => {
    const title = "Grade A Large Eggs - 12ct - Good & Gather";
    const result = resolveTargetLink(
      title,
      "https://www.target.com/p/-/A-11111111",
      ["92186007"],
    );
    expect(result).toMatchObject({
      link: createTargetSearchUrl(title),
      linkType: "search",
      productPageUnavailable: true,
    });
  });
});
