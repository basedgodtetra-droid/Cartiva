import { getKrogerAuthClient, KrogerAuthError } from "@/lib/kroger-auth";
import {
  createServerlessKrogerAuthorization,
  usesServerlessKrogerWebSession,
} from "@/lib/kroger-web-session";
import {
  enforceRateLimit,
  validateLocalApiRequest,
} from "@/lib/api-security";
import { sharedWebSessionEnabled } from "@/lib/kroger-shared-client";
import { createSharedKrogerAuthorization } from "@/lib/kroger-shared-web";
import { enforceSharedKrogerRateLimit } from "@/lib/kroger-shared-rate";
import { SharedStateError } from "@/lib/kroger-shared-protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorization(request: Request): Promise<{ authorizationUrl: string; setCookie?: string; setCookies?: string[] }> {
  if (usesServerlessKrogerWebSession(request) && sharedWebSessionEnabled()) {
    const started = await createSharedKrogerAuthorization(request);
    return { authorizationUrl: started.result.authorizationUrl, setCookies: [...started.setCookies, started.result.stateCookie] };
  }
  if (usesServerlessKrogerWebSession(request)) return createServerlessKrogerAuthorization();
  return { authorizationUrl: getKrogerAuthClient().createAuthorizationUrl() };
}

async function guard(request: Request) {
  return validateLocalApiRequest(request)
    ?? enforceRateLimit(request, "kroger-oauth-start", { limit: 8, windowMs: 10 * 60_000 })
    ?? await enforceSharedKrogerRateLimit(request, "kroger-oauth-start", { limit: 8, windowMs: 10 * 60_000 });
}

export async function GET(request: Request) {
  const rejected = await guard(request);
  if (rejected) return rejected;
  try {
    const started = await authorization(request);
    const response = new Response(null, { status: 302, headers: { Location: started.authorizationUrl, "Cache-Control": "no-store" } });
    if (started.setCookie) response.headers.append("Set-Cookie", started.setCookie);
    for (const cookie of started.setCookies ?? []) response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (error) {
    const status = error instanceof KrogerAuthError || error instanceof SharedStateError ? error.status : 500;
    return Response.json(
      { error: error instanceof KrogerAuthError || error instanceof SharedStateError ? error.message : "Kroger connection could not start. Your basket is preserved; please retry." },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: Request) {
  const rejected = await guard(request);
  if (rejected) return rejected;
  try {
    const started = await authorization(request);
    const response = Response.json(
      { authorizationUrl: started.authorizationUrl },
      { headers: { "Cache-Control": "no-store" } },
    );
    if (started.setCookie) response.headers.append("Set-Cookie", started.setCookie);
    for (const cookie of started.setCookies ?? []) response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (error) {
    const status = error instanceof KrogerAuthError || error instanceof SharedStateError ? error.status : 500;
    return Response.json(
      { error: error instanceof KrogerAuthError || error instanceof SharedStateError ? error.message : "Kroger connection could not start. Your basket is preserved; please retry." },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
