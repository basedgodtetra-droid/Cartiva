import {
  isBuildEligible,
  isKrogerBuildEligible,
  isReliableTargetMatch,
} from "./totals.js";
import type {
  ComparisonRetailerState,
  ComparisonSearchState,
  FulfillmentMode,
  ParsedListItem,
  PreparedItem,
  Retailer,
} from "./types.js";

export const COMPARISON_RETAILERS = ["walmart", "target", "kroger"] as const satisfies readonly Retailer[];

export interface ComparisonRetailerContext {
  fulfillmentMode: FulfillmentMode;
  storeId?: string;
  zip?: string;
}

export interface BasketComparison {
  retailer: Retailer;
  status: ComparisonRetailerState["status"];
  totalCents: number;
  reliableCount: number;
  requestedCount: number;
  coveragePercent: number;
  comparable: boolean;
  basis: "verified" | "estimate" | "incomplete";
  promoSavingsCents: number;
  hasConditionalPromo: boolean;
  reason?: string;
}

export interface ComparisonEvaluation {
  status: "waiting" | "ready" | "only_complete" | "no_comparable_basket";
  baskets: Record<Retailer, BasketComparison>;
  lowestComparableRetailer?: Retailer;
  lowestVerifiedRetailer?: Retailer;
  tiedLowestRetailers: Retailer[];
  completeBasketCount: number;
  comparableBasketCount: number;
  verifiedBasketCount: number;
}

function stableListItem(item: ParsedListItem) {
  return {
    text: item.normalizedText,
    quantity: item.quantity,
    brand: item.brand ?? "",
    size: item.size ?? "",
    packCount: item.packCount ?? 0,
    preferredProductId: item.preferredProductId ?? "",
    preferredItemId: item.preferredItemId ?? "",
    preferredTitle: item.preferredTitle ?? "",
  };
}

export function comparisonListSignature(items: ParsedListItem[]) {
  return JSON.stringify(items.map(stableListItem));
}

export function comparisonContextSignature(
  contexts: Record<Retailer, ComparisonRetailerContext>,
) {
  return JSON.stringify(COMPARISON_RETAILERS.map((retailer) => ({
    retailer,
    fulfillmentMode: contexts[retailer].fulfillmentMode,
    storeId: contexts[retailer].storeId ?? "",
    zip: contexts[retailer].zip?.replace(/\D/g, "").slice(0, 5) ?? "",
  })));
}

export function comparisonRetailerContextSignature(
  retailer: Retailer,
  context: ComparisonRetailerContext,
) {
  return JSON.stringify({
    retailer,
    fulfillmentMode: context.fulfillmentMode,
    storeId: context.storeId ?? "",
    zip: context.zip?.replace(/\D/g, "").slice(0, 5) ?? "",
  });
}

export function emptyComparisonSearchState(
  listSignature: string,
  contexts: Record<Retailer, ComparisonRetailerContext>,
  requestedCount: number,
): ComparisonSearchState {
  const contextSignature = comparisonContextSignature(contexts);
  const retailerState = (retailer: Retailer): ComparisonRetailerState => ({
    status: "idle",
    items: [],
    contextSignature: comparisonRetailerContextSignature(retailer, contexts[retailer]),
  });
  return {
    version: 1,
    status: "idle",
    listSignature,
    contextSignature,
    requestedCount,
    retailers: {
      walmart: retailerState("walmart"),
      target: retailerState("target"),
      kroger: retailerState("kroger"),
    },
  };
}

function reliableFor(
  retailer: Retailer,
  item: PreparedItem,
  context: ComparisonRetailerContext,
  nowMs: number,
) {
  if (retailer === "target") {
    return isReliableTargetMatch(item, context.fulfillmentMode, nowMs);
  }
  if (retailer === "kroger") {
    return isKrogerBuildEligible(item, context.fulfillmentMode, nowMs, context.storeId);
  }
  return isBuildEligible(item, context.fulfillmentMode, nowMs, context.storeId);
}

function exactVerifiedPrice(retailer: Retailer, item: PreparedItem) {
  const provenance = item.product?.priceProvenance;
  if (retailer === "walmart") {
    return provenance?.localPriceVerified === true
      && provenance.priceScope === "exact_store"
      && provenance.searchStoreMatched !== false
      && provenance.detailStoreMatched !== false;
  }
  return provenance?.exactStoreVerified === true && provenance.priceReliability === "verified";
}

