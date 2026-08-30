import type { ExplicitRequestDetails, ParsedListItem } from "./types.js";

const COMPOUND_AND_PHRASES = [
  "mac and cheese",
  "salt and pepper",
  "peanut butter and jelly",
  "cookies and cream",
] as const;

const BRAND_PATTERNS: Array<{ canonical: string; pattern: RegExp }> = [
  { canonical: "Coca-Cola", pattern: /\b(?:coca[ -]?cola|coke(?:\s+zero)?)\b/i },
  { canonical: "Sprite", pattern: /\bsprite\b/i },
  { canonical: "7 Up", pattern: /\b7\s*up\b/i },
  { canonical: "Gatorade", pattern: /\bgatorade\b/i },
  { canonical: "Takis", pattern: /\btakis\b/i },
  { canonical: "Pepsi", pattern: /\bpepsi\b/i },
  { canonical: "Fage", pattern: /\bfage\b/i },
  { canonical: "Doritos", pattern: /\bdoritos\b/i },
  { canonical: "Lay's", pattern: /\blay'?s\b/i },
  { canonical: "Dr Pepper", pattern: /\bdr\.?\s+pepper\b/i },
];

const GROCERY_ANCHORS = [
  "greek yogurt", "chicken breast", "ground beef", "black beans", "peanut butter",
  "orange juice", "apple juice", "almond milk", "oat milk", "coke zero",
  "coca cola", "dr pepper", "7 up", "mac and cheese", "eggs", "egg", "bacon",
  "milk", "chicken", "yogurt", "bread", "cheese", "rice", "cereal", "apples",
  "apple", "bananas", "banana", "oranges", "orange", "onions", "onion",
  "tomatoes", "tomato", "potatoes", "potato", "lettuce", "spinach", "carrots",
  "carrot", "avocados", "avocado", "produce", "vegetables", "vegetable", "veggies",
  "veggie", "bell peppers", "bell pepper", "asparagus", "peppers", "cucumbers",
  "cucumber", "zucchini", "squash", "cauliflower", "celery", "salad greens",
  "fresh herbs", "spring mix", "cilantro", "parsley", "basil", "coffee", "beef", "pork", "salmon", "tuna",
  "shrimp", "juice", "soda", "water", "chips", "sprite", "coke", "pepsi",
  "gatorade", "takis", "doritos", "broccoli", "pasta", "beans", "butter",
] as const;

const ANCHOR_PATTERN = new RegExp(
  `\\b(?:${[...GROCERY_ANCHORS]
    .sort((a, b) => b.length - a.length)
    .map((anchor) => anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"))
    .join("|")})\\b`,
  "gi",
);

const WORD_QUANTITIES: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

// Walmart catalog titles often place the sellable package after a comma.
// Those measurement-only chunks are metadata for the prior product, not a
// second grocery item (for example "Eggs, 12 Count").
const PACKAGE_ONLY = /^(?:(?:\d+(?:\.\d+)?\s*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|g|kg|ml|liters?|litres?|gal(?:lons?)?|count|ct|packs?|pk))|(?:\d+\s*[x×]\s*\d+(?:\.\d+)?\s*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|g|kg|ml|liters?|litres?|gal(?:lons?)?|count|ct)))(?:\s+(?:each|cans?|bottles?|bags?|boxes?|cartons?|jars?|tubs?))?$/i;

function stableId(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `item-${(hash >>> 0).toString(36)}`;
}

export function normalizeListItem(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "")
    .replace(/[.!?]+$/g, "");
}

function protectCompounds(value: string) {
  let protectedValue = value;
  const replacements = new Map<string, string>();
  COMPOUND_AND_PHRASES.forEach((phrase, index) => {
    const marker = `__cartiva_compound_${index}__`;
    const pattern = new RegExp(phrase.replace(/ /g, "\\s+"), "gi");
    if (pattern.test(protectedValue)) {
      protectedValue = protectedValue.replace(pattern, marker);
      replacements.set(marker, phrase);
    }
  });
  return { protectedValue, replacements };
}

function splitInput(value: string) {
  const { protectedValue, replacements } = protectCompounds(value);
  const chunks = protectedValue
    .split(/(?:\r?\n|[,;]|\s+\band\b\s+)/i)
    .map((part) => {
      let restored = part;
      for (const [marker, phrase] of replacements) restored = restored.replace(marker, phrase);
      return restored.trim().replace(/^(?:and|then)\s+/i, "");
    })
    .filter(Boolean);

  const combined: string[] = [];
  for (const chunk of chunks) {
    if (PACKAGE_ONLY.test(chunk) && combined.length > 0) {
      combined[combined.length - 1] = `${combined.at(-1)}, ${chunk}`;
    } else {
      combined.push(chunk);
    }
  }
  return combined.flatMap(splitAdjacentGroceryAnchors);
}

