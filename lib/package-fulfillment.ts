import type { ProductIntent } from "./product-search-intent";
import {
  COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE,
  COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE,
  COUNTED_CONTENT_UNIT_PATTERN_SOURCE,
} from "@/packages/shared/src/package-grammar";
import type {
  Confidence,
  RetailPackageFulfillment,
  RetailProductCore,
} from "./types";

const EPSILON = 0.0001;
const MAX_REVIEW_OVERAGE_RATIO = 1;
const VARIABLE_WEIGHT_PRODUCT = /\b(?:chicken|turkey|beef|pork|steak|meat|fish|salmon|tilapia|cod|catfish|shrimp|seafood)\b/i;
const FLEXIBLE_PANTRY_PRODUCT = /\b(?:pasta|rice|beans?|chickpeas?|lentils?|tomatoes?|coconut\s+milk)\b/i;

export type RetailerContainer =
  | "bag"
  | "bottle"
  | "box"
  | "bunch"
  | "can"
  | "canister"
  | "carton"
  | "container"
  | "each"
  | "jar"
  | "loaf"
  | "pouch"
  | "tray"
  | "tub";

export type RetailerCountUnit =
  | "bar"
  | "blade"
  | "pac"
  | "piece"
  | "pod"
  | "roll"
  | "sheet"
  | "wipe";

export interface RetailerContainerEvidence {
  container: RetailerContainer;
  source:
    | "retailer_category"
    | "retailer_metadata_inference"
    | "retailer_size"
    | "retailer_title";
}

export interface RetailerCountUnitEvidence {
  countUnit: RetailerCountUnit;
  source: RetailerContainerEvidence["source"];
}

type FulfillmentProduct = Pick<RetailProductCore, "price" | "size">
  & Partial<Pick<RetailProductCore, "productType" | "title">>;

const CONTAINER_PATTERNS: ReadonlyArray<{
  container: RetailerContainer;
  pattern: RegExp;
}> = [
  { container: "can", pattern: /\b(?:can|cans|canned)\b/i },
  { container: "canister", pattern: /\bcanisters?\b/i },
  { container: "bottle", pattern: /\bbottles?\b/i },
  { container: "jar", pattern: /\bjars?\b/i },
  { container: "pouch", pattern: /\bpouch(?:es)?\b/i },
  { container: "tub", pattern: /\btubs?\b/i },
  { container: "tray", pattern: /\btrays?\b/i },
  { container: "bag", pattern: /\bbags?\b/i },
  { container: "box", pattern: /\b(?:box|boxes)\b/i },
  { container: "carton", pattern: /\bcartons?\b/i },
  { container: "container", pattern: /\bcontainers?\b/i },
  { container: "bunch", pattern: /\b(?:bunch|bunches)\b/i },
  { container: "loaf", pattern: /\b(?:loaf|loaves)\b/i },
  { container: "each", pattern: /\beach\b/i },
];

const COUNT_UNIT_PATTERNS: ReadonlyArray<{
  countUnit: RetailerCountUnit;
  pattern: RegExp;
}> = [
  { countUnit: "blade", pattern: /\bblades?\b/i },
  { countUnit: "wipe", pattern: /\bwipes?\b/i },
  { countUnit: "pod", pattern: /\bpods?\b/i },
  { countUnit: "pac", pattern: /\bpacs?\b/i },
  { countUnit: "bar", pattern: /\bbars?\b/i },
  { countUnit: "piece", pattern: /\bpieces?\b/i },
  { countUnit: "roll", pattern: /\brolls?\b/i },
  { countUnit: "sheet", pattern: /\bsheets?\b/i },
];

function textContainerEvidence(
  value: string | undefined,
  source: RetailerContainerEvidence["source"],
) {
  if (!value) return [];
  return CONTAINER_PATTERNS.flatMap(({ container, pattern }) => (
    pattern.test(value) ? [{ container, source }] : []
  ));
}

