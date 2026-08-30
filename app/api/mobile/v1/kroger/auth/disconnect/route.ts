import { enforcePublicReadRateLimit } from "@/lib/api-security";
import { KrogerAuthError } from "@/lib/kroger-auth";
import { disconnectMobileKroger } from "@/lib/kroger-mobile-auth";
import {
  mobileSessionOptions,
  rejectDisallowedMobileBrowserOrigin,
  withMobileSessionCors,
} from "@/lib/mobile-api-cors";
import {
  MobileSessionError,
  mobileSessionErrorResponse,
  requireMobileSession,
} from "@/lib/mobile-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  return mobileSessionOptions(request, ["POST"]);
}

export async function POST(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-kroger-auth-disconnect",
    { limit: 8, windowMs: 10 * 60_000 },
  );
  if (limited) return withMobileSessionCors(limited, request);

  let ownerId: string;
  try {
    ownerId = requireMobileSession(request).ownerId;
  } catch (error) {
    return withMobileSessionCors(mobileSessionErrorResponse(error), request);
  }

  try {
    return withMobileSessionCors(Response.json(
      await disconnectMobileKroger(ownerId),
      { headers: { "Cache-Control": "no-store" } },
    ), request);
  } catch (error) {
    // A token-file/keychain cleanup failure is not evidence that the Cartiva
    // bearer is invalid. Returning a session-shaped 401 would make the app
    // rotate owners and orphan comparison/cart duplicate-write guards.
    if (error instanceof MobileSessionError) {
      return withMobileSessionCors(mobileSessionErrorResponse(error), request);
    }
    return withMobileSessionCors(Response.json({
      error: error instanceof KrogerAuthError && error.code === "storage"
        ? error.message
        : "Cartiva could not safely disconnect Kroger. The existing Cartiva session was kept.",
      code: "disconnect_unavailable",
      retrySafe: false,
    }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    }), request);
  }
}
