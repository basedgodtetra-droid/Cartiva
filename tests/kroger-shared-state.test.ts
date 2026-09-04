import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { krogerHandoffSchemaStatements } from "../db/schema";
import { executeSharedCommand, consumeBridgeNonce, withSharedDatabase, type SharedDatabase, type SharedStatement } from "@/lib/kroger-shared-sql";
import { bridgeSignature, SHARED_PATH, SESSION_LEASE_MS, sealShared, stateHash, validSharedCommand, type SharedSession, type SharedCommand } from "@/lib/kroger-shared-protocol";
import { createSharedKrogerAuthorization, disconnectSharedKrogerWebSession, sharedLeaseForClient, sharedWebOwner, withSharedKrogerWebSession } from "@/lib/kroger-shared-web";
import { runSharedKrogerCartOperation, sharedCartId } from "@/lib/kroger-shared-cart";
import { GET as callback } from "@/app/api/kroger/oauth/callback/route";
import { GET as oauthStartGet } from "@/app/api/kroger/oauth/start/route";
import { POST as bridge } from "@/app/api/internal/kroger-state/route";
import { GET as pendingReview, POST as acknowledge } from "@/app/api/kroger/cart/review/route";
import { sharedCommand } from "@/lib/kroger-shared-client";
import { resetKrogerAuthClientForTests } from "@/lib/kroger-auth";

const origin = "https://cartiva-smoky.vercel.app";
const opened: DatabaseSync[] = [];
function database() {
  const sqlite = new DatabaseSync(":memory:");
  opened.push(sqlite);
  for (const sql of krogerHandoffSchemaStatements) sqlite.exec(sql);
  class Statement implements SharedStatement {
    constructor(readonly sql: string, readonly values: (string | number | null)[] = []) {}
    bind(...values: (string | number | null)[]) { return new Statement(this.sql, values); }
    async first<T>() { return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null; }
    async run() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  }
  const db: SharedDatabase = {
    prepare: sql => new Statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map(statement => {
          const s = statement as Statement;
          return { results: sqlite.prepare(s.sql).all(...s.values) as Record<string, unknown>[] };
        });
        sqlite.exec("COMMIT");
        return result;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return { db, sqlite, run: (command: SharedCommand, now?: number) => executeSharedCommand(db, command, now) };
}
const token = () => randomBytes(32).toString("base64url");
const owner = () => `web2:${randomBytes(32).toString("hex")}`;
const cookiePairs = (cookies: string[]) => cookies.map(v => v.split(";", 1)[0]).join("; ");
const req = (cookies = "") => new Request(`${origin}/api/kroger/auth/status`, { headers: { cookie: cookies, Origin: origin } });

beforeEach(() => {
  vi.stubEnv("CARTIVA_PUBLIC_ORIGIN", origin);
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("CARTIVA_SHARED_STATE_MODE", "d1");
  vi.stubEnv("CARTIVA_SHARED_STATE_SECRET", "shared-state-test-secret-with-more-than-forty-three-characters");
  vi.stubEnv("CARTIVA_WEB_SESSION_SECRET", "web-state-test-secret-with-more-than-thirty-two-characters");
  vi.stubEnv("KROGER_CLIENT_ID", "shared-test-client");
  vi.stubEnv("KROGER_CLIENT_SECRET", "shared-test-client-secret");
  vi.stubEnv("KROGER_REDIRECT_URI", `${origin}/api/retailers/kroger/oauth/callback`);
  resetKrogerAuthClientForTests();
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers();
  for (const db of opened.splice(0)) db.close();
  resetKrogerAuthClientForTests();
});

async function connected(db: SharedDatabase, expiresIn = 3600) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "initial-access", refresh_token: "initial-refresh", expires_in: expiresIn, scope: "cart.basic:write" })));
  const started = await withSharedDatabase(db, () => createSharedKrogerAuthorization(req()));
  const cookies = cookiePairs([...started.setCookies, started.result.stateCookie]);
  const state = new URL(started.result.authorizationUrl).searchParams.get("state")!;
  const response = await withSharedDatabase(db, () => callback(new Request(`${origin}/api/kroger/oauth/callback?code=test-code&state=${state}`, { headers: { cookie: cookies } })));
  expect(response.status).toBe(200);
  return cookies;
}
const accepted = { success: true as const, addedCount: 2, itemCount: 1, cartUrl: "https://www.kroger.com/cart", chain: "KROGER",
  selectedSearchLocation: { locationId: "03500529", name: "Test store" }, locationBoundByCartApi: false as const, message: "Kroger accepted the test items." };