function comparisonPriceCents(retailer: Retailer, item: PreparedItem) {
  const priceCents = item.product?.priceCents;
  if (!Number.isInteger(priceCents) || priceCents! <= 0) return undefined;
  const provenance = item.product?.priceProvenance;
  const regular = provenance?.regularPriceCents;
  const promo = provenance?.promoPriceCents;
  if (
    retailer === "kroger"
    && provenance?.promoUnconditional !== true
    && Number.isInteger(promo)
    && promo! > 0
    && (!Number.isInteger(regular) || regular! <= 0)
  ) return undefined;
  if (
    retailer === "kroger"
    && provenance?.promoUnconditional !== true
    && Number.isInteger(regular)
    && regular! > 0
    && Number.isInteger(promo)
    && promo! > 0
  ) {
    return regular;
  }
  return priceCents;
}

function explicitRequestedMeasurement(request: ParsedListItem) {
  if (!request.size) return undefined;
  const match = request.size.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|gallons?|gal|liters?|litres?|l|count|ct)\b/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2].replace(/\s+/g, " ");
  if (unit === "lb" || unit === "lbs" || unit.startsWith("pound")) {
    return { kind: "weight" as const, baseUnit: "oz" as const, baseAmount: amount * 16 };
  }
  if (unit === "fl oz" || unit.startsWith("fluid ounce")) {
    return { kind: "volume" as const, baseUnit: "fl oz" as const, baseAmount: amount };
  }
  if (unit === "gal" || unit.startsWith("gallon")) {
    return { kind: "volume" as const, baseUnit: "fl oz" as const, baseAmount: amount * 128 };
  }
  if (unit === "l" || unit.startsWith("liter") || unit.startsWith("litre")) {
    return { kind: "volume" as const, baseUnit: "fl oz" as const, baseAmount: amount * 33.814 };
  }
  if (unit === "count" || unit === "ct") {
    return { kind: "count" as const, baseUnit: "each" as const, baseAmount: amount };
  }
  return { kind: "weight" as const, baseUnit: "oz" as const, baseAmount: amount };
}

function closeMeasurement(left: number, right: number, count: boolean) {
  if (count) return left === right;
  const tolerance = Math.max(0.05, Math.max(left, right) * 0.02);
  return Math.abs(left - right) <= tolerance;
}

function measurementMatchesRequest(item: PreparedItem) {
  const measurement = item.product?.size;
  if (!measurement) return false;
  if (item.estimatedByWeight === true && !item.request.size) return false;
  const explicit = explicitRequestedMeasurement(item.request);
  const productAmountForRequest = item.request.packCount !== undefined
    && measurement.packCount === item.request.packCount
    && Number.isFinite(measurement.perPackageAmount)
    && measurement.perPackageAmount! > 0
      ? measurement.perPackageAmount!
      : measurement.baseAmount;
  if (explicit && (
    measurement.kind !== explicit.kind
    || measurement.baseUnit !== explicit.baseUnit
    || !closeMeasurement(productAmountForRequest, explicit.baseAmount, explicit.kind === "count")
  )) return false;
  if (item.request.packCount !== undefined) {
    const matchesCount = measurement.kind === "count" && measurement.baseAmount === item.request.packCount;
    const matchesPack = measurement.packCount === item.request.packCount;
    if (!matchesCount && !matchesPack) return false;
  }
  return true;
}

function equivalentLine(left: PreparedItem, right: PreparedItem) {
  if (!measurementMatchesRequest(left) || !measurementMatchesRequest(right)) return false;
  const leftSize = left.product!.size!;
  const rightSize = right.product!.size!;
  if (leftSize.kind !== rightSize.kind || leftSize.baseUnit !== rightSize.baseUnit) return false;
  if (left.request.packCount !== undefined || right.request.packCount !== undefined) {
    if (leftSize.packCount !== rightSize.packCount) {
      const bothTotalCount = leftSize.kind === "count" && rightSize.kind === "count"
        && leftSize.baseAmount === rightSize.baseAmount;
      if (!bothTotalCount) return false;
    }
  }
  return closeMeasurement(leftSize.baseAmount, rightSize.baseAmount, leftSize.kind === "count");
}

