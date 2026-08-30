import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as locationsPost } from "@/app/api/extension/kroger/locations/route";
import { POST as statusPost } from "@/app/api/extension/kroger/auth/status/route";
import { getKrogerAuthClient, krogerAuthIsConfigured } from "@/lib/kroger-auth";
import { findKrogerLocations } from "@/lib/kroger-provider";

vi.mock("@/lib/kroger-provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kroger-provider")>("@/lib/kroger-provider");
  return { ...actual, findKrogerLocations: vi.fn() };
});

vi.mock("@/lib/kroger-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kroger-auth")>("@/lib/kroger-auth");
  return {
    ...actual,
    getKrogerAuthClient: vi.fn(),
    krogerAuthIsConfigured: vi.fn(),
  };
});

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const extensionOrigin = `chrome-extension://${extensionId}`;
const untrustedOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function locationsRequest(origin?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request("http://localhost:3000/api/extension/kroger/locations", {
    method: "POST",
    headers,
    body: JSON.stringify({ zipCode: "75216" }),
  });
}

function statusRequest(origin?: string) {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  return new Request("http://localhost:3000/api/extension/kroger/auth/status", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CARTIVA_EXTENSION_ID", extensionId);
  vi.mocked(findKrogerLocations).mockResolvedValue({
    zipCode: "75216",
    locations: [{
      locationId: "03500213",
      name: "Kroger - Wynnewood Village",
      chain: "KROGER",
      address: {
        addressLine1: "752 Wynnewood Village Shp Ctr",
        city: "Dallas",
        state: "TX",
        zipCode: "75224",
      },
      departments: [],
    }],
    diagnostics: { apiCall: true, cacheHit: false, deduplicated: false, durationMs: 1 },
  });
  vi.mocked(krogerAuthIsConfigured).mockReturnValue(true);
  vi.mocked(getKrogerAuthClient).mockReturnValue({
    connectionStatus: vi.fn(async () => ({ connected: true, profileId: "customer-profile" })),
  } as never);
});

afterEach(() => vi.unstubAllEnvs());

describe("extension Kroger read routes", () => {
  it("accepts a location POST only from the exact configured extension origin", async () => {
    const allowed = await locationsPost(locationsRequest(extensionOrigin));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);
    expect(findKrogerLocations).toHaveBeenCalledWith("75216");

    for (const origin of [undefined, untrustedOrigin]) {
      vi.mocked(findKrogerLocations).mockClear();
      const rejected = await locationsPost(locationsRequest(origin));
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(findKrogerLocations).not.toHaveBeenCalled();
    }
  });

  it("accepts a status POST only from the exact configured extension origin", async () => {
    const allowed = await statusPost(statusRequest(extensionOrigin));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);
    expect(await allowed.json()).toMatchObject({ connected: true, configured: true });

    for (const origin of [undefined, untrustedOrigin]) {
      vi.mocked(getKrogerAuthClient).mockClear();
      const rejected = await statusPost(statusRequest(origin));
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(getKrogerAuthClient).not.toHaveBeenCalled();
    }
  });
});
