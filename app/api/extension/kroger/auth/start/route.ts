import { POST as startKroger } from "@/app/api/kroger/oauth/start/route";
import { isAllowedExtensionOrigin } from "@/lib/extension-cors";
import { trustValidatedExtensionRequest } from "@/lib/api-security";
import {
  krogerExtensionOptions,
  rejectedKrogerExtensionOrigin,
  withKrogerExtensionCors,
} from "@/lib/kroger-route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  return krogerExtensionOptions(request, ["GET", "POST"]);
}

async function start(request: Request) {
  const origin = request.headers.get("Origin");
  if (!isAllowedExtensionOrigin(origin)) return rejectedKrogerExtensionOrigin();
  const response = await startKroger(trustValidatedExtensionRequest(request));
  if (!response.ok) return withKrogerExtensionCors(response, origin!);
  const payload = await response.json() as { authorizationUrl?: unknown };
  const url = typeof payload.authorizationUrl === "string" ? payload.authorizationUrl : undefined;
  return withKrogerExtensionCors(Response.json(
    { url, authorizationUrl: url },
    { headers: { "Cache-Control": "no-store" } },
  ), origin!);
}

export const GET = start;
export const POST = start;