function equivalentBaskets(
  left: ComparisonRetailerState,
  right: ComparisonRetailerState,
  requests: ParsedListItem[],
) {
  const leftById = new Map(left.items.map((item) => [item.id, item]));
  const rightById = new Map(right.items.map((item) => [item.id, item]));
  return requests.every((request) => {
    const leftItem = leftById.get(request.id);
    const rightItem = rightById.get(request.id);
    return Boolean(leftItem && rightItem && equivalentLine(leftItem, rightItem));
  });
}

function basketFor(
  retailer: Retailer,
  retailerState: ComparisonRetailerState,
  requests: ParsedListItem[],
  context: ComparisonRetailerContext,
  nowMs: number,
): BasketComparison {
  const byId = new Map<string, PreparedItem>();
  let duplicate = false;
  for (const item of retailerState.items) {
    if (byId.has(item.id)) duplicate = true;
    byId.set(item.id, item);
  }
  const requestedItems = requests.map((request) => byId.get(request.id));
  const terminal = retailerState.status === "complete" || retailerState.status === "error";
  const reliableItems = requestedItems.filter((item): item is PreparedItem => Boolean(
    item
      && item.matchStatus !== "searching"
      && reliableFor(retailer, item, context, nowMs)
      && comparisonPriceCents(retailer, item) !== undefined
      && measurementMatchesRequest(item),
  ));
  const reliableCount = reliableItems.length;
  const requestedCount = requests.length;
  const totalCents = reliableItems.reduce(
    (total, item) => total + comparisonPriceCents(retailer, item)! * item.request.quantity,
    0,
  );
  const promoSavingsCents = retailer === "kroger" ? reliableItems.reduce((total, item) => {
    const provenance = item.product?.priceProvenance;
    const regular = provenance?.regularPriceCents;
    const promo = provenance?.promoPriceCents;
    return Number.isInteger(regular) && Number.isInteger(promo) && regular! > promo! && promo! > 0
      ? total + (regular! - promo!) * item.request.quantity
      : total;
  }, 0) : 0;
  const hasConditionalPromo = retailer === "kroger" && requestedItems.some((item) => {
    const provenance = item?.product?.priceProvenance;
    const regular = provenance?.regularPriceCents;
    const promo = provenance?.promoPriceCents;
    return provenance?.promoUnconditional !== true
      && Number.isInteger(regular)
      && regular! > 0
      && Number.isInteger(promo)
      && promo! > 0
      && promo! < regular!;
  });
  const complete = terminal
    && retailerState.status === "complete"
    && !duplicate
    && retailerState.items.length === requestedCount
    && requestedItems.every(Boolean)
    && reliableCount === requestedCount
    && requestedCount > 0;
  const basis = complete
    ? reliableItems.every((item) => exactVerifiedPrice(retailer, item)) ? "verified" : "estimate"
    : "incomplete";
  const reason = complete
    ? undefined
    : !terminal
      ? "Still checking this basket."
      : retailerState.status === "error"
        ? retailerState.error ?? "This retailer search did not finish."
        : reliableCount < requestedCount
          ? `${requestedCount - reliableCount} ${requestedCount - reliableCount === 1 ? "item is" : "items are"} missing or not reliably priced.`
          : "This basket could not be compared safely.";
  return {
    retailer,
    status: retailerState.status,
    totalCents,
    reliableCount,
    requestedCount,
    coveragePercent: requestedCount ? Math.round((reliableCount / requestedCount) * 100) : 0,
    comparable: complete,
    basis,
    promoSavingsCents,
    hasConditionalPromo,
    reason,
  };
}

const RETAILER_ORDER: Record<Retailer, number> = { walmart: 0, target: 1, kroger: 2 };

function rankBaskets(baskets: BasketComparison[]) {
  return [...baskets].sort((left, right) => (
    left.totalCents - right.totalCents
    || (left.basis === right.basis ? 0 : left.basis === "verified" ? -1 : 1)
    || RETAILER_ORDER[left.retailer] - RETAILER_ORDER[right.retailer]
  ));
}