describe("real SQLite shared-state contract", () => {
  it.each(["toString", "constructor", "__proto__", "valueOf", "unknown"])("rejects prototype/unknown command %s", op => {
    expect(validSharedCommand({ op })).toBe(false);
  });
  it("has one lease winner across independent callers and fences abandoned refresh state", async () => {
    const { run } = database(); const o = owner(); const a = token(); const b = token();
    await run({ op: "session.ensure", owner: o }, 1000);
    const results = await Promise.all([a, b].map(lease => run({ op: "session.acquire", owner: o, lease }, 1000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winning = results.find(Boolean) as SharedSession;
    await run({ op: "session.save", owner: o, version: 0, lease: winning.refresh_lock_token!, encrypted: "old-token" }, 1001);
    expect(await run({ op: "session.release", owner: o, version: 1, lease: winning.refresh_lock_token! }, 1000 + SESSION_LEASE_MS)).toBeNull();
    const next = await run({ op: "session.acquire", owner: o, lease: token() }, 1000 + SESSION_LEASE_MS) as SharedSession;
    expect(next.session_encrypted).toBe(""); expect(next.session_version).toBe(2);
    expect(await run({ op: "session.save", owner: o, version: 1, lease: winning.refresh_lock_token!, encrypted: "late-token" }, 1000 + SESSION_LEASE_MS)).toBeNull();
  });
  it("consumes callback state only once and preserves disconnect tombstones", async () => {
    const { run } = database(); const o = owner(); const lease = token(); const hash = stateHash("state");
    await run({ op: "session.ensure", owner: o }); await run({ op: "session.acquire", owner: o, lease });
    await run({ op: "oauth.register", owner: o, lease, version: 0, hash, encrypted: "bound-state" });
    const results = await Promise.all([1, 2].map(() => run({ op: "oauth.consume", owner: o, hash })));
    expect(results.filter(Boolean)).toHaveLength(1);
    await run({ op: "session.revoke", owner: o });
    expect(await run({ op: "session.save", owner: o, lease, version: 0, encrypted: "late-callback" })).toBeNull();
    const retained = await run({ op: "session.ensure", owner: o }) as SharedSession;
    expect(retained.session_version).toBe(1); expect(retained.session_encrypted).toBe("");
  });
  it("retains unknown writes indefinitely and fences delayed attempt results", async () => {
    const { run } = database(); const o = owner(); const lease = token(); const id = stateHash("operation"); const fingerprint = token(); const attempt = token();
    await run({ op: "session.ensure", owner: o }); await run({ op: "session.acquire", owner: o, lease });
    const claim: SharedCommand = { op: "cart.claim", owner: o, lease, version: 0, id, fingerprint, attempt, payload: "encrypted" };
    expect(await run(claim)).toBe(true); expect(await run(claim)).toBe(false);
    expect(await run({ op: "cart.acknowledge", owner: o, id })).toBeNull();
    await run({ op: "session.release", owner: o, lease, version: 0 });
    expect(await run({ op: "cart.acknowledge", owner: o, id })).toBeTruthy();
    expect(await run({ op: "cart.retryable", owner: o, id, fingerprint, attempt })).toBeNull();
    expect(await run({ op: "cart.finish", owner: o, id, fingerprint, attempt, receipt: "late" })).toBeNull();
    expect(await run({ op: "cart.read", owner: o, id }, Date.now() + 365 * 86400000)).toMatchObject({ status: "outcome_unknown" });
  });
  it("guards NULL attempt metadata and never crosses owner boundaries", async () => {
    const { run, sqlite } = database(); const o = owner(); const lease = token(); const id = stateHash("operation");
    await run({ op: "session.ensure", owner: o }); await run({ op: "session.acquire", owner: o, lease });
    await run({ op: "cart.claim", owner: o, lease, version: 0, id, fingerprint: token(), attempt: token(), payload: "encrypted" });
    sqlite.prepare("UPDATE kroger_cart_operations SET error_code=NULL WHERE id=?").run(`web2:${id}`);
    expect(await run({ op: "cart.claim", owner: o, lease, version: 0, id: stateHash("other"), fingerprint: token(), attempt: token(), payload: "new" })).toBe(false);
    expect(await run({ op: "cart.read", owner: owner(), id })).toBeNull();
  });
  it("applies shared rate quotas atomically", async () => {
    const { run } = database();
    const results = await Promise.all(Array.from({ length: 20 }, () => run({ op: "rate", key: stateHash("quota"), limit: 8, windowMs: 60000 })));
    expect(results.filter(Boolean)).toHaveLength(8);
  });
  it("revocation cannot remove the review barrier while a cart PUT is in flight", async () => {
    const { run } = database(); const o = owner(); const lease = token(); const id = stateHash("inflight");
    await run({ op: "session.ensure", owner: o }); await run({ op: "session.acquire", owner: o, lease });
    await run({ op: "cart.claim", owner: o, lease, version: 0, id, fingerprint: token(), attempt: token(), payload: "encrypted" });
    await run({ op: "session.revoke", owner: o });
    expect(await run({ op: "cart.acknowledge", owner: o, id })).toBeNull();
    expect(await run({ op: "session.assert", owner: o, lease, version: 0 })).toBeNull();
    expect(await run({ op: "session.release", owner: o, lease, version: 0 })).toBeTruthy();
    expect(await run({ op: "cart.acknowledge", owner: o, id })).toBeTruthy();
  });
  it("a reviewed missing operation fences its delayed first claim", async () => {
    const { run } = database(); const o = owner(); const lease = token(); const id = stateHash("delayed");
    await run({ op: "session.ensure", owner: o });
    expect(await run({ op: "cart.acknowledge", owner: o, id })).toBeTruthy();
    await run({ op: "session.acquire", owner: o, lease });
    expect(await run({ op: "cart.claim", owner: o, lease, version: 0, id, fingerprint: token(), attempt: token(), payload: "late" })).toBe(false);
  });
  it("an old attempt cannot finish or reopen a newer retry", async () => {
    const { run } = database(); const o = owner(); const lease = token(); const id = stateHash("retry"); const fingerprint = token(); const a = token(); const b = token();
    await run({ op: "session.ensure", owner: o }); await run({ op: "session.acquire", owner: o, lease });
    const claim = { op: "cart.claim" as const, owner: o, lease, version: 0, id, fingerprint, payload: "test" };
    await run({ ...claim, attempt: a }); await run({ op: "cart.retryable", owner: o, id, fingerprint, attempt: a });
    expect(await run({ ...claim, attempt: b })).toBe(true);
    expect(await run({ op: "cart.retryable", owner: o, id, fingerprint, attempt: a })).toBeNull();
    expect(await run({ op: "cart.finish", owner: o, id, fingerprint, attempt: a, receipt: "late" })).toBeNull();
    expect(await run({ op: "cart.finish", owner: o, id, fingerprint, attempt: b, receipt: "accepted" })).toBeTruthy();
  });
  it("authenticates originless bridge calls and rejects replay, browser access and invalid signatures", async () => {
    const { db } = database(); const body = JSON.stringify({ op: "session.ensure", owner: owner() });
    const timestamp = String(Date.now()); const nonce = token();
    const headers = { "Content-Type": "application/json", "X-Cartiva-State-Time": timestamp, "X-Cartiva-State-Nonce": nonce,
      "X-Cartiva-State-Signature": bridgeSignature(body, timestamp, nonce) };
    const call = (h = headers) => withSharedDatabase(db, () => bridge(new Request(`${origin}${SHARED_PATH}`, { method: "POST", headers: h, body })));
    expect((await call()).status).toBe(200); expect((await call()).status).toBe(409);
    expect((await call({ ...headers, "X-Cartiva-State-Signature": token() })).status).toBe(401);
    expect((await call({ ...headers, Origin: origin } as typeof headers)).status).toBe(403);
    expect(await consumeBridgeNonce(db, stateHash(nonce))).toBe(false);
  });
});

describe("shared OAuth and cart integration", () => {
  it("GET OAuth start returns mutable redirect headers with the browser bindings", async () => {
    const { db } = database();
    const response = await withSharedDatabase(db, () => oauthStartGet(req()));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("redirect_uri=");
    expect(response.headers.getSetCookie().some(c => c.startsWith("__Host-cartiva-kroger-owner="))).toBe(true);
  });
  it("a busy status request does not spend the callback state before token exchange", async () => {
    const { db, run } = database(); const fetcher = vi.fn(async () => Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })); vi.stubGlobal("fetch", fetcher);
    const start = await withSharedDatabase(db, () => createSharedKrogerAuthorization(req()));
    const cookies = cookiePairs([...start.setCookies, start.result.stateCookie]);
    const identity = sharedWebOwner(req(cookies))!; const lease = token();
    await run({ op: "session.acquire", owner: identity.owner, lease });
    const state = new URL(start.result.authorizationUrl).searchParams.get("state");
    const call = () => withSharedDatabase(db, () => callback(new Request(`${origin}/api/kroger/oauth/callback?code=code&state=${state}`, { headers: { cookie: cookies } })));
    const busy = await call(); expect(busy.status).toBe(503); expect(busy.headers.has("set-cookie")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    await run({ op: "session.release", owner: identity.owner, lease, version: 0 });
    expect((await call()).status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("a missing rotated refresh token cannot be reused by the next request", async () => {
    const { db } = database(); const cookies = await connected(db, 1);
    const fetcher = vi.fn(async () => Response.json({ access_token: "rotation-without-refresh", expires_in: 3600 })); vi.stubGlobal("fetch", fetcher);
    await expect(withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => c.getCustomerAccessToken()))).rejects.toMatchObject({ code: "not_connected" });
    const checked = await withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => c.connectionStatus()));
    expect(checked.result.connected).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("cancel consumes OAuth state and cannot later exchange the same code", async () => {
    const { db } = database(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const start = await withSharedDatabase(db, () => createSharedKrogerAuthorization(req()));
    const cookies = cookiePairs([...start.setCookies, start.result.stateCookie]);
    const state = new URL(start.result.authorizationUrl).searchParams.get("state");
    const call = (query: string) => withSharedDatabase(db, () => callback(new Request(`${origin}/api/kroger/oauth/callback?${query}&state=${state}`, { headers: { cookie: cookies } })));
    expect((await call("error=access_denied")).status).toBe(400);
    expect((await call("code=late")).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not import legacy token cookies or accept forged owner cookies", async () => {
    const { db } = database(); const cookies = await connected(db);
    const forged = cookies.replace(/(__Host-cartiva-kroger-owner=)[A-Za-z0-9_-]/, "$1!");
    expect(sharedWebOwner(req(forged))).toBeNull();
    const result = await withSharedDatabase(db, () => withSharedKrogerWebSession(req("__Host-cartiva-kroger-session=old-token"), c => c.connectionStatus()));
    expect(result.result.connected).toBe(false);
    expect(result.setCookies.some(c => c.startsWith("__Host-cartiva-kroger-session=") && c.includes("Max-Age=0"))).toBe(true);
  });
  it("does not mint owner cookies on background status reads", async () => {
    const { db } = database();
    const result = await withSharedDatabase(db, () => withSharedKrogerWebSession(req(), client => client.connectionStatus()));
    expect(result.result.connected).toBe(false);
    expect(result.setCookies.some(c => c.startsWith("__Host-cartiva-kroger-owner="))).toBe(false);
  });
  it("one callback wins across concurrent requests, and a connected owner cannot be replaced", async () => {
    const { db } = database(); const fetcher = vi.fn(async () => Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetcher);
    const start = await withSharedDatabase(db, () => createSharedKrogerAuthorization(req()));
    const cookies = cookiePairs([...start.setCookies, start.result.stateCookie]);
    const state = new URL(start.result.authorizationUrl).searchParams.get("state");
    const results = await Promise.all([1, 2].map(() => withSharedDatabase(db, () => callback(new Request(`${origin}/api/kroger/oauth/callback?code=code&state=${state}`, { headers: { cookie: cookies } })))));
    expect(results.map(r => r.status).sort()).toEqual([200, 400]); expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(withSharedDatabase(db, () => createSharedKrogerAuthorization(req(cookies)))).rejects.toMatchObject({ code: "already_connected" });
  });
  it("refreshes once for independently constructed request clients", async () => {
    const { db } = database(); const cookies = await connected(db, 1);
    const fetcher = vi.fn(async () => { await new Promise(r => setTimeout(r, 40)); return Response.json({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 3600 }); });
    vi.stubGlobal("fetch", fetcher);
    const results = await Promise.all([1, 2].map(() => withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => c.getCustomerAccessToken()))));
    expect(results.map(r => r.result)).toEqual(["rotated", "rotated"]); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not spend an uncertain rotating refresh token again", async () => {
    const { db } = database(); const cookies = await connected(db, 1);
    const fetcher = vi.fn(async () => { throw new Error("response lost after rotation"); }); vi.stubGlobal("fetch", fetcher);
    await expect(withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => c.getCustomerAccessToken()))).rejects.toBeDefined();
    const status = await withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => c.connectionStatus()));
    expect(status.result.connected).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("disconnect fences a refresh that completes late", async () => {
    const { db } = database(); const cookies = await connected(db, 1);
    let finish!: () => void; let started!: () => void;
    const sent = new Promise<void>(r => { started = r; }); const waiting = new Promise<void>(r => { finish = r; });
    vi.stubGlobal("fetch", vi.fn(async () => { started(); await waiting; return Response.json({ access_token: "late", refresh_token: "late-refresh", expires_in: 3600 }); }));
    const attempt = withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => c.getCustomerAccessToken()));
    const failure = expect(attempt).rejects.toBeDefined(); await sent;
    await withSharedDatabase(db, () => disconnectSharedKrogerWebSession(req(cookies))); finish(); await failure;
    const status = await withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => c.connectionStatus()));
    expect(status.result.connected).toBe(false);
  });
  it("one accepted PUT is replayed by a cold request without exposing the internal ID", async () => {
    const { db } = database(); const cookies = await connected(db); const operationId = "shared-operation-12345"; const put = vi.fn(async () => accepted);
    const send = () => withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), async client => {
      await client.getCustomerAccessToken(); const fingerprint = stateHash(await client.getAuthorizationGeneration());
      return runSharedKrogerCartOperation(sharedLeaseForClient(client)!, operationId, Buffer.from(fingerprint, "hex").toString("base64url"), put, () => false, { items: [{ upc: "0001111000001", quantity: 2 }] });
    }));
    const results = await Promise.all([send(), send()]);
    expect(put).toHaveBeenCalledTimes(1); expect(results.map(r => r.result.replayed).sort()).toEqual([false, true]);
    expect(results[0].result.receipt.operationId).toBe(operationId);
  });
  it("keeps unknown guard after accepted PUT but failed receipt storage, then allows only an explicitly new reviewed operation", async () => {
    const { db, run } = database(); const cookies = await connected(db); const operationId = "unknown-operation-12345"; const fingerprint = token();
    const broken: SharedDatabase = { ...db, prepare(sql) { if (sql.includes("receipt_encrypted=?")) throw new Error("storage offline"); return db.prepare(sql); } };
    const put = vi.fn(async () => accepted);
    await expect(withSharedDatabase(broken, () => withSharedKrogerWebSession(req(cookies), c => runSharedKrogerCartOperation(sharedLeaseForClient(c)!, operationId, fingerprint, put, () => true, {})))).rejects.toMatchObject({ recoveryOperationId: operationId });
    const identity = sharedWebOwner(req(cookies))!;
    expect(await run({ op: "cart.read", owner: identity.owner, id: sharedCartId(identity.owner, operationId) })).toMatchObject({ status: "outcome_unknown" });
    // Recovery works even when the browser lost its local pending operation ID.
    const pending = await withSharedDatabase(db, () => pendingReview(req(cookies)));
    expect(await pending.json()).toEqual({ operationId });
    const response = await withSharedDatabase(db, () => acknowledge(new Request(`${origin}/api/kroger/cart/review`, {
      method: "POST", headers: { Origin: origin, cookie: cookies, "Content-Type": "application/json" },
      body: JSON.stringify({ operationId, acknowledgement: "REVIEWED_RETAILER_CART" }),
    })));
    expect(response.status).toBe(200);
    await expect(withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => runSharedKrogerCartOperation(sharedLeaseForClient(c)!, operationId, fingerprint, put, () => false, {})))).rejects.toBeDefined();
    await withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => runSharedKrogerCartOperation(sharedLeaseForClient(c)!, "deliberate-new-operation", fingerprint, put, () => false, {})));
    expect(put).toHaveBeenCalledTimes(2);
  });
  it("corrupt confirmed receipts never become safely retryable", async () => {
    const { db, sqlite } = database(); const cookies = await connected(db); const operationId = "corrupt-operation-12345"; const fingerprint = token();
    await withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => runSharedKrogerCartOperation(sharedLeaseForClient(c)!, operationId, fingerprint, async () => accepted, () => false, {})));
    sqlite.prepare("UPDATE kroger_cart_operations SET receipt_encrypted=?").run(sealShared(null, `cart:${sharedWebOwner(req(cookies))!.owner}`));
    const put = vi.fn(async () => accepted);
    await expect(withSharedDatabase(db, () => withSharedKrogerWebSession(req(cookies), c => runSharedKrogerCartOperation(sharedLeaseForClient(c)!, operationId, fingerprint, put, () => false, {})))).rejects.toMatchObject({ recoveryOperationId: operationId });
    expect(put).not.toHaveBeenCalled();
  });
});

