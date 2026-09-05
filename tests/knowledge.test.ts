import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgeDatabase } from "./support/knowledge-database";
import { executeSharedCommand, withSharedDatabase } from "@/lib/kroger-shared-sql";
import { validSharedCommand } from "@/lib/kroger-shared-protocol";
import { conceptForIntent, knowledgeId, decayedConfidence, safeKnowledgePhrase, OFFER_TTL_MS } from "@/lib/knowledge/foundations";
import { knowledgeQueries, learningForResult, lookupKnowledge } from "@/lib/knowledge/pipeline";
import { parseProductIntent } from "@/lib/product-search-intent";
import { issueFeedbackEvidence, prepareFeedbackBrowser } from "@/lib/knowledge/feedback";
import { POST as feedbackPost } from "@/app/api/knowledge/feedback/route";
import type { KnowledgeLearning, KnowledgeContext } from "@/lib/knowledge/protocol";

const databases: ReturnType<typeof knowledgeDatabase>[] = [];
const open = () => { const value = knowledgeDatabase(); databases.push(value); return value; };
const origin = "https://cartiva-smoky.vercel.app";
const req = (cookie = "", body?: unknown) => new Request(`${origin}/api/knowledge/feedback`, { method: "POST", headers: { Origin: origin, cookie, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
function learning(overrides: Partial<KnowledgeLearning> = {}): KnowledgeLearning {
  return {
    id: knowledgeId("observation-1"), concept: conceptForIntent(parseProductIntent("coke zero"))!,
    product: { upc: "0004900000012", title: "Coca-Cola Zero Sugar", brand: "Coca-Cola", package: "12 count" },
    queries: [{ query: "coke zero", success: false }, { query: "coca cola zero sugar", success: true }],
    source: "FIXTURE", checkedAt: Date.now(), store: "03500529", fulfillment: "PICKUP", price: 8.99, availability: "UNKNOWN", packageQuantity: 1, ...overrides,
  };
}
beforeEach(() => {
  vi.stubEnv("CARTIVA_SHARED_STATE_MODE", "d1");
  vi.stubEnv("CARTIVA_SHARED_STATE_SECRET", "knowledge-test-secret-longer-than-forty-three-characters");
  vi.stubEnv("CARTIVA_PUBLIC_ORIGIN", origin);
});
afterEach(() => { for (const d of databases.splice(0)) d.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("persistent product knowledge", () => {
  it("persists concepts, trusted curated aliases, negative knowledge and package semantics separately from offers", async () => {
    const { db, sqlite } = open();
    await executeSharedCommand(db, { op: "knowledge.seed" });
    await executeSharedCommand(db, { op: "knowledge.learn", records: [learning()] });
    const result = await executeSharedCommand(db, { op: "knowledge.lookup", keys: [learning().concept.id] }) as KnowledgeContext[];
    expect(result[0].aliases.some(a => a.alias === "coke zero" && a.stage === "TRUSTED")).toBe(true);
    expect(result[0].products[0]).toMatchObject({ upc: "0004900000012", package: "12 count" });
    expect(result[0].products[0]).not.toHaveProperty("price");
    expect(result[0].products[0]).not.toHaveProperty("availability");
    expect(result[0].relationships).toContainEqual(expect.objectContaining({ kind: "CONTRADICTORY", toConcept: knowledgeId("diet coke") }));
    expect(result[0].semantics?.rules).toContain("package");
    expect(sqlite.prepare("SELECT expiresAt-checkedAt AS ttl FROM cartiva_match_observations LIMIT 1").get()?.ttl).toBe(OFFER_TTL_MS);
  });
  it("keeps query evidence idempotent across concurrent signed-command retries", async () => {
    const { db, sqlite } = open(); const record = learning();
    await Promise.all(Array.from({ length: 12 }, () => executeSharedCommand(db, { op: "knowledge.learn", records: [record] })));
    const rows = sqlite.prepare("SELECT successes,failures FROM cartiva_search_query_memory ORDER BY successes DESC").all();
    expect(rows).toEqual([{ successes: 1, failures: 0 }, { successes: 0, failures: 1 }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cartiva_match_observations").get()?.n).toBe(2);
  });
  it("indexes query evidence and excludes old-version/expired support", async () => {
    const { db, sqlite } = open();
    await executeSharedCommand(db, { op: "knowledge.learn", records: [learning()] });
    sqlite.prepare("UPDATE cartiva_match_observations SET version=0 WHERE outcome='VERIFIED'").run();
    await executeSharedCommand(db, { op: "knowledge.learn", records: [learning({ id: knowledgeId("fresh-event") })] });
    expect(sqlite.prepare("SELECT successes FROM cartiva_search_query_memory WHERE query='coca cola zero sugar'").get()?.successes).toBe(1);
    const plan = sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM cartiva_match_observations WHERE conceptId=? AND query=? AND version=? AND checkedAt>?").all("x", "milk", 1, 0);
    expect(JSON.stringify(plan)).toContain("USING INDEX cartiva_observation_query");
  });
  it("learns retailer vocabulary as provisional evidence and recognizes paper-product semantics", async () => {
    const { db, sqlite } = open();
    await executeSharedCommand(db, { op: "knowledge.learn", records: [learning({ product: { upc: "0004900000012", title: "Coca-Cola Zero Sugar Soda Cans", brand: "Coca-Cola", package: "12 count" } })] });
    expect(sqlite.prepare("SELECT source,stage FROM cartiva_product_aliases WHERE alias='coca cola zero sugar soda cans'").get()).toEqual({ source: "RETAILER_METADATA", stage: "PROVISIONAL" });
    expect(conceptForIntent(parseProductIntent("paper towels"))?.category).toBe("paper products");
  });
  it("survives close/reopen and applies migrations twice without modifying existing OAuth rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cartiva-knowledge-test-"));
    const path = join(directory, "knowledge.sqlite");
    let first = knowledgeDatabase(path);
    try {
      first.sqlite.prepare("INSERT INTO kroger_customer_sessions(owner_id,session_encrypted,token_expires_at,session_version,updated_at) VALUES ('existing','opaque',1,9,1)").run();
      await executeSharedCommand(first.db, { op: "knowledge.learn", records: [learning()] });
      first.close(); first = knowledgeDatabase(path);
      expect(first.sqlite.prepare("SELECT session_encrypted,session_version FROM kroger_customer_sessions WHERE owner_id='existing'").get()).toEqual({ session_encrypted: "opaque", session_version: 9 });
      expect((await executeSharedCommand(first.db, { op: "knowledge.lookup", keys: [learning().concept.id] }) as KnowledgeContext[])[0].queries[0].successes).toBe(1);
    } finally { first.close(); rmSync(directory, { recursive: true }); }
  });
  it.each(["my diabetic cutting diet milk", "milk for Josh", "milk josh@example.com", "sara@daisy.farm milk", "milk@bread", "rice https://example.com", "chicken\nmy address", "milk 5551234567", "private medical pasta"])("does not globally learn personal prose: %s", value => {
    expect(safeKnowledgePhrase(value)).toBe(false);
    expect(conceptForIntent(parseProductIntent(value))).toBeNull();
  });
  it("rejects arbitrary command fields, numeric UPC, fixture training in production, and claimed global promotion", () => {
    const r = learning();
    expect(validSharedCommand({ op: "knowledge.learn", records: [r] })).toBe(true);
    expect(validSharedCommand({ op: "knowledge.learn", records: [{ ...r, originalText: "private" }] })).toBe(false);
    expect(validSharedCommand({ op: "knowledge.learn", records: [{ ...r, product: { ...r.product, upc: 4900000012 } }] })).toBe(false);
    expect(validSharedCommand({ op: "knowledge.correct", correction: { id: knowledgeId("x"), conceptId: r.concept.id, acceptedUpc: r.product!.upc, rejectedUpc: "", kind: "ACCEPTED", stage: "TRUSTED" } })).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(validSharedCommand({ op: "knowledge.learn", records: [r] })).toBe(false);
  });
  it("never stores stale or future observations as current evidence", async () => {
    const { db, sqlite } = open();
    await executeSharedCommand(db, { op: "knowledge.learn", records: [learning({ checkedAt: Date.now() - 3 * 60000 }), learning({ checkedAt: Date.now() + 2 * 60000 })] });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cartiva_match_observations").get()?.n).toBe(0);
  });
  it("weak knowledge decays, curated facts do not, and failed queries are not blacklisted", () => {
    const now = Date.now();
    expect(decayedConfidence(0.8, now - 90 * 86400000, "INFERRED", now)).toBeCloseTo(0.4);
    expect(decayedConfidence(1, 1, "CURATED", now)).toBe(1);
    const intent = parseProductIntent("coke zero");
    expect(knowledgeQueries(intent, { conceptId: "x", aliases: [], products: [], relationships: [], queries: [{ query: "coke zero", successes: 0, failures: 99, quality: 0, lastConfirmedAt: now }] })).toEqual(intent.discoveryQueries.slice(0, 3));
    expect(conceptForIntent(parseProductIntent("white bread"))?.id).not.toBe(conceptForIntent(parseProductIntent("gluten free white bread"))?.id);
  });
  it("100 independent cookies/signals cannot promote a substitution or alias", async () => {
    const { db, sqlite } = open(); const c = learning().concept;
    for (let i = 0; i < 100; i++) await executeSharedCommand(db, { op: "knowledge.correct", correction: {
      id: knowledgeId(`separate-signal-${i}`), conceptId: c.id, rejectedUpc: "0004900000012", acceptedUpc: "0004900000013", kind: "SUBSTITUTE",
    } });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cartiva_match_corrections WHERE stage='PROVISIONAL' AND kind='SUBSTITUTE'").get()?.n).toBe(100);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cartiva_product_aliases").get()?.n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cartiva_product_relationships").get()?.n).toBe(0);
  });
  it("memory unavailable falls back without an OAuth session or parser failure", async () => {
    const db = { prepare() { throw new Error("offline"); }, async batch() { throw new Error("offline"); } };
    expect((await withSharedDatabase(db, () => lookupKnowledge([parseProductIntent("milk")]))).size).toBe(0);
  });
});

describe("server-authenticated shopper corrections", () => {
  async function issued() {
    const storage = open();
    const identity = await withSharedDatabase(storage.db, () => prepareFeedbackBrowser(req()));
    expect(identity).not.toBeNull();
    const evidence = { conceptId: learning().concept.id, intentDigest: knowledgeId("coke zero"), itemId: "item-1", quantity: 1,
      store: "03500529", fulfillment: "pickup", recommendedUpc: "0004900000012", offers: [
        { upc: "0004900000012", productId: "0004900000012", title: "Coca-Cola Zero Sugar", package: "12 count", canChoose: true },
        { upc: "0004900000013", productId: "0004900000013", title: "Diet Coke", package: "12 count", canChoose: false },
      ] };
    return { ...storage, identity: identity!, evidence, receipt: issueFeedbackEvidence(identity!.owner, evidence), cookie: identity!.cookie!.split(";", 1)[0] };
  }
  it("records one logical event across double-clicks without tokens, prompts or actor identifiers", async () => {
    const x = await issued(); const body = { receipt: x.receipt, upc: "0004900000012", kind: "ACCEPTED" };
    for (let i = 0; i < 2; i++) expect((await withSharedDatabase(x.db, () => feedbackPost(req(x.cookie, body)))).status).toBe(200);
    const rows = x.sqlite.prepare("SELECT * FROM cartiva_match_corrections").all();
    expect(rows).toHaveLength(1); expect(JSON.stringify(rows)).not.toContain(x.identity.owner);
    expect(rows[0]).toMatchObject({ stage: "PROVISIONAL", kind: "ACCEPTED" });
  });
  it("rejects forged, cross-browser, expired, and unoffered products", async () => {
    const x = await issued();
    const other = await withSharedDatabase(x.db, () => prepareFeedbackBrowser(req()));
    const bodies = [
      [x.cookie, { receipt: x.receipt + "x", upc: "0004900000012", kind: "ACCEPTED" }],
      [other!.cookie!.split(";", 1)[0], { receipt: x.receipt, upc: "0004900000012", kind: "ACCEPTED" }],
      [x.cookie, { receipt: x.receipt, upc: "0004900000999", kind: "ACCEPTED" }],
      [x.cookie, { receipt: x.receipt, upc: "0004900000013", kind: "ACCEPTED" }],
    ] as const;
    for (const [cookie, body] of bodies) expect((await withSharedDatabase(x.db, () => feedbackPost(req(cookie, body)))).status).toBe(409);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 16 * 60000);
    expect((await withSharedDatabase(x.db, () => feedbackPost(req(x.cookie, { receipt: x.receipt, upc: "0004900000012", kind: "ACCEPTED" })))).status).toBe(409);
  });
  it("records an explicit substitution without asserting equivalence", async () => {
    const x = await issued();
    expect((await withSharedDatabase(x.db, () => feedbackPost(req(x.cookie, { receipt: x.receipt, upc: "0004900000013", kind: "SUBSTITUTE" })))).status).toBe(200);
    expect(x.sqlite.prepare("SELECT kind,stage FROM cartiva_match_corrections").get()).toEqual({ kind: "SUBSTITUTE", stage: "PROVISIONAL" });
  });
});
