import catalogSource from "@/tests/fixtures/cartiva-100-catalog.json";
import fixtureSource from "@/tests/fixtures/cartiva-100.json";
import { createHash } from "node:crypto";

import { rankKrogerProducts } from "@/lib/kroger-products";
import {
  isPlausibleDiscoveryCandidate,
  parseProductIntent,
  retrieveCandidatesProgressively,
} from "@/lib/product-search-intent";
import type { KrogerProduct, Measurement } from "@/lib/types";
import { isRetailerHandoffAcceptedMatch } from "@/packages/shared/src/comparison-session";
import {
  interpretGroceryInput,
  resolveGroceryClarification,
  type GroceryNotepadItem,
} from "@/packages/shared/src/grocery-notepad";

export const CARTIVA_100_SCORING_POLICY = "shopper-outcome-v1" as const;
export const CARTIVA_100_ORACLE_REVISION = 2 as const;
export const CARTIVA_100_FINGERPRINT_ALGORITHM = "recursive-key-sort-json-sha256-v1" as const;

export type Cartiva100Score = 0 | 1 | 2 | 3;

export type Cartiva100FailureCategory =
  | "PARSING"
  | "ITEM_BOUNDARY"
  | "TYPO_NORMALIZATION"
  | "PRODUCT_IDENTITY"
  | "ALIAS"
  | "BRAND"
  | "VARIANT"
  | "ATTRIBUTE_EXTRACTION"
  | "QUANTITY_SEMANTICS"
  | "PACKAGE_SIZE"
  | "MULTI_PACKAGE_FULFILLMENT"
  | "UNIT_CONVERSION"
  | "CATEGORY_CLASSIFICATION"
  | "SEARCH_QUERY"
  | "SEARCH_TOO_LITERAL"
  | "CANDIDATE_RETRIEVAL"
  | "CANDIDATE_RANKING"
  | "CONFIDENCE_THRESHOLD"
  | "AVAILABILITY"
  | "RETAILER_METADATA"
  | "CLARIFICATION"
  | "SUBSTITUTION"
  | "UNKNOWN";

interface QueryExpectation {
  includes: string[];
  excludes: string[];
}

export interface ClarificationStep {
  id: string;
  select: string;
  minOptions: number;
}

interface ExpectedItem {
  policy: "automatic" | "clarification";
  clarificationPath?: ClarificationStep[];
  allowedProductIds?: string[];
  candidateIds?: string[];
  cartQuantity?: number;
  packageCount?: number;
  query?: QueryExpectation;
}

interface Cartiva100Case {
  id: string;
  level: 1 | 2 | 3 | 4 | 5;
  input: string;
  tags: Cartiva100FailureCategory[];
  liveKroger?: boolean;
  expectedItems: ExpectedItem[];
}

interface Cartiva100Fixture {
  schemaVersion: 1;
  suite: {
    id: "cartiva-100";
    title: string;
    scoringPolicy: typeof CARTIVA_100_SCORING_POLICY;
    requiredPerLevel: Record<"1" | "2" | "3" | "4" | "5", number>;
    targets: {
      score2Or3Percent: number;
      atLeast1Percent: number;
      deadEndPercentExclusive: number;
    };
  };
  cases: Cartiva100Case[];
}

interface CatalogProduct {
  id: string;
  title: string;
  brand?: string;
  productType?: string;
  priceCents: number;
  size?: Measurement;
  facts: {
    product: string;
    variant?: string;
    container?: string;
  };
}

interface CatalogFixture {
  schemaVersion: 1;
  location: { id: string; name: string; postalCode: string };
  products: CatalogProduct[];
}

export interface Cartiva100ItemOutcome {
  score: Cartiva100Score;
  deadEnd: boolean;
  category?: Cartiva100FailureCategory;
  reason: string;
  parseMs: number;
  matchMs: number;
  searchAttempts: number;
  unsafeSelection: boolean;
}

export interface Cartiva100CaseOutcome {
  id: string;
  level: Cartiva100Case["level"];
  input: string;
  score: Cartiva100Score;
  deadEnd: boolean;
  unsafeSelection: boolean;
  category?: Cartiva100FailureCategory;
  reason: string;
  itemOutcomes: Cartiva100ItemOutcome[];
}

