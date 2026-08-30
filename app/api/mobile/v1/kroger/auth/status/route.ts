import { enforcePublicReadRateLimit } from "@/lib/api-security";
import { KrogerAuthError } from "@/lib/kroger-auth";
import {
  mobileKrogerConnectionStatus,
} from "@/lib/kroger-mobile-auth";
import {
  mobileSessionOptions,
  rejectDisallowedMobileBrowserOrigin,
  withMobileSessionCors,
} from "@/lib/mobile-api-cors";
import {
  mobileSessionErrorResponse,
  requireMobileSession,
} from "@/lib/mobile-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  return mobileSessionOptions(request, ["GET"]);
}

export async function GET(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-kroger-auth-status",
    { limit: 60, windowMs: 60_000 },
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
      await mobileKrogerConnectionStatus(ownerId),
      {
        headers: {
          "Cache-Control": "no-store",
          Pragma: "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      },
    ), request);
  } catch (error) {
    const authError = error instanceof KrogerAuthError ? error : undefined;
    return withMobileSessionCors(Response.json(
      {
        error: authError && authError.code !== "configuration"
          ? authError.message
          : "Cartiva could not check the Kroger connection right now.",
        code: authError?.code ?? "status_unavailable",
      },
      {
        status: authError?.status ?? 503,
        headers: {
          "Cache-Control": "no-store",
          Pragma: "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      },
    ), request);
  }
}
