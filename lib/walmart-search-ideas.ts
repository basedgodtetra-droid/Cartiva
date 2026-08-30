import {
  extractRequestedBrand,
} from "./product-knowledge";
import {
  inferSuggestionBrand,
  inferSuggestionFlavor,
  inferSuggestionFormat,
} from "./walmart-suggestions";
import type { WalmartProduct } from "./types";

export const MAX_WALMART_SEARCH_IDEAS = 8;

export interface WalmartSearchIdea {
  text: string;
  evidenceCount?: number;
}

export interface WalmartSearchSuggestionSignalLike {
  text: string;
  source: "spelling" | "related" | "filter";
  score?: number;
  group?: string;
  itemCount?: number;
}

type IdeaKind = "brand" | "descriptor" | "variant" | "type" | "format" | "size" | "related";

interface IdeaCandidate {
  text: string;
  kind: IdeaKind;
  baseScore: number;
  bestRank: number;
  evidence: Set<string>;
  officialScore: number;
}

interface TextToken {
  text: string;
  key: string;
}

const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "for", "of", "the", "with",
  "pack", "count", "ct", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds",
]);

const MEASUREMENT_WORDS = new Set([
  "fl", "fluid", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds",
  "g", "gram", "grams", "kg", "ml", "l", "liter", "liters", "litre", "litres",
  "ct", "count", "each", "pack", "packs", "pk",
]);

const CONTAINER_WORDS = new Set([
  "bag", "bags", "bottle", "bottles", "box", "boxes", "can", "cans", "carton", "cartons",
  "case", "cases", "jar", "jars", "loaf", "pack", "packs", "packet", "packets", "pouch",
  "pouches", "roll", "rolls", "tub", "tubs", "glass",
]);

// These are presentation/commerce words rather than grocery attributes. The
// list is intentionally category-neutral; product identities and flavors are
// learned from the actual Walmart response instead of a local catalog.
const CATALOG_NOISE_WORDS = new Set([
  "assorted", "brand", "everyday", "flavor", "flavored", "fresh", "freshness", "fridge",
  "guaranteed", "grocery", "max", "mini", "new", "package", "packages", "packaging", "party",
  "plastic", "pop", "premium", "product", "products", "resealable", "share", "sharing",
  "size", "sizes", "snack", "snacks", "taste", "ultra", "value",
]);

// Single words are emitted from a longer title phrase only when they are a
// genuine shopper choice. The complete multiword phrase is still retained,
// so this does not turn into a category-specific item catalog.
const USEFUL_SINGLE_DESCRIPTOR = /^(?:1%|2%|aa|aaa|alkaline|beefsteak|block|boneless|cage|decaf|deli|diet|frozen|ground|lunchmeat|organic|roma|shredded|skinless|skim|sliced|whole)$/i;

const USEFUL_FILTER_GROUP = /\b(?:brand|category|type|form|style|flavou?r|variety|cut|roast|format|container|size|count|pack|dietary)\b/i;
const USELESS_FILTER_GROUP = /\b(?:price|retailer|seller|availability|fulfillment|delivery|shipping|pickup|rating|savings?|benefit|color)\b/i;

const KIND_SCORE: Record<IdeaKind, number> = {
  brand: 68,
  descriptor: 88,
  variant: 100,
  type: 82,
  format: 54,
  size: 34,
  related: 92,
};

const KIND_LIMIT: Record<IdeaKind, number> = {
  brand: 3,
  descriptor: 4,
  variant: 3,
  type: 2,
  format: 2,
  size: 1,
  related: 3,
};

