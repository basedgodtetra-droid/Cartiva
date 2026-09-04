import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const cartiva100 = JSON.parse(readFileSync(path.join(root, "tests/fixtures/cartiva-100.json"), "utf8"));
const catalog100 = JSON.parse(readFileSync(path.join(root, "tests/fixtures/cartiva-100-catalog.json"), "utf8"));

const groups = [
  { key: "A", level: 1, sourceLevel: 5, title: "Generic groceries" },
  { key: "B", level: 2, sourceLevel: 2, title: "Generic groceries with quantity" },
  { key: "C", level: 3, sourceLevel: 3, title: "Vague attributes and shopping purpose" },
  { key: "D", level: 4, sourceLevel: 4, title: "Messy human input" },
  { key: "E", level: 5, sourceLevel: 1, title: "Planner and recipe-style requirements" },
];

const tagMap = {
  PARSING: "PARSING",
  ITEM_BOUNDARY: "ITEM_BOUNDARY",
  TYPO_NORMALIZATION: "TYPO",
  PRODUCT_IDENTITY: "PRODUCT_IDENTITY",
  ALIAS: "ALIAS",
  BRAND: "PRODUCT_IDENTITY",
  VARIANT: "ATTRIBUTE_EXTRACTION",
  ATTRIBUTE_EXTRACTION: "ATTRIBUTE_EXTRACTION",
  QUANTITY_SEMANTICS: "QUANTITY",
  PACKAGE_SIZE: "PACKAGE",
  MULTI_PACKAGE_FULFILLMENT: "MULTI_PACKAGE",
  UNIT_CONVERSION: "UNIT_CONVERSION",
  CATEGORY_CLASSIFICATION: "CATEGORY",
  PRODUCE: "CATEGORY",
  SEAFOOD: "CATEGORY",
  SEARCH_QUERY: "SEARCH_TOO_LITERAL",
  SEARCH_TOO_LITERAL: "SEARCH_TOO_LITERAL",
  CANDIDATE_RETRIEVAL: "CANDIDATE_RETRIEVAL",
  CANDIDATE_RANKING: "RANKING",
  CONFIDENCE_THRESHOLD: "CONFIDENCE",
  AVAILABILITY: "AVAILABILITY",
  CLARIFICATION: "CLARIFICATION",
  SUBSTITUTION: "RECOVERY",
  UNKNOWN: "OTHER",
};

