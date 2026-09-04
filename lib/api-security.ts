import { createHash } from "node:crypto";
import { isIP } from "node:net";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const JSON_BODY_READ_TIMEOUT_MS = 8_000;
const MAX_RATE_LIMIT_BUCKETS = 4_096;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CARTIVA_CANONICAL_ORIGIN = "https://cartiva-complete-cart.basedgodtetra.chatgpt.site";
const trustedExtensionRequests = new WeakSet<Request>();
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface JsonRequestResult<T> {
  ok: true;
  value: T;
}

export interface JsonRequestFailure {
  ok: false;
  response: Response;
}

function securityError(message: string, status: number) {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function pruneRateLimits(now: number) {
  if (rateLimitBuckets.size < 256) return;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
  while (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
    const oldestKey = rateLimitBuckets.keys().next().value;
    if (typeof oldestKey !== "string") break;
    rateLimitBuckets.delete(oldestKey);
  }
}

function rateLimitResponse(
  key: string,
  policy: RateLimitPolicy,
  cost = 1,
) {
  const now = Date.now();
  pruneRateLimits(now);
  const current = rateLimitBuckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + policy.windowMs }
    : current;
  bucket.count += Number.isSafeInteger(cost) && cost > 0 ? cost : 1;
  rateLimitBuckets.set(key, bucket);

  if (bucket.count <= policy.limit) return null;
  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  const response = securityError(
    "Cartiva is receiving too many requests. Wait a moment and try again.",
    429,
  );
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

/**
 * A deliberately small, process-local abuse guard for Cartiva's single-user
 * loopback backend. A hosted, multi-user release must replace this with a
 * durable per-account and per-IP limiter at the network edge.
 */
export function enforceRateLimit(
  request: Request,
  scope: string,
  policy: RateLimitPolicy,
) {
  return rateLimitResponse(`${scope}:${publicReadClientIdentity(request)}`, policy);
}

function normalizedClientAddress(value: string | null) {
  if (!value) return undefined;
  let candidate = value.trim();
  if (candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1);
  }
  if (candidate.startsWith("[") && candidate.includes("]")) {
    candidate = candidate.slice(1, candidate.indexOf("]"));
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(":"));
  }
  return isIP(candidate) ? candidate.toLowerCase() : undefined;
}

/**
 * Prefer addresses written by common reverse proxies. The fallback is a
 * deliberately coarse, hashed client fingerprint so raw request metadata is
 * never retained in the process-local limiter.
 */
function publicReadClientIdentity(request: Request) {
  // Vercel overwrites this single-address header at its edge. Never trust it
  // merely because an arbitrary caller supplied it to another deployment.
  if (process.env.VERCEL === "1") {
    const address = normalizedClientAddress(request.headers.get("x-vercel-forwarded-for"));
    if (address) return `ip:${address}`;
  }
  // Forwarding headers are caller-controlled unless the deployment explicitly
  // places Cartiva behind a trusted edge and makes the origin unreachable.
  // Ignoring them by default prevents a direct caller from rotating a spoofed
  // X-Forwarded-For value to evade every process-local bucket.
  if (process.env.CARTIVA_TRUSTED_EDGE?.trim().toLowerCase() === "true") {
    for (const header of ["CF-Connecting-IP", "True-Client-IP", "X-Real-IP"]) {
      const address = normalizedClientAddress(request.headers.get(header));
      if (address) return `ip:${address}`;
    }

    const forwardedAddress = normalizedClientAddress(
      request.headers.get("X-Forwarded-For")?.split(",", 1)[0] ?? null,
    );
    if (forwardedAddress) return `ip:${forwardedAddress}`;
  }

  const fallback = [
    request.headers.get("User-Agent")?.slice(0, 512) ?? "unknown-agent",
    request.headers.get("Accept-Language")?.slice(0, 128) ?? "unknown-language",
  ].join("\n");
  const digest = createHash("sha256").update(fallback).digest("base64url").slice(0, 32);
  return `client:${digest}`;
}

/**
 * A process-local abuse guard for anonymous, read-only public endpoints.
 * Deployment infrastructure should additionally enforce a durable edge limit.
 */
