import { hasOnlyKeys, isRecord, readValidatedJson, validateLocalApiRequest } from "@/lib/api-security";
import { sharedCommand, sharedWebSessionEnabled } from "@/lib/kroger-shared-client";
import { sharedCartId } from "@/lib/kroger-shared-cart";
import { openShared, type SharedCart } from "@/lib/kroger-shared-protocol";
import { sharedWebOwner } from "@/lib/kroger-shared-web";
import { enforceSharedKrogerRateLimit } from "@/lib/kroger-shared-rate";
import { stateHash } from "@/lib/kroger-shared-protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request) {
  const rejected = validateLocalApiRequest(request);
  if (rejected) return rejected;
  const limited = await enforceSharedKrogerRateLimit(request, "cart-review-read", { limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  if (!sharedWebSessionEnabled()) return json({ operationId: null });
  const identity = sharedWebOwner(request);
  if (!identity) return json({ error: "Reconnect Cartiva before confirming this review." }, 401);
  try {
    const pending = await sharedCommand<SharedCart | null>({ op: "cart.pending", owner: identity.owner });
    if (!pending) return json({ operationId: null });
    const data = openShared<{ operationId: string }>(pending.payload_encrypted, `cart:${identity.owner}`);
    if (!data || !/^[A-Za-z0-9_-]{16,128}$/.test(data.operationId)) throw new Error();
    return json({ operationId: data.operationId });
  } catch { return json({ error: "Cartiva could not load the cart review safely. Please retry." }, 503); }
}

export async function POST(request: Request) {
  const parsed = await readValidatedJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.value) || !hasOnlyKeys(parsed.value, ["operationId", "acknowledgement"])
    || typeof parsed.value.operationId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(parsed.value.operationId)
    || parsed.value.acknowledgement !== "REVIEWED_RETAILER_CART") return json({ error: "Review the retailer cart before continuing." }, 400);
  if (!sharedWebSessionEnabled()) return json({ acknowledged: true });
  const limited = await enforceSharedKrogerRateLimit(request, "cart-review-write", { limit: 12, windowMs: 600_000 });
  if (limited) return limited;
  const identity = sharedWebOwner(request);
  if (!identity) return json({ error: "Reconnect Cartiva before confirming this review." }, 401);
  try {
    if (await sharedCommand<boolean>({ op: "rate", key: stateHash(`review:${identity.owner}`), limit: 12, windowMs: 600_000 }) !== true) return json({ error: "Too many cart review attempts. Wait and retry." }, 429);
    const result = await sharedCommand({ op: "cart.acknowledge", owner: identity.owner, id: sharedCartId(identity.owner, parsed.value.operationId) });
    if (!result) return json({ error: "Cartiva is still finishing the earlier Kroger request. Wait a moment, review the cart, then retry." }, 409);
    return json({ acknowledged: true });
  } catch { return json({ error: "Cartiva could not save the cart review. Your basket is preserved; please retry." }, 503); }
}