export interface Cartiva100Report {
  suiteId: string;
  scoringPolicy: typeof CARTIVA_100_SCORING_POLICY;
  total: number;
  scoreCounts: Record<Cartiva100Score, number>;
  score2Or3Percent: number;
  atLeast1Percent: number;
  deadEndPercent: number;
  unsafeSelectionCount: number;
  stableOutcomeSha256: string;
  targetMet: boolean;
  levels: Record<1 | 2 | 3 | 4 | 5, {
    useful: number;
    score2Or3: number;
    total: number;
  }>;
  failureCategories: Partial<Record<Cartiva100FailureCategory, number>>;
  performance: {
    averageParsingMs: number;
    averageLocalMatchingMs: number;
    averageSearchAttempts: number;
    retailerCalls: 0;
  };
  cases: Cartiva100CaseOutcome[];
}

const fixture = fixtureSource as Cartiva100Fixture;
const catalog = catalogSource as CatalogFixture;
const catalogById = new Map(catalog.products.map((product) => [product.id, product]));

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalizeJson(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalizeJson((value as Record<string, unknown>)[key])]),
    );
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  throw new TypeError("Cartiva 100 fingerprints require JSON-compatible values.");
}

function canonicalJsonSha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalizeJson(value)), "utf8").digest("hex");
}

export function cartiva100FixtureFingerprints() {
  const requestCorpus = fixture.cases.map((testCase) => ({
    id: testCase.id,
    level: testCase.level,
    input: testCase.input,
    tags: testCase.tags,
    liveKroger: Boolean(testCase.liveKroger),
  }));
  const oracle = fixture.cases.map((testCase) => ({
    id: testCase.id,
    expectedItems: testCase.expectedItems,
  }));
  return {
    algorithm: CARTIVA_100_FINGERPRINT_ALGORITHM,
    oracleRevision: CARTIVA_100_ORACLE_REVISION,
    requestCorpusSha256: canonicalJsonSha256(requestCorpus),
    oracleSha256: canonicalJsonSha256(oracle),
  };
}

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function primaryFailureCategory(testCase: Cartiva100Case) {
  const priority: Cartiva100FailureCategory[] = [
    "ITEM_BOUNDARY",
    "PARSING",
    "TYPO_NORMALIZATION",
    "QUANTITY_SEMANTICS",
    "PACKAGE_SIZE",
    "MULTI_PACKAGE_FULFILLMENT",
    "UNIT_CONVERSION",
    "CLARIFICATION",
    "BRAND",
    "VARIANT",
    "ATTRIBUTE_EXTRACTION",
    "CATEGORY_CLASSIFICATION",
    "ALIAS",
    "PRODUCT_IDENTITY",
  ];
  return priority.find((category) => testCase.tags.includes(category)) ?? "UNKNOWN";
}

function hydrateProduct(source: CatalogProduct): KrogerProduct {
  const checkedAt = "2026-09-02T00:00:00.000Z";
  return {
    retailer: "kroger",
    id: source.id,
    productId: source.id,
    upc: source.id.replace(/[^a-z0-9]/gi, "").padEnd(13, "0").slice(0, 13),
    title: source.title,
    price: source.priceCents / 100,
    priceCents: source.priceCents,
    link: `https://www.kroger.com/p/${source.id}`,
    sourceUrl: `fixture://cartiva-100/${source.id}`,
    brand: source.brand,
    productType: source.productType,
    inStock: true,
    availabilityStatus: "in_stock",
    sponsored: false,
    size: source.size,
    checkedAt,
    verification: "verified",
    priceProvenance: {
      retailer: "kroger",
      priceSource: "kroger_location_product",
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified: true,
      locationId: catalog.location.id,
      locationName: catalog.location.name,
      location: {
        requestedStoreId: catalog.location.id,
        observedStoreId: catalog.location.id,
        requestedPostalCode: catalog.location.postalCode,
        observedPostalCode: catalog.location.postalCode,
        responseProvesLocation: true,
        storeMatched: true,
        postalCodeMatched: true,
      },
      fulfillment: ["pickup"],
      checkedAt,
    },
    dataSource: "kroger_public_api",
    identityVerified: true,
    cartEligible: true,
  };
}

