import {
  extractMeasurement,
  extractPackOnlyCount,
  normalizeMeasurementFractions,
} from "./measurements";
import { parseRetailerPackageQuantity } from "@/packages/shared/src";
import {
  COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE,
  COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE,
  COUNTED_CONTENT_UNIT_PATTERN_SOURCE,
  OUTER_CONTAINER_UNIT_PATTERN_SOURCE,
} from "@/packages/shared/src/package-grammar";
import {
  assessProduceForm,
  assessProductFamily,
  assessProductVariant,
  extractRequestedBrand,
  inferProductCategory,
  missingRequestedDescriptors,
  productMatchesRequestedBrand,
  productTypeMatchesRequest,
  stripFlexibleProteinPreferences,
} from "./product-knowledge";
import {
  analyzeProductFacets,
  productConstraintIssues,
  type ProductConstraint,
  type StructuredProductRequest,
} from "./product-facets";
import type { RetailProductCore, WalmartProduct } from "./types";

export type DiscoveryLevel = "normalized" | "simplified" | "broader";

export interface DiscoveryQuery {
  level: DiscoveryLevel;
  query: string;
}

export interface ProductIntent {
  originalText: string;
  verificationText: string;
  fulfillmentText: string;
  displayName: string;
  category?: StructuredProductRequest["category"];
  categoryLabel?: string;
  brand?: string;
  brandRequired: boolean;
  constraints: ProductConstraint[];
  packageConstraints: ProductConstraint[];
  identityConstraints: ProductConstraint[];
  requestedPackageLabel?: string;
  requestedTotal?: ReturnType<typeof extractMeasurement>;
  requestedCartQuantity: number;
  requestedContainer?: string;
  requestedCountUnit?: string;
  strictPackageRequest: boolean;
  discoveryQueries: DiscoveryQuery[];
}

export interface DiscoveryAttempt {
  level: DiscoveryLevel;
  query: string;
  returnedCount: number;
  pooledCount: number;
  outcome:
    | "verified"
    | "sufficient_candidates"
    | "plausible_candidates"
    | "broadened"
    | "exhausted";
}

export interface CandidateDiscoveryResult<T> {
  candidates: T[];
  attempts: DiscoveryAttempt[];
}

const PACKAGE_ATTRIBUTES = new Set([
  "bagSize",
  "bottleSize",
  "boxSize",
  "containerFormat",
  "containerSize",
  "count",
  "loafSize",
  "packCount",
  "packageSize",
  "packageType",
  "quantity",
  "weightRange",
]);

export function isPackageConstraint(constraint: ProductConstraint) {
  return PACKAGE_ATTRIBUTES.has(constraint.attribute);
}

const SEARCH_FILLER = new Set([
  "a", "an", "and", "available", "buy", "cheapest", "for", "get", "need",
  "please", "the", "want", "with",
]);

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/%/g, " percent ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(value: string, phrase: string) {
  return ` ${normalize(value)} `.includes(` ${normalize(phrase)} `);
}

