import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KrogerAuthClient } from "@/lib/kroger-auth";

function tokenResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function client(fetcher: typeof fetch) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-kroger-auth-"));
  return new KrogerAuthClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3000/api/kroger/oauth/callback",
    sessionFile: path.join(directory, "session.json"),
  }, fetcher);
}

beforeEach(() => {
  vi.stubEnv("KROGER_CART_RECEIPT_FILE", path.join(os.tmpdir(), `cartiva-kroger-auth-receipts-${Date.now()}-${Math.random()}.json`));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Kroger OAuth", () => {
  it("deduplicates client-credentials tokens and keeps secrets out of the URL", async () => {
    const fetcher = vi.fn(async () => tokenResponse({
      access_token: "public-token",
      expires_in: 1800,
    })) as unknown as typeof fetch;
    const auth = await client(fetcher);

    await Promise.all([auth.getPublicAccessToken(), auth.getPublicAccessToken()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = vi.mocked(fetcher).mock.calls[0];
    expect(String(url)).toBe("https://api.kroger.com/v1/connect/oauth2/token");
    expect(String(url)).not.toContain("client-secret");
    expect(request).toMatchObject({ method: "POST", redirect: "manual" });
    expect((request?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);

    await auth.fetchPublic("/v1/locations");
    const [, publicRequest] = vi.mocked(fetcher).mock.calls[1];
    expect(publicRequest).toMatchObject({ redirect: "manual" });
    expect((publicRequest?.headers as Record<string, string>).Authorization)
      .toBe("Bearer public-token");
  });

  it("requires a one-use matching state and stores customer tokens only on the server", async () => {
    const fetcher = vi.fn(async () => tokenResponse({
      access_token: "customer-access",
      refresh_token: "customer-refresh",
      expires_in: 1800,
      scope: "cart.basic:write profile.compact",
    })) as unknown as typeof fetch;
    const auth = await client(fetcher);
    const authorizationUrl = new URL(auth.createAuthorizationUrl());
    expect(authorizationUrl.origin).toBe("https://api.kroger.com");
    expect(authorizationUrl.pathname).toBe("/v1/connect/oauth2/authorize");
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
    expect(authorizationUrl.searchParams.has("code_challenge")).toBe(false);

    await auth.exchangeAuthorizationCode(
      "authorization-code",
      authorizationUrl.searchParams.get("state")!,
    );
    expect(await auth.connectionStatus()).toEqual({ connected: true });
    await auth.fetchCustomer("/v1/cart/add", { method: "PUT" });
    const [, customerRequest] = vi.mocked(fetcher).mock.calls[1];
    expect(customerRequest).toMatchObject({ method: "PUT", redirect: "manual" });
    expect((customerRequest?.headers as Record<string, string>).Authorization)
      .toBe("Bearer customer-access");
    await expect(auth.exchangeAuthorizationCode(
      "authorization-code",
      authorizationUrl.searchParams.get("state")!,
    )).rejects.toMatchObject({ code: "oauth_state" });
  });

  it("single-flights rotation of Kroger's one-use refresh token", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-kroger-refresh-"));
    const sessionFile = path.join(directory, "session.json");
    await writeFile(sessionFile, JSON.stringify({
      version: 1,
      accessToken: "expired",
      refreshToken: "old-refresh",
      expiresAt: 1,
    }));
    const fetcher = vi.fn(async () => tokenResponse({
      access_token: "fresh",
      refresh_token: "rotated-refresh",
      expires_in: 1800,
    })) as unknown as typeof fetch;
    const auth = new KrogerAuthClient({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/kroger/oauth/callback",
      sessionFile,
    }, fetcher);

    expect(await Promise.all([
      auth.getCustomerAccessToken(),
      auth.getCustomerAccessToken(),
    ])).toEqual(["fresh", "fresh"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const serialized = await readFile(sessionFile, "utf8");
    expect(serialized).not.toContain("expired");
    expect(serialized).not.toContain("old-refresh");
    expect(serialized).not.toContain("fresh");
    expect(serialized).not.toContain("rotated-refresh");
    const stored = JSON.parse(serialized);
    expect(stored).toMatchObject({ version: 2, algorithm: "aes-256-gcm" });
    expect(Object.keys(stored).sort()).toEqual([
      "algorithm",
      "authTag",
      "ciphertext",
      "iv",
      "version",
    ]);
  });

  it("propagates a transient refresh failure instead of reporting disconnected", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-kroger-status-transient-"));
    const sessionFile = path.join(directory, "session.json");
    await writeFile(sessionFile, JSON.stringify({
      version: 1,
      accessToken: "expiring-access",
      refreshToken: "still-valid-refresh",
      expiresAt: 1,
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: "temporarily_unavailable",
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    const auth = new KrogerAuthClient({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/kroger/oauth/callback",
      sessionFile,
    }, fetcher);

    await expect(auth.connectionStatus()).rejects.toMatchObject({
      code: "upstream",
      status: 502,
    });
    await expect(stat(sessionFile)).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains a customer session when the token endpoint rejects client authentication", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-kroger-status-revoked-"));
    const sessionFile = path.join(directory, "session.json");
    await writeFile(sessionFile, JSON.stringify({
      version: 1,
      accessToken: "expired-access",
      refreshToken: "revoked-refresh",
      expiresAt: 1,
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: "invalid_client",
    }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    const auth = new KrogerAuthClient({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/kroger/oauth/callback",
      sessionFile,
    }, fetcher);

    await expect(auth.connectionStatus()).rejects.toMatchObject({ code: "upstream", status: 401 });
    await expect(stat(sessionFile)).resolves.toBeDefined();
    await expect(auth.getCustomerAccessToken()).rejects.toMatchObject({
      code: "upstream",
      status: 401,
    });
  });

  it("treats Kroger refresh invalid_grant as revoked without exposing its description", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-kroger-invalid-grant-"));
    const sessionFile = path.join(directory, "session.json");
    await writeFile(sessionFile, JSON.stringify({
      version: 1,
      accessToken: "expired-access",
      refreshToken: "revoked-refresh",
      expiresAt: 1,
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "provider detail containing sensitive context",
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    const auth = new KrogerAuthClient({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/kroger/oauth/callback",
      sessionFile,
    }, fetcher);

    await expect(auth.connectionStatus()).resolves.toEqual({ connected: false, expired: true });
    await expect(stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps an encrypted session on an unknown refresh-time 400 response", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-kroger-unknown-400-"));
    const sessionFile = path.join(directory, "session.json");
    await writeFile(sessionFile, JSON.stringify({
      version: 1,
      accessToken: "expired-access",
      refreshToken: "possibly-valid-refresh",
      expiresAt: 1,
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: "unexpected_provider_code",
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    const auth = new KrogerAuthClient({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/kroger/oauth/callback",
      sessionFile,
    }, fetcher);

    await expect(auth.connectionStatus()).rejects.toMatchObject({
      code: "upstream",
      status: 502,
    });
    await expect(stat(sessionFile)).resolves.toBeDefined();
  });

  it("propagates refresh-session persistence failures", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-kroger-status-storage-"));
    const sessionDirectory = path.join(directory, "sessions");
    const sessionFile = path.join(sessionDirectory, "session.json");
    const fetcher = vi.fn(async () => tokenResponse({
      access_token: `customer-access-${Math.random()}`,
      refresh_token: `customer-refresh-${Math.random()}`,
      expires_in: 1,
      scope: "cart.basic:write profile.compact",
    })) as unknown as typeof fetch;
    const auth = new KrogerAuthClient({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/kroger/oauth/callback",
      sessionFile,
    }, fetcher);
    const authorizationUrl = new URL(auth.createAuthorizationUrl());
    await auth.exchangeAuthorizationCode(
      "authorization-code",
      authorizationUrl.searchParams.get("state")!,
    );
    await rm(sessionFile);
    await rm(sessionDirectory, { recursive: true, force: true });
    await writeFile(sessionDirectory, "not a directory", "utf8");

    await expect(auth.connectionStatus()).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("limits repeated OAuth starts and bounds pending authorization state", async () => {
    const auth = await client(vi.fn() as unknown as typeof fetch);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(auth.createAuthorizationUrl()).toContain("state=");
    }
    expect(() => auth.createAuthorizationUrl()).toThrowError(
      expect.objectContaining({ code: "rate_limit", status: 429 }),
    );
  });

  it("deletes the customer token file even when receipt cleanup fails during disconnect", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-kroger-disconnect-"));
    const sessionFile = path.join(directory, "session.json");
    await writeFile(sessionFile, "sensitive-session-placeholder", "utf8");
    const cleanup = vi.fn(async () => {
      throw new Error("receipt cleanup failed");
    });
    const auth = new KrogerAuthClient({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/kroger/oauth/callback",
      sessionFile,
    }, vi.fn() as unknown as typeof fetch, cleanup);

    await expect(auth.disconnect()).rejects.toThrow("receipt cleanup failed");
    await expect(stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed instead of retaining an old customer session when reauthorization transition fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-kroger-reauth-"));
    const sessionFile = path.join(directory, "session.json");
    const fetcher = vi.fn(async () => tokenResponse({
      access_token: `customer-access-${Math.random()}`,
      refresh_token: `customer-refresh-${Math.random()}`,
      expires_in: 1800,
      scope: "cart.basic:write profile.compact",
    })) as unknown as typeof fetch;
    let rejectTransition = false;
    const auth = new KrogerAuthClient({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/kroger/oauth/callback",
      sessionFile,
    }, fetcher, async () => {
      if (rejectTransition) throw new Error("idempotency transition failed");
    });

    const first = new URL(auth.createAuthorizationUrl());
    await auth.exchangeAuthorizationCode("first-code", first.searchParams.get("state")!);
    expect(await auth.connectionStatus()).toEqual({ connected: true });

    rejectTransition = true;
    const second = new URL(auth.createAuthorizationUrl());
    await expect(auth.exchangeAuthorizationCode(
      "second-code",
      second.searchParams.get("state")!,
    )).rejects.toThrow("idempotency transition failed");
    expect(await auth.connectionStatus()).toEqual({ connected: false });
    await expect(stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