function splitAdjacentGroceryAnchors(value: string) {
  const matches = [...value.matchAll(new RegExp(ANCHOR_PATTERN.source, "gi"))];
  if (matches.length < 2) return [value];
  const boundaries = matches.slice(1).map((match, index) => {
    const nextAnchor = match.index ?? 0;
    const previous = matches[index];
    const previousEnd = (previous.index ?? 0) + previous[0].length;
    const between = value.slice(previousEnd, nextAnchor);
    const nextItemPrefix = between.match(
      /(?:^|\s)((?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a)\s+(?:(?:packs?|bags?|boxes?|bottles?|cans?|cartons?|dozen|oz|ounces?|lb|lbs|pounds?|count|ct)\s+)?|(?:plain|fresh|frozen|boneless|bone-in|whole|skim|generic|cheapest)\s+|(?:great\s+value|coca[ -]?cola|dr\.?\s+pepper)\s+)+)$/i,
    )?.[1];
    return nextItemPrefix ? nextAnchor - nextItemPrefix.length : nextAnchor;
  });
  const starts = [0, ...boundaries];
  const ends = [...boundaries, value.length];
  return starts.map((start, index) => value.slice(start, ends[index]).trim()).filter(Boolean);
}

function extractCartQuantity(text: string) {
  if (/^\s*(?:a|one)?\s*dozen\b/i.test(text)) {
    return { text: text.trim(), quantity: 1 };
  }
  const packageMatch = text.match(
    /^\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:packs?|bags?|boxes?|bottles?|cans?|cartons?)\s+(.+)$/i,
  );
  if (packageMatch) {
    const quantity = Number(packageMatch[1]) || WORD_QUANTITIES[packageMatch[1].toLowerCase()] || 1;
    return { text: packageMatch[2].trim(), quantity: Math.max(1, Math.min(24, quantity)) };
  }
  const match = text.match(/^\s*(?:(\d+)\s*[x×]\s+|(?:qty\s+)?(\d+)\s+)(.+)$/i);
  if (!match) return { text: text.trim(), quantity: 1 };
  const remainder = match[3].trim();
  if (/^(?:oz|ounce|ounces|lb|lbs|pound|pounds|pack|pk|count|ct|gallon|liter)\b/i.test(remainder)) {
    return { text: text.trim(), quantity: 1 };
  }
  return { text: remainder, quantity: Math.max(1, Math.min(24, Number(match[1] ?? match[2]))) };
}

export function extractExplicitRequestDetails(text: string): ExplicitRequestDetails {
  const brand = BRAND_PATTERNS.find(({ pattern }) => pattern.test(text))?.canonical;
  const sizeMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(fl\s*oz|oz|ounces?|lb|lbs|pounds?|gallons?|gal|liters?|l)\b/i);
  const packMatch = text.match(/\b(\d+)\s*(?:-|\s)?(?:pack|pk|count|ct)\b/i);
  const dozenCount = /\b(?:a|one)?\s*dozen\b/i.test(text) ? 12 : undefined;
  return {
    brand,
    size: sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].replace(/\s+/g, " ")}` : undefined,
    packCount: packMatch ? Number(packMatch[1]) : dozenCount,
  };
}

export function parseShoppingList(value: string): ParsedListItem[] {
  const deduplicated = new Map<string, ParsedListItem>();
  for (const rawPart of splitInput(value)) {
    const extracted = extractCartQuantity(rawPart);
    const text = extracted.text.replace(/^(?:please\s+)?(?:get|buy|add|need)\s+/i, "").trim();
    const normalizedText = normalizeListItem(text);
    if (!normalizedText) continue;
    const existing = deduplicated.get(normalizedText);
    if (existing) {
      existing.quantity = Math.min(24, existing.quantity + extracted.quantity);
      continue;
    }
    deduplicated.set(normalizedText, {
      id: stableId(normalizedText),
      text,
      normalizedText,
      quantity: extracted.quantity,
      ...extractExplicitRequestDetails(text),
    });
  }
  return [...deduplicated.values()].slice(0, 24);
}
