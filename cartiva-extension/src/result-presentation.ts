import type { CartItemStatus, PreparedItem, Retailer } from "./types.js";

export type ResultDisplayStatus =
  | "searching"
  | "matched"
  | "best_match"
  | "couldnt_verify"
  | "no_match"
  | "api_error"
  | Exclude<CartItemStatus, "ready">;

/**
 * Presentation must never loosen Cartiva's cart boundary. A reasonable
 * assumption gets the friendlier label only after the existing strict
 * eligibility checks pass; every unverified result remains excluded.
 */
export function resultDisplayStatus(
  item: PreparedItem,
  strictlyEligible: boolean,
  buildStatus?: CartItemStatus,
): ResultDisplayStatus {
  if (buildStatus && buildStatus !== "ready") return buildStatus;
  if (item.matchStatus === "matched") {
    if (!strictlyEligible) return "couldnt_verify";
    return item.assumptions?.length ? "best_match" : "matched";
  }
  if (item.matchStatus === "needs_review") return "couldnt_verify";
  return item.matchStatus;
}

export const RESULT_STATUS_LABELS: Record<ResultDisplayStatus, string> = {
  searching: "Searching",
  matched: "Matched",
  best_match: "Best reasonable match",
  couldnt_verify: "Couldn't verify",
  no_match: "No reliable match",
  api_error: "Walmart unavailable",
  adding: "Adding",
  added: "Added",
  needs_choice: "Needs choice",
  unavailable: "Unavailable",
  failed: "Failed",
  skipped: "Skipped",
};

export function resultStatusLabel(status: ResultDisplayStatus, retailer: Retailer = "walmart") {
  if (status === "api_error") {
    return retailer === "target"
      ? "Target unavailable"
      : retailer === "kroger"
        ? "Kroger unavailable"
        : "Walmart unavailable";
  }
  return RESULT_STATUS_LABELS[status];
}
