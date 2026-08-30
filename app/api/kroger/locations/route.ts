import { KrogerProviderError } from "@/lib/kroger-provider";
import { krogerAdapter } from "@/lib/retailers/kroger-adapter";
import type { RetailerClientBoundary } from "@/lib/retailers/retailer-adapter";
import {
  enforceRateLimit,
  hasOnlyKeys,
  isRecord,
  readValidatedJson,
  validateLocalApiRequest,
} from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function zipFromRequest(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.get("zipCode")?.trim() ?? "";
}

async function locationsResponse(
  zipCode: string,
  boundary?: RetailerClientBoundary,
) {
  if (!/^\d{5}$/.test(zipCode)) {
    return Response.json({ error: "Enter a valid 5-digit ZIP code." }, { status: 400 });
  }
  try {
    const result = await krogerAdapter.findLocations(zipCode);
    const locations = boundary === "ANONYMOUS_MOBILE"
      ? result.locations.map((location) => ({
          ...location,
          handoff: {
            mode: krogerAdapter.getHandoffCapabilities(boundary).mode,
            url: krogerAdapter.getHandoffUrl(boundary, location),
            storeSelectionRequired: true,
          },
        }))
      : result.locations;
    return Response.json({
      retailer: "kroger",
      zipCode,
      locations,
    }, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    const status = error instanceof KrogerProviderError ? error.status : 502;
    return Response.json(
      { error: error instanceof Error ? error.message : "Kroger store lookup failed." },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/** Shared read implementation for validated server-side API boundaries. */
export function handleKrogerLocationsRead(
  value: unknown,
  boundary?: RetailerClientBoundary,
) {
  if (!isRecord(value) || !hasOnlyKeys(value, ["zipCode"])) {
    return Response.json({ error: "The Kroger store request contains unsupported fields." }, { status: 400 });
  }
  return locationsResponse(
    typeof value.zipCode === "string" ? value.zipCode.trim() : "",
    boundary,
  );
}

export function GET(request: Request) {
  const rejected = validateLocalApiRequest(request);
  if (rejected) return rejected;
  const limited = enforceRateLimit(request, "kroger-locations", { limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  return locationsResponse(zipFromRequest(request));
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "kroger-locations", { limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  const parsed = await readValidatedJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  return handleKrogerLocationsRead(parsed.value);
}