export function enforcePublicReadRateLimit(
  request: Request,
  scope: string,
  policy: RateLimitPolicy,
) {
  return rateLimitResponse(`public-read:${scope}:${publicReadClientIdentity(request)}`, policy);
}

/**
 * Charges expected upstream work, not just HTTP request count. Authenticated
 * mobile comparisons use the stable owner key; anonymous reads use the same
 * coarse client fingerprint as the request limiter. A public deployment must
 * still replace this process-local guard with a trusted edge/work quota.
 */
export function enforcePublicReadWorkLimit(
  request: Request,
  scope: string,
  cost: number,
  policy: RateLimitPolicy,
  ownerId?: string,
) {
  const identity = ownerId && /^[a-f0-9]{64}$/.test(ownerId)
    ? `owner:${ownerId}`
    : publicReadClientIdentity(request);
  return rateLimitResponse(`public-work:${scope}:${identity}`, policy, cost);
}

export function resetRateLimitsForTests() {
  rateLimitBuckets.clear();
}

/**
 * Marks a request only after an extension route has validated its Origin.
 * A WeakSet keeps the bypass process-local; a caller cannot forge it with a
 * header or request field.
 */
export function trustValidatedExtensionRequest(request: Request) {
  trustedExtensionRequests.add(request);
  return request;
}

export function validateLocalApiRequest(
  request: Request,
  options: { requireJson?: boolean } = {},
) {
  const malformedPayload = validateJsonPayload(request, options);
  if (malformedPayload) return malformedPayload;

  if (trustedExtensionRequests.has(request)) return null;

  const url = new URL(request.url);
  const browserOrigin = request.headers.get("Origin")
    ?? (() => {
      const referrer = request.headers.get("Referer");
      if (!referrer) return null;
      try {
        return new URL(referrer).origin;
      } catch {
        return null;
      }
    })();
  const configuredOrigins = new Set([CARTIVA_CANONICAL_ORIGIN]);
  for (const value of [
    process.env.CARTIVA_PUBLIC_ORIGIN,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL,
  ]) {
    const cleaned = value?.trim();
    if (!cleaned) continue;
    try {
      configuredOrigins.add(new URL(cleaned.includes("://") ? cleaned : `https://${cleaned}`).origin);
    } catch {
      // An invalid deployment hint must never broaden the API boundary.
    }
  }

  let browserUrl: URL | null = null;
  if (browserOrigin) {
    try {
      browserUrl = new URL(browserOrigin);
    } catch {
      return securityError("The request origin is invalid.", 403);
    }
  }
  const urlIsLoopback = LOOPBACK_HOSTS.has(url.hostname);
  const browserIsEquivalentLoopback = Boolean(
    browserUrl
    && urlIsLoopback
    && LOOPBACK_HOSTS.has(browserUrl.hostname)
    && browserUrl.protocol === url.protocol
    && browserUrl.port === url.port,
  );
  const configuredBrowserRequest = Boolean(browserOrigin && configuredOrigins.has(browserOrigin));
  const configuredDirectRequest = configuredOrigins.has(url.origin);
  const fetchMetadataAllowsOriginlessRead = !browserOrigin
    && request.headers.get("Sec-Fetch-Site")?.toLowerCase() === "same-origin";

  if (
    !(urlIsLoopback && (!browserOrigin || browserIsEquivalentLoopback || configuredBrowserRequest))
    && !(configuredDirectRequest && (browserOrigin === url.origin || fetchMetadataAllowsOriginlessRead))
  ) {
    return securityError(
      urlIsLoopback || configuredDirectRequest
        ? "Cross-origin access to this Cartiva API is not allowed."
        : "Cartiva's retailer backend is available only to the configured Cartiva website.",
      403,
    );
  }

  if (request.headers.get("Sec-Fetch-Site")?.toLowerCase() === "cross-site") {
    return securityError("Cross-site access to this Cartiva API is not allowed.", 403);
  }

  return null;
}

function validateJsonPayload(
  request: Request,
  options: { requireJson?: boolean } = {},
) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return securityError("The request size is invalid.", 400);
    }
    if (parsedLength > MAX_JSON_BODY_BYTES) {
      return securityError("The request is too large.", 413);
    }
  }

  if (options.requireJson) {
    const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      return securityError("Send the request as JSON.", 415);
    }
  }
  return null;
}