function cleanQuery(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[’]/g, "'")
    .replace(/[^a-zA-Z0-9%'+.-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,.;:\s-]+|[,.;:\s-]+$/g, "")
    .trim();
}

/**
 * Remove package syntax only from retailer discovery. The unchanged request is
 * retained on ProductIntent and remains the source of truth for verification.
 * Product nouns are not globally removed, so "trash bags" and "can opener"
 * keep their identity when no numeric package expression qualifies them.
 */
export function stripDiscoveryPackageTerms(value: string) {
  const normalizedValue = normalizeMeasurementFractions(value);
  const parsedQuantity = parseRetailerPackageQuantity(normalizedValue);
  let text = (explicitAggregateMeasurementMatch(normalizedValue)
    ? normalizedValue
    : parsedQuantity.searchText)
    .normalize("NFKC")
    .replace(/^\s*\d{1,2}\s*[x×]\s+(?=\S)/i, " ")
    .replace(new RegExp(`\\b\\d+(?:\\.\\d+)?${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}(?:${OUTER_CONTAINER_UNIT_PATTERN_SOURCE})\\b(?=[\\s\\S]*\\btotal\\b\\s*$)`, "gi"), " ")
    .replace(/\b\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|gallons?|gal|quarts?|qt|pints?|pt|liters?|litres?|milliliters?|millilitres?|ml|l)\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?[\s-]*(?:pack|pk|count|ct)\b(?:\s+of)?(?:\s+(?:bags?|bottles?|boxes?|canisters?|cans?|cartons?|containers?|jars?|packages?|pouch(?:es)?|trays?|tubs?))?/gi, " ")
    .replace(new RegExp(`\\b\\d+(?:\\.\\d+)?${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(?:${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b`, "gi"), " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|gallons?|gal|quarts?|qt|pints?|pt|liters?|litres?|milliliters?|millilitres?|ml|l)\b(?:\s+(?:bags?|bottles?|boxes?|cans?|cartons?|containers?|jars?|packages?|pouch(?:es)?|trays?|tubs?))?/gi, " ")
    .replace(/\b(?:half(?:[ -]a)?|one|a)?\s*gallons?\b/gi, " ")
    .replace(/\b(?:one|a)\s+dozen\b/gi, " ")
    .replace(/\b(?:family|party|snack|regular)\s+size\b/gi, " ");
  text = cleanQuery(text);
  return text;
}

const FLEXIBLE_RAW_WEIGHT_CATEGORY = new Set([
  "beef",
  "chicken",
  "chicken breast",
  "ground beef",
  "meat",
  "pork",
  "seafood",
  "turkey",
]);

// A bare product word such as the cereal brand "Total" is identity, not an
// aggregate request. Accept "total" only in an unmistakable amount phrase or
// at the end of the request; the other variants are semantically explicit.
const EXPLICIT_TOTAL_SIGNAL = /\b(?:desired\s+total|totaling|altogether|in\s+total|a\s+total\s+of)\b|\btotal\b(?=\s*(?:$|[.,;])|\s+[x×]\s*\d+\b)/i;
const PREPACKAGED_WEIGHT_SIGNAL = /\b(?:bacon|sausage|deli|smoked|frozen|canned|dried|pickled|jarred|steam(?:able|[ -]?in[ -]?bag))\b/i;
const TRAILING_TOTAL_MEASUREMENT = new RegExp(
  `\\b(\\d+(?:\\.\\d+)?)\\s*(fl\\s*oz|fluid\\s+ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|liters?|litres?|milliliters?|millilitres?|gallons?|gal|quarts?|qt|pints?|pt|ml|l|count|ct|each|${COUNTED_CONTENT_UNIT_PATTERN_SOURCE}|${OUTER_CONTAINER_UNIT_PATTERN_SOURCE})\\b[\\s,;:-]+(?:(?:in\\s+)?total|altogether)(?:\\s+please)?\\s*[.,;]?\\s*$`,
  "i",
);
const PREFIXED_TOTAL_MEASUREMENT = new RegExp(
  `\\b(?:desired\\s+total|totaling|a\\s+total\\s+of)\\s+(\\d+(?:\\.\\d+)?)\\s*(fl\\s*oz|fluid\\s+ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|liters?|litres?|milliliters?|millilitres?|gallons?|gal|quarts?|qt|pints?|pt|ml|l|count|ct|each|${COUNTED_CONTENT_UNIT_PATTERN_SOURCE}|${OUTER_CONTAINER_UNIT_PATTERN_SOURCE})\\b`,
  "i",
);

function explicitAggregateMeasurementMatch(value: string) {
  return value.match(TRAILING_TOTAL_MEASUREMENT)
    ?? value.match(PREFIXED_TOTAL_MEASUREMENT);
}

function explicitTrailingTotalMeasurement(value: string) {
  const match = explicitAggregateMeasurementMatch(value);
  if (!match) return undefined;
  const countUnit = new RegExp(
    `^(?:count|ct|each|${COUNTED_CONTENT_UNIT_PATTERN_SOURCE}|${OUTER_CONTAINER_UNIT_PATTERN_SOURCE})$`,
    "i",
  ).test(match[2]);
  return extractMeasurement(countUnit
    ? `${match[1]} count`
    : `${match[1]} ${match[2]}`);
}

const REQUESTED_CONTAINER_ALIASES: Record<string, string> = {
  bag: "bag",
  bags: "bag",
  bottle: "bottle",
  bottles: "bottle",
  box: "box",
  boxes: "box",
  bunch: "bunch",
  bunches: "bunch",
  can: "can",
  canned: "can",
  cans: "can",
  carton: "carton",
  cartons: "carton",
  canister: "canister",
  canisters: "canister",
  container: "container",
  containers: "container",
  each: "each",
  jar: "jar",
  jars: "jar",
  loaf: "loaf",
  loaves: "loaf",
  "mini-can": "can",
  "mini-cans": "can",
  pouch: "pouch",
  pouches: "pouch",
  tray: "tray",
  trays: "tray",
  tub: "tub",
  tubs: "tub",
};

const REQUESTED_COUNT_UNIT_ALIASES: Record<string, string> = {
  bar: "bar",
  bars: "bar",
  blade: "blade",
  blades: "blade",
  pac: "pac",
  pacs: "pac",
  piece: "piece",
  pieces: "piece",
  pod: "pod",
  pods: "pod",
  roll: "roll",
  rolls: "roll",
  sheet: "sheet",
  sheets: "sheet",
  wipe: "wipe",
  wipes: "wipe",
};

function normalizeRequestedContainer(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\s*\d+(?:\.\d+)?\s+/, "")
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return REQUESTED_CONTAINER_ALIASES[normalized];
}