function seededOrder<T>(values: T[], seed: number) {
  return [...values].sort((left, right) => {
    const leftIndex = values.indexOf(left);
    const rightIndex = values.indexOf(right);
    const leftKey = Math.imul(leftIndex + 1, 1103515245) ^ seed;
    const rightKey = Math.imul(rightIndex + 1, 1103515245) ^ seed;
    return leftKey - rightKey;
  });
}

function candidateVariants(products: KrogerProduct[], allowedIds: Set<string>, seed: number) {
  const adversarial = products.map((product) => {
    const priceCents = allowedIds.has(product.id) ? 99999 : 1;
    return {
      ...product,
      price: priceCents / 100,
      priceCents,
      priceProvenance: {
        ...product.priceProvenance,
        regularPriceCents: priceCents,
      },
    };
  });
  return [
    { name: "normal", products },
    { name: "reversed", products: [...products].reverse() },
    { name: "seeded", products: seededOrder(products, seed) },
    { name: "adversarial-price", products: seededOrder(adversarial, seed + 17) },
  ];
}

function validateFixture() {
  if (fixture.schemaVersion !== 1 || fixture.suite.id !== "cartiva-100") {
    throw new Error("Cartiva 100 fixture schema is not supported.");
  }
  if (fixture.suite.scoringPolicy !== CARTIVA_100_SCORING_POLICY) {
    throw new Error("Cartiva 100 scoring policy does not match the runner.");
  }
  if (fixture.cases.length < 100) {
    throw new Error(`Cartiva 100 must retain at least its 100 original cases; found ${fixture.cases.length}.`);
  }
  const ids = new Set<string>();
  const normalizedInputs = new Map<string, string>();
  for (const testCase of fixture.cases) {
    if (ids.has(testCase.id)) throw new Error(`Duplicate Cartiva 100 id: ${testCase.id}`);
    ids.add(testCase.id);
    const inputKey = normalize(testCase.input);
    const policyKey = testCase.expectedItems.map((item) => item.policy).join(",");
    const priorPolicy = normalizedInputs.get(inputKey);
    if (priorPolicy && priorPolicy !== policyKey) {
      throw new Error(`Conflicting policies for duplicate input: ${testCase.input}`);
    }
    normalizedInputs.set(inputKey, policyKey);
    for (const expected of testCase.expectedItems) {
      for (const id of expected.candidateIds ?? []) {
        if (!catalogById.has(id)) throw new Error(`${testCase.id} references missing candidate ${id}.`);
      }
      for (const id of expected.allowedProductIds ?? []) {
        if (!catalogById.has(id)) throw new Error(`${testCase.id} references missing allowed product ${id}.`);
      }
      if (expected.policy === "automatic") {
        const candidates = expected.candidateIds ?? [];
        const allowed = new Set(expected.allowedProductIds ?? []);
        if (!candidates.some((id) => allowed.has(id))) {
          throw new Error(`${testCase.id} has no oracle-valid candidate.`);
        }
        if (!candidates.some((id) => !allowed.has(id))) {
          throw new Error(`${testCase.id} needs at least one confusable negative candidate.`);
        }
      }
    }
  }
  for (const level of [1, 2, 3, 4, 5] as const) {
    const count = fixture.cases.filter((testCase) => testCase.level === level).length;
    const required = fixture.suite.requiredPerLevel[String(level) as "1" | "2" | "3" | "4" | "5"];
    if (count < required) {
      throw new Error(`Cartiva 100 level ${level} must retain at least ${required} cases; found ${count}.`);
    }
  }
}

function outcome(
  score: Cartiva100Score,
  reason: string,
  options: Partial<Omit<Cartiva100ItemOutcome, "score" | "reason">> = {},
): Cartiva100ItemOutcome {
  return {
    score,
    reason,
    deadEnd: options.deadEnd ?? false,
    category: options.category,
    parseMs: options.parseMs ?? 0,
    matchMs: options.matchMs ?? 0,
    searchAttempts: options.searchAttempts ?? 0,
    unsafeSelection: options.unsafeSelection ?? false,
  };
}

