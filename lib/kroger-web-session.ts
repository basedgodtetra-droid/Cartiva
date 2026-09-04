import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createKrogerAuthClientForSessionFile,
  getKrogerAuthClient,
  KrogerAuthError,
  type KrogerAuthClient,
} from "./kroger-auth";
import "./server-only-guard";
import { sharedWebSessionConfigured, sharedWebSessionEnabled } from "./kroger-shared-client";
import { withSharedKrogerWebSession } from "./kroger-shared-web";

const LEGACY_SESSION_COOKIE = "__Host-cartiva-kroger-session";
const SESSION_COOKIE_PREFIX = "__Host-cartiva-kroger-session-";
const STATE_COOKIE = "__Host-cartiva-kroger-oauth-state";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSION_COOKIE_LENGTH = 12_000;
// Chromium limits an individual cookie (name, value, and attributes together)
// to roughly 4 KiB. Kroger's encrypted access and refresh tokens can exceed
// that limit, so keep every value comfortably below it and reassemble the
// authenticated envelope on the server.
const SESSION_COOKIE_CHUNK_SIZE = 3_000;
const MAX_SESSION_COOKIE_CHUNKS = Math.ceil(
  MAX_SESSION_COOKIE_LENGTH / SESSION_COOKIE_CHUNK_SIZE,
);
const MAX_SESSION_FILE_BYTES = 8_192;

function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function secureCookie(name: string, value: string, maxAge: number) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function stateSecret() {
  const value = process.env.CARTIVA_WEB_SESSION_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new KrogerAuthError(
      "Kroger website sessions are not configured on this deployment.",
      "configuration",
      503,
    );
  }
  return value;
}

function stateSignature(payload: string) {
  return createHmac("sha256", stateSecret())
    .update("Cartiva Kroger web OAuth state\0", "utf8")
    .update(payload, "utf8")
    .digest("base64url");
}

function signaturesMatch(expected: string, supplied: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function decodeSessionCookie(value: string | undefined) {
  if (!value || value.length > MAX_SESSION_COOKIE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  try {
    const serialized = Buffer.from(value, "base64url");
    if (!serialized.length || serialized.length > MAX_SESSION_FILE_BYTES) return undefined;
    JSON.parse(serialized.toString("utf8"));
    return serialized;
  } catch {
    return undefined;
  }
}

function sessionCookieValue(request: Request) {
  const chunks: string[] = [];
  for (let index = 0; index < MAX_SESSION_COOKIE_CHUNKS; index += 1) {
    const chunk = cookieValue(request, `${SESSION_COOKIE_PREFIX}${index}`);
    if (chunk === undefined) {
      if (index === 0) return cookieValue(request, LEGACY_SESSION_COOKIE);
      break;
    }
    chunks.push(chunk);
  }
  return chunks.join("");
}

function sessionCookies(serialized: Buffer | null) {
  const value = serialized?.toString("base64url") ?? "";
  if (value.length > MAX_SESSION_COOKIE_LENGTH) {
    throw new KrogerAuthError("The saved Kroger connection is too large.", "storage", 503);
  }
  const chunks = serialized
    ? Array.from(
      { length: Math.ceil(value.length / SESSION_COOKIE_CHUNK_SIZE) },
      (_, index) => value.slice(
        index * SESSION_COOKIE_CHUNK_SIZE,
        (index + 1) * SESSION_COOKIE_CHUNK_SIZE,
      ),
    )
    : [];
  return [
    // Remove the pre-chunking cookie during the transition so a stale legacy
    // session can never shadow an intentionally cleared connection.
    secureCookie(LEGACY_SESSION_COOKIE, "", 0),
    ...Array.from({ length: MAX_SESSION_COOKIE_CHUNKS }, (_, index) => secureCookie(
      `${SESSION_COOKIE_PREFIX}${index}`,
      chunks[index] ?? "",
      chunks[index] ? SESSION_TTL_SECONDS : 0,
    )),
  ];
}

export function usesServerlessKrogerWebSession(request?: Request) {
  if (request && new URL(request.url).pathname.startsWith("/api/extension/")) return false;
  return process.env.VERCEL === "1" || process.env.CARTIVA_SERVERLESS_WEB_SESSION === "true";
}

export function serverlessKrogerWebSessionIsConfigured() {
  if (!usesServerlessKrogerWebSession()) return true;
  try {
    stateSecret();
    if (sharedWebSessionEnabled() && !sharedWebSessionConfigured()) return false;
    return true;
  } catch {
    return false;
  }
}

export async function withServerlessKrogerWebSession<T>(
  request: Request,
  operation: (client: KrogerAuthClient) => Promise<T>,
) {
  if (sharedWebSessionEnabled()) return withSharedKrogerWebSession(request, operation);
  const directory = await mkdtemp(path.join(os.tmpdir(), "cartiva-kroger-web-"));
  const sessionFile = path.join(directory, "session.json");
  try {
    const existing = decodeSessionCookie(sessionCookieValue(request));
    if (existing) await writeFile(sessionFile, existing, { mode: 0o600, flag: "wx" });
    const result = await operation(createKrogerAuthClientForSessionFile(sessionFile));
    let serialized: Buffer | null = null;
    try {
      serialized = await readFile(sessionFile);
      if (serialized.length > MAX_SESSION_FILE_BYTES) {
        throw new KrogerAuthError("The saved Kroger connection is too large.", "storage", 503);
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    return { result, setCookies: sessionCookies(serialized) };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createServerlessKrogerAuthorization() {
  const state = randomBytes(24).toString("base64url");
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `${state}.${issuedAt}`;
  const authorizationUrl = getKrogerAuthClient()
    .createAuthorizationUrlAfterExternalStateRegistration(state);
  return {
    authorizationUrl,
    setCookie: secureCookie(
      STATE_COOKIE,
      `${payload}.${stateSignature(payload)}`,
      OAUTH_STATE_TTL_SECONDS,
    ),
  };
}

export function validateServerlessKrogerAuthorization(request: Request, returnedState: string) {
  const stored = cookieValue(request, STATE_COOKIE) ?? "";
  const [state, issuedText, signature, extra] = stored.split(".");
  const issuedAt = Number(issuedText);
  const payload = `${state}.${issuedText}`;
  const now = Math.floor(Date.now() / 1000);
  if (
    extra !== undefined
    || !/^[A-Za-z0-9_-]{32}$/.test(state ?? "")
    || state !== returnedState
    || !Number.isInteger(issuedAt)
    || issuedAt > now + 30
    || issuedAt + OAUTH_STATE_TTL_SECONDS < now
    || !signaturesMatch(stateSignature(payload), signature ?? "")
  ) {
    throw new KrogerAuthError(
      "This Kroger connection request expired or could not be verified. Start again.",
      "oauth_state",
      400,
    );
  }
}

export function clearServerlessKrogerAuthorizationCookie() {
  return secureCookie(STATE_COOKIE, "", 0);
}
