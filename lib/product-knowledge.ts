import type { WalmartProduct } from "./types";

export interface BrandDefinition {
  canonical: string;
  aliases: string[];
}

const BRANDS: BrandDefinition[] = [
  { canonical: "Coca-Cola", aliases: ["coca cola", "coca-cola", "coke"] },
  { canonical: "7UP", aliases: ["7up", "7 up"] },
  { canonical: "Gatorade", aliases: ["gatorade"] },
  { canonical: "Pepsi", aliases: ["pepsi"] },
  { canonical: "Sprite", aliases: ["sprite"] },
  { canonical: "Dr Pepper", aliases: ["dr pepper", "dr. pepper"] },
  { canonical: "Mountain Dew", aliases: ["mountain dew", "mtn dew"] },
  { canonical: "Bimbo", aliases: ["bimbo"] },
  { canonical: "Takis", aliases: ["takis"] },
  { canonical: "Doritos", aliases: ["doritos"] },
  { canonical: "Lay's", aliases: ["lays", "lay's"] },
  { canonical: "Cheetos", aliases: ["cheetos"] },
  { canonical: "Oreo", aliases: ["oreo", "oreos"] },
  { canonical: "Kraft", aliases: ["kraft"] },
  { canonical: "Heinz", aliases: ["heinz"] },
  { canonical: "Ocean Spray", aliases: ["ocean spray"] },
  { canonical: "Tropicana", aliases: ["tropicana"] },
  { canonical: "FAGE", aliases: ["fage"] },
  { canonical: "Chobani", aliases: ["chobani"] },
  { canonical: "Oikos", aliases: ["oikos"] },
  { canonical: "Barilla", aliases: ["barilla"] },
  { canonical: "Goya", aliases: ["goya"] },
  { canonical: "Bush's", aliases: ["bushs", "bush's"] },
  { canonical: "Tyson", aliases: ["tyson"] },
  { canonical: "Eggland's Best", aliases: ["egglands best", "eggland's best"] },
  { canonical: "Oscar Mayer", aliases: ["oscar mayer"] },
  { canonical: "Great Value", aliases: ["great value"] },
  { canonical: "Tide", aliases: ["tide"] },
  { canonical: "Dove", aliases: ["dove"] },
  { canonical: "Bounty", aliases: ["bounty"] },
  { canonical: "Dawn", aliases: ["dawn"] },
  { canonical: "Charmin", aliases: ["charmin"] },
  { canonical: "Colgate", aliases: ["colgate"] },
  { canonical: "Pantene", aliases: ["pantene"] },
  { canonical: "Head & Shoulders", aliases: ["head and shoulders", "head & shoulders"] },
];

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAlias(value: string, alias: string) {
  return new RegExp(`(?:^|\\s)${normalize(alias).replaceAll(" ", "\\s+")}(?:$|\\s)`, "i")
    .test(` ${normalize(value)} `);
}

export function extractRequestedBrand(request: string): BrandDefinition | undefined {
  return BRANDS.find((brand) => brand.aliases.some((alias) => containsAlias(request, alias)));
}

function canonicalBrand(value: string) {
  return BRANDS.find((brand) => brand.aliases.some((alias) => containsAlias(value, alias)));
}

export function productMatchesRequestedBrand(
  requested: BrandDefinition,
  product: WalmartProduct,
) {
  if (product.brand) {
    const explicit = canonicalBrand(product.brand);
    return explicit
      ? explicit.canonical === requested.canonical
      : requested.aliases.some((alias) => containsAlias(product.brand ?? "", alias));
  }

  const recognized = BRANDS
    .flatMap((brand) => brand.aliases.map((alias) => ({
      brand,
      index: normalize(product.title).indexOf(normalize(alias)),
    })))
    .filter((match) => match.index >= 0)
    .sort((a, b) => a.index - b.index || b.brand.canonical.length - a.brand.canonical.length);

  const titleBrand = recognized[0]?.brand;
  return titleBrand?.canonical === requested.canonical;
}

