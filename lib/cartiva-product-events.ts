export const CARTIVA_PRODUCT_EVENT_NAMES = [
  "page_view",
  "list_started",
  "item_added",
  "list_pasted",
  "clarification_requested",
  "clarification_completed",
  "zip_entered",
  "store_selected",
  "comparison_started",
  "comparison_completed",
  "comparison_failed",
  "basket_saved",
  "list_saved",
  "price_history_viewed",
  "kroger_handoff_started",
  "kroger_cart_added",
] as const;

export type CartivaProductEventName = typeof CARTIVA_PRODUCT_EVENT_NAMES[number];

export interface CartivaProductEventProperties {
  route?: string;
  source?: "single" | "paste" | "automatic" | "manual";
  retailer?: "kroger";
  fulfillmentMode?: "pickup" | "delivery";
  itemCount?: number;
  addedCount?: number;
  readyCount?: number;
  clarificationCount?: number;
  matchedCount?: number;
  storeCount?: number;
  complete?: boolean;
  retrySafe?: boolean;
}

export interface CartivaProductEvent {
  schemaVersion: 1;
  name: CartivaProductEventName;
  occurredAt: string;
  properties: CartivaProductEventProperties;
}

function safeCount(value: number | undefined) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(999, Math.floor(value ?? 0)));
}

function safeRoute(value: string | undefined) {
  if (!value) return undefined;
  const pathname = value.split(/[?#]/, 1)[0];
  return /^\/[a-z0-9/-]{0,80}$/i.test(pathname) ? pathname : undefined;
}

export function buildCartivaProductEvent(
  name: CartivaProductEventName,
  properties: CartivaProductEventProperties = {},
  occurredAt = new Date().toISOString(),
): CartivaProductEvent {
  const counts = {
    itemCount: safeCount(properties.itemCount),
    addedCount: safeCount(properties.addedCount),
    readyCount: safeCount(properties.readyCount),
    clarificationCount: safeCount(properties.clarificationCount),
    matchedCount: safeCount(properties.matchedCount),
    storeCount: safeCount(properties.storeCount),
  };
  return {
    schemaVersion: 1,
    name,
    occurredAt,
    properties: {
      ...(safeRoute(properties.route) ? { route: safeRoute(properties.route) } : {}),
      ...(properties.source ? { source: properties.source } : {}),
      ...(properties.retailer ? { retailer: properties.retailer } : {}),
      ...(properties.fulfillmentMode ? { fulfillmentMode: properties.fulfillmentMode } : {}),
      ...Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== undefined)),
      ...(properties.complete === undefined ? {} : { complete: properties.complete }),
      ...(properties.retrySafe === undefined ? {} : { retrySafe: properties.retrySafe }),
    },
  };
}

/**
 * First-party, transport-free product events. Cartiva emits only coarse flow
 * metadata: never grocery text, ZIP codes, store IDs, UPCs, or account data.
 * A consent-aware analytics adapter can subscribe to `cartiva:product-event`
 * later without changing product components or silently transmitting data now.
 */
export function trackCartivaEvent(
  name: CartivaProductEventName,
  properties: CartivaProductEventProperties = {},
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<CartivaProductEvent>(
    "cartiva:product-event",
    { detail: buildCartivaProductEvent(name, properties) },
  ));
}
