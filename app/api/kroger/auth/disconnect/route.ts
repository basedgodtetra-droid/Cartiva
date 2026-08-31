import { getKrogerAuthClient } from "@/lib/kroger-auth";
import {
  usesServerlessKrogerWebSession,
  withServerlessKrogerWebSession,
} from "@/lib/kroger-web-session";
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
  if (usesServerlessKrogerWebSession(request)) {
    const disconnected = await withServerlessKrogerWebSession(request, async (client) => {
      await client.disconnect();
      return { connected: false as const };
    });
    const response = Response.json(disconnected.result, { headers: { "Cache-Control": "no-store" } });
    for (const cookie of disconnected.setCookies) response.headers.append("Set-Cookie", cookie);
    return response;
  }
  await getKrogerAuthClient().disconnect();
  return Response.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
}
