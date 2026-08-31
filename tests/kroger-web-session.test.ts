import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callbackGet } from "@/app/api/kroger/oauth/callback/route";
import { POST as startPost } from "@/app/api/kroger/oauth/start/route";
import { GET as statusGet } from "@/app/api/kroger/auth/status/route";
import { resetKrogerAuthClientForTests } from "@/lib/kroger-auth";

const origin = "https://cartiva-smoky.vercel.app";
const callback = `${origin}/api/retailers/kroger/oauth/callback`;

function cookiePair(setCookie: string, name: string) {
  const match = setCookie.match(new RegExp(`(?:^|,\\s*)${name}=([^;]*)`));
  if (!match) throw new Error(`Missing ${name} cookie.`);
  return `${name}=${match[1]}`;
}

beforeEach(() => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("KROGER_CLIENT_ID", "cartiva-web-test");
  vi.stubEnv("KROGER_CLIENT_SECRET", "test-client-secret-not-for-production");
  vi.stubEnv("KROGER_REDIRECT_URI", callback);
  vi.stubEnv("CARTIVA_SESSION_SECRET", "cartiva-test-session-secret-32-characters-minimum");
  vi.stubEnv("CARTIVA_PUBLIC_ORIGIN", origin);
  resetKrogerAuthClientForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetKrogerAuthClientForTests();
});

describe("serverless Kroger web OAuth", () => {
  it("carries one-use state and an encrypted customer session across requests using secure cookies", async () => {
    const start = await startPost(new Request(`${origin}/api/kroger/oauth/start`, {
      method: "POST",
      headers: { Origin: origin },
    }));
    expect(start.status).toBe(200);
    const startBody = await start.json() as { authorizationUrl: string };
    const authorization = new URL(startBody.authorizationUrl);
    expect(authorization.searchParams.get("client_id")).toBe("cartiva-web-test");
    expect(authorization.searchParams.get("redirect_uri")).toBe(callback);
    const state = authorization.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const stateCookie = cookiePair(
      start.headers.get("set-cookie") ?? "",
      "__Host-cartiva-kroger-oauth-state",
    );
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      access_token: "customer-access-token",
      refresh_token: "customer-refresh-token",
      expires_in: 3_600,
      scope: "cart.basic:write",
    })));

    // Resetting the singleton simulates the callback landing in another
    // serverless instance; the cookie, not process memory, owns the state.
    resetKrogerAuthClientForTests();
    const completed = await callbackGet(new Request(
      `${callback}?code=authorization-code&state=${state}`,
      { headers: { Cookie: stateCookie } },
    ));
    expect(completed.status).toBe(200);
    expect(await completed.text()).toContain("Kroger connected");
    const sessionCookie = cookiePair(
      completed.headers.get("set-cookie") ?? "",
      "__Host-cartiva-kroger-session",
    );
    expect(sessionCookie).not.toContain("customer-access-token");
    expect(sessionCookie).not.toContain("customer-refresh-token");

    resetKrogerAuthClientForTests();
    const status = await statusGet(new Request(`${origin}/api/kroger/auth/status`, {
      headers: { Origin: origin, Cookie: sessionCookie },
    }));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ connected: true, configured: true });
  });

  it("rejects a callback whose returned state is not the cookie-bound state", async () => {
    const start = await startPost(new Request(`${origin}/api/kroger/oauth/start`, {
      method: "POST",
      headers: { Origin: origin },
    }));
    const stateCookie = cookiePair(
      start.headers.get("set-cookie") ?? "",
      "__Host-cartiva-kroger-oauth-state",
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const completed = await callbackGet(new Request(
      `${callback}?code=authorization-code&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      { headers: { Cookie: stateCookie } },
    ));
    expect(completed.status).toBe(400);
    expect(await completed.text()).toContain("could not be verified");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
