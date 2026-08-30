import { describe, expect, it } from "vitest";
import { validatePublicApiUrl } from "../mobile/app.config";

describe("mobile public API build configuration", () => {
  it("allows an omitted or LAN HTTP origin only outside guarded EAS builds", () => {
    expect(validatePublicApiUrl(undefined, { requireHttps: false })).toBeUndefined();
    expect(validatePublicApiUrl("http://192.168.1.10:3000/", { requireHttps: false }))
      .toBe("http://192.168.1.10:3000");
  });

  it("fails a guarded build when the API origin is missing or is not HTTPS", () => {
    expect(() => validatePublicApiUrl(undefined, { requireHttps: true }))
      .toThrow(/required for EAS builds/i);
    expect(() => validatePublicApiUrl("http://192.168.1.10:3000", { requireHttps: true }))
      .toThrow(/require.*https/i);
    expect(() => validatePublicApiUrl("https://127.0.0.1:3000", { requireHttps: true }))
      .toThrow(/reachable HTTPS/i);
  });

  it("accepts only a clean deployed HTTPS origin for a guarded build", () => {
    expect(validatePublicApiUrl("https://api.cartiva.example/", { requireHttps: true }))
      .toBe("https://api.cartiva.example");
    expect(() => validatePublicApiUrl("https://api.cartiva.example/v1", { requireHttps: true }))
      .toThrow(/origin only/i);
    expect(() => validatePublicApiUrl("https://user:pass@api.cartiva.example", { requireHttps: true }))
      .toThrow(/origin only/i);
  });
});
