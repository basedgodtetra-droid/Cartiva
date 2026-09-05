import { createHash } from "node:crypto";
import { stripDiscoveryPackageTerms, type ProductIntent } from "../product-search-intent";

export const KNOWLEDGE_VERSION = 1;
export const OFFER_TTL_MS = 120_000;
export type RelationshipKind = "EQUIVALENT" | "ALIAS" | "RELATED" | "SUBSTITUTE" | "CONTRADICTORY" | "PACKAGE_VARIANT" | "CATEGORY_MEMBER";
export const knowledgeId = (value: string) => createHash("sha256").update(`Cartiva knowledge v1\0${value}`).digest("hex");
export const normalizeKnowledgeText = (value: string) => value.normalize("NFKC").toLowerCase().replace(/%/g, " percent ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

// Reviewed taxonomy facts, not user votes or automatically generated equivalences.
export const CURATED_CONCEPTS = [
  { canonical: "coca cola zero sugar", category: "soda", aliases: ["coke zero", "coca cola zero", "coke zero sugar"] },
  { canonical: "diet coke", category: "soda", aliases: ["diet coca cola"] },
  { canonical: "whole milk", category: "milk", aliases: ["vitamin d whole milk"] },
  { canonical: "2 percent milk", category: "milk", aliases: ["2% milk", "reduced fat milk"] },
  { canonical: "toilet paper", category: "paper products", aliases: ["bath tissue", "bathroom tissue"] },
  { canonical: "chickpeas", category: "beans", aliases: ["garbanzo beans"] },
  { canonical: "93 7 ground beef", category: "meat", aliases: ["ground beef 93/7", "93% lean 7% fat ground beef"] },
  { canonical: "80 20 ground beef", category: "meat", aliases: ["ground beef 80/20", "80% lean 20% fat ground beef"] },
  { canonical: "kidney beans", category: "beans", aliases: [] },
  { canonical: "black beans", category: "beans", aliases: [] },
  { canonical: "gluten free bread", category: "bread", aliases: [] },
  { canonical: "white bread", category: "bread", aliases: [] },
  { canonical: "wheat bread", category: "bread", aliases: [] },
  { canonical: "light coconut milk", category: "pantry", aliases: ["lite coconut milk", "coconut milk light"] },
];
export const CURATED_CONTRADICTIONS = [
  ["coca cola zero sugar", "diet coke"], ["2 percent milk", "whole milk"],
  ["93 7 ground beef", "80 20 ground beef"], ["kidney beans", "black beans"],
  ["gluten free bread", "wheat bread"],
];
export const CATEGORY_RULES: Record<string, { identity: string[]; quantity: string; package: string }> = {
  eggs: { identity: ["count", "size", "explicit production type"], quantity: "counted contents", package: "exact count unless total is explicit" },
  milk: { identity: ["fat percentage", "dairy or plant", "flavor"], quantity: "cart units separate from volume", package: "explicit volume is a shelf requirement" },
  meat: { identity: ["animal", "cut", "lean fat ratio", "raw or cooked"], quantity: "fresh requested weight is total", package: "ceil required total divided by current package weight" },
  chicken: { identity: ["cut", "bone", "skin", "raw or cooked"], quantity: "fresh requested weight is total", package: "current package quantity must cover total" },
  turkey: { identity: ["cut", "lean fat ratio", "raw or cooked"], quantity: "fresh requested weight is total", package: "current package quantity must cover total" },
  soda: { identity: ["brand", "variant", "container"], quantity: "cart units separate from pack count", package: "explicit multipack is a hard requirement" },
  beans: { identity: ["bean species", "canned or dry", "sodium"], quantity: "outer cans are cart units", package: "explicit can size is a shelf requirement" },
  bread: { identity: ["type", "dietary requirements", "loaf format"], quantity: "loaves are cart units", package: "weight only hard when explicit" },
  produce: { identity: ["species", "fresh frozen or canned"], quantity: "each bunch bag or weight", package: "fresh total may span packages" },
  "paper products": { identity: ["product type", "rolls", "sheet format"], quantity: "rolls are counted contents", package: "do not confuse equivalent rolls with physical rolls" },
  pantry: { identity: ["product type", "diet", "variant"], quantity: "outer packages are cart units", package: "explicit total may span packages" },
};

// An allowlist, not a PII denylist: arbitrary prose never enters global memory.
// Unknown terms still search normally; they simply do not train the global store.
const PRODUCT_WORDS = new Set((`coca cola coke zero sugar diet pepsi dr pepper sprite fanta soda pop unsweetened sweetened regular original light lite coconut milk whole vitamin d reduced fat percent skim lactose free almond oat soy rice white brown jasmine basmati wild arborio bread wheat wholegrain grain sandwich sourdough rye multigrain gluten rolls buns hamburger hot dog bagel tortilla corn flour pasta red lentil lentils spaghetti penne macaroni noodles ramen kidney black pinto navy garbanzo chickpeas beans canned dry low sodium no salt added organic chicken breast breasts thighs wings tenderloins drumsticks boneless skinless ground beef turkey pork ham steak roast chops lean extra meat fresh frozen cooked raw sausage bacon breakfast fish salmon tilapia cod tuna seafood shrimp peeled deveined yogurt greek plain vanilla strawberry blueberry cheese cheddar mozzarella parmesan shredded sliced block cream butter eggs egg large medium cage range dozen juice orange apple cranberry lemonade water sparkling mineral spring coffee decaf ground instant tea green black cereal oats oatmeal granola honey peanut butter jam jelly mustard ketchup mayonnaise hot sauce salsa tomatoes tomato paste diced crushed onion onions garlic potatoes potato sweet carrots carrot broccoli spinach lettuce romaine cabbage kale celery cucumbers cucumber peppers pepper bell jalapeno apples apple bananas banana oranges orange lemons lemon limes lime avocado avocados grapes grape berries strawberries blueberries pineapple mango peaches peach pears pear mushrooms mushroom zucchini squash eggplant cucumber watermelon cantaloupe produce snacks chips potato tortilla crackers pretzels popcorn nuts almonds cashews walnuts raisins chocolate cookies ice cream frozen pizza nuggets fries soup broth stock vegetable vegetables canola olive oil vinegar baking powder soda yeast cinnamon cumin paprika turmeric salt pepper spices seasoning basil oregano parsley cilantro coconut chickpea quinoa couscous bulgur barley tofu tempeh miso kimchi curry tahini hummus pita naan edamame enchilada taco tacos burgers burrito wraps paper towels towel toilet bath bathroom tissue napkins detergent laundry dish soap trash bags foil plastic wrap sponge sponges wipes rolls sheet sheets package pack count ct oz lb lbs fl gal gallon half quart pint liter ml kg g cans can carton cartons box boxes bag bags bottle bottles loaf loaves tray trays tub tubs jar jars bunch each total servings family party single serve size kroger simple truth private selection great value thai kitchen barilla goya bushs hunts del monte daisy chobani fage oikos yoplait dannon tyson perdue jennie o butterball oscar mayer hillshire farm hormel heinz frenchs hellmanns dukes mccormick brawny bounty charmin scott angel soft cottonelle kleenex tide dawn reynolds ziploc sargento kraft tillamook cabot sara lee natures own wonder daves killer thomas pepperidge arnold mission old el paso ben uncle minute mahatma tilda indian mexican italian asian jasmine sushi nori seaweed sriracha hoisin tamari coconut evaporated condensed heavy whipping half and half light roast dark roast medium roast`).split(/\s+/));
export function safeKnowledgePhrase(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > 120) return false;
  if (/[@\r\n]|https?:|\b\d{4,}\b/i.test(value)) return false;
  const words = normalizeKnowledgeText(value).split(" ");
  return words.length <= 18 && words.some(w => PRODUCT_WORDS.has(w))
    && words.every(w => PRODUCT_WORDS.has(w) || /^\d{1,3}$/.test(w));
}
export interface SafeConcept { id: string; canonical: string; alias: string; category: string; attributes: string[]; curated: boolean }
export function conceptForIntent(intent: ProductIntent): SafeConcept | null {
  // Reject private markers BEFORE destructive normalization can erase them.
  if ([intent.originalText, intent.verificationText].some(text => /[@\r\n]|https?:|\b\d{4,}\b/i.test(text))) return null;
  const core = normalizeKnowledgeText(stripDiscoveryPackageTerms(intent.verificationText)
    .replace(/\s+(?:in\s+)?total\s*$/i, ""));
  if (!safeKnowledgePhrase(core)) return null;
  const curated = CURATED_CONCEPTS.find(c => [c.canonical, ...c.aliases].some(a => normalizeKnowledgeText(a) === core));
  const canonical = curated?.canonical ?? core;
  const category = curated?.category ?? (intent.category || "pantry");
  // Only structured, reviewed vocabulary. Never retain originalText or recipes.
  const attributes = intent.identityConstraints.map(c => normalizeKnowledgeText(c.searchText)).filter(safeKnowledgePhrase).sort();
  return { id: knowledgeId(canonical), canonical, alias: core, category, attributes, curated: Boolean(curated) };
}
export function decayedConfidence(confidence: number, confirmedAt: number, source: string, now = Date.now()) {
  return source === "CURATED" ? confidence : confidence * Math.pow(0.5, Math.max(0, now - confirmedAt) / (90 * 86400000));
}
