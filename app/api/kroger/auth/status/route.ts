import { getKrogerAuthClient, krogerAuthIsConfigured } from "@/lib/kroger-auth";
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
  return Response.json(
    { ...(await getKrogerAuthClient().connectionStatus()), configured: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