function queryIssue(expected: ExpectedItem, queries: string[]) {
  if (!expected.query) return undefined;
  const normalizedQueries = queries.map(normalize);
  const missing = expected.query.includes.filter((term) => (
    !normalizedQueries.some((query) => ` ${query} `.includes(` ${normalize(term)} `))
  ));
  if (missing.length) {
    return { category: "SEARCH_QUERY" as const, reason: `Discovery omitted ${missing.join(", ")}.` };
  }
  const leaked = expected.query.excludes.filter((term) => (
    normalizedQueries.some((query) => ` ${query} `.includes(` ${normalize(term)} `))
  ));
  if (leaked.length) {
    return { category: "SEARCH_TOO_LITERAL" as const, reason: `Discovery leaked package/cart terms: ${leaked.join(", ")}.` };
  }
  return undefined;
}

function resolveClarificationPath(
  initial: GroceryNotepadItem,
  expected: ExpectedItem,
  parseMs: number,
) {
  let raw = initial.raw;
  const path = expected.clarificationPath ?? [];
  if (!path.length) {
    return {
      failed: outcome(0, "Expected a declared clarification path.", {
        category: "CLARIFICATION",
        deadEnd: true,
        parseMs,
      }),
    };
  }
  for (const step of path) {
    const interpreted = interpretGroceryInput(raw);
    const item = interpreted.items[0];
    const clarification = item?.clarification;
    if (!item || interpreted.items.length !== 1 || clarification?.id !== step.id) {
      return {
        failed: outcome(0, `Expected clarification ${step.id}, received ${clarification?.id ?? "none"}.`, {
          category: "CLARIFICATION",
          deadEnd: true,
          parseMs,
        }),
      };
    }
    if (clarification.options.length < step.minOptions) {
      return {
        failed: outcome(0, `${step.id} offered too few one-tap choices.`, {
          category: "CLARIFICATION",
          deadEnd: true,
          parseMs,
        }),
      };
    }
    const selected = clarification.options.find((option) => option.value === step.select);
    if (!selected) {
      return {
        failed: outcome(0, `${step.id} did not offer the expected ${step.select} choice.`, {
          category: "CLARIFICATION",
          deadEnd: true,
          parseMs,
        }),
      };
    }
    const resolved = resolveGroceryClarification(raw, step.id, step.select).raw;
    if (normalize(resolved) === normalize(raw)) {
      return {
        failed: outcome(0, `${step.id} did not change the shopper intent.`, {
          category: "CLARIFICATION",
          deadEnd: true,
          parseMs,
        }),
      };
    }
    const next = interpretGroceryInput(resolved).items[0];
    if (next?.clarification?.id === step.id) {
      return {
        failed: outcome(0, `${step.id} repeated after the shopper answered it.`, {
          category: "CLARIFICATION",
          deadEnd: true,
          parseMs,
        }),
      };
    }
    raw = resolved;
  }
  const final = interpretGroceryInput(raw);
  if (final.items.length !== 1 || final.items[0].status !== "ready") {
    return {
      failed: outcome(0, `Clarification path did not reach a ready item; next is ${final.items[0]?.clarification?.id ?? "unknown"}.`, {
        category: "CLARIFICATION",
        deadEnd: true,
        parseMs,
      }),
    };
  }
  return { item: final.items[0] };
}

