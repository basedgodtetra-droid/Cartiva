export interface GrocerySuggestion {
  value: string;
  category: string;
  aliases: string[];
  kind?: "category" | "item" | "query" | "product";
  source?: "local" | "walmart_idea" | "walmart";
  productId?: string;
  itemId?: string;
  exactTitle?: string;
  brand?: string;
  brandSource?: "api" | "title";
  flavor?: string;
  format?: string;
  fulfillment?: Array<"pickup" | "delivery" | "shipping" | "in_store">;
  price?: number;
  packageSize?: string;
}

export interface ActiveListFragment {
  start: number;
  end: number;
  text: string;
}

export interface GrocerySuggestionQuery {
  prefix: string;
  query: string;
}

/**
 * Short enough to feel immediate while still avoiding a Walmart request for
 * every keystroke during normal typing.
 */
export const WALMART_PRODUCT_LOOKUP_DEBOUNCE_MS = 275;

const suggestion = (category: string, value: string, ...aliases: string[]): GrocerySuggestion => ({
  category,
  value,
  aliases,
  kind: "item",
});

const produceCategorySuggestion = (value: string, ...aliases: string[]): GrocerySuggestion => ({
  category: "Produce category",
  value,
  aliases,
  kind: "category",
});

const SUGGESTIONS: GrocerySuggestion[] = [
  suggestion("Canned seafood", "tuna in water", "tuna", "canned tuna", "can of tuna"),
  suggestion("Canned seafood", "albacore tuna", "tuna", "white tuna"),
  suggestion("Canned seafood", "tuna in oil", "tuna", "canned tuna"),
  suggestion("Canned seafood", "tuna pouches", "tuna", "tuna pouch"),
  suggestion("Eggs", "large white eggs 12 count", "eggs", "dozen eggs"),
  suggestion("Eggs", "large brown eggs 12 count", "eggs", "brown eggs"),
  suggestion("Eggs", "cage-free eggs 12 count", "eggs", "cage free eggs"),
  suggestion("Milk", "whole milk 1 gallon", "milk", "gallon milk"),
  suggestion("Milk", "2% milk 1 gallon", "milk", "two percent milk"),
  suggestion("Milk", "skim milk 1 gallon", "milk", "fat free milk"),
  suggestion("Milk", "unsweetened almond milk half gallon", "milk", "almond milk"),
  suggestion("Bread", "white sandwich bread", "bread", "white bread"),
  suggestion("Bread", "whole wheat bread", "bread", "wheat bread"),
  suggestion("Bread", "whole grain bread", "bread", "grain bread"),
  suggestion("Bread", "hamburger buns 8 count", "bread", "buns"),
  suggestion("Chicken", "boneless skinless chicken breast", "chicken", "chicken breast"),
  suggestion("Chicken", "fresh chicken thighs", "chicken", "chicken thighs"),
  suggestion("Chicken", "chicken drumsticks family pack", "chicken", "drumsticks"),
  suggestion("Bacon", "hickory smoked bacon 16 oz", "bacon"),
  suggestion("Bacon", "thick cut bacon 16 oz", "bacon"),
  suggestion("Yogurt", "plain Greek yogurt 32 oz", "yogurt", "greek yogurt"),
  suggestion("Yogurt", "vanilla Greek yogurt", "yogurt", "greek yogurt"),
  suggestion("Yogurt", "strawberry yogurt cups", "yogurt"),
  suggestion("Cheese", "American cheese slices", "cheese", "american cheese"),
  suggestion("Cheese", "Swiss cheese slices", "cheese", "swiss cheese"),
  suggestion("Cheese", "cheddar cheese block", "cheese", "cheddar cheese"),
  suggestion("Cheese", "shredded mozzarella cheese", "cheese", "mozzarella cheese"),
  suggestion("Cheese", "string cheese", "cheese", "cheese sticks"),
  suggestion("Soda", "Coca-Cola 12 pack cans", "coke", "coca cola", "regular coke", "soda"),
  suggestion("Soda", "Coca-Cola 24 pack cans", "coke", "coca cola", "regular coke", "soda"),
  suggestion("Soda", "Coca-Cola 2 liter bottle", "coke", "coca cola", "regular coke", "soda"),
  suggestion("Soda", "Coke Zero 12 pack cans", "coke", "coke zero", "zero sugar coke", "soda"),
  suggestion("Soda", "Coke Zero 24 pack cans", "coke", "coke zero", "zero sugar coke", "soda"),
  suggestion("Soda", "Diet Coke 12 pack cans", "coke", "diet coke", "soda"),
  suggestion("Soda", "Cherry Coke 12 pack cans", "coke", "cherry coke", "soda"),
  suggestion("Soda", "Sprite 12 pack cans", "sprite", "soda"),
  suggestion("Soda", "7 Up 12 pack cans", "7up", "7 up", "soda"),
  suggestion("Sports drinks", "Gatorade lemon lime 12 pack", "gatorade", "sports drink"),
  suggestion("Sparkling water", "bubly 8 pack", "bubly", "sparkling water"),
  suggestion("Water", "spring water 1 gallon", "water", "gallon water"),
  suggestion("Water", "purified water 24 pack", "water", "bottled water"),
  suggestion("Water", "purified water 40 pack", "water", "bottled water"),
  suggestion("Pasta", "penne pasta 16 oz", "pasta", "penne"),
  suggestion("Pasta", "spaghetti 16 oz", "pasta", "spaghetti"),
  suggestion("Pasta", "elbow macaroni 16 oz", "pasta", "macaroni"),
  suggestion("Beans", "black beans 15 oz", "beans", "black beans"),
  suggestion("Beans", "pinto beans 15 oz", "beans", "pinto beans"),
  suggestion("Beans", "red kidney beans 15 oz", "beans", "kidney beans"),
  produceCategorySuggestion("Fruit", "produce"),
  produceCategorySuggestion("Vegetables", "produce", "vegetable", "veggie", "veggies"),
  produceCategorySuggestion("Salad greens", "produce", "greens"),
  produceCategorySuggestion("Fresh herbs", "produce", "herbs"),
  suggestion("Produce", "bananas", "banana", "fruit"),
  suggestion("Produce", "apples", "apple", "fruit"),
  suggestion("Produce", "oranges", "orange", "fruit"),
  suggestion("Produce", "broccoli", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "asparagus", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "tomatoes", "tomato", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "carrots", "carrot", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "spinach", "vegetable", "vegetables", "veggie", "veggies", "salad greens"),
  suggestion("Produce", "onions", "onion", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "bell peppers", "bell pepper", "peppers", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "cucumber", "cucumbers", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "zucchini", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "cauliflower", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "squash", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "celery", "vegetable", "vegetables", "veggie", "veggies"),
  suggestion("Produce", "lettuce", "salad greens", "greens"),
  suggestion("Produce", "spring mix", "salad greens", "greens"),
  suggestion("Produce", "cilantro", "fresh herbs", "herbs"),
  suggestion("Produce", "parsley", "fresh herbs", "herbs"),
  suggestion("Produce", "basil", "fresh herbs", "herbs"),
  suggestion("Cereal", "Cheerios family size", "cereal", "cheerios"),
  suggestion("Cereal", "corn flakes family size", "cereal", "corn flakes"),
  suggestion("Coffee", "medium roast ground coffee 12 oz", "coffee", "ground coffee"),
  suggestion("Coffee", "dark roast K-Cup pods", "coffee", "k cups", "coffee pods"),
  suggestion("Chip flavor", "original potato chips", "chips", "potato chips"),
  suggestion("Chip flavor", "sour cream and onion potato chips", "chips", "potato chips", "sour cream chips"),
  suggestion("Chip flavor", "hot chips", "chips", "spicy chips"),
  suggestion("Chip flavor", "nacho cheese tortilla chips", "chips", "tortilla chips"),
  suggestion("Chip flavor", "barbecue potato chips", "chips", "potato chips", "bbq chips"),
  suggestion("Snacks", "Takis Fuego", "takis", "chips"),
  suggestion("Snacks", "Doritos nacho cheese family size", "doritos", "chips"),
  suggestion("Household", "AA batteries 4 pack", "batteries", "double a batteries"),
  suggestion("Household", "AAA batteries 4 pack", "batteries", "triple a batteries"),
  suggestion("Personal care", "Old Spice shampoo", "shampoo", "old spice"),
  suggestion("Personal care", "moisturizing shampoo", "shampoo"),
];

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9%]+/g, " ").replace(/\s+/g, " ").trim();
}

