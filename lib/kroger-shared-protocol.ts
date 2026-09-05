import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import "./server-only-guard";
import { validKnowledgeCommand, type KnowledgeCommand } from "./knowledge/protocol";

export const SHARED_PATH = "/api/internal/kroger-state";
export const OWNER_PATTERN = /^web2:[a-f0-9]{64}$/;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_LEASE_MS = 180_000;
export const STATE_TTL_MS = 600_000;

export interface SharedSession {
  owner_id: string;
  session_encrypted: string;
  session_version: number;
  refresh_lock_token: string | null;
  refresh_locked_until: number;
}
export interface SharedOAuthState {
  owner_id: string;
  verifier_encrypted: string;
  selection_version: number;
  expires_at: number;
}
export interface SharedCart {
  request_fingerprint: string;
  status: string;
  payload_encrypted: string;
  receipt_encrypted: string | null;
  error_code: string | null;
}
type Owned = { owner: string };
type Leased = Owned & { lease: string; version: number };
export type SharedCommand =
  | KnowledgeCommand
  | ({ op: "session.ensure" | "session.read" } & Owned)
  | ({ op: "session.acquire"; lease: string } & Owned)
  | ({ op: "session.assert" | "session.release" } & Leased)
  | ({ op: "session.save"; encrypted: string } & Leased)
  | ({ op: "session.revoke" } & Owned)
  | ({ op: "oauth.register"; hash: string; encrypted: string } & Leased)
  | ({ op: "oauth.consume"; hash: string } & Owned)
  | { op: "oauth.peek"; hash: string }
  | ({ op: "cart.claim"; id: string; fingerprint: string; attempt: string; payload: string } & Leased)
  | ({ op: "cart.finish"; id: string; fingerprint: string; attempt: string; receipt: string } & Owned)
  | ({ op: "cart.retryable"; id: string; fingerprint: string; attempt: string } & Owned)
  | ({ op: "cart.read"; id: string } & Owned)
  | ({ op: "cart.pending" } & Owned)
  | ({ op: "cart.acknowledge"; id: string } & Owned)
  | { op: "rate"; key: string; limit: number; windowMs: number };

export class SharedStateError extends Error {
  constructor(readonly code: "unavailable" | "invalid" | "busy" | "stale" | "replay", readonly status = 503) {
    super(code === "busy" ? "Cartiva is finishing another Kroger request. Try again in a moment."
      : "Cartiva could not safely verify the Kroger connection. Your basket has been preserved.");
    this.name = "SharedStateError";
  }
}
export function sharedSecret() {
  const secret = process.env.CARTIVA_SHARED_STATE_SECRET;
  if (!secret || secret.length < 43) throw new SharedStateError("unavailable");
  return secret;
}
export function stateHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function sealShared(value: unknown, binding: string) {
  const key = createHash("sha256").update("Cartiva shared envelope v2\0" + sharedSecret()).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(binding));
  // Workers requires an explicit encoding for string cipher input.
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, encrypted, cipher.getAuthTag()].map(b => b.toString("base64url")).join(".");
}
export function openShared<T>(value: string, binding: string): T {
  try {
    const [iv, data, tag, extra] = value.split(".");
    if (extra !== undefined || !iv || !data || !tag || value.length > 48_000) throw new Error();
    const key = createHash("sha256").update("Cartiva shared envelope v2\0" + sharedSecret()).digest();
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    cipher.setAAD(Buffer.from(binding));
    cipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, "base64url")), cipher.final()]).toString("utf8")) as T;
  } catch { throw new SharedStateError("unavailable"); }
}
export function bridgeSignature(body: string, timestamp: string, nonce: string) {
  return createHmac("sha256", sharedSecret()).update(`POST\n${SHARED_PATH}\n${timestamp}\n${nonce}\n${body}`).digest("base64url");
}
export function equalSignature(expected: string, supplied: string) {
  return TOKEN_PATTERN.test(supplied) && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

/** Strict named operations only: the bridge never accepts SQL/table names. */
export function validSharedCommand(value: unknown): value is SharedCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.op === "string" && v.op.startsWith("knowledge.")) return validKnowledgeCommand(value);
  const fields: Record<string, string[]> = {
    "session.ensure": ["owner"], "session.read": ["owner"],
    "session.acquire": ["owner", "lease"], "session.assert": ["owner", "lease", "version"],
    "session.release": ["owner", "lease", "version"], "session.save": ["owner", "lease", "version", "encrypted"],
    "session.revoke": ["owner"], "oauth.register": ["owner", "lease", "version", "hash", "encrypted"],
    "oauth.consume": ["owner", "hash"], "oauth.peek": ["hash"],
    "cart.claim": ["owner", "lease", "version", "id", "fingerprint", "attempt", "payload"],
    "cart.finish": ["owner", "id", "fingerprint", "attempt", "receipt"],
    "cart.retryable": ["owner", "id", "fingerprint", "attempt"], "cart.read": ["owner", "id"],
    "cart.pending": ["owner"], "cart.acknowledge": ["owner", "id"],
    rate: ["key", "limit", "windowMs"],
  };
  const required = typeof v.op === "string" && Object.hasOwn(fields, v.op) ? fields[v.op] : undefined;
  if (!required || Object.keys(v).length !== required.length + 1 || !required.every(k => k in v)) return false;
  return required.every(k => {
    const x = v[k];
    if (k === "owner") return typeof x === "string" && OWNER_PATTERN.test(x);
    if (["lease", "fingerprint", "attempt"].includes(k)) return typeof x === "string" && TOKEN_PATTERN.test(x);
    if (["hash", "id", "key"].includes(k)) return typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
    if (k === "version") return Number.isSafeInteger(x) && (x as number) >= 0;
    if (k === "limit") return Number.isSafeInteger(x) && (x as number) >= 1 && (x as number) <= 600;
    if (k === "windowMs") return Number.isSafeInteger(x) && (x as number) >= 1000 && (x as number) <= 3_600_000;
    return typeof x === "string" && x.length <= (k === "encrypted" ? 16_000 : 48_000);
  });
}
