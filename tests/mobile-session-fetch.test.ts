import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secureStoreTestDouble as secureStore } from "@/tests/test-doubles/expo-secure-store";

import {
  clearMobileSession,
  getMobileSessionToken,
  mobileSessionFetch,
  resetMobileSession,
} from "@/mobile/src/services/mobile-session";

const SESSION_ID = "s".repeat(43);
const NEW_SESSION_ID = "n".repeat(43);
const accessToken = (marker: string, sessionId = SESSION_ID) => (
  `v1.${sessionId}.mabcdef12.${marker.repeat(43)}`
);
const recoveryToken = (marker: string, sessionId = SESSION_ID) => (
  `r1.${sessionId}.${marker.repeat(43)}`
);
const ACCESS = accessToken("a");
const RECOVERY = recoveryToken("r");
const NEW_ACCESS = accessToken("b", NEW_SESSION_ID);
const NEW_RECOVERY = recoveryToken("q", NEW_SESSION_ID);
const accessExpiry = (access: string) => (
  new Date(Number.parseInt(access.split(".")[2]!, 36)).toISOString()
);
const sessionResponse = (access: string, recovery: string) => ({
  sessionToken: access,
  recoveryToken: recovery,
  expiresAt: accessExpiry(access),
});
const storedCredentials = (
  access = ACCESS,
  recovery = RECOVERY,
  pendingRecoveryToken?: string,
) => JSON.stringify({
  version: 2,
  accessToken: access,
  recoveryToken: recovery,
  ...(pendingRecoveryToken ? { pendingRecoveryToken } : {}),
});

