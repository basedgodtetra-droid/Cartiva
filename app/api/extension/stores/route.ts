import {
  extensionCorsHeaders,
  isAllowedExtensionOrigin,
  withExtensionCors,
} from "@/lib/extension-cors";
import {
  enforceRateLimit,
  hasOnlyKeys,
  isRecord,
  readValidatedJson,
  trustValidatedExtensionRequest,
} from "@/lib/api-security";
import {
  getWalmartStoresByZip,
  normalizeUsZip,
  WalmartStoreDirectoryError,
} from "@/lib/walmart-stores";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rejectedOrigin() {
  return Response.json(
    { error: "This origin is not allowed to use the Cartiva extension API." },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        Vary: "Origin",
      },
    },
  );
}

function jsonWithCors(data: unknown, status: number, origin: string) {
  const headers = extensionCorsHeaders(origin);
  headers.set("Cache-Control", "no-store");
  return Response.json(data, { status, headers });
}

export function OPTIONS(request: Request) {
  const origin = request.headers.get("Origin");
  if (!isAllowedExtensionOrigin(origin)) return rejectedOrigin();

  const requestedMethod = request.headers.get("Access-Control-Request-Method");
  if (requestedMethod && requestedMethod.toUpperCase() !== "POST") {
    return jsonWithCors({ error: "Only POST requests are supported." }, 405, origin!);
  }

  const requestedHeaders = request.headers
    .get("Access-Control-Request-Headers")
    ?.split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean) ?? [];
  if (requestedHeaders.some((header) => header !== "content-type")) {
    return jsonWithCors({ error: "The requested CORS headers are not allowed." }, 400, origin!);
  }

  return new Response(null, {
    status: 204,
    headers: extensionCorsHeaders(origin!),
  });
}

export async function POST(request: Request) {
  const origin = request.headers.get("Origin");
  if (!isAllowedExtensionOrigin(origin)) return rejectedOrigin();

  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return jsonWithCors({ error: "Send the extension request as JSON." }, 415, origin!);
  }

  const trusted = trustValidatedExtensionRequest(request);
  const limited = enforceRateLimit(trusted, "walmart-stores", { limit: 30, windowMs: 60_000 });
  if (limited) return withExtensionCors(limited, origin!);
  const parsed = await readValidatedJson<unknown>(trusted);
  if (!parsed.ok) return withExtensionCors(parsed.response, origin!);
  if (!isRecord(parsed.value) || !hasOnlyKeys(parsed.value, ["zipCode"])) {
    return jsonWithCors({ error: "The store request contains unsupported fields." }, 400, origin!);
  }
  const body = parsed.value;

  let zipCode: string;
  try {
    zipCode = normalizeUsZip(body.zipCode);
  } catch {
    return jsonWithCors({ error: "Enter a five-digit US ZIP code." }, 400, origin!);
  }

  try {
    const result = await getWalmartStoresByZip(zipCode);
    return jsonWithCors(result, 200, origin!);
  } catch (error) {
    const status = error instanceof WalmartStoreDirectoryError && error.code === "timeout"
      ? 504
      : 502;
    return jsonWithCors(
      { error: "Walmart store lookup is temporarily unavailable. Try again or use Walmart's store finder." },
      status,
      origin!,
    );
  }
}
