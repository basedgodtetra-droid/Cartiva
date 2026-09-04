import { normalizeHumanGroceryText, parseShoppingList } from "./list-parser";
import {
  COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE,
  COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE,
  COUNTED_CONTENT_UNIT_PATTERN_SOURCE,
} from "./package-grammar";
import { AttributeOrigin, type AttributeOrigin as AttributeOriginValue } from "./types";

export type GroceryProteinCategory = "meat" | "poultry" | "seafood";

export type GroceryProteinAttributeKey =
  | "animal"
  | "cut"
  | "form"
  | "leanRatio"
  | "preparation"
  | "species"
  | "cookingState"
  | "size"
  | "style"
  | "weight"
  | "quantity";

export interface GroceryProteinAttribute {
  value: string;
  origin: AttributeOriginValue;
}

export interface GroceryProteinIntent {
  category: GroceryProteinCategory;
  animal?: GroceryProteinAttribute;
  cut?: GroceryProteinAttribute;
  form?: GroceryProteinAttribute;
  leanRatio?: GroceryProteinAttribute;
  preparation?: GroceryProteinAttribute;
  species?: GroceryProteinAttribute;
  cookingState?: GroceryProteinAttribute;
  size?: GroceryProteinAttribute;
  style?: GroceryProteinAttribute;
  weight?: GroceryProteinAttribute;
  quantity?: GroceryProteinAttribute;
}

export type GroceryProteinOriginMap = Record<
  string,
  Partial<Record<GroceryProteinAttributeKey, AttributeOriginValue>>
>;