function largestEquivalentGroup(
  baskets: BasketComparison[],
  comparison: ComparisonSearchState,
  requests: ParsedListItem[],
) {
  const ordered = [...baskets].sort((left, right) => RETAILER_ORDER[left.retailer] - RETAILER_ORDER[right.retailer]);
  const groups: BasketComparison[][] = [];
  for (let mask = 1; mask < (1 << ordered.length); mask += 1) {
    const group = ordered.filter((_, index) => (mask & (1 << index)) !== 0);
    if (group.length < 2) continue;
    const pairwiseEquivalent = group.every((left, leftIndex) => group.every((right, rightIndex) => (
      leftIndex >= rightIndex || equivalentBaskets(
        comparison.retailers[left.retailer],
        comparison.retailers[right.retailer],
        requests,
      )
    )));
    if (pairwiseEquivalent) groups.push(group);
  }
  const sorted = groups.sort((left, right) => right.length - left.length);
  const largest = sorted[0]?.length ?? 0;
  const maximal = sorted.filter((group) => group.length === largest);
  return maximal.length === 1 ? maximal[0] : [];
}

export function evaluateComparison(
  comparison: ComparisonSearchState,
  requests: ParsedListItem[],
  contexts: Record<Retailer, ComparisonRetailerContext>,
  nowMs = Date.now(),
): ComparisonEvaluation {
  const expectedListSignature = comparisonListSignature(requests);
  const expectedContextSignature = comparisonContextSignature(contexts);
  const stateIsCurrent = comparison.listSignature === expectedListSignature
    && comparison.contextSignature === expectedContextSignature
    && comparison.requestedCount === requests.length
    && COMPARISON_RETAILERS.every((retailer) => (
      comparison.retailers[retailer].contextSignature
        === comparisonRetailerContextSignature(retailer, contexts[retailer])
    ));
  const baskets = Object.fromEntries(COMPARISON_RETAILERS.map((retailer) => [
    retailer,
    basketFor(retailer, comparison.retailers[retailer], requests, contexts[retailer], nowMs),
  ])) as Record<Retailer, BasketComparison>;
  if (!stateIsCurrent) {
    for (const basket of Object.values(baskets)) {
      basket.comparable = false;
      basket.basis = "incomplete";
      basket.reason = "The list or store setup changed. Compare again for current prices.";
    }
    return {
      status: "no_comparable_basket",
      baskets,
      tiedLowestRetailers: [],
      completeBasketCount: 0,
      comparableBasketCount: 0,
      verifiedBasketCount: 0,
    };
  }
  const allTerminal = COMPARISON_RETAILERS.every((retailer) => (
    comparison.retailers[retailer].status === "complete"
    || comparison.retailers[retailer].status === "error"
  ));
  const completeBaskets = COMPARISON_RETAILERS
    .map((retailer) => baskets[retailer])
    .filter((basket) => basket.comparable);
  const equivalentGroup = largestEquivalentGroup(completeBaskets, comparison, requests);
  const equivalentRetailers = new Set(equivalentGroup.map((basket) => basket.retailer));
  const comparableBaskets = completeBaskets.filter((basket) => equivalentRetailers.has(basket.retailer));
  if (allTerminal && completeBaskets.length >= 2) {
    for (const basket of completeBaskets) {
      if (equivalentRetailers.has(basket.retailer)) continue;
      basket.comparable = false;
      basket.basis = "incomplete";
      basket.reason = "Package sizes differ or size evidence is missing. Specify sizes for a fair comparison.";
    }
  }
  const canNameLowest = allTerminal && comparableBaskets.length >= 2;
  const ranked = canNameLowest ? rankBaskets(comparableBaskets) : [];
  const lowest = ranked[0];
  const exactRanked = canNameLowest
    ? rankBaskets(comparableBaskets.filter((basket) => basket.basis === "verified"))
    : [];
  const tiedLowestRetailers = lowest
    ? ranked.filter((basket) => basket.totalCents === lowest.totalCents).map((basket) => basket.retailer)
    : [];
  return {
    status: !allTerminal
      ? "waiting"
      : comparableBaskets.length >= 2
        ? "ready"
        : completeBaskets.length === 1
          ? "only_complete"
          : "no_comparable_basket",
    baskets,
    lowestComparableRetailer: lowest?.retailer,
    lowestVerifiedRetailer: exactRanked.length >= 2 ? exactRanked[0]?.retailer : undefined,
    tiedLowestRetailers,
    completeBasketCount: completeBaskets.length,
    comparableBasketCount: comparableBaskets.length,
    verifiedBasketCount: completeBaskets.filter((basket) => basket.basis === "verified").length,
  };
}
