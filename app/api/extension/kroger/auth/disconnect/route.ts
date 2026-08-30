import { POST as disconnectKroger } from "@/app/api/kroger/auth/disconnect/route";
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
  return krogerExtensionOptions(request, ["POST"]);
}

export async function POST(request: Request) {
  const origin = request.headers.get("Origin");
  if (!isAllowedExtensionOrigin(origin)) return rejectedKrogerExtensionOrigin();
  return withKrogerExtensionCors(
    await disconnectKroger(trustValidatedExtensionRequest(request)),
    origin!,
  );
}
