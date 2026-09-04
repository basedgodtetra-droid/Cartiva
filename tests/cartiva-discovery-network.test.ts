import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBufferedResponse } from "@/lib/browser-request";
import { decodeCartivaSearchEvent } from "@/lib/cartiva-search-event";
import { getCartivaKrogerPreflight } from "@/lib/cartiva-kroger-connection";
import { enforceRateLimit, resetRateLimitsForTests } from "@/lib/api-security";
import { findKrogerLocations, resetKrogerProviderForTests, searchKrogerProducts } from "@/lib/kroger-provider";
import type { KrogerAuthClient } from "@/lib/kroger-auth";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(() => { resetRateLimitsForTests(); resetKrogerProviderForTests(); });
describe("discovery: network boundaries", () => {
  it.each(["headers", "body"])("bounds stalled %s", async (phase) => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => phase === "headers" ? new Promise(() => {}) : Promise.resolve({ text: () => new Promise(() => {}) })));
    const result = fetchBufferedResponse("/api/test", {}, 100);
    const failure = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(101); await failure;
  });
  it.each([200, 401, 429, 500])( "preserves HTTP %s and its decoded body", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "test" }, { status })));
    const response = await fetchBufferedResponse("/api/test");
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: "test" });
  });
  it.each([null, {}, [], { connected: "true" }])("rejects malformed connection %j", (body) => {
    expect(getCartivaKrogerPreflight(true, body).state).toBe("unavailable");
  });
  it.each([{}, { data: null }, { data: {} }, { data: "not products" }])("does not confuse malformed catalog %j with no match", async (body) => {
    const auth = { fetchPublic: async () => Response.json(body) } as unknown as KrogerAuthClient;
    await expect(findKrogerLocations("75204", auth)).rejects.toMatchObject({ code: "bad_response" });
    await expect(searchKrogerProducts("rice", { locationId: "03500529", locationVerified: true, fulfillmentMode: "pickup" }, auth)).rejects.toMatchObject({ code: "bad_response" });
  });
  it("rejects wrong indices, wrong stores, null items and malformed product structures", () => {
    const event = { type: "item", retailer: "kroger", checkedAt: new Date().toISOString(), phase: "verification", index: 0,
      diagnostics: { locationId: "store-a" }, result: { retailer: "kroger", requestedItem: "rice", recommended: null, alternatives: [], status: "no_match", confidence: "low", explanation: "No compatible rice" } };
    expect(decodeCartivaSearchEvent(event, 1, "store-a")).toEqual(event);
    for (const bad of [null, { ...event, index: -1 }, { ...event, index: 2 }, { ...event, result: null }, { ...event, result: { ...event.result, recommended: {} } }]) {
      expect(() => decodeCartivaSearchEvent(bad, 1, "store-a")).toThrow(/incomplete/);
    }
    expect(() => decodeCartivaSearchEvent(event, 1, "store-b")).toThrow(/incomplete/);
  });
});

describe("discovery: platform rate isolation", () => {
  const request = (ip: string, extra: Record<string, string> = {}) => new Request("https://cartiva-smoky.vercel.app/api/kroger/cart", { headers: { "x-vercel-forwarded-for": ip, ...extra } });
  const limit = (req: Request) => enforceRateLimit(req, "discovery", { limit: 1, windowMs: 60000 });
  it("separates genuine Vercel addresses without letting Origin reset a bucket", () => {
    vi.stubEnv("VERCEL", "1");
    expect(limit(request("192.0.2.1"))).toBeNull(); expect(limit(request("192.0.2.2"))).toBeNull();
    expect(limit(request("192.0.2.1", { Origin: "https://different.example", "User-Agent": "different" }))?.status).toBe(429);
  });
  it("ignores spoofed platform/proxy headers outside the trusted deployment", () => {
    vi.stubEnv("VERCEL", ""); vi.stubEnv("CARTIVA_TRUSTED_EDGE", "");
    expect(limit(request("192.0.2.1"))).toBeNull();
    expect(limit(request("192.0.2.2", { "CF-Connecting-IP": "192.0.2.3" }))?.status).toBe(429);
  });
});
