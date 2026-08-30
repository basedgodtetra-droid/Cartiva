import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as disconnectPost } from "@/app/api/mobile/v1/kroger/auth/disconnect/route";
import { resetRateLimitsForTests } from "@/lib/api-security";
import { disconnectMobileKroger } from "@/lib/kroger-mobile-auth";
import { issueMobileSession } from "@/lib/mobile-session";

vi.mock("@/lib/kroger-mobile-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kroger-mobile-auth")>("@/lib/kroger-mobile-auth");
  return { ...actual, disconnectMobileKroger: vi.fn() };
});

function request(token?: string) {
  return new Request("https://api.cartiva.test/api/mobile/v1/kroger/auth/disconnect", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-Forwarded-For": "203.0.113.94",
    },
  });
}

describe("mobile Kroger disconnect route", () => {
  beforeEach(() => {
    vi.stubEnv("CARTIVA_SESSION_SECRET", "disconnect-route-session-secret-at-least-thirty-two-characters");
    resetRateLimitsForTests();
    vi.mocked(disconnectMobileKroger).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses a session-shaped 401 only when the Cartiva bearer is invalid", async () => {
    const response = await disconnectPost(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "missing" });
    expect(disconnectMobileKroger).not.toHaveBeenCalled();
  });

  it("keeps the owner bearer valid when retailer-session cleanup storage fails", async () => {
    const issued = issueMobileSession();
    vi.mocked(disconnectMobileKroger).mockRejectedValueOnce(new Error("session directory unavailable"));

    const response = await disconnectPost(request(issued.sessionToken));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Cartiva could not safely disconnect Kroger. The existing Cartiva session was kept.",
      code: "disconnect_unavailable",
      retrySafe: false,
    });
    expect(disconnectMobileKroger).toHaveBeenCalledWith(issued.ownerId);
  });
});
