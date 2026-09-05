import { createHmac, randomBytes } from "node:crypto";
import { sharedCommand, sharedWebSessionConfigured } from "../kroger-shared-client";
import { equalSignature, openShared, sealShared, sharedSecret } from "../kroger-shared-protocol";
import { sharedRateIdentity } from "../api-security";
import { knowledgeId, KNOWLEDGE_VERSION } from "./foundations";
import type { FeedbackKind } from "./protocol";
import type { ProductFeedbackOffer } from "../types";

const COOKIE = "__Host-cartiva-knowledge";
const sign = (value: string) => createHmac("sha256", sharedSecret()).update(`Cartiva feedback browser v1\0${value}`).digest("base64url");
export function feedbackBrowser(request: Request) {
  const cookie = request.headers.get("cookie")?.split(";").map(c => c.trim()).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!cookie) return null;
  const [id, mac, extra] = cookie.split(".");
  return !extra && /^[A-Za-z0-9_-]{43}$/.test(id ?? "") && equalSignature(sign(id), mac ?? "") ? id : null;
}
export async function prepareFeedbackBrowser(request: Request) {
  if (!sharedWebSessionConfigured() || new URL(request.url).protocol !== "https:"
    || request.headers.get("origin") !== new URL(request.url).origin) return null;
  try {
    // Edge-derived quota survives workers/cookie rotation; not a claim of
    // independent humans. Owner quota also bounds one browser's activity.
    if (!await sharedCommand({ op: "rate", key: sharedRateIdentity(request, "knowledge-receipts"), limit: 30, windowMs: 60000 })) return null;
    const existing = feedbackBrowser(request);
    const owner = existing ?? randomBytes(32).toString("base64url");
    return { owner, cookie: existing ? undefined : `${COOKIE}=${owner}.${sign(owner)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400` };
  } catch { return null; }
}
export interface FeedbackEvidence {
  version: number; nonce: string; conceptId: string; intentDigest: string; itemId: string;
  quantity: number; store: string; fulfillment: string; expiresAt: number;
  recommendedUpc: string; offers: ProductFeedbackOffer[];
}
export function issueFeedbackEvidence(owner: string, value: Omit<FeedbackEvidence, "version" | "nonce" | "expiresAt">) {
  return sealShared({ ...value, version: KNOWLEDGE_VERSION, nonce: randomBytes(24).toString("base64url"), expiresAt: Date.now() + 15 * 60000 }, `knowledge-feedback:${owner}`);
}
export async function recordFeedback(request: Request, body: { receipt: string; kind: FeedbackKind; upc: string }) {
  const owner = feedbackBrowser(request);
  if (!owner) throw new Error("expired");
  const evidence = openShared<FeedbackEvidence>(body.receipt, `knowledge-feedback:${owner}`);
  if (evidence.version !== KNOWLEDGE_VERSION || evidence.expiresAt <= Date.now() || evidence.expiresAt > Date.now() + 16 * 60000
    || !evidence.offers.some(p => p.upc === body.upc)) throw new Error("expired");
  const selected = evidence.offers.find(p => p.upc === body.upc)!;
  if (body.kind === "ACCEPTED" && !selected.canChoose) throw new Error("invalid");
  const allowed = await sharedCommand<boolean>({ op: "rate", key: knowledgeId(`feedback-quota:${owner}`), limit: 60, windowMs: 3600000 });
  if (!allowed || !await sharedCommand<boolean>({ op: "rate", key: sharedRateIdentity(request, "knowledge-feedback"), limit: 120, windowMs: 3600000 })) throw new Error("limited");
  // One logical receipt, one signal. Replays or changed choices cannot grow
  // support, and no persistent actor/browser identifier is stored here.
  return sharedCommand({ op: "knowledge.correct", correction: {
    id: knowledgeId(`feedback-event:${evidence.nonce}`), conceptId: evidence.conceptId,
    rejectedUpc: body.kind === "REJECTED" ? body.upc : evidence.recommendedUpc === body.upc ? "" : evidence.recommendedUpc,
    acceptedUpc: body.kind === "REJECTED" ? "" : body.upc, kind: body.kind,
  } });
}