async function automaticOutcome(
  item: GroceryNotepadItem,
  expected: ExpectedItem,
  testCase: Cartiva100Case,
  parseMs: number,
  scoreCap: Cartiva100Score = 3,
) {
  const intent = parseProductIntent(item.canonicalText);
  const queries = intent.discoveryQueries.map((query) => query.query);
  const issue = queryIssue(expected, queries);
  if (issue) {
    return outcome(0, issue.reason, { category: issue.category, deadEnd: true, parseMs });
  }

  const allowedIds = new Set(expected.allowedProductIds ?? []);
  const products = (expected.candidateIds ?? []).map((id) => hydrateProduct(catalogById.get(id)!));
  const variants = candidateVariants(products, allowedIds, Number(testCase.id.replace(/\D/g, "")) || 1);
  const variantOutcomes: Cartiva100ItemOutcome[] = [];

  for (const variant of variants) {
    const matchStarted = performance.now();
    let latest = rankKrogerProducts(item.canonicalText, [], [], undefined, { intent });
    const discovered = await retrieveCandidatesProgressively({
      intent,
      search: async (_query, level) => {
        const stage = Math.max(0, intent.discoveryQueries.findIndex((query) => query.level === level));
        const fraction = (stage + 1) / intent.discoveryQueries.length;
        return variant.products.slice(0, Math.max(1, Math.ceil(variant.products.length * fraction)));
      },
      hasVerifiedMatch: (candidates) => {
        latest = rankKrogerProducts(item.canonicalText, candidates, [], undefined, { intent });
        return isRetailerHandoffAcceptedMatch(latest);
      },
      isPlausible: (candidate) => isPlausibleDiscoveryCandidate(intent, candidate),
      candidateKey: (candidate) => candidate.id,
    });
    latest = rankKrogerProducts(item.canonicalText, discovered.candidates, [], undefined, { intent });
    const matchMs = performance.now() - matchStarted;
    const baseOptions = {
      parseMs,
      matchMs,
      searchAttempts: discovered.attempts.length,
    };
    if (discovered.attempts.length > 3) {
      variantOutcomes.push(outcome(0, `${variant.name} exceeded the three-search bound.`, {
        ...baseOptions,
        category: "SEARCH_QUERY",
        deadEnd: true,
      }));
      continue;
    }
    if (latest.recommended && !allowedIds.has(latest.recommended.id)) {
      variantOutcomes.push(outcome(0, `${variant.name} selected unsafe product ${latest.recommended.id}.`, {
        ...baseOptions,
        category: primaryFailureCategory(testCase),
        deadEnd: false,
        unsafeSelection: true,
      }));
      continue;
    }
    if (!latest.recommended) {
      const validAlternative = latest.alternatives.some((candidate) => allowedIds.has(candidate.id));
      if (validAlternative) {
        variantOutcomes.push(outcome(1, `${variant.name} exposed a valid review alternative.`, {
          ...baseOptions,
          category: "CONFIDENCE_THRESHOLD",
        }));
      } else {
        variantOutcomes.push(outcome(0, `${variant.name} could not produce a safe result or recovery.`, {
          ...baseOptions,
          category: primaryFailureCategory(testCase),
          deadEnd: true,
        }));
      }
      continue;
    }
    if (expected.cartQuantity !== undefined && latest.fulfillment?.cartQuantity !== expected.cartQuantity) {
      variantOutcomes.push(outcome(0, `${variant.name} produced cart quantity ${latest.fulfillment?.cartQuantity ?? "none"}; expected ${expected.cartQuantity}.`, {
        ...baseOptions,
        category: "QUANTITY_SEMANTICS",
        deadEnd: false,
      }));
      continue;
    }
    if (expected.packageCount !== undefined && latest.fulfillment?.packageCount !== expected.packageCount) {
      variantOutcomes.push(outcome(0, `${variant.name} produced ${latest.fulfillment?.packageCount ?? "no"} packages; expected ${expected.packageCount}.`, {
        ...baseOptions,
        category: expected.packageCount > 1 ? "MULTI_PACKAGE_FULFILLMENT" : "PACKAGE_SIZE",
        deadEnd: false,
      }));
      continue;
    }
    if (latest.resolution === "matched_check_availability" || latest.status === "review") {
      variantOutcomes.push(outcome(1, `${variant.name} found the right identity but still requires a safe review.`, {
        ...baseOptions,
        category: "AVAILABILITY",
      }));
      continue;
    }
    variantOutcomes.push(outcome(scoreCap, `${variant.name} produced the oracle-valid product and fulfillment.`, baseOptions));
  }

  return variantOutcomes.sort((left, right) => (
    left.score - right.score || Number(right.deadEnd) - Number(left.deadEnd)
  ))[0];
}

async function runItem(
  item: GroceryNotepadItem,
  expected: ExpectedItem,
  testCase: Cartiva100Case,
  parseMs: number,
) {
  if (expected.policy === "clarification") {
    const resolved = resolveClarificationPath(item, expected, parseMs);
    if (resolved.failed) return resolved.failed;
    if (!expected.allowedProductIds?.length) {
      return outcome(2, "Asked the expected one-tap clarification and did not repeat it.", { parseMs });
    }
    return automaticOutcome(resolved.item!, expected, testCase, parseMs, 2);
  }

  if (item.clarification) {
    const useful = item.clarification.options.length >= 2;
    return outcome(useful ? 1 : 0, `Unexpected clarification: ${item.clarification.id}.`, {
      category: "CLARIFICATION",
      deadEnd: !useful,
      parseMs,
    });
  }
  return automaticOutcome(item, expected, testCase, parseMs);
}