function textCountUnitEvidence(
  value: string | undefined,
  source: RetailerCountUnitEvidence["source"],
) {
  if (!value) return [];
  return COUNT_UNIT_PATTERNS.flatMap(({ countUnit, pattern }) => (
    pattern.test(value) ? [{ countUnit, source }] : []
  ));
}

const MEASURED_CONTAINER_PATTERN = new RegExp(
  String.raw`\b\d+(?:\.\d+)?\s*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|gallons?|gal|quarts?|qt|pints?|pt|liters?|litres?|milliliters?|millilitres?|ml|l|count|ct|pack|pk)(?:\s|,|\/|-)+(bags?|bottles?|box(?:es)?|bunch(?:es)?|canisters?|cans?|cartons?|containers?|each|jars?|loaf|loaves|pouch(?:es)?|trays?|tubs?)\b`,
  "gi",
);
const COUNTED_CONTAINER_PATTERN = new RegExp(
  `\\b(\\d+(?:\\.\\d+)?)${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b`,
  "gi",
);
const INNER_CAPACITY_TAIL_PATTERN = /^\s*(?:\/|per)\s*(?:bags?|bars?|blades?|bottles?|boxes?|canisters?|cans?|cartons?|containers?|doses?|jars?|packs?|pacs?|pieces?|pods?|portions?|pouch(?:es)?|rolls?|scoops?|servings?|sheets?|trays?|tubs?|wipes?)\b/i;
const INNER_CAPACITY_EXPRESSION_PATTERN = new RegExp(
  `\\b(\\d+(?:\\.\\d+)?)${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b\\s*(?:/|per)\\s*(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE}|canisters?|containers?|packs?)\\b`,
  "gi",
);
const SINGULAR_COUNT_DESCRIPTOR = /\b(\d+(?:\.\d+)?)(?:\s*[-–—]\s*|\s+)(blade)\b/gi;
const OUTER_COUNT_CONTAINER = "bags?|bottles?|boxes?|bunch(?:es)?|canisters?|cans?|cartons?|containers?|jars?|loaf|loaves|pouch(?:es)?|trays?|tubs?";
const GENERIC_COUNT_OUTER_CONTAINER_PATTERN = new RegExp(
  `(?:\\b\\d+(?:\\.\\d+)?[\\s-]*(?:count|ct)\\b[\\s,.;:()\\[\\]{}-]*(?:${OUTER_COUNT_CONTAINER})\\b|\\b(?:${OUTER_COUNT_CONTAINER})\\b[\\s,.;:()\\[\\]{}-]*\\d+(?:\\.\\d+)?[\\s-]*(?:count|ct)\\b)`,
  "i",
);
const PLURAL_OUTER_COUNT_CONTAINER_PATTERN = /\b(?:bags|bottles|boxes|bunches|canisters|cans|cartons|containers|jars|loaves|pouches|trays|tubs)\b/i;
const UNRESOLVED_SERVING_COUNT_CAPACITY = new RegExp(
  `\\b\\d+(?:\\.\\d+)?${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(?:${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b\\s*(?:/|per)\\s*(?:doses?|portions?|scoops?|servings?)\\b`,
  "i",
);

/**
 * Product nouns can also be package words (for example, "trash bags" and
 * "tea bags"). A container directly following a measured retailer size is
 * stronger sell-unit evidence than a package word elsewhere in the title.
 */
function measuredContainerEvidence(
  value: string | undefined,
  source: RetailerContainerEvidence["source"],
) {
  if (!value) return [];
  return [...value.matchAll(MEASURED_CONTAINER_PATTERN)].flatMap((match) => {
    const containerText = match[1];
    const matched = CONTAINER_PATTERNS.find(({ pattern }) => pattern.test(containerText));
    return matched ? [{ container: matched.container, source }] : [];
  });
}

function measuredCountUnitCapacities(value: string | undefined) {
  if (!value) return [];
  return [...value.matchAll(COUNTED_CONTAINER_PATTERN)].flatMap((match) => {
    const matchEnd = (match.index ?? 0) + match[0].length;
    // "244 sheets per roll" is inner capacity, not a competing sell-unit.
    if (INNER_CAPACITY_TAIL_PATTERN.test(value.slice(matchEnd))) return [];
    const unitText = match[2];
    const matched = COUNT_UNIT_PATTERNS.find(({ pattern }) => pattern.test(unitText));
    return matched ? [{ countUnit: matched.countUnit, amount: Number(match[1]) }] : [];
  });
}

