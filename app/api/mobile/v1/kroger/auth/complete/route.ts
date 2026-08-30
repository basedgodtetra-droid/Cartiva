import {
  enforcePublicReadRateLimit,
  hasOnlyKeys,
  isRecord,
  readPublicValidatedJson,
} from "@/lib/api-security";
import { KrogerAuthError } from "@/lib/kroger-auth";
import { activateMobileKrogerAuthorization } from "@/lib/kroger-mobile-auth";
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
  return mobileSessionOptions(request, ["POST"]);
}

export async function POST(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-kroger-auth-complete",
    { limit: 12, windowMs: 10 * 60_000 },
  );
  if (limited) return withMobileSessionCors(limited, request);

  let ownerId: string;
  try {
    ownerId = requireMobileSession(request).ownerId;
  } catch (error) {
    return withMobileSessionCors(mobileSessionErrorResponse(error), request);
  }

  const parsed = await readPublicValidatedJson<unknown>(request);
  if (!parsed.ok) return withMobileSessionCors(parsed.response, request);
  if (
    !isRecord(parsed.value)
    || !hasOnlyKeys(parsed.value, ["completion"])
    || typeof parsed.value.completion !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(parsed.value.completion)
  ) {
    return withMobileSessionCors(Response.json({
      error: "This Kroger connection completion is invalid or expired.",
      code: "oauth_binding",
    }, { status: 400, headers: { "Cache-Control": "no-store" } }), request);
  }

  try {
    return withMobileSessionCors(Response.json(
      await activateMobileKrogerAuthorization(ownerId, parsed.value.completion),
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
    return withMobileSessionCors(Response.json({
      error: authError && authError.code !== "configuration"
        ? authError.message
        : "Cartiva could not safely finish the Kroger connection.",
      code: authError?.code ?? "status_unavailable",
    }, {
      status: authError?.status ?? 503,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    }), request);
  }
}
