import { sharedCommand, sharedWebSessionConfigured } from "../kroger-shared-client";
import { retrieveCandidatesProgressively, type ProductIntent, type DiscoveryAttempt, type DiscoveryQuery } from "../product-search-intent";
import { isRetailerHandoffAcceptedMatch } from "../../packages/shared/src";
import type { KrogerProduct, KrogerMatchResult } from "../types";
import { conceptForIntent, decayedConfidence, knowledgeId, normalizeKnowledgeText, safeKnowledgePhrase, type SafeConcept } from "./foundations";
import type { KnowledgeContext, KnowledgeLearning } from "./protocol";

export async function lookupKnowledge(intents: ProductIntent[]): Promise<Map<string, KnowledgeContext>> {
  if (!sharedWebSessionConfigured()) return new Map();
  const keys = [...new Set(intents.map(conceptForIntent).filter((c): c is SafeConcept => !!c).map(c => c.id))];
  if (!keys.length) return new Map();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      sharedCommand<KnowledgeContext[]>({ op: "knowledge.lookup", keys }),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); }),
    ]);
    return new Map((result ?? []).filter(r => keys.includes(r.conceptId)).map(r => [r.conceptId, r]));
  } catch { return new Map(); }
  finally { if (timer) clearTimeout(timer); }
}

export function knowledgeQueries(intent: ProductIntent, memory?: KnowledgeContext): DiscoveryQuery[] {
  if (!memory) return intent.discoveryQueries;
  const variants: DiscoveryQuery[] = [];
  const add = (query: string, level: DiscoveryQuery["level"] = "normalized") => {
    if (!variants.some(v => normalizeKnowledgeText(v.query) === normalizeKnowledgeText(query))) variants.push({ query, level });
  };
  const proven = memory.queries.find(q => safeKnowledgePhrase(q.query) && q.successes > 0
    && decayedConfidence(q.quality, q.lastConfirmedAt, "RETAILER_METADATA") >= 0.25);
  if (proven) add(proven.query);
  // Current wording stays in the bounded plan, even after a historical failure.
  if (intent.discoveryQueries[0]) add(intent.discoveryQueries[0].query);
  const alias = memory.aliases.find(a => a.stage === "TRUSTED" && safeKnowledgePhrase(a.alias)
    && decayedConfidence(a.confidence, a.lastConfirmedAt, a.source) >= 0.85
    && !variants.some(v => normalizeKnowledgeText(v.query) === normalizeKnowledgeText(a.alias)));
  if (!proven && alias) add(alias.alias, "simplified");
  // A remembered query may replace an intermediate wording, never the final
  // category fallback that made the cold plan recoverable.
  if ((proven || alias) && intent.discoveryQueries.length > 1) {
    const last = intent.discoveryQueries.at(-1)!;
    add(last.query, last.level);
  }
  for (const v of intent.discoveryQueries) add(v.query, v.level);
  return variants.slice(0, 3);
}

/** Memory changes discovery only. Every candidate is verified against the
 * unchanged intent; fulfillment is recalculated from its FRESH package. */
export async function discoverWithKnowledge(options: {
  intent: ProductIntent; memory?: KnowledgeContext;
  search(query: string): Promise<KrogerProduct[]>;
  verify(products: KrogerProduct[]): KrogerMatchResult;
  plausible(product: KrogerProduct): boolean;
  refreshIdentity?(upc: string): Promise<KrogerProduct | null>;
}) {
  const queryOrigins = new Map<string, string>();
  const discovery = await retrieveCandidatesProgressively({
    intent: { ...options.intent, discoveryQueries: knowledgeQueries(options.intent, options.memory) },
    maxSearches: 3, maxCandidates: 60,
    candidateKey: p => p.productId || p.upc || p.id,
    search: async query => {
      const products = await options.search(query);
      for (const p of products) if (!queryOrigins.has(p.upc)) queryOrigins.set(p.upc, query);
      return products;
    },
    hasVerifiedMatch: products => isRetailerHandoffAcceptedMatch(options.verify(products)),
    isPlausible: options.plausible,
  });
  let detailCalls = 0;
  if (!isRetailerHandoffAcceptedMatch(options.verify(discovery.candidates)) && options.refreshIdentity) {
    const identity = options.memory?.products.find(p => /^\d{12,14}$/.test(p.upc) && !discovery.candidates.some(c => c.upc === p.upc));
    if (identity) {
      detailCalls = 1;
      try {
        const fresh = await options.refreshIdentity(identity.upc);
        if (fresh && fresh.upc === identity.upc) discovery.candidates.push(fresh);
      } catch { /* Historical identity is optional; preserve ordinary recovery. */ }
    }
  }
  return { ...discovery, queryOrigins, detailCalls };
}

export function learningForResult(options: {
  intent: ProductIntent; result: KrogerMatchResult; attempts: DiscoveryAttempt[];
  queryOrigins: Map<string, string>; locationId: string; fulfillment: "pickup" | "delivery";
  source?: KnowledgeLearning["source"];
}): KnowledgeLearning | null {
  const concept = conceptForIntent(options.intent);
  if (!concept) return null;
  const p = isRetailerHandoffAcceptedMatch(options.result) ? options.result.recommended : null;
  const checkedAt = p ? Date.parse(p.priceProvenance.checkedAt ?? p.checkedAt ?? "") : Date.now();
  if (!Number.isFinite(checkedAt) || (p && (!/^\d{12,14}$/.test(p.upc) || !p.priceProvenance.exactStoreVerified
    || p.priceProvenance.locationId !== options.locationId || !p.priceProvenance.fulfillment.includes(options.fulfillment)))) return null;
  const selectedQuery = p ? options.queryOrigins.get(p.upc) : undefined;
  const queries = options.attempts.filter(a => safeKnowledgePhrase(a.query)).map(a => ({ query: a.query, success: a.query === selectedQuery }));
  if (!queries.length && !p) return null;
  return {
    // Cached responses and transport retries cannot manufacture extra support.
    id: knowledgeId(`${concept.id}:${p?.upc ?? "none"}:${options.locationId}:${options.fulfillment}:${Math.floor(checkedAt / 120000)}`),
    concept, product: p ? { upc: p.upc, title: p.title.slice(0, 300), brand: (p.brand ?? "").slice(0, 100), package: (p.size?.label ?? "").slice(0, 100) } : null,
    queries, source: options.source ?? "RETAILER_METADATA", checkedAt,
    store: options.locationId, fulfillment: options.fulfillment === "pickup" ? "PICKUP" : "DELIVERY",
    price: p?.price ?? null, availability: p?.availabilityStatus === "in_stock" ? "IN_STOCK" : p?.availabilityStatus === "out_of_stock" ? "OUT_OF_STOCK" : "UNKNOWN",
    packageQuantity: options.result.fulfillment?.cartQuantity ?? options.intent.requestedCartQuantity,
  };
}

export async function rememberResults(records: KnowledgeLearning[], seedFoundations = false) {
  if (!sharedWebSessionConfigured() || !records.length) return;
  const deadline = performance.now() + 20_000;
  if (seedFoundations) {
    try { await sharedCommand({ op: "knowledge.seed" }); }
    catch { return; }
  }
  for (let i = 0; i < records.length; i += 5) {
    if (performance.now() > deadline) break;
    try { await sharedCommand({ op: "knowledge.learn", records: records.slice(i, i + 5) }); }
    catch { if (process.env.NODE_ENV === "development") console.warn("[Cartiva knowledge] Learning unavailable; comparison preserved."); break; }
  }
}
