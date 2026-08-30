import {
  enforcePublicReadRateLimit,
  hasOnlyKeys,
  isRecord,
  readPublicValidatedJson,
} from "@/lib/api-security";
import {
  mobileSessionOptions,
  rejectDisallowedMobileBrowserOrigin,
  withMobileSessionCors,
} from "@/lib/mobile-api-cors";
import {
  mobileSessionErrorResponse,
  renewMobileSession,
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
    "mobile-v1-session-renew",
    { limit: 30, windowMs: 60 * 60_000 },
  );
  if (limited) return withMobileSessionCors(limited, request);

  const parsed = await readPublicValidatedJson<unknown>(request);
  if (!parsed.ok) return withMobileSessionCors(parsed.response, request);
  if (
    !isRecord(parsed.value)
    || !hasOnlyKeys(parsed.value, ["nextRecoveryToken"])
    || Object.keys(parsed.value).length !== 1
    || typeof parsed.value.nextRecoveryToken !== "string"
    || !/^r1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(parsed.value.nextRecoveryToken)
  ) {
    return withMobileSessionCors(Response.json({
      error: "Send one valid replacement Cartiva recovery credential.",
      code: "invalid",
    }, {
      status: 400,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    }), request);
  }

  try {
    const { sessionToken, recoveryToken, expiresAt } = await renewMobileSession(
      request,
      parsed.value.nextRecoveryToken,
    );
    return withMobileSessionCors(Response.json({
      sessionToken,
      recoveryToken,
      expiresAt: new Date(expiresAt).toISOString(),
    }, {
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    }), request);
  } catch (error) {
    return withMobileSessionCors(mobileSessionErrorResponse(error), request);
  }
}
