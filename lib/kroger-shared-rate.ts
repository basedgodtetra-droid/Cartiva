import { sharedRateIdentity, type RateLimitPolicy } from "./api-security";
import { sharedCommand, sharedWebSessionEnabled } from "./kroger-shared-client";

export async function enforceSharedKrogerRateLimit(request: Request, scope: string, policy: RateLimitPolicy) {
  if (!sharedWebSessionEnabled()) return null;
  try {
    if (await sharedCommand<boolean>({ op: "rate", key: sharedRateIdentity(request, scope), ...policy }) === true) return null;
    return Response.json({ error: "Too many Kroger requests. Wait a moment and try again.", retrySafe: true }, {
      status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.ceil(policy.windowMs / 1000)) },
    });
  } catch {
    return Response.json({ error: "Cartiva could not safely check this Kroger request. Your basket is preserved; please retry.", retrySafe: true }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