describe("remote bridge transport", () => {
  beforeEach(() => {
    vi.stubEnv("CARTIVA_SHARED_STATE_MODE", "bridge");
    vi.stubEnv("CARTIVA_SHARED_STATE_URL", `${origin}${SHARED_PATH}`);
    vi.stubEnv("CARTIVA_SHARED_STATE_SITE_TOKEN", "test-private-site-token");
  });
  it.each([302, 401, 409, 503])("fails closed without retry on bridge status %i", async status => {
    const fetcher = vi.fn(async () => new Response("blocked", { status })); vi.stubGlobal("fetch", fetcher);
    await expect(sharedCommand({ op: "session.ensure", owner: owner() })).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.length).toBeGreaterThan(0);
  });
  it("uses the exact fixed endpoint, signed server headers, and no redirect following", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers); const body = String(init?.body);
      expect(init?.redirect).toBe("manual"); expect(h.get("Origin")).toBeNull();
      expect(h.get("OAI-Sites-Authorization")).toBe("Bearer test-private-site-token");
      expect(h.get("X-Cartiva-State-Signature")).toBe(bridgeSignature(body, h.get("X-Cartiva-State-Time")!, h.get("X-Cartiva-State-Nonce")!));
      return Response.json({ result: true });
    }); vi.stubGlobal("fetch", fetcher);
    expect(await sharedCommand({ op: "rate", key: stateHash("test"), limit: 1, windowMs: 1000 })).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe(`${origin}${SHARED_PATH}`);
  });
  it("rejects malformed bridge envelopes and unsafe endpoints", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true })); vi.stubGlobal("fetch", fetcher);
    await expect(sharedCommand({ op: "session.ensure", owner: owner() })).rejects.toMatchObject({ code: "unavailable" });
    vi.stubEnv("CARTIVA_SHARED_STATE_URL", `http://localhost${SHARED_PATH}`);
    await expect(sharedCommand({ op: "session.ensure", owner: owner() })).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
