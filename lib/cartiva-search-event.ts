import type { KrogerSearchStreamEvent } from "@/lib/types";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
function validProduct(value: unknown): boolean {
  if (!record(value)) return false;
  return value.retailer === "kroger" && typeof value.title === "string" && typeof value.upc === "string"
    && typeof value.link === "string" && /^https:\/\//.test(value.link)
    && typeof value.price === "number" && Number.isFinite(value.price) && value.price >= 0
    && strings(value.reasons) && strings(value.matchedTerms)
    && record(value.priceProvenance) && record(value.priceProvenance.location)
    && Array.isArray(value.priceProvenance.fulfillment)
    && (value.size === undefined || (record(value.size) && typeof value.size.label === "string" && typeof value.size.baseAmount === "number" && Number.isFinite(value.size.baseAmount)));
}

/** Treat malformed/truncated transport as retryable failure, never product absence. */
export function decodeCartivaSearchEvent(value: unknown, itemCount: number, locationId: string): KrogerSearchStreamEvent {
  const bad = () => { throw new Error("The comparison response was incomplete. Your list is safe. Please compare again."); };
  if (!record(value) || value.retailer !== "kroger" || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) return bad();
  if (value.type === "performance") return value as unknown as KrogerSearchStreamEvent;
  if (value.type !== "item" || !Number.isInteger(value.index) || (value.index as number) < 0 || (value.index as number) >= itemCount
    || !["search", "verification"].includes(String(value.phase)) || !record(value.result)
    || !record(value.diagnostics) || value.diagnostics.locationId !== locationId) return bad();
  const result = value.result;
  if (result.retailer !== "kroger" || typeof result.requestedItem !== "string" || typeof result.explanation !== "string"
    || !["matched", "review", "no_match"].includes(String(result.status))
    || !["high", "medium", "low"].includes(String(result.confidence))
    || !Array.isArray(result.alternatives) || !result.alternatives.every(validProduct)
    || (result.recommended !== null && !validProduct(result.recommended))
    || (result.error !== undefined && typeof result.error !== "string")) return bad();
  if (result.fulfillment !== undefined && (!record(result.fulfillment)
    || !Number.isInteger(result.fulfillment.cartQuantity) || (result.fulfillment.cartQuantity as number) < 1
    || (result.fulfillment.cartQuantity as number) > 99 || typeof result.fulfillment.label !== "string")) return bad();
  return value as unknown as KrogerSearchStreamEvent;
}
