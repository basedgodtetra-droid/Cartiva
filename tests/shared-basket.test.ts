import { describe, expect, it } from "vitest";

import {
  BasketCompleteness,
  summarizeBasket,
} from "@/packages/shared/src";

describe("shared complete-basket rule", () => {
  it("keeps four valid matches for five requests out of complete-total ranking", () => {
    const summary = summarizeBasket([
      { validMatch: true, priceCents: 349 },
      { validMatch: true, priceCents: 429 },
      { validMatch: true, priceCents: 199 },
      { validMatch: true, priceCents: 279 },
      { validMatch: false },
    ]);

    expect(summary).toMatchObject({
      requestedCount: 5,
      validMatchCount: 4,
      pricedMatchCount: 4,
      completeness: BasketCompleteness.INCOMPLETE,
      matchedSubtotalCents: 1_256,
      eligibleForBestCompleteTotal: false,
    });
    expect(summary).not.toHaveProperty("completeTotalCents");
  });

  it("requires a usable price for every valid match before exposing a total", () => {
    const missingPrice = summarizeBasket([
      { validMatch: true, priceCents: 349 },
      { validMatch: true },
    ]);
    expect(missingPrice.completeness).toBe(BasketCompleteness.INCOMPLETE);
    expect(missingPrice.validMatchCount).toBe(2);
    expect(missingPrice.pricedMatchCount).toBe(1);
    expect(missingPrice.completeTotalCents).toBeUndefined();

    const complete = summarizeBasket([
      { validMatch: true, priceCents: 349 },
      { validMatch: true, priceCents: 429 },
    ]);
    expect(complete).toMatchObject({
      completeness: BasketCompleteness.COMPLETE,
      completeTotalCents: 778,
      eligibleForBestCompleteTotal: true,
    });
  });

  it("does not classify an empty request as a complete basket", () => {
    expect(summarizeBasket([])).toEqual({
      requestedCount: 0,
      validMatchCount: 0,
      pricedMatchCount: 0,
      completeness: BasketCompleteness.INCOMPLETE,
      matchedSubtotalCents: 0,
      eligibleForBestCompleteTotal: false,
    });
  });
});
