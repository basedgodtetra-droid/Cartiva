import {
  getKrogerAuthClient,
  KrogerAuthError,
  krogerAuthIsConfigured,
} from "@/lib/kroger-auth";
import {
  serverlessKrogerWebSessionIsConfigured,
  usesServerlessKrogerWebSession,
  withServerlessKrogerWebSession,
} from "@/lib/kroger-web-session";
import {
  enforceRateLimit,
  validateLocalApiRequest,
} from "@/lib/api-security";
import { enforceSharedKrogerRateLimit } from "@/lib/kroger-shared-rate";
import { SharedStateError } from "@/lib/kroger-shared-protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = validateLocalApiRequest(request)
    ?? enforceRateLimit(request, "kroger-auth-status", { limit: 60, windowMs: 60_000 });
  if (rejected) return rejected;
  const limited = await enforceSharedKrogerRateLimit(request, "kroger-auth-status", { limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  if (!krogerAuthIsConfigured() || !serverlessKrogerWebSessionIsConfigured()) {
    return Response.json(
      { connected: false, configured: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    if (usesServerlessKrogerWebSession(request)) {
      const checked = await withServerlessKrogerWebSession(
        request,
        (client) => client.connectionStatus(),
      );
      const response = Response.json(
        { ...checked.result, configured: true },
        { headers: { "Cache-Control": "no-store" } },
      );
      for (const cookie of checked.setCookies) response.headers.append("Set-Cookie", cookie);
      return response;
    }
    return Response.json(
      { ...(await getKrogerAuthClient().connectionStatus()), configured: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        connected: false,
        configured: true,
        error: error instanceof Error ? error.message : "Kroger connection status could not be read.",
      },
      {
        status: error instanceof KrogerAuthError || error instanceof SharedStateError ? error.status : 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