const REQUIRED_DESCRIPTOR_RULES = [
  {
    request: /\borganic\b/i,
    product: /\borganic\b/i,
    label: "organic variety",
  },
  {
    request: /\blemon[\s-]*lime\b/i,
    product: /\blemon[\s-]*lime\b/i,
    label: "lemon lime flavor",
  },
  {
    request: /\bzero(?:\s+sugar)?\b/i,
    product: /\bzero(?:\s+sugar)?\b/i,
    label: "zero sugar variety",
  },
  {
    request: /\bdiet\b/i,
    product: /\bdiet\b/i,
    label: "diet variety",
  },
  {
    request: /\bcherry\b/i,
    product: /\bcherry\b/i,
    label: "cherry variety",
  },
  {
    request: /\bcaffeine[\s-]*free\b/i,
    product: /\bcaffeine[\s-]*free\b/i,
    label: "caffeine-free variety",
  },
  {
    request: /\bfuego\b/i,
    product: /\bfuego\b/i,
    label: "Fuego flavor",
  },
  {
    request: /\bblue\s+heat\b/i,
    product: /\bblue\s+heat\b/i,
    label: "Blue Heat flavor",
  },
  {
    request: /\bgluten[ -]?free\b/i,
    product: /\bgluten[ -]?free\b/i,
    label: "gluten-free variety",
  },
  {
    request: /\b(?:nonfat|fat[ -]?free|zero[ -]?fat|0\s*(?:%|percent)\s*fat)\b/i,
    product: /\b(?:nonfat|fat[ -]?free|zero[ -]?fat|0\s*(?:%|percent)(?:\s*fat)?)\b/i,
    label: "nonfat variety",
  },
  {
    request: /\b(?:lactose[ -]?free|dairy[ -]?free)\b/i,
    product: /\b(?:lactose[ -]?free|dairy[ -]?free)\b/i,
    label: "lactose/dairy-free variety",
  },
  {
    request: /\b(?:sugar[ -]?free|no\s+added\s+sugar)\b/i,
    product: /\b(?:sugar[ -]?free|no\s+added\s+sugar|zero\s+sugar)\b/i,
    label: "sugar-free variety",
  },
  {
    request: /\bfree\s*(?:&|and)\s*(?:gentle|clear)\b/i,
    product: /\bfree\s*(?:&|and)\s*(?:gentle|clear)\b/i,
    label: "free-and-gentle variety",
  },
  {
    request: /\bsensitive\s+skin\b/i,
    product: /\bsensitive\s+skin\b/i,
    label: "sensitive-skin variety",
  },
  {
    request: /\b(?:unscented|fragrance[ -]?free|free\s+of\s+perfumes?)\b/i,
    product: /\b(?:unscented|fragrance[ -]?free|free\s+of\s+perfumes?)\b/i,
    label: "unscented variety",
  },
  {
    request: /\bliquid\b/i,
    product: /\b(?:liquid|fluid)\b/i,
    label: "liquid form",
  },
  {
    request: /\b(?:pods?|pacs?)\b/i,
    product: /\b(?:pods?|pacs?)\b/i,
    label: "pod form",
  },
  {
    request: /\bpowder(?:ed)?\b/i,
    product: /\bpowder(?:ed)?\b/i,
    label: "powder form",
  },
  {
    request: /\bspray\b/i,
    product: /\bspray\b/i,
    label: "spray form",
  },
];

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RESIDUAL_FILLER = new Set([
  "a", "an", "and", "buy", "cheapest", "for", "get", "i", "need", "of",
  "please", "some", "the", "want", "with",
]);

function residualStem(value: string) {
  if (value.length > 5 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && value.endsWith("es")) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

const RESIDUAL_TERM_ALIASES: Record<string, string[]> = {
  mac: ["mac", "macaroni"],
};

function stripResidualPackageSyntax(value: string) {
  return value
    .replace(/^\s*\d{1,2}\s*[x×]\s+(?=\S)/i, " ")
    .replace(/\b\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|gallons?|gal|quarts?|qt|liters?|litres?|milliliters?|millilitres?|ml|l)\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:pack|pk|count|ct)\b(?:\s+of)?(?:\s+(?:bags?|bottles?|boxes?|cans?|cartons?|containers?|jars?|packages?))?/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|gallons?|gal|quarts?|qt|liters?|litres?|milliliters?|millilitres?|ml|l)\b(?:\s+(?:bags?|bottles?|boxes?|cans?|cartons?|containers?|jars?|packages?))?/gi, " ")
    .replace(/\b(?:half(?:[ -]a)?|one|a)?\s*gallons?\b/gi, " ")
    .replace(/\b(?:one|a)\s+dozen\b/gi, " ");
}

function residualDescriptorIssues(request: string, candidate: string) {
  let residual = request;
  for (const rule of REQUIRED_DESCRIPTOR_RULES) {
    if (rule.request.test(request)) residual = residual.replace(rule.request, " ");
  }
  residual = residual.replace(/\b(?:original(?:\s+taste)?|classic)\b/gi, " ");
  residual = residual.replace(/\b\d{2}\s*[/:-]\s*\d{1,2}\b/g, " ");
  residual = residual.replace(/\b\d+(?:\.\d+)?\s*(?:%|\bpercent\b)/gi, " ");
  residual = stripResidualPackageSyntax(residual);

  const requestedBrand = extractRequestedBrand(request);
  const brandWords = new Set(
    requestedBrand
      ? [requestedBrand.canonical, ...requestedBrand.aliases]
          .flatMap((value) => normalize(value).split(/\s+/))
      : [],
  );
  const categoryMatch = matchingCategoryRule(request)?.match;
  const categoryWords = new Set(normalize(categoryMatch ?? "").split(/\s+/).filter(Boolean));
  const requestTerms = normalize(residual)
    .split(/\s+/)
    .filter((word) => word.length >= 2)
    .filter((word) => !/^\d+(?:\.\d+)?$/.test(word))
    .filter((word) => !RESIDUAL_FILLER.has(word))
    .filter((word) => !brandWords.has(word) && !categoryWords.has(word))
    .map(residualStem);
  const candidateTerms = new Set(normalize(candidate).split(/\s+/).map(residualStem));
  return [...new Set(requestTerms)]
    .filter((term) => !(RESIDUAL_TERM_ALIASES[term] ?? [term]).some((alias) => (
      candidateTerms.has(residualStem(alias))
    )))
    .map((term) => `${term} descriptor`);
}

