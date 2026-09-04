import handler from "vinext/server/app-router-entry";
import { withSharedDatabase, type SharedDatabase } from "../lib/kroger-shared-sql";

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "upgrade-insecure-requests",
    "worker-src 'self' blob:",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
} as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const worker = {
  async fetch(
    request: Request,
    env?: Parameters<typeof handler.fetch>[1],
    ctx?: Parameters<typeof handler.fetch>[2],
  ) {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
      url.protocol = "https:";
      return Response.redirect(url, 308);
    }

    const database = (env as unknown as { DB?: SharedDatabase } | undefined)?.DB;
    const response = await withSharedDatabase(database, () => handler.fetch(request, env, ctx));
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

export default worker;