function normalizeRequestedCountUnit(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return REQUESTED_COUNT_UNIT_ALIASES[normalized];
}

function requestedContainerFor(
  value: string,
  packageSizeText: string | undefined,
  measurement: ReturnType<typeof extractMeasurement>,
  constraints: ProductConstraint[],
) {
  const parsedPackageContainer = normalizeRequestedContainer(packageSizeText);
  if (parsedPackageContainer) return parsedPackageContainer;

  const aggregateContainer = normalizeRequestedContainer(
    explicitAggregateMeasurementMatch(value)?.[2],
  );
  if (aggregateContainer) return aggregateContainer;

  const totalContainerMatches = /\btotal\b\s*$/i.test(value)
    ? [...value.matchAll(new RegExp(
        `\\b\\d+(?:\\.\\d+)?${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}(${OUTER_CONTAINER_UNIT_PATTERN_SOURCE})\\b`,
        "gi",
      ))]
    : [];
  const totalContainer = normalizeRequestedContainer(totalContainerMatches.at(-1)?.[1]);
  if (totalContainer) return totalContainer;

  // A package word directly following an explicit measurement is shopper
  // intent, while an identity such as "can opener" must not become packaging.
  if (measurement) {
    const physicalContainerMatch = value.match(
      /\b\d+(?:\.\d+)?[\s-]*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|gallons?|gal|quarts?|qt|pints?|pt|liters?|litres?|milliliters?|millilitres?|ml|l|count|ct|pack|pk)(?:\s|,|\/|-)+(bags?|bottles?|box(?:es)?|bunch(?:es)?|canisters?|cans?|cartons?|containers?|each|jars?|loaf|loaves|pouch(?:es)?|trays?|tubs?)\b/i,
    );
    const countedContainerMatch = value.match(new RegExp(
      `\\b\\d+(?:\\.\\d+)?${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(?:${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})(?:\\s|,|/|-)+(bags?|bottles?|box(?:es)?|bunch(?:es)?|canisters?|cans?|cartons?|containers?|each|jars?|loaf|loaves|pouch(?:es)?|trays?|tubs?)\\b`,
      "i",
    ));
    const measuredContainerMatch = physicalContainerMatch ?? countedContainerMatch;
    const matchEnd = measuredContainerMatch?.index !== undefined
      ? measuredContainerMatch.index + measuredContainerMatch[0].length
      : 0;
    const accessoryTail = measuredContainerMatch
      ? /^\s+(?:opener|cutter|holder|rack|dispenser|brush|cleaner|liner|clip|labels?)\b/i.test(value.slice(matchEnd))
      : false;
    const normalizedMeasuredContainer = accessoryTail
      ? undefined
      : normalizeRequestedContainer(measuredContainerMatch?.[1]);
    if (normalizedMeasuredContainer) return normalizedMeasuredContainer;
  }

  const structuredContainer = constraints.find((constraint) => (
    constraint.attribute === "containerFormat" || constraint.attribute === "packageType"
  ));
  return normalizeRequestedContainer(structuredContainer?.value)
    ?? normalizeRequestedContainer(structuredContainer?.searchText);
}