export function missingRequestedDescriptors(request: string, product: WalmartProduct) {
  const candidate = `${product.productType ?? ""} ${product.title}`;
  const missing = REQUIRED_DESCRIPTOR_RULES
    .filter((rule) => rule.request.test(request) && !rule.product.test(candidate))
    .map((rule) => rule.label);
  const requestedRatio = request.match(/\b(\d{2})\s*[/:-]\s*(\d{1,2})\b/);
  if (requestedRatio) {
    const ratioPattern = new RegExp(
      `\\b${requestedRatio[1]}\\s*[/:-]\\s*${requestedRatio[2]}\\b`,
      "i",
    );
    if (!ratioPattern.test(candidate)) {
      missing.push(`${requestedRatio[1]}/${requestedRatio[2]} ratio`);
    }
  }
  const requestedPercent = request.match(/\b(\d+(?:\.\d+)?)\s*(?:%|\bpercent\b)/i);
  if (requestedPercent) {
    const percent = escapedPattern(requestedPercent[1]);
    const equivalent = requestedPercent[1] === "0"
      ? new RegExp(`(?:\\b0\\s*(?:%|\\bpercent\\b)|\\bnonfat\\b|\\bfat[ -]?free\\b|\\bzero[ -]?fat\\b)`, "i")
      : new RegExp(`\\b${percent}\\s*(?:%|\\bpercent\\b)`, "i");
    if (!equivalent.test(candidate)) missing.push(`${requestedPercent[1]}% variety`);
  }
  missing.push(...residualDescriptorIssues(request, candidate));
  return [...new Set(missing)];
}

interface AmbiguityRule {
  term: RegExp;
  clarifiedBy: RegExp;
  question: string;
}

const AMBIGUITY_RULES: AmbiguityRule[] = [
  {
    term: /\bcranberr(?:y|ies)\b/i,
    clarifiedBy: /\b(?:fresh|whole|dried|juice|sauce|frozen|canned)\b/i,
    question: "Did you mean fresh cranberries, cranberry juice, or dried cranberries?",
  },
];

export function clarificationForRequest(request: string) {
  return AMBIGUITY_RULES.find(
    (rule) => rule.term.test(request) && !rule.clarifiedBy.test(request),
  )?.question;
}

interface CategoryRule {
  id: string;
  detect: RegExp;
  exclude?: RegExp;
}

interface ProduceIdentityRule {
  canonical: string;
  pattern: RegExp;
}

const PRODUCE_IDENTITIES: ProduceIdentityRule[] = [
  { canonical: "cilantro", pattern: /\b(?:cilantro|coriander leaves?)\b/i },
  { canonical: "parsley", pattern: /\bparsley\b/i },
  { canonical: "basil", pattern: /\bbasil\b/i },
  { canonical: "brussels sprouts", pattern: /\bbrussels? sprouts?\b/i },
  { canonical: "collard greens", pattern: /\bcollard greens?\b/i },
  { canonical: "green beans", pattern: /\bgreen beans?\b/i },
  { canonical: "bell peppers", pattern: /\bbell peppers?\b/i },
  { canonical: "sweet peppers", pattern: /\bsweet peppers?\b/i },
  { canonical: "chili peppers", pattern: /\bchili peppers?\b/i },
  { canonical: "asparagus", pattern: /\basparagus\b/i },
  { canonical: "artichokes", pattern: /\bartichokes?\b/i },
  { canonical: "cauliflower", pattern: /\bcauliflower\b/i },
  { canonical: "cucumbers", pattern: /\bcucumbers?\b/i },
  { canonical: "mushrooms", pattern: /\bmushrooms?\b/i },
  { canonical: "zucchini", pattern: /\bzucchini\b/i },
  { canonical: "eggplant", pattern: /\beggplants?\b/i },
  { canonical: "jalapenos", pattern: /\bjalape(?:n|ñ)os?\b/i },
  { canonical: "broccoli", pattern: /\bbroccoli\b/i },
  { canonical: "cabbage", pattern: /\bcabbages?\b/i },
  { canonical: "carrots", pattern: /\bcarrots?\b/i },
  { canonical: "celery", pattern: /\bcelery\b/i },
  { canonical: "lettuce", pattern: /\blettuce\b/i },
  { canonical: "spinach", pattern: /\bspinach\b/i },
  { canonical: "potatoes", pattern: /\bpotato(?:es)?\b/i },
  { canonical: "tomatoes", pattern: /\btomato(?:es)?\b/i },
  { canonical: "avocados", pattern: /\bavocados?\b/i },
  { canonical: "bananas", pattern: /\bbananas?\b/i },
  { canonical: "oranges", pattern: /\boranges?\b/i },
  { canonical: "apples", pattern: /\bapples?\b/i },
  { canonical: "onions", pattern: /\bonions?\b/i },
  { canonical: "radishes", pattern: /\bradishes?\b/i },
  { canonical: "squash", pattern: /\bsquash\b/i },
  { canonical: "beets", pattern: /\bbeets?\b/i },
  { canonical: "garlic", pattern: /\bgarlic\b/i },
  { canonical: "leeks", pattern: /\bleeks?\b/i },
  { canonical: "okra", pattern: /\bokra\b/i },
  { canonical: "peas", pattern: /\bpeas?\b/i },
  { canonical: "corn", pattern: /\bcorn\b/i },
  { canonical: "kale", pattern: /\bkale\b/i },
  { canonical: "peppers", pattern: /\bpeppers?\b/i },
];

const PRODUCE_CATEGORY_PATTERN = /\b(?:produce|vegetables?|fresh herbs?|cilantro|coriander leaves?|parsley|basil|apples?|bananas?|oranges?|onions?|tomatoes?|potatoes?|lettuce|spinach|carrots?|avocados?|broccoli|asparagus|artichokes?|beets?|bell peppers?|sweet peppers?|chili peppers?|peppers?|brussels? sprouts?|cabbages?|cauliflower|celery|collard greens?|corn|cucumbers?|eggplants?|garlic|green beans?|jalape(?:n|ñ)os?|kale|leeks?|mushrooms?|okra|peas?|radishes?|squash|zucchini)\b/i;

