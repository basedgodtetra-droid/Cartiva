import { parseShoppingList } from "./list-parser";

export interface GroceryClarificationOption {
  id: string;
  label: string;
  value: string;
}

export interface GroceryClarification {
  id: string;
  prompt: string;
  shortLabel: string;
  options: GroceryClarificationOption[];
}

export interface GroceryNotepadItem {
  id: string;
  raw: string;
  name: string;
  detail?: string;
  canonicalText: string;
  status: "ready" | "needs-detail";
  clarification?: GroceryClarification;
}

export interface GroceryInterpretation {
  items: GroceryNotepadItem[];
  serialized: string;
  readyCount: number;
  unresolvedCount: number;
  usedSmartSplit: boolean;
  limitReached: boolean;
  omittedCount: number;
}

interface InterpretOptions {
  undoImplicitSplits?: boolean;
}

const COUNT_PATTERN = /\b(\d{1,3})\s*[- ]?\s*(?:count|ct)\b/i;
const PACK_PATTERN = /\b(\d{1,3})\s*[- ]?\s*(?:pack|pk)\b/i;
const WEIGHT_PATTERN = /\b(\d+(?:\.\d+)?)\s*[- ]?\s*(lb|lbs|pounds?|oz|ounces?)\b/i;
const VOLUME_PATTERN = /\b(\d+(?:\.\d+)?)\s*(gallons?|gal|liters?|litres?|l|ml|fl\s*oz|fluid\s*ounces?)\b/i;
const HALF_GALLON_PATTERN = /\b(?:a\s+)?half[-\s]?gallon\b/i;
const BARE_GALLON_PATTERN = /\bgallon\b/i;
const DOZEN_PATTERN = /\b(?:(\d+|one|two|three|a)\s+)?dozen\b/i;
const BARE_EGG_COUNT_PREFIX = /\b(12|18|24)(?=\s+eggs?\b)/i;
const BARE_EGG_COUNT_SUFFIX = /\beggs?\s+(12|18|24)\b/i;

const EGG_COUNTS: GroceryClarificationOption[] = [
  { id: "eggs-12", label: "12 count", value: "12 count" },
  { id: "eggs-18", label: "18 count", value: "18 count" },
  { id: "eggs-24", label: "24 count", value: "24 count" },
];

const MILK_TYPES: GroceryClarificationOption[] = [
  { id: "milk-whole", label: "Whole", value: "whole" },
  { id: "milk-2", label: "2%", value: "2%" },
  { id: "milk-1", label: "1%", value: "1%" },
  { id: "milk-skim", label: "Skim", value: "skim" },
];

const MILK_SIZES: GroceryClarificationOption[] = [
  { id: "milk-half-gallon", label: "Half gallon", value: "half gallon" },
  { id: "milk-gallon", label: "1 gallon", value: "1 gallon" },
];

const YOGURT_SIZES: GroceryClarificationOption[] = [
  { id: "yogurt-single", label: "Single serve", value: "single serve" },
  { id: "yogurt-4-pack", label: "4 pack", value: "4 pack" },
  { id: "yogurt-16", label: "16 oz", value: "16 oz" },
  { id: "yogurt-32", label: "32 oz", value: "32 oz" },
];

const CHICKEN_WEIGHTS: GroceryClarificationOption[] = [
  { id: "chicken-1", label: "About 1 lb", value: "1 lb" },
  { id: "chicken-2", label: "About 2 lb", value: "2 lb" },
  { id: "chicken-3", label: "About 3 lb", value: "3 lb" },
];

function clean(value: string) {
  return value
    .normalize("NFKC")
    .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/[.!?]+$/, "")
    .trim();
}

function titleCase(value: string) {
  return value.replace(/(^|[\s/-])([a-z])/g, (_, prefix: string, letter: string) =>
    `${prefix}${letter.toUpperCase()}`,
  );
}