function requestedCountUnitFor(
  value: string,
  measurement: ReturnType<typeof extractMeasurement>,
  constraints: ProductConstraint[],
) {
  if (!measurement) return undefined;
  const aggregateUnit = normalizeRequestedCountUnit(
    explicitAggregateMeasurementMatch(value)?.[2],
  );
  if (aggregateUnit) return aggregateUnit;
  const measuredUnitPattern = /\btotal\b\s*$/i.test(value)
    ? new RegExp(`\\b\\d+(?:\\.\\d+)?${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b\\s+total\\s*$`, "i")
    : new RegExp(`\\b\\d+(?:\\.\\d+)?${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b`, "i");
  const measuredUnit = normalizeRequestedCountUnit(value.match(measuredUnitPattern)?.[1]);
  if (measuredUnit) return measuredUnit;
  const structuredUnit = constraints.find((constraint) => (
    constraint.attribute === "containerFormat" || constraint.attribute === "packageType"
  ));
  return normalizeRequestedCountUnit(structuredUnit?.value)
    ?? normalizeRequestedCountUnit(structuredUnit?.searchText);
}

function isFlexibleMeasuredTotal(value: string, category: string | undefined) {
  if (EXPLICIT_TOTAL_SIGNAL.test(value)) return true;
  if (category && FLEXIBLE_RAW_WEIGHT_CATEGORY.has(category)) {
    return !PREPACKAGED_WEIGHT_SIGNAL.test(value);
  }
  if (category === "produce") {
    // Unpackaged produce weights normally describe the amount the shopper
    // needs. Frozen, canned, dried, and other packaged forms remain exact
    // shelf-size requests unless the shopper explicitly says "total".
    return !PREPACKAGED_WEIGHT_SIGNAL.test(value);
  }
  // Retained compatibility for the original reported red-lentil-pasta
  // aggregate regression. New planner and recipe requests carry an explicit
  // `total` marker, but saved/direct requests using the old wording must keep
  // their verified multi-package behavior.
  return /\bred\s+lentil\s+pasta\b/i.test(value);
}

function strictPackageRequest(
  value: string,
  measurement: ReturnType<typeof extractMeasurement>,
  category: string | undefined,
) {
  if (extractPackOnlyCount(value) !== undefined || measurement?.packCount) return true;
  // "Total" describes the amount the shopper needs across one or more
  // packages. It overrides a plain count (for example, 21 eggs) but not an
  // explicit multipack such as a 24-pack or 24 × 12-ounce case.
  if (measurement && EXPLICIT_TOTAL_SIGNAL.test(value)) return false;
  if (measurement?.kind === "count") return true;
  if (!measurement) return false;
  if (/\b(?:package|pkg|box|bag|tub|tray|pouch|bottle|can|carton|container|jar|loaf)\b/i.test(value)) {
    return true;
  }
  // Explicit measurements are shelf-package requirements by default. Relax
  // only when wording identifies a desired total or a normal variable-weight
  // food, never merely because a pantry noun appears.
  return !isFlexibleMeasuredTotal(value, category);
}

function addDistinctQuery(
  queries: DiscoveryQuery[],
  level: DiscoveryLevel,
  value: string | undefined,
) {
  const query = cleanQuery(value ?? "");
  if (!query || query.length < 2) return;
  if (queries.some((candidate) => normalize(candidate.query) === normalize(query))) return;
  queries.push({ level, query });
}

function addPhrase(phrases: string[], value: string | undefined) {
  const phrase = cleanQuery(value ?? "");
  if (!phrase) return;
  if (phrases.some((existing) => containsPhrase(existing, phrase) || containsPhrase(phrase, existing))) {
    const existingIndex = phrases.findIndex((existing) => containsPhrase(phrase, existing));
    if (existingIndex >= 0 && normalize(phrase).length > normalize(phrases[existingIndex]).length) {
      phrases[existingIndex] = phrase;
    }
    return;
  }
  phrases.push(phrase);
}

function constraintIdentityQuery(request: StructuredProductRequest) {
  const phrases: string[] = [];
  const identityConstraints = request.constraints.filter(
    (constraint) => !PACKAGE_ATTRIBUTES.has(constraint.attribute),
  );
  for (const constraint of identityConstraints.filter((item) => item.attribute === "brand")) {
    addPhrase(phrases, constraint.searchText);
  }
  for (const constraint of identityConstraints.filter((item) => item.attribute !== "brand")) {
    // Retailer titles often omit "original" for the standard variety. Keep it
    // as a hard verification constraint without making discovery depend on it.
    if (constraint.attribute === "flavor" && constraint.value === "original") continue;
    addPhrase(phrases, constraint.searchText);
  }
  addPhrase(phrases, request.categoryLabel ?? request.category);
  return phrases.join(" ");
}