async function runCase(testCase: Cartiva100Case): Promise<Cartiva100CaseOutcome> {
  const parseStarted = performance.now();
  const interpreted = interpretGroceryInput(testCase.input);
  const parseMs = performance.now() - parseStarted;
  if (!interpreted.items.length) {
    const failed = outcome(0, "Input produced no grocery item.", {
      category: "PARSING",
      deadEnd: true,
      unsafeSelection: false,
      parseMs,
    });
    return {
      id: testCase.id,
      level: testCase.level,
      input: testCase.input,
      score: 0,
      deadEnd: true,
      unsafeSelection: false,
      category: failed.category,
      reason: failed.reason,
      itemOutcomes: [failed],
    };
  }
  if (interpreted.items.length !== testCase.expectedItems.length) {
    const failed = outcome(0, `Parsed ${interpreted.items.length} items; expected ${testCase.expectedItems.length}.`, {
      category: "ITEM_BOUNDARY",
      deadEnd: true,
      parseMs,
    });
    return {
      id: testCase.id,
      level: testCase.level,
      input: testCase.input,
      score: 0,
      deadEnd: true,
      unsafeSelection: false,
      category: failed.category,
      reason: failed.reason,
      itemOutcomes: [failed],
    };
  }

  const itemOutcomes = await Promise.all(interpreted.items.map((item, index) => (
    runItem(item, testCase.expectedItems[index], testCase, parseMs / interpreted.items.length)
  )));
  const worst = [...itemOutcomes].sort((left, right) => (
    left.score - right.score || Number(right.deadEnd) - Number(left.deadEnd)
  ))[0];
  return {
    id: testCase.id,
    level: testCase.level,
    input: testCase.input,
    score: worst.score,
    deadEnd: itemOutcomes.some((item) => item.deadEnd),
    unsafeSelection: itemOutcomes.some((item) => item.unsafeSelection),
    category: worst.category,
    reason: worst.reason,
    itemOutcomes,
  };
}

export async function runCartiva100(): Promise<Cartiva100Report> {
  validateFixture();
  const cases: Cartiva100CaseOutcome[] = [];
  for (const testCase of fixture.cases) cases.push(await runCase(testCase));

  const scoreCounts: Record<Cartiva100Score, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const levels = {
    1: { useful: 0, score2Or3: 0, total: 0 },
    2: { useful: 0, score2Or3: 0, total: 0 },
    3: { useful: 0, score2Or3: 0, total: 0 },
    4: { useful: 0, score2Or3: 0, total: 0 },
    5: { useful: 0, score2Or3: 0, total: 0 },
  } satisfies Cartiva100Report["levels"];
  const failureCategories: Cartiva100Report["failureCategories"] = {};
  let parseTotal = 0;
  let matchTotal = 0;
  let searchAttempts = 0;
  let itemCount = 0;
  for (const testCase of cases) {
    scoreCounts[testCase.score] += 1;
    levels[testCase.level].total += 1;
    if (testCase.score >= 1) levels[testCase.level].useful += 1;
    if (testCase.score >= 2) levels[testCase.level].score2Or3 += 1;
    if (testCase.score <= 1 && testCase.category) {
      failureCategories[testCase.category] = (failureCategories[testCase.category] ?? 0) + 1;
    }
    for (const item of testCase.itemOutcomes) {
      parseTotal += item.parseMs;
      matchTotal += item.matchMs;
      searchAttempts += item.searchAttempts;
      itemCount += 1;
    }
  }
  const total = cases.length;
  const score2Or3Percent = round(((scoreCounts[2] + scoreCounts[3]) / total) * 100, 1);
  const atLeast1Percent = round(((total - scoreCounts[0]) / total) * 100, 1);
  const deadEndPercent = round((cases.filter((testCase) => testCase.deadEnd).length / total) * 100, 1);
  const unsafeSelectionCount = cases.filter((testCase) => testCase.unsafeSelection).length;
  const stableOutcomeSha256 = createHash("sha256").update(JSON.stringify(cases.map((testCase) => ({
    id: testCase.id,
    score: testCase.score,
    deadEnd: testCase.deadEnd,
    unsafeSelection: testCase.unsafeSelection,
    category: testCase.category,
    itemOutcomes: testCase.itemOutcomes.map((item) => ({
      score: item.score,
      deadEnd: item.deadEnd,
      unsafeSelection: item.unsafeSelection,
      category: item.category,
      reason: item.reason,
      searchAttempts: item.searchAttempts,
    })),
  })))).digest("hex");
  const targets = fixture.suite.targets;
  return {
    suiteId: fixture.suite.id,
    scoringPolicy: CARTIVA_100_SCORING_POLICY,
    total,
    scoreCounts,
    score2Or3Percent,
    atLeast1Percent,
    deadEndPercent,
    unsafeSelectionCount,
    stableOutcomeSha256,
    targetMet: score2Or3Percent >= targets.score2Or3Percent
      && atLeast1Percent >= targets.atLeast1Percent
      && deadEndPercent < targets.deadEndPercentExclusive
      && unsafeSelectionCount === 0,
    levels,
    failureCategories,
    performance: {
      averageParsingMs: round(parseTotal / Math.max(itemCount, 1), 3),
      averageLocalMatchingMs: round(matchTotal / Math.max(itemCount, 1), 3),
      averageSearchAttempts: round(searchAttempts / Math.max(itemCount, 1), 2),
      retailerCalls: 0,
    },
    cases,
  };
}