function stableId(value: string, index: number) {
  let hash = 2166136261;
  for (const character of `${index}:${value.toLowerCase()}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `grocery-${(hash >>> 0).toString(36)}`;
}

function explicitSegments(input: string) {
  return input
    .replace(/\r/g, "")
    .split(/\n+|\s*[;,]\s*/)
    .map(clean)
    .filter(Boolean)
    .slice(0, 25);
}

function dozenCount(value: string | undefined) {
  if (!value || value === "one" || value === "a") return 12;
  if (value === "two") return 24;
  if (value === "three") return 36;
  return Number(value) * 12;
}

function normalizeDetail(raw: string) {
  const lower = raw.toLowerCase();
  const halfGallon = lower.match(HALF_GALLON_PATTERN);
  if (halfGallon) return { source: halfGallon[0], detail: "Half gallon" };

  const count = lower.match(COUNT_PATTERN);
  if (count) return { source: count[0], detail: `${count[1]} ct` };

  const bareEggCountPrefix = lower.match(BARE_EGG_COUNT_PREFIX);
  if (bareEggCountPrefix) return { source: bareEggCountPrefix[1], detail: `${bareEggCountPrefix[1]} ct` };

  const bareEggCountSuffix = lower.match(BARE_EGG_COUNT_SUFFIX);
  if (bareEggCountSuffix) return { source: bareEggCountSuffix[1], detail: `${bareEggCountSuffix[1]} ct` };

  const dozen = lower.match(DOZEN_PATTERN);
  if (dozen) return { source: dozen[0], detail: `${dozenCount(dozen[1])} ct` };

  const pack = lower.match(PACK_PATTERN);
  if (pack) return { source: pack[0], detail: `${pack[1]} pack` };

  const weight = lower.match(WEIGHT_PATTERN);
  if (weight) {
    const unit = /^(?:lb|lbs|pound)/i.test(weight[2]) ? "lb" : "oz";
    return { source: weight[0], detail: `${weight[1]} ${unit}` };
  }

  const volume = lower.match(VOLUME_PATTERN);
  if (volume) {
    const rawUnit = volume[2].toLowerCase();
    const unit = /^(?:gallon|gal)/.test(rawUnit)
      ? Number(volume[1]) === 1 ? "gallon" : "gallons"
      : /^(?:liter|litre|l$)/.test(rawUnit)
        ? "L"
        : rawUnit === "ml"
          ? "mL"
          : "fl oz";
    return { source: volume[0], detail: `${volume[1]} ${unit}` };
  }

  if (/\bmilk\b/i.test(raw) && BARE_GALLON_PATTERN.test(raw)) {
    return { source: raw.match(BARE_GALLON_PATTERN)?.[0] ?? "gallon", detail: "1 gallon" };
  }

  return undefined;
}

function categoryFor(raw: string) {
  const lower = raw.toLowerCase();
  if (/\beggs?\b/.test(lower)) return "eggs";
  if (/\b(?:almond|oat|coconut|soy)\s+milk\b/.test(lower)) return "alt-milk";
  if (/\bmilk\b/.test(lower)) return "milk";
  if (/\byogurt\b/.test(lower)) return "yogurt";
  if (/\bchicken\s+breasts?\b/.test(lower)) return "chicken";
  if (/\bbread\b/.test(lower)) return "bread";
  if (/\b(?:coke|coca[-\s]?cola|pepsi|sprite|dr\.?\s*pepper|mountain\s+dew|7\s*up|soda)\b/.test(lower)) return "soda";
  return undefined;
}

function sodaVariantOptions(raw: string): GroceryClarificationOption[] {
  if (/\bpepsi\b/i.test(raw)) {
    return [
      { id: "pepsi-original", label: "Pepsi", value: "original" },
      { id: "pepsi-diet", label: "Diet Pepsi", value: "diet" },
      { id: "pepsi-zero", label: "Pepsi Zero Sugar", value: "zero" },
    ];
  }

  return [
    { id: "coke-original", label: "Coca-Cola", value: "original" },
    { id: "coke-diet", label: "Diet Coke", value: "diet" },
    { id: "coke-zero", label: "Coke Zero", value: "zero" },
  ];
}

function clarificationFor(raw: string, category: string | undefined): GroceryClarification | undefined {
  const lower = raw.toLowerCase();

  if (category === "eggs" && !COUNT_PATTERN.test(lower) && !DOZEN_PATTERN.test(lower) && !BARE_EGG_COUNT_PREFIX.test(lower) && !BARE_EGG_COUNT_SUFFIX.test(lower)) {
    return { id: "egg-count", prompt: "How many eggs?", shortLabel: "Needs a count", options: EGG_COUNTS };
  }

  if (category === "milk") {
    if (!/(?:\b(?:whole|skim|fat[-\s]?free|one percent|two percent)\b|[012]\s*%)/.test(lower)) {
      return { id: "milk-type", prompt: "What kind of milk?", shortLabel: "Needs a type", options: MILK_TYPES };
    }
    if (!VOLUME_PATTERN.test(lower) && !HALF_GALLON_PATTERN.test(lower) && !BARE_GALLON_PATTERN.test(lower)) {
      return { id: "milk-size", prompt: "What size milk?", shortLabel: "Needs a size", options: MILK_SIZES };
    }
  }

  if (category === "alt-milk" && !VOLUME_PATTERN.test(lower) && !HALF_GALLON_PATTERN.test(lower) && !BARE_GALLON_PATTERN.test(lower)) {
    return { id: "milk-size", prompt: "What size milk?", shortLabel: "Needs a size", options: MILK_SIZES };
  }

  if (category === "soda") {
    // A named soda is already actionable. In ordinary grocery language,
    // "coke" means standard Coca-Cola while "coke zero" already supplies the
    // material variety. Package format remains optional unless the shopper
    // explicitly asks for one; discovery can search broadly and verification
    // will preserve any supplied package constraint.
    const namedSoda = /\b(?:coke|coca[-\s]?cola|pepsi|sprite|dr\.?\s*pepper|mountain\s+dew|7\s*up)\b/.test(lower);
    if (/\bsoda\b/.test(lower) && !namedSoda) {
      return { id: "soda-variant", prompt: "Which soda?", shortLabel: "Needs a variety", options: sodaVariantOptions(raw) };
    }
  }

  if (category === "yogurt" && !PACK_PATTERN.test(lower) && !WEIGHT_PATTERN.test(lower) && !/\bsingle[-\s]serve\b/.test(lower)) {
    return { id: "yogurt-size", prompt: "What yogurt size?", shortLabel: "Needs a size", options: YOGURT_SIZES };
  }

  if (category === "chicken" && !WEIGHT_PATTERN.test(lower)) {
    return { id: "chicken-weight", prompt: "About how much chicken?", shortLabel: "Needs a weight", options: CHICKEN_WEIGHTS };
  }

  return undefined;
}

function itemFromRaw(rawValue: string, index: number): GroceryNotepadItem {
  const raw = clean(rawValue);
  const category = categoryFor(raw);
  const detailResult = normalizeDetail(raw);
  const nameSource = detailResult
    ? clean(raw.replace(new RegExp(detailResult.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "").replace(/^[,\s]+|[,\s]+$/g, ""))
    : raw;
  const name = titleCase(nameSource || raw);
  const detail = detailResult?.detail;
  const clarification = clarificationFor(raw, category);
  const canonicalText = detail ? `${name}, ${detail}` : name;

  return {
    id: stableId(raw, index),
    raw,
    name,
    detail,
    canonicalText,
    status: clarification ? "needs-detail" : "ready",
    clarification,
  };
}

export function serializeGroceryItems(items: GroceryNotepadItem[]) {
  return items.map((item) => item.canonicalText).join("\n");
}

export function interpretGroceryInput(
  input: string,
  options: InterpretOptions = {},
): GroceryInterpretation {
  const explicit = explicitSegments(input);
  const detectedItems = options.undoImplicitSplits ? explicit : parseShoppingList(input, 25);
  const rawItems = detectedItems.slice(0, 24);
  const items = rawItems.map(itemFromRaw);
  const unresolvedCount = items.filter((item) => item.status === "needs-detail").length;

  return {
    items,
    serialized: serializeGroceryItems(items),
    readyCount: items.length - unresolvedCount,
    unresolvedCount,
    usedSmartSplit: !options.undoImplicitSplits && items.length > explicit.length && explicit.length > 0,
    limitReached: detectedItems.length > 24,
    omittedCount: Math.max(0, detectedItems.length - 24),
  };
}

function sodaVariant(raw: string, value: string) {
  const isPepsi = /\bpepsi\b/i.test(raw);
  const replacement = isPepsi
    ? value === "diet" ? "Diet Pepsi" : value === "zero" ? "Pepsi Zero Sugar" : "Pepsi Original"
    : value === "diet" ? "Diet Coke" : value === "zero" ? "Coke Zero" : "Coca-Cola Original";
  if (/\b(?:coke|coca[-\s]?cola|pepsi|soda)\b/i.test(raw)) {
    return clean(raw.replace(/\b(?:coke|coca[-\s]?cola|pepsi|soda)\b/i, replacement));
  }
  return `${replacement} ${raw}`;
}

export function applyGroceryClarification(rawValue: string, clarificationId: string, value: string) {
  const raw = clean(rawValue);

  if (clarificationId === "milk-type") {
    const prefix = value === "whole" ? "Whole" : value === "skim" ? "Skim" : value;
    return clean(raw.replace(/\bmilk\b/i, `${prefix} milk`));
  }

  if (clarificationId === "soda-variant") return sodaVariant(raw, value);

  return clean(`${raw} ${value}`);
}