function simplifiedUnknownQuery(value: string) {
  return stripDiscoveryPackageTerms(stripFlexibleProteinPreferences(value))
    .replace(EXPLICIT_TOTAL_SIGNAL, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !SEARCH_FILLER.has(normalize(word)))
    .join(" ");
}

function broaderQuery(
  request: StructuredProductRequest,
  brand: string | undefined,
  inferredCategory: string | undefined,
) {
  const phrases: string[] = [];
  addPhrase(phrases, brand);
  addPhrase(phrases, request.categoryLabel ?? request.category ?? inferredCategory);
  if (request.category || inferredCategory) return phrases.join(" ");

  if (brand) {
    const brandWords = new Set(normalize(brand).split(/\s+/));
    const core = simplifiedUnknownQuery(request.text)
      .split(/\s+/)
      .filter((word) => !brandWords.has(normalize(word)))
      .join(" ");
    addPhrase(phrases, core);
    return phrases.join(" ");
  }

  const terms = simplifiedUnknownQuery(request.text)
    .split(/\s+/)
    .filter((word) => normalize(word).length >= 3);
  return terms.length > 4 ? terms.slice(-4).join(" ") : "";
}

function packageLabel(value: string) {
  const packOnly = extractPackOnlyCount(value);
  if (packOnly !== undefined) return `${packOnly}-pack`;
  const measurement = extractMeasurement(value);
  if (!measurement) return undefined;
  if (measurement.packCount && measurement.perPackageAmount) {
    return `${measurement.packCount}-pack of ${measurement.perPackageAmount} ${measurement.unit}`;
  }
  if (/\b(?:half(?:[ -]a)?\s+)?gallon\b/i.test(value)) {
    return measurement.baseAmount === 64 ? "half-gallon" : "1-gallon";
  }
  return measurement.label.replace(" × ", "-pack of ");
}

export function parseProductIntent(
  value: string,
  structuredRequest = analyzeProductFacets(value),
): ProductIntent {
  const normalizedValue = normalizeMeasurementFractions(value);
  const parsedQuantityIntent = parseRetailerPackageQuantity(normalizedValue);
  const quantityIntent = explicitAggregateMeasurementMatch(normalizedValue)
    ? {
        ...parsedQuantityIntent,
        quantity: 1,
        searchText: normalizedValue,
        packageSizeText: undefined,
      }
    : parsedQuantityIntent;
  const verificationText = quantityIntent.searchText.normalize("NFKC").replace(/\s+/g, " ").trim();
  // In shopper language, a terminal total is the requested aggregate. Bind it
  // to the immediately preceding amount instead of an earlier per-package
  // measurement. Catalog-title parsing intentionally keeps its own precedence.
  const measurement = explicitTrailingTotalMeasurement(verificationText)
    ?? extractMeasurement(verificationText);
  const requestedContainer = requestedContainerFor(
    verificationText,
    quantityIntent.packageSizeText,
    measurement,
    structuredRequest.constraints,
  );
  const requestedCountUnit = requestedCountUnitFor(
    verificationText,
    measurement,
    structuredRequest.constraints,
  );
  const inferredCategory = inferProductCategory(verificationText);
  const packageIsStrict = strictPackageRequest(
    verificationText,
    measurement,
    structuredRequest.category ?? inferredCategory,
  )
    || /\b(?:gallon|quart|pint)\b/i.test(quantityIntent.packageSizeText ?? "")
    || Boolean(measurement && structuredRequest.category === "bread");
  const requestedTotal = measurement && !packageIsStrict ? measurement : undefined;
  const fulfillmentText = requestedTotal
    ? stripDiscoveryPackageTerms(verificationText).replace(EXPLICIT_TOTAL_SIGNAL, " ").replace(/\s+/g, " ").trim()
    : verificationText;
  const requestedBrand = extractRequestedBrand(verificationText);
  const brandConstraint = structuredRequest.constraints.find((item) => item.attribute === "brand");
  const brand = requestedBrand?.canonical ?? brandConstraint?.label;
  const packageConstraints = structuredRequest.constraints.filter((item) => (
    PACKAGE_ATTRIBUTES.has(item.attribute)
  ));
  const identityConstraints = structuredRequest.constraints.filter((item) => (
    !PACKAGE_ATTRIBUTES.has(item.attribute)
  ));
  const normalizedQuery = stripDiscoveryPackageTerms(
    stripFlexibleProteinPreferences(verificationText),
  ).replace(requestedTotal ? EXPLICIT_TOTAL_SIGNAL : /$^/, " ").replace(/\s+/g, " ").trim();
  const queries: DiscoveryQuery[] = [];
  addDistinctQuery(queries, "normalized", normalizedQuery);
  addDistinctQuery(
    queries,
    "simplified",
    structuredRequest.category
      ? constraintIdentityQuery(structuredRequest)
      : simplifiedUnknownQuery(verificationText),
  );
  addDistinctQuery(
    queries,
    "broader",
    broaderQuery(structuredRequest, brand, inferredCategory),
  );
  if (!queries.length) addDistinctQuery(queries, "normalized", verificationText);

  return {
    originalText: value,
    verificationText,
    fulfillmentText,
    displayName: normalizedQuery || structuredRequest.categoryLabel || inferredCategory || "requested product",
    category: structuredRequest.category,
    categoryLabel: structuredRequest.categoryLabel ?? inferredCategory,
    brand,
    brandRequired: Boolean(brand),
    constraints: structuredRequest.constraints,
    packageConstraints,
    identityConstraints,
    requestedPackageLabel: packageIsStrict ? packageLabel(verificationText) : undefined,
    requestedTotal,
    requestedCartQuantity: quantityIntent.quantity,
    requestedContainer,
    requestedCountUnit,
    strictPackageRequest: packageIsStrict,
    discoveryQueries: queries.slice(0, 3),
  };
}

