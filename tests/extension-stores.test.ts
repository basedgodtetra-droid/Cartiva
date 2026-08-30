import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPTIONS as extensionStoresOptions,
  POST as extensionStoresPost,
} from "@/app/api/extension/stores/route";
import { clearWalmartStoreDirectoryCache } from "@/lib/walmart-stores";

const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const directoryFixture = [
  { store_id: "2201", postal_code: "79925", address: "7101 Gateway Blvd W" },
  { store_id: "3661", postal_code: "79936", address: "1551 N Zaragoza Rd" },
  { store_id: "5108", postal_code: "79936", address: "3000 Saul Kleinfeld Dr" },
  { store_id: "2612", postal_code: "79936", address: "1850 N Zaragoza Rd" },
];

function storeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/extension/stores", {
    method: "POST",
    headers: {
      Origin: extensionOrigin,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  clearWalmartStoreDirectoryCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extension Walmart store lookup route", () => {
  it("answers a valid POST preflight and rejects untrusted origins", () => {
    const allowed = extensionStoresOptions(new Request(
      "http://localhost:3000/api/extension/stores",
      {
        method: "OPTIONS",
        headers: {
          Origin: extensionOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
    ));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);

    const rejected = extensionStoresOptions(new Request(
      "http://localhost:3000/api/extension/stores",
      { method: "OPTIONS", headers: { Origin: "https://attacker.example" } },
    ));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns bounded exact-ZIP store choices without auto-selecting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(directoryFixture)));
    const response = await extensionStoresPost(storeRequest({ zipCode: "79936" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toMatchObject({ zipCode: "79936", totalMatches: 3 });
    expect(payload.stores.map((store: { storeId: string }) => store.storeId))
      .toEqual(["3661", "2612", "5108"]);
    expect(payload).not.toHaveProperty("selectedStoreId");
  });

  it("rejects malformed ZIPs and non-JSON requests before fetching the directory", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const invalidZip = await extensionStoresPost(storeRequest({ zipCode: "7992A" }));
    expect(invalidZip.status).toBe(400);
    expect(await invalidZip.json()).toEqual({ error: "Enter a five-digit US ZIP code." });

    const wrongType = await extensionStoresPost(storeRequest(
      { zipCode: "79925" },
      { "Content-Type": "text/plain" },
    ));
    expect(wrongType.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects originless requests before fetching the directory", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await extensionStoresPost(new Request(
      "http://localhost:3000/api/extension/stores",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zipCode: "79925" }),
      },
    ));

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a sanitized error when the fixed upstream directory is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream details", { status: 503 })));
    const response = await extensionStoresPost(storeRequest({ zipCode: "79925" }));
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error).toMatch(/temporarily unavailable/i);
    expect(JSON.stringify(payload)).not.toContain("upstream details");
    expect(JSON.stringify(payload)).not.toContain("serpapi.com");
  });
});
