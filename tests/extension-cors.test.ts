import { describe, expect, it } from "vitest";
import {
  extensionCorsHeaders,
  isAllowedExtensionOrigin,
  withExtensionCors,
} from "@/lib/extension-cors";
import {
  OPTIONS as extensionSearchOptions,
  POST as extensionSearchPost,
} from "@/app/api/extension/search/route";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const extensionOrigin = `chrome-extension://${extensionId}`;

describe("Cartiva extension CORS", () => {
  it("allows only syntactically valid Chrome extension origins in development", () => {
    expect(isAllowedExtensionOrigin(extensionOrigin, { nodeEnv: "development" })).toBe(true);
    expect(isAllowedExtensionOrigin(
      "chrome-extension://qrstuvwxyzabcdefghijklmnopqrstuv",
      { nodeEnv: "development" },
    )).toBe(false);
    expect(isAllowedExtensionOrigin(`${extensionOrigin}/side-panel.html`, {
      nodeEnv: "development",
    })).toBe(false);
  });

  it("requires the exact configured Chrome extension ID in production", () => {
    expect(isAllowedExtensionOrigin(extensionOrigin, {
      nodeEnv: "production",
      productionExtensionId: extensionId,
    })).toBe(true);
    expect(isAllowedExtensionOrigin(
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      { nodeEnv: "production", productionExtensionId: extensionId },
    )).toBe(false);
    expect(isAllowedExtensionOrigin(extensionOrigin, {
      nodeEnv: "production",
      productionExtensionId: "not-an-extension-id",
    })).toBe(false);
  });

  it("enforces a configured extension ID during local development too", () => {
    expect(isAllowedExtensionOrigin(extensionOrigin, {
      nodeEnv: "development",
      productionExtensionId: extensionId,
    })).toBe(true);
    expect(isAllowedExtensionOrigin(
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      { nodeEnv: "development", productionExtensionId: extensionId },
    )).toBe(false);
  });

  it("requires the configured Chrome extension ID in development too", () => {
    expect(isAllowedExtensionOrigin(extensionOrigin, {
      nodeEnv: "development",
      productionExtensionId: extensionId,
    })).toBe(true);
    expect(isAllowedExtensionOrigin(
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      { nodeEnv: "development", productionExtensionId: extensionId },
    )).toBe(false);
    expect(isAllowedExtensionOrigin(extensionOrigin, {
      nodeEnv: "development",
      productionExtensionId: "invalid-configured-id",
    })).toBe(false);
  });

  it("limits local development callers to exact loopback origins", () => {
    expect(isAllowedExtensionOrigin("http://localhost:3000", {
      nodeEnv: "development",
    })).toBe(true);
    expect(isAllowedExtensionOrigin("http://127.0.0.1:5173", {
      nodeEnv: "test",
    })).toBe(true);
    expect(isAllowedExtensionOrigin("http://localhost.example.com:3000", {
      nodeEnv: "development",
    })).toBe(false);
    expect(isAllowedExtensionOrigin("http://localhost:3000", {
      nodeEnv: "production",
    })).toBe(false);
  });

  it("can narrow local development callers with an explicit origin list", () => {
    const options = {
      nodeEnv: "development",
      localDevelopmentOrigins: "http://localhost:4400,https://not-loopback.test",
    };
    expect(isAllowedExtensionOrigin("http://localhost:4400", options)).toBe(true);
    expect(isAllowedExtensionOrigin("http://localhost:3000", options)).toBe(false);
    expect(isAllowedExtensionOrigin("https://not-loopback.test", options)).toBe(false);
  });

  it("echoes the approved origin without enabling credentials", () => {
    const headers = extensionCorsHeaders(extensionOrigin);
    expect(headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);
    expect(headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(headers.get("Access-Control-Allow-Credentials")).toBeNull();

    const response = withExtensionCors(new Response("ok", {
      headers: { Vary: "Accept-Encoding" },
    }), extensionOrigin);
    expect(response.headers.get("Vary")).toBe("Accept-Encoding, Origin");
  });
});

describe("extension Walmart search route", () => {
  it("answers a valid preflight and rejects an untrusted origin", () => {
    const allowed = extensionSearchOptions(new Request(
      "http://localhost:3000/api/extension/search",
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
    expect(allowed.headers.get("Vary")).toBe("Origin");

    const rejected = extensionSearchOptions(new Request(
      "http://localhost:3000/api/extension/search",
      { method: "OPTIONS", headers: { Origin: "https://attacker.example" } },
    ));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects unsupported preflight headers", () => {
    const response = extensionSearchOptions(new Request(
      "http://localhost:3000/api/extension/search",
      {
        method: "OPTIONS",
        headers: {
          Origin: extensionOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, authorization",
        },
      },
    ));
    expect(response.status).toBe(400);
  });

  it("preserves existing search validation while adding CORS", async () => {
    const response = await extensionSearchPost(new Request(
      "http://localhost:3000/api/extension/search",
      {
        method: "POST",
        headers: {
          Origin: extensionOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [],
          storeId: "2201",
          zipCode: "79925",
          fulfillmentMode: "pickup",
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);
    expect(await response.json()).toEqual({
      error: "Add 1 to 50 valid shopping-list items, each no longer than 300 characters.",
    });
  });

  it("rejects non-JSON and originless requests before Walmart access", async () => {
    const wrongType = await extensionSearchPost(new Request(
      "http://localhost:3000/api/extension/search",
      {
        method: "POST",
        headers: { Origin: extensionOrigin, "Content-Type": "text/plain" },
        body: "eggs",
      },
    ));
    expect(wrongType.status).toBe(415);
    expect(wrongType.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);

    const originless = await extensionSearchPost(new Request(
      "http://localhost:3000/api/extension/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: ["eggs"] }),
      },
    ));
    expect(originless.status).toBe(403);
    expect(originless.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("requires an explicit valid store ID when the extension supplies a ZIP", async () => {
    const post = (body: unknown) => extensionSearchPost(new Request(
      "http://localhost:3000/api/extension/search",
      {
        method: "POST",
        headers: {
          Origin: extensionOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    ));

    const missingStore = await post({ items: ["eggs"], zipCode: "79925" });
    expect(missingStore.status).toBe(400);
    expect(await missingStore.json()).toEqual({
      error: "Choose a Walmart pickup store for this ZIP before searching.",
    });
    expect(missingStore.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);

    const invalidStore = await post({ items: ["eggs"], storeId: "2201<script>" });
    expect(invalidStore.status).toBe(400);
    expect(await invalidStore.json()).toEqual({ error: "Choose a valid Walmart pickup store." });

    const invalidZip = await post({ items: ["eggs"], storeId: "2201", zipCode: "7992A" });
    expect(invalidZip.status).toBe(400);
    expect(await invalidZip.json()).toEqual({ error: "Enter a valid 5-digit ZIP code." });
  });
});
