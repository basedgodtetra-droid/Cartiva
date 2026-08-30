import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  activateMobileKrogerAuthorization,
  createMobileKrogerAuthorization,
  consumeMobileKrogerAuthorizationState,
  disconnectMobileKroger,
  getMobileKrogerAuthClient,
  mobileKrogerCapabilityStatus,
  MOBILE_KROGER_SESSION_RETENTION_MS,
  mobileKrogerConnectionStatus,
  pruneExpiredMobileKrogerSessions,
  pruneExpiredMobileKrogerAuthorizationCompletions,
  prepareMobileKrogerAuthorizationCompletion,
  resetMobileKrogerAuthForTests,
} from "@/lib/kroger-mobile-auth";
import {
  issueMobileSession,
  MOBILE_SESSION_TTL_MS,
  verifyMobileSessionToken,
} from "@/lib/mobile-session";
import { resetKrogerCartOperationsForTests } from "@/lib/kroger-cart-operations";
import { validateKrogerOAuthReturn } from "../mobile/src/services/kroger-oauth-return";

let directory: string;
const TEST_SESSION_SECRET = "test-session-secret-that-is-at-least-thirty-two-characters";
const ROTATED_SESSION_SECRET = "rotated-session-secret-that-is-at-least-thirty-two-characters";

function configureMobileKroger() {
  vi.stubEnv("CARTIVA_ENABLE_KROGER_CART_WRITES", "true");
  vi.stubEnv("CARTIVA_SESSION_SECRET", TEST_SESSION_SECRET);
  vi.stubEnv("KROGER_CLIENT_ID", "mobile-client-id");
  vi.stubEnv("KROGER_CLIENT_SECRET", "mobile-client-secret");
  vi.stubEnv(
    "KROGER_MOBILE_REDIRECT_URI",
    "https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback",
  );
  vi.stubEnv("CARTIVA_MOBILE_OAUTH_STATE_DIR", path.join(directory, "states"));
  vi.stubEnv("CARTIVA_MOBILE_OAUTH_COMPLETION_DIR", path.join(directory, "completions"));
  vi.stubEnv("CARTIVA_MOBILE_KROGER_SESSION_DIR", path.join(directory, "sessions"));
  vi.stubEnv("KROGER_CART_RECEIPT_FILE", path.join(directory, "cart-receipts.json"));
}

function rotateSessionSecret() {
  vi.stubEnv("CARTIVA_SESSION_SECRET", ROTATED_SESSION_SECRET);
  vi.stubEnv("CARTIVA_SESSION_PREVIOUS_SECRET", TEST_SESSION_SECRET);
}

async function exchangeAndActivate(
  pending: Awaited<ReturnType<typeof consumeMobileKrogerAuthorizationState>>,
  code: string,
) {
  const completion = await prepareMobileKrogerAuthorizationCompletion(pending, code);
  return activateMobileKrogerAuthorization(pending.ownerId, completion.completion);
}

