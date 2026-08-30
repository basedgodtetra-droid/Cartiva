const MOBILE_ALLOWED_ORIGINS_ENV = "CARTIVA_MOBILE_ALLOWED_ORIGINS";
const MOBILE_ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "x-cartiva-client",
]);
const MOBILE_SESSION_REQUEST_HEADERS = new Set([
  ...MOBILE_ALLOWED_REQUEST_HEADERS,
  "authorization",
]);

function isPrivateIpv4Hostname(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function normalizedConfiguredOrigin(value: string) {
  try {
    const parsed = new URL(value);
    const isSecureWebOrigin = parsed.protocol === "https:";
    const isLocalDevelopmentOrigin = parsed.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    const isPrivateLanDevelopmentOrigin = process.env.NODE_ENV !== "production"
      && parsed.protocol === "http:"
      && isPrivateIpv4Hostname(parsed.hostname);
    if (
      (!isSecureWebOrigin && !isLocalDevelopmentOrigin && !isPrivateLanDevelopmentOrigin)
      || parsed.username
      || parsed.password
      || parsed.origin !== value
    ) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function configuredMobileOrigins(value = process.env[MOBILE_ALLOWED_ORIGINS_ENV]) {
  if (!value?.trim()) return new Set<string>();
  return new Set(
    value
      .split(",")
      .map((entry) => normalizedConfiguredOrigin(entry.trim()))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

export function isAllowedMobileBrowserOrigin(origin: string | null) {
  if (!origin) return true;
  return configuredMobileOrigins().has(origin);
}

function appendVaryOrigin(headers: Headers) {
  const vary = headers.get("Vary")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  if (!vary.some((value) => value.toLowerCase() === "origin")) vary.push("Origin");
  headers.set("Vary", vary.join(", "));
}

function mobileCorsHeaders(origin: string, allowAuthorization = false) {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": allowAuthorization
      ? "Accept, Authorization, Content-Type, X-Cartiva-Client"
      : "Accept, Content-Type, X-Cartiva-Client",
    "Access-Control-Max-Age": "600",
  });
}

export function rejectedMobileBrowserOrigin() {
  return Response.json(
    { error: "This browser origin is not allowed to use the Cartiva mobile API." },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        Vary: "Origin",
      },
    },
  );
}

export function rejectDisallowedMobileBrowserOrigin(request: Request) {
  return isAllowedMobileBrowserOrigin(request.headers.get("Origin"))
    ? null
    : rejectedMobileBrowserOrigin();
}

/** Adds CORS only for an explicitly configured browser origin. Native clients omit Origin. */
export function withMobileReadCors(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  appendVaryOrigin(headers);
  const origin = request.headers.get("Origin");
  if (origin && isAllowedMobileBrowserOrigin(origin)) {
    for (const [name, value] of mobileCorsHeaders(origin)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** CORS for bearer-authenticated temporary mobile-session endpoints only. */
export function withMobileSessionCors(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  appendVaryOrigin(headers);
  const origin = request.headers.get("Origin");
  if (origin && isAllowedMobileBrowserOrigin(origin)) {
    for (const [name, value] of mobileCorsHeaders(origin, true)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function mobileReadOptions(
  request: Request,
  allowedMethods: readonly string[],
) {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedMobileBrowserOrigin(origin)) {
    return rejectedMobileBrowserOrigin();
  }

  const requestedMethod = request.headers.get("Access-Control-Request-Method")?.toUpperCase();
  if (requestedMethod && !allowedMethods.includes(requestedMethod)) {
    return Response.json(
      { error: "This method is not supported." },
      { status: 405, headers: { "Cache-Control": "no-store", Vary: "Origin" } },
    );
  }

  const requestedHeaders = request.headers
    .get("Access-Control-Request-Headers")
    ?.split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean) ?? [];
  if (requestedHeaders.some((header) => !MOBILE_ALLOWED_REQUEST_HEADERS.has(header))) {
    return Response.json(
      { error: "The requested CORS headers are not allowed." },
      { status: 400, headers: { "Cache-Control": "no-store", Vary: "Origin" } },
    );
  }

  const headers = mobileCorsHeaders(origin);
  headers.set("Access-Control-Allow-Methods", `${allowedMethods.join(", ")}, OPTIONS`);
  appendVaryOrigin(headers);
  return new Response(null, { status: 204, headers });
}

export function mobileSessionOptions(
  request: Request,
  allowedMethods: readonly string[],
) {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedMobileBrowserOrigin(origin)) {
    return rejectedMobileBrowserOrigin();
  }

  const requestedMethod = request.headers.get("Access-Control-Request-Method")?.toUpperCase();
  if (requestedMethod && !allowedMethods.includes(requestedMethod)) {
    return Response.json(
      { error: "This method is not supported." },
      { status: 405, headers: { "Cache-Control": "no-store", Vary: "Origin" } },
    );
  }

  const requestedHeaders = request.headers
    .get("Access-Control-Request-Headers")
    ?.split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean) ?? [];
  if (requestedHeaders.some((header) => !MOBILE_SESSION_REQUEST_HEADERS.has(header))) {
    return Response.json(
      { error: "The requested CORS headers are not allowed." },
      { status: 400, headers: { "Cache-Control": "no-store", Vary: "Origin" } },
    );
  }

  const headers = mobileCorsHeaders(origin, true);
  headers.set("Access-Control-Allow-Methods", `${allowedMethods.join(", ")}, OPTIONS`);
  appendVaryOrigin(headers);
  return new Response(null, { status: 204, headers });
}
