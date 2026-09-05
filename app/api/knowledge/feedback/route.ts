import { readValidatedJson, hasOnlyKeys, isRecord } from "@/lib/api-security";
import { recordFeedback } from "@/lib/knowledge/feedback";
import type { FeedbackKind } from "@/lib/knowledge/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  // This is a first-party correction endpoint, never a cross-origin beacon.
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Open Cartiva to review this item." }, { status: 403 });
  const parsed = await readValidatedJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const b = parsed.value;
  if (!isRecord(b) || !hasOnlyKeys(b, ["receipt", "kind", "upc"]) || typeof b.receipt !== "string" || b.receipt.length > 16000
    || typeof b.upc !== "string" || !/^\d{12,14}$/.test(b.upc) || !["ACCEPTED", "REJECTED", "SUBSTITUTE", "EQUIVALENCE_PROPOSAL"].includes(String(b.kind))) {
    return Response.json({ error: "Choose a product from this comparison." }, { status: 400 });
  }
  try {
    const result = await recordFeedback(request, { receipt: b.receipt, kind: b.kind as FeedbackKind, upc: b.upc });
    return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Feedback could not be saved. Your basket is unchanged. Compare again to refresh these choices." }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
}
