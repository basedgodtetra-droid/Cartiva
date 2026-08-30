import { getKrogerAuthClient } from "@/lib/kroger-auth";
import {
  enforceRateLimit,
  validateLocalApiRequest,
} from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = validateLocalApiRequest(request)
    ?? enforceRateLimit(request, "kroger-auth-disconnect", { limit: 8, windowMs: 10 * 60_000 });
  if (rejected) return rejected;
  await getKrogerAuthClient().disconnect();
  return Response.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
}