function measuredCountUnitEvidence(
  value: string | undefined,
  source: RetailerCountUnitEvidence["source"],
) {
  return measuredCountUnitCapacities(value).map(({ countUnit }) => ({ countUnit, source }));
}

function countUnitFallbackText(value: string | undefined) {
  return value?.replace(
    INNER_CAPACITY_EXPRESSION_PATTERN,
    (_expression, _amount: string, _innerUnit: string, outerUnit: string) => outerUnit,
  );
}

function conflictingSingularDescriptor(
  value: string | undefined,
  requested: RetailerCountUnit,
  packageAmount: number,
) {
  if (!value) return false;
  return [...value.matchAll(SINGULAR_COUNT_DESCRIPTOR)].some((match) => {
    const unit = COUNT_UNIT_PATTERNS.find(({ pattern }) => pattern.test(match[2]))?.countUnit;
    return unit === requested && Math.abs(Number(match[1]) - packageAmount) > EPSILON;
  });
}

function nestedCountCapacities(value: string | undefined) {
  if (!value) return [];
  return [...value.matchAll(INNER_CAPACITY_EXPRESSION_PATTERN)].flatMap((match) => {
    const inner = COUNT_UNIT_PATTERNS.find(({ pattern }) => pattern.test(match[2]))?.countUnit;
    if (!inner) return [];
    const outer = COUNT_UNIT_PATTERNS.find(({ pattern }) => pattern.test(match[3]))?.countUnit;
    return [{ inner, innerAmount: Number(match[1]), outer }];
  });
}

function verifiedCountCapacityFor(
  product: Pick<FulfillmentProduct, "productType" | "size" | "title">,
  requested: RetailerCountUnit,
) {
  const size = product.size;
  if (!size || size.kind !== "count" || size.baseAmount <= 0) return undefined;

  for (const nested of nestedCountCapacities(product.title)) {
    const directOuter = nested.outer
      ? measuredCountUnitCapacities(product.title)
          .find(({ countUnit }) => countUnit === nested.outer)?.amount
      : undefined;
    const outerCount = directOuter ?? size.packCount;
    if (!outerCount || outerCount <= 0) continue;
    if (requested === nested.inner) return nested.innerAmount * outerCount;
    if (nested.outer && requested === nested.outer) return outerCount;
  }

  const evidence = retailerCountUnitEvidence(product);
  if (evidence.length === 0 || evidence.some(({ countUnit }) => countUnit !== requested)) {
    return undefined;
  }

  if (conflictingSingularDescriptor(product.title, requested, size.baseAmount)) {
    return undefined;
  }

  const numericCapacity = [
    ...measuredCountUnitCapacities(size.label),
    ...measuredCountUnitCapacities(product.title),
  ].filter(({ countUnit }) => countUnit === requested);
  if (numericCapacity.length > 0) {
    if (
      size.packCount
      && size.perPackageAmount
      && numericCapacity.some(({ amount }) => (
        Math.abs(amount - size.perPackageAmount!) <= EPSILON
      ))
    ) {
      return size.baseAmount;
    }
    return numericCapacity.some(({ amount }) => (
      Math.abs(amount - size.baseAmount) <= EPSILON
    ))
      ? size.baseAmount
      : undefined;
  }

  if (
    GENERIC_COUNT_OUTER_CONTAINER_PATTERN.test(product.title ?? "")
    || PLURAL_OUTER_COUNT_CONTAINER_PATTERN.test(product.title ?? "")
    || UNRESOLVED_SERVING_COUNT_CAPACITY.test(product.title ?? "")
  ) {
    return undefined;
  }

  // A retailer count greater than one can be bound to the only compatible
  // counted-product identity (for example, 12 ct coffee pods). A bare 1 ct is
  // merely one outer UPC unless the title supplied a numeric same-unit count.
  return size.baseAmount > 1 ? size.baseAmount : undefined;
}

