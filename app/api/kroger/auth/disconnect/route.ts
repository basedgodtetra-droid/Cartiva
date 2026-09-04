import { getKrogerAuthClient } from "@/lib/kroger-auth";
import { sharedWebSessionEnabled } from "@/lib/kroger-shared-client";
import { disconnectSharedKrogerWebSession } from "@/lib/kroger-shared-web";
import { enforceSharedKrogerRateLimit } from "@/lib/kroger-shared-rate";
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
  const limited = await enforceSharedKrogerRateLimit(request, "kroger-auth-disconnect", { limit: 8, windowMs: 10 * 60_000 });
  if (limited) return limited;
  if (usesServerlessKrogerWebSession(request) && sharedWebSessionEnabled()) {
    try {
      const cookies = await disconnectSharedKrogerWebSession(request);
      const response = Response.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
      for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
      return response;
    } catch {
      return Response.json({ error: "Cartiva could not confirm disconnection. Please retry.", code: "storage" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
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
