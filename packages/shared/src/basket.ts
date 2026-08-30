import { BasketCompleteness } from "./types";

/**
 * The minimum retailer-neutral facts needed to decide whether a required
 * basket line can participate in a complete price comparison.
 */
export interface BasketLineSummaryInput {
  /** True only after product identity and every shopper constraint pass. */
  validMatch: boolean;
  /** A usable current price for the accepted match, expressed in cents. */
  priceCents?: number;
}

export interface BasketSummary {
  requestedCount: number;
  validMatchCount: number;
  pricedMatchCount: number;
  completeness: (typeof BasketCompleteness)[keyof typeof BasketCompleteness];
  /** Partial arithmetic, safe to display only when clearly labeled subtotal. */
  matchedSubtotalCents: number;
  /** Present only when every required line has a valid, priced match. */
  completeTotalCents?: number;
  /** Incomplete baskets must never compete for "best complete total." */
  eligibleForBestCompleteTotal: boolean;
}

function isUsablePriceCents(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Summarizes one entry per required shopper item. An empty basket is not a
 * complete comparison, and a valid match without a usable price cannot make a
 * basket eligible for total-price ranking.
 */
export function summarizeBasket(
  lines: readonly BasketLineSummaryInput[],
): BasketSummary {
  const validMatchCount = lines.filter((line) => line.validMatch).length;
  const pricedMatches = lines.filter(
    (line) => line.validMatch && isUsablePriceCents(line.priceCents),
  );
  const requestedCount = lines.length;
  const pricedMatchCount = pricedMatches.length;
  const eligibleForBestCompleteTotal = requestedCount > 0
    && validMatchCount === requestedCount
    && pricedMatchCount === requestedCount;
  const matchedSubtotalCents = pricedMatches.reduce(
    (total, line) => total + (line.priceCents ?? 0),
    0,
  );

  return {
    requestedCount,
    validMatchCount,
    pricedMatchCount,
    completeness: eligibleForBestCompleteTotal
      ? BasketCompleteness.COMPLETE
      : BasketCompleteness.INCOMPLETE,
    matchedSubtotalCents,
    ...(eligibleForBestCompleteTotal
      ? { completeTotalCents: matchedSubtotalCents }
      : {}),
    eligibleForBestCompleteTotal,
  };
}
