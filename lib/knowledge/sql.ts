import type { SharedDatabase, SharedStatement } from "../kroger-shared-sql";
import { CATEGORY_RULES, CURATED_CONCEPTS, CURATED_CONTRADICTIONS, KNOWLEDGE_VERSION, OFFER_TTL_MS, knowledgeId, normalizeKnowledgeText, safeKnowledgePhrase } from "./foundations";
import { stripDiscoveryPackageTerms } from "../product-search-intent";
import type { KnowledgeCommand, KnowledgeContext } from "./protocol";

/** Server-only named operations; no runtime schema creation, no auth-table writes. */
export async function executeKnowledgeCommand(db: SharedDatabase, c: KnowledgeCommand, now: number): Promise<unknown> {
  const q = (sql: string, ...v: (string | number | null)[]) => db.prepare(sql).bind(...v);
  if (c.op === "knowledge.lookup") {
    const placeholders = c.keys.map(() => "?").join(",");
    const rows = await db.batch([
      q(`SELECT * FROM cartiva_product_aliases WHERE conceptId IN (${placeholders}) AND version=? AND stage='TRUSTED' LIMIT 200`, ...c.keys, KNOWLEDGE_VERSION),
      q(`SELECT * FROM cartiva_search_query_memory WHERE conceptId IN (${placeholders}) AND version=? AND stage='TRUSTED' AND lastConfirmedAt>? ORDER BY quality DESC,lastConfirmedAt DESC LIMIT 200`, ...c.keys, KNOWLEDGE_VERSION, now - 90 * 86400000),
      q(`SELECT * FROM cartiva_retailer_products WHERE conceptId IN (${placeholders}) AND version=? AND lastObservedAt>? ORDER BY lastObservedAt DESC LIMIT 200`, ...c.keys, KNOWLEDGE_VERSION, now - 180 * 86400000),
      q(`SELECT * FROM cartiva_product_relationships WHERE fromConcept IN (${placeholders}) AND version=? AND stage='TRUSTED' LIMIT 200`, ...c.keys, KNOWLEDGE_VERSION),
      q(`SELECT p.id,s.rules,s.version FROM cartiva_product_concepts p JOIN cartiva_category_semantics s ON p.category=s.category WHERE p.id IN (${placeholders})`, ...c.keys),
      q(`SELECT version FROM cartiva_category_semantics WHERE category='soda' AND version=?`, KNOWLEDGE_VERSION),
    ]);
    return c.keys.map(key => ({
      conceptId: key,
      foundationsReady: Boolean(rows[5].results?.length),
      aliases: (rows[0].results ?? []).filter(r => r.conceptId === key).slice(0, 8).map(r => ({ alias: r.alias, source: r.source, confidence: r.confidence, stage: r.stage, lastConfirmedAt: r.lastConfirmedAt })),
      queries: (rows[1].results ?? []).filter(r => r.conceptId === key).slice(0, 3).map(r => ({ query: r.query, successes: r.successes, failures: r.failures, quality: r.quality, lastConfirmedAt: r.lastConfirmedAt })),
      products: (rows[2].results ?? []).filter(r => r.conceptId === key).slice(0, 3).map(r => ({ upc: r.upc, title: r.title, brand: r.brand, package: r.package, lastObservedAt: r.lastObservedAt })),
      relationships: (rows[3].results ?? []).filter(r => r.fromConcept === key).map(r => ({ toConcept: r.toConcept, kind: r.kind, source: r.source, stage: r.stage })),
      semantics: (rows[4].results ?? []).find(r => r.id === key),
    })) as KnowledgeContext[];
  }
  if (c.op === "knowledge.correct") {
    const f = c.correction;
    // A cookie, retry, purchase, or replacement choice never proves equivalence.
    // Quarantine evidence for review; no alias/ranking/global-negative mutation.
    const row = await q(`INSERT INTO cartiva_match_corrections
      (id,conceptId,rejectedUpc,acceptedUpc,kind,source,stage,confidence,version,createdAt)
      VALUES (?,?,?,?,?,'SHOPPER_CONFIRMED','PROVISIONAL',0.5,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`,
    f.id, f.conceptId, f.rejectedUpc, f.acceptedUpc, f.kind, KNOWLEDGE_VERSION, now).first();
    return { recorded: true, duplicate: !row, stage: "PROVISIONAL" };
  }
  const statements: SharedStatement[] = [];
  const concept = (id: string, canonical: string, category: string, attributes: string[], curated: boolean) => {
    statements.push(q(`INSERT INTO cartiva_product_concepts
      (id,canonical,category,attributes,source,confidence,stage,version,createdAt,updatedAt,lastConfirmedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      category=CASE WHEN source='CURATED' AND excluded.source<>'CURATED' THEN category ELSE excluded.category END,
      attributes=CASE WHEN source='CURATED' AND excluded.source<>'CURATED' THEN attributes ELSE excluded.attributes END,
      source=CASE WHEN source='CURATED' AND excluded.source<>'CURATED' THEN source ELSE excluded.source END,
      stage=CASE WHEN source='CURATED' AND excluded.source<>'CURATED' THEN stage ELSE excluded.stage END,
      confidence=CASE WHEN source='CURATED' AND excluded.source<>'CURATED' THEN confidence ELSE excluded.confidence END,
      version=excluded.version,updatedAt=MAX(updatedAt,excluded.updatedAt),lastConfirmedAt=MAX(lastConfirmedAt,excluded.lastConfirmedAt)
      WHERE excluded.version>=version`,
    id, canonical, category, JSON.stringify(attributes), curated ? "CURATED" : "RETAILER_METADATA", curated ? 1 : 0.8, curated ? "TRUSTED" : "PROVISIONAL", KNOWLEDGE_VERSION, now, now, now));
  };
  const alias = (id: string, value: string, curated: boolean, retailerMetadata = false) => {
    statements.push(q(`INSERT INTO cartiva_product_aliases
      (id,conceptId,alias,source,confidence,stage,version,createdAt,updatedAt,lastConfirmedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      source=CASE WHEN excluded.source='CURATED' THEN excluded.source ELSE source END,
      stage=CASE WHEN excluded.source='CURATED' THEN excluded.stage ELSE stage END,
      confidence=CASE WHEN excluded.source='CURATED' THEN excluded.confidence ELSE confidence END,
      version=excluded.version,lastConfirmedAt=MAX(lastConfirmedAt,excluded.lastConfirmedAt),updatedAt=MAX(updatedAt,excluded.updatedAt)
      WHERE excluded.version>=version`,
    knowledgeId(`${id}:alias:${value}`), id, value, curated ? "CURATED" : retailerMetadata ? "RETAILER_METADATA" : "INFERRED", curated ? 1 : retailerMetadata ? 0.8 : 0.6, curated ? "TRUSTED" : "PROVISIONAL", KNOWLEDGE_VERSION, now, now, now));
  };
  if (c.op === "knowledge.seed") {
    statements.push(q(`UPDATE cartiva_product_aliases SET stage='RETIRED',updatedAt=? WHERE source='CURATED' AND version<?`, now, KNOWLEDGE_VERSION));
    statements.push(q(`UPDATE cartiva_product_relationships SET stage='RETIRED',updatedAt=? WHERE source='CURATED' AND version<?`, now, KNOWLEDGE_VERSION));
    for (const rule of CURATED_CONCEPTS) {
      const id = knowledgeId(rule.canonical);
      concept(id, rule.canonical, rule.category, [], true);
      for (const value of [rule.canonical, ...rule.aliases]) alias(id, normalizeKnowledgeText(value), true);
    }
    for (const [a, b] of CURATED_CONTRADICTIONS) for (const [from, to] of [[a, b], [b, a]]) {
      statements.push(q(`INSERT INTO cartiva_product_relationships
        (id,fromConcept,toConcept,kind,source,confidence,stage,version,createdAt,updatedAt,lastConfirmedAt)
        VALUES (?,?,?,'CONTRADICTORY','CURATED',1,'TRUSTED',?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        stage=excluded.stage,version=excluded.version,updatedAt=excluded.updatedAt,lastConfirmedAt=excluded.lastConfirmedAt WHERE excluded.version>=version`,
      knowledgeId(`contradiction:${from}:${to}`), knowledgeId(from), knowledgeId(to), KNOWLEDGE_VERSION, now, now, now));
    }
    for (const [category, rules] of Object.entries(CATEGORY_RULES)) {
      statements.push(q(`INSERT INTO cartiva_category_semantics (category,rules,source,version,updatedAt)
        VALUES (?,?,'CURATED',?,?) ON CONFLICT(category) DO UPDATE SET rules=excluded.rules,version=excluded.version,updatedAt=excluded.updatedAt`, category, JSON.stringify(rules), KNOWLEDGE_VERSION, now));
    }
  } else {
    // Retain bounded historical evidence, not an ever-growing permanent offer
    // cache. Product identities, approved taxonomy and query memory remain.
    statements.push(q(`DELETE FROM cartiva_match_observations WHERE id IN
      (SELECT id FROM cartiva_match_observations WHERE expiresAt<? LIMIT 200)`, now - 90 * 86400000));
    for (const r of c.records) {
      // Even a signed server command cannot promote an arbitrary curated claim.
      const curated = CURATED_CONCEPTS.some(x => x.canonical === r.concept.canonical && x.category === r.concept.category);
      if (r.concept.id !== knowledgeId(r.concept.canonical) || r.checkedAt > now + 60000 || r.checkedAt < now - OFFER_TTL_MS) continue;
      concept(r.concept.id, r.concept.canonical, r.concept.category, r.concept.attributes, curated);
      alias(r.concept.id, r.concept.alias, curated && CURATED_CONCEPTS.some(x => x.canonical === r.concept.canonical && [x.canonical, ...x.aliases].map(normalizeKnowledgeText).includes(r.concept.alias)));
      const p = r.product;
      if (p) {
        const retailerWording = normalizeKnowledgeText(stripDiscoveryPackageTerms(p.title));
        if (safeKnowledgePhrase(retailerWording) && retailerWording !== r.concept.alias) alias(r.concept.id, retailerWording, false, true);
      }
      const productId = p ? knowledgeId(`kroger:${p.upc}:${r.concept.id}`) : "";
      if (p) statements.push(q(`INSERT INTO cartiva_retailer_products
        (id,retailer,upc,conceptId,title,brand,package,source,version,createdAt,lastObservedAt)
        VALUES (?,'kroger',?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,brand=excluded.brand,package=excluded.package,lastObservedAt=excluded.lastObservedAt,version=excluded.version
        WHERE excluded.lastObservedAt>=lastObservedAt AND excluded.version>=version`, productId, p.upc, r.concept.id, p.title, p.brand, p.package, r.source, KNOWLEDGE_VERSION, now, r.checkedAt));
      for (const attempt of r.queries) {
        const eventId = knowledgeId(`${r.id}:${attempt.query}`);
        statements.push(q(`INSERT INTO cartiva_match_observations
          (id,conceptId,productId,query,outcome,source,checkedAt,store,fulfillment,price,availability,expiresAt,packageSolution,version)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, eventId, r.concept.id, attempt.success ? productId : "", attempt.query,
        attempt.success ? "VERIFIED" : "NO_USEFUL_MATCH", r.source, r.checkedAt, r.store, r.fulfillment, attempt.success ? r.price : null,
        attempt.success ? r.availability : "UNKNOWN", r.checkedAt + OFFER_TTL_MS, JSON.stringify({ packageQuantity: r.packageQuantity, package: p?.package ?? "" }), KNOWLEDGE_VERSION));
        statements.push(q(`INSERT INTO cartiva_search_query_memory
          (id,conceptId,retailer,query,successes,failures,quality,stage,source,version,createdAt,updatedAt,lastConfirmedAt)
          SELECT ?,?,'kroger',?,SUM(outcome='VERIFIED'),SUM(outcome<>'VERIFIED'),
          1.0*SUM(outcome='VERIFIED')/COUNT(*),CASE WHEN SUM(outcome='VERIFIED')>0 THEN 'TRUSTED' ELSE 'PROVISIONAL' END,
          ?,?,?,?,COALESCE(MAX(CASE WHEN outcome='VERIFIED' THEN checkedAt END),0)
          FROM cartiva_match_observations WHERE conceptId=? AND query=? AND version=? AND checkedAt>?
          ON CONFLICT(id) DO UPDATE SET successes=excluded.successes,failures=excluded.failures,quality=excluded.quality,
          stage=excluded.stage,updatedAt=excluded.updatedAt,lastConfirmedAt=excluded.lastConfirmedAt,version=excluded.version WHERE excluded.version>=version`,
        knowledgeId(`query:${r.concept.id}:${attempt.query}`), r.concept.id, attempt.query, r.source, KNOWLEDGE_VERSION, now, now, r.concept.id, attempt.query, KNOWLEDGE_VERSION, now - 90 * 86400000));
      }
    }
  }
  // D1 transaction limits: bounded chunks. All operations are idempotent and
  // never make old offer evidence authoritative if a later chunk fails.
  for (let i = 0; i < statements.length; i += 60) await db.batch(statements.slice(i, i + 60));
  return { recorded: true };
}
