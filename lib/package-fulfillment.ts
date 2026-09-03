import type { ProductIntent } from "./product-search-intent";
import type {
  Confidence,
  RetailPackageFulfillment,
  RetailProductCore,
} from "./types";

const EPSILON = 0.0001;
const VARIABLE_WEIGHT_PRODUCT = /\b(?:chicken|turkey|beef|pork|steak|meat|fish|salmon|tilapia|cod|catfish|shrimp|seafood)\b/i;
const FLEXIBLE_PANTRY_PRODUCT = /\b(?:pasta|rice|beans?|chickpeas?|lentils?|tomatoes?|coconut\s+milk)\b/i;

export type RetailerContainer =
  | "bag"
  | "bottle"
  | "box"
  | "bunch"
  | "can"
  | "carton"
  | "each"
  | "jar"
  | "loaf"
  | "roll";

export interface RetailerContainerEvidence {
  container: RetailerContainer;
  source:
    | "retailer_category"
    | "retailer_metadata_inference"
    | "retailer_size"
    | "retailer_title";
}

type FulfillmentProduct = Pick<RetailProductCore, "price" | "size">
  & Partial<Pick<RetailProductCore, "productType" | "title">>;

const CONTAINER_PATTERNS: ReadonlyArray<{
  container: RetailerContainer;
  pattern: RegExp;
}> = [
  { container: "can", pattern: /\b(?:can|cans|canned)\b/i },
  { container: "bottle", pattern: /\bbottles?\b/i },
  { container: "jar", pattern: /\bjars?\b/i },
  { container: "bag", pattern: /\bbags?\b/i },
  { container: "box", pattern: /\b(?:box|boxes)\b/i },
  { container: "carton", pattern: /\bcartons?\b/i },
  { container: "roll", pattern: /\brolls?\b/i },
  { container: "bunch", pattern: /\b(?:bunch|bunches)\b/i },
  { container: "loaf", pattern: /\b(?:loaf|loaves)\b/i },
  { container: "each", pattern: /\beach\b/i },
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

/**
 * Derives packaging only from retailer-supplied fields. Shopper wording is
 * deliberately excluded so it can never manufacture proof that a SKU is canned.
 */
export function retailerContainerEvidence(
  product: Pick<FulfillmentProduct, "productType" | "size" | "title">,
): RetailerContainerEvidence[] {
  const titleEvidence = textContainerEvidence(product.title, "retailer_title");
  const sizeEvidence = textContainerEvidence(product.size?.label, "retailer_size");
  const explicitEvidence = [...titleEvidence, ...sizeEvidence];
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

function requestedRetailerContainer(value: string | undefined) {
  return CONTAINER_PATTERNS.some(({ container }) => container === value)
    ? value as RetailerContainer
    : undefined;
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

  // A count greater than one describes a retailer multipack, not one requested can.
  if (requested === "can" && product.size?.kind === "count" && product.size.baseAmount > 1) {
    return false;
  }

  return requested !== "can" || evidence.some(({ container }) => container === "can");
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
  return value.endsWith("s") ? value : `${value}s`;
}

function packageLabel(
  product: Pick<FulfillmentProduct, "productType" | "size" | "title">,
  intent: ProductIntent,
  count: number,
) {
  const size = product.size?.label;
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

export function packageFulfillmentForProduct(
  intent: ProductIntent,
  product: FulfillmentProduct,
  cartQuantityOverride?: number,
  recoveredFromStrictNoMatch = false,
): RetailPackageFulfillment | null {
  if (!retailerContainerCompatible(intent, product)) return null;

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

  if (!product.size || product.size.kind !== requested.kind || product.size.baseAmount <= 0) {
    return null;
  }
  const packagesPerRequest = Math.max(
    1,
    Math.ceil((requested.baseAmount - EPSILON) / product.size.baseAmount),
  );
  const packageCount = packagesPerRequest * lineMultiplier;
  if (packageCount > 99) return null;

  const requestedBaseAmount = requested.baseAmount * lineMultiplier;
  const suppliedBaseAmount = product.size.baseAmount * packageCount;
  const overageBaseAmount = Math.max(0, suppliedBaseAmount - requestedBaseAmount);
  const overagePercent = requestedBaseAmount > 0
    ? Number(((overageBaseAmount / requestedBaseAmount) * 100).toFixed(1))
    : 0;
  if (overageBaseAmount / requestedBaseAmount > permittedOverage(intent) + EPSILON) {
    return null;
  }

  const variableWeight = VARIABLE_WEIGHT_PRODUCT.test(intent.fulfillmentText);
  const unitLabel = packageLabel(product, intent, packageCount);
  const suppliedLabel = formatBaseAmount(suppliedBaseAmount, requested.baseUnit);
  const label = packageCount > 1
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
    approvalRequired: false,
    ...(recoveredFromStrictNoMatch ? { recoveredFromStrictNoMatch: true } : {}),
  };
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
