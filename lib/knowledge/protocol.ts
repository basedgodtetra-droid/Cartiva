import { safeKnowledgePhrase, type SafeConcept } from "./foundations";

export interface RetailerIdentity {
  upc: string; title: string; brand: string; package: string;
}
export interface KnowledgeLearning {
  id: string; concept: SafeConcept; product: RetailerIdentity | null;
  queries: { query: string; success: boolean }[];
  source: "RETAILER_METADATA" | "FIXTURE";
  checkedAt: number; store: string; fulfillment: "PICKUP" | "DELIVERY";
  price: number | null; availability: string; packageQuantity: number;
}
export type FeedbackKind = "ACCEPTED" | "REJECTED" | "SUBSTITUTE" | "EQUIVALENCE_PROPOSAL";
export interface KnowledgeCorrection {
  id: string; conceptId: string; rejectedUpc: string; acceptedUpc: string; kind: FeedbackKind;
}
export type KnowledgeCommand =
  | { op: "knowledge.lookup"; keys: string[] }
  | { op: "knowledge.learn"; records: KnowledgeLearning[] }
  | { op: "knowledge.correct"; correction: KnowledgeCorrection }
  | { op: "knowledge.seed" };
export interface KnowledgeContext {
  conceptId: string;
  foundationsReady?: boolean;
  aliases: { alias: string; source: string; confidence: number; stage: string; lastConfirmedAt: number }[];
  queries: { query: string; successes: number; failures: number; quality: number; lastConfirmedAt: number }[];
  products: (RetailerIdentity & { lastObservedAt: number })[];
  relationships: { toConcept: string; kind: string; source: string; stage: string }[];
  semantics?: { rules: string; version: number };
}
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const upc = (v: unknown): v is string => typeof v === "string" && /^\d{12,14}$/.test(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(f => f in v);
const bounded = (v: unknown, n: number): v is string => typeof v === "string" && v.length <= n && !/[\r\n\x00-\x1f]/.test(v);
function validLearning(v: unknown): v is KnowledgeLearning {
  if (!obj(v) || !exact(v, ["id", "concept", "product", "queries", "source", "checkedAt", "store", "fulfillment", "price", "availability", "packageQuantity"])) return false;
  const c = v.concept;
  if (!obj(c) || !exact(c, ["id", "canonical", "alias", "category", "attributes", "curated"]) || !hash(c.id)
    || !safeKnowledgePhrase(c.canonical) || !safeKnowledgePhrase(c.alias) || !bounded(c.category, 40)
    || !Array.isArray(c.attributes) || c.attributes.length > 12 || !c.attributes.every(safeKnowledgePhrase) || typeof c.curated !== "boolean") return false;
  const p = v.product;
  if (p !== null && (!obj(p) || !exact(p, ["upc", "title", "brand", "package"]) || !upc(p.upc) || !bounded(p.title, 300) || !bounded(p.brand, 100) || !bounded(p.package, 100))) return false;
  return hash(v.id) && Array.isArray(v.queries) && v.queries.length <= 4
    && v.queries.every(q => obj(q) && exact(q, ["query", "success"]) && safeKnowledgePhrase(q.query) && typeof q.success === "boolean" && (!q.success || p !== null))
    && (v.source === "RETAILER_METADATA" || (v.source === "FIXTURE" && process.env.NODE_ENV === "test"))
    && Number.isSafeInteger(v.checkedAt) && (v.checkedAt as number) > 0
    && typeof v.store === "string" && /^\d{8}$/.test(v.store)
    && ["PICKUP", "DELIVERY"].includes(v.fulfillment as string)
    && (v.price === null || (typeof v.price === "number" && Number.isFinite(v.price) && v.price > 0 && v.price < 10000))
    && ["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN", "LOW_STOCK"].includes(v.availability as string)
    && Number.isSafeInteger(v.packageQuantity) && (v.packageQuantity as number) >= 1 && (v.packageQuantity as number) <= 999;
}
export function validKnowledgeCommand(v: unknown): v is KnowledgeCommand {
  if (!obj(v)) return false;
  switch (v.op) {
    case "knowledge.seed": return exact(v, ["op"]);
    case "knowledge.lookup": return exact(v, ["op", "keys"]) && Array.isArray(v.keys) && v.keys.length >= 1 && v.keys.length <= 50 && v.keys.every(hash);
    case "knowledge.learn": return exact(v, ["op", "records"]) && Array.isArray(v.records) && v.records.length >= 1 && v.records.length <= 10 && v.records.every(validLearning);
    case "knowledge.correct": {
      const c = v.correction;
      return exact(v, ["op", "correction"]) && obj(c) && exact(c, ["id", "conceptId", "rejectedUpc", "acceptedUpc", "kind"])
        && hash(c.id) && hash(c.conceptId) && (c.rejectedUpc === "" || upc(c.rejectedUpc)) && (c.acceptedUpc === "" || upc(c.acceptedUpc))
        && ["ACCEPTED", "REJECTED", "SUBSTITUTE", "EQUIVALENCE_PROPOSAL"].includes(c.kind as string)
        && Boolean(c.rejectedUpc || c.acceptedUpc);
    }
    default: return false;
  }
}
