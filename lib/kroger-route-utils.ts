import {
  extensionCorsHeaders,
  isAllowedExtensionOrigin,
  withExtensionCors,
} from "./extension-cors";

export function rejectedKrogerExtensionOrigin() {
  return Response.json(
    { error: "This origin is not allowed to use the Cartiva extension API." },
    { status: 403, headers: { "Cache-Control": "no-store", Vary: "Origin" } },
  );
}

export function krogerExtensionOptions(
  request: Request,
  allowedMethods: Array<"GET" | "POST">,
) {
  const origin = request.headers.get("Origin");
  if (!isAllowedExtensionOrigin(origin)) return rejectedKrogerExtensionOrigin();
  const requestedMethod = request.headers.get("Access-Control-Request-Method")?.toUpperCase();
  if (requestedMethod && !allowedMethods.includes(requestedMethod as "GET" | "POST")) {
    return Response.json({ error: "This method is not supported." }, { status: 405 });
  }
  const requestedHeaders = request.headers
    .get("Access-Control-Request-Headers")
    ?.split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean) ?? [];
  if (requestedHeaders.some((header) => header !== "content-type")) {
    return Response.json({ error: "The requested CORS headers are not allowed." }, { status: 400 });
  }
  const headers = extensionCorsHeaders(origin!);
  headers.set("Access-Control-Allow-Methods", `${allowedMethods.join(", ")}, OPTIONS`);
  return new Response(null, { status: 204, headers });
}

export function withKrogerExtensionCors(response: Response, origin: string) {
  const withCors = withExtensionCors(response, origin);
  const headers = new Headers(withCors.headers);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return new Response(withCors.body, {
    status: withCors.status,
    statusText: withCors.statusText,
    headers,
  });
}

export function requiresJson(request: Request) {
  return request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") === true;
}