export function formatCartiva100Report(report: Cartiva100Report) {
  const lines = [
    "",
    "CARTIVA 100",
    "",
    `Score 3: ${report.scoreCounts[3]}`,
    `Score 2: ${report.scoreCounts[2]}`,
    `Score 1: ${report.scoreCounts[1]}`,
    `Score 0: ${report.scoreCounts[0]}`,
    "",
    `2 OR 3: ${report.score2Or3Percent}%`,
    `AT LEAST 1: ${report.atLeast1Percent}%`,
    `DEAD END: ${report.deadEndPercent}%`,
    `UNSAFE AUTOMATIC SELECTIONS: ${report.unsafeSelectionCount}`,
    "",
    ...([1, 2, 3, 4, 5] as const).map((level) => (
      `LEVEL ${level}: ${report.levels[level].useful} / ${report.levels[level].total} useful · ${report.levels[level].score2Or3} / ${report.levels[level].total} score 2+`
    )),
    "",
    "FAILURE SUMMARY",
    ...Object.entries(report.failureCategories)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([category, count]) => `${category}: ${count}`),
    "",
    `PERFORMANCE: parse ${report.performance.averageParsingMs} ms avg · local match ${report.performance.averageLocalMatchingMs} ms avg · ${report.performance.averageSearchAttempts} search attempts avg · ${report.performance.retailerCalls} retailer calls`,
    "",
    `TARGET: ${report.targetMet ? "MET" : "NOT MET"}`,
  ];
  const unresolved = report.cases.filter((testCase) => testCase.score <= 1);
  if (unresolved.length) {
    lines.push("", "SCORE 0 OR 1 CASES");
    for (const testCase of unresolved) {
      lines.push(`${testCase.id} [${testCase.category ?? "UNKNOWN"}] ${testCase.input} — ${testCase.reason}`);
    }
  }
  return lines.join("\n");
}

export function cartiva100FixtureSummary() {
  validateFixture();
  return {
    caseCount: fixture.cases.length,
    levelCounts: Object.fromEntries([1, 2, 3, 4, 5].map((level) => [
      level,
      fixture.cases.filter((testCase) => testCase.level === level).length,
    ])),
    liveKrogerCaseIds: fixture.cases.filter((testCase) => testCase.liveKroger).map((testCase) => testCase.id),
  };
}

export function cartiva100LiveCases() {
  validateFixture();
  return fixture.cases
    .filter((testCase) => testCase.liveKroger)
    .map((testCase) => ({
      id: testCase.id,
      input: testCase.input,
      clarificationPath: testCase.expectedItems[0]?.clarificationPath ?? [],
      expectedCartQuantity: testCase.expectedItems[0]?.cartQuantity,
      expectedPackageCount: testCase.expectedItems[0]?.packageCount,
    }));
}