export interface GroceryClarificationOption {
  id: string;
  label: string;
  value: string;
  attributeKey?: GroceryProteinAttributeKey;
  normalizedValue?: string;
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
  proteinIntent?: GroceryProteinIntent;
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

export interface InterpretOptions {
  undoImplicitSplits?: boolean;
  proteinOrigins?: GroceryProteinOriginMap;
}

const COUNT_PATTERN = /\b(\d{1,3})\s*[- ]?\s*(?:count|ct)\b(?:\s+(bags?|bottles?|box(?:es)?|cans?|cartons?|jars?|pouch(?:es)?|trays?|tubs?)\b(?!\s+(?:opener|cutter|holder|rack|dispenser|brush|cleaner|liner|clip|labels?)))?/i;
const PACK_PATTERN = /\b(\d{1,3})\s*[- ]?\s*(?:pack|pk)\b/i;
const WEIGHT_PATTERN = /\b(\d+(?:\.\d+)?)\s*[- ]?\s*(lbs?|pounds?|oz|ounces?|kilograms?|kgs?|kg|grams?|g)\b(?:\s+(bags?|bottles?|box(?:es)?|cans?|cartons?|jars?|pouch(?:es)?|trays?|tubs?)\b(?!\s+(?:opener|cutter|holder|rack|dispenser|brush|cleaner|liner|clip|labels?)))?/i;
const VOLUME_PATTERN = /\b(\d+(?:\.\d+)?)\s*(gallons?|gal|quarts?|qt|pints?|pt|liters?|litres?|l|ml|fl\s*oz|fluid\s*ounces?)\b(?:\s+(bags?|bottles?|box(?:es)?|cans?|cartons?|jars?|pouch(?:es)?|trays?|tubs?)\b(?!\s+(?:opener|cutter|holder|rack|dispenser|brush|cleaner|liner|clip|labels?)))?/i;
const HALF_GALLON_PATTERN = /\b(?:a\s+)?half[-\s]?gallon\b/i;
const BARE_GALLON_PATTERN = /\bgallon\b/i;
const DOZEN_PATTERN = /\b(?:(\d+|one|two|three|four|a)\s+)?dozen\b/i;
const BARE_EGG_COUNT_PREFIX = /\b(12|18|24)(?=\s+eggs?\b)/i;
const BARE_EGG_COUNT_SUFFIX = /\beggs?\s+(12|18|24)\b/i;
const CONTAINER_QUANTITY_PATTERN = /\b(\d{1,2})\s+(cans?|bottles?|jars?|bags?|boxes?|cartons?|pouch(?:es)?|trays?|tubs?|bunches?|loaves?)\b/i;
const COUNT_UNIT_QUANTITY_PATTERN = new RegExp(
  `\\b(\\d{1,3})${COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE}${COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE}(${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b\\s*$`,
  "i",
);
const MULTIPACK_DETAIL_PATTERN = new RegExp(
  `\\b(\\d{1,3})\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)[\\s-]*(fl\\s*oz|fluid\\s*ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|milliliters?|millilitres?|ml|liters?|litres?|l|gallons?|gal|quarts?|qt|pints?|pt|count|ct|${COUNTED_CONTENT_UNIT_PATTERN_SOURCE})\\b(?:\\s+(?:each|bags?|bottles?|boxes?|cans?|cartons?|jars?|pouch(?:es)?|trays?|tubs?))?`,
  "i",
);
const CART_QUANTITY_SUFFIX_PATTERN = /\s+(?:x|×)\s*(\d{1,2})\s*$/i;
const TRAILING_TOTAL_PATTERN = /\s+total\s*$/i;
const LEADING_MILK_VOLUME_QUANTITY_PATTERN = /^\s*(\d{1,2})\s+(.+?\bmilk)\s+(gallons?|gal)\s*$/i;
const LEADING_VOLUME_OF_PRODUCT_PATTERN = /^\s*(\d{1,2})\s+(gallons?|gal|quarts?|qt|pints?|pt)\s+(?:of\s+)?(.+)$/i;
const LEADING_EACH_QUANTITY_PATTERN = /^\s*(\d{1,2})\s+(bananas?|apples?|oranges?|avocados?|onions?|tomatoes?|potatoes?|lemons?|limes?)\b/i;
const TRAILING_EACH_QUANTITY_PATTERN = /\b(bananas?|apples?|oranges?|avocados?|onions?|tomatoes?|potatoes?|lemons?|limes?)\s+(\d{1,2})\s*$/i;

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

function simpleOptions(
  prefix: string,
  values: Array<[label: string, value: string]>,
): GroceryClarificationOption[] {
  return values.map(([label, value]) => ({
    id: `${prefix}-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    label,
    value,
  }));
}

const BEAN_KINDS = simpleOptions("beans", [
  ["Black", "black"],
  ["Pinto", "pinto"],
  ["Kidney", "kidney"],
  ["Chickpeas", "chickpeas"],
]);

const BREAD_KINDS = simpleOptions("bread", [
  ["White", "white"],
  ["Whole wheat", "whole wheat"],
  ["Sourdough", "sourdough"],
  ["Gluten free", "gluten free"],
]);

const YOGURT_KINDS = simpleOptions("yogurt", [
  ["Greek", "Greek"],
  ["Regular", "regular"],
  ["Skyr", "skyr"],
]);

const PASTA_KINDS = simpleOptions("pasta", [
  ["Spaghetti", "spaghetti"],
  ["Penne", "penne"],
  ["Rotini", "rotini"],
  ["Macaroni", "macaroni"],
]);

const RICE_KINDS = simpleOptions("rice", [
  ["White", "white"],
  ["Brown", "brown"],
  ["Jasmine", "jasmine"],
  ["Basmati", "basmati"],
]);

const CHEESE_KINDS = simpleOptions("cheese", [
  ["Cheddar", "cheddar"],
  ["Mozzarella", "mozzarella"],
  ["Swiss", "swiss"],
  ["American", "american"],
  ["Cream cheese", "cream"],
]);

const CEREAL_KINDS = simpleOptions("cereal", [
  ["Cheerios", "Cheerios"],
  ["Corn flakes", "corn flakes"],
  ["Oat cereal", "oat cereal"],
  ["Granola", "granola"],
]);

const JUICE_KINDS = simpleOptions("juice", [
  ["Orange", "orange"],
  ["Apple", "apple"],
  ["Grape", "grape"],
  ["Cranberry", "cranberry"],
]);

const SODA_KINDS = simpleOptions("soda", [
  ["Coca-Cola", "Coca-Cola"],
  ["Pepsi", "Pepsi"],
  ["Sprite", "Sprite"],
  ["Dr Pepper", "Dr Pepper"],
]);

const TACO_NEEDS = simpleOptions("taco", [
  ["Taco shells", "taco shells"],
  ["Tortillas", "tortillas"],
  ["Ground beef", "ground beef"],
  ["Taco seasoning", "taco seasoning"],
]);

const BREAKFAST_KINDS = simpleOptions("breakfast", [
  ["Eggs", "eggs"],
  ["Oatmeal", "oatmeal"],
  ["Cereal", "cereal"],
  ["Yogurt", "yogurt"],
  ["Bacon", "bacon"],
]);

const GROUND_MEAT_KINDS = simpleOptions("ground-meat", [
  ["Ground beef", "ground beef"],
  ["Ground turkey", "ground turkey"],
  ["Ground chicken", "ground chicken"],
  ["Ground pork", "ground pork"],
]);

function clean(value: string) {
  return value
    .normalize("NFKC")
    .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/[.!?]+$/, "")
    .trim();
}

export function groceryProteinOriginKey(value: string, index?: number) {
  const normalized = clean(value).toLowerCase();
  return index === undefined ? normalized : `${index}:${normalized}`;
}

export function sanitizeGroceryProteinOrigins(value: unknown): GroceryProteinOriginMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const validOrigins = new Set<AttributeOriginValue>(Object.values(AttributeOrigin));
  const validKeys = new Set<GroceryProteinAttributeKey>([
    "animal", "cut", "form", "leanRatio", "preparation", "species",
    "cookingState", "size", "style", "weight", "quantity",
  ]);
  const result: GroceryProteinOriginMap = {};
  for (const [itemKey, rawOrigins] of Object.entries(value)) {
    if (!itemKey || !rawOrigins || typeof rawOrigins !== "object" || Array.isArray(rawOrigins)) continue;
    const origins: Partial<Record<GroceryProteinAttributeKey, AttributeOriginValue>> = {};
    for (const [attribute, origin] of Object.entries(rawOrigins)) {
      if (validKeys.has(attribute as GroceryProteinAttributeKey) && validOrigins.has(origin as AttributeOriginValue)) {
        origins[attribute as GroceryProteinAttributeKey] = origin as AttributeOriginValue;
      }
    }
    if (Object.keys(origins).length) result[itemKey.slice(0, 240)] = origins;
  }
  return result;
}

interface ProteinTaxon {
  category: GroceryProteinCategory;
  animal: string;
  detect: RegExp;
}

interface ProteinValueRule {
  value: string;
  detect: RegExp;
}

interface ProteinChoice {
  id: string;
  label: string;
  value: string;
  output: string;
}

interface ProteinQuestionPolicy {
  id: string;
  prompt: string;
  shortLabel: string;
  attribute: GroceryProteinAttributeKey;
  categories?: GroceryProteinCategory[];
  animals?: string[];
  forms?: string[];
  cuts?: string[];
  species?: string[];
  requiredValues?: Partial<Record<GroceryProteinAttributeKey, string[]>>;
  requireAllMissing?: GroceryProteinAttributeKey[];
  requireMissing?: GroceryProteinAttributeKey;
  placement: "append" | "prepend" | "replace";
  target?: RegExp;
  anyText: string;
  choices: ProteinChoice[];
}

const PROTEIN_EXCLUSION = /\b(?:dog|cat|pet)\s+(?:foods?|treats?|snacks?|chews?)\b|\b(?:seasoning|sauce|marinade|flavor|jerky|broth|stock|soup|nuggets?|patties?)\b/i;

const PROTEIN_TAXONOMY: ProteinTaxon[] = [
  { category: "poultry", animal: "chicken", detect: /\bchicken\b/i },
  { category: "poultry", animal: "turkey", detect: /\bturkey\b/i },
  { category: "seafood", animal: "shrimp", detect: /\bshrimp\b/i },
  { category: "seafood", animal: "fish", detect: /\b(?:fish|salmon|tilapia|cod|tuna|catfish)\b/i },
  { category: "meat", animal: "beef", detect: /\bbeef\b/i },
  { category: "meat", animal: "pork", detect: /\bpork\b/i },
];

const PROTEIN_CUTS: ProteinValueRule[] = [
  { value: "new york strip", detect: /\b(?:new york|ny)\s+strip\b/i },
  { value: "filet mignon", detect: /\bfilet\s+mignon\b/i },
  { value: "t-bone", detect: /\bt[ -]?bone\b/i },
  { value: "ribeye", detect: /\brib[ -]?eye\b/i },
  { value: "sirloin", detect: /\bsirloin\b/i },
  { value: "breast", detect: /\bbreasts?\b/i },
  { value: "thighs", detect: /\bthighs?\b/i },
  { value: "drumsticks", detect: /\bdrumsticks?\b/i },
  { value: "wings", detect: /\bwings?\b/i },
  { value: "chops", detect: /\bchops?\b/i },
  { value: "loin", detect: /\bloin\b/i },
  { value: "shoulder", detect: /\bshoulder\b/i },
  { value: "ribs", detect: /\bribs?\b/i },
];

const PROTEIN_FORMS: ProteinValueRule[] = [
  { value: "ground", detect: /\bground\b/i },
  { value: "steak", detect: /\bsteaks?\b/i },
  { value: "roast", detect: /\broasts?\b/i },
  { value: "stew meat", detect: /\bstew\s+meat\b/i },
  { value: "whole side", detect: /\bwhole\s+(?:salmon\s+)?side\b/i },
  { value: "portions", detect: /\bportions?\b/i },
  { value: "fillet", detect: /\bfillets?\b/i },
  { value: "deli", detect: /\bdeli\b/i },
  { value: "whole", detect: /\bwhole\s+(?:chicken|turkey|fish)\b/i },
  { value: "bacon", detect: /\bbacon\b/i },
  { value: "sausage", detect: /\b(?:sausage|bratwurst)\b/i },
];

const SEAFOOD_SPECIES: ProteinValueRule[] = [
  { value: "salmon", detect: /\bsalmon\b/i },
  { value: "tilapia", detect: /\btilapia\b/i },
  { value: "cod", detect: /\bcod\b/i },
  { value: "tuna", detect: /\btuna\b/i },
  { value: "catfish", detect: /\bcatfish\b/i },
];

const PROTEIN_PREFERENCES: Array<{
  attribute: GroceryProteinAttributeKey;
  label: string;
  detect: RegExp;
}> = [
  { attribute: "leanRatio", label: "Any lean ratio", detect: /\bany\s+(?:lean(?:\s*\/\s*fat)?\s+)?ratio\b/i },
  { attribute: "cut", label: "Any cut", detect: /\bany\s+(?:steak\s+)?cut\b/i },
  { attribute: "preparation", label: "Any bone or skin style", detect: /\bany\s+(?:preparation|bone\s+or\s+skin\s+style)\b/i },
  { attribute: "form", label: "Any form", detect: /\bany\s+form\b/i },
  { attribute: "species", label: "Any fish", detect: /\bany\s+(?:fish|species)\b/i },
  { attribute: "cookingState", label: "Any raw or cooked", detect: /\bany\s+(?:raw\s+or\s+cooked|cooking\s+style)\b/i },
  { attribute: "size", label: "Any size", detect: /\bany\s+(?:shrimp\s+)?size\b/i },
  { attribute: "style", label: "Any style", detect: /\bany\s+(?:bacon\s+style|sausage\s+kind|style)\b/i },
];

const choice = (id: string, label: string, value: string, output = value): ProteinChoice => ({
  id,
  label,
  value,
  output,
});

const anyChoice = (id: string): ProteinChoice => choice(id, "Any", "any", "");

const PROTEIN_QUESTIONS: ProteinQuestionPolicy[] = [
  {
    id: "ground-beef-ratio", prompt: "What lean/fat ratio?", shortLabel: "Needs a lean ratio",
    attribute: "leanRatio", categories: ["meat"], animals: ["beef"], forms: ["ground"], requireMissing: "leanRatio",
    placement: "append", anyText: "any lean ratio",
    choices: [
      choice("ground-beef-80-20", "80/20", "80/20"),
      choice("ground-beef-85-15", "85/15", "85/15"),
      choice("ground-beef-90-10", "90/10", "90/10"),
      choice("ground-beef-93-7", "93/7", "93/7"),
      choice("ground-beef-96-4", "96/4", "96/4"),
      anyChoice("ground-beef-any"),
    ],
  },
  {
    id: "chicken-cut", prompt: "What kind of chicken?", shortLabel: "Needs a cut",
    attribute: "cut", categories: ["poultry"], animals: ["chicken"], requireAllMissing: ["cut", "form"],
    placement: "replace", target: /\bchicken\b/i, anyText: "any cut",
    choices: [
      choice("chicken-breast", "Breast", "breast", "chicken breast"),
      choice("chicken-thighs", "Thighs", "thighs", "chicken thighs"),
      choice("chicken-drumsticks", "Drumsticks", "drumsticks", "chicken drumsticks"),
      choice("chicken-wings", "Wings", "wings", "chicken wings"),
      choice("chicken-whole", "Whole chicken", "whole", "whole chicken"),
      choice("chicken-ground", "Ground chicken", "ground", "ground chicken"),
      anyChoice("chicken-any"),
    ],
  },
  {
    id: "chicken-preparation", prompt: "Which preparation?", shortLabel: "Needs a preparation",
    attribute: "preparation", categories: ["poultry"], animals: ["chicken"], cuts: ["breast", "thighs"], requireMissing: "preparation",
    placement: "prepend", anyText: "any bone or skin style",
    choices: [
      choice("chicken-boneless-skinless", "Boneless skinless", "boneless skinless"),
      choice("chicken-bone-in", "Bone-in", "bone-in"),
      anyChoice("chicken-preparation-any"),
    ],
  },
  {
    id: "turkey-form", prompt: "What kind of turkey?", shortLabel: "Needs a form",
    attribute: "form", categories: ["poultry"], animals: ["turkey"], requireAllMissing: ["cut", "form"],
    placement: "replace", target: /\bturkey\b/i, anyText: "any form",
    choices: [
      choice("turkey-ground", "Ground turkey", "ground", "ground turkey"),
      choice("turkey-breast", "Turkey breast", "breast", "turkey breast"),
      choice("turkey-whole", "Whole turkey", "whole", "whole turkey"),
      choice("turkey-deli", "Deli turkey", "deli", "deli turkey"),
      anyChoice("turkey-any"),
    ],
  },
  {
    id: "ground-turkey-ratio", prompt: "What lean/fat ratio?", shortLabel: "Needs a lean ratio",
    attribute: "leanRatio", categories: ["poultry"], animals: ["turkey"], forms: ["ground"], requireMissing: "leanRatio",
    placement: "append", anyText: "any lean ratio",
    choices: [
      choice("ground-turkey-85-15", "85/15", "85/15"),
      choice("ground-turkey-93-7", "93/7", "93/7"),
      choice("ground-turkey-99-1", "99% lean", "99/1", "99% lean"),
      anyChoice("ground-turkey-any"),
    ],
  },
  {
    id: "beef-form", prompt: "What kind of beef?", shortLabel: "Needs a kind",
    attribute: "form", categories: ["meat"], animals: ["beef"], requireAllMissing: ["cut", "form"],
    placement: "replace", target: /\bbeef\b/i, anyText: "any form",
    choices: [
      choice("beef-ground", "Ground beef", "ground", "ground beef"),
      choice("beef-steak", "Steak", "steak", "steak"),
      choice("beef-roast", "Roast", "roast", "beef roast"),
      choice("beef-stew", "Stew meat", "stew meat", "beef stew meat"),
      choice("beef-ribs", "Beef ribs", "ribs", "beef ribs"),
    ],
  },
  {
    id: "steak-cut", prompt: "What cut of steak?", shortLabel: "Needs a cut",
    attribute: "cut", categories: ["meat"], forms: ["steak"], requireMissing: "cut",
    placement: "prepend", anyText: "any cut",
    choices: [
      choice("steak-ribeye", "Ribeye", "ribeye"),
      choice("steak-new-york", "New York strip", "new york strip"),
      choice("steak-sirloin", "Sirloin", "sirloin"),
      choice("steak-filet", "Filet mignon", "filet mignon"),
      choice("steak-t-bone", "T-bone", "t-bone"),
      anyChoice("steak-any"),
    ],
  },
  {
    id: "pork-form", prompt: "What kind of pork?", shortLabel: "Needs a kind",
    attribute: "cut", categories: ["meat"], animals: ["pork"], requireAllMissing: ["cut", "form"],
    placement: "replace", target: /\bpork\b/i, anyText: "any cut",
    choices: [
      choice("pork-chops", "Pork chops", "chops", "pork chops"),
      choice("pork-loin", "Pork loin", "loin", "pork loin"),
      choice("pork-shoulder", "Pork shoulder", "shoulder", "pork shoulder"),
      choice("pork-ground", "Ground pork", "ground", "ground pork"),
      choice("pork-ribs", "Pork ribs", "ribs", "pork ribs"),
      anyChoice("pork-any"),
    ],
  },
  {
    id: "pork-chop-preparation", prompt: "Which preparation?", shortLabel: "Needs a preparation",
    attribute: "preparation", categories: ["meat"], animals: ["pork"], cuts: ["chops"], requireMissing: "preparation",
    placement: "prepend", anyText: "any bone or skin style",
    choices: [
      choice("pork-chops-boneless", "Boneless", "boneless"),
      choice("pork-chops-bone-in", "Bone-in", "bone-in"),
      anyChoice("pork-chops-any"),
    ],
  },
  {
    id: "bacon-style", prompt: "What kind of bacon?", shortLabel: "Needs a style",
    attribute: "style", categories: ["meat"], forms: ["bacon"], requireMissing: "style",
    placement: "replace", target: /\bbacon\b/i, anyText: "any style",
    choices: [
      choice("bacon-regular", "Regular", "regular", "regular cut bacon"),
      choice("bacon-thick", "Thick cut", "thick cut", "thick cut bacon"),
      choice("bacon-turkey", "Turkey bacon", "turkey", "turkey bacon"),
      anyChoice("bacon-any"),
    ],
  },
  {
    id: "sausage-style", prompt: "What kind of sausage?", shortLabel: "Needs a kind",
    attribute: "style", categories: ["meat"], forms: ["sausage"], requireMissing: "style",
    placement: "replace", target: /\b(?:sausage|bratwurst)\b/i, anyText: "any style",
    choices: [
      choice("sausage-breakfast", "Breakfast sausage", "breakfast", "breakfast sausage"),
      choice("sausage-italian", "Italian sausage", "italian", "italian sausage"),
      choice("sausage-bratwurst", "Bratwurst", "bratwurst", "bratwurst"),
      choice("sausage-smoked", "Smoked sausage", "smoked", "smoked sausage"),
      choice("sausage-chicken", "Chicken sausage", "chicken", "chicken sausage"),
      anyChoice("sausage-any"),
    ],
  },
  {
    id: "fish-species", prompt: "What kind of fish?", shortLabel: "Needs a kind",
    attribute: "species", categories: ["seafood"], animals: ["fish"], requireMissing: "species",
    placement: "replace", target: /\bfish\b/i, anyText: "any species",
    choices: [
      choice("fish-salmon", "Salmon", "salmon", "salmon"),
      choice("fish-tilapia", "Tilapia", "tilapia", "tilapia"),
      choice("fish-cod", "Cod", "cod", "cod"),
      choice("fish-tuna", "Tuna", "tuna", "tuna"),
      choice("fish-catfish", "Catfish", "catfish", "catfish"),
      anyChoice("fish-any"),
    ],
  },
  {
    id: "salmon-form", prompt: "What form of salmon?", shortLabel: "Needs a form",
    attribute: "form", categories: ["seafood"], animals: ["fish"], species: ["salmon"], requireMissing: "form",
    placement: "append", anyText: "any form",
    choices: [
      choice("salmon-fillet", "Fillet", "fillet"),
      choice("salmon-portions", "Portions", "portions"),
      choice("salmon-side", "Whole side", "whole side"),
      anyChoice("salmon-any"),
    ],
  },
  {
    id: "shrimp-cooking", prompt: "Raw or cooked?", shortLabel: "Needs a preparation",
    attribute: "cookingState", categories: ["seafood"], animals: ["shrimp"], requireMissing: "cookingState",
    placement: "prepend", anyText: "any raw or cooked",
    choices: [
      choice("shrimp-raw", "Raw", "raw"),
      choice("shrimp-cooked", "Cooked", "cooked"),
      anyChoice("shrimp-cooking-any"),
    ],
  },
  {
    id: "shrimp-size", prompt: "What shrimp size?", shortLabel: "Needs a size",
    attribute: "size", categories: ["seafood"], animals: ["shrimp"], requireMissing: "size",
    requiredValues: { cookingState: ["raw", "cooked"] },
    placement: "prepend", anyText: "any size",
    choices: [
      choice("shrimp-small", "Small", "small"),
      choice("shrimp-medium", "Medium", "medium"),
      choice("shrimp-large", "Large", "large"),
      choice("shrimp-jumbo", "Jumbo", "jumbo"),
      anyChoice("shrimp-size-any"),
    ],
  },
];

function matchedValue(rules: ProteinValueRule[], raw: string) {
  return rules.find((rule) => rule.detect.test(raw))?.value;
}

function leanRatioFrom(raw: string) {
  const direct = raw.match(/\b(\d{2})\s*[/:-]\s*(\d{1,2})\b/i);
  if (direct && Number(direct[1]) + Number(direct[2]) === 100) {
    return `${Number(direct[1])}/${Number(direct[2])}`;
  }
  const leanPercent = raw.match(/\b(\d{2})\s*(?:%|percent)\s*lean\b/i)
    ?? raw.match(/\blean\b[^\d]{0,24}\b(\d{2})\s*(?:%|percent)\b/i);
  if (!leanPercent) return undefined;
  const lean = Number(leanPercent[1]);
  return lean >= 50 && lean <= 99 ? `${lean}/${100 - lean}` : undefined;
}

function preparationFrom(raw: string) {
  if (/\bboneless\b/i.test(raw) && /\bskinless\b/i.test(raw)) return "boneless skinless";
  if (/\bbone[ -]?in\b/i.test(raw) && /\bskin[ -]?on\b/i.test(raw)) return "bone-in skin-on";
  if (/\bboneless\b/i.test(raw)) return "boneless";
  if (/\bskinless\b/i.test(raw)) return "skinless";
  if (/\bbone[ -]?in\b/i.test(raw)) return "bone-in";
  if (/\bskin[ -]?on\b/i.test(raw)) return "skin-on";
  return undefined;
}

function proteinStyleFrom(raw: string, form: string | undefined) {
  if (form === "bacon") {
    if (/\bturkey\s+bacon\b/i.test(raw)) return "turkey";
    if (/\bthick[ -]?cut\b/i.test(raw)) return "thick cut";
    if (/\bregular(?:\s+cut)?\b/i.test(raw)) return "regular";
  }
  if (form === "sausage") {
    if (/\bbreakfast\s+sausage\b/i.test(raw)) return "breakfast";
    if (/\bitalian\s+sausage\b/i.test(raw)) return "italian";
    if (/\bbratwurst\b/i.test(raw)) return "bratwurst";
    if (/\bsmoked\s+sausage\b/i.test(raw)) return "smoked";
    if (/\bchicken\s+sausage\b/i.test(raw)) return "chicken";
  }
  return undefined;
}

function proteinCategoryFor(raw: string, form: string | undefined) {
  if (PROTEIN_EXCLUSION.test(raw)) return undefined;
  const taxon = PROTEIN_TAXONOMY.find((value) => value.detect.test(raw));
  if (taxon) return { category: taxon.category, animal: taxon.animal, inferredAnimal: false };
  if (form === "steak") return { category: "meat" as const, animal: "beef", inferredAnimal: true };
  if (form === "bacon") {
    return {
      category: "meat" as const,
      animal: /\bturkey\s+bacon\b/i.test(raw) ? "turkey" : "pork",
      inferredAnimal: !/\bturkey\s+bacon\b/i.test(raw),
    };
  }
  if (form === "sausage") return { category: "meat" as const, animal: undefined, inferredAnimal: true };
  return undefined;
}

function proteinIntentFor(
  raw: string,
  origins: Partial<Record<GroceryProteinAttributeKey, AttributeOriginValue>> = {},
): GroceryProteinIntent | undefined {
  const form = matchedValue(PROTEIN_FORMS, raw);
  const identity = proteinCategoryFor(raw, form);
  if (!identity) return undefined;
  const preference = new Map(
    PROTEIN_PREFERENCES
      .filter((item) => item.detect.test(raw))
      .map((item) => [item.attribute, "any"] as const),
  );
  const value = (
    key: GroceryProteinAttributeKey,
    explicitValue: string | undefined,
    defaultOrigin: AttributeOriginValue = AttributeOrigin.USER_EXPLICIT,
  ): GroceryProteinAttribute | undefined => {
    const resolved = preference.get(key) ?? explicitValue;
    return resolved ? { value: resolved, origin: origins[key] ?? defaultOrigin } : undefined;
  };
  const species = matchedValue(SEAFOOD_SPECIES, raw);
  const cookingState = /\braw\b/i.test(raw)
    ? "raw"
    : /\b(?:fully\s+)?cooked\b/i.test(raw)
      ? "cooked"
      : undefined;
  const shrimpSize = identity.animal === "shrimp"
    ? raw.match(/\b(small|medium|large|jumbo)\b/i)?.[1].toLowerCase()
    : undefined;
  const weight = raw.match(WEIGHT_PATTERN);
  const weightValue = weight
    ? `${weight[1]} ${/^(?:lb|pound)/i.test(weight[2])
      ? "lb"
      : /^(?:kg|kilogram)/i.test(weight[2])
        ? "kg"
        : /^(?:g|gram)/i.test(weight[2])
          ? "g"
          : "oz"}`
    : undefined;
  const quantity = raw.match(PACK_PATTERN);

  return {
    category: identity.category,
    animal: identity.animal
      ? value(
          "animal",
          identity.animal,
          identity.inferredAnimal ? AttributeOrigin.INFERRED : AttributeOrigin.USER_EXPLICIT,
        )
      : undefined,
    cut: value("cut", matchedValue(PROTEIN_CUTS, raw)),
    form: value("form", form),
    leanRatio: value("leanRatio", leanRatioFrom(raw)),
    preparation: value("preparation", preparationFrom(raw)),
    species: value("species", species),
    cookingState: value("cookingState", cookingState),
    size: value("size", shrimpSize),
    style: value("style", proteinStyleFrom(raw, form)),
    weight: value("weight", weightValue),
    quantity: value("quantity", quantity ? `${quantity[1]} packages` : undefined),
  };
}

function policyMatchesIntent(policy: ProteinQuestionPolicy, intent: GroceryProteinIntent) {
  if (policy.categories && !policy.categories.includes(intent.category)) return false;
  if (policy.animals && (!intent.animal || !policy.animals.includes(intent.animal.value))) return false;
  if (policy.forms && (!intent.form || !policy.forms.includes(intent.form.value))) return false;
  if (policy.cuts && (!intent.cut || !policy.cuts.includes(intent.cut.value))) return false;
  if (policy.species && (!intent.species || !policy.species.includes(intent.species.value))) return false;
  if (policy.requireMissing && intent[policy.requireMissing]) return false;
  if (policy.requireAllMissing?.some((key) => intent[key])) return false;
  if (policy.requiredValues) {
    for (const [key, allowed] of Object.entries(policy.requiredValues)) {
      const attribute = intent[key as GroceryProteinAttributeKey];
      if (!attribute || !allowed?.includes(attribute.value)) return false;
    }
  }
  return true;
}

function proteinClarificationFor(intent: GroceryProteinIntent | undefined) {
  if (!intent) return undefined;
  const policy = PROTEIN_QUESTIONS.find((item) => policyMatchesIntent(item, intent));
  if (!policy) return undefined;
  return {
    id: policy.id,
    prompt: policy.prompt,
    shortLabel: policy.shortLabel,
    options: policy.choices.map((item) => ({
      id: item.id,
      label: item.label,
      value: item.value,
      attributeKey: policy.attribute,
      normalizedValue: item.value,
    })),
  } satisfies GroceryClarification;
}

function stripProteinPreferences(raw: string) {
  return PROTEIN_PREFERENCES.reduce(
    (value, preference) => value.replace(preference.detect, " "),
    raw,
  ).replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
}

function proteinPreferenceDetail(raw: string) {
  return PROTEIN_PREFERENCES.find((item) => item.detect.test(raw))?.label;
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
  if (value === "four") return 48;
  return Number(value) * 12;
}

function normalizeDetail(raw: string) {
  const lower = raw.toLowerCase();
  const halfGallon = lower.match(HALF_GALLON_PATTERN);
  if (halfGallon) return { source: halfGallon[0], detail: "Half gallon" };

  const multipack = lower.match(MULTIPACK_DETAIL_PATTERN);
  if (multipack) {
    const rawUnit = multipack[3].toLowerCase().replace(/\s+/g, " ");
    const unit = /^(?:lb|pound)/.test(rawUnit)
      ? "lb"
      : /^(?:kg|kilogram)/.test(rawUnit)
        ? "kg"
        : /^(?:g|gram)/.test(rawUnit)
          ? "g"
          : /^(?:fl|fluid)/.test(rawUnit)
            ? "fl oz"
            : /^(?:ml|milliliter|millilitre)/.test(rawUnit)
              ? "mL"
              : /^(?:l|liter|litre)$/.test(rawUnit)
                ? "L"
                : /^(?:quart|qt)/.test(rawUnit)
                  ? "qt"
                  : /^(?:pint|pt)/.test(rawUnit)
                    ? "pt"
                    : /^(?:gallon|gal)/.test(rawUnit)
                      ? "gal"
                      : /^(?:count|ct)/.test(rawUnit)
                        ? "ct"
                        : rawUnit;
    return {
      source: multipack[0],
      detail: `${multipack[1]} × ${multipack[2]} ${unit}`,
    };
  }

  const count = lower.match(COUNT_PATTERN);
  if (count) {
    const container = count[2]?.toLowerCase();
    return {
      source: count[0],
      detail: `${count[1]} ct${container ? ` ${container}` : ""}`,
    };
  }

  const bareEggCountPrefix = lower.match(BARE_EGG_COUNT_PREFIX);
  if (bareEggCountPrefix) return { source: bareEggCountPrefix[1], detail: `${bareEggCountPrefix[1]} ct` };

  const bareEggCountSuffix = lower.match(BARE_EGG_COUNT_SUFFIX);
  if (bareEggCountSuffix) return { source: bareEggCountSuffix[1], detail: `${bareEggCountSuffix[1]} ct` };

  const dozen = lower.match(DOZEN_PATTERN);
  if (dozen) return { source: dozen[0], detail: `${dozenCount(dozen[1])} ct` };

  // Count-unit syntax is only a package detail when it closes the grocery
  // phrase. This preserves identities such as "2 bar stools" and "1 pod
  // coffee maker" while still normalizing "razor refills 12 blades".
  const countUnitQuantity = lower.match(COUNT_UNIT_QUANTITY_PATTERN);
  if (countUnitQuantity) {
    return {
      source: countUnitQuantity[0],
      detail: `${countUnitQuantity[1]} ${countUnitQuantity[2].toLowerCase()}`,
    };
  }

  const containerQuantity = lower.match(CONTAINER_QUANTITY_PATTERN);
  if (containerQuantity) {
    return { source: containerQuantity[0], detail: `${containerQuantity[1]} ${containerQuantity[2].toLowerCase()}` };
  }

  const leadingEachQuantity = lower.match(LEADING_EACH_QUANTITY_PATTERN);
  if (leadingEachQuantity) {
    return { source: leadingEachQuantity[1], detail: `${leadingEachQuantity[1]} each` };
  }

  const trailingEachQuantity = lower.match(TRAILING_EACH_QUANTITY_PATTERN);
  if (trailingEachQuantity) {
    return { source: trailingEachQuantity[2], detail: `${trailingEachQuantity[2]} each` };
  }

  const pack = lower.match(PACK_PATTERN);
  if (pack) return { source: pack[0], detail: `${pack[1]} pack` };

  const weight = lower.match(WEIGHT_PATTERN);
  if (weight) {
    const unit = /^(?:lb|pound)/i.test(weight[2])
      ? "lb"
      : /^(?:kg|kilogram)/i.test(weight[2])
        ? "kg"
        : /^(?:g|gram)/i.test(weight[2])
          ? "g"
          : "oz";
    const container = weight[3]?.toLowerCase();
    return {
      source: weight[0],
      detail: `${weight[1]} ${unit}${container ? ` ${container}` : ""}`,
    };
  }

  const volume = lower.match(VOLUME_PATTERN);
  if (volume) {
    const rawUnit = volume[2].toLowerCase();
    const unit = /^(?:gallon|gal)/.test(rawUnit)
      ? Number(volume[1]) === 1 ? "gallon" : "gallons"
      : /^(?:liter|litre|l$)/.test(rawUnit)
        ? "L"
        : /^(?:quart|qt)/.test(rawUnit)
          ? "qt"
          : /^(?:pint|pt)/.test(rawUnit)
            ? "pt"
        : rawUnit === "ml"
          ? "mL"
          : "fl oz";
    const container = volume[3]?.toLowerCase();
    return {
      source: volume[0],
      detail: `${volume[1]} ${unit}${container ? ` ${container}` : ""}`,
    };
  }

  if (/\bmilk\b/i.test(raw) && BARE_GALLON_PATTERN.test(raw)) {
    return { source: raw.match(BARE_GALLON_PATTERN)?.[0] ?? "gallon", detail: "1 gallon" };
  }

  return undefined;
}

function categoryFor(raw: string) {
  const lower = raw.toLowerCase();
  if (/\bsomething\s+for\s+tacos?\b/.test(lower)) return "taco-need";
  if (/\bbreakfast\s+food\b/.test(lower)) return "breakfast-kind";
  if (/\b(?:ground\s+meat|meat\s+for\s+burgers?)\b/.test(lower)) return "ground-meat-kind";
  if (/\beggs?\b/.test(lower)) return "eggs";
  if (/\bcoconut\s+milk\b/.test(lower) && /\b(?:cans?|canned|light|lite)\b/.test(lower)) return "canned-goods";
  if (/\b(?:almond|oat|coconut|soy)\s+milk\b/.test(lower)) return "alt-milk";
  if (/\bmilk\b/.test(lower)) return "milk";
  if (/\byogurt\b/.test(lower)) return "yogurt";
  if (/\bbread\b/.test(lower)) return "bread";
  if (/\bbeans?\b/.test(lower)) return "beans";
  if (/\bpasta\b/.test(lower)) return "pasta";
  if (/\brice\b/.test(lower)) return "rice";
  if (/\bcheese\b/.test(lower)) return "cheese";
  if (/\bcereal\b/.test(lower)) return "cereal";
  if (/\bjuice\b/.test(lower)) return "juice";
  if (/\b(?:coke|coca[-\s]?cola|pepsi|sprite|dr\.?\s*pepper|mountain\s+dew|7\s*up|soda)\b/.test(lower)) return "soda";
  return undefined;
}

function bareCategoryText(raw: string) {
  return raw
    .toLowerCase()
    .replace(/^\s*\d{1,2}\s+(?:bars?|blades?|cans?|bottles?|jars?|bags?|boxes?|cartons?|pacs?|pieces?|pods?|pouch(?:es)?|rolls?|sheets?|trays?|tubs?|wipes?|bunches?|loaves?)\s+(?:of\s+)?/, "")
    .replace(/\s+\d{1,3}[\s-]*(?:(?:big|double|family|giant|jumbo|large|mega|regular|standard|super|triple|xl|select[ -]?a[ -]?size)[\s-]+){0,3}(?:bars?|blades?|cans?|bottles?|jars?|bags?|boxes?|cartons?|pacs?|pieces?|pods?|pouch(?:es)?|rolls?|sheets?|trays?|tubs?|wipes?|bunches?|loaves?|count|ct|packs?|pk|lbs?|pounds?|oz|ounces?|gallons?|gal)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clarificationFor(
  raw: string,
  category: string | undefined,
  proteinIntent: GroceryProteinIntent | undefined,
): GroceryClarification | undefined {
  const lower = raw.toLowerCase();
  const proteinClarification = proteinClarificationFor(proteinIntent);
  if (proteinClarification) return proteinClarification;

  const bare = bareCategoryText(raw);
  if (category === "beans" && /^(?:bean|beans)$/.test(bare)) {
    return { id: "beans-kind", prompt: "Which kind of beans?", shortLabel: "Needs a kind", options: BEAN_KINDS };
  }
  const exactCategory = clean(raw).toLowerCase();
  const hasBreadKind = /\b(?:white|whole\s+wheat|wheat|sourdough|gluten[-\s]?free)\b/i.test(raw);
  const hasYogurtKind = /\b(?:greek|regular|skyr)\b/i.test(raw);
  const hasRiceKind = /\b(?:white|brown|jasmine|basmati)\b/i.test(raw);
  const hasCheeseKind = /\b(?:cheddar|mozzarella|swiss|american|cream\s+cheese)\b/i.test(raw);
  const hasCerealKind = /\b(?:cheerios|corn\s+flakes|oat\s+cereal|granola)\b/i.test(raw);
  const hasVaguePreference = /\b(?:healthy|good|cheap|budget|affordable|low[-\s]?calorie)\b|\bfor\s+(?:tacos?|sandwiches?|burgers?|dinner)\b/i.test(raw);
  if (category === "bread" && !hasBreadKind && (exactCategory === "bread" || hasVaguePreference)) {
    return { id: "bread-kind", prompt: "What kind of bread?", shortLabel: "Needs a kind", options: BREAD_KINDS };
  }
  if (category === "yogurt" && !hasYogurtKind && (exactCategory === "yogurt" || hasVaguePreference)) {
    return { id: "yogurt-kind", prompt: "What kind of yogurt?", shortLabel: "Needs a kind", options: YOGURT_KINDS };
  }
  if (category === "pasta" && exactCategory === "pasta") {
    return { id: "pasta-kind", prompt: "What kind of pasta?", shortLabel: "Needs a kind", options: PASTA_KINDS };
  }
  if (category === "rice" && !hasRiceKind && (exactCategory === "rice" || hasVaguePreference)) {
    return { id: "rice-kind", prompt: "What kind of rice?", shortLabel: "Needs a kind", options: RICE_KINDS };
  }
  if (category === "cheese" && !hasCheeseKind && (exactCategory === "cheese" || hasVaguePreference)) {
    return { id: "cheese-kind", prompt: "What kind of cheese?", shortLabel: "Needs a kind", options: CHEESE_KINDS };
  }
  if (category === "cereal" && !hasCerealKind && (exactCategory === "cereal" || hasVaguePreference)) {
    return { id: "cereal-kind", prompt: "What kind of cereal?", shortLabel: "Needs a kind", options: CEREAL_KINDS };
  }
  if (category === "juice" && exactCategory === "juice") {
    return { id: "juice-kind", prompt: "Which juice?", shortLabel: "Needs a kind", options: JUICE_KINDS };
  }
  if (category === "taco-need") {
    return { id: "taco-need", prompt: "What do you need for tacos?", shortLabel: "Needs a choice", options: TACO_NEEDS };
  }
  if (category === "breakfast-kind") {
    return { id: "breakfast-kind", prompt: "What sounds good for breakfast?", shortLabel: "Needs a choice", options: BREAKFAST_KINDS };
  }
  if (category === "ground-meat-kind") {
    return { id: "ground-meat-kind", prompt: "Which ground meat?", shortLabel: "Needs a kind", options: GROUND_MEAT_KINDS };
  }

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
      return { id: "soda-kind", prompt: "Which soda?", shortLabel: "Needs a kind", options: SODA_KINDS };
    }
  }

  if (category === "yogurt" && !PACK_PATTERN.test(lower) && !WEIGHT_PATTERN.test(lower) && !/\bsingle[-\s]serve\b/.test(lower)) {
    return { id: "yogurt-size", prompt: "What yogurt size?", shortLabel: "Needs a size", options: YOGURT_SIZES };
  }

  return undefined;
}

function stripLeanRatioText(raw: string) {
  return raw
    .replace(/\b\d{2}\s*[/:-]\s*\d{1,2}\b/i, " ")
    .replace(/\b\d{2}\s*(?:%|percent)(?:\s+lean)?\b/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function itemFromRaw(
  rawValue: string,
  index: number,
  proteinOrigins: GroceryProteinOriginMap = {},
): GroceryNotepadItem {
  const sourceRaw = clean(rawValue);
  const leadingVolumeProduct = sourceRaw.match(LEADING_VOLUME_OF_PRODUCT_PATTERN);
  const leadingMilkQuantity = sourceRaw.match(LEADING_MILK_VOLUME_QUANTITY_PATTERN);
  const raw = leadingVolumeProduct
    ? clean(`${leadingVolumeProduct[3]} 1 ${leadingVolumeProduct[2].replace(/s$/i, "")} x${leadingVolumeProduct[1]}`)
    : leadingMilkQuantity
      ? clean(`${leadingMilkQuantity[2]} ${leadingMilkQuantity[3]} x${leadingMilkQuantity[1]}`)
      : sourceRaw;
  const cartQuantitySuffix = raw.match(CART_QUANTITY_SUFFIX_PATTERN);
  const displayRaw = cartQuantitySuffix
    ? clean(raw.slice(0, cartQuantitySuffix.index))
    : raw;
  const proteinIntent = proteinIntentFor(
    raw,
    proteinOrigins[groceryProteinOriginKey(raw, index)]
      ?? proteinOrigins[groceryProteinOriginKey(raw)],
  );
  const category = categoryFor(displayRaw);
  const withoutPreferences = stripProteinPreferences(displayRaw);
  const ratio = proteinIntent?.leanRatio?.value !== "any" ? proteinIntent?.leanRatio?.value : undefined;
  const displaySource = ratio ? stripLeanRatioText(withoutPreferences) : withoutPreferences;
  const totalRequested = TRAILING_TOTAL_PATTERN.test(displaySource);
  const itemDisplaySource = totalRequested
    ? clean(displaySource.replace(TRAILING_TOTAL_PATTERN, ""))
    : displaySource;
  const detailResult = normalizeDetail(itemDisplaySource);
  const nameSource = detailResult
    ? clean(itemDisplaySource.replace(new RegExp(detailResult.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "").replace(/^[,\s]+|[,\s]+$/g, ""))
    : itemDisplaySource;
  const name = titleCase(nameSource || raw);
  const preferenceDetail = proteinPreferenceDetail(raw);
  const detailParts = [ratio, preferenceDetail, detailResult?.detail].filter(Boolean) as string[];
  const detail = detailParts.length ? detailParts.join(" · ") : undefined;
  const clarification = clarificationFor(displayRaw, category, proteinIntent);
  // Keep an explicit no-preference marker in verification text so matching can
  // relax only the attribute the shopper chose as "Any". Retailer discovery
  // strips these markers before searching, while verification retains them.
  const canonicalDetails = [ratio, preferenceDetail, detailResult?.detail].filter(Boolean);
  const canonicalBase = canonicalDetails.length ? `${name}, ${canonicalDetails.join(", ")}` : name;
  const canonicalTotal = totalRequested ? `${canonicalBase} total` : canonicalBase;
  const dozen = category === "eggs" ? itemDisplaySource.match(DOZEN_PATTERN) : undefined;
  const dozenPackages = dozen ? dozenCount(dozen[1]) / 12 : 1;
  const explicitCartMultiplier = Number(cartQuantitySuffix?.[1] ?? 1);
  const combinedDozenPackages = dozenPackages * explicitCartMultiplier;
  const canonicalText = dozen && combinedDozenPackages <= 99
    ? combinedDozenPackages > 1
      ? `${name}, 12 ct${totalRequested ? " total" : ""} x${combinedDozenPackages}`
      : `${name}, 12 ct${totalRequested ? " total" : ""}`
    : cartQuantitySuffix
      ? `${canonicalTotal} x${cartQuantitySuffix[1]}`
      : canonicalTotal;

  return {
    id: stableId(raw, index),
    raw,
    name,
    detail,
    canonicalText,
    status: clarification ? "needs-detail" : "ready",
    clarification,
    proteinIntent,
  };
}

export function serializeGroceryItems(items: GroceryNotepadItem[]) {
  return items.map((item) => item.canonicalText).join("\n");
}

export function interpretGroceryInput(
  input: string,
  options: InterpretOptions = {},
): GroceryInterpretation {
  const normalizedInput = normalizeHumanGroceryText(input);
  const explicit = explicitSegments(normalizedInput);
  const detectedItems = options.undoImplicitSplits ? explicit : parseShoppingList(normalizedInput, 51);
  const rawItems = detectedItems.slice(0, 50);
  const items = rawItems.map((item, index) => itemFromRaw(item, index, options.proteinOrigins));
  const unresolvedCount = items.filter((item) => item.status === "needs-detail").length;

  return {
    items,
    serialized: serializeGroceryItems(items),
    readyCount: items.length - unresolvedCount,
    unresolvedCount,
    usedSmartSplit: !options.undoImplicitSplits && items.length > explicit.length && explicit.length > 0,
    limitReached: detectedItems.length > 50,
    omittedCount: Math.max(0, detectedItems.length - 50),
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

export interface GroceryClarificationResolution {
  raw: string;
  selectedAttribute?: {
    key: GroceryProteinAttributeKey;
    value: string;
    origin: typeof AttributeOrigin.USER_SELECTED;
  };
}

function resolveProteinClarification(
  raw: string,
  clarificationId: string,
  value: string,
): GroceryClarificationResolution | undefined {
  const policy = PROTEIN_QUESTIONS.find((item) => item.id === clarificationId);
  const selected = policy?.choices.find((item) => item.value === value);
  if (!policy || !selected) return undefined;

  let resolved: string;
  if (selected.value === "any") {
    resolved = clean(`${raw} ${policy.anyText}`);
  } else if (policy.placement === "replace" && policy.target) {
    resolved = clean(raw.replace(policy.target, selected.output));
  } else if (policy.placement === "prepend") {
    resolved = clean(`${selected.output} ${raw}`);
  } else {
    resolved = clean(`${raw} ${selected.output}`);
  }

  const nextIntent = proteinIntentFor(resolved);
  const actualKey = selected.value === "any"
    ? policy.attribute
    : ([
        "leanRatio", "preparation", "cookingState", "size", "style", "cut", "form", "species",
      ] as GroceryProteinAttributeKey[]).find((key) => nextIntent?.[key]?.value === selected.value)
      ?? policy.attribute;

  return {
    raw: resolved,
    selectedAttribute: {
      key: actualKey,
      value: selected.value,
      origin: AttributeOrigin.USER_SELECTED,
    },
  };
}

export function resolveGroceryClarification(
  rawValue: string,
  clarificationId: string,
  value: string,
): GroceryClarificationResolution {
  const raw = clean(rawValue);
  const protein = resolveProteinClarification(raw, clarificationId, value);
  if (protein) return protein;

  if (clarificationId === "milk-type") {
    const prefix = value === "whole" ? "Whole" : value === "skim" ? "Skim" : value;
    return { raw: clean(raw.replace(/\bmilk\b/i, `${prefix} milk`)) };
  }

  if (clarificationId === "soda-variant") return { raw: sodaVariant(raw, value) };

  const replacements: Record<string, [RegExp, string]> = {
    "beans-kind": [/\bbeans?\b/i, `${value} beans`],
    "bread-kind": [/\bbread\b/i, `${value} bread`],
    "yogurt-kind": [/\byogurt\b/i, `${value} yogurt`],
    "pasta-kind": [/\bpasta\b/i, `${value} pasta`],
    "rice-kind": [/\brice\b/i, `${value} rice`],
    "cheese-kind": [/\bcheese\b/i, value === "cream" ? "cream cheese" : `${value} cheese`],
    "cereal-kind": [/\bcereal\b/i, `${value} cereal`],
    "juice-kind": [/\bjuice\b/i, `${value} juice`],
    "soda-kind": [/\bsoda\b/i, value],
    "taco-need": [/.+/, value],
    "breakfast-kind": [/.+/, value],
    "ground-meat-kind": [/\b(?:ground\s+meat|meat\s+for\s+burgers?)\b/i, value],
  };
  const replacement = replacements[clarificationId];
  if (replacement) return { raw: clean(raw.replace(replacement[0], replacement[1])) };

  return { raw: clean(`${raw} ${value}`) };
}

export function applyGroceryClarification(rawValue: string, clarificationId: string, value: string) {
  return resolveGroceryClarification(rawValue, clarificationId, value).raw;
}
