import { describe, expect, it } from "vitest";
import { DEFAULT_BACKEND_URL, restoredBackendBaseUrl } from "../src/sidepanel-settings";

describe("side-panel backend defaults", () => {
  it("uses a stable same-computer address for new installs", () => {
    expect(DEFAULT_BACKEND_URL).toBe("http://127.0.0.1:8088");
    expect(restoredBackendBaseUrl(undefined)).toBe(DEFAULT_BACKEND_URL);
  });

  it("repairs obsolete development addresses", () => {
    expect(restoredBackendBaseUrl("http://localhost:3000")).toBe(DEFAULT_BACKEND_URL);
    expect(restoredBackendBaseUrl("not a URL")).toBe(DEFAULT_BACKEND_URL);
  });

  it("repairs saved private-network backends and preserves exact loopback origins", () => {
    expect(restoredBackendBaseUrl("http://192.168.1.44:8088")).toBe(DEFAULT_BACKEND_URL);
    expect(restoredBackendBaseUrl("http://localhost:8088")).toBe("http://localhost:8088");
    expect(restoredBackendBaseUrl("http://[::1]:8088")).toBe("http://[::1]:8088");
  });
});
