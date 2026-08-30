import { enforcePublicReadRateLimit } from "@/lib/api-security";
import {
  mobileReadOptions,
  rejectDisallowedMobileBrowserOrigin,
  withMobileReadCors,
} from "@/lib/mobile-api-cors";
import { anonymousMobileRetailerCapabilities } from "@/lib/retailers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  return mobileReadOptions(request, ["GET"]);
}

export function GET(request: Request) {
  const rejectedOrigin = rejectDisallowedMobileBrowserOrigin(request);
  if (rejectedOrigin) return rejectedOrigin;
  const limited = enforcePublicReadRateLimit(
    request,
    "mobile-v1-capabilities",
    { limit: 120, windowMs: 60_000 },
  );
  if (limited) return withMobileReadCors(limited, request);

  const retailers = anonymousMobileRetailerCapabilities();
  const temporarySessionSupported = retailers.some(
    (retailer) => retailer.handoff.mode === "CART_TRANSFER_SUPPORTED",
  );
  return withMobileReadCors(Response.json({
    apiVersion: "v1",
    access: temporarySessionSupported
      ? "ANONYMOUS_WITH_TEMPORARY_SESSION"
      : "ANONYMOUS_READ_ONLY",
    retailers,
  }, {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  }), request);
}
