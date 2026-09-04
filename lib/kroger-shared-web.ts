import { createHmac, randomBytes } from "node:crypto";
import { createKrogerAuthClientForSharedSession, getKrogerAuthClient, KrogerAuthError, type KrogerAuthClient } from "./kroger-auth";
import { sharedCommand, sharedWebSessionConfigured } from "./kroger-shared-client";
import { equalSignature, openShared, sealShared, SharedStateError, stateHash, STATE_TTL_MS, type SharedOAuthState, type SharedSession } from "./kroger-shared-protocol";
import "./server-only-guard";

const OWNER_COOKIE = "__Host-cartiva-kroger-owner";
const STATE_COOKIE = "__Host-cartiva-kroger-oauth-state";
const OWNER_TTL = 30 * 24 * 60 * 60;
const leases = new WeakMap<KrogerAuthClient, SharedWebLease>();

export interface SharedWebLease {
  owner: string;
  lease: string;
  version: number;
  assertCurrent(): Promise<void>;
}
export function sharedLeaseForClient(client: KrogerAuthClient) { return leases.get(client); }
function secret() {
  const value = process.env.CARTIVA_WEB_SESSION_SECRET;
  if (!value || value.length < 32) throw new SharedStateError("unavailable");
  return value;
}
function sign(value: string) { return createHmac("sha256", secret()).update(`Cartiva web2 cookie\0${value}`).digest("base64url"); }
function cookie(name: string, value: string, seconds: number) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}
function readCookie(request: Request, name: string) {
  const entries = (request.headers.get("cookie") ?? "").split(";");
  const entry = entries.find(v => v.trim().startsWith(`${name}=`));
  try { return entry ? decodeURIComponent(entry.trim().slice(name.length + 1)) : ""; } catch { return ""; }
}
function ownerCookie(raw: string) {
  const payload = `${raw}.${Math.floor(Date.now() / 1000) + OWNER_TTL}`;
  return cookie(OWNER_COOKIE, `${payload}.${sign(payload)}`, OWNER_TTL);
}
export function sharedWebOwner(request: Request, create = false) {
  const [raw, expiration, signature, extra] = readCookie(request, OWNER_COOKIE).split(".");
  const now = Math.floor(Date.now() / 1000);
  if (extra === undefined && /^[A-Za-z0-9_-]{43}$/.test(raw ?? "")
    && /^\d+$/.test(expiration ?? "") && Number(expiration) > now && Number(expiration) <= now + OWNER_TTL + 30
    && equalSignature(sign(`${raw}.${expiration}`), signature ?? "")) {
    return { owner: `web2:${stateHash(raw)}`, setCookie: ownerCookie(raw) };
  }
  if (!create) return null;
  const next = randomBytes(32).toString("base64url");
  return { owner: `web2:${stateHash(next)}`, setCookie: ownerCookie(next) };
}
function retiredTokenCookies() {
  // No automatic token-cookie migration: replaying an old cookie must never
  // resurrect a disconnected row or create a second rotating-token owner.
  return ["__Host-cartiva-kroger-session", ...Array.from({ length: 4 }, (_, i) => `__Host-cartiva-kroger-session-${i}`)]
    .map(name => cookie(name, "", 0));
}
function validSession(value: SharedSession | null, owner: string): value is SharedSession {
  return Boolean(value && value.owner_id === owner && typeof value.session_encrypted === "string"
    && value.session_encrypted.length <= 16_000 && Number.isSafeInteger(value.session_version) && value.session_version >= 0
    && (value.refresh_lock_token === null || /^[A-Za-z0-9_-]{43}$/.test(value.refresh_lock_token))
    && Number.isSafeInteger(value.refresh_locked_until));
}

