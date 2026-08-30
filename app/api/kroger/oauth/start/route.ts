import { getKrogerAuthClient, KrogerAuthError } from "@/lib/kroger-auth";
import {
  enforceRateLimit,
  validateLocalApiRequest,
} from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorizationUrl() {
  return getKrogerAuthClient().createAuthorizationUrl();
}

function guard(request: Request) {
  return validateLocalApiRequest(request)
    ?? enforceRateLimit(request, "kroger-oauth-start", { limit: 8, windowMs: 10 * 60_000 });
}

export function GET(request: Request) {
  const rejected = guard(request);
  if (rejected) return rejected;
  try {
    return Response.redirect(authorizationUrl(), 302);
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
    return Response.json(
      { authorizationUrl: authorizationUrl() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const status = error instanceof KrogerAuthError ? error.status : 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "Kroger connection could not start." },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
