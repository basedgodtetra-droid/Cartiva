import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CartivaApiError,
  findKrogerLocations,
  getCapabilities,
} from "@/mobile/src/services/cartiva-api";

function headersThenStalledJson() {
  return {
    ok: true,
    status: 200,
    json: () => new Promise<never>(() => undefined),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("__DEV__", true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mobile JSON response deadlines", () => {
  it("times out capabilities when headers arrive but JSON never finishes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => headersThenStalledJson()));
    const assertion = expect(getCapabilities()).rejects.toMatchObject({
      code: "timeout",
    } satisfies Partial<CartivaApiError>);

    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("times out locations when headers arrive but JSON never finishes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => headersThenStalledJson()));
    const assertion = expect(findKrogerLocations("80202")).rejects.toMatchObject({
      code: "timeout",
    } satisfies Partial<CartivaApiError>);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});

describe("mobile retailer response validation", () => {
  const readOnlyCapabilities = {
    apiVersion: "v1",
    access: "ANONYMOUS_READ_ONLY",
    retailers: [{
      id: "kroger",
      label: "Kroger",
      status: "ACTIVE",
      read: { locations: true, productSearch: true },
      handoff: {
        mode: "SHOPPING_PAGE_ONLY",
        cartTransferSupported: false,
        requiresRetailerCheckout: true,
        reason: "Customer cart transfer is not configured.",
      },
    }],
  };

  const locations = {
    retailer: "kroger",
    zipCode: "80202",
    locations: [{
      locationId: "62000115",
      name: "King Soopers - Union Station",
      chain: "King Soopers",
      address: {
        addressLine1: "1950 Chestnut Pl",
        city: "Denver",
        state: "CO",
        zipCode: "80202",
      },
      departments: ["Pickup"],
      handoff: {
        mode: "SHOPPING_PAGE_ONLY",
        url: "https://www.kingsoopers.com/",
        storeSelectionRequired: true,
      },
    }],
  };

  it("accepts the exact truthful read-only capability shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(readOnlyCapabilities)));
    await expect(getCapabilities()).resolves.toEqual(readOnlyCapabilities);
  });

  it("rejects inconsistent cart-transfer capability claims", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...readOnlyCapabilities,
      retailers: [{
        ...readOnlyCapabilities.retailers[0],
        handoff: {
          ...readOnlyCapabilities.retailers[0].handoff,
          cartTransferSupported: true,
        },
      }],
    })));
    await expect(getCapabilities()).rejects.toMatchObject({ code: "response" });
  });

  it("accepts an exact Kroger-family shopping handoff for the requested ZIP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(locations)));
    await expect(findKrogerLocations("80202")).resolves.toEqual(locations);
  });

  it("rejects an untrusted location handoff before it can reach the live result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...locations,
      locations: [{
        ...locations.locations[0],
        handoff: {
          ...locations.locations[0].handoff,
          url: "https://www.kingsoopers.com.evil.example/",
        },
      }],
    })));
    await expect(findKrogerLocations("80202")).rejects.toMatchObject({ code: "response" });
  });

  it("rejects a location response for a different ZIP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...locations, zipCode: "79912" })));
    await expect(findKrogerLocations("80202")).rejects.toMatchObject({ code: "response" });
  });
});