const BODY_TOO_LARGE = Symbol("body-too-large");
const BODY_INVALID = Symbol("body-invalid");
const BODY_TIMEOUT = Symbol("body-timeout");

async function readLimitedBody(request: Request) {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const consume = (async () => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_JSON_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          return BODY_TOO_LARGE;
        }
        chunks.push(value);
      }
    } catch {
      return BODY_INVALID;
    } finally {
      reader.releaseLock();
    }

    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return BODY_INVALID;
    }
  })();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<typeof BODY_TIMEOUT>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      resolve(BODY_TIMEOUT);
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // The timeout result already won; cancellation is best effort.
      }
    }, JSON_BODY_READ_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([consume, deadline]);
    return timedOut ? BODY_TIMEOUT : result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function readValidatedJson<T>(
  request: Request,
): Promise<JsonRequestResult<T> | JsonRequestFailure> {
  const rejection = validateLocalApiRequest(request, { requireJson: true });
  if (rejection) return { ok: false, response: rejection };

  return readJsonBody<T>(request);
}

/**
 * Parses JSON for a deliberately public route without bypassing or changing
 * the loopback checks used by Cartiva's existing retailer and mutation APIs.
 */
export async function readPublicValidatedJson<T>(
  request: Request,
): Promise<JsonRequestResult<T> | JsonRequestFailure> {
  const rejection = validateJsonPayload(request, { requireJson: true });
  if (rejection) return { ok: false, response: rejection };

  return readJsonBody<T>(request);
}

async function readJsonBody<T>(
  request: Request,
): Promise<JsonRequestResult<T> | JsonRequestFailure> {

  const text = await readLimitedBody(request);
  if (text === BODY_TOO_LARGE) {
    return { ok: false, response: securityError("The request is too large.", 413) };
  }
  if (text === BODY_TIMEOUT) {
    return { ok: false, response: securityError("The request body took too long to arrive.", 408) };
  }
  if (text === BODY_INVALID) {
    return { ok: false, response: securityError("Send a valid UTF-8 JSON request.", 400) };
  }

  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, response: securityError("Send a valid JSON request.", 400) };
  }
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const SEARCH_ITEM_BASE_KEYS = [
  "text",
  "quantity",
  "explicitBrand",
  "explicitSize",
  "explicitPackCount",
  "facetOptionIds",
] as const;

export function hasValidSearchItemShape(
  value: unknown,
  preferenceKeys: readonly string[],
) {
  if (typeof value === "string") {
    const text = value.normalize("NFKC").replace(/\s+/g, " ").trim();
    return text.length >= 1 && text.length <= 300;
  }
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, [...SEARCH_ITEM_BASE_KEYS, ...preferenceKeys])) return false;

  for (const field of preferenceKeys) {
    const preference = value[field];
    if (
      preference !== undefined
      && (typeof preference !== "string" || preference.trim().length < 1 || preference.length > 300)
    ) return false;
  }

  const text = typeof value.text === "string"
    ? value.text.normalize("NFKC").replace(/\s+/g, " ").trim()
    : "";
  if (text.length < 1 || text.length > 300) return false;
  if (
    value.quantity !== undefined
    && (!Number.isInteger(value.quantity) || (value.quantity as number) < 1 || (value.quantity as number) > 99)
  ) return false;
  for (const field of ["explicitBrand", "explicitSize"] as const) {
    const entry = value[field];
    if (entry !== undefined && (typeof entry !== "string" || entry.trim().length > 160)) {
      return false;
    }
  }
  if (
    value.explicitPackCount !== undefined
    && (!Number.isInteger(value.explicitPackCount)
      || (value.explicitPackCount as number) < 1
      || (value.explicitPackCount as number) > 999)
  ) return false;
  if (value.facetOptionIds !== undefined) {
    if (!Array.isArray(value.facetOptionIds) || value.facetOptionIds.length > 12) return false;
    if (value.facetOptionIds.some((id) => typeof id !== "string" || id.length > 80)) return false;
  }
  return true;
}