function stem(value: string) {
  if (value.length > 5 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && value.endsWith("es")) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

/**
 * Discovery compatibility ignores package, price, stock, and store evidence.
 * Those remain strict verification gates after a candidate has been found.
 */
export function isPlausibleDiscoveryCandidate(
  intent: ProductIntent,
  product: Pick<RetailProductCore, "title" | "brand" | "productType" | "size">,
) {
  const rankingProduct = product as WalmartProduct;
  if (!productTypeMatchesRequest(intent.verificationText, rankingProduct)) return false;

  const requestedBrand = extractRequestedBrand(intent.verificationText);
  if (requestedBrand && !productMatchesRequestedBrand(requestedBrand, rankingProduct)) {
    return false;
  }
  if (productConstraintIssues(product, intent.identityConstraints).length) return false;
  if (missingRequestedDescriptors(intent.verificationText, rankingProduct).length) return false;
  if (assessProduceForm(intent.verificationText, rankingProduct).rejected) return false;
  if (assessProductVariant(intent.verificationText, rankingProduct).rejected) return false;
  if (assessProductFamily(intent.verificationText, rankingProduct).rejected) return false;

  if (intent.category || intent.categoryLabel) return true;
  const requestedBrandWords = new Set(
    requestedBrand
      ? [requestedBrand.canonical, ...requestedBrand.aliases]
          .flatMap((item) => normalize(item).split(/\s+/))
      : [],
  );
  const requestTerms = normalize(stripDiscoveryPackageTerms(intent.verificationText))
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !SEARCH_FILLER.has(word))
    .filter((word) => !requestedBrandWords.has(word))
    .map(stem);
  const candidateTerms = new Set(
    normalize(`${product.brand ?? ""} ${product.productType ?? ""} ${product.title}`)
      .split(/\s+/)
      .map(stem),
  );
  return requestTerms.length
    ? requestTerms.some((word) => candidateTerms.has(word))
    : Boolean(requestedBrand);
}

function defaultCandidateKey(candidate: unknown, index: number) {
  if (candidate && typeof candidate === "object") {
    const value = candidate as Record<string, unknown>;
    for (const field of ["productId", "itemId", "upc", "id"]) {
      if (typeof value[field] === "string" && value[field]) return `${field}:${value[field]}`;
    }
    if (typeof value.title === "string") return `title:${normalize(value.title)}`;
  }
  return `candidate:${index}`;
}

