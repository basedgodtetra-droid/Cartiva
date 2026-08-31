import {
  getKrogerAuthClient,
  KrogerAuthError,
  krogerAuthIsConfigured,
} from "@/lib/kroger-auth";
import {
  enforceRateLimit,
  validateLocalApiRequest,
} from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = validateLocalApiRequest(request)
    ?? enforceRateLimit(request, "kroger-auth-status", { limit: 60, windowMs: 60_000 });
  if (rejected) return rejected;
  if (!krogerAuthIsConfigured()) {
    return Response.json(
      { connected: false, configured: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
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
        status: error instanceof KrogerAuthError ? error.status : 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
