import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

// Identity and evidence are deliberately separate from expiring retailer offers.
export const productConcepts = sqliteTable("cartiva_product_concepts", {
  id: text().primaryKey(), canonical: text().notNull(), category: text().notNull(),
  attributes: text().notNull(), source: text().notNull(), confidence: real().notNull(),
  stage: text().notNull(), version: integer().notNull(), createdAt: integer().notNull(),
  updatedAt: integer().notNull(), lastConfirmedAt: integer().notNull(),
});
export const productAliases = sqliteTable("cartiva_product_aliases", {
  id: text().primaryKey(), conceptId: text().notNull(), alias: text().notNull(),
  source: text().notNull(), confidence: real().notNull(), stage: text().notNull(),
  version: integer().notNull(), createdAt: integer().notNull(), updatedAt: integer().notNull(),
  lastConfirmedAt: integer().notNull(),
}, t => [index("cartiva_alias_concept").on(t.conceptId)]);
export const productRelationships = sqliteTable("cartiva_product_relationships", {
  id: text().primaryKey(), fromConcept: text().notNull(), toConcept: text().notNull(),
  kind: text().notNull(), source: text().notNull(), confidence: real().notNull(),
  stage: text().notNull(), version: integer().notNull(), createdAt: integer().notNull(),
  updatedAt: integer().notNull(), lastConfirmedAt: integer().notNull(),
}, t => [index("cartiva_relationship_from").on(t.fromConcept)]);
export const categorySemantics = sqliteTable("cartiva_category_semantics", {
  category: text().primaryKey(), rules: text().notNull(), source: text().notNull(),
  version: integer().notNull(), updatedAt: integer().notNull(),
});
export const retailerProducts = sqliteTable("cartiva_retailer_products", {
  id: text().primaryKey(), retailer: text().notNull(), upc: text().notNull(),
  conceptId: text().notNull(), title: text().notNull(), brand: text().notNull(),
  package: text().notNull(), source: text().notNull(), version: integer().notNull(),
  createdAt: integer().notNull(), lastObservedAt: integer().notNull(),
}, t => [index("cartiva_product_concept").on(t.conceptId)]);
export const searchQueryMemory = sqliteTable("cartiva_search_query_memory", {
  id: text().primaryKey(), conceptId: text().notNull(), retailer: text().notNull(), query: text().notNull(),
  successes: integer().notNull(), failures: integer().notNull(), quality: real().notNull(),
  stage: text().notNull(), source: text().notNull(), version: integer().notNull(),
  createdAt: integer().notNull(), updatedAt: integer().notNull(), lastConfirmedAt: integer().notNull(),
}, t => [index("cartiva_query_concept").on(t.conceptId)]);
export const matchObservations = sqliteTable("cartiva_match_observations", {
  id: text().primaryKey(), conceptId: text().notNull(), productId: text().notNull(), query: text().notNull(),
  outcome: text().notNull(), source: text().notNull(), checkedAt: integer().notNull(),
  store: text().notNull(), fulfillment: text().notNull(),
  price: real(), availability: text().notNull(), expiresAt: integer().notNull(),
  // Package solution is evidence only; current quantity is always recalculated.
  packageSolution: text().notNull(), version: integer().notNull(),
}, t => [index("cartiva_observation_expiry").on(t.expiresAt), index("cartiva_observation_query").on(t.conceptId, t.query, t.version, t.checkedAt)]);
export const matchCorrections = sqliteTable("cartiva_match_corrections", {
  id: text().primaryKey(), conceptId: text().notNull(), rejectedUpc: text().notNull(),
  acceptedUpc: text().notNull(), kind: text().notNull(), source: text().notNull(),
  stage: text().notNull(), confidence: real().notNull(), version: integer().notNull(),
  createdAt: integer().notNull(),
}, t => [index("cartiva_correction_concept").on(t.conceptId)]);
