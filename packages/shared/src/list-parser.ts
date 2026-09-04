import {
  COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE,
  COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE,
  COUNTED_CONTENT_UNIT_PATTERN_SOURCE,
} from "./package-grammar";
import { normalizeMeasurementFractions } from "./quantity-text";

/** Framework-neutral shopping-list parsing shared by every Cartiva client. */
const LEADING_REQUEST =
  /^(?:(?:recipe|meal plan)\s+needs?\s+|for\s+meal\s+prep\s*:\s*|shopping\s+list\s*:\s*|(?:(?:please|could you|can you)\s+)?(?:(?:i|we)(?:'d| would)?\s+)?(?:need|want|would like|am looking for|get|buy|pick up)\s+)/i;

const COMPOUND_PHRASES = [
  "mac and cheese",
  "salt and pepper",
  "peanut butter and jelly",
  "cookies and cream",
];

const QUALIFIER_ONLY =
  /^(?:generic is (?:okay|ok|fine)|cheapest(?: available)?|no\s+\w+(?:\s+\w+){0,2}|high protein|low sodium|sugar free|gluten free)$/i;

// Walmart catalog titles commonly put package metadata after commas. Once the
// comma is split, these fragments are not independent groceries and should
// stay with the product title immediately before them.
const PACKAGE_ONLY = new RegExp(
  `^(?:(?:\\d+(?:\\.\\d+)?\\s*(?:fl\\s*oz|fluid\\s*ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|milliliters?|millilitres?|ml|liters?|litres?|l|gal(?:lons?)?|quarts?|qt|pints?|pt|count|ct|packs?|pk))|(?:\\d+\\s*(?:x|\\u00d7)\\s*\\d+(?:\\.\\d+)?\\s*(?:fl\\s*oz|fluid\\s*ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|milliliters?|millilitres?|ml|liters?|litres?|l|gal(?:lons?)?|quarts?|qt|pints?|pt|count|ct|${COUNTED_CONTENT_UNIT_PATTERN_SOURCE}))|(?:\\d+${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(?:each|${COUNTED_CONTENT_UNIT_PATTERN_SOURCE}|cans?|bottles?|bags?|boxes?|cartons?|jars?|pouch(?:es)?|trays?|tubs?|bunches?|loaves?)))(?:\\s+(?:each|cans?|bottles?|bags?|boxes?|cartons?|jars?|pouch(?:es)?|trays?|tubs?))?(?:\\s*(?:x|\\u00d7)\\s*\\d{1,2})?$`,
  "i",
);

const LEAN_RATIO_ONLY = /^(\d{2})\s*[/:-]\s*(\d{1,2})$/i;
const BARE_QUANTITY_ONLY = /^(?:x\s*)?\d{1,3}$/i;
const PERCENT_ONLY = /^\d{1,2}\s*(?:%|percent)$/i;
const ATTRIBUTE_ONLY = /^(?:(?:boneless|skinless|bone[- ]?in|skin[- ]?on|large|small|medium|jumbo|plain|regular|thick[- ]?cut)(?:\s+|$)){1,4}$/i;
const SIMPLE_PACKAGE_ONLY = /^\d+(?:\.\d+)?\s*[- ]?\s*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|milliliters?|millilitres?|ml|liters?|litres?|l|gallons?|gal|quarts?|qt|pints?|pt|count|ct|packs?|pk|each|cans?|bottles?|bags?|boxes?|cartons?|jars?|pouch(?:es)?|trays?|tubs?|bunches?|loaves?|rolls?)$/i;

/**
 * Returns true only for fragments that cannot stand on their own as a useful
 * grocery identity. The check is deliberately strict so numeric product names
 * such as "7 Up" and "3 Musketeers" remain valid products.
 */
export function isOrphanGroceryModifier(value: string) {
  const fragment = cleanItem(value).replace(/\s+total$/i, "").trim();
  if (!fragment) return false;
  const ratio = fragment.match(LEAN_RATIO_ONLY);
  if (ratio) return Number(ratio[1]) + Number(ratio[2]) === 100;
  if (BARE_QUANTITY_ONLY.test(fragment)
    || PERCENT_ONLY.test(fragment)
    || ATTRIBUTE_ONLY.test(fragment)
    || QUALIFIER_ONLY.test(fragment)
    || SIMPLE_PACKAGE_ONLY.test(fragment)
    || PACKAGE_ONLY.test(fragment)) return true;

  const withoutAttributes = fragment
    .replace(/\b\d{2}\s*[/:-]\s*\d{1,2}\b/g, " ")
    .replace(/\b(?:boneless|skinless|bone[- ]?in|skin[- ]?on|large|small|medium|jumbo|plain|regular|thick[- ]?cut)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutAttributes !== fragment
    && (!withoutAttributes
      || SIMPLE_PACKAGE_ONLY.test(withoutAttributes)
      || PACKAGE_ONLY.test(withoutAttributes));
}

/**
 * Common grocery anchors used only to detect missing separators. Longer phrases
 * win over their individual words, so "chicken breast" and "black beans" stay
 * together. This is intentionally deterministic and can later be supplemented
 * by an AI parser without changing the UI.
 */
const GROCERY_ANCHORS = [
  "spaghetti pasta",
  "penne pasta",
  "rotini pasta",
  "macaroni pasta",
  "fettuccine pasta",
  "linguine pasta",
  "banana bread",
  "chicken sausage",
  "turkey sausage",
  "spinach pasta",
  "cheese crackers",
  "boneless skinless chicken breast",
  "new york strip steak",
  "filet mignon steak",
  "whole wheat bread",
  "sandwich bread",
  "sourdough bread",
  "white bread",
  "wheat bread",
  "whole milk",
  "skim milk",
  "laundry detergent",
  "dish soap",
  "greek yogurt",
  "chicken breast",
  "chicken breasts",
  "chicken thighs",
  "chicken drumsticks",
  "chicken wings",
  "whole chicken",
  "ground chicken",
  "ground beef",
  "ground turkey",
  "ground meat",
  "turkey breast",
  "turkey bacon",
  "whole turkey",
  "deli turkey",
  "ribeye steak",
  "sirloin steak",
  "t-bone steak",
  "pork chops",
  "pork loin",
  "pork shoulder",
  "ground pork",
  "pork ribs",
  "salmon fillet",
  "black beans",
  "kidney beans",
  "green beans",
  "peanut butter",
  "olive oil",
  "orange juice",
  "apple juice",
  "paper towels",
  "toilet paper",
  "trash bags",
  "pork bacon",
  "breakfast food",
  "taco shells",
  "ice cream",
  "cream cheese",
  "cottage cheese",
  "sour cream",
  "almond milk",
  "oat milk",
  "coconut milk",
  "coca-cola soda",
  "coca cola soda",
  "coke zero",
  "coca-cola",
  "coca cola",
  "dr pepper",
  "mountain dew",
  "sprite",
  "coke",
  "pepsi",
  "7 up",
  "7up",
  "takis",
  "doritos",
  "lay's",
  "lays",
  "cheetos",
  "eggs",
  "egg",
  "bacon",
  "milk",
  "chicken",
  "yogurt",
  "broccoli",
  "pasta",
  "spaghetti",
  "beans",
  "bread",
  "cheese",
  "butter",
  "rice",
  "cereal",
  "oatmeal",
  "apples",
  "apple",
  "bananas",
  "banana",
  "oranges",
  "orange",
  "onions",
  "onion",
  "tomatoes",
  "tomato",
  "potatoes",
  "potato",
  "lettuce",
  "spinach",
  "carrots",
  "carrot",
  "avocados",
  "avocado",
  "coffee",
  "tea",
  "flour",
  "sugar",
  "salt",
  "tortillas",
  "tortilla",
  "beef",
  "steak",
  "pork",
  "sausage",
  "turkey",
  "fish",
  "salmon",
  "tilapia",
  "cod",
  "catfish",
  "tuna",
  "shrimp",
  "juice",
  "soda",
  "water",
  "crackers",
  "cookies",
  "chips",
  "soup",
  "tofu",
] as const;

const ITEM_PREFIX = new RegExp(
  "(?:^|\\s)(" +
    "(?:(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|a|an)\\s+" +
      "(?:(?:packs|boxes|bags|bottles|cans|jars|cartons)\\s+)?)" +
    "|(?:(?:great value|oscar mayer|eggland(?:'s|s)? best|chobani|fage|barilla|goya|tyson)\\s+)" +
    "|(?:(?:organic|fresh|frozen|large|small|medium|jumbo|whole|skim|plain|boneless|skinless|bone[- ]?in|skin[- ]?on|ground|raw|cooked|thick[- ]?cut|\\d{2}\\s*[/:-]\\s*\\d{1,2})\\s+)" +
  ")$",
  "i",
);

interface GroceryAnchor {
  start: number;
  end: number;
  value: string;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const GROCERY_ANCHOR_PATTERNS = GROCERY_ANCHORS.map((anchor) => ({
  anchor,
  expression: new RegExp(`\\b${escapeRegExp(anchor).replaceAll(" ", "\\s+")}\\b`, "gi"),
}));

const COMPACTED_GROCERY_PHRASES = GROCERY_ANCHORS
  .filter((anchor) => anchor.includes(" "))
  .map((anchor) => ({ compact: anchor.replaceAll(" ", ""), expanded: anchor }))
  .sort((left, right) => right.compact.length - left.compact.length);

// Keep typo repair deliberately allow-listed. A broad edit-distance pass can
// silently mutate valid grocery attributes (for example, creamy -> cream or
// block -> black), which is more dangerous than leaving an unknown word for
// safe review.
const COMMON_GROCERY_TYPOS: Record<string, string> = {
  avacado: "avocado",
  banannas: "bananas",
  brocolli: "broccoli",
  chiken: "chicken",
  chickn: "chicken",
  cok: "coke",
  potatos: "potatoes",
  turky: "turkey",
  tomatos: "tomatoes",
  yogrt: "yogurt",
};

function conservativeGroceryTypo(token: string) {
  return COMMON_GROCERY_TYPOS[token.toLowerCase()] ?? token;
}

/**
 * Repairs only high-confidence human grocery shorthand before list splitting.
 * The rules are category-neutral: compacted known phrases, unit spacing, a
 * single unambiguous edit, and a lean/fat ratio in an explicit ground-meat
 * context. Original intent is never expanded with a new product attribute.
 */
export function normalizeHumanGroceryText(input: string) {
  const compactUnit = "(?:lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|fl\\s*oz|ounces?|oz|milliliters?|millilitres?|ml|liters?|litres?|l|count|ct|packs?|pk|bars?|blades?|pacs?|pieces?|pods?|rolls?|sheets?|wipes?|cans?|bottles?|bags?|boxes?|cartons?|jars?|pouch(?:es)?|trays?|tubs?|bunches?|loaves?|gallons?|gal|quarts?|qt|pints?|pt)";
  let value = normalizeMeasurementFractions(input)
    .replace(new RegExp(`([a-z])(?=\\d+(?:\\.\\d+)?(?:\\s*)?${compactUnit}\\b)`, "gi"), "$1 ")
    .replace(new RegExp(`(\\d)(?=${compactUnit}\\b)`, "gi"), "$1 ")
    .replace(/%(?=[a-z])/gi, "% ");

  for (const phrase of COMPACTED_GROCERY_PHRASES) {
    value = value.replace(
      new RegExp(`\\b${escapeRegExp(phrase.compact)}\\b`, "gi"),
      phrase.expanded,
    );
  }

  value = value.replace(/\b[a-z]{3,}\b/gi, (token) => conservativeGroceryTypo(token));
  value = value.replace(
    /\b(\d{2})\s+(\d{1,2})(?=\s+(?:ground\s+)?(?:beef|turkey|meat)\b)/gi,
    (match, leanText: string, fatText: string) => (
      Number(leanText) + Number(fatText) === 100 ? `${leanText}/${fatText}` : match
    ),
  );
  value = value.replace(
    /\b((?:ground\s+)(?:beef|turkey|meat))\s+(\d{2})\s+(\d{1,2})\b/gi,
    (match, productText: string, leanText: string, fatText: string) => (
      Number(leanText) + Number(fatText) === 100
        ? `${productText} ${leanText}/${fatText}`
        : match
    ),
  );
  return value.replace(/[ \t]+/g, " ").trim();
}

function protectCompounds(value: string) {
  let protectedValue = value;
  const replacements = new Map<string, string>();

  COMPOUND_PHRASES.forEach((phrase, index) => {
    const token = `__compound_${index}__`;
    protectedValue = protectedValue.replace(
      new RegExp(phrase.replaceAll(" ", "\\s+"), "gi"),
      token,
    );
    replacements.set(token, phrase);
  });

  return { protectedValue, replacements };
}

function cleanItem(value: string) {
  return value
    .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findGroceryAnchors(value: string): GroceryAnchor[] {
  const candidates = GROCERY_ANCHOR_PATTERNS.flatMap(({ expression }) => {
    const matches: GroceryAnchor[] = [];
    for (const match of value.matchAll(expression)) {
      const start = match.index ?? 0;
      matches.push({ start, end: start + match[0].length, value: match[0] });
    }
    return matches;
  }).sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  const resolved: GroceryAnchor[] = [];
  for (const candidate of candidates) {
    const previous = resolved.at(-1);
    if (!previous || candidate.start >= previous.end) resolved.push(candidate);
  }
  return resolved;
}

function implicitItemBoundary(value: string, previous: GroceryAnchor, next: GroceryAnchor) {
  const between = value.slice(previous.end, next.start);
  const previousProduct = previous.value.toLowerCase();
  const nextProduct = next.value.toLowerCase();
  const nextIsMilk = nextProduct.includes("milk");
  const nextIsSoda = /^(?:coke(?: zero)?|coca[-\s]?cola(?: soda)?|pepsi|sprite|dr pepper|mountain dew|7\s?up|soda)$/.test(nextProduct);
  const previousIsSoda = /^(?:coke(?: zero)?|coca[-\s]?cola(?: soda)?|pepsi|sprite|dr pepper|mountain dew|7\s?up|soda)$/.test(previousProduct);
  const milkPrefix = nextIsMilk
    ? between.match(/(?:^|\s)((?:[012]\s*%|whole|skim|fat[-\s]?free|(?:a\s+)?half[-\s]?gallon|\d+(?:\.\d+)?\s*(?:gal(?:lons?)?|gallons?|liters?|litres?|l|ml|fl\s*oz)|\d{1,2}))\s*$/i)?.[1]
    : undefined;
  const sodaPrefix = nextIsSoda && !previousIsSoda
    ? between.match(/(?:^|\s)((?:diet|zero\s+sugar|original|regular|\d{1,3}\s*[- ]?\s*(?:pack|pk)))\s*$/i)?.[1]
    : undefined;
  const eggPrefix = /^eggs?$/.test(nextProduct)
    ? between.match(/(?:^|\s)((?:(?:12|18|24)\s*[- ]?\s*(?:count|ct)?|(?:one|two|a)?\s*dozen))\s*$/i)?.[1]
    : undefined;
  const semanticPrefix = milkPrefix ?? sodaPrefix ?? eggPrefix;

  if (semanticPrefix) {
    return previous.end + between.toLowerCase().lastIndexOf(semanticPrefix.toLowerCase());
  }

  const prefix = between.match(ITEM_PREFIX)?.[1];
  return prefix ? previous.end + between.length - prefix.length : next.start;
}

function splitImplicitGroceryItems(value: string) {
  const anchors = findGroceryAnchors(value);
  if (anchors.length <= 1) return [cleanItem(value)];

  const boundaries = [0];
  for (let index = 1; index < anchors.length; index += 1) {
    boundaries.push(implicitItemBoundary(value, anchors[index - 1], anchors[index]));
  }
  boundaries.push(value.length);

  return boundaries
    .slice(0, -1)
    .map((start, index) => cleanItem(value.slice(start, boundaries[index + 1])))
    .filter(Boolean);
}

export function normalizeShoppingItem(value: string) {
  return cleanItem(value).toLowerCase();
}

export function inspectShoppingList(input: string, limit = 24, splitImplicit = true) {
  const unattachedModifiers: string[] = [];
  if (!input.trim()) return { items: [], unattachedModifiers };

  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 24;
  if (safeLimit === 0) return { items: [], unattachedModifiers };
  const chunkScanLimit = safeLimit * 4;

  const withoutPrefix = normalizeHumanGroceryText(input).replace(LEADING_REQUEST, "");
  const { protectedValue, replacements } = protectCompounds(withoutPrefix);
  const restoreCompounds = (chunk: string) => {
    let restored = chunk;
    replacements.forEach((phrase, token) => {
      restored = restored.replaceAll(token, phrase);
    });
    return cleanItem(restored);
  };
  const chunks = protectedValue
    .replace(/\r/g, "")
    .split(/\n+|\s*;\s*/)
    .slice(0, chunkScanLimit)
    .flatMap((strongSegment) => {
      const candidates = strongSegment
        .split(/\s*,\s*/)
        .flatMap((chunk) => chunk.split(/\s+(?:and then|and|plus|also)\s+/i))
        .map(restoreCompounds)
        .filter(Boolean)
        .flatMap((value) => splitImplicit ? splitImplicitGroceryItems(value) : [value]);
      const repaired: string[] = [];
      const prefixModifiers: string[] = [];
      for (const candidate of candidates) {
        if (isOrphanGroceryModifier(candidate)) {
          if (repaired.length > 0) {
            repaired[repaired.length - 1] = `${repaired.at(-1)}, ${candidate}`;
          } else prefixModifiers.push(candidate);
          continue;
        }
        repaired.push(prefixModifiers.length ? `${candidate}, ${prefixModifiers.splice(0).join(", ")}` : candidate);
      }
      unattachedModifiers.push(...prefixModifiers);
      return repaired;
    })
    .slice(0, chunkScanLimit);

  return { items: chunks.slice(0, safeLimit), unattachedModifiers };
}

export function parseShoppingList(input: string, limit = 24): string[] {
  return inspectShoppingList(input, limit).items;
}