describe("mobile session fetch retry boundary", () => {
  beforeEach(async () => {
    vi.stubGlobal("__DEV__", true);
    secureStore.getItemAsync = vi.fn(async () => null);
    secureStore.setItemAsync = vi.fn(async () => undefined);
    secureStore.deleteItemAsync = vi.fn(async () => undefined);
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(async () => storedCredentials());
    secureStore.setItemAsync = vi.fn(async () => undefined);
    secureStore.deleteItemAsync = vi.fn(async () => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the existing bearer when Kroger status is temporarily unavailable", async () => {
    const requestFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      void input;
      void init;
      return Response.json(
        {
          error: "Kroger authorization did not respond in time.",
          code: "upstream",
        },
        { status: 502 },
      );
    });
    vi.stubGlobal("fetch", requestFetch);

    const response = await mobileSessionFetch("api/mobile/v1/kroger/auth/status", {
      method: "GET",
    });

    expect(response.status).toBe(502);
    expect(requestFetch).toHaveBeenCalledTimes(1);
    expect(requestFetch.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3000/api/mobile/v1/kroger/auth/status",
    );
    expect(requestFetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: expect.objectContaining({
        Authorization: `Bearer ${ACCESS}`,
      }),
    });
    expect(secureStore.getItemAsync).toHaveBeenCalledTimes(1);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("keeps the same owner when Kroger disconnect storage is unavailable", async () => {
    const requestFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      void input;
      void init;
      return Response.json(
        {
          error: "Cartiva could not safely disconnect Kroger. The existing Cartiva session was kept.",
          code: "disconnect_unavailable",
          retrySafe: false,
        },
        { status: 503 },
      );
    });
    vi.stubGlobal("fetch", requestFetch);

    const response = await mobileSessionFetch("api/mobile/v1/kroger/auth/disconnect", {
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(requestFetch).toHaveBeenCalledTimes(1);
    expect(requestFetch.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: `Bearer ${ACCESS}`,
      }),
    });
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("blocks owner rotation when the iOS keychain cannot be read", async () => {
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(async () => {
      throw new Error("keychain temporarily unavailable");
    });
    const requestFetch = vi.fn();
    vi.stubGlobal("fetch", requestFetch);

    await expect(getMobileSessionToken()).rejects.toThrow(/secure temporary session/i);
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("does not publish a newly issued owner until the keychain write succeeds", async () => {
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(async () => null);
    secureStore.setItemAsync = vi.fn(async () => {
      throw new Error("keychain write failed");
    });
    const requestFetch = vi.fn(async () => Response.json(
      sessionResponse(NEW_ACCESS, NEW_RECOVERY),
    ));
    vi.stubGlobal("fetch", requestFetch);

    await expect(getMobileSessionToken()).rejects.toThrow("keychain write failed");
    expect(requestFetch).toHaveBeenCalledTimes(1);

    secureStore.setItemAsync = vi.fn(async () => undefined);
    await expect(getMobileSessionToken()).resolves.toBe(NEW_ACCESS);
    expect(requestFetch).toHaveBeenCalledTimes(2);
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ sessionToken: "malformed", recoveryToken: NEW_RECOVERY, expiresAt: accessExpiry(NEW_ACCESS) }],
    [{ ...sessionResponse(NEW_ACCESS, recoveryToken("q", SESSION_ID)) }],
    [{ ...sessionResponse(NEW_ACCESS, NEW_RECOVERY), expiresAt: "2026-08-25T00:00:00.000Z" }],
    [{ ...sessionResponse(NEW_ACCESS, NEW_RECOVERY), unexpected: true }],
    [{ sessionToken: NEW_ACCESS, recoveryToken: NEW_RECOVERY }],
  ])("rejects a malformed or cross-owner bootstrap response before SecureStore", async (body) => {
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(async () => null);
    const requestFetch = vi.fn(async () => Response.json(body));
    vi.stubGlobal("fetch", requestFetch);

    await expect(getMobileSessionToken()).rejects.toThrow(/could not start/i);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("bounds a never-resolving first-launch session request", async () => {
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(async () => null);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
    )));

    const assertion = expect(getMobileSessionToken()).rejects.toThrow(
      "timed out while starting",
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });

  it("keeps the bootstrap deadline active when headers arrive but JSON never finishes", async () => {
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(async () => null);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: () => new Promise<never>(() => undefined),
    } as unknown as Response)));

    const assertion = expect(getMobileSessionToken()).rejects.toThrow(
      "timed out while starting",
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });

  it("lets one caller stop waiting without cancelling the shared session bootstrap", async () => {
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(async () => null);
    let finishSession!: () => void;
    const requestFetch = vi.fn(() => new Promise<Response>((resolve) => {
      finishSession = () => resolve(Response.json(sessionResponse(NEW_ACCESS, NEW_RECOVERY)));
    }));
    vi.stubGlobal("fetch", requestFetch);
    const controller = new AbortController();

    const cancelledWaiter = getMobileSessionToken(controller.signal);
    await vi.waitFor(() => expect(requestFetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(cancelledWaiter).rejects.toMatchObject({ name: "AbortError" });

    finishSession();
    await expect(getMobileSessionToken()).resolves.toBe(NEW_ACCESS);
    expect(requestFetch).toHaveBeenCalledOnce();
  });

  it("keeps a timed-out bootstrap single-flight until its late keychain commit settles", async () => {
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(async () => null);
    let finishKeychainWrite!: () => void;
    secureStore.setItemAsync = vi.fn(() => new Promise<void>((resolve) => {
      finishKeychainWrite = resolve;
    }));
    const requestFetch = vi.fn(async () => Response.json(
      sessionResponse(NEW_ACCESS, NEW_RECOVERY),
    ));
    vi.stubGlobal("fetch", requestFetch);
    vi.useFakeTimers();

    const first = expect(getMobileSessionToken()).rejects.toThrow("in-progress owner was kept");
    await vi.waitFor(() => expect(secureStore.setItemAsync).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_000);
    await first;

    const second = getMobileSessionToken();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestFetch).toHaveBeenCalledOnce();
    expect(secureStore.setItemAsync).toHaveBeenCalledOnce();
    finishKeychainWrite();
    await expect(second).resolves.toBe(NEW_ACCESS);
    await expect(getMobileSessionToken()).resolves.toBe(NEW_ACCESS);
  });

  it("serializes explicit clear after a late bootstrap write and never republishes the old owner", async () => {
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(async () => null);
    const order: string[] = [];
    let finishWrite!: () => void;
    secureStore.setItemAsync = vi.fn(() => new Promise<void>((resolve) => {
      order.push("set-started");
      finishWrite = () => {
        order.push("set-finished");
        resolve();
      };
    }));
    secureStore.deleteItemAsync = vi.fn(async () => {
      order.push("delete");
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      sessionResponse(NEW_ACCESS, NEW_RECOVERY),
    )));

    const bootstrap = getMobileSessionToken();
    await vi.waitFor(() => expect(secureStore.setItemAsync).toHaveBeenCalledOnce());
    const clearing = clearMobileSession();
    finishWrite();
    await expect(bootstrap).rejects.toMatchObject({ name: "AbortError" });
    await clearing;
    expect(order).toEqual(["set-started", "set-finished", "delete"]);
  });

  it("does not let a late keychain read republish credentials after explicit clear", async () => {
    await clearMobileSession();
    let finishRead!: () => void;
    secureStore.getItemAsync = vi.fn(() => new Promise<string | null>((resolve) => {
      finishRead = () => resolve(storedCredentials());
    }));
    const reading = getMobileSessionToken();
    await vi.waitFor(() => expect(secureStore.getItemAsync).toHaveBeenCalledOnce());
    const clearing = clearMobileSession();
    finishRead();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    await clearing;
  });

  it("bounds and deduplicates a stalled keychain read without issuing a new owner", async () => {
    await clearMobileSession();
    secureStore.getItemAsync = vi.fn(() => new Promise<string | null>(() => undefined));
    const requestFetch = vi.fn();
    vi.stubGlobal("fetch", requestFetch);
    vi.useFakeTimers();

    const first = expect(getMobileSessionToken()).rejects.toThrow("reading the secure temporary session");
    const second = expect(getMobileSessionToken()).rejects.toThrow("reading the secure temporary session");
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([first, second]);
    expect(secureStore.getItemAsync).toHaveBeenCalledOnce();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("renews an expired token for the same owner before retrying", async () => {
    let proposedRecovery = "";
    const renewedAccess = accessToken("b");
    const requestFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/mobile/v1/session/renew")) {
        expect(init?.headers).toEqual(expect.objectContaining({
          Authorization: `Bearer ${RECOVERY}`,
        }));
        proposedRecovery = (JSON.parse(String(init?.body)) as { nextRecoveryToken: string })
          .nextRecoveryToken;
        expect(proposedRecovery).toMatch(new RegExp(`^r1\\.${SESSION_ID}\\.`));
        return Response.json(sessionResponse(renewedAccess, proposedRecovery));
      }
      const authorization = (init?.headers as Record<string, string>)?.Authorization;
      if (authorization === `Bearer ${ACCESS}`) {
        return Response.json({ code: "expired" }, { status: 401 });
      }
      expect(authorization).toBe(`Bearer ${renewedAccess}`);
      return Response.json({ status: "NONE" });
    });
    vi.stubGlobal("fetch", requestFetch);

    await expect(mobileSessionFetch("api/mobile/v1/kroger/cart", { method: "GET" }))
      .resolves.toMatchObject({ status: 200 });
    expect(requestFetch).toHaveBeenCalledTimes(3);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(2);
    const finalStored = JSON.parse(String(vi.mocked(secureStore.setItemAsync).mock.calls.at(-1)?.[1]));
    expect(finalStored).toEqual({
      version: 2,
      accessToken: renewedAccess,
      recoveryToken: proposedRecovery,
    });
  });

  it("renews the same owner before a near-expiry protected operation", async () => {
    const renewedAccess = accessToken("c");
    const requestFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/mobile/v1/session/renew")) {
        const proposed = (JSON.parse(String(init?.body)) as { nextRecoveryToken: string })
          .nextRecoveryToken;
        return Response.json(sessionResponse(renewedAccess, proposed));
      }
      const authorization = (init?.headers as Record<string, string>)?.Authorization;
      return authorization === `Bearer ${ACCESS}`
        ? Response.json({ code: "renew_required" }, { status: 401 })
        : Response.json({ status: "NONE" });
    });
    vi.stubGlobal("fetch", requestFetch);

    await expect(mobileSessionFetch("api/mobile/v1/kroger/cart", { method: "GET" }))
      .resolves.toMatchObject({ status: 200 });
    expect(requestFetch).toHaveBeenCalledTimes(3);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("replays the exact persisted recovery rotation after a lost renewal response", async () => {
    const renewedAccess = accessToken("d");
    const renewalBodies: string[] = [];
    let renewalAttempts = 0;
    const requestFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/mobile/v1/session/renew")) {
        renewalAttempts += 1;
        renewalBodies.push(String(init?.body));
        if (renewalAttempts === 1) throw new TypeError("response lost");
        const proposed = (JSON.parse(String(init?.body)) as { nextRecoveryToken: string })
          .nextRecoveryToken;
        return Response.json(sessionResponse(renewedAccess, proposed));
      }
      const authorization = (init?.headers as Record<string, string>)?.Authorization;
      return authorization === `Bearer ${ACCESS}`
        ? Response.json({ code: "expired" }, { status: 401 })
        : Response.json({ status: "NONE" });
    });
    vi.stubGlobal("fetch", requestFetch);

    await expect(mobileSessionFetch("api/mobile/v1/kroger/cart", { method: "GET" }))
      .rejects.toThrow("response lost");
    await expect(mobileSessionFetch("api/mobile/v1/kroger/cart", { method: "GET" }))
      .resolves.toMatchObject({ status: 200 });
    expect(renewalBodies).toHaveLength(2);
    expect(renewalBodies[1]).toBe(renewalBodies[0]);
  });

  it("rejects a renewal response that changes the owner session ID", async () => {
    const requestFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/mobile/v1/session/renew")) {
        return Response.json(sessionResponse(NEW_ACCESS, NEW_RECOVERY));
      }
      return Response.json({ code: "expired" }, { status: 401 });
    });
    vi.stubGlobal("fetch", requestFetch);

    await expect(mobileSessionFetch("api/mobile/v1/kroger/cart", { method: "GET" }))
      .rejects.toThrow(/existing owner was kept/i);
    const conservative = JSON.parse(String(vi.mocked(secureStore.setItemAsync).mock.calls.at(-1)?.[1]));
    expect(conservative.accessToken).toBe(ACCESS);
    expect(conservative.recoveryToken).toBe(RECOVERY);
    expect(conservative.pendingRecoveryToken).toMatch(new RegExp(`^r1\\.${SESSION_ID}\\.`));
  });

  it("never rotates owners automatically when an existing bearer becomes invalid", async () => {
    const renewedAccess = accessToken("e");
    const requestFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/mobile/v1/session/renew")) {
        const proposed = (JSON.parse(String(init?.body)) as { nextRecoveryToken: string })
          .nextRecoveryToken;
        return Response.json(sessionResponse(renewedAccess, proposed));
      }
      const authorization = (init?.headers as Record<string, string>)?.Authorization;
      return authorization === `Bearer ${ACCESS}`
        ? Response.json(
          { code: "invalid", error: "Session signing configuration changed." },
          { status: 401 },
        )
        : Response.json({ status: "NONE" });
    });
    vi.stubGlobal("fetch", requestFetch);

    const response = await mobileSessionFetch("api/mobile/v1/kroger/cart", { method: "GET" });
    expect(response.status).toBe(200);
    expect(requestFetch).toHaveBeenCalledTimes(3);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
    await expect(getMobileSessionToken()).resolves.toBe(renewedAccess);
  });

  it("keeps the expired owner and fails closed when same-owner renewal fails", async () => {
    const requestFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/mobile/v1/session/renew")) {
        return Response.json({ error: "Same-owner renewal is unavailable." }, { status: 503 });
      }
    expect((init?.headers as Record<string, string>)?.Authorization)
        .toBe(`Bearer ${ACCESS}`);
      return Response.json({ code: "expired" }, { status: 401 });
    });
    vi.stubGlobal("fetch", requestFetch);

    await expect(mobileSessionFetch("api/mobile/v1/kroger/cart", { method: "GET" }))
      .rejects.toThrow("Same-owner renewal is unavailable");
    expect(requestFetch).toHaveBeenCalledTimes(2);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
    const conservative = JSON.parse(String(vi.mocked(secureStore.setItemAsync).mock.calls[0]?.[1]));
    expect(conservative).toMatchObject({
      version: 2,
      accessToken: ACCESS,
      recoveryToken: RECOVERY,
    });
    expect(conservative.pendingRecoveryToken).toMatch(new RegExp(`^r1\\.${SESSION_ID}\\.`));
  });

  it("confirms server revocation before clearing the device credential", async () => {
    const order: string[] = [];
    secureStore.deleteItemAsync = vi.fn(async () => {
      order.push("local-delete");
    });
    const requestFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      order.push(String((init?.headers as Record<string, string>)?.Authorization));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", requestFetch);

    await expect(resetMobileSession()).resolves.toEqual({ serverRevoked: true });
    expect(order).toEqual([`Bearer ${RECOVERY}`, "local-delete"]);
    expect(requestFetch).toHaveBeenCalledTimes(1);
    expect(requestFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("tries the exact pending rotation after the prior recovery cannot revoke", async () => {
    const pendingRecovery = recoveryToken("p");
    secureStore.getItemAsync = vi.fn(async () => (
      storedCredentials(ACCESS, RECOVERY, pendingRecovery)
    ));
    const authorizations: string[] = [];
    const requestFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = String(
        (init?.headers as Record<string, string>)?.Authorization,
      );
      authorizations.push(authorization);
      return authorization === `Bearer ${pendingRecovery}`
        ? new Response(null, { status: 204 })
        : Response.json({ code: "invalid" }, { status: 401 });
    });
    vi.stubGlobal("fetch", requestFetch);

    await expect(resetMobileSession()).resolves.toEqual({ serverRevoked: true });
    expect(authorizations).toEqual([
      `Bearer ${RECOVERY}`,
      `Bearer ${pendingRecovery}`,
    ]);
  });

  it("can explicitly clear a damaged local session without inventing a new owner", async () => {
    secureStore.getItemAsync = vi.fn(async () => "{damaged");
    const requestFetch = vi.fn();
    vi.stubGlobal("fetch", requestFetch);

    await expect(resetMobileSession()).resolves.toEqual({ serverRevoked: false });
    expect(secureStore.deleteItemAsync).toHaveBeenCalledOnce();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("keeps the revoked credential locally when secure deletion fails so reset can retry", async () => {
    secureStore.deleteItemAsync = vi.fn(async () => {
      throw new Error("keychain delete failed");
    });
    const requestFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", requestFetch);

    await expect(resetMobileSession()).rejects.toThrow("keychain delete failed");
    expect(requestFetch).toHaveBeenCalledOnce();
  });

  it("keeps SecureStore intact when revocation cannot be confirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network unavailable");
    }));

    await expect(resetMobileSession()).rejects.toThrow(/secure session was kept/i);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
    await expect(getMobileSessionToken()).resolves.toBe(ACCESS);
  });

  it("does not treat stale 401 recovery credentials as proof of revocation", async () => {
    const pendingRecovery = recoveryToken("p");
    secureStore.getItemAsync = vi.fn(async () => (
      storedCredentials(ACCESS, RECOVERY, pendingRecovery)
    ));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: "This Cartiva recovery credential is invalid or revoked.",
      code: "invalid",
    }, { status: 401 })));

    await expect(resetMobileSession()).rejects.toThrow(/secure session was kept/i);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("blocks a new owner bootstrap until explicit server revocation finishes", async () => {
    let finishRevocation!: () => void;
    const requestFetch = vi.fn(() => new Promise<Response>((resolve) => {
      finishRevocation = () => resolve(new Response(null, { status: 204 }));
    }));
    vi.stubGlobal("fetch", requestFetch);

    const resetting = resetMobileSession();
    await vi.waitFor(() => expect(requestFetch).toHaveBeenCalledOnce());
    await expect(getMobileSessionToken()).rejects.toThrow(/resetting this device/i);
    finishRevocation();
    await expect(resetting).resolves.toEqual({ serverRevoked: true });
  });
});
