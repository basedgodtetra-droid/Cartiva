import { GET as handleKrogerOAuthCallback } from "@/app/api/kroger/oauth/callback/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Compatibility callback for the production URI registered in Cartiva's
// Kroger developer application. The implementation remains centralized in the
// established Kroger callback so both registered development and production
// paths exchange codes through the same verified flow.
export const GET = handleKrogerOAuthCallback;
