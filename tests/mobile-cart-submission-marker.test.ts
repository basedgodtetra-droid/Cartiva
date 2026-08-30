import { describe, expect, it } from "vitest";
import {
  isTrustedKrogerCartUrl,
  parseKrogerCartSubmissionMarker,
} from "../mobile/src/services/cart-submission-marker";

const marker = {
  schemaVersion: 1,
  retailer: "kroger",
  comparisonId: "comparison_current_001",
  locationId: "62000001",
  retailerBanner: "King Soopers",
  phase: "CONFIRMED",
  updatedAt: "2026-08-24T12:00:00.000Z",
};

describe("durable Kroger cart submission marker", () => {
  it("allows only a Kroger-family cart destination", () => {
    expect(isTrustedKrogerCartUrl("https://www.kingsoopers.com/cart")).toBe(true);
    expect(isTrustedKrogerCartUrl("https://www.kroger.com/cart/?fulfillment=pickup")).toBe(false);
    expect(isTrustedKrogerCartUrl("https://www.kroger.com/cart#review")).toBe(false);
    expect(isTrustedKrogerCartUrl("https://www.kingsoopers.com/")).toBe(false);
    expect(isTrustedKrogerCartUrl("https://www.kingsoopers.com/cart/checkout")).toBe(false);
    expect(isTrustedKrogerCartUrl("https://www.kingsoopers.com.evil.example/cart")).toBe(false);
    expect(isTrustedKrogerCartUrl("https://user@www.kingsoopers.com/cart")).toBe(false);
    expect(isTrustedKrogerCartUrl("https://www.kingsoopers.com:444/cart")).toBe(false);
    expect(isTrustedKrogerCartUrl("http://www.kingsoopers.com/cart")).toBe(false);
  });

  it("keeps a valid submitted phase but strips a tampered CTA", () => {
    expect(parseKrogerCartSubmissionMarker(JSON.stringify({
      ...marker,
      handoffUrl: "https://phishing.example/cart",
    }))).toEqual(marker);
  });

  it("rejects markers that are not bound to a valid comparison and store", () => {
    expect(parseKrogerCartSubmissionMarker(JSON.stringify({
      ...marker,
      comparisonId: "short",
    }))).toBeNull();
    expect(parseKrogerCartSubmissionMarker(JSON.stringify({
      ...marker,
      locationId: "store id with spaces",
    }))).toBeNull();
  });
});
