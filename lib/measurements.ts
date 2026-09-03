import type { Measurement, WalmartProduct } from "./types";
import { extractProduceIdentity } from "./product-knowledge";
import {
  COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE,
  COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE,
  COUNTED_CONTENT_UNIT_PATTERN_SOURCE,
  MULTIPACK_CONTAINER_UNIT_PATTERN_SOURCE,
  OUTER_CONTAINER_UNIT_PATTERN_SOURCE,
} from "@/packages/shared/src/package-grammar";

const NUMBER = "(\\d+(?:\\.\\d+)?)";
const NUTRITION_NOUN = "protein|fat|carbs?|carbohydrates?|fiber|sugars?|sodium|collagen(?:\\s+peptides?)?|creatine|amino\\s+acids?|bcaas?|caffeine|omega(?:[\\s-]*3)?|grains?";
// Nutrient callouts in retailer titles are commonly expressed in grams. Let
// up to two plain-language modifiers precede the nutrient noun ("net carbs",
// "high quality protein", "saturated fat") without maintaining a brittle
// adjective allow-list. Other physical units remain unaffected.
const NUTRITION_CLAIM_TAIL = `\\s*(?:(?:(?:[a-z][a-z-]*\\s+){0,2})(?:${NUTRITION_NOUN})|(?:(?:/|-)\\s*)?(?:per[\\s-]+)?(?:serving|scoop|dose))\\b`;
const GRAM_UNIT = "(?:grams?|g)";
const AMBIGUOUS_GRAM_UNIT = `(?:grams?|g)(?!${NUTRITION_CLAIM_TAIL})`;
const WEIGHT_UNIT = `oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|${GRAM_UNIT}`;
const AMBIGUOUS_WEIGHT_UNIT = `oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|${AMBIGUOUS_GRAM_UNIT}`;
const CATALOG_UNIT = `fl\\s*oz|fluid ounces?|${WEIGHT_UNIT}|liters?|litres?|milliliters?|millilitres?|gallons?|gal|quarts?|qt|pints?|pt|ml|l`;
const AMBIGUOUS_CATALOG_UNIT = `fl\\s*oz|fluid ounces?|${AMBIGUOUS_WEIGHT_UNIT}|liters?|litres?|milliliters?|millilitres?|gallons?|gal|quarts?|qt|pints?|pt|ml|l`;
const GRAM_PACKAGE_PRODUCT_TAIL = "\\s+(?:(?:whey|plant|pea|soy|casein|egg|rice|hemp)\\s+)?(?:protein|collagen(?:\\s+peptides?)?)(?:\\s+(?:isolate|concentrate|blend|supplement))?\\s+powders?\\b(?!\\s*(?:(?:/|-)\\s*)?(?:per[\\s-]+)?(?:serving|scoop|dose)\\b)";
const SINGULAR_COUNT_DESCRIPTOR = /^\d+(?:\.\d+)?(?:\s*[-–—]\s*|\s+)blade$/i;
const SERVING_AMOUNT_TAIL = /^\s*(?:(?:\/|-)\s*)?(?:per[\s-]+)?(?:servings?|portions?|scoops?|doses?)\b/i;
const SERVING_AMOUNT_PREFIX = /\bserving\s+size\s*[:.,-]?\s*$/i;
const PER_PIECE_AMOUNT_TAIL = /^\s*(?:fillets?|patties?|burgers?|steaks?|pieces?)\b/i;
const SELLABLE_PACKAGE_AMOUNT_TAIL = /^\s*(?:(?:net\s*(?:wt|weight)\b[\s:.,-]*)?(?:bags?|bottles?|boxes?|canisters?|cans?|cartons?|containers?|jars?|packages?|pouches?|trays?|tubs?)\b|net\s*(?:wt|weight)\b)/i;
const SELLABLE_PACKAGE_AMOUNT_PREFIX = /\bnet\s*(?:wt|weight|contents?)\s*[:.,-]?\s*$/i;
// Nutrition claims often sit between a multipack count and the actual package
// size (for example, "6 Pack 12 g Protein 1.76 oz Each"). A nutrient amount
// must never become the sellable size used to calculate retailer cart quantity.
const COUNT_PACK_MULTIPLIER = `(?:(?:packs?|pks?)\\b|[x×](?=\\s*\\d))`;
const PLURAL_MULTIPACK_CONTAINER = "bags|bottles|boxes|bunches|canisters|cans|cartons|containers|jars|loaves|pouches|rolls|trays|tubs";
const COUNT_CAPACITY_CONTAINER = MULTIPACK_CONTAINER_UNIT_PATTERN_SOURCE;
const FRESH_HERB = /\b(?:cilantro|coriander|parsley|basil|mint|rosemary|thyme|dill|sage|chives?)\b/i;

