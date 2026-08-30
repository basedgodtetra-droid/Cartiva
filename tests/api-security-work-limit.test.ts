import { beforeEach, describe, expect, it } from "vitest";
import {
  enforcePublicReadWorkLimit,
  resetRateLimitsForTests,
} from "@/lib/api-security";

function request(address: string) {
  return new Request("https://api.cartiva.test/api/mobile/v1/kroger/search", {
    headers: { "X-Forwarded-For": address },
  });
}

describe("public retailer upstream-work limiter", () => {
  beforeEach(() => resetRateLimitsForTests());

  it("charges expected discovery attempts rather than only request count", () => {
    const policy = { limit: 10, windowMs: 60_000 };
    expect(enforcePublicReadWorkLimit(request("203.0.113.1"), "search", 3, policy)).toBeNull();
    expect(enforcePublicReadWorkLimit(request("203.0.113.1"), "search", 6, policy)).toBeNull();
    const rejected = enforcePublicReadWorkLimit(request("203.0.113.1"), "search", 3, policy);
    expect(rejected?.status).toBe(429);
    expect(rejected?.headers.get("Retry-After")).toBeTruthy();
  });

  it("uses the stable mobile owner even if forwarding headers change", () => {
    const ownerId = "a".repeat(64);
    const policy = { limit: 5, windowMs: 60_000 };
    expect(enforcePublicReadWorkLimit(
      request("203.0.113.2"), "search", 3, policy, ownerId,
    )).toBeNull();
    expect(enforcePublicReadWorkLimit(
      request("198.51.100.20"), "search", 3, policy, ownerId,
    )?.status).toBe(429);
  });
});