export async function retrieveCandidatesProgressively<T>(options: {
  intent: ProductIntent;
  search(query: string, level: DiscoveryLevel): Promise<T[]>;
  hasVerifiedMatch(candidates: T[]): boolean;
  hasSufficientCandidate?(candidates: T[]): boolean;
  isPlausible(candidate: T): boolean;
  candidateKey?(candidate: T, index: number): string;
  maxSearches?: number;
  maxCandidates?: number;
}): Promise<CandidateDiscoveryResult<T>> {
  const maxSearches = Math.max(1, Math.min(options.maxSearches ?? 3, 3));
  const maxCandidates = Math.max(10, Math.min(options.maxCandidates ?? 60, 60));
  const pooled = new Map<string, T>();
  const attempts: DiscoveryAttempt[] = [];
  const queries = options.intent.discoveryQueries.slice(0, maxSearches);

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const variant = queries[queryIndex];
    const returned = await options.search(variant.query, variant.level);
    returned.forEach((candidate, index) => {
      if (pooled.size >= maxCandidates) return;
      const key = options.candidateKey?.(candidate, index) ?? defaultCandidateKey(candidate, index);
      if (!pooled.has(key)) pooled.set(key, candidate);
    });
    const candidates = [...pooled.values()];
    const verified = options.hasVerifiedMatch(candidates);
    const sufficient = !verified && Boolean(options.hasSufficientCandidate?.(candidates));
    const plausible = candidates.some(options.isPlausible);
    const hasMoreQueries = queryIndex < queries.length - 1;
    const outcome: DiscoveryAttempt["outcome"] = verified
      ? "verified"
      : sufficient
        ? "sufficient_candidates"
        : plausible
          ? "plausible_candidates"
          : hasMoreQueries
            ? "broadened"
            : "exhausted";
    attempts.push({
      level: variant.level,
      query: variant.query,
      returnedCount: returned.length,
      pooledCount: candidates.length,
      outcome,
    });
    if (verified || sufficient || !hasMoreQueries) break;
  }

  return { candidates: [...pooled.values()], attempts };
}

/**
 * Turn retrieval and verification evidence into a shopper-facing reason.
 * Retailer adapters provide their own exact-package and commerce checks while
 * this function keeps the explanation order consistent across integrations.
 */
export function explainDiscoveryFailure<
  T extends Pick<RetailProductCore, "title" | "brand" | "productType" | "size">
>(options: {
  retailerLabel: string;
  intent: ProductIntent;
  candidates: T[];
  exactPackage?: (candidate: T) => boolean;
  commerceEligible?: (candidate: T) => boolean;
}) {
  const { retailerLabel, intent, candidates } = options;
  const label = intent.displayName;
  if (!candidates.length) {
    return `No ${label} products were returned by ${retailerLabel} at this location.`;
  }

  const identityMatches = candidates.filter((candidate) => (
    isPlausibleDiscoveryCandidate(intent, candidate)
  ));
  if (!identityMatches.length) {
    return `${retailerLabel} returned products, but none matched ${label}.`;
  }

  const packageMatches = options.exactPackage
    ? identityMatches.filter(options.exactPackage)
    : identityMatches;
  if (!packageMatches.length && intent.requestedPackageLabel) {
    return `${label} was found at ${retailerLabel}, but no verified ${intent.requestedPackageLabel} package was available.`;
  }

  const commerceMatches = options.commerceEligible
    ? packageMatches.filter(options.commerceEligible)
    : packageMatches;
  if (!commerceMatches.length) {
    return `${retailerLabel} found a matching ${label} product, but did not confirm it as in stock with a usable price at this location.`;
  }

  return `${retailerLabel} found ${label} candidates, but none passed Cartiva's strict product checks.`;
}

export function logDiscoveryDecision(value: {
  intent: ProductIntent;
  attempts: DiscoveryAttempt[];
  candidates: Array<Pick<RetailProductCore, "id" | "title">>;
  candidateOutcomes?: Array<{
    id: string;
    title: string;
    verified: boolean;
    reasons: string[];
  }>;
  selectedId?: string;
  rejectionReason?: string;
}) {
  if (process.env.NODE_ENV !== "development") return;
  console.debug("[Cartiva product discovery]", {
    userIntent: value.intent.verificationText,
    parsedIntent: {
      category: value.intent.categoryLabel,
      brand: value.intent.brand,
      hardConstraints: value.intent.constraints.map((item) => item.label),
      requestedPackage: value.intent.requestedPackageLabel,
    },
    attempts: value.attempts,
    candidates: value.candidates.slice(0, 20).map((item) => ({ id: item.id, title: item.title })),
    verification: value.candidateOutcomes?.slice(0, 20),
    selectedId: value.selectedId,
    rejectionReason: value.rejectionReason,
  });
}
