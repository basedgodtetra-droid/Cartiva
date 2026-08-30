import { handleKrogerSearchRead } from "@/app/api/kroger/search/route";
import {
  enforcePublicReadRateLimit,
  enforcePublicReadWorkLimit,
  isRecord,
  readPublicValidatedJson,
} from "@/lib/api-security";
import {
  mobileSessionOptions,
  rejectDisallowedMobileBrowserOrigin,
  withMobileSessionCors,
} from "@/lib/mobile-api-cors";
import { mobileSessionErrorResponse, requireMobileSession } from "@/lib/mobile-session";

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
    "mobile-v1-kroger-search",
    { limit: 12, windowMs: 60_000 },
  );
  if (limited) return withMobileSessionCors(limited, request);

  let session;
  if (request.headers.has("Authorization")) {
    try {
      session = requireMobileSession(request);
    } catch (error) {
      return withMobileSessionCors(mobileSessionErrorResponse(error), request);
    }
  }

  const parsed = await readPublicValidatedJson<unknown>(request);
  if (!parsed.ok) return withMobileSessionCors(parsed.response, request);
  const rawItems = isRecord(parsed.value) && Array.isArray(parsed.value.items)
    ? parsed.value.items.length
    : 1;
  // Progressive discovery performs at most three product searches per item.
  // Charge that worst-case fan-out before any location/product provider work.
  const workLimited = enforcePublicReadWorkLimit(
    request,
    "mobile-v1-kroger-search-attempts",
    Math.max(1, rawItems) * 3,
    { limit: 180, windowMs: 60_000 },
    session?.ownerId,
  );
  if (workLimited) return withMobileSessionCors(workLimited, request);
  return withMobileSessionCors(
    await handleKrogerSearchRead(parsed.value, {
      anonymousReadOnly: !session,
      comparisonOwnerId: session?.ownerId,
      requireComparisonReceipt: Boolean(session),
    }),
    request,
  );
}