const FRACTION_UNIT_LOOKAHEAD = "(?=\\s*(?:fl\\s*oz|fluid ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|liters?|litres?|milliliters?|millilitres?|gallons?|gal|quarts?|qt|pints?|pt|ml|l)\\b)";
const VULGAR_FRACTIONS: Record<string, string> = {
  "¼": "1/4", "½": "1/2", "¾": "3/4", "⅐": "1/7", "⅑": "1/9", "⅒": "1/10",
  "⅓": "1/3", "⅔": "2/3", "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5",
  "⅙": "1/6", "⅚": "5/6", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};

/**
 * Convert shopper-friendly measurement fractions before any quantity parser
 * sees them. Limiting conversion to values immediately followed by a physical
 * unit avoids changing product names, dates, model numbers, and URLs.
 */
export function normalizeMeasurementFractions(value: string) {
  const vulgarPattern = /[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g;
  let normalized = value
    .replace(/(\d+)\s*([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (_match, whole: string, fraction: string) => (
      `${whole} ${VULGAR_FRACTIONS[fraction]}`
    ))
    .replace(vulgarPattern, (fraction) => VULGAR_FRACTIONS[fraction])
    .replace(/⁄/g, "/")
    .normalize("NFKC")
    .replace(
      new RegExp(`(\\d+),(\\d+)${FRACTION_UNIT_LOOKAHEAD}`, "gi"),
      "$1.$2",
    )
    .replace(
      new RegExp(`(^|[^\\d])\\.(\\d+)${FRACTION_UNIT_LOOKAHEAD}`, "gi"),
      (_match, prefix: string, decimals: string) => `${prefix}0.${decimals}`,
    );

  normalized = normalized.replace(
    new RegExp(`\\b(\\d+)(?:\\s+|\\s*-\\s*)(\\d+)\\s*\\/\\s*(\\d+)${FRACTION_UNIT_LOOKAHEAD}`, "gi"),
    (match, wholeText: string, numeratorText: string, denominatorText: string) => {
      const denominator = Number(denominatorText);
      if (!denominator) return match;
      return String(Number(wholeText) + Number(numeratorText) / denominator);
    },
  );
  return normalized.replace(
    new RegExp(`\\b(\\d+)\\s*\\/\\s*(\\d+)${FRACTION_UNIT_LOOKAHEAD}`, "gi"),
    (match, numeratorText: string, denominatorText: string) => {
      const denominator = Number(denominatorText);
      if (!denominator) return match;
      return String(Number(numeratorText) / denominator);
    },
  );
}

function isSingularCountDescriptor(amount: string, unit: string) {
  return SINGULAR_COUNT_DESCRIPTOR.test(`${amount} ${unit}`);
}

export function extractPackOnlyCount(value: string) {
  const pack = value.match(/\b(\d+)[\s-]*(?:packs?|pks?)\b/i);
  const individualSize = value.match(
    new RegExp(`(?:\\b\\d+(?:\\.\\d+)?[\\s-]*(?:${CATALOG_UNIT}|count|ct|each)\\b|\\b\\d+(?:\\.\\d+)?${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(?:${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b)`, "i"),
  );
  return pack && !individualSize ? Number(pack[1]) : undefined;
}

function round(value: number, decimals = 4) {
  return Number(value.toFixed(decimals));
}

function buildMeasurement(
  amount: number,
  unit: Measurement["unit"],
  packCount?: number,
  perPackageAmount?: number,
): Measurement {
  const kind = unit === "count" ? "count" : unit === "fl oz" ? "volume" : "weight";
  const baseUnit = unit === "count" ? "each" : unit === "fl oz" ? "fl oz" : "oz";
  const converted = unit === "lb" ? amount * 16 : amount;
  const baseAmount = round(converted * (packCount ?? 1));
  const label = packCount && packCount > 1
    ? `${packCount} × ${perPackageAmount ?? amount} ${unit}`
    : `${amount} ${unit}`;

  return {
    amount: packCount ? baseAmount : amount,
    unit,
    kind,
    baseAmount,
    baseUnit,
    packCount,
    perPackageAmount,
    label,
  };
}

function buildProduceUnitMeasurement(amount: number, unit: "each" | "bunch") {
  return {
    ...buildMeasurement(amount, "count"),
    label: `${amount} ${unit === "bunch" && amount !== 1 ? "bunches" : unit}`,
  };
}

function normalizedCatalogMeasurement(
  amount: number,
  rawUnit: string,
  beverageContext: boolean,
) {
  const value = rawUnit.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^(?:l|liter|litre)s?$/.test(value)) {
    return { amount: round(amount * 33.814), unit: "fl oz" as const, label: `${amount} L` };
  }
  if (/^(?:ml|milliliter|millilitre)s?$/.test(value)) {
    return { amount: round(amount * 0.033814), unit: "fl oz" as const, label: `${amount} mL` };
  }
  if (/^(?:kg|kgs|kilogram)s?$/.test(value)) {
    return { amount: round(amount * 35.274), unit: "oz" as const, label: `${amount} kg` };
  }
  if (/^(?:g|gram)s?$/.test(value)) {
    return { amount: round(amount * 0.035274), unit: "oz" as const, label: `${amount} g` };
  }
  if (/^(?:gal|gallon)s?$/.test(value)) {
    return { amount: round(amount * 128), unit: "fl oz" as const, label: `${amount} gal` };
  }
  if (/^(?:qt|quart)s?$/.test(value)) {
    return { amount: round(amount * 32), unit: "fl oz" as const, label: `${amount} qt` };
  }
  if (/^(?:pt|pint)s?$/.test(value)) {
    return { amount: round(amount * 16), unit: "fl oz" as const, label: `${amount} pt` };
  }
  const unit = normalizeUnit(rawUnit, beverageContext);
  return { amount, unit, label: `${amount} ${unit}` };
}

function buildCatalogMeasurement(
  amount: number,
  rawUnit: string,
  beverageContext: boolean,
  packCount?: number,
) {
  const normalized = normalizedCatalogMeasurement(amount, rawUnit, beverageContext);
  return {
    ...buildMeasurement(
      normalized.amount,
      normalized.unit,
      packCount,
      packCount ? normalized.amount : undefined,
    ),
    label: packCount && packCount > 1
      ? `${packCount} × ${normalized.label}`
      : normalized.label,
  };
}

export function extractMeasurement(value: string): Measurement | undefined {
  const text = normalizeMeasurementFractions(value).toLowerCase().replace(/,/g, " ");
  const beverageContext = /\b(?:gatorade|sports drink|soda|cola|coke|pepsi|juice|water|beverage|bottles?)\b/i.test(text);
  const freshProduceContext = (
    Boolean(extractProduceIdentity(text))
    || /\bfresh produce\b/i.test(text)
    || (FRESH_HERB.test(text) && /\b(?:fresh|organic|whole|bunch(?:es)?|each)\b/i.test(text))
  )
    && !/\b(?:frozen|canned|pickled|dried|freeze[- ]dried|jarred)\b/i.test(text);

  const nestedCountSellUnit = text.match(new RegExp(
    `\\b${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b.{0,36}?${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b\\s*(?:/|per)\\s*(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b`,
    "i",
  ));
  if (
    nestedCountSellUnit
    && nestedCountSellUnit[2].replace(/s$/i, "").toLowerCase()
      === nestedCountSellUnit[5].replace(/s$/i, "").toLowerCase()
  ) {
    return buildMeasurement(Number(nestedCountSellUnit[1]), "count");
  }

  const measurementRange = text.match(new RegExp(
    `\\b(\\d+(?:\\.\\d+)?)\\s*(?:[-–—]|to)\\s*(\\d+(?:\\.\\d+)?)\\s*(${AMBIGUOUS_CATALOG_UNIT})\\b`,
    "i",
  ));
  if (measurementRange) {
    const lowerBound = Math.min(Number(measurementRange[1]), Number(measurementRange[2]));
    return buildCatalogMeasurement(lowerBound, measurementRange[3], beverageContext);
  }

  const compoundWeight = text.match(
    /\b(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\s+(\d+(?:\.\d+)?)\s*(?:oz|ounces?)\b/i,
  );
  if (compoundWeight) {
    const pounds = Number(compoundWeight[1]);
    const ounces = Number(compoundWeight[2]);
    return {
      ...buildCatalogMeasurement(pounds * 16 + ounces, "oz", beverageContext),
      label: `${pounds} lb ${ounces} oz`,
    };
  }

  const countPackBefore = text.match(
    new RegExp(`\\b${NUMBER}[\\s-]*${COUNT_PACK_MULTIPLIER}.{0,36}?${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b(?:\\s+each)?`, "i"),
  );
  if (countPackBefore && !isSingularCountDescriptor(countPackBefore[2], countPackBefore[3])) {
    const packCount = Number(countPackBefore[1]);
    const amount = Number(countPackBefore[2]);
    return buildMeasurement(amount, "count", packCount, amount);
  }

  const countBeforePack = text.match(
    new RegExp(`\\b${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b(?:\\s+each)?.{0,24}?${NUMBER}[\\s-]*(?:packs?|pks?)\\b`, "i"),
  );
  if (countBeforePack && !isSingularCountDescriptor(countBeforePack[1], countBeforePack[2])) {
    const amount = Number(countBeforePack[1]);
    const packCount = Number(countBeforePack[3]);
    return buildMeasurement(amount, "count", packCount, amount);
  }

  const capacityBeforeOuterCount = text.match(
    new RegExp(`\\b${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b\\s+(?:each|per\\s+(?:${COUNT_CAPACITY_CONTAINER}))\\b.{0,24}?${NUMBER}[\\s-]*(?:count|ct)\\b`, "i"),
  );
  if (capacityBeforeOuterCount && !isSingularCountDescriptor(capacityBeforeOuterCount[1], capacityBeforeOuterCount[2])) {
    const amount = Number(capacityBeforeOuterCount[1]);
    const packCount = Number(capacityBeforeOuterCount[3]);
    return buildMeasurement(amount, "count", packCount, amount);
  }

  const outerCountBeforeCapacity = text.match(
    new RegExp(`\\b${NUMBER}[\\s-]*(?:count|ct)\\b.{0,24}?${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b\\s+(?:each|per\\s+(?:${COUNT_CAPACITY_CONTAINER}))\\b`, "i"),
  );
  if (outerCountBeforeCapacity && !isSingularCountDescriptor(outerCountBeforeCapacity[2], outerCountBeforeCapacity[3])) {
    const packCount = Number(outerCountBeforeCapacity[1]);
    const amount = Number(outerCountBeforeCapacity[2]);
    return buildMeasurement(amount, "count", packCount, amount);
  }

  const countCapacityBeforeMultiplier = text.match(
    new RegExp(`\\b${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b\\s*(?:[x×]\\s*|pack\\s+of\\s*)${NUMBER}\\s*(?:${COUNT_CAPACITY_CONTAINER}|packs?)\\b`, "i"),
  );
  if (countCapacityBeforeMultiplier && !isSingularCountDescriptor(countCapacityBeforeMultiplier[1], countCapacityBeforeMultiplier[2])) {
    const amount = Number(countCapacityBeforeMultiplier[1]);
    const packCount = Number(countCapacityBeforeMultiplier[3]);
    return buildMeasurement(amount, "count", packCount, amount);
  }

  const capacityBeforeNamedOuter = text.match(
    new RegExp(`\\b${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b\\s*(?:(?:each|per\\s+(?:${COUNT_CAPACITY_CONTAINER}))\\b\\s*)?(?:pack\\s+of\\s+${NUMBER}|${NUMBER}\\s+(?:${COUNT_CAPACITY_CONTAINER})\\b)`, "i"),
  );
  if (capacityBeforeNamedOuter && !isSingularCountDescriptor(capacityBeforeNamedOuter[1], capacityBeforeNamedOuter[2])) {
    const amount = Number(capacityBeforeNamedOuter[1]);
    const packCount = Number(capacityBeforeNamedOuter[3] ?? capacityBeforeNamedOuter[4]);
    return buildMeasurement(amount, "count", packCount, amount);
  }

  const namedOuterBeforeCapacity = text.match(
    new RegExp(`(?:\\bpack\\s+of\\s+${NUMBER}|\\b${NUMBER}\\s+(?:${COUNT_CAPACITY_CONTAINER})\\b).{0,24}?${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b\\s*(?:each|per\\s+(?:${COUNT_CAPACITY_CONTAINER}))\\b`, "i"),
  );
  if (namedOuterBeforeCapacity) {
    const packCount = Number(namedOuterBeforeCapacity[1] ?? namedOuterBeforeCapacity[2]);
    const amount = Number(namedOuterBeforeCapacity[3]);
    if (!isSingularCountDescriptor(namedOuterBeforeCapacity[3], namedOuterBeforeCapacity[4])) {
      return buildMeasurement(amount, "count", packCount, amount);
    }
  }

  const outerContainerTotal = /\btotal\b\s*$/i.test(text)
    ? text.match(new RegExp(`\\b${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}(?:${OUTER_CONTAINER_UNIT_PATTERN_SOURCE})\\b`, "i"))
    : null;
  if (outerContainerTotal) {
    return buildMeasurement(Number(outerContainerTotal[1]), "count");
  }

  // Explicit "each" metadata is the strongest multipack size signal. Check it
  // before looser catalog wording so a preceding nutrition claim cannot win.
  const packBeforeEach = text.match(
    new RegExp(`\\b${NUMBER}[\\s-]*(?:(?:pack|pk|count|ct|${MULTIPACK_CONTAINER_UNIT_PATTERN_SOURCE})\\b|[x×](?=\\s*\\d)).{0,64}?${NUMBER}\\s*(${CATALOG_UNIT})\\b\\s+each\\b`, "i"),
  );
  if (packBeforeEach) {
    const packCount = Number(packBeforeEach[1]);
    const amount = Number(packBeforeEach[2]);
    return buildCatalogMeasurement(amount, packBeforeEach[3], beverageContext, packCount);
  }

  const eachBeforePack = text.match(
    new RegExp(`\\b${NUMBER}\\s*(${CATALOG_UNIT})\\b\\s+each\\b.{0,24}?${NUMBER}[\\s-]*(?:pack|pk)\\b`, "i"),
  );
  if (eachBeforePack) {
    const amount = Number(eachBeforePack[1]);
    const packCount = Number(eachBeforePack[3]);
    return buildCatalogMeasurement(amount, eachBeforePack[2], beverageContext, packCount);
  }

  const sizeBeforeMultiplier = text.match(
    new RegExp(`\\b${NUMBER}\\s*(${AMBIGUOUS_CATALOG_UNIT})\\b\\s*(?:[x×]\\s*|pack\\s+of\\s*)${NUMBER}(?:\\s+(?:bags?|bottles?|boxes?|canisters?|cans?|cartons?|containers?|jars?|packs?|pouches?|rolls?|trays?|tubs?))?\\b`, "i"),
  );
  if (sizeBeforeMultiplier) {
    const amount = Number(sizeBeforeMultiplier[1]);
    const packCount = Number(sizeBeforeMultiplier[3]);
    return buildCatalogMeasurement(amount, sizeBeforeMultiplier[2], beverageContext, packCount);
  }

  const parenthesizedCountBeforePhysical = text.match(
    new RegExp(`\\(\\s*${NUMBER}\\s*\\).{0,24}?${NUMBER}\\s*(${AMBIGUOUS_CATALOG_UNIT})\\b\\s+(?:${PLURAL_MULTIPACK_CONTAINER})\\b`, "i"),
  );
  if (parenthesizedCountBeforePhysical) {
    const packCount = Number(parenthesizedCountBeforePhysical[1]);
    const amount = Number(parenthesizedCountBeforePhysical[2]);
    return buildCatalogMeasurement(amount, parenthesizedCountBeforePhysical[3], beverageContext, packCount);
  }

  // A generic count becomes a physical multipack only when the title also
  // names the outer containers. This avoids multiplying unrelated metadata
  // such as "12 Count, 1.69 lb" while preserving "12 Count 12 fl oz Cans".
  const countBeforePhysicalContainer = text.match(
    new RegExp(`\\b${NUMBER}[\\s-]*(?:count|ct)\\b.{0,64}?${NUMBER}\\s*(${AMBIGUOUS_CATALOG_UNIT})\\b\\s+(?:${PLURAL_MULTIPACK_CONTAINER})\\b`, "i"),
  );
  if (countBeforePhysicalContainer) {
    const packCount = Number(countBeforePhysicalContainer[1]);
    const amount = Number(countBeforePhysicalContainer[2]);
    return buildCatalogMeasurement(amount, countBeforePhysicalContainer[3], beverageContext, packCount);
  }

  const packBeforeMarker = text.match(
    new RegExp(`(?:\\b${NUMBER}[\\s-]*(?:(?:packs?|pks?|${MULTIPACK_CONTAINER_UNIT_PATTERN_SOURCE})\\b|[x×](?=\\s*\\d))|\\b(?:case|pack)\\s+of\\s+${NUMBER}\\b)`, "i"),
  );
  if (packBeforeMarker) {
    const markerEnd = (packBeforeMarker.index ?? 0) + packBeforeMarker[0].length;
    const tail = text.slice(markerEnd, markerEnd + 96);
    const perItemSizes = [...tail.matchAll(
      new RegExp(`\\b${NUMBER}\\s*(${AMBIGUOUS_CATALOG_UNIT})\\b`, "gi"),
    )].filter((match) => {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const prefix = tail.slice(0, start);
      const suffix = tail.slice(end);
      return !SERVING_AMOUNT_TAIL.test(suffix)
        && !SERVING_AMOUNT_PREFIX.test(prefix)
        && !/^\s*total\b/i.test(suffix)
        && !/\bnet\s*(?:wt|weight)\s*$/i.test(prefix);
    });
    const packageSize = perItemSizes.find((match) => {
      const end = (match.index ?? 0) + match[0].length;
      return SELLABLE_PACKAGE_AMOUNT_TAIL.test(tail.slice(end));
    });
    const perItemSize = packageSize ?? perItemSizes[0];
    if (perItemSize) {
      const packCount = Number(packBeforeMarker[1] ?? packBeforeMarker[2]);
      const amount = Number(perItemSize[1]);
      const packageIndex = packageSize ? perItemSizes.indexOf(packageSize) : -1;
      const earlierInnerAmount = packageIndex > 0 && perItemSizes
        .slice(0, packageIndex)
        .some((match) => {
          const end = (match.index ?? 0) + match[0].length;
          const suffix = tail.slice(end);
          return PER_PIECE_AMOUNT_TAIL.test(suffix)
            || /^\s*(?:\d+(?:\.\d+)?\s*)?(?:servings?|portions?|scoops?|doses?)\b/i.test(suffix);
        });
      if (earlierInnerAmount) {
        return buildCatalogMeasurement(amount, perItemSize[2], beverageContext);
      }
      return buildCatalogMeasurement(amount, perItemSize[2], beverageContext, packCount);
    }
  }

  const sizeBeforePackMarker = text.match(
    new RegExp(`\\b${NUMBER}\\s*(?:packs?|pks?|count|ct)\\b`, "i"),
  );
  if (sizeBeforePackMarker?.index !== undefined && sizeBeforePackMarker.index > 0) {
    const prefixStart = Math.max(0, sizeBeforePackMarker.index - 96);
    const prefix = text.slice(prefixStart, sizeBeforePackMarker.index);
    const perItemSizes = [...prefix.matchAll(
      new RegExp(`\\b${NUMBER}\\s*(${AMBIGUOUS_CATALOG_UNIT})\\b`, "gi"),
    )].filter((match) => {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const before = prefix.slice(0, start);
      const after = prefix.slice(end);
      return !SERVING_AMOUNT_TAIL.test(after)
        && !/^\s*total\b/i.test(after)
        && !/\bnet\s*(?:wt|weight)\s*$/i.test(before);
    });
    const perItemSize = perItemSizes.at(-1);
    if (perItemSize) {
      const amount = Number(perItemSize[1]);
      const packCount = Number(sizeBeforePackMarker[1]);
      return buildCatalogMeasurement(amount, perItemSize[2], beverageContext, packCount);
    }
  }

  const volumeMatches = [...text.matchAll(
    new RegExp(`\\b${NUMBER}[\\s-]*(fl\\s*oz|fluid ounces?|liters?|litres?|milliliters?|millilitres?|gallons?|gal|quarts?|qt|pints?|pt|ml|l)\\b`, "gi"),
  )].filter((match) => {
    const matchStart = match.index ?? 0;
    const matchEnd = (match.index ?? 0) + match[0].length;
    return !SERVING_AMOUNT_TAIL.test(text.slice(matchEnd))
      && !SERVING_AMOUNT_PREFIX.test(text.slice(0, matchStart));
  });
  const packageVolume = volumeMatches.find((match) => {
    const matchStart = match.index ?? 0;
    const matchEnd = (match.index ?? 0) + match[0].length;
    return SELLABLE_PACKAGE_AMOUNT_TAIL.test(text.slice(matchEnd))
      || SELLABLE_PACKAGE_AMOUNT_PREFIX.test(text.slice(0, matchStart));
  });
  const volume = packageVolume ?? volumeMatches[0];
  if (volume) return buildCatalogMeasurement(Number(volume[1]), volume[2], true);

  // Natural shopping shorthand such as "milk gallon" still expresses a
  // concrete package. This normalizes the unit generally; discovery code can
  // remove it from the retailer query while verification keeps the volume.
  if (/\bhalf(?:[ -]a)?\s+gallons?\b/i.test(text)) {
    return buildCatalogMeasurement(64, "fl oz", true);
  }
  const implicitSingleVolume = text.match(
    /\b(?:a\s+|one\s+)?(gallons?|gal|quarts?|qt|pints?|pt|liters?|litres?)\b/i,
  );
  if (implicitSingleVolume) {
    return buildCatalogMeasurement(1, implicitSingleVolume[1], true);
  }

  // Reconcile generic outer-count metadata with named inner contents. A
  // trailing "1 Count" describes one sellable box in titles such as
  // "6 Double Rolls, 1 Count", while "5-Blade ... 4 Count" uses the
  // hyphenated singular as a razor-model descriptor rather than capacity.
  const count = text.match(
    new RegExp(`\\b${NUMBER}[\\s-]*(count|ct|each)\\b`, "i"),
  );
  const countedContent = text.match(new RegExp(
    `\\b${NUMBER}${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b`,
    "i",
  ));
  const usableCountedContent = countedContent
    && !SINGULAR_COUNT_DESCRIPTOR.test(countedContent[0])
      ? countedContent
      : null;
  if (
    usableCountedContent
    && (!count || (Number(count[1]) === 1 && Number(usableCountedContent[1]) > 1))
  ) {
    return buildMeasurement(Number(usableCountedContent[1]), "count");
  }
  if (count) {
    return freshProduceContext && /^each$/i.test(count[2])
      ? buildProduceUnitMeasurement(Number(count[1]), "each")
      : buildMeasurement(Number(count[1]), "count");
  }

  if (usableCountedContent) {
    return buildMeasurement(Number(usableCountedContent[1]), "count");
  }

  // A metric size can legitimately precede a nutrition-product identity
  // ("500 g Whey Protein Powder"). Preserve that explicit package form, but
  // keep a bare claim such as "25 g protein per serving" out of fulfillment.
  const gramPackageProduct = text.match(
    new RegExp(`\\b${NUMBER}\\s*(${GRAM_UNIT})\\b${GRAM_PACKAGE_PRODUCT_TAIL}`, "i"),
  );
  if (gramPackageProduct) {
    return buildCatalogMeasurement(Number(gramPackageProduct[1]), gramPackageProduct[2], beverageContext);
  }

  const weightMatches = [...text.matchAll(
    new RegExp(`\\b${NUMBER}\\s*(${AMBIGUOUS_WEIGHT_UNIT})\\b`, "gi"),
  )].filter((match) => {
    const matchStart = match.index ?? 0;
    const matchEnd = (match.index ?? 0) + match[0].length;
    return !SERVING_AMOUNT_TAIL.test(text.slice(matchEnd))
      && !SERVING_AMOUNT_PREFIX.test(text.slice(0, matchStart));
  });
  // A weight immediately followed by a food-piece noun is normally the inner
  // piece size when a later package weight exists ("4 oz patties, 1 lb bag").
  // Keep it when it is the only weight so "one 4 oz fillet" still works.
  const packageWeight = weightMatches.find((match) => {
    const matchStart = match.index ?? 0;
    const matchEnd = (match.index ?? 0) + match[0].length;
    return SELLABLE_PACKAGE_AMOUNT_TAIL.test(text.slice(matchEnd))
      || SELLABLE_PACKAGE_AMOUNT_PREFIX.test(text.slice(0, matchStart));
  });
  const weight = packageWeight ?? weightMatches.find((match, index) => {
    const matchEnd = (match.index ?? 0) + match[0].length;
    return !PER_PIECE_AMOUNT_TAIL.test(text.slice(matchEnd))
      || index === weightMatches.length - 1;
  });
  if (weight) {
    return buildCatalogMeasurement(Number(weight[1]), weight[2], beverageContext);
  }

  const canCount = text.match(new RegExp(`\\b${NUMBER}\\s*cans?\\b`, "i"));
  if (canCount) return buildMeasurement(Number(canCount[1]), "count");

  const packOnly = text.match(new RegExp(`\\b${NUMBER}[\\s-]*(?:packs?|pks?)\\b`, "i"));
  if (packOnly) return buildMeasurement(Number(packOnly[1]), "count");

  if (/\b(?:one|a) dozen\b/i.test(text)) return buildMeasurement(12, "count");

  // Fresh produce often has no net weight because Walmart sells it as one
  // piece or one bunch. Preserve those retailer package units as count-based
  // measurements without relaxing weight/volume rules for other products.
  if (freshProduceContext) {
    const bunchCount = text.match(new RegExp(`\\b${NUMBER}\\s*bunch(?:es)?\\b`, "i"));
    if (bunchCount) return buildProduceUnitMeasurement(Number(bunchCount[1]), "bunch");
    if (/\bbunch(?:es)?\b/i.test(text)) return buildProduceUnitMeasurement(1, "bunch");
    if (/\beach\b/i.test(text)) return buildProduceUnitMeasurement(1, "each");
  }

  return undefined;
}

function normalizeUnit(value: string, beverageContext = false): Measurement["unit"] {
  if (/^fl|fluid/.test(value)) return "fl oz";
  if (/^lb|pound/.test(value)) return "lb";
  if (beverageContext) return "fl oz";
  return "oz";
}

export function calculateUnitPrice(
  price: number,
  measurement?: Measurement,
): { value: number; label: string } | undefined {
  if (!measurement || !Number.isFinite(price) || price < 0 || measurement.baseAmount <= 0) {
    return undefined;
  }

  let value = price / measurement.baseAmount;
  let suffix: string = measurement.baseUnit;

  if (measurement.kind === "count") {
    suffix = "each";
  } else if (measurement.unit === "lb" && !measurement.packCount) {
    value = price / measurement.amount;
    suffix = "lb";
  }

  return { value: round(value), label: `$${value.toFixed(2)}/${suffix}` };
}

export function calculateComparablePrice(
  product: WalmartProduct,
  requested?: Measurement,
) {
  if (!requested || !product.size || requested.kind !== product.size.kind) {
    return product.price;
  }

  const packagesNeeded = Math.max(
    1,
    Math.ceil((requested.baseAmount - 0.0001) / product.size.baseAmount),
  );
  return round(product.price * packagesNeeded, 2);
}