/**
 * Derives packaging only from retailer-supplied fields. Shopper wording is
 * deliberately excluded so it can never manufacture proof that a SKU is canned.
 */
export function retailerContainerEvidence(
  product: Pick<FulfillmentProduct, "productType" | "size" | "title">,
): RetailerContainerEvidence[] {
  const titleEvidence = textContainerEvidence(product.title, "retailer_title");
  const sizeEvidence = textContainerEvidence(product.size?.label, "retailer_size");
  const measuredTitleEvidence = measuredContainerEvidence(product.title, "retailer_title");
  // A container in normalized retailer size metadata is already scoped to the
  // sell unit. Otherwise prefer a container adjacent to a measured title size.
  // Fall back to unscoped title words only when neither stronger source exists.
  const structuredPackages = sizeEvidence.filter(({ container }) => container !== "each");
  const measuredPackages = measuredTitleEvidence.filter(({ container }) => container !== "each");
  const explicitEvidence = structuredPackages.length
    ? [...structuredPackages, ...measuredPackages]
    : measuredPackages.length
      ? measuredPackages
      : titleEvidence;
  const explicitPackages = explicitEvidence.filter(({ container }) => container !== "each");
  const categoryConfirmsCan = /\b(?:can|cans|canned)\b/i.test(product.productType ?? "")
    && explicitPackages.every(({ container }) => container === "can");
  const size = product.size;
  const typicalCulinaryCoconutMilkCan = /\bcoconut\s+milk\b/i.test(product.title ?? "")
    && size?.kind === "volume"
    && size.baseAmount > 8
    && size.baseAmount <= 20
    && explicitPackages.length === 0;
  const combined = [
    ...explicitEvidence,
    ...(categoryConfirmsCan
      ? [{ container: "can" as const, source: "retailer_category" as const }]
      : []),
    ...(typicalCulinaryCoconutMilkCan
      ? [{ container: "can" as const, source: "retailer_metadata_inference" as const }]
      : []),
  ];

  return combined.filter((evidence, index) => combined.findIndex((candidate) => (
    candidate.container === evidence.container && candidate.source === evidence.source
  )) === index);
}

/**
 * Counted contents are independent from the outer package: six blades may be
 * sold in a box, and a roll may contain hundreds of sheets. Prefer numeric
 * unit evidence; only fall back to retailer identity fields when no measured
 * unit is present.
 */
export function retailerCountUnitEvidence(
  product: Pick<FulfillmentProduct, "productType" | "size" | "title">,
): RetailerCountUnitEvidence[] {
  const measured = [
    ...measuredCountUnitEvidence(product.size?.label, "retailer_size"),
    ...measuredCountUnitEvidence(product.title, "retailer_title"),
  ];
  const combined = measured.length
    ? measured
    : [
        ...textCountUnitEvidence(countUnitFallbackText(product.title), "retailer_title"),
        ...textCountUnitEvidence(product.productType, "retailer_category"),
      ];
  return combined.filter((evidence, index) => combined.findIndex((candidate) => (
    candidate.countUnit === evidence.countUnit && candidate.source === evidence.source
  )) === index);
}

function requestedRetailerContainer(value: string | undefined) {
  return CONTAINER_PATTERNS.some(({ container }) => container === value)
    ? value as RetailerContainer
    : undefined;
}

function requestedRetailerCountUnit(value: string | undefined) {
  return COUNT_UNIT_PATTERNS.some(({ countUnit }) => countUnit === value)
    ? value as RetailerCountUnit
    : undefined;
}

function explicitContainerCount(
  value: string | undefined,
  requested: RetailerContainer,
) {
  if (!value) return undefined;
  const matches = [...value.matchAll(new RegExp(
    `\\b(\\d+(?:\\.\\d+)?)\\s+(?:of\\s+)?(${OUTER_COUNT_CONTAINER})\\b`,
    "gi",
  ))];
  const matching = matches.find((match) => CONTAINER_PATTERNS.some(({ container, pattern }) => (
    container === requested && pattern.test(match[2])
  )));
  return matching ? Number(matching[1]) : undefined;
}