const OPTIONAL_VARIANTS = ["zero", "diet", "cherry", "vanilla", "strawberry"];

/**
 * Keep a broad category or brand query focused on its standard product. Variant
 * suggestions become eligible as soon as the shopper starts typing that variant.
 */
function hasUnrequestedVariant(label: string, query: string) {
  if (!/\b(?:coke|coca cola)\b/.test(label)) return false;
  const labelWords = new Set(label.split(" "));
  const queryWords = query.split(" ").filter(Boolean);
  const lastQueryWord = queryWords.at(-1) ?? "";

  return OPTIONAL_VARIANTS.some((variant) => {
    if (!labelWords.has(variant)) return false;
    if (queryWords.includes(variant)) return false;

    const isTypingVariant = queryWords.length > 1
      && lastQueryWord.length > 0
      && variant.startsWith(lastQueryWord);
    return !isTypingVariant;
  });
}

export function activeListFragment(value: string, caret = value.length): ActiveListFragment {
  const cursor = Math.max(0, Math.min(value.length, caret));
  const before = value.slice(0, cursor);
  const boundary = Math.max(before.lastIndexOf("\n"), before.lastIndexOf(","), before.lastIndexOf(";"));
  let start = boundary + 1;
  while (start < value.length && /\s/.test(value[start] ?? "")) start += 1;
  const remainder = value.slice(cursor);
  const nextOffsets = [remainder.indexOf("\n"), remainder.indexOf(","), remainder.indexOf(";")]
    .filter((offset) => offset >= 0);
  let end = nextOffsets.length ? cursor + Math.min(...nextOffsets) : value.length;
  while (end > start && /\s/.test(value[end - 1] ?? "")) end -= 1;
  return { start, end, text: value.slice(start, end) };
}

