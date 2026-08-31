/** Framework-neutral shopping-list parsing shared by every Cartiva client. */
const LEADING_REQUEST =
  /^(?:(?:please|could you|can you)\s+)?(?:(?:i|we)(?:'d| would)?\s+)?(?:need|want|would like|am looking for|get|buy|pick up)\s+/i;

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
const PACKAGE_ONLY =
  /^(?:(?:\d+(?:\.\d+)?\s*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|g|kg|ml|liters?|litres?|gal(?:lons?)?|count|ct|packs?|pk))|(?:\d+\s*(?:x|\u00d7)\s*\d+(?:\.\d+)?\s*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|g|kg|ml|liters?|litres?|gal(?:lons?)?|count|ct)))(?:\s+(?:each|cans?|bottles?|bags?|boxes?|cartons?|jars?|tubs?))?$/i;

/**
 * Common grocery anchors used only to detect missing separators. Longer phrases
 * win over their individual words, so "chicken breast" and "black beans" stay
 * together. This is intentionally deterministic and can later be supplemented
 * by an AI parser without changing the UI.
 */
const GROCERY_ANCHORS = [
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
  "turkey breast",
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
    ? between.match(/(?:^|\s)((?:[012]\s*%|whole|skim|fat[-\s]?free|(?:a\s+)?half[-\s]?gallon|\d+(?:\.\d+)?\s*(?:gal(?:lons?)?|gallons?|liters?|litres?|l|ml|fl\s*oz)))\s*$/i)?.[1]
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

export function parseShoppingList(input: string, limit = 24): string[] {
  if (!input.trim()) return [];

  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 24;
  if (safeLimit === 0) return [];
  const chunkScanLimit = safeLimit * 4;

  const withoutPrefix = input.trim().replace(LEADING_REQUEST, "");
  const { protectedValue, replacements } = protectCompounds(withoutPrefix);
  const chunks = protectedValue
    .replace(/\r/g, "")
    .split(/\n+|\s*[;,]\s*/)
    .flatMap((chunk) => chunk.split(/\s+(?:and then|and|plus|also)\s+/i))
    .slice(0, chunkScanLimit)
    .map((chunk) => {
      let restored = chunk;
      replacements.forEach((phrase, token) => {
        restored = restored.replaceAll(token, phrase);
      });
      return cleanItem(restored);
    })
    .filter(Boolean)
    .flatMap(splitImplicitGroceryItems);

  const combined: string[] = [];
  for (const chunk of chunks) {
    if ((QUALIFIER_ONLY.test(chunk) || PACKAGE_ONLY.test(chunk)) && combined.length > 0) {
      combined[combined.length - 1] = `${combined.at(-1)}, ${chunk}`;
    } else {
      combined.push(chunk);
    }
  }

  return combined.slice(0, safeLimit);
}