function tokenResponse() {
  return new Response(JSON.stringify({
    access_token: "customer-access-token",
    refresh_token: "customer-refresh-token",
    expires_in: 1_800,
    scope: "cart.basic:write profile.compact product.compact",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-mobile-auth-"));
  configureMobileKroger();
  resetMobileKrogerAuthForTests();
  resetKrogerCartOperationsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetMobileKrogerAuthForTests();
  resetKrogerCartOperationsForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("temporary mobile sessions", () => {
  it("issues a signed high-entropy bearer and rejects tampering or expiry", () => {
    const issued = issueMobileSession();
    expect(issued.sessionToken).not.toContain(issued.ownerId);
    expect(verifyMobileSessionToken(issued.sessionToken)).toEqual({
      ownerId: issued.ownerId,
      expiresAt: issued.expiresAt,
    });

    const tampered = `${issued.sessionToken.slice(0, -1)}${issued.sessionToken.endsWith("a") ? "b" : "a"}`;
    expect(() => verifyMobileSessionToken(tampered)).toThrow(/invalid/i);
    expect(() => verifyMobileSessionToken(issued.sessionToken, issued.expiresAt)).toThrow(/expired/i);
  });

  it("fails closed when the server session secret is absent", () => {
    vi.stubEnv("CARTIVA_SESSION_SECRET", "");
    expect(() => issueMobileSession()).toThrow(/not configured/i);
    expect(mobileKrogerCapabilityStatus()).toMatchObject({
      mode: "SHOPPING_PAGE_ONLY",
      cartTransferSupported: false,
      configured: false,
    });
  });

  it("requires an explicit cart-write opt-in", () => {
    vi.stubEnv("CARTIVA_ENABLE_KROGER_CART_WRITES", "false");
    expect(mobileKrogerCapabilityStatus()).toMatchObject({
      mode: "SHOPPING_PAGE_ONLY",
      cartTransferSupported: false,
      configured: false,
      reason: expect.stringMatching(/not explicitly enabled/i),
    });
  });

  it("keeps production cart writing off without reviewed persistent single-instance state", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CARTIVA_MOBILE_APP_RETURN_URI", "https://api.cartiva.test/oauth/kroger");
    expect(mobileKrogerCapabilityStatus()).toMatchObject({
      mode: "SHOPPING_PAGE_ONLY",
      configured: false,
      reason: expect.stringMatching(/durable secure-state/i),
    });

    vi.stubEnv("CARTIVA_SECURE_STATE_MODE", "SINGLE_INSTANCE_FILESYSTEM");
    vi.stubEnv("CARTIVA_MOBILE_SESSION_FILE", path.join(directory, "mobile-sessions.json"));
    vi.stubEnv("CARTIVA_MOBILE_OAUTH_STATE_DIR", path.join(directory, "states"));
    vi.stubEnv("CARTIVA_MOBILE_OAUTH_COMPLETION_DIR", path.join(directory, "completions"));
    vi.stubEnv("CARTIVA_MOBILE_KROGER_SESSION_DIR", path.join(directory, "sessions"));
    vi.stubEnv("CARTIVA_COMPARISON_RECEIPT_FILE", path.join(directory, "comparisons.json"));
    vi.stubEnv("KROGER_CART_RECEIPT_FILE", path.join(directory, "cart-receipts.json"));
    expect(mobileKrogerCapabilityStatus()).toMatchObject({
      mode: "SHOPPING_PAGE_ONLY",
      configured: false,
      reason: expect.stringMatching(/trusted rate-limiting edge/i),
    });
    vi.stubEnv("CARTIVA_TRUSTED_EDGE", "true");
    expect(mobileKrogerCapabilityStatus()).toMatchObject(process.platform === "win32" ? {
      mode: "SHOPPING_PAGE_ONLY",
      cartTransferSupported: false,
      configured: false,
      reason: expect.stringMatching(/durably sync/i),
    } : {
      mode: "CART_TRANSFER_SUPPORTED",
      cartTransferSupported: true,
      configured: true,
    });

    const requiredStatePaths = [
      "CARTIVA_MOBILE_SESSION_FILE",
      "CARTIVA_MOBILE_OAUTH_STATE_DIR",
      "CARTIVA_MOBILE_OAUTH_COMPLETION_DIR",
      "CARTIVA_MOBILE_KROGER_SESSION_DIR",
      "CARTIVA_COMPARISON_RECEIPT_FILE",
      "KROGER_CART_RECEIPT_FILE",
    ] as const;
    for (const name of requiredStatePaths) {
      const configured = process.env[name]!;
      vi.stubEnv(name, "");
      expect(mobileKrogerCapabilityStatus()).toMatchObject({
        mode: "SHOPPING_PAGE_ONLY",
        cartTransferSupported: false,
        configured: false,
        reason: expect.stringMatching(/absolute paths/i),
      });
      vi.stubEnv(name, configured);
    }

    vi.stubEnv("CARTIVA_MOBILE_SESSION_FILE", "relative/mobile-sessions.json");
    expect(mobileKrogerCapabilityStatus()).toMatchObject({
      mode: "SHOPPING_PAGE_ONLY",
      cartTransferSupported: false,
      configured: false,
      reason: expect.stringMatching(/absolute paths/i),
    });
  });

  it("requires a claimed HTTPS app return link in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CARTIVA_SECURE_STATE_MODE", "SINGLE_INSTANCE_FILESYSTEM");
    vi.stubEnv("CARTIVA_MOBILE_SESSION_FILE", path.join(directory, "mobile-sessions.json"));
    vi.stubEnv("CARTIVA_MOBILE_OAUTH_STATE_DIR", path.join(directory, "states"));
    vi.stubEnv("CARTIVA_MOBILE_OAUTH_COMPLETION_DIR", path.join(directory, "completions"));
    vi.stubEnv("CARTIVA_MOBILE_KROGER_SESSION_DIR", path.join(directory, "sessions"));
    vi.stubEnv("CARTIVA_COMPARISON_RECEIPT_FILE", path.join(directory, "comparisons.json"));
    vi.stubEnv("KROGER_CART_RECEIPT_FILE", path.join(directory, "cart-receipts.json"));
    vi.stubEnv("CARTIVA_MOBILE_APP_RETURN_URI", "cartiva://oauth/kroger");
    expect(mobileKrogerCapabilityStatus()).toMatchObject({
      mode: "SHOPPING_PAGE_ONLY",
      configured: false,
    });
  });
});

describe("owner-scoped Kroger mobile OAuth", () => {
  it("does not let a cached customer client bypass the runtime cart-write kill switch", () => {
    const ownerId = issueMobileSession().ownerId;
    expect(getMobileKrogerAuthClient(ownerId)).toBeDefined();
    vi.stubEnv("CARTIVA_ENABLE_KROGER_CART_WRITES", "false");
    expect(() => getMobileKrogerAuthClient(ownerId)).toThrow(/not explicitly enabled/i);
  });

  it("bounds pending authorization starts per temporary owner", async () => {
    const ownerId = issueMobileSession().ownerId;
    for (let index = 0; index < 8; index += 1) {
      await createMobileKrogerAuthorization(ownerId, `comparison_owner_limit_${index}`);
    }
    await expect(createMobileKrogerAuthorization(
      ownerId,
      "comparison_owner_limit_9",
    )).rejects.toMatchObject({ code: "rate_limit", status: 429 });
    expect((await readdir(path.join(directory, "states")))
      .filter((entry) => entry.endsWith(".json"))).toHaveLength(8);
  });

  it("verifies a pending OAuth state with the configured previous signing secret", async () => {
    const issued = issueMobileSession();
    const url = new URL(await createMobileKrogerAuthorization(
      issued.ownerId,
      "comparison_state_key_rotation",
    ));

    rotateSessionSecret();

    expect(verifyMobileSessionToken(issued.sessionToken)).toMatchObject({ ownerId: issued.ownerId });
    await expect(consumeMobileKrogerAuthorizationState(url.searchParams.get("state")!))
      .resolves.toMatchObject({
        ownerId: issued.ownerId,
        comparisonId: "comparison_state_key_rotation",
      });
  });

  it("prunes expired pending authorization state before registering another", async () => {
    const base = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(base);
      const ownerId = issueMobileSession().ownerId;
      await createMobileKrogerAuthorization(ownerId, "comparison_state_expiry_1");
      vi.setSystemTime(base + 11 * 60_000);
      await createMobileKrogerAuthorization(ownerId, "comparison_state_expiry_2");
      expect((await readdir(path.join(directory, "states")))
        .filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses documented scopes, durable one-use state, and an owner-bound encrypted token", async () => {
    const fetcher = vi.fn(async () => tokenResponse());
    vi.stubGlobal("fetch", fetcher);
    const ownerId = issueMobileSession().ownerId;
    const authorizationUrl = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_mobile_0001",
    ));

    expect(authorizationUrl.origin).toBe("https://api.kroger.com");
    expect(authorizationUrl.pathname).toBe("/v1/connect/oauth2/authorize");
    expect(authorizationUrl.searchParams.get("scope"))
      .toBe("cart.basic:write");
    expect(authorizationUrl.searchParams.get("redirect_uri"))
      .toBe("https://api.cartiva.test/api/mobile/v1/kroger/oauth/callback");
    expect(authorizationUrl.toString()).not.toContain("mobile-client-secret");

    const state = authorizationUrl.searchParams.get("state")!;
    const pending = await consumeMobileKrogerAuthorizationState(state);
    expect(pending).toMatchObject({ ownerId, comparisonId: "comparison_mobile_0001" });
    await expect(consumeMobileKrogerAuthorizationState(state)).rejects.toMatchObject({
      code: "oauth_state",
    });

    await exchangeAndActivate(pending, "authorization-code");
    expect(await getMobileKrogerAuthClient(ownerId).connectionStatus())
      .toEqual({ connected: true });
    const authorizationGeneration = await getMobileKrogerAuthClient(ownerId)
      .getAuthorizationGeneration();
    expect(authorizationGeneration).toMatch(/^[A-Za-z0-9_-]{43}$/);
    resetMobileKrogerAuthForTests();
    expect(await getMobileKrogerAuthClient(ownerId).getAuthorizationGeneration())
      .toBe(authorizationGeneration);
    const serialized = await readFile(path.join(directory, "sessions", `${ownerId}.json`), "utf8");
    expect(serialized).not.toMatch(/customer-access-token|customer-refresh-token/);
    expect(JSON.parse(serialized)).toMatchObject({ version: 3, algorithm: "aes-256-gcm" });
  });

  it("allows exactly one concurrent consumer to claim an OAuth state", async () => {
    const ownerId = issueMobileSession().ownerId;
    const authorizationUrl = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_concurrent_state_1",
    ));
    const state = authorizationUrl.searchParams.get("state")!;

    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => consumeMobileKrogerAuthorizationState(state)),
    );
    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof consumeMobileKrogerAuthorizationState>>> => (
        attempt.status === "fulfilled"
      ),
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].value).toMatchObject({
      ownerId,
      comparisonId: "comparison_concurrent_state_1",
    });
    expect(rejected).toHaveLength(7);
    for (const attempt of rejected) {
      expect(attempt.reason).toMatchObject({ code: "oauth_state" });
    }
  });

  it("does not let a second pending callback replace an already-connected account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));
    const ownerId = issueMobileSession().ownerId;
    const firstUrl = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_parallel_account_1",
    ));
    const secondUrl = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_parallel_account_2",
    ));
    const first = await consumeMobileKrogerAuthorizationState(firstUrl.searchParams.get("state")!);
    const second = await consumeMobileKrogerAuthorizationState(secondUrl.searchParams.get("state")!);
    await exchangeAndActivate(first, "first-account-code");
    await expect(prepareMobileKrogerAuthorizationCompletion(
      second,
      "second-account-code",
    )).rejects.toMatchObject({ code: "already_connected", status: 409 });
  });

  it("activates a staged completion signed before a configured signing-key rotation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));
    const ownerId = issueMobileSession().ownerId;
    const url = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_completion_rotation",
    ));
    const pending = await consumeMobileKrogerAuthorizationState(url.searchParams.get("state")!);
    const completion = await prepareMobileKrogerAuthorizationCompletion(
      pending,
      "pre-rotation-code",
    );

    rotateSessionSecret();

    await expect(activateMobileKrogerAuthorization(ownerId, completion.completion))
      .resolves.toMatchObject({ authorization: "CONNECTED" });
  });

  it("invalidates an OAuth state already claimed before explicit disconnect", async () => {
    const providerFetch = vi.fn(async () => tokenResponse());
    vi.stubGlobal("fetch", providerFetch);
    const ownerId = issueMobileSession().ownerId;
    const url = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_disconnect_claimed_state",
    ));
    const pending = await consumeMobileKrogerAuthorizationState(url.searchParams.get("state")!);

    await disconnectMobileKroger(ownerId);
    await expect(prepareMobileKrogerAuthorizationCompletion(pending, "late-code"))
      .rejects.toMatchObject({ code: "oauth_state", status: 400 });
    expect(providerFetch).not.toHaveBeenCalled();
    await expect(mobileKrogerConnectionStatus(ownerId))
      .resolves.toMatchObject({ authorization: "NOT_CONNECTED" });
  });

  it("reads a previous-key disconnect marker when issuing state after rotation", async () => {
    const ownerId = issueMobileSession().ownerId;
    await disconnectMobileKroger(ownerId);

    rotateSessionSecret();
    const url = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_marker_key_rotation",
    ));

    await expect(consumeMobileKrogerAuthorizationState(url.searchParams.get("state")!))
      .resolves.toMatchObject({ ownerId, comparisonId: "comparison_marker_key_rotation" });
  });

  it("prunes a dormant disconnect marker before its old signing key is retired", async () => {
    const base = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(base);
      const ownerId = issueMobileSession().ownerId;
      await disconnectMobileKroger(ownerId);
      const markerFile = path.join(directory, "states", `${ownerId}.disconnected`);
      await expect(stat(markerFile)).resolves.toBeDefined();

      vi.setSystemTime(base + 11 * 60_000);
      vi.stubEnv("CARTIVA_SESSION_SECRET", ROTATED_SESSION_SECRET);
      vi.stubEnv("CARTIVA_SESSION_PREVIOUS_SECRET", "");
      const url = new URL(await createMobileKrogerAuthorization(
        ownerId,
        "comparison_dormant_marker_rotation",
      ));

      await expect(stat(markerFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(consumeMobileKrogerAuthorizationState(url.searchParams.get("state")!))
        .resolves.toMatchObject({ ownerId });
    } finally {
      vi.useRealTimers();
    }
  });

  it("disconnects and removes pending state signed before key rotation", async () => {
    const ownerId = issueMobileSession().ownerId;
    const url = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_disconnect_key_rotation",
    ));
    const state = url.searchParams.get("state")!;

    rotateSessionSecret();
    await expect(disconnectMobileKroger(ownerId))
      .resolves.toMatchObject({ authorization: "NOT_CONNECTED" });
    await expect(consumeMobileKrogerAuthorizationState(state))
      .rejects.toMatchObject({ code: "oauth_state" });
  });

  it("rejects a staged completion that survives a crash after the disconnect marker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));
    const ownerId = issueMobileSession().ownerId;
    const url = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_disconnect_crash_completion",
    ));
    const pending = await consumeMobileKrogerAuthorizationState(url.searchParams.get("state")!);
    const completion = await prepareMobileKrogerAuthorizationCompletion(pending, "staged-code");
    const hash = createHash("sha256")
      .update("Cartiva mobile Kroger OAuth completion\0", "utf8")
      .update(completion.completion, "utf8")
      .digest("hex");
    const ownerDirectory = path.join(directory, "completions", ownerId);
    const record = await readFile(path.join(ownerDirectory, `${hash}.json`));
    const stagedSession = await readFile(path.join(ownerDirectory, `${hash}.session`));

    await disconnectMobileKroger(ownerId);
    // Model a restart after the durable marker was committed but before the
    // old staged files were removed by restoring only those crash survivors.
    await mkdir(ownerDirectory, { recursive: true });
    await writeFile(path.join(ownerDirectory, `${hash}.json`), record);
    await writeFile(path.join(ownerDirectory, `${hash}.session`), stagedSession);
    resetMobileKrogerAuthForTests();

    await expect(activateMobileKrogerAuthorization(ownerId, completion.completion))
      .rejects.toMatchObject({ code: "oauth_binding", status: 400 });
    await expect(stat(path.join(directory, "sessions", `${ownerId}.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects swapped staged sessions before either Kroger account can activate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));
    const ownerId = issueMobileSession().ownerId;
    const firstUrl = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_staged_binding_a",
    ));
    const secondUrl = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_staged_binding_b",
    ));
    const firstPending = await consumeMobileKrogerAuthorizationState(
      firstUrl.searchParams.get("state")!,
    );
    const secondPending = await consumeMobileKrogerAuthorizationState(
      secondUrl.searchParams.get("state")!,
    );
    const first = await prepareMobileKrogerAuthorizationCompletion(
      firstPending,
      "first-account-code",
    );
    const second = await prepareMobileKrogerAuthorizationCompletion(
      secondPending,
      "second-account-code",
    );
    const hash = (value: string) => createHash("sha256")
      .update("Cartiva mobile Kroger OAuth completion\0", "utf8")
      .update(value, "utf8")
      .digest("hex");
    const completionDirectory = path.join(directory, "completions", ownerId);
    const firstSession = path.join(completionDirectory, `${hash(first.completion)}.session`);
    const secondSession = path.join(completionDirectory, `${hash(second.completion)}.session`);
    const temporary = path.join(completionDirectory, "swap.tmp");
    await rename(firstSession, temporary);
    await rename(secondSession, firstSession);
    await rename(temporary, secondSession);

    await expect(activateMobileKrogerAuthorization(ownerId, first.completion))
      .rejects.toMatchObject({ code: "storage", status: 503 });
    await expect(stat(path.join(directory, "sessions", `${ownerId}.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes abandoned pending encrypted sessions after their short completion window", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));
    const base = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(base);
      const ownerId = issueMobileSession().ownerId;
      const url = new URL(await createMobileKrogerAuthorization(
        ownerId,
        "comparison_abandoned_completion",
      ));
      const pending = await consumeMobileKrogerAuthorizationState(url.searchParams.get("state")!);
      await prepareMobileKrogerAuthorizationCompletion(pending, "abandoned-code");
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(await readdir(path.join(directory, "completions", ownerId)))
        .toEqual(expect.arrayContaining([expect.stringMatching(/\.json$/), expect.stringMatching(/\.session$/)]));

      await vi.advanceTimersByTimeAsync(6 * 60_000);
      // The production interval is unref'ed so fake-timer runners do not own
      // its lifecycle. Invoke the exact janitor sweep after proving it was
      // scheduled, at the advanced interval time.
      await pruneExpiredMobileKrogerAuthorizationCompletions();
      expect(await readdir(path.join(directory, "completions", ownerId))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes an expired staged completion signed by the previous key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));
    const base = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(base);
      const ownerId = issueMobileSession().ownerId;
      const url = new URL(await createMobileKrogerAuthorization(
        ownerId,
        "comparison_completion_janitor_rotation",
      ));
      const pending = await consumeMobileKrogerAuthorizationState(url.searchParams.get("state")!);
      await prepareMobileKrogerAuthorizationCompletion(pending, "pre-rotation-abandoned-code");

      rotateSessionSecret();
      vi.setSystemTime(base + 6 * 60_000);
      await pruneExpiredMobileKrogerAuthorizationCompletions();

      expect(await readdir(path.join(directory, "completions", ownerId))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot swap one owner's encrypted Kroger session into another owner file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));
    const ownerA = issueMobileSession().ownerId;
    const ownerB = issueMobileSession().ownerId;
    const url = new URL(await createMobileKrogerAuthorization(ownerA, "comparison_owner_swap_1"));
    const pending = await consumeMobileKrogerAuthorizationState(url.searchParams.get("state")!);
    await exchangeAndActivate(pending, "authorization-code");

    await mkdir(path.join(directory, "sessions"), { recursive: true });
    await copyFile(
      path.join(directory, "sessions", `${ownerA}.json`),
      path.join(directory, "sessions", `${ownerB}.json`),
    );
    await expect(getMobileKrogerAuthClient(ownerB).connectionStatus())
      .rejects.toMatchObject({ code: "storage", status: 503 });
    await expect(stat(path.join(directory, "sessions", `${ownerB}.json`))).resolves.toBeDefined();
  });

  it("rejects rather than migrates a plaintext session for an owner-bound mobile client", async () => {
    const ownerId = issueMobileSession().ownerId;
    const file = path.join(directory, "sessions", `${ownerId}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      version: 1,
      accessToken: "plaintext-mobile-access",
      refreshToken: "plaintext-mobile-refresh",
      expiresAt: Date.now() + 60_000,
    }), "utf8");

    await expect(getMobileKrogerAuthClient(ownerId).connectionStatus())
      .rejects.toMatchObject({ code: "storage", status: 503 });
    await expect(stat(file)).resolves.toBeDefined();
  });

  it("blocks OAuth start when the owner's saved-session path is unreadable", async () => {
    const ownerId = issueMobileSession().ownerId;
    const file = path.join(directory, "sessions", `${ownerId}.json`);
    await mkdir(file, { recursive: true });

    await expect(createMobileKrogerAuthorization(
      ownerId,
      "comparison_unreadable_session_1",
    )).rejects.toMatchObject({ code: "storage", status: 503 });
    await expect(stat(file)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("blocks a pending OAuth callback when the encrypted owner session cannot authenticate", async () => {
    const providerFetch = vi.fn(async () => tokenResponse());
    vi.stubGlobal("fetch", providerFetch);
    const ownerId = issueMobileSession().ownerId;
    const firstUrl = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_cipher_guard_a",
    ));
    const secondUrl = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_cipher_guard_b",
    ));
    const first = await consumeMobileKrogerAuthorizationState(firstUrl.searchParams.get("state")!);
    const second = await consumeMobileKrogerAuthorizationState(secondUrl.searchParams.get("state")!);
    await exchangeAndActivate(first, "first-account-code");

    const file = path.join(directory, "sessions", `${ownerId}.json`);
    const envelope = JSON.parse(await readFile(file, "utf8")) as { authTag: string };
    envelope.authTag = `${envelope.authTag.startsWith("a") ? "b" : "a"}${envelope.authTag.slice(1)}`;
    const tampered = JSON.stringify(envelope);
    await writeFile(file, tampered, "utf8");
    resetMobileKrogerAuthForTests();

    await expect(prepareMobileKrogerAuthorizationCompletion(second, "second-account-code"))
      .rejects.toMatchObject({ code: "storage", status: 503 });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toBe(tampered);
  });

  it("removes an owner's token even when callback configuration later becomes unavailable", async () => {
    const ownerId = issueMobileSession().ownerId;
    const file = path.join(directory, "sessions", `${ownerId}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "encrypted-placeholder", "utf8");
    resetMobileKrogerAuthForTests();
    vi.stubEnv("KROGER_MOBILE_REDIRECT_URI", "");

    const status = await disconnectMobileKroger(ownerId);
    expect(status.authorization).toBe("UNAVAILABLE");
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes refresh-capable status ahead of disconnect so refresh cannot restore the token", async () => {
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);
    let releaseRefresh!: () => void;
    let markRefreshStarted!: () => void;
    const refreshCanFinish = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const providerFetch = vi.fn(async () => {
      if (providerFetch.mock.calls.length === 1) {
        return new Response(JSON.stringify({
          access_token: "short-lived-customer-access",
          refresh_token: "short-lived-customer-refresh",
          expires_in: 120,
          scope: "cart.basic:write profile.compact product.compact",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      markRefreshStarted();
      await refreshCanFinish;
      return new Response(JSON.stringify({
        access_token: "rotated-customer-access",
        refresh_token: "rotated-customer-refresh",
        expires_in: 1_800,
        scope: "cart.basic:write profile.compact product.compact",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", providerFetch);

    const ownerId = issueMobileSession().ownerId;
    const authorizationUrl = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_refresh_disconnect_1",
    ));
    const pending = await consumeMobileKrogerAuthorizationState(
      authorizationUrl.searchParams.get("state")!,
    );
    await exchangeAndActivate(pending, "authorization-code");
    vi.setSystemTime(base + 61_000);
    const file = path.join(directory, "sessions", `${ownerId}.json`);

    const statusRequest = mobileKrogerConnectionStatus(ownerId);
    await refreshStarted;
    let disconnectCompleted = false;
    const disconnectRequest = disconnectMobileKroger(ownerId).then((status) => {
      disconnectCompleted = true;
      return status;
    });
    // Give an unlocked disconnect ample time to remove the file. The locked
    // implementation must remain queued for the still-paused refresh.
    await vi.advanceTimersByTimeAsync(25);
    expect(disconnectCompleted).toBe(false);

    releaseRefresh();
    await expect(statusRequest).resolves.toMatchObject({ authorization: "CONNECTED" });
    await expect(disconnectRequest).resolves.toMatchObject({ authorization: "NOT_CONNECTED" });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(mobileKrogerConnectionStatus(ownerId))
      .resolves.toMatchObject({ authorization: "NOT_CONNECTED" });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes inactive owner token files after the temporary-session retention window", async () => {
    expect(MOBILE_KROGER_SESSION_RETENTION_MS).toBe(7 * 24 * 60 * 60_000);
    expect(MOBILE_KROGER_SESSION_RETENTION_MS).not.toBe(MOBILE_SESSION_TTL_MS);
    const oldOwner = issueMobileSession().ownerId;
    const file = path.join(directory, "sessions", `${oldOwner}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "old", "utf8");
    const now = Date.now();
    const oldSeconds = (now - MOBILE_KROGER_SESSION_RETENTION_MS - 1_000) / 1_000;
    await utimes(file, oldSeconds, oldSeconds);

    // The owner that triggered pruning is not exempt from the inactivity
    // policy; a returning stale recovery credential cannot pin Kroger forever.
    await pruneExpiredMobileKrogerSessions(oldOwner, now);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("disconnects a returning owner whose Kroger token file exceeded seven days of inactivity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));
    const ownerId = issueMobileSession().ownerId;
    const authorizationUrl = new URL(await createMobileKrogerAuthorization(
      ownerId,
      "comparison_returning_owner_retention",
    ));
    const pending = await consumeMobileKrogerAuthorizationState(
      authorizationUrl.searchParams.get("state")!,
    );
    await exchangeAndActivate(pending, "authorization-code");
    const file = path.join(directory, "sessions", `${ownerId}.json`);
    const staleSeconds = (Date.now() - MOBILE_KROGER_SESSION_RETENTION_MS - 1_000) / 1_000;
    await utimes(file, staleSeconds, staleSeconds);

    await expect(mobileKrogerConnectionStatus(ownerId)).resolves.toMatchObject({
      authorization: "NOT_CONNECTED",
    });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Kroger mobile OAuth return validation", () => {
  it("accepts only the expected comparison and known status", () => {
    expect(validateKrogerOAuthReturn({
      status: "pending",
      comparisonId: "comparison_expected_001",
      completion: "A".repeat(43),
    }, "comparison_expected_001")).toEqual({
      status: "pending",
      comparisonId: "comparison_expected_001",
      completion: "A".repeat(43),
    });
    expect(validateKrogerOAuthReturn({
      status: "pending",
      comparisonId: "comparison_expected_001",
      completion: "short",
    }, "comparison_expected_001")).toEqual({
      status: "failed",
      comparisonId: "comparison_expected_001",
    });
    expect(validateKrogerOAuthReturn({
      status: "connected",
      comparisonId: "comparison_expected_001",
    }, "comparison_expected_001")).toEqual({
      status: "connected",
      comparisonId: "comparison_expected_001",
    });
    expect(validateKrogerOAuthReturn({
      status: "connected",
      comparisonId: "comparison_attacker_001",
    }, "comparison_expected_001")).toEqual({ status: "failed" });
    expect(validateKrogerOAuthReturn({
      status: "connected",
    }, "comparison_expected_001")).toEqual({ status: "failed" });
    expect(validateKrogerOAuthReturn({
      status: "made-up",
      comparisonId: "comparison_expected_001",
    }, "comparison_expected_001")).toEqual({
      status: "failed",
      comparisonId: "comparison_expected_001",
    });
  });
});
