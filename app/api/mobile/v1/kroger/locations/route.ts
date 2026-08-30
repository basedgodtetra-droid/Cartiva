import { handleKrogerLocationsRead } from "@/app/api/kroger/locations/route";
import {
  enforcePublicReadRateLimit,
  readPublicValidatedJson,
} from "@/lib/api-security";
import {
  mobileReadOptions,
  rejectDisallowedMobileBrowserOrigin,
  withMobileReadCors,
} from "@/lib/mobile-api-cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  return mobileReadOptions(request, ["POST"]);
}

export async function POST(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-kroger-locations",
    { limit: 30, windowMs: 60_000 },
  );
  if (limited) return withMobileReadCors(limited, request);

  const parsed = await readPublicValidatedJson<unknown>(request);
  if (!parsed.ok) return withMobileReadCors(parsed.response, request);
  return withMobileReadCors(
    await handleKrogerLocationsRead(parsed.value, "ANONYMOUS_MOBILE"),
    request,
  );
}
