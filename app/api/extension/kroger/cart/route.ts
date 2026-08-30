import { POST as addKrogerCart } from "@/app/api/kroger/cart/route";
import { trustValidatedExtensionRequest } from "@/lib/api-security";
import { isAllowedExtensionOrigin } from "@/lib/extension-cors";
import {
  krogerExtensionOptions,
  rejectedKrogerExtensionOrigin,
  requiresJson,
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
  if (!requiresJson(request)) {
    return withKrogerExtensionCors(
      Response.json({ error: "Send the extension request as JSON." }, { status: 415 }),
      origin!,
    );
  }
  return withKrogerExtensionCors(
    await addKrogerCart(trustValidatedExtensionRequest(request)),
    origin!,
  );
}