/**
 * A requested can is an identity-bearing package constraint: dry beans or a
 * coconut-milk carton cannot fulfill it. Other container requests remain
 * permissive for matching, but their labels use only verified retailer evidence.
 */
export function retailerContainerCompatible(
  intent: ProductIntent,
  product: Pick<FulfillmentProduct, "productType" | "size" | "title">,
) {
  const requested = requestedRetailerContainer(intent.requestedContainer);
  if (!requested) return true;

  const evidence = retailerContainerEvidence(product);
  const explicitPackages = evidence.filter(({ source, container }) => (
    source !== "retailer_category" && container !== "each"
  ));
  if (explicitPackages.some(({ container }) => container !== requested)) return false;
  if (!evidence.some(({ container }) => container === requested)) return false;

  // Without aggregate wording, "3 bottles" means three individual bottles,
  // not three 24-bottle cases. Aggregate totals are allowed to use verified
  // multipacks because the quantity math then targets the requested total.
  if (
    !intent.requestedTotal
    && intent.requestedCartQuantity > 1
    && (
      (product.size?.kind === "count" && product.size.baseAmount > 1)
      || Number(product.title?.match(/\b(\d+(?:\.\d+)?)[\s-]*(?:count|ct)\b/i)?.[1]) > 1
      || (explicitContainerCount(product.title, requested) ?? 0) > 1
    )
  ) {
    return false;
  }

  return true;
}

export function retailerCountUnitCompatible(
  intent: ProductIntent,
  product: Pick<FulfillmentProduct, "productType" | "size" | "title">,
) {
  const requested = requestedRetailerCountUnit(intent.requestedCountUnit);
  if (!requested) {
    // A generic "count" total does not identify whether the shopper means
    // outer packages or inner wipes/rolls/blades. If retailer identity exposes
    // a specific count axis, require the shopper to name it before handoff.
    if (
      intent.requestedTotal?.kind === "count"
      && !intent.requestedContainer
      && (
        retailerCountUnitEvidence(product).length > 0
        || PLURAL_OUTER_COUNT_CONTAINER_PATTERN.test(product.title ?? "")
      )
    ) {
      return false;
    }
    return true;
  }
  if (intent.requestedTotal?.kind === "count") {
    return verifiedCountCapacityFor(product, requested) !== undefined;
  }
  const evidence = retailerCountUnitEvidence(product);
  if (evidence.length === 0 || evidence.some(({ countUnit }) => countUnit !== requested)) {
    return false;
  }
  return true;
}

function safeCartQuantity(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && (value ?? 0) >= 1 && (value ?? 0) <= 99
    ? value as number
    : fallback;
}

function trimNumber(value: number) {
  return Number(value.toFixed(2)).toString();
}

function formatBaseAmount(amount: number, baseUnit: "oz" | "fl oz" | "each") {
  if (baseUnit === "oz" && amount >= 16) return `${trimNumber(amount / 16)} lb`;
  if (baseUnit === "fl oz" && amount >= 128) return `${trimNumber(amount / 128)} gal`;
  if (baseUnit === "each") return `${trimNumber(amount)} each`;
  return `${trimNumber(amount)} ${baseUnit}`;
}

function pluralContainer(value: string | undefined, count: number) {
  if (!value) return "";
  if (count === 1) return value;
  if (value === "box") return "boxes";
  if (value === "loaf") return "loaves";
  if (value === "bunch") return "bunches";
  if (value === "pouch") return "pouches";
  return value.endsWith("s") ? value : `${value}s`;
}

function verifiedCountUnitFor(
  product: Pick<FulfillmentProduct, "productType" | "size" | "title">,
  intent: ProductIntent,
) {
  const requested = requestedRetailerCountUnit(intent.requestedCountUnit);
  return requested && retailerCountUnitEvidence(product)
    .some(({ countUnit }) => countUnit === requested)
    ? requested
    : undefined;
}