export function grocerySuggestions(fragment: string, limit = 6) {
  const { prefix: preservedPrefix, query: rawQuery } = grocerySuggestionQuery(fragment);
  const query = normalize(rawQuery);
  if (query.length < 2) return [];
  return SUGGESTIONS.flatMap((item, order) => {
    const label = normalize(item.value);
    const aliases = item.aliases.map(normalize);
    if (item.kind === "category" && label === query) return [];
    if (hasUnrequestedVariant(label, query)) return [];
    let rank: number | undefined;
    if (label.startsWith(query)) rank = 0;
    else if (aliases.some((alias) => alias.startsWith(query))) rank = 10;
    if (rank === undefined) return [];
    return [{ ...item, rank, order }];
  })
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .slice(0, Math.max(1, Math.min(8, limit)))
    .map((item) => ({
      value: `${preservedPrefix}${item.value}`.replace(/\s+/g, " ").trim(),
      category: item.category,
      aliases: item.aliases,
      kind: item.kind,
      source: "local" as const,
    }));
}

/**
 * Split a cart quantity from the active product phrase. The quantity remains in
 * the textarea while only the product intent is sent to Walmart typeahead.
 */
export function grocerySuggestionQuery(fragment: string): GrocerySuggestionQuery {
  const quantity = "(?:(?:qty\\s+)?\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const packaged = fragment.match(new RegExp(
    `^(\\s*${quantity}\\s+(?:packs?|bags?|boxes?|bottles?|cans?|cartons?)\\s+(?:of\\s+)?)(.+)$`,
    "i",
  ));
  if (packaged) return { prefix: packaged[1], query: packaged[2].trim() };

  const prefixed = fragment.match(new RegExp(`^(\\s*${quantity}\\s+)(.+)$`, "i"));
  const packageRequirement = /^(?:dozen|fl\s*oz|oz|ounces?|lb|lbs|pounds?|count|ct)\b/i;
  const numericBrand = /^\s*(?:7\s+up|3\s+musketeers)\b/i;
  const keepPrefix = prefixed
    && !packageRequirement.test(prefixed[2])
    && !numericBrand.test(fragment);
  return {
    prefix: keepPrefix ? prefixed[1] : "",
    query: (keepPrefix ? prefixed[2] : fragment).trim(),
  };
}

