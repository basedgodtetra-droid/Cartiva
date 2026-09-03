import type {
  KrogerMatchResult,
  ProductMeasurement,
  RankedKrogerProduct,
} from "../services/cartiva-api";

function sameOptionalNumber(left: number | undefined, right: number | undefined) {
  return left === right;
}

/**
 * A package-quantity plan belongs to the exact request/candidate pairing that
 * produced it. Reusing it for a differently sized package can silently add the
 * wrong number of units to the retailer cart.
 */
export function hasEquivalentPackageSize(
  left: ProductMeasurement | undefined,
  right: ProductMeasurement | undefined,
) {
  return Boolean(
    left
    && right
    && left.kind === right.kind
    && left.unit === right.unit
    && left.amount === right.amount
    && left.baseUnit === right.baseUnit
    && left.baseAmount === right.baseAmount
    && sameOptionalNumber(left.packCount, right.packCount)
    && sameOptionalNumber(left.perPackageAmount, right.perPackageAmount),
  );
}

/**
 * Applies a shopper-selected alternative without inventing a cart quantity.
 * Same-size candidates can reuse the verified plan (or the legacy list
 * quantity); a package-size change must be revalidated by a new comparison.
 */
export function applyKrogerAlternativeSelection(
  result: KrogerMatchResult,
  candidate: RankedKrogerProduct,
): KrogerMatchResult {
  const previous = result.recommended;
  const packageSizeVerified = hasEquivalentPackageSize(previous?.size, candidate.size);
  const alternatives = [
    ...(previous && previous.id !== candidate.id ? [previous] : []),
    ...result.alternatives.filter((item) => (
      item.id !== candidate.id && item.id !== previous?.id
    )),
  ];
  const {
    clarification: _previousClarification,
    error: _previousError,
    fulfillment: _previousFulfillment,
    resolution: _previousResolution,
    ...baseResult
  } = result;

  if (!packageSizeVerified) {
    return {
      ...baseResult,
      recommended: candidate,
      alternatives,
      confidence: candidate.confidence,
      status: "review",
      resolution: "needs_choice",
      explanation: "This candidate has a different package size and needs a new quantity check.",
      clarification: "Compare again to verify how many of this package fulfill your request.",
    };
  }

  const resolution = candidate.availabilityStatus !== "in_stock"
    ? "matched_check_availability" as const
    : result.fulfillment?.kind === "multi_package"
      ? "multi_package_fulfillment" as const
      : "matched" as const;

  return {
    ...baseResult,
    recommended: candidate,
    alternatives,
    confidence: candidate.confidence,
    status: "matched",
    resolution,
    ...(result.fulfillment ? { fulfillment: result.fulfillment } : {}),
    explanation: "You selected this verified Kroger candidate.",
  };
}
