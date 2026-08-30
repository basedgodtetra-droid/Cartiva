import { KrogerAuthError } from "@/lib/kroger-auth";
import {
  consumeMobileKrogerAuthorizationState,
  mobileKrogerReturnUrl,
  prepareMobileKrogerAuthorizationCompletion,
} from "@/lib/kroger-mobile-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function returnToCartiva(
  status: "pending" | "cancelled" | "failed",
  comparisonId?: string,
  completion?: string,
) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: mobileKrogerReturnUrl(status, comparisonId, completion),
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const state = parameters.get("state") ?? "";
  let pending;
  try {
    pending = await consumeMobileKrogerAuthorizationState(state);
  } catch {
    // No unverified state value is ever reflected into the return URL.
    return returnToCartiva("failed");
  }

  const authorizationError = parameters.get("error");
  if (authorizationError) {
    return returnToCartiva(
      authorizationError === "access_denied" ? "cancelled" : "failed",
      pending.comparisonId,
    );
  }

  const code = parameters.get("code") ?? "";
  if (code.length < 1 || code.length > 4_096) {
    return returnToCartiva("failed", pending.comparisonId);
  }
  try {
    const completion = await prepareMobileKrogerAuthorizationCompletion(pending, code);
    return returnToCartiva(
      "pending",
      pending.comparisonId,
      completion.completion,
    );
  } catch (error) {
    // Keep diagnostics deliberately structural. Provider messages can echo an
    // authorization code, token, or OAuth error_description, so they must not
    // be written to logs or reflected through the app deep link.
    console.error("Kroger mobile OAuth callback failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: error instanceof KrogerAuthError ? error.code : "unexpected",
      status: error instanceof KrogerAuthError ? error.status : 500,
    });
    return returnToCartiva("failed", pending.comparisonId);
  }
}