function packageLabel(
  product: Pick<FulfillmentProduct, "productType" | "size" | "title">,
  intent: ProductIntent,
  count: number,
) {
  const verifiedCountUnit = verifiedCountUnitFor(product, intent);
  const size = verifiedCountUnit && product.size?.kind === "count"
    ? `${trimNumber(product.size.baseAmount)} ${pluralContainer(verifiedCountUnit, product.size.baseAmount)}`
    : product.size?.label;
  const requested = requestedRetailerContainer(intent.requestedContainer);
  const verifiedContainer = requested && retailerContainerEvidence(product)
    .some(({ container }) => container === requested)
    ? requested
    : undefined;
  const container = pluralContainer(verifiedContainer, count);
  if (size && container) return `${size} ${container}`;
  return size ?? container ?? "package";
}

function permittedOverage(intent: ProductIntent) {
  if (VARIABLE_WEIGHT_PRODUCT.test(intent.fulfillmentText)) return 0.35;
  if (FLEXIBLE_PANTRY_PRODUCT.test(intent.fulfillmentText)) return 0.5;
  return 0.35;
}

function fulfillmentSizeFor(
  intent: ProductIntent,
  product: FulfillmentProduct,
) {
  const requestedUnit = requestedRetailerCountUnit(intent.requestedCountUnit);
  if (intent.requestedTotal?.kind !== "count" || !requestedUnit) {
    return product.size;
  }
  const capacity = verifiedCountCapacityFor(product, requestedUnit);
  if (!product.size || capacity === undefined) return undefined;
  return {
    ...product.size,
    amount: capacity,
    baseAmount: capacity,
    label: `${trimNumber(capacity)} count`,
    packCount: undefined,
    perPackageAmount: undefined,
  };
}

function measuredPackageFulfillment(
  intent: ProductIntent,
  product: FulfillmentProduct,
  lineMultiplier: number,
  approvalRequired: boolean,
  recoveredFromStrictNoMatch = false,
): RetailPackageFulfillment | null {
  const requested = intent.requestedTotal;
  const productSize = fulfillmentSizeFor(intent, product);
  if (
    !requested
    || !productSize
    || productSize.kind !== requested.kind
    || productSize.baseAmount <= 0
    || requested.baseAmount <= 0
  ) {
    return null;
  }

  const requestedBaseAmount = requested.baseAmount * lineMultiplier;
  const packageCount = Math.max(
    1,
    Math.ceil((requestedBaseAmount - EPSILON) / productSize.baseAmount),
  );
  if (packageCount > 99) return null;

  const suppliedBaseAmount = productSize.baseAmount * packageCount;
  const overageBaseAmount = Math.max(0, suppliedBaseAmount - requestedBaseAmount);
  const overagePercent = Number(((overageBaseAmount / requestedBaseAmount) * 100).toFixed(1));
  if (
    !approvalRequired
    && overageBaseAmount / requestedBaseAmount > permittedOverage(intent) + EPSILON
  ) {
    return null;
  }

  const variableWeight = VARIABLE_WEIGHT_PRODUCT.test(intent.fulfillmentText);
  const unitLabel = packageLabel({ ...product, size: productSize }, intent, packageCount);
  const verifiedCountUnit = verifiedCountUnitFor(product, intent);
  const suppliedLabel = requested.baseUnit === "each" && verifiedCountUnit
    ? `${trimNumber(suppliedBaseAmount)} ${pluralContainer(verifiedCountUnit, suppliedBaseAmount)}`
    : formatBaseAmount(suppliedBaseAmount, requested.baseUnit);
  const label = approvalRequired
    ? `${packageCount} × ${unitLabel} · ${suppliedLabel} total${overagePercent > 0 ? ` (${trimNumber(overagePercent)}% extra)` : ""}`
    : packageCount > 1
      ? `${packageCount} × ${unitLabel} · ${suppliedLabel} total`
      : variableWeight && overagePercent > 2
        ? `Approx. ${unitLabel}`
        : unitLabel;

  return {
    kind: variableWeight && packageCount === 1 && overagePercent > 2
      ? "variable_weight"
      : packageCount > 1 ? "multi_package" : "single_package",
    cartQuantity: packageCount,
    packageCount,
    requestedBaseAmount,
    suppliedBaseAmount,
    baseUnit: requested.baseUnit,
    overageBaseAmount,
    overagePercent,
    label,
    approvalRequired,
    ...(recoveredFromStrictNoMatch ? { recoveredFromStrictNoMatch: true } : {}),
  };
}

