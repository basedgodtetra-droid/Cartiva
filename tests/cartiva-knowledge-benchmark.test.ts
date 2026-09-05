import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixtures from "./fixtures/cartiva-knowledge.json";
import { knowledgeDatabase } from "./support/knowledge-database";
import { knowledgeCatalogProduct } from "./support/knowledge-catalog";
import { executeSharedCommand } from "@/lib/kroger-shared-sql";
import { conceptForIntent } from "@/lib/knowledge/foundations";
import { discoverWithKnowledge, learningForResult } from "@/lib/knowledge/pipeline";
import { parseProductIntent, isPlausibleDiscoveryCandidate } from "@/lib/product-search-intent";
import { rankKrogerProducts } from "@/lib/kroger-products";
import { isRetailerHandoffAcceptedMatch } from "@/packages/shared/src";
import type { KnowledgeContext } from "@/lib/knowledge/protocol";
import type { KrogerProduct } from "@/lib/types";

describe("CARTIVA KNOWLEDGE cold/warm persistent benchmark", () => {
  it("reduces actual query-string calls after a database restart without stale offers or wrong products", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cartiva-knowledge-benchmark-"));
    const path = join(directory, "knowledge.sqlite");
    let storage = knowledgeDatabase(path);
    const oracle = new Map<string, string[]>();
    for (const c of fixtures.cases) oracle.set(c.query, [...(oracle.get(c.query) ?? []), c.product]);
    const reports: { run: string; searchCalls: number; productCalls: number; matches: number; clarifications: number; latencyMs: number; cases: number }[] = [];
    try {
      for (const warm of [false, true]) {
        const report = { run: warm ? "B: WARM AFTER RESTART" : "A: COLD", searchCalls: 0, productCalls: 0, matches: 0, clarifications: 0, latencyMs: 0, cases: fixtures.cases.length };
        if (warm) { storage.close(); storage = knowledgeDatabase(path); }
        for (const c of fixtures.cases) {
          const started = performance.now();
          const intent = parseProductIntent(c.input);
          const concept = conceptForIntent(intent);
          expect(concept, `safe concept ${c.input}`).not.toBeNull();
          const [memory] = await executeSharedCommand(storage.db, { op: "knowledge.lookup", keys: [concept!.id] }) as KnowledgeContext[];
          const verify = (products: KrogerProduct[]) => rankKrogerProducts(intent.verificationText, products, intent.constraints, undefined, { intent });
          const discovery = await discoverWithKnowledge({ intent, memory,
            search: async query => {
              report.searchCalls++;
              return (oracle.get(query) ?? []).map(id => knowledgeCatalogProduct(id, { priceIncrease: warm ? 101 : 0 }));
            }, verify, plausible: p => isPlausibleDiscoveryCandidate(intent, p),
            refreshIdentity: async () => { report.productCalls++; return null; },
          });
          const result = verify(discovery.candidates);
          report.latencyMs += performance.now() - started;
          if (isRetailerHandoffAcceptedMatch(result)) report.matches++; else report.clarifications++;
          expect(result.recommended?.upc, `${report.run}: ${c.input}: ${result.explanation}`).toBe(knowledgeCatalogProduct(c.product).upc);
          expect(isRetailerHandoffAcceptedMatch(result), `${c.input}: ${result.explanation}`).toBe(true);
          expect(result.fulfillment?.cartQuantity ?? intent.requestedCartQuantity).toBe(c.quantity);
          expect(result.recommended?.price).toBe(knowledgeCatalogProduct(c.product, { priceIncrease: warm ? 101 : 0 }).price);
          const record = learningForResult({ intent, result, attempts: discovery.attempts, queryOrigins: discovery.queryOrigins,
            locationId: "03500529", fulfillment: "pickup", source: "FIXTURE" });
          expect(record).not.toBeNull();
          await executeSharedCommand(storage.db, { op: "knowledge.learn", records: [record!] });
        }
        report.latencyMs = Number((report.latencyMs / report.cases).toFixed(2));
        reports.push(report);
      }
      process.stdout.write("CARTIVA KNOWLEDGE — deterministic query oracle; zero live retailer requests\n" + JSON.stringify(reports, null, 2) + "\n");
      expect(reports[0].matches).toBe(15); expect(reports[1].matches).toBe(15);
      expect(reports[1].searchCalls).toBeLessThan(reports[0].searchCalls);
      expect(reports[1].searchCalls).toBe(15);
      expect(reports.every(r => r.productCalls === 0 && r.clarifications === 0)).toBe(true);
    } finally { storage.close(); rmSync(directory, { recursive: true }); }
  });

  it("stale proven query never removes the cold plan's final recovery query", async () => {
    const intent = parseProductIntent("Coke Zero 12 pack");
    const calls: string[] = [];
    const verify = (products: KrogerProduct[]) => rankKrogerProducts(intent.verificationText, products, intent.constraints, undefined, { intent });
    const result = await discoverWithKnowledge({ intent, verify, plausible: p => isPlausibleDiscoveryCandidate(intent, p),
      memory: { conceptId: conceptForIntent(intent)!.id, aliases: [], products: [], relationships: [],
        queries: [{ query: "Coca Cola Zero Sugar", successes: 1, failures: 0, quality: 1, lastConfirmedAt: Date.now() }] },
      search: async query => { calls.push(query); return query === "Coca-Cola Soda" ? [knowledgeCatalogProduct("coke-zero-12")] : []; },
    });
    expect(calls).toEqual(["Coca Cola Zero Sugar", "Coke Zero", "Coca-Cola Soda"]);
    expect(isRetailerHandoffAcceptedMatch(verify(result.candidates))).toBe(true);
  });

  it("refreshes one remembered UPC in the new store and recalculates current quantity", async () => {
    const intent = parseProductIntent("ground beef 93/7 2 lb");
    const identity = knowledgeCatalogProduct("ground-beef-93-1lb");
    const fresh = knowledgeCatalogProduct("ground-beef-93-1lb", { priceIncrease: 200, store: "01400912", fulfillment: "delivery" });
    const verify = (products: KrogerProduct[]) => rankKrogerProducts(intent.verificationText, products, intent.constraints, undefined, { intent });
    let detailCalls = 0;
    const discovery = await discoverWithKnowledge({ intent, verify, plausible: p => isPlausibleDiscoveryCandidate(intent, p), search: async () => [],
      memory: { conceptId: conceptForIntent(intent)!.id, aliases: [], queries: [], relationships: [], products: [{
        upc: identity.upc, title: identity.title, brand: identity.brand!, package: "1 lb", lastObservedAt: Date.now() - 86400000,
      }] },
      refreshIdentity: async upc => { detailCalls++; expect(upc).toBe(identity.upc); return fresh; },
    });
    const result = verify(discovery.candidates);
    expect(detailCalls).toBe(1); expect(discovery.attempts.length).toBeLessThanOrEqual(3);
    expect(result.fulfillment?.cartQuantity).toBe(2);
    expect(result.recommended?.price).toBe(fresh.price);
    expect(result.recommended?.priceProvenance.locationId).toBe("01400912");
    expect(result.recommended?.priceProvenance.fulfillment).toEqual(["delivery"]);
    expect(discovery.queryOrigins.size).toBe(0); // Detail success cannot credit a failed search query.
  });

  it.each(["missing", "out_of_stock", "wrong_upc"])("historical UPC %s yields recovery, never stale success", async failure => {
    const intent = parseProductIntent("2% milk 1 gallon");
    const p = knowledgeCatalogProduct("milk-2pct-gallon");
    const verify = (products: KrogerProduct[]) => rankKrogerProducts(intent.verificationText, products, intent.constraints, undefined, { intent });
    const discovery = await discoverWithKnowledge({ intent, verify, plausible: product => isPlausibleDiscoveryCandidate(intent, product), search: async () => [],
      memory: { conceptId: conceptForIntent(intent)!.id, aliases: [], queries: [], relationships: [], products: [{ upc: p.upc, title: p.title, brand: p.brand!, package: "1 gal", lastObservedAt: Date.now() }] },
      refreshIdentity: async () => failure === "missing" ? null : failure === "out_of_stock" ? knowledgeCatalogProduct("milk-2pct-gallon", { outOfStock: true }) : knowledgeCatalogProduct("milk-whole-gallon"),
    });
    expect(discovery.detailCalls).toBe(1);
    expect(isRetailerHandoffAcceptedMatch(verify(discovery.candidates))).toBe(false);
  });

  it.each([
    ["2% milk 1 gallon", "milk-whole-gallon"], ["Coke Zero 12 pack", "diet-coke-12"],
    ["Ground beef 93/7 3 lb", "ground-beef-80-1lb"], ["Light coconut milk 3 cans", "coconut-regular-can"],
  ])("memory cannot override explicit intent: %s", async (input, wrong) => {
    const intent = parseProductIntent(input);
    const verify = (products: KrogerProduct[]) => rankKrogerProducts(intent.verificationText, products, intent.constraints, undefined, { intent });
    const discovery = await discoverWithKnowledge({ intent, verify, plausible: p => isPlausibleDiscoveryCandidate(intent, p),
      search: async () => [knowledgeCatalogProduct(wrong)],
      memory: { conceptId: conceptForIntent(intent)!.id, aliases: [], products: [], relationships: [], queries: [{ query: "milk", successes: 100, failures: 0, quality: 1, lastConfirmedAt: Date.now() }] },
    });
    expect(isRetailerHandoffAcceptedMatch(verify(discovery.candidates))).toBe(false);
  });
});
