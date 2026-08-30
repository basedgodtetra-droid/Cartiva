import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
) as {
  host_permissions?: string[];
  optional_host_permissions?: string[];
  externally_connectable?: unknown;
};

describe("extension manifest network boundary", () => {
  it("grants backend access only to exact loopback hosts", () => {
    expect(manifest.host_permissions).toEqual([
      "https://www.walmart.com/*",
      "https://www.target.com/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
      "http://[::1]/*",
    ]);
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
  });
});