const PRODUCE_CATEGORY_EXCLUSIONS = /\b(?:apple|banana|orange|tomato|vegetable|asparagus|artichoke|beet|broccoli|cabbage|carrot|cauliflower|celery|cilantro|coriander|basil|parsley|corn|cucumber|eggplant|garlic|kale|mushroom|onion|pea|pepper|potato|spinach|squash|zucchini)s?\s+(?:juice|sauce|soup|chips?|candy|baby food|snack|seasoning|powder|supplements?|seeds?|plants?|oil)\b|\b(?:black|white|ground|crushed red)\s+pepper\b|\b(?:popcorn|corn dogs?|corn syrup|corn starch|cornmeal|cream of asparagus|asparagus fern)\b/i;

export function extractProduceIdentity(value: string) {
  return PRODUCE_IDENTITIES.find((identity) => identity.pattern.test(value))?.canonical;
}

// Specific product identities intentionally come first. A flavor word is not
// allowed to outweigh the actual product, so Doritos Nacho Cheese stays chips.
const CATEGORY_RULES: CategoryRule[] = [
  // Product categories take precedence over ingredient/scent words. For
  // example, cucumber body wash is personal care, not produce.
  { id: "body wash", detect: /\b(?:body\s+wash|shower\s+gel)\b/i },
  { id: "dish soap", detect: /\b(?:dish\s+soap|dishwashing\s+liquid)\b/i },
  { id: "laundry detergent", detect: /\b(?:laundry\s+)?detergent(?:\s+pods?)?\b/i, exclude: /\bdish(?:washer)?\b/i },
  { id: "paper towels", detect: /\bpaper\s+towels?\b/i },
  { id: "trash bags", detect: /\b(?:trash|garbage)\s+bags?\b/i },
  { id: "toilet paper", detect: /\b(?:toilet\s+paper|bath\s+tissue)\b/i },
  { id: "toothpaste", detect: /\btoothpaste\b/i },
  { id: "deodorant", detect: /\b(?:deodorant|antiperspirant)\b/i },
  { id: "shampoo", detect: /\bshampoo\b/i },
  { id: "conditioner", detect: /\bhair\s+conditioner\b|\bconditioner\b/i },
  { id: "ground beef", detect: /\bground\s+beef\b/i },
  { id: "beef", detect: /\b(?:beef|steaks?|roasts?)\b/i, exclude: /\b(?:coffee|seasoning|sauce|marinade|flavor|jerky)\b/i },
  { id: "pork", detect: /\b(?:pork|pork\s+chops?|pork\s+ribs?)\b/i, exclude: /\b(?:seasoning|sauce|marinade|flavor|jerky)\b/i },
  {
    id: "canned seafood",
    detect: /\b(?:tuna|albacore|canned salmon|canned sardines?)\b/i,
    exclude: /\b(?:cat|dog|pet)\s+(?:food|treats?)\b/i,
  },
  { id: "sports drink", detect: /\b(?:gatorade|sports drinks?)\b/i },
  {
    id: "soda",
    detect: /\b(?:coke|coca[ -]?cola|pepsi|cola|soda|soft drinks?|sprite|7\s?up|dr\.? pepper|mountain dew|mtn dew)\b/i,
    // Brand licensing and flavor words are not beverage evidence. Retailer
    // searches can return Coca-Cola candy, gummies, cosmetics, and merchandise.
    exclude: /\b(?:baking|washing)\s+soda\b|\b(?:cand(?:y|ies)|gumm(?:y|ies)|lip\s+balm|cosmetics?|apparel|shirts?|toys?|collectibles?|merchandise)\b/i,
  },
  {
    id: "chips",
    detect: /\b(?:chips?|takis|doritos|lay['’]?s|cheetos|tortilla chips?)\b/i,
    exclude: /\b(?:chocolate|baking|wood)\s+chips\b/i,
  },
  {
    id: "cereal",
    detect: /\b(?:cereal|cheerios|corn flakes|frosted flakes)\b/i,
    exclude: /\bcereal\s+bars?\b/i,
  },
  {
    id: "juice",
    detect: /\b(?:juice|orange juice|apple juice|cranberry juice)\b/i,
    exclude: /\bjuice\s+(?:drink mix|powder|enhancer)\b/i,
  },
  {
    id: "water",
    detect: /\b(?:bottled water|drinking water|spring water|purified water|mineral water|sparkling water|water|dasani|aquafina|pure life)\b/i,
    exclude: /\b(?:tuna|fruit|vegetables?|beans?)\s+(?:packed\s+)?in\s+water\b|\bwater\s+(?:enhancer|flavoring)\b/i,
  },
  {
    id: "coffee",
    detect: /\bcoffee\b/i,
    exclude: /\bcoffee\s+(?:creamer|candy|cake|ice cream)\b/i,
  },
  { id: "Greek yogurt", detect: /\b(?:greek yogurt|greek-style yogurt)\b/i },
  {
    id: "yogurt",
    detect: /\b(?:yogurt|skyr)\b/i,
    exclude: /\byogurt[- ](?:covered|flavored)\b|\byogurt\s+(?:pretzels?|raisins?|bars?)\b/i,
  },
  { id: "dried cranberries", detect: /\bdried cranberr(?:y|ies)\b/i },
  { id: "fresh cranberries", detect: /\b(?:fresh|whole) cranberr(?:y|ies)\b/i },
  {
    id: "bread",
    detect: /\b(?:bread|loaf|buns?|tortillas?)\b/i,
    exclude: /\b(?:bread\s*crumbs?|breaded|bread pudding|stuffing mix)\b/i,
  },
  { id: "chicken breast", detect: /\bchicken breasts?\b/i },
  {
    id: "chicken",
    detect: /\bchicken\b/i,
    exclude: /\bchicken\s+(?:broth|stock|soup|noodles?|nuggets?|patties|seasoning|flavor)\b/i,
  },
  {
    id: "milk",
    detect: /\b(?:milk|almond milk|oat milk)\b/i,
    exclude: /\bmilk\s+(?:chocolate|candy|powder|shake|shake mix)\b/i,
  },
  {
    id: "cheese",
    detect: /\b(?:cheese|cheddar|mozzarella|provolone)\b/i,
    exclude: /\b(?:cheese[- ]flavored|cheese\s+(?:crackers?|puffs?|chips?|dip|sauce|popcorn)|mac(?:aroni)?\s+and\s+cheese)\b/i,
  },
  {
    id: "eggs",
    detect: /\beggs?\b/i,
    exclude: /\b(?:chocolate|candy|creme|toy|decorative)\s+eggs?\b|\begg\s+(?:noodles?|rolls?|substitute)\b/i,
  },
  {
    id: "pasta",
    detect: /\b(?:pasta|spaghetti|penne|macaroni|fettuccine|linguine)\b/i,
    exclude: /\bpasta\s+(?:sauce|salad|seasoning)\b|\bmac(?:aroni)?\s+and\s+cheese\b/i,
  },
  {
    id: "rice",
    detect: /\b(?:rice|jasmine rice|basmati rice)\b/i,
    exclude: /\brice\s+(?:cakes?|cereal|pudding|crackers?)\b/i,
  },
  {
    id: "produce",
    detect: PRODUCE_CATEGORY_PATTERN,
    exclude: PRODUCE_CATEGORY_EXCLUSIONS,
  },
  {
    id: "beans",
    detect: /\bbeans?\b/i,
    exclude: /\b(?:jelly|coffee|cocoa|vanilla)\s+beans?\b/i,
  },
  { id: "bacon", detect: /\bbacon\b/i, exclude: /\b(?:imitation\s+)?bacon\s+bits?\b/i },
  {
    id: "meat",
    detect: /\b(?:beef|pork|steaks?|roasts?|ground beef|pork chops?|ribs?)\b/i,
    exclude: /\b(?:steak|beef|pork|meat)\s+(?:seasoning|sauce|marinade|flavor|dog treats?|jerky)\b/i,
  },
  { id: "batteries", detect: /\b(?:aa|aaa|c|d|9v)?\s*batter(?:y|ies)\b/i },
];

function matchingCategoryRule(value: string) {
  for (const rule of CATEGORY_RULES) {
    if (rule.exclude?.test(value)) continue;
    const match = value.match(rule.detect)?.[0];
    if (match) return { rule, match };
  }
  return undefined;
}

export function inferProductCategory(value: string) {
  return matchingCategoryRule(value)?.rule.id;
}

/** Pet products are a separate shopper identity even when their ingredient is human food. */
const PET_PRODUCT_SIGNAL = /\b(?:dog|cat|pet)\s+(?:foods?|treats?|snacks?|chews?|biscuits?|jerky|toppers?)\b|\bfor\s+(?:dogs?|cats?|pets?)\b/i;

/** Hardware/accessories cannot satisfy a request for the consumable they reference. */
const PRODUCT_ACCESSORY_SIGNAL = /\b(?:accessor(?:y|ies)|holders?|dispensers?|racks?|organizers?|cadd(?:y|ies)|stands?|mounts?|makers?|cookers?|frothers?|kn(?:ife|ives)|graters?|slicers?|choppers?|openers?|replacement\s+filters?|filter\s+cartridges?|cartridges?|storage\s+cases?|appliances?|machines?|drinkware|kitchenware|cookware|utensils?|hardware)\b|\b(?:stainless\s+steel|insulated|reusable)\s+(?:water\s+)?bottles?\b/i;

export function productTypeMatchesRequest(request: string, product: WalmartProduct) {
  const requestedType = inferProductCategory(request);
  if (!requestedType) return true;
  const candidateText = `${product.productType ?? ""} ${product.title}`;
  // Ingredient words such as "chicken breast" or "ground beef" must not let
  // dog/cat products cross into a human grocery request (or vice versa).
  if (PET_PRODUCT_SIGNAL.test(request) !== PET_PRODUCT_SIGNAL.test(candidateText)) return false;
  // The same agreement rule lets an explicit "water filter" or "paper towel
  // holder" request work while keeping those accessories out of water/paper
  // consumable comparisons.
  if (PRODUCT_ACCESSORY_SIGNAL.test(request) !== PRODUCT_ACCESSORY_SIGNAL.test(candidateText)) {
    return false;
  }
  const candidateType = inferProductCategory(candidateText);
  if (requestedType === "chicken" && candidateType === "chicken breast") return true;
  if (requestedType === "yogurt" && candidateType === "Greek yogurt") return true;
  if (requestedType === "beef" && candidateType === "ground beef") return true;
  if (requestedType === "meat" && ["ground beef", "beef", "pork"].includes(candidateType ?? "")) {
    return true;
  }
  return candidateType === requestedType;
}

export type ProduceForm = "fresh" | "frozen" | "canned" | "pickled" | "dried";

const EXPLICIT_PRODUCE_FORM_RULES: Array<{ form: Exclude<ProduceForm, "fresh">; pattern: RegExp }> = [
  { form: "pickled", pattern: /\b(?:pickled|in brine)\b/i },
  { form: "dried", pattern: /\b(?:dried|dehydrated|freeze[ -]?dried)\b/i },
  { form: "frozen", pattern: /\b(?:frozen|steamable|steam[ -]?in[ -]bag)\b/i },
  { form: "canned", pattern: /\b(?:canned|jarred|cans?|jars?)\b/i },
];

const FRESH_PRODUCE_SIGNAL = /\b(?:fresh|fresh produce|fresh vegetables?|raw|whole|organic|bunch(?:es)?|each|heads?|stalks?|crowns?|loose|bundles?|clamshell|bagged?)\b/i;
const PREPARED_PRODUCE_SIGNAL = /\b(?:roasted|grilled|seasoned|breaded|fried|ready[ -]?to[ -]?eat|prepared meal|casserole)\b/i;

function explicitProduceForm(value: string) {
  return EXPLICIT_PRODUCE_FORM_RULES.find((rule) => rule.pattern.test(value))?.form;
}

function candidateProduceForm(product: WalmartProduct): ProduceForm | "prepared" | undefined {
  const candidate = `${product.productType ?? ""} ${product.title}`;
  const explicit = explicitProduceForm(candidate);
  if (explicit) return explicit;
  if (PREPARED_PRODUCE_SIGNAL.test(candidate)) return "prepared";
  if (FRESH_PRODUCE_SIGNAL.test(candidate)) return "fresh";
  return undefined;
}

/**
 * A broad "vegetables" or "produce" request has no item word in common with
 * a concrete result such as broccoli. It is still safe to rank that result
 * when the category and fresh/processed form have both been confirmed.
 */
export function isGenericProduceRequest(request: string) {
  return inferProductCategory(request) === "produce" && !extractProduceIdentity(request);
}

/**
 * Whole produce defaults to fresh. Processed forms remain valid when the
 * shopper explicitly asks for them, but never win merely because they cost
 * less than the fresh item the request normally means.
 */
export function assessProduceForm(
  request: string,
  product: WalmartProduct,
): ProductVariantAssessment {
  if (inferProductCategory(request) !== "produce") {
    return { rejected: false, scoreAdjustment: 0, reasons: [] };
  }

  const requestedForm: ProduceForm = explicitProduceForm(request) ?? "fresh";
  const candidateForm = candidateProduceForm(product);
  if (candidateForm !== requestedForm) {
    return {
      rejected: true,
      scoreAdjustment: 0,
      reasons: [candidateForm
        ? `requested ${requestedForm} produce, but the product is ${candidateForm}`
        : `does not confirm ${requestedForm} produce`],
    };
  }

  return {
    rejected: false,
    scoreAdjustment: requestedForm === "fresh" ? 18 : 14,
    reasons: [`confirms ${requestedForm} produce`],
  };
}

interface ProductVariantAssessment {
  rejected: boolean;
  scoreAdjustment: number;
  reasons: string[];
}

interface ProductFamilyRule {
  label: string;
  request: RegExp;
  product: RegExp;
}

const TAKIS_SPECIALTY_FAMILIES: ProductFamilyRule[] = [
  {
    label: "Stix",
    request: /\b(?:stix|sticks?)\b/i,
    product: /\b(?:stix|snack sticks?)\b/i,
  },
  {
    label: "Pix",
    request: /\b(?:pix|corn puffs?)\b/i,
    product: /\b(?:pix|corn puffs?)\b/i,
  },
  {
    label: "Kettlez",
    request: /\b(?:kettlez|kettle[ -]?(?:cooked)?(?:\s+potato)?\s+chips?)\b/i,
    product: /\b(?:kettlez|kettle[ -]?cooked)\b/i,
  },
  {
    label: "Waves",
    request: /\b(?:waves|wavy(?:\s+potato)?\s+chips?)\b/i,
    product: /\b(?:waves|wavy(?:\s+potato)?\s+chips?)\b/i,
  },
  {
    label: "Crisps",
    request: /\b(?:crisps?|potato crisps?)\b/i,
    product: /\b(?:crisps?|potato crisps?)\b/i,
  },
];

interface BreadFormatRule {
  id: string;
  label: string;
  pattern: RegExp;
}

/**
 * Bread is a broad retailer category, but these formats are not interchangeable
 * shopper intents. A catalog can label buns or tortillas as "Bread"; that
 * metadata confirms only the broad aisle, not that the item is a loaf.
 */
const BREAD_SPECIALTY_FORMATS: BreadFormatRule[] = [
  { id: "buns", label: "buns", pattern: /\b(?:buns?|hamburger buns?|hot dog buns?|slider buns?)\b/i },
  { id: "tortillas", label: "tortillas", pattern: /\btortillas?\b/i },
  { id: "rolls", label: "rolls", pattern: /\b(?:dinner|sandwich|sub|hoagie|kaiser|sweet)\s+rolls?\b/i },
  { id: "pita", label: "pita", pattern: /\bpita(?:\s+bread)?\b/i },
  { id: "naan", label: "naan", pattern: /\bnaan(?:\s+bread)?\b/i },
  { id: "flatbread", label: "flatbread", pattern: /\bflatbreads?\b/i },
];

interface MeatPreparationRule {
  id: string;
  label: string;
  pattern: RegExp;
}

const MEAT_CATEGORIES = new Set([
  "chicken breast",
  "chicken",
  "ground beef",
  "beef",
  "pork",
  "meat",
]);

/** Cut and preparation are product identity for meat, not optional metadata. */
const MEAT_PREPARATION_RULES: MeatPreparationRule[] = [
  { id: "nuggets", label: "nuggets", pattern: /\bnuggets?\b/i },
  { id: "patties", label: "patties", pattern: /\b(?:hamburger|chicken|beef|pork)?\s*patties\b/i },
  { id: "meatballs", label: "meatballs", pattern: /\bmeatballs?\b/i },
  { id: "tenders", label: "tenders or strips", pattern: /\b(?:tenders?|tenderloins?|strips?)\b/i },
  { id: "breaded", label: "breaded", pattern: /\b(?:breaded|battered)\b/i },
  { id: "cooked", label: "pre-cooked", pattern: /\b(?:fully\s+cooked|pre[ -]?cooked|ready[ -]?to[ -]?eat|rotisserie|grilled|fried)\b/i },
  { id: "seasoned", label: "seasoned or marinated", pattern: /\b(?:seasoned|marinated)\b/i },
  { id: "prepared-meal", label: "prepared meal", pattern: /\b(?:prepared\s+meal|dinner|sandwich|deli)\b/i },
];

function assessMeatPreparation(
  request: string,
  product: WalmartProduct,
): ProductVariantAssessment | undefined {
  const requestedCategory = inferProductCategory(request);
  if (!requestedCategory || !MEAT_CATEGORIES.has(requestedCategory)) return undefined;

  const candidate = `${product.productType ?? ""} ${product.title}`;
  const requestedFeatures = MEAT_PREPARATION_RULES.filter((rule) => rule.pattern.test(request));
  const candidateFeatures = MEAT_PREPARATION_RULES.filter((rule) => rule.pattern.test(candidate));

  if (!requestedFeatures.length && candidateFeatures.length) {
    return {
      rejected: true,
      scoreAdjustment: 0,
      reasons: [`unrequested meat preparation (${candidateFeatures.map((rule) => rule.label).join(", ")})`],
    };
  }

  const missing = requestedFeatures.filter((requested) => (
    !candidateFeatures.some((candidateFeature) => candidateFeature.id === requested.id)
  ));
  if (missing.length) {
    return {
      rejected: true,
      scoreAdjustment: 0,
      reasons: [`does not match requested meat preparation (${missing.map((rule) => rule.label).join(", ")})`],
    };
  }

  return requestedFeatures.length
    ? {
        rejected: false,
        scoreAdjustment: 14,
        reasons: [`matches requested meat preparation (${requestedFeatures.map((rule) => rule.label).join(", ")})`],
      }
    : { rejected: false, scoreAdjustment: 0, reasons: [] };
}

function assessBreadProductFamily(
  request: string,
  product: WalmartProduct,
): ProductVariantAssessment | undefined {
  if (inferProductCategory(request) !== "bread") return undefined;

  const requestedFormat = BREAD_SPECIALTY_FORMATS.find((format) => format.pattern.test(request));
  // Product type is deliberately excluded here. Retailers commonly use the
  // broad value "Bread" for buns, tortillas, and loaves alike.
  const candidateFormat = BREAD_SPECIALTY_FORMATS.find((format) => format.pattern.test(product.title));

  if (requestedFormat) {
    if (candidateFormat?.id !== requestedFormat.id) {
      return {
        rejected: true,
        scoreAdjustment: 0,
        reasons: [`does not match requested bread format (${requestedFormat.label})`],
      };
    }

    return {
      rejected: false,
      scoreAdjustment: 16,
      reasons: [`matches requested bread format (${requestedFormat.label})`],
    };
  }

  if (candidateFormat) {
    return {
      rejected: true,
      scoreAdjustment: 0,
      reasons: [`unrequested bread format (${candidateFormat.label})`],
    };
  }

  return { rejected: false, scoreAdjustment: 0, reasons: [] };
}

/**
 * Keep a bare Takis request on the brand's core rolled-tortilla product.
 * Walmart also returns several Takis line extensions for the same broad
 * "chips" category; those are eligible only when the shopper names one.
 */
export function assessProductFamily(
  request: string,
  product: WalmartProduct,
): ProductVariantAssessment {
  const meatAssessment = assessMeatPreparation(request, product);
  if (meatAssessment) return meatAssessment;

  const breadAssessment = assessBreadProductFamily(request, product);
  if (breadAssessment) return breadAssessment;

  if (extractRequestedBrand(request)?.canonical !== "Takis") {
    return { rejected: false, scoreAdjustment: 0, reasons: [] };
  }

  const candidate = `${product.productType ?? ""} ${product.title}`;
  const requestedSpecialty = TAKIS_SPECIALTY_FAMILIES.find((family) =>
    family.request.test(request));

  if (requestedSpecialty) {
    if (!requestedSpecialty.product.test(candidate)) {
      return {
        rejected: true,
        scoreAdjustment: 0,
        reasons: [`does not match requested Takis ${requestedSpecialty.label} product family`],
      };
    }
    return {
      rejected: false,
      scoreAdjustment: 18,
      reasons: [`matches requested Takis ${requestedSpecialty.label} product family`],
    };
  }

  const unrequestedSpecialty = TAKIS_SPECIALTY_FAMILIES.find((family) =>
    family.product.test(candidate));
  if (unrequestedSpecialty) {
    return {
      rejected: true,
      scoreAdjustment: 0,
      reasons: [`unrequested Takis ${unrequestedSpecialty.label} product family`],
    };
  }

  if (!/\brolled\s+tortilla\s+chips?\b/i.test(candidate)) {
    return {
      rejected: true,
      scoreAdjustment: 0,
      reasons: ["does not confirm classic Takis rolled tortilla chips"],
    };
  }

  return {
    rejected: false,
    scoreAdjustment: 18,
    reasons: ["classic Takis rolled tortilla chips"],
  };
}

const SODA_VARIANTS = [
  { label: "zero sugar", pattern: /\bzero(?:\s+sugar)?\b/i },
  { label: "diet", pattern: /\bdiet\b/i },
  { label: "cherry", pattern: /\bcherry\b/i },
  { label: "vanilla", pattern: /\bvanilla\b/i },
  { label: "cream soda", pattern: /\b(?:cream soda|strawberries?\s+and\s+cream)\b/i },
  { label: "caffeine-free", pattern: /\bcaffeine[\s-]*free\b/i },
];

interface CategorySpecialtyVariantPolicy {
  category: string;
  variants: Array<{ label: string; pattern: RegExp }>;
}

/**
 * Category semantics for specialty products that remain the same broad type
 * but should not silently replace the conventional product. Candidate catalog
 * text is evidence about the candidate only; a specialty term becomes a hard
 * shopper requirement only when it is present in the request.
 */
const CATEGORY_SPECIALTY_VARIANTS: CategorySpecialtyVariantPolicy[] = [
  {
    category: "bread",
    variants: [{ label: "gluten-free", pattern: /\bgluten[ -]?free\b/i }],
  },
];

function assessCategorySpecialtyVariant(
  request: string,
  product: WalmartProduct,
  requestedType: string | undefined,
  candidateType: string | undefined,
): ProductVariantAssessment | undefined {
  const policy = CATEGORY_SPECIALTY_VARIANTS.find((item) => (
    item.category === requestedType && item.category === candidateType
  ));
  if (!policy) return undefined;

  const candidate = `${product.brand ?? ""} ${product.productType ?? ""} ${product.title}`;
  const requestedVariants = policy.variants.filter((variant) => variant.pattern.test(request));
  const candidateVariants = policy.variants.filter((variant) => variant.pattern.test(candidate));
  const missing = requestedVariants.filter((variant) => !candidateVariants.includes(variant));
  if (missing.length) {
    return {
      rejected: true,
      scoreAdjustment: 0,
      reasons: [`does not match requested ${missing.map((item) => item.label).join(" and ")} variety`],
    };
  }

  const unrequested = candidateVariants.filter((variant) => !requestedVariants.includes(variant));
  if (unrequested.length) {
    return {
      rejected: false,
      scoreAdjustment: -20,
      reasons: [`less typical unrequested ${unrequested.map((item) => item.label).join(" and ")} variety`],
    };
  }

  return requestedVariants.length
    ? {
        rejected: false,
        scoreAdjustment: 0,
        reasons: [`matches requested ${requestedVariants.map((item) => item.label).join(" and ")} variety`],
      }
    : { rejected: false, scoreAdjustment: 0, reasons: [] };
}

const CONFIRMED_SODA_IDENTITY_SCORE = 18;
const CONFIRMED_SODA_VARIANT_SCORE = 14;

/** Keep named soda requests on their standard/original variety by default. */
export function assessProductVariant(
  request: string,
  product: WalmartProduct,
): ProductVariantAssessment {
  const requestedType = inferProductCategory(request);
  const candidateType = inferProductCategory(`${product.productType ?? ""} ${product.title}`);
  const categorySpecialty = assessCategorySpecialtyVariant(
    request,
    product,
    requestedType,
    candidateType,
  );
  if (categorySpecialty) return categorySpecialty;
  if (requestedType !== "soda" || candidateType !== "soda") {
    return { rejected: false, scoreAdjustment: 0, reasons: [] };
  }

  const requestedBrand = extractRequestedBrand(request);
  const candidate = `${product.brand ?? ""} ${product.title}`;
  const confirmedBrandIdentity = Boolean(
    requestedBrand && productMatchesRequestedBrand(requestedBrand, product),
  );
  const applicableVariants = SODA_VARIANTS.filter((variant) => (
    variant.label !== "caffeine-free"
    || !requestedBrand
    || !["7UP", "Sprite"].includes(requestedBrand.canonical)
  ));
  const requestedVariants = applicableVariants.filter((variant) => variant.pattern.test(request));
  const candidateVariants = applicableVariants.filter((variant) => variant.pattern.test(candidate));
  const missing = requestedVariants.filter((variant) => !candidateVariants.includes(variant));
  const extra = candidateVariants.filter((variant) => !requestedVariants.includes(variant));

  if (missing.length) {
    return {
      rejected: true,
      scoreAdjustment: 0,
      reasons: [`does not match requested ${missing.map((item) => item.label).join(" and ")} variety`],
    };
  }
  if (extra.length && (requestedBrand || requestedVariants.length)) {
    return {
      rejected: true,
      scoreAdjustment: 0,
      reasons: [`unrequested ${extra.map((item) => item.label).join(" and ")} variety`],
    };
  }
  if (extra.length) {
    return {
      rejected: false,
      scoreAdjustment: -20,
      reasons: [`less typical ${extra.map((item) => item.label).join(" and ")} variety`],
    };
  }
  const identityScore = confirmedBrandIdentity ? CONFIRMED_SODA_IDENTITY_SCORE : 0;
  const identityReasons = confirmedBrandIdentity && requestedBrand
    ? [`confirms ${requestedBrand.canonical} soda identity`]
    : [];
  if (requestedVariants.length) {
    return {
      rejected: false,
      scoreAdjustment: identityScore + CONFIRMED_SODA_VARIANT_SCORE,
      reasons: [
        ...identityReasons,
        `matches requested ${requestedVariants.map((item) => item.label).join(" and ")} variety`,
      ],
    };
  }
  if (requestedBrand) {
    return {
      rejected: false,
      scoreAdjustment: identityScore + CONFIRMED_SODA_VARIANT_SCORE,
      reasons: [...identityReasons, "standard/original brand variety"],
    };
  }
  return { rejected: false, scoreAdjustment: 0, reasons: [] };
}