export async function withSharedKrogerWebSession<T>(request: Request, operation: (client: KrogerAuthClient) => Promise<T>, expectedVersion?: number, createOwner = false) {
  if (!sharedWebSessionConfigured()) throw new SharedStateError("unavailable");
  const identity = sharedWebOwner(request, createOwner);
  if (!identity) {
    // Background anonymous status reads must not race OAuth start by minting
    // a second owner cookie. Only explicit authorization creates an owner.
    const client = createKrogerAuthClientForSharedSession("unconnected", {
      read: async () => null,
      write: async () => { throw new SharedStateError("stale"); },
      remove: async () => undefined,
    }, async () => true);
    return { result: await operation(client), setCookies: retiredTokenCookies() };
  }
  const owner = identity.owner;
  const initial = await sharedCommand<SharedSession | null>({ op: "session.ensure", owner });
  if (!validSession(initial, owner)) throw new SharedStateError("unavailable");
  const token = randomBytes(32).toString("base64url");
  let row = await sharedCommand<SharedSession | null>({ op: "session.acquire", owner, lease: token });
  if (!row) {
    await new Promise(resolve => setTimeout(resolve, 200));
    row = await sharedCommand<SharedSession | null>({ op: "session.acquire", owner, lease: token });
  }
  if (!row) throw new SharedStateError("busy");
  if (!validSession(row, owner) || row.refresh_lock_token !== token) throw new SharedStateError("unavailable");
  const context: SharedWebLease = {
    owner, lease: token, version: row.session_version,
    async assertCurrent() {
      const current = await sharedCommand<SharedSession | null>({ op: "session.assert", owner, lease: token, version: context.version });
      if (!validSession(current, owner) || current.refresh_lock_token !== token || current.session_version !== context.version) {
        throw new KrogerAuthError("The Kroger connection changed. Reconnect before continuing this basket.", "not_connected", 401);
      }
    },
  };
  let encrypted = row.session_encrypted;
  const persist = async (value: string) => {
    const next = await sharedCommand<SharedSession | null>({ op: "session.save", owner, lease: token, version: context.version, encrypted: value });
    if (!validSession(next, owner) || next.session_version !== context.version + 1 || next.refresh_lock_token !== token) throw new SharedStateError("stale");
    context.version = next.session_version;
    encrypted = next.session_encrypted;
  };
  try {
    if (expectedVersion !== undefined && context.version !== expectedVersion) throw new KrogerAuthError("This Kroger connection request is no longer current. Start again.", "oauth_state", 400);
    const client = createKrogerAuthClientForSharedSession(owner, {
      read: async () => encrypted || null,
      write: persist,
      remove: () => persist(""),
      uncertainRefresh: () => persist(""),
    }, async () => { await context.assertCurrent(); return true; });
    leases.set(client, context);
    const result = await operation(client);
    return { result, setCookies: [identity.setCookie, ...retiredTokenCookies()] };
  } finally {
    // A failed release cannot turn an accepted, durably recorded cart into an
    // unverified cart. Stale leases self-fence and require reconnect on expiry.
    await sharedCommand({ op: "session.release", owner, lease: token, version: context.version }).catch(() => undefined);
  }
}

export async function disconnectSharedKrogerWebSession(request: Request) {
  const identity = sharedWebOwner(request);
  if (identity) await sharedCommand({ op: "session.revoke", owner: identity.owner });
  return retiredTokenCookies();
}

export async function createSharedKrogerAuthorization(request: Request) {
  return withSharedKrogerWebSession(request, async (client) => {
    if ((await client.connectionStatus()).connected) throw new KrogerAuthError("Kroger is already connected. Return to Cartiva to add your basket.", "already_connected", 409);
    const context = sharedLeaseForClient(client)!;
    if (await sharedCommand<boolean>({ op: "rate", key: stateHash(`oauth:${context.owner}`), limit: 8, windowMs: STATE_TTL_MS }) !== true) throw new KrogerAuthError("Too many Kroger connection attempts. Wait a few minutes and retry.", "rate_limit", 429);
    const state = randomBytes(24).toString("base64url");
    const authorizationUrl = getKrogerAuthClient().createAuthorizationUrlAfterExternalStateRegistration(state);
    const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri")!;
    // Each current host has its own registered callback. Do not send a
    // host-only browser binding to an unrelated/cross-origin callback.
    if (new URL(redirectUri).origin !== new URL(request.url).origin) throw new KrogerAuthError("The Kroger callback must belong to this Cartiva website.", "configuration", 503);
    const expiresAt = Date.now() + STATE_TTL_MS;
    const registered = await sharedCommand({ op: "oauth.register", owner: context.owner, lease: context.lease,
      version: context.version, hash: stateHash(state), encrypted: sealShared({ redirectUri, origin: new URL(request.url).origin }, `oauth:${context.owner}:${stateHash(state)}`) });
    if (!registered) throw new SharedStateError("stale");
    const payload = `${state}.${expiresAt}`;
    return { authorizationUrl, stateCookie: cookie(STATE_COOKIE, `${payload}.${sign(`${context.owner}:${payload}`)}`, STATE_TTL_MS / 1000) };
  }, undefined, true);
}

export async function consumeSharedKrogerAuthorization(request: Request, returnedState: string) {
  const identity = sharedWebOwner(request);
  const [state, expiresAt, signature, extra] = readCookie(request, STATE_COOKIE).split(".");
  if (!identity || extra !== undefined || state !== returnedState || !/^[A-Za-z0-9_-]{32}$/.test(state ?? "")
    || !/^\d{13}$/.test(expiresAt ?? "") || Number(expiresAt) <= Date.now() || Number(expiresAt) > Date.now() + STATE_TTL_MS + 30_000
    || !equalSignature(sign(`${identity.owner}:${state}.${expiresAt}`), signature ?? "")) throw new KrogerAuthError("This Kroger connection request expired or could not be verified. Start again.", "oauth_state", 400);
  const stored = await sharedCommand<SharedOAuthState | null>({ op: "oauth.consume", owner: identity.owner, hash: stateHash(state) });
  if (!stored || stored.owner_id !== identity.owner || !Number.isSafeInteger(stored.selection_version)
    || typeof stored.verifier_encrypted !== "string") throw new KrogerAuthError("This Kroger connection response was already used or expired.", "oauth_state", 400);
  const data = openShared<{ redirectUri: string; origin: string }>(stored.verifier_encrypted, `oauth:${identity.owner}:${stateHash(state)}`);
  if (data.origin !== new URL(request.url).origin || new URL(data.redirectUri).origin !== data.origin) throw new KrogerAuthError("This Kroger connection belongs to another website.", "oauth_state", 400);
  return { version: stored.selection_version, redirectUri: data.redirectUri };
}
