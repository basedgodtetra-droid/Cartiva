import {
  comparisonContextSignature,
  comparisonListSignature,
} from "./comparison.js";
import type { ComparisonRetailerContext } from "./comparison.js";
import type { ParsedListItem, Retailer } from "./types.js";

export const AUTO_COMPARE_LIST_DEBOUNCE_MS = 1_400;
export const AUTO_COMPARE_ZIP_DEBOUNCE_MS = 400;
export const AUTO_COMPARE_MIN_START_INTERVAL_MS = 1_500;

export function automaticRetailerReady(
  retailer: Retailer,
  context: ComparisonRetailerContext,
) {
  if (!/^\d{5}$/.test(context.zip ?? "")) return false;
  // Target's current comparison route safely supports ZIP-localized estimates.
  // It must not be presented as exact-store verified without store evidence.
  if (retailer === "target") return true;
  return /^\d{1,32}$/.test(context.storeId ?? "");
}

export function automaticComparisonKey(
  items: ParsedListItem[],
  contexts: Record<Retailer, ComparisonRetailerContext>,
) {
  return `${comparisonListSignature(items)}::${comparisonContextSignature(contexts)}`;
}

export function automaticallySelectedStore<T extends { id: string; zip: string }>(
  stores: readonly T[],
  saved: T | undefined,
  zip: string,
) {
  const returnedSaved = saved?.zip === zip
    ? stores.find((store) => store.id === saved.id && store.zip === zip)
    : undefined;
  return returnedSaved ?? stores[0];
}

export function automaticComparisonDelay(
  nowMs: number,
  lastStartedAtMs: number,
) {
  return Math.max(
    AUTO_COMPARE_LIST_DEBOUNCE_MS,
    lastStartedAtMs > 0
      ? lastStartedAtMs + AUTO_COMPARE_MIN_START_INTERVAL_MS - nowMs
      : 0,
  );
}

export function shouldStartAutomaticComparison(
  expectedKey: string | undefined,
  currentKey: string | undefined,
  inFlightKey: string | undefined,
) {
  return Boolean(expectedKey)
    && expectedKey !== currentKey
    && expectedKey !== inFlightKey;
}