function displayText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[®,™]/g, "")
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedText(value: string) {
  return displayText(value)
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularKey(value: string) {
  const token = normalizedText(value);
  if (token === "cheeses") return "cheese";
  if (token.length <= 3) return token;
  if (/[^aeiou]ies$/.test(token)) return `${token.slice(0, -3)}y`;
  if (/(?:oes|ches|shes|xes|zes|ses)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokens(value: string): TextToken[] {
  return displayText(value)
    .match(/[A-Za-z0-9%]+(?:[’'][A-Za-z0-9]+)?|&/g)
    ?.map((text) => ({ text, key: singularKey(text) }))
    .filter((token) => token.key) ?? [];
}

function significantTokens(value: string) {
  return tokens(value).filter((token) => (
    !QUERY_STOP_WORDS.has(token.key)
    && !/^\d+(?:\.\d+)?$/.test(token.key)
  ));
}

function evidenceKey(product: WalmartProduct, index: number) {
  return product.productId
    ?? product.itemId
    ?? `${normalizedText(product.title)}:${index}`;
}

function containsSequence(haystack: TextToken[], needle: TextToken[]) {
  if (!needle.length || needle.length > haystack.length) return undefined;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset]?.key === token.key)) {
      return { start, end: start + needle.length };
    }
  }
  return undefined;
}

function stripSequenceAtEnd(value: TextToken[], suffix: TextToken[]) {
  if (!suffix.length || suffix.length > value.length) return value;
  const offset = value.length - suffix.length;
  return suffix.every((token, index) => value[offset + index]?.key === token.key)
    ? value.slice(0, offset)
    : value;
}

function cleanDescriptorTokens(
  value: TextToken[],
  brandKeys: Set<string>,
  queryKeys: Set<string>,
) {
  return value.filter((token) => (
    !brandKeys.has(token.key)
    && !queryKeys.has(token.key)
    && !MEASUREMENT_WORDS.has(token.key)
    && !CONTAINER_WORDS.has(token.key)
    && !CATALOG_NOISE_WORDS.has(token.key)
    && !/^\d+(?:\.\d+)?x?$/.test(token.key)
  ));
}

function joinTokens(value: TextToken[]) {
  return value.map((token) => token.text).join(" ").replace(/\s+&\s+/g, " & ");
}

function cleanProductType(value: string) {
  return joinTokens(tokens(value).filter((token) => (
    !CATALOG_NOISE_WORDS.has(token.key)
    && !MEASUREMENT_WORDS.has(token.key)
    && !CONTAINER_WORDS.has(token.key)
  )));
}

function sameOrContainsWords(container: string, value: string) {
  const containerKeys = new Set(tokens(container).map((token) => token.key));
  const valueKeys = significantTokens(value).map((token) => token.key);
  return valueKeys.length > 0 && valueKeys.every((key) => containerKeys.has(key));
}

function combineQueryAndAttribute(query: string, attribute: string) {
  const cleanQuery = displayText(query);
  const cleanAttribute = displayText(attribute);
  if (!cleanQuery || !cleanAttribute) return undefined;
  if (normalizedText(cleanQuery) === normalizedText(cleanAttribute)) return undefined;
  if (sameOrContainsWords(cleanQuery, cleanAttribute)) return undefined;
  if (sameOrContainsWords(cleanAttribute, cleanQuery)) return cleanAttribute;
  return displayText(`${cleanQuery} ${cleanAttribute}`);
}

function descriptorPhrases(query: string, product: WalmartProduct) {
  const output = new Set<string>();
  const queryTokens = significantTokens(query);
  const queryKeys = new Set(queryTokens.map((token) => token.key));
  const brand = inferSuggestionBrand(product)?.value;
  const brandTokens = tokens(brand ?? "");
  const brandKeys = new Set(brandTokens.map((token) => token.key));
  const productTypeTokens = significantTokens(product.productType ?? "");
  const descriptorQueryKeys = new Set([
    ...queryKeys,
    ...productTypeTokens.map((token) => token.key),
  ]);
  const knownFlavor = inferSuggestionFlavor(product);
  const flavorKeys = new Set(significantTokens(knownFlavor ?? "").map((token) => token.key));

  for (const rawClause of product.title.split(/[,;()]+/)) {
    let clauseTokens = tokens(rawClause);
    if (!clauseTokens.length) continue;

    const brandPrefix = containsSequence(clauseTokens, brandTokens);
    if (brandPrefix?.start === 0) clauseTokens = clauseTokens.slice(brandPrefix.end);

    const queryAnchor = containsSequence(clauseTokens, queryTokens);
    const portions: TextToken[][] = [];
    if (queryAnchor) {
      portions.push(clauseTokens.slice(0, queryAnchor.start));
      portions.push(stripSequenceAtEnd(
        clauseTokens.slice(queryAnchor.end),
        productTypeTokens,
      ));
    } else if (
      !clauseTokens.some((token) => /^\d/.test(token.key))
      || clauseTokens.some((token) => /^\d+(?:\.\d+)?%$/.test(token.text))
    ) {
      portions.push(clauseTokens);
    }

    for (const portion of portions) {
      const cleaned = cleanDescriptorTokens(portion, brandKeys, descriptorQueryKeys);
      if (!cleaned.length || cleaned.length > 6) continue;
      if (knownFlavor && [...flavorKeys].every((key) => cleaned.some((token) => token.key === key))) {
        continue;
      }

      const bounded = cleaned.length <= 4 ? cleaned : cleaned.slice(0, 4);
      const phrase = joinTokens(bounded);
      if (phrase) output.add(phrase);

      // Short, query-adjacent title words are useful Walmart-style refinements
      // (Roma, sliced, deli, AA) and remain fully traceable to the result.
      if (cleaned.length <= 3) {
        for (const token of cleaned) {
          if (USEFUL_SINGLE_DESCRIPTOR.test(token.text)) {
            output.add(token.text);
          }
        }
      }
    }
  }

  return [...output];
}

function productEvidenceText(product: WalmartProduct) {
  return `${product.title} ${product.brand ?? ""} ${product.productType ?? ""} ${product.size?.label ?? ""}`;
}

function resultVariant(product: WalmartProduct) {
  const value = `${product.productType ?? ""} ${product.title}`;
  const percentage = value.match(/\b(\d+(?:\.\d+)?)%\s*(?:(?:reduced|low)[ -]?fat|milkfat)?(?=\s|,|$)/i);
  if (percentage && Number(percentage[1]) <= 10) return displayText(percentage[0]);
  return value.match(
    /\b(?:fat[ -]?free|(?:reduced|low)[ -]?fat|skim|unsweetened|decaf)\b/i,
  )?.[0];
}

function evidenceForAttribute(attribute: string, products: WalmartProduct[]) {
  const wanted = significantTokens(attribute).map((token) => token.key);
  if (!wanted.length) return [];
  return products.flatMap((product, index) => {
    const available = new Set(tokens(productEvidenceText(product)).map((token) => token.key));
    return wanted.every((key) => available.has(key)) ? [evidenceKey(product, index)] : [];
  });
}

function signalIdeaText(query: string, signal: WalmartSearchSuggestionSignalLike) {
  const text = displayText(signal.text);
  if (!text) return undefined;
  if (signal.source === "spelling") return text;
  if (sameOrContainsWords(text, query)) return text;
  return combineQueryAndAttribute(query, text);
}

function signalKind(signal: WalmartSearchSuggestionSignalLike): IdeaKind {
  if (signal.source !== "filter") return "related";
  const group = signal.group ?? "";
  if (/\bbrand\b/i.test(group)) return "brand";
  if (/\b(?:size|count|pack)\b/i.test(group)) return "size";
  if (/\b(?:format|container|form)\b/i.test(group)) return "format";
  if (/\b(?:category|type)\b/i.test(group)) return "type";
  return "descriptor";
}

function addCandidate(
  candidates: Map<string, IdeaCandidate>,
  query: string,
  attributeOrIdea: string,
  kind: IdeaKind,
  evidence: string[],
  rank: number,
  options: { completeIdea?: boolean; officialScore?: number } = {},
) {
  const text = options.completeIdea
    ? displayText(attributeOrIdea)
    : combineQueryAndAttribute(query, attributeOrIdea);
  if (!text || text.length > 160 || /[\n,;]/.test(text)) return;
  const normalizedQuery = normalizedText(query);
  const normalizedIdea = normalizedText(text);
  if (!normalizedIdea || normalizedIdea === normalizedQuery) return;

  const key = normalizedIdea;
  const existing = candidates.get(key);
  if (existing) {
    for (const item of evidence) existing.evidence.add(item);
    existing.bestRank = Math.min(existing.bestRank, rank);
    existing.officialScore = Math.max(existing.officialScore, options.officialScore ?? 0);
    return;
  }
  candidates.set(key, {
    text,
    kind,
    baseScore: KIND_SCORE[kind],
    bestRank: rank,
    evidence: new Set(evidence),
    officialScore: options.officialScore ?? 0,
  });
}

function candidateScore(candidate: IdeaCandidate) {
  const wordCount = significantTokens(candidate.text).length;
  const supportBonus = candidate.kind === "brand"
    ? Math.min(8, Math.max(0, candidate.evidence.size - 1) * 2)
    : candidate.kind === "format" || candidate.kind === "size"
      ? 0
      : Math.min(30, Math.max(0, candidate.evidence.size - 1) * 10);
  const rankBonus = Math.max(0, 20 - candidate.bestRank * 2);
  const conciseBonus = wordCount <= 6 ? 8 : -Math.min(20, (wordCount - 6) * 4);
  return candidate.baseScore + supportBonus + rankBonus + conciseBonus + candidate.officialScore;
}

/**
 * Build Walmart-like query refinements from the exact, already-filtered store
 * results and optional first-party query/filter signals. This function never
 * calls Walmart and never invents a catalog option.
 */
export function deriveWalmartSearchIdeas(
  query: string,
  eligibleProducts: WalmartProduct[],
  suggestionSignals: WalmartSearchSuggestionSignalLike[] = [],
  limit = MAX_WALMART_SEARCH_IDEAS,
): WalmartSearchIdea[] {
  const candidates = new Map<string, IdeaCandidate>();
  const requestedBrand = extractRequestedBrand(query);

  eligibleProducts.forEach((product, rank) => {
    const productEvidence = [evidenceKey(product, rank)];
    const brand = inferSuggestionBrand(product)?.value;
    if (brand && !requestedBrand) {
      addCandidate(candidates, query, brand, "brand", productEvidence, rank);
    }

    const variant = resultVariant(product);
    if (variant) {
      addCandidate(candidates, query, variant, "variant", productEvidence, rank, {
        officialScore: /%/.test(variant) ? 20 : 0,
      });
    }

    const productType = cleanProductType(product.productType?.trim() ?? "");
    if (productType) {
      addCandidate(candidates, query, productType, "type", productEvidence, rank);
    }

    const flavor = inferSuggestionFlavor(product);
    if (flavor) {
      addCandidate(candidates, query, flavor, "descriptor", productEvidence, rank);
    }

    const format = inferSuggestionFormat(product);
    if (format) {
      addCandidate(candidates, query, format, "format", productEvidence, rank);
    }

    if (product.size?.label) {
      addCandidate(candidates, query, product.size.label, "size", productEvidence, rank);
    }

    for (const descriptor of descriptorPhrases(query, product)) {
      addCandidate(candidates, query, descriptor, "descriptor", productEvidence, rank);
    }
  });

  for (const signal of suggestionSignals) {
    if (!signal?.text?.trim()) continue;
    if (signal.source === "filter") {
      if (USELESS_FILTER_GROUP.test(signal.group ?? "")) continue;
      if (signal.group && !USEFUL_FILTER_GROUP.test(signal.group)) continue;
    }
    const kind = signalKind(signal);
    const signalText = kind === "type" ? cleanProductType(signal.text) : signal.text;
    const ideaText = signalIdeaText(query, { ...signal, text: signalText });
    if (!ideaText) continue;
    const queryKeys = new Set(significantTokens(query).map((token) => token.key));
    const addedText = significantTokens(ideaText)
      .filter((token) => !queryKeys.has(token.key))
      .map((token) => token.text)
      .join(" ");
    const evidence = evidenceForAttribute(addedText || ideaText, eligibleProducts);
    // A spelling correction is an explicit supported Walmart Search signal.
    // It is useful precisely when the typo prevented normal product matching,
    // so it does not require an already-eligible product as corroboration.
    if (!evidence.length && signal.source !== "spelling") continue;
    addCandidate(
      candidates,
      query,
      ideaText,
      kind,
      evidence,
      0,
      {
        completeIdea: true,
        officialScore: Math.min(20, Math.max(0, signal.score ?? 0)),
      },
    );
  }

  const boundedLimit = Math.max(1, Math.min(MAX_WALMART_SEARCH_IDEAS, Math.floor(limit)));
  const sorted = [...candidates.values()].sort((left, right) => (
    candidateScore(right) - candidateScore(left)
    || right.evidence.size - left.evidence.size
    || left.bestRank - right.bestRank
    || left.text.localeCompare(right.text)
  ));
  const kindCounts = new Map<IdeaKind, number>();
  const selected: IdeaCandidate[] = [];

  for (const candidate of sorted) {
    if (selected.length >= boundedLimit) break;
    if ((kindCounts.get(candidate.kind) ?? 0) >= KIND_LIMIT[candidate.kind]) continue;
    const normalizedCandidate = normalizedText(candidate.text);
    const redundant = selected.some((existing) => {
      const normalizedExisting = normalizedText(existing.text);
      return normalizedCandidate === normalizedExisting
        || (candidate.kind === existing.kind
          && (normalizedCandidate.startsWith(`${normalizedExisting} `)
            || normalizedExisting.startsWith(`${normalizedCandidate} `))
          && Math.abs(candidateScore(candidate) - candidateScore(existing)) < 12);
    });
    if (redundant) continue;
    selected.push(candidate);
    kindCounts.set(candidate.kind, (kindCounts.get(candidate.kind) ?? 0) + 1);
  }

  return selected.map((candidate) => ({
    text: candidate.text,
    evidenceCount: candidate.evidence.size || undefined,
  }));
}
