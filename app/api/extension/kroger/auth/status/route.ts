import { GET as krogerStatus } from "@/app/api/kroger/auth/status/route";
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

async function statusResponse(request: Request) {
  const origin = request.headers.get("Origin");
  if (!isAllowedExtensionOrigin(origin)) return rejectedKrogerExtensionOrigin();
  return withKrogerExtensionCors(
    await krogerStatus(trustValidatedExtensionRequest(request)),
    origin!,
  );
}

export function GET(request: Request) {
  return statusResponse(request);
}

export function POST(request: Request) {
  return statusResponse(request);
}
