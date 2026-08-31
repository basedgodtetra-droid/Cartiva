import { getKrogerAuthClient, KrogerAuthError } from "@/lib/kroger-auth";
import {
  createServerlessKrogerAuthorization,
  usesServerlessKrogerWebSession,
} from "@/lib/kroger-web-session";
import {
  enforceRateLimit,
  validateLocalApiRequest,
} from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorization(request: Request): { authorizationUrl: string; setCookie?: string } {
  if (usesServerlessKrogerWebSession(request)) return createServerlessKrogerAuthorization();
  return { authorizationUrl: getKrogerAuthClient().createAuthorizationUrl() };
}

function guard(request: Request) {
  return validateLocalApiRequest(request)
    ?? enforceRateLimit(request, "kroger-oauth-start", { limit: 8, windowMs: 10 * 60_000 });
}

export function GET(request: Request) {
  const rejected = guard(request);
  if (rejected) return rejected;
  try {
    const started = authorization(request);
    const response = Response.redirect(started.authorizationUrl, 302);
    if (started.setCookie) response.headers.append("Set-Cookie", started.setCookie);
    return response;
  } catch (error) {
    const status = error instanceof KrogerAuthError ? error.status : 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "Kroger connection could not start." },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export function POST(request: Request) {
  const rejected = guard(request);
  if (rejected) return rejected;
  try {
    const started = authorization(request);
    const response = Response.json(
      { authorizationUrl: started.authorizationUrl },
      { headers: { "Cache-Control": "no-store" } },
    );
    if (started.setCookie) response.headers.append("Set-Cookie", started.setCookie);
    return response;
  } catch (error) {
    const status = error instanceof KrogerAuthError ? error.status : 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "Kroger connection could not start." },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