export function replaceListFragment(
  value: string,
  fragment: ActiveListFragment,
  replacement: string,
) {
  const nextValue = `${value.slice(0, fragment.start)}${replacement}${value.slice(fragment.end)}`;
  return { value: nextValue, caret: fragment.start + replacement.length };
}

/** Live catalog choices are structured metadata, not delimiter-safe list text. */
export function grocerySuggestionTextUpdate(
  value: string,
  fragment: ActiveListFragment,
  suggestion: GrocerySuggestion,
) {
  return suggestion.source === "walmart"
    ? { value, caret: fragment.end }
    : replaceListFragment(value, fragment, suggestion.value);
}

/** Exact store products lead; local refinements remain available underneath. */
export function prioritizeWalmartSuggestions(
  walmartSuggestions: GrocerySuggestion[],
  localSuggestions: GrocerySuggestion[],
  limit = 8,
) {
  const exactTitles = new Set(
    walmartSuggestions.map((item) => normalize(item.exactTitle ?? item.value)),
  );
  return [
    ...walmartSuggestions,
    ...localSuggestions.filter((item) => !exactTitles.has(normalize(item.value))),
  ].slice(0, Math.max(1, Math.min(10, limit)));
}

/** Keep only distinct, exact Walmart catalog products in the visible dropdown. */
export function walmartProductSuggestions(
  suggestions: GrocerySuggestion[],
  limit = 6,
) {
  const seenProducts = new Set<string>();
  return suggestions
    .filter((item) => {
      if (item.source !== "walmart" || (!item.productId && !item.itemId)) return false;
      const key = item.productId
        ? `product:${item.productId.toLowerCase()}`
        : item.itemId
          ? `item:${item.itemId}`
          : `title:${normalize(item.exactTitle ?? item.value)}`;
      if (seenProducts.has(key)) return false;
      seenProducts.add(key);
      return true;
    })
    .slice(0, Math.max(1, Math.min(6, limit)));
}

/** Every meaningful product phrase can use Walmart typeahead after the debounce. */
export function canLookupWalmartSuggestions(query: string, storeId?: string) {
  return /^\d{1,8}$/.test(storeId?.trim() ?? "")
    && query.replace(/\s+/g, " ").trim().length >= 3;
}

/** Keep the richer label when fields overlap (for example, "Bag" and "8 oz Bag"). */
export function conciseSuggestionMetadata(...values: Array<string | undefined>) {
  const output: string[] = [];
  for (const raw of values) {
    const value = raw?.replace(/\s+/g, " ").trim();
    if (!value) continue;
    const normalizedValue = normalize(value);
    const overlappingIndex = output.findIndex((existing) => {
      const normalizedExisting = normalize(existing);
      return normalizedExisting === normalizedValue
        || normalizedExisting.includes(normalizedValue)
        || normalizedValue.includes(normalizedExisting);
    });
    if (overlappingIndex < 0) {
      output.push(value);
      continue;
    }
    if (normalizedValue.length > normalize(output[overlappingIndex]).length) {
      output[overlappingIndex] = value;
    }
  }
  return output;
}
