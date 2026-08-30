import type {
  ExtensionSettings,
  FulfillmentMode,
  WalmartStoreLookupResult,
  WalmartStoreOption,
} from "./types.js";

interface WalmartLocationMetadata {
  storeId?: string;
  pickupStore?: string;
  deliveryStore?: string;
}

function validStoreId(value?: string) {
  return value && /^\d{1,8}$/.test(value) ? value : undefined;
}

export function preferredContextStoreId(
  mode: FulfillmentMode,
  metadata: WalmartLocationMetadata | undefined,
  visibleStoreIds: Array<string | undefined> = [],
) {
  const visible = visibleStoreIds.map(validStoreId).find(Boolean);
  if (visible) return visible;
  const modeSpecific = mode === "pickup"
    ? metadata?.pickupStore
    : mode === "delivery"
      ? metadata?.deliveryStore
      : undefined;
  const scoped = validStoreId(modeSpecific);
  if (scoped) return scoped;
  return mode === "unknown" ? validStoreId(metadata?.storeId) : undefined;
}

export function normalizePickupZip(value: string) {
  const zip = value.replace(/\D/g, "").slice(0, 5);
  if (!/^\d{5}$/.test(zip)) {
    throw new Error("Enter a valid 5-digit ZIP code.");
  }
  return zip;
}

export function isWalmartStoreOption(value: unknown): value is WalmartStoreOption {
  if (!value || typeof value !== "object") return false;
  const store = value as Partial<WalmartStoreOption>;
  return typeof store.id === "string"
    && /^\d{1,8}$/.test(store.id)
    && typeof store.name === "string"
    && Boolean(store.name.trim())
    && typeof store.address === "string"
    && Boolean(store.address.trim())
    && typeof store.zip === "string"
    && /^\d{5}$/.test(store.zip);
}

export function parseStoreLookupResult(value: unknown, requestedZip: string): WalmartStoreLookupResult {
  const zip = normalizePickupZip(requestedZip);
  if (!value || typeof value !== "object") {
    throw new Error("Cartiva received an invalid Walmart store response.");
  }
  const payload = value as { zipCode?: unknown; stores?: unknown };
  if (payload.zipCode !== zip || !Array.isArray(payload.stores)) {
    throw new Error("Cartiva received an invalid Walmart store response.");
  }
  const seen = new Set<string>();
  const stores = payload.stores
    .filter((entry): entry is { storeId: string; postalCode: string; address: string; country: "US" } => {
      if (!entry || typeof entry !== "object") return false;
      const store = entry as Record<string, unknown>;
      return typeof store.storeId === "string"
        && /^\d{1,8}$/.test(store.storeId)
        && typeof store.postalCode === "string"
        && /^\d{5}$/.test(store.postalCode)
        && typeof store.address === "string"
        && Boolean(store.address.trim())
        && store.country === "US";
    })
    .filter((store) => {
      if (seen.has(store.storeId)) return false;
      seen.add(store.storeId);
      return true;
    })
    .slice(0, 10)
    .map((store) => ({
      id: store.storeId,
      name: "Walmart pickup store",
      address: store.address.trim(),
      zip: store.postalCode,
    }));
  return { zipCode: zip, stores };
}

export function walmartStoreSelectionUrl(value: string) {
  const zip = normalizePickupZip(value);
  return `https://www.walmart.com/store-finder?location=${encodeURIComponent(zip)}`;
}

export function storeNameForDisplay(value?: string) {
  const name = value
    ?.replace(/\s*(?:walmart\s+)?(?:store\s*)?#\s*\d{1,8}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return name || "Walmart pickup store";
}

export function settingsWithSelectedStore(
  settings: ExtensionSettings,
  store: WalmartStoreOption,
): ExtensionSettings {
  if (!isWalmartStoreOption(store)) throw new Error("Choose a valid Walmart store.");
  return {
    ...settings,
    pickupZip: store.zip,
    selectedStore: { ...store },
    storeIdOverride: undefined,
    fulfillmentModeOverride: "pickup",
  };
}
