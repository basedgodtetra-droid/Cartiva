import { auditProductCandidates, rankProducts } from "./matching";
import {
  extractRequestedBrand,
  inferProductCategory,
} from "./product-knowledge";
import type { ProductConstraint } from "./product-facets";
import type {
  Measurement,
  WalmartFulfillmentType,
  WalmartProduct,
} from "./types";

export const MAX_WALMART_SUGGESTIONS = 6;

export interface WalmartSuggestionOption {
  title: string;
  productId?: string;
  itemId?: string;
  brand?: string;
  brandSource?: "api" | "title";
  price: number;
  priceCents: number;
  packageSize?: string;
  size?: Measurement;
  flavor?: string;
  format?: string;
  fulfillment?: WalmartFulfillmentType[];
}

const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "for", "of", "the", "with", "pack", "count", "ct",
  "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds",
]);

const FLAVOR_PATTERNS: Array<[RegExp, string]> = [
  [/\bsour\s+cream\s*(?:&|and)?\s*onion\b/i, "Sour Cream & Onion"],
  [/\bsalt\s*(?:&|and)\s*vinegar\b/i, "Salt & Vinegar"],
  [/\bcool\s+ranch\b/i, "Cool Ranch"],
  [/\bflamin(?:g|['\u2019])?\s+hot\b/i, "Flamin' Hot"],
  [/\blemon[ -]?lime\b/i, "Lemon Lime"],
  [/\bnacho\s+cheese\b/i, "Nacho Cheese"],
  [/\bsour\s+cream\b/i, "Sour Cream"],
  [/\bbarbe?c(?:ue|ued)|\bbbq\b/i, "Barbecue"],
  [/\bblue\s+heat\b/i, "Blue Heat"],
  [/\bfuego\b/i, "Fuego"],
  [/\b(?:spicy|hot)\b/i, "Hot"],
  [/\bjalape(?:n|\u00f1)o\b/i, "Jalape\u00f1o"],
  [/\branch\b/i, "Ranch"],
  [/\bcheddar\b/i, "Cheddar"],
  [/\blime\b/i, "Lime"],
  [/\bzero\s+sugar\b/i, "Zero Sugar"],
  [/\bcherry\b/i, "Cherry"],
  [/\bvanilla\b/i, "Vanilla"],
  [/\bstrawberry\b/i, "Strawberry"],
  [/\bchocolate\b/i, "Chocolate"],
  [/\bcinnamon\b/i, "Cinnamon"],
  [/\bhoney\b/i, "Honey"],
  [/\b(?:original|classic|plain)\b/i, "Original"],
];

const FORMAT_PATTERNS: Array<[RegExp, string]> = [
  [/\bvariety\s+pack\b/i, "Variety pack"],
  [/\bmulti[ -]?pack\b/i, "Multipack"],
  [/\bmini\s+cans?\b/i, "Mini cans"],
  [/\bglass\s+bottles?\b/i, "Glass bottle"],
  [/\bbags?\b/i, "Bag"],
  [/\bboxes?\b/i, "Box"],
  [/\bbottles?\b/i, "Bottle"],
  [/\bcans?\b/i, "Can"],
  [/\btubs?\b/i, "Tub"],
  [/\bpouches?\b/i, "Pouch"],
  [/\bcartons?\b/i, "Carton"],
  [/\bloaf\b/i, "Loaf"],
  [/\b(?:slices?|singles)\b/i, "Slices"],
  [/\bblocks?\b/i, "Block"],
  [/\bbunch\b/i, "Bunch"],
];

const KNOWN_TITLE_BRANDS: Array<[RegExp, string]> = [
  [/^Ruffles\b/i, "Ruffles"],
  [/^Pringles\b/i, "Pringles"],
  [/^Tostitos\b/i, "Tostitos"],
  [/^Fritos\b/i, "Fritos"],
  [/^SunChips\b/i, "SunChips"],
  [/^Kettle Brand\b/i, "Kettle Brand"],
  [/^Cape Cod\b/i, "Cape Cod"],
  [/^Miss Vickie['\u2019]?s\b/i, "Miss Vickie's"],
  [/^On The Border\b/i, "On The Border"],
  [/^Utz\b/i, "Utz"],
];

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value: string) {
  return normalize(value).split(" ").filter(Boolean);
}

function queryWords(value: string) {
  return words(value).filter((word) => (
    !QUERY_STOP_WORDS.has(word) && !/^\d+(?:\.\d+)?$/.test(word)
  ));
}

export function inferSuggestionFlavor(product: Pick<WalmartProduct, "title" | "productType">) {
  const candidate = `${product.productType ?? ""} ${product.title}`;
  return FLAVOR_PATTERNS.find(([pattern]) => pattern.test(candidate))?.[1];
}

export function inferSuggestionFormat(product: Pick<WalmartProduct, "title" | "productType">) {
  const candidate = `${product.productType ?? ""} ${product.title}`;
  return FORMAT_PATTERNS.find(([pattern]) => pattern.test(candidate))?.[1];
}

export function inferSuggestionBrand(
  product: Pick<WalmartProduct, "title" | "brand" | "productType">,
) {
  const apiBrand = product.brand?.trim();
  if (apiBrand) return { value: apiBrand, source: "api" as const };

  const catalogBrand = extractRequestedBrand(product.title);
  const normalizedTitle = normalize(product.title);
  if (catalogBrand && catalogBrand.aliases.some((alias) => {
    const normalizedAlias = normalize(alias);
    return normalizedTitle === normalizedAlias || normalizedTitle.startsWith(`${normalizedAlias} `);
  })) {
    return { value: catalogBrand.canonical, source: "title" as const };
  }

  const knownTitleBrand = KNOWN_TITLE_BRANDS.find(([pattern]) => pattern.test(product.title));
  if (knownTitleBrand) return { value: knownTitleBrand[1], source: "title" as const };

  return undefined;
}

function productKey(product: WalmartProduct) {
  return product.productId
    ? `product:${product.productId}`
    : product.itemId
      ? `item:${product.itemId}`
      : `title:${normalize(product.title)}:${product.size?.label ?? ""}`;
}

function basicProductSafety(product: WalmartProduct) {
  if (!Number.isFinite(product.price) || product.price <= 0 || !product.inStock) return false;
  if (product.sponsored) return false;
  const provenance = product.priceProvenance;
  if (provenance?.sellerType === "marketplace") return false;
  if (provenance?.searchStoreMatched === false) return false;
  if (
    provenance?.fulfillment.length === 1
    && provenance.fulfillment[0] === "shipping"
    && !(product.dataSource === "scrapingbee" && provenance.searchStoreMatched === true)
  ) {
    return false;
  }
  if (
    (product.dataSource === "serpapi"
      || product.dataSource === "openwebninja"
      || product.dataSource === "scrapingbee"
      || product.dataSource === "decodo")
    && provenance
    && !provenance.localPriceEligible
  ) {
    return false;
  }
  if (!provenance && product.seller && !/walmart/i.test(product.seller)) return false;
  return Boolean(product.productId || product.itemId);
}

/**
 * Unknown three-character fragments do not yet have enough information for
 * category matching. Keep them useful without weakening normal matching by
 * requiring every typed word to prefix an API-returned title or brand word.
 */
function matchesUnknownFragment(query: string, product: WalmartProduct) {
  const requested = queryWords(query);
  if (!requested.length) return false;
  const candidate = words(`${product.brand ?? ""} ${product.title}`);
  return requested.every((fragment) => (
    candidate.some((word) => word === fragment || word.startsWith(fragment))
  ));
}

/**
 * Apply the same store, seller, availability, brand, and product-intent rules
 * to every piece of the typeahead response. Query ideas must never be mined
 * from a product that Cartiva would reject as an exact suggestion.
 */
export function eligibleWalmartSuggestionProducts(
  query: string,
  products: WalmartProduct[],
  constraints: ProductConstraint[],
) {
  const audits = auditProductCandidates(query, products, constraints);
  const knownIntent = Boolean(inferProductCategory(query) || extractRequestedBrand(query));
  const seen = new Set<string>();

  return products.filter((product, index) => {
    if (!basicProductSafety(product)) return false;
    const ordinarilyEligible = !audits[index]?.rejectionReason;
    if (knownIntent ? !ordinarilyEligible : !matchesUnknownFragment(query, product)) return false;
    const key = productKey(product);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface CandidateView {
  product: WalmartProduct;
  apiIndex: number;
  preferredIndex: number;
  brandKey?: string;
  flavor?: string;
  format?: string;
  sizeKey?: string;
}

function diverseProducts(
  query: string,
  products: WalmartProduct[],
  constraints: ProductConstraint[],
  limit: number,
) {
  const preferred = rankProducts(query, products, constraints);
  const preferredKeys = [preferred.recommended, ...preferred.alternatives]
    .filter((product): product is NonNullable<typeof product> => Boolean(product))
    .map(productKey);
  const candidates: CandidateView[] = products.map((product, apiIndex) => {
    const suggestionBrand = inferSuggestionBrand(product);
    return {
      product,
      apiIndex,
      preferredIndex: preferredKeys.indexOf(productKey(product)),
      brandKey: suggestionBrand ? normalize(suggestionBrand.value) : undefined,
      flavor: inferSuggestionFlavor(product),
      format: inferSuggestionFormat(product),
      sizeKey: product.size?.label ? normalize(product.size.label) : undefined,
    };
  });
  const selected: CandidateView[] = [];
  const remaining = [...candidates];

  while (remaining.length && selected.length < limit) {
    const seenBrands = new Set(selected.flatMap((item) => item.brandKey ? [item.brandKey] : []));
    const seenFlavors = new Set(selected.flatMap((item) => item.flavor ? [item.flavor] : []));
    const seenFormats = new Set(selected.flatMap((item) => item.format ? [item.format] : []));
    const seenSizes = new Set(selected.flatMap((item) => item.sizeKey ? [item.sizeKey] : []));
    const score = (candidate: CandidateView) => {
      const preferredBonus = candidate.preferredIndex >= 0
        ? 70 - candidate.preferredIndex * 10
        : 0;
      const apiRelevance = Math.max(0, 50 - candidate.apiIndex * 2);
      if (!selected.length) return preferredBonus + apiRelevance;
      return preferredBonus + apiRelevance
        + (candidate.brandKey && !seenBrands.has(candidate.brandKey) ? 34 : 0)
        + (candidate.flavor && !seenFlavors.has(candidate.flavor) ? 42 : 0)
        + (candidate.format && !seenFormats.has(candidate.format) ? 10 : 0)
        + (candidate.sizeKey && !seenSizes.has(candidate.sizeKey) ? 8 : 0)
        - (selected.some((item) => (
          item.brandKey === candidate.brandKey
          && item.flavor === candidate.flavor
          && item.format === candidate.format
          && item.sizeKey === candidate.sizeKey
        )) ? 55 : 0);
    };
    remaining.sort((left, right) => (
      score(right) - score(left) || left.apiIndex - right.apiIndex
    ));
    selected.push(remaining.shift()!);
  }

  return selected.map((item) => item.product);
}

export function selectWalmartSuggestions(
  query: string,
  products: WalmartProduct[],
  constraints: ProductConstraint[] = [],
  limit = MAX_WALMART_SUGGESTIONS,
): WalmartSuggestionOption[] {
  const boundedLimit = Math.max(1, Math.min(MAX_WALMART_SUGGESTIONS, Math.floor(limit)));
  const eligible = eligibleWalmartSuggestionProducts(query, products, constraints);
  return diverseProducts(query, eligible, constraints, boundedLimit).map((product) => {
    const suggestionBrand = inferSuggestionBrand(product);
    return {
      title: product.title,
      productId: product.productId,
      itemId: product.itemId,
      brand: suggestionBrand?.value,
      brandSource: suggestionBrand?.source,
      price: product.price,
      priceCents: product.priceCents ?? Math.round(product.price * 100),
      packageSize: product.size?.label,
      size: product.size,
      flavor: inferSuggestionFlavor(product),
      format: inferSuggestionFormat(product),
      fulfillment: product.priceProvenance?.fulfillment,
    };
  });
}