const requestVariants = {
  A: [
    (input) => `need ${input}`,
    (input) => `please get ${input}`,
    (input) => `could you pick up ${input}`,
    (input) => `we would like ${input}`,
  ],
  B: [
    (input) => `need ${input}`,
    (input) => `please buy ${input}`,
    (input) => `could you get ${input}`,
    (input) => `we need ${input}`,
  ],
  C: [
    (input) => `I want ${input}`,
    (input) => `please get ${input}`,
    (input) => `could you pick up ${input}`,
    (input) => `we would like ${input}`,
  ],
  D: [
    (input) => `need ${input}`,
    (input) => `please get ${input}`,
    (input) => `could you buy ${input}`,
    (input) => `we need ${input}`,
  ],
  E: [
    (input) => `recipe needs ${input}`,
    (input) => `meal plan needs ${input}`,
    (input) => `for meal prep: ${input}`,
    (input) => `shopping list: ${input}`,
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mappedTags(tags, group) {
  return [...new Set([
    ...(tags ?? []).map((tag) => tagMap[tag] ?? "OTHER"),
    group === "A" ? "GENERIC_INTENT" : undefined,
    group === "B" || group === "E" ? "QUANTITY" : undefined,
    group === "C" ? "ATTRIBUTE_EXTRACTION" : undefined,
    group === "D" ? "TYPO" : undefined,
  ].filter(Boolean))];
}

const cases = [];
const additionalLiveRegressionIds = new Set(["C100-L1-004", "C100-L1-019"]);
for (const group of groups) {
  const seeds = cartiva100.cases.filter((testCase) => testCase.level === group.sourceLevel);
  if (seeds.length !== 20) throw new Error(`Expected 20 CARTIVA 100 seeds for group ${group.key}.`);

  for (const seed of seeds) {
    cases.push({
      ...clone(seed),
      level: group.level,
      group: group.key,
      regressionId: seed.id,
      tags: mappedTags(seed.tags, group.key),
      liveKroger: Boolean(seed.liveKroger || additionalLiveRegressionIds.has(seed.id)),
    });
  }

  let generatedIndex = 1;
  for (const seed of seeds) {
    for (const variant of requestVariants[group.key]) {
      cases.push({
        id: `C500-${group.key}-${String(generatedIndex).padStart(3, "0")}`,
        level: group.level,
        group: group.key,
        input: variant(seed.input),
        tags: mappedTags(seed.tags, group.key),
        expectedItems: clone(seed.expectedItems),
      });
      generatedIndex += 1;
    }
  }
}

function expectedFrom(input) {
  const found = cartiva100.cases.find((testCase) => testCase.input === input);
  if (!found) throw new Error(`Missing CARTIVA 100 oracle seed: ${input}`);
  return clone(found.expectedItems);
}

function replaceCase(id, value) {
  const index = cases.findIndex((testCase) => testCase.id === id);
  if (index < 0) throw new Error(`Missing generated case ${id}.`);
  cases[index] = { ...cases[index], ...value };
}

// These named cases keep the benchmark anchored to ordinary shopper wording,
// not only mechanically varied catalog requests.
replaceCase("C500-C-001", { input: "lean beef", tags: ["GENERIC_INTENT", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"], expectedItems: expectedFrom("beef") });
replaceCase("C500-C-002", { input: "healthy cereal", tags: ["GENERIC_INTENT", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"], expectedItems: expectedFrom("cereal") });
replaceCase("C500-C-003", { input: "low calorie yogurt", tags: ["GENERIC_INTENT", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"], expectedItems: expectedFrom("yogurt") });
replaceCase("C500-C-004", { input: "good sandwich bread", tags: ["GENERIC_INTENT", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"], expectedItems: expectedFrom("bread") });
replaceCase("C500-C-005", { input: "chicken for tacos", tags: ["GENERIC_INTENT", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"], expectedItems: expectedFrom("chicken") });
replaceCase("C500-C-006", { input: "meat for burgers", tags: ["GENERIC_INTENT", "CATEGORY", "CLARIFICATION"], expectedItems: expectedFrom("ground meat") });
replaceCase("C500-C-007", { input: "fish for dinner", tags: ["GENERIC_INTENT", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"], expectedItems: expectedFrom("fish") });
replaceCase("C500-C-008", { input: "cheap rice", tags: ["GENERIC_INTENT", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"], expectedItems: expectedFrom("rice") });
replaceCase("C500-C-009", { input: "cheese for tacos", tags: ["GENERIC_INTENT", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"], expectedItems: expectedFrom("cheese") });

replaceCase("C500-D-001", { input: "chiken", tags: ["TYPO", "GENERIC_INTENT", "CLARIFICATION"], expectedItems: expectedFrom("chicken") });
replaceCase("C500-D-002", { input: "ground turky", tags: ["TYPO", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"], expectedItems: [{ policy: "clarification", clarificationPath: [{ id: "ground-turkey-ratio", select: "any", minOptions: 4 }] }] });
replaceCase("C500-D-003", { input: "cok zero", tags: ["TYPO", "ALIAS", "PRODUCT_IDENTITY"], expectedItems: expectedFrom("Coke Zero") });
replaceCase("C500-D-004", { input: "greek yogrt", tags: ["TYPO", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"], expectedItems: expectedFrom("greek yogrt") });

replaceCase("C500-E-001", {
  input: "chicken breast 4 lb",
  tags: ["QUANTITY", "MULTI_PACKAGE", "ATTRIBUTE_EXTRACTION", "CLARIFICATION"],
  expectedItems: [{ ...expectedFrom("chicken breast 2 lb")[0], cartQuantity: 4, packageCount: 4 }],
});
replaceCase("C500-E-002", {
  input: "kidney beans 6 cans",
  tags: ["QUANTITY", "MULTI_PACKAGE", "PACKAGE"],
  expectedItems: [{ ...expectedFrom("kidney beans 4 cans")[0], cartQuantity: 6, packageCount: 6 }],
});
replaceCase("C500-E-003", {
  input: "onions 5",
  tags: ["QUANTITY", "MULTI_PACKAGE", "CATEGORY"],
  expectedItems: [{ policy: "automatic", allowedProductIds: ["onions-each"], candidateIds: ["apples-each", "onions-each"], cartQuantity: 5, packageCount: 5, query: { includes: ["onions"], excludes: ["5"] } }],
});
replaceCase("C500-E-004", {
  input: "ground turkey 93/7 3 lb",
  tags: ["QUANTITY", "MULTI_PACKAGE", "ATTRIBUTE_EXTRACTION"],
  expectedItems: [{ policy: "automatic", allowedProductIds: ["ground-turkey-93-1lb"], candidateIds: ["ground-beef-93-1lb", "ground-turkey-93-1lb"], cartQuantity: 3, packageCount: 3, query: { includes: ["ground", "turkey"], excludes: ["3", "lb"] } }],
});
replaceCase("C500-E-005", {
  input: "red lentil pasta 2 lb",
  tags: ["QUANTITY", "MULTI_PACKAGE", "UNIT_CONVERSION", "PRODUCT_IDENTITY"],
  expectedItems: [{ policy: "automatic", allowedProductIds: ["red-lentil-pasta-12"], candidateIds: ["pasta-spaghetti-16", "red-lentil-pasta-12"], cartQuantity: 3, packageCount: 3, query: { includes: ["red", "lentil", "pasta"], excludes: ["2", "lb"] } }],
});
replaceCase("C500-E-006", {
  input: "tomatoes 8 cans",
  tags: ["QUANTITY", "MULTI_PACKAGE", "PACKAGE", "CATEGORY"],
  expectedItems: [{ ...expectedFrom("diced tomatoes 8 cans")[0], query: { includes: ["tomatoes"], excludes: ["8", "cans"] } }],
});
replaceCase("C500-E-007", {
  input: "light coconut milk 3 cans",
  tags: ["QUANTITY", "MULTI_PACKAGE", "PACKAGE", "ATTRIBUTE_EXTRACTION"],
  expectedItems: [{ ...expectedFrom("light coconut milk 2 cans")[0], cartQuantity: 3, packageCount: 3 }],
});

// Verified shopper failures are appended permanently. The original 500 cases
// and their five balanced groups remain intact.
cases.push({
  id: "C500-R-001",
  level: 4,
  group: "D",
  input: "Ground beef, 93/7, 1 lb",
  tags: ["ITEM_FRAGMENT_ATTACHMENT", "ORPHAN_MODIFIER", "ATTRIBUTE_EXTRACTION"],
  expectedItems: expectedFrom("93/7 ground beef 1 lb"),
});
cases.push({
  id: "C500-R-002",
  level: 4,
  group: "D",
  input: "Bananas, 6",
  tags: ["ITEM_FRAGMENT_ATTACHMENT", "ORPHAN_MODIFIER", "QUANTITY"],
  expectedItems: expectedFrom("6 bananas"),
});

const counts = Object.fromEntries(groups.map((group) => [
  group.key,
  cases.filter((testCase) => testCase.group === group.key).length,
]));
if (cases.length !== 502
  || counts.A !== 100
  || counts.B !== 100
  || counts.C !== 100
  || counts.D !== 102
  || counts.E !== 100) {
  throw new Error(`CARTIVA 500 distribution is invalid: ${JSON.stringify(counts)}`);
}

const fixture = {
  schemaVersion: 1,
  suite: {
    id: "cartiva-500",
    title: "CARTIVA 500 normal-human grocery reliability benchmark",
    scoringPolicy: "shopper-outcome-v1",
    oracleRevision: 2,
    groups: Object.fromEntries(groups.map((group) => [group.key, group.title])),
    requiredPerLevel: { "1": 100, "2": 100, "3": 100, "4": 100, "5": 100 },
    targets: { score2Or3Percent: 95, atLeast1Percent: 99, deadEndPercentExclusive: 0.1 },
    maintenance: "Never delete a hard case. Add verified shopper failures to this suite or its successor.",
  },
  cases,
};

const extraProducts = [
  {
    id: "onions-each", title: "Fresh Yellow Onion", productType: "Produce", priceCents: 89,
    size: { amount: 1, unit: "count", kind: "count", baseAmount: 1, baseUnit: "each", label: "1 count" },
    facts: { product: "onions", container: "each" },
  },
  {
    id: "red-lentil-pasta-12", title: "Barilla Red Lentil Penne Pasta Box", brand: "Barilla", productType: "Pasta", priceCents: 349,
    size: { amount: 12, unit: "oz", kind: "weight", baseAmount: 12, baseUnit: "oz", label: "12 oz" },
    facts: { product: "red lentil pasta", variant: "penne", container: "box" },
  },
];
const catalog = { ...catalog100, suite: "cartiva-500", products: [...catalog100.products, ...extraProducts] };

writeFileSync(path.join(root, "tests/fixtures/cartiva-500.json"), `${JSON.stringify(fixture, null, 2)}\n`);
writeFileSync(path.join(root, "tests/fixtures/cartiva-500-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);

console.log(`Generated CARTIVA 500: ${cases.length} cases (${Object.entries(counts).map(([key, count]) => `${key}=${count}`).join(", ")}).`);
