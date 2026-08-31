import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enforceRateLimit,
  enforcePublicReadRateLimit,
  hasValidSearchItemShape,
  readValidatedJson,
  resetRateLimitsForTests,
  trustValidatedExtensionRequest,
  validateLocalApiRequest,
} from "@/lib/api-security";

function jsonRequest(
  url = "http://127.0.0.1:3000/api/search",
  body: unknown = { items: ["eggs"] },
  headers: Record<string, string> = {},
) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => resetRateLimitsForTests());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("local API security boundary", () => {
  it("rejects non-loopback and cross-origin direct API requests", () => {
    expect(validateLocalApiRequest(jsonRequest("https://cartiva.example/api/search"))?.status)
      .toBe(403);
    expect(validateLocalApiRequest(jsonRequest(
      "http://127.0.0.1:3000/api/search",
      {},
      { Origin: "https://attacker.example" },
    ))?.status).toBe(403);
  });

  it("accepts equivalent loopback aliases used by a local reverse proxy", () => {
    expect(validateLocalApiRequest(jsonRequest(
      "http://localhost:3000/api/search",
      {},
      { Origin: "http://127.0.0.1:3000", "Sec-Fetch-Site": "same-origin" },
    ))).toBeNull();
  });

  it("accepts the explicitly configured Cartiva website and no other hosted origin", () => {
    vi.stubEnv("CARTIVA_PUBLIC_ORIGIN", "https://preview.cartiva.example");
    expect(validateLocalApiRequest(jsonRequest(
      "https://preview.cartiva.example/api/search",
      {},
      { Origin: "https://preview.cartiva.example", "Sec-Fetch-Site": "same-origin" },
    ))).toBeNull();
    expect(validateLocalApiRequest(jsonRequest(
      "https://preview.cartiva.example/api/search",
      {},
      { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    ))?.status).toBe(403);
  });

  it("requires JSON and enforces the body-size ceiling while streaming", async () => {
    const plain = new Request("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    const wrongType = await readValidatedJson(plain);
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.response.status).toBe(415);

    const oversized = await readValidatedJson(jsonRequest(
      "http://localhost:3000/api/search",
      { item: "x".repeat(65 * 1024) },
    ));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.response.status).toBe(413);
  });

  it("uses an unforgeable in-process mark for an origin-checked extension request", async () => {
    const request = jsonRequest(
      "http://localhost:3000/api/extension/search",
      { items: ["eggs"] },
      { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" },
    );
    const parsed = await readValidatedJson<{ items: string[] }>(
      trustValidatedExtensionRequest(request),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.items).toEqual(["eggs"]);
  });

  it("rejects unknown or oversized search-item fields", () => {
    expect(hasValidSearchItemShape({ text: "eggs", admin: true }, [])).toBe(false);
    expect(hasValidSearchItemShape({ text: "x".repeat(301) }, [])).toBe(false);
    expect(hasValidSearchItemShape({ text: "eggs", quantity: "2" }, [])).toBe(false);
    expect(hasValidSearchItemShape({ text: "eggs", quantity: 2 }, [])).toBe(true);
  });

  it("returns 429 with Retry-After after a route budget is exhausted", () => {
    const request = jsonRequest();
    expect(enforceRateLimit(request, "test", { limit: 1, windowMs: 60_000 })).toBeNull();
    const rejected = enforceRateLimit(request, "test", { limit: 1, windowMs: 60_000 });
    expect(rejected?.status).toBe(429);
    expect(rejected?.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("keys anonymous public read budgets by the best available client address", () => {
    vi.stubEnv("CARTIVA_TRUSTED_EDGE", "true");
    const firstClient = jsonRequest(
      "https://api.cartiva.example/api/mobile/v1/kroger/locations",
      { zipCode: "80202" },
      { "X-Forwarded-For": "203.0.113.10" },
    );
    const sameClient = jsonRequest(
      "https://api.cartiva.example/api/mobile/v1/kroger/locations",
      { zipCode: "80202" },
      { "X-Forwarded-For": "203.0.113.10" },
    );
    const otherClient = jsonRequest(
      "https://api.cartiva.example/api/mobile/v1/kroger/locations",
      { zipCode: "80202" },
      { "X-Forwarded-For": "203.0.113.11" },
    );

    expect(enforcePublicReadRateLimit(
      firstClient,
      "test-public",
      { limit: 1, windowMs: 60_000 },
    )).toBeNull();
    expect(enforcePublicReadRateLimit(
      sameClient,
      "test-public",
      { limit: 1, windowMs: 60_000 },
    )?.status).toBe(429);
    expect(enforcePublicReadRateLimit(
      otherClient,
      "test-public",
      { limit: 1, windowMs: 60_000 },
    )).toBeNull();
  });

  it("ignores caller-supplied forwarding addresses without an explicit trusted edge", () => {
    const policy = { limit: 1, windowMs: 60_000 };
    expect(enforcePublicReadRateLimit(
      jsonRequest("https://api.cartiva.example/api/mobile/v1/session", {}, {
        "X-Forwarded-For": "203.0.113.20",
      }),
      "untrusted-forwarding",
      policy,
    )).toBeNull();
    expect(enforcePublicReadRateLimit(
      jsonRequest("https://api.cartiva.example/api/mobile/v1/session", {}, {
        "X-Forwarded-For": "198.51.100.40",
      }),
      "untrusted-forwarding",
      policy,
    )?.status).toBe(429);
  });

  it("times out a JSON body that never finishes instead of accepting its prefix", async () => {
    vi.useFakeTimers();
    const request = new Request("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"items":["eggs"]}'));
          // Deliberately never close the request body.
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = readValidatedJson(request);
    await vi.advanceTimersByTimeAsync(8_100);
    const parsed = await result;
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(408);
  });
});
