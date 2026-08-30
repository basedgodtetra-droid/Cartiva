import {
  extensionCorsHeaders,
  isAllowedExtensionOrigin,
  withExtensionCors,
} from "@/lib/extension-cors";
import { POST as searchWalmartList } from "@/app/api/search/route";
import { trustValidatedExtensionRequest } from "@/lib/api-security";

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

export function OPTIONS(request: Request) {
  const origin = request.headers.get("Origin");
  if (!isAllowedExtensionOrigin(origin)) return rejectedOrigin();

  const requestedMethod = request.headers.get("Access-Control-Request-Method");
  if (requestedMethod && requestedMethod.toUpperCase() !== "POST") {
    return Response.json(
      { error: "Only POST requests are supported." },
      { status: 405, headers: extensionCorsHeaders(origin!) },
    );
  }

  const requestedHeaders = request.headers
    .get("Access-Control-Request-Headers")
    ?.split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean) ?? [];
  if (requestedHeaders.some((header) => header !== "content-type")) {
    return Response.json(
      { error: "The requested CORS headers are not allowed." },
      { status: 400, headers: extensionCorsHeaders(origin!) },
    );
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
    return Response.json(
      { error: "Send the extension request as JSON." },
      { status: 415, headers: extensionCorsHeaders(origin!) },
    );
  }

  // Forward the untouched JSON request so the extension can include storeId,
  // zipCode, fulfillmentMode, and per-item metadata. The established search
  // route remains the single server-side owner of Walmart provider access.
  const response = await searchWalmartList(trustValidatedExtensionRequest(request));
  return withExtensionCors(response, origin!);
}
