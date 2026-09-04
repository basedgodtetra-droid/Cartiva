import { readPublicValidatedJson } from "@/lib/api-security";
import { bridgeSignature, equalSignature, SHARED_PATH, stateHash, TOKEN_PATTERN, validSharedCommand } from "@/lib/kroger-shared-protocol";
import { consumeBridgeNonce, currentSharedDatabase, executeSharedCommand } from "@/lib/kroger-shared-sql";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const failure = (status: number) => Response.json({ error: "Shared state request rejected." }, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

export async function POST(request: Request) {
  // Private Sites dispatch authentication AND this independent request MAC
  // are required. Browser cookies/forwarded user headers grant no access.
  const db = currentSharedDatabase();
  if (!db || process.env.CARTIVA_SHARED_STATE_MODE !== "d1") return failure(503);
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")
    || new URL(request.url).pathname !== SHARED_PATH) return failure(403);
  const timestamp = request.headers.get("x-cartiva-state-time") ?? "";
  const nonce = request.headers.get("x-cartiva-state-nonce") ?? "";
  const signature = request.headers.get("x-cartiva-state-signature") ?? "";
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000
    || !TOKEN_PATTERN.test(nonce) || !TOKEN_PATTERN.test(signature)) return failure(401);
  // Reuse the bounded, timed JSON reader; authenticate its exact bytes by
  // requiring canonical serialization, as emitted by the server client.
  const parsed = await readPublicValidatedJson<unknown>(request);
  if (!parsed.ok || !validSharedCommand(parsed.value)) return failure(400);
  try {
    if (!equalSignature(bridgeSignature(JSON.stringify(parsed.value), timestamp, nonce), signature)) return failure(401);
    if (!await consumeBridgeNonce(db, stateHash(nonce))) return failure(409);
    const result = await executeSharedCommand(db, parsed.value);
    return Response.json({ result }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return failure(503); }
}
