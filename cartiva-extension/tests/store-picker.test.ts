import { describe, expect, it } from "vitest";
import {
  isWalmartStoreOption,
  normalizePickupZip,
  parseStoreLookupResult,
  preferredContextStoreId,
  settingsWithSelectedStore,
  storeNameForDisplay,
} from "../src/store-picker";
import type { ExtensionSettings, WalmartStoreOption } from "../src/types";

const dallasStore: WalmartStoreOption = {
  id: "3014",
  name: "Walmart pickup store",
  address: "200 Short Blvd, Dallas, TX 75216",
  zip: "75216",
};

const backendDallasStore = {
  storeId: "3014",
  postalCode: "75216",
  address: "200 Short Blvd, Dallas, TX 75216",
  country: "US",
};

describe("pickup ZIP normalization", () => {
  it("normalizes common ZIP input to exactly five digits", () => {
    expect(normalizePickupZip(" 75216 ")).toBe("75216");
    expect(normalizePickupZip("75216-4820")).toBe("75216");
  });

  it("rejects input that cannot provide a five-digit ZIP", () => {
    expect(() => normalizePickupZip("7521")).toThrow(/5-digit ZIP/i);
    expect(() => normalizePickupZip("Dallas")).toThrow(/5-digit ZIP/i);
  });
});

describe("Walmart store response validation", () => {
  it("accepts a complete backend store without DOM-only selection or distance fields", () => {
    expect(isWalmartStoreOption(dallasStore)).toBe(true);
    expect(parseStoreLookupResult({
      zipCode: "75216",
      stores: [backendDallasStore],
      totalMatches: 1,
    }, "75216")).toEqual({
      zipCode: "75216",
      stores: [dallasStore],
    });
  });

  it("rejects malformed store identities and malformed response envelopes", () => {
    expect(isWalmartStoreOption({ ...dallasStore, id: "store-3014" })).toBe(false);
    expect(isWalmartStoreOption({ ...dallasStore, address: " " })).toBe(false);
    expect(() => parseStoreLookupResult({
      zipCode: "75217",
      stores: [backendDallasStore],
      totalMatches: 1,
    }, "75216")).toThrow(/invalid Walmart store response/i);
  });
});

describe("nearby store filtering", () => {
  it("returns valid nearby stores from the trusted backend", () => {
    const result = parseStoreLookupResult({
      zipCode: "75216",
      stores: [
        backendDallasStore,
        { ...backendDallasStore, storeId: "3015", postalCode: "75220", address: "9410 Webb Chapel Rd" },
        { ...backendDallasStore, storeId: "2201", postalCode: "79925", address: "7101 Gateway Blvd W" },
        { ...backendDallasStore, storeId: "invalid" },
        { ...backendDallasStore, address: "Duplicate store record" },
      ],
      totalMatches: 5,
    }, "75216-4820");

    expect(result).toEqual({
      zipCode: "75216",
      stores: [
        dallasStore,
        {
          id: "3015",
          name: "Walmart pickup store",
          address: "9410 Webb Chapel Rd",
          zip: "75220",
        },
        {
          id: "2201",
          name: "Walmart pickup store",
          address: "7101 Gateway Blvd W",
          zip: "79925",
        },
      ],
    });
  });

  it("leaves malformed nearby results empty so the caller can use Walmart's visible finder", () => {
    expect(parseStoreLookupResult({
      zipCode: "75216",
      stores: [{ ...backendDallasStore, postalCode: "not-a-zip" }],
      totalMatches: 1,
    }, "75216")).toEqual({ zipCode: "75216", stores: [] });
  });
});

describe("selected-store settings update", () => {
  it("updates the store, ZIP, and pickup mode together without mutating inputs", () => {
    const settings: ExtensionSettings = {
      backendBaseUrl: "http://localhost:3000",
      pickupZip: "75217",
      selectedStore: { ...dallasStore, id: "3015", zip: "75217" },
      storeIdOverride: "9999",
      fulfillmentModeOverride: "delivery",
    };
    const originalSettings = structuredClone(settings);
    const originalStore = structuredClone(dallasStore);

    const updated = settingsWithSelectedStore(settings, dallasStore);

    expect(updated).toEqual({
      backendBaseUrl: "http://localhost:3000",
      pickupZip: "75216",
      selectedStore: dallasStore,
      storeIdOverride: undefined,
      fulfillmentModeOverride: "pickup",
    });
    expect(updated).not.toBe(settings);
    expect(updated.selectedStore).not.toBe(dallasStore);
    expect(settings).toEqual(originalSettings);
    expect(dallasStore).toEqual(originalStore);
  });
});

describe("shopper-facing store labels", () => {
  it("keeps Walmart's internal store number out of the visible store name", () => {
    expect(storeNameForDisplay("Dallas Supercenter #3014")).toBe("Dallas Supercenter");
    expect(storeNameForDisplay("Walmart Store #3014")).toBe("Walmart pickup store");
  });
});

describe("fulfillment-scoped Walmart location metadata", () => {
  it("prefers the pickup or delivery store over a stale generic store ID", () => {
    const metadata = {
      storeId: "9999",
      pickupStore: "3014",
      deliveryStore: "2201",
    };
    expect(preferredContextStoreId("pickup", metadata)).toBe("3014");
    expect(preferredContextStoreId("delivery", metadata)).toBe("2201");
  });

  it("uses strong visible evidence first and does not use generic metadata for a known mode", () => {
    const metadata = { storeId: "9999" };
    expect(preferredContextStoreId("pickup", metadata, [undefined, "3014"])).toBe("3014");
    expect(preferredContextStoreId("pickup", metadata)).toBeUndefined();
    expect(preferredContextStoreId("unknown", metadata)).toBe("9999");
  });
});