export function packageFulfillmentForProduct(
  intent: ProductIntent,
  product: FulfillmentProduct,
  cartQuantityOverride?: number,
  recoveredFromStrictNoMatch = false,
): RetailPackageFulfillment | null {
  if (
    !retailerContainerCompatible(intent, product)
    || !retailerCountUnitCompatible(intent, product)
  ) return null;

  const lineMultiplier = safeCartQuantity(
    cartQuantityOverride,
    intent.requestedCartQuantity,
  );
  const requested = intent.requestedTotal;

  if (!requested) {
    const label = packageLabel(product, intent, lineMultiplier);
    return {
      kind: lineMultiplier > 1 ? "multi_package" : "single_package",
      cartQuantity: lineMultiplier,
      packageCount: lineMultiplier,
      label: lineMultiplier > 1 ? `${lineMultiplier} × ${label}` : label,
      approvalRequired: false,
      ...(recoveredFromStrictNoMatch ? { recoveredFromStrictNoMatch: true } : {}),
    };
  }

  return measuredPackageFulfillment(
    intent,
    product,
    lineMultiplier,
    false,
    recoveredFromStrictNoMatch,
  );
}

/**
 * Exposes excessive same-dimension package math as an explicit review only.
 * The result can inform the shopper, but approvalRequired and the review
 * status at the ranker boundary prevent it from entering a retailer cart.
 */
export function packageReviewForProduct(
  intent: ProductIntent,
  product: FulfillmentProduct,
  cartQuantityOverride?: number,
): RetailPackageFulfillment | null {
  if (
    !intent.requestedTotal
    || !retailerContainerCompatible(intent, product)
    || !retailerCountUnitCompatible(intent, product)
  ) return null;
  const lineMultiplier = safeCartQuantity(
    cartQuantityOverride,
    intent.requestedCartQuantity,
  );
  const review = measuredPackageFulfillment(intent, product, lineMultiplier, true);
  if (!review || !review.requestedBaseAmount) return null;
  const overageRatio = (review.overageBaseAmount ?? 0) / review.requestedBaseAmount;
  return overageRatio > permittedOverage(intent) + EPSILON
    && overageRatio <= MAX_REVIEW_OVERAGE_RATIO + EPSILON
      ? review
      : null;
}

export interface RankedFulfillmentCandidate<TProduct extends RetailProductCore> {
  product: TProduct;
  confidence: Confidence;
  score: number;
  fulfillment: RetailPackageFulfillment;
}

function confidenceRank(value: Confidence) {
  return value === "high" ? 2 : value === "medium" ? 1 : 0;
}

/**
 * Chooses one compatible SKU to repeat. Keeping one UPC per requested line
 * preserves the existing secure receipt and handoff model while solving the
 * common multi-package case without mixing materially different products.
 */
export function rankFulfillmentCandidates<TProduct extends RetailProductCore>(
  candidates: RankedFulfillmentCandidate<TProduct>[],
) {
  return [...candidates].sort((left, right) => (
    confidenceRank(right.confidence) - confidenceRank(left.confidence)
    || (left.fulfillment.overagePercent ?? 0) - (right.fulfillment.overagePercent ?? 0)
    || (left.product.price * left.fulfillment.cartQuantity)
      - (right.product.price * right.fulfillment.cartQuantity)
    || left.fulfillment.packageCount - right.fulfillment.packageCount
    || right.score - left.score
  ));
}

export function bestFulfillmentCandidate<TProduct extends RetailProductCore>(
  candidates: RankedFulfillmentCandidate<TProduct>[],
) {
  return rankFulfillmentCandidates(candidates)[0];
}
