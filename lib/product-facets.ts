import type { WalmartProduct } from "./types";
import {
  extractRequestedBrand,
  productTitleConflictsWithProteinConstraint,
  stripFlexibleProteinPreferences,
} from "./product-knowledge";

export type ProductCategory =
  | "soda"
  | "bread"
  | "chicken"
  | "milk"
  | "chips"
  | "cheese"
  | "eggs"
  | "yogurt"
  | "produce"
  | "cereal"
  | "water"
  | "coffee"
  | "meat"
  | "turkey"
  | "sausage"
  | "seafood"
  | "canned-seafood"
  | "juice"
  | "pasta"
  | "rice"
  | "beans"
  | "bacon";

export interface ProductConstraint {
  attribute: string;
  value: string;
  label: string;
  source: "typed" | "selected";
  searchText: string;
  matchGroups: string[][];
}

export interface ProductFacetOptionView {
  id: string;
  label: string;
  selected: boolean;
  attributes: string[];
}

export interface ProductFacetGroupView {
  id: string;
  label: string;
  options: ProductFacetOptionView[];
}

export interface StructuredProductRequest {
  text: string;
  normalizedText: string;
  category?: ProductCategory;
  categoryLabel?: string;
  constraints: ProductConstraint[];
  selectedOptionIds: string[];
  groups: ProductFacetGroupView[];
}

type ConstraintTemplate = Omit<ProductConstraint, "source">;

interface FacetOption {
  id: string;
  label: string;
  constraints: ConstraintTemplate[];
}

interface FacetGroup {
  id: string;
  label: string;
  options: FacetOption[];
}

interface FacetDefinition {
  category: ProductCategory;
  label: string;
  detect: RegExp;
  exclude?: RegExp;
  groups: FacetGroup[] | ((text: string) => FacetGroup[]);
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/%/g, " percent ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(value: string, term: string) {
  return ` ${normalize(value)} `.includes(` ${normalize(term)} `);
}

function constraint(
  attribute: string,
  value: string,
  label: string,
  searchText: string,
  matchGroups: string[][],
): ConstraintTemplate {
  return { attribute, value, label, searchText, matchGroups };
}

function option(id: string, label: string, ...constraints: ConstraintTemplate[]): FacetOption {
  return { id, label, constraints };
}

function group(id: string, label: string, options: FacetOption[]): FacetGroup {
  return { id, label, options };
}

const brand = (value: string, aliases: string[] = [value]) =>
  constraint("brand", normalize(value), value, value, [aliases]);
const phrase = (attribute: string, value: string, label: string, aliases: string[] = [label]) =>
  constraint(attribute, value, label, label, [aliases]);

const sodaGroups: FacetGroup[] = [
  group("soda-brand", "Brand", [
    option("soda-brand-coca-cola", "Coca-Cola", brand("Coca-Cola", ["coca cola", "coke"])),
    option("soda-brand-sprite", "Sprite", brand("Sprite")),
    option("soda-brand-pepsi", "Pepsi", brand("Pepsi")),
    option("soda-brand-7up", "7UP", brand("7UP", ["7up", "7 up"])),
    option("soda-brand-dr-pepper", "Dr Pepper", brand("Dr Pepper", ["dr pepper", "dr. pepper"])),
  ]),
  group("soda-flavor", "Flavor", [
    option("soda-flavor-original", "Original", phrase("flavor", "original", "Original", ["original", "classic", "original taste"])),
    option("soda-flavor-zero", "Zero sugar", phrase("flavor", "zero-sugar", "Zero sugar", ["zero sugar", "zero"])),
    option("soda-flavor-diet", "Diet", phrase("flavor", "diet", "Diet", ["diet"])),
    option("soda-flavor-cherry", "Cherry", phrase("flavor", "cherry", "Cherry")),
    option("soda-flavor-lemon-lime", "Lemon lime", phrase("flavor", "lemon-lime", "Lemon lime", ["lemon lime", "lemon-lime"])),
  ]),
  group("soda-format", "Common format", [
    option(
      "soda-format-12-cans",
      "12-pack cans",
      phrase("packCount", "12", "12-pack", ["12 pack", "12-pack", "12 count", "12 ct"]),
      phrase("containerFormat", "cans", "Cans", ["can", "cans"]),
    ),
    option(
      "soda-format-2-liter",
      "2-liter bottle",
      phrase("containerSize", "2-liter", "2-liter", ["2 liter", "2-liter", "2 l"]),
      phrase("containerFormat", "bottle", "Bottle", ["bottle", "bottles"]),
    ),
    option(
      "soda-format-6-bottles",
      "6-pack bottles",
      phrase("packCount", "6", "6-pack", ["6 pack", "6-pack", "6 count", "6 ct"]),
      phrase("containerFormat", "bottles", "Bottles", ["bottle", "bottles"]),
    ),
    option(
      "soda-format-mini-cans",
      "Mini cans",
      phrase("containerFormat", "mini-cans", "Mini cans", ["mini can", "mini cans"]),
    ),
  ]),
];

const breadGroups: FacetGroup[] = [
  group("bread-type", "Bread type or style", [
    option("bread-type-white", "White", phrase("breadType", "white", "White")),
    option("bread-type-wheat", "Wheat", phrase("breadType", "wheat", "Wheat")),
    option("bread-type-whole-grain", "Whole grain", phrase("breadType", "whole-grain", "Whole grain", ["whole grain", "whole-grain"])),
    option("bread-style-buns", "Buns", phrase("style", "buns", "Buns", ["bun", "buns"])),
    option("bread-style-tortillas", "Tortillas", phrase("style", "tortillas", "Tortillas", ["tortilla", "tortillas"])),
  ]),
  group("bread-dietary", "Dietary requirement", [
    option(
      "bread-dietary-gluten-free",
      "Gluten free",
      phrase("dietary", "gluten-free", "Gluten free", ["gluten free", "gluten-free"]),
    ),
  ]),
  group("bread-brand", "Brand", [
    option("bread-brand-natures-own", "Nature’s Own", brand("Nature’s Own", ["natures own", "nature's own", "nature’s own"])),
    option("bread-brand-sara-lee", "Sara Lee", brand("Sara Lee")),
    option("bread-brand-wonder", "Wonder", brand("Wonder")),
    option("bread-brand-great-value", "Great Value", brand("Great Value")),
  ]),
  group("bread-size", "Optional loaf size", [
    option("bread-size-20oz", "20 oz loaf", phrase("loafSize", "20-oz", "20 oz loaf", ["20 oz", "20 ounce"])),
    option("bread-size-24oz", "24 oz loaf", phrase("loafSize", "24-oz", "24 oz loaf", ["24 oz", "24 ounce"])),
  ]),
];

const chickenGroups: FacetGroup[] = [
  group("chicken-cut", "Cut", [
    option("chicken-cut-breast", "Breast", phrase("cut", "breast", "Chicken breast", ["breast", "breasts"])),
    option("chicken-cut-thighs", "Thighs", phrase("cut", "thighs", "Chicken thighs", ["thigh", "thighs"])),
    option("chicken-cut-drumsticks", "Drumsticks", phrase("cut", "drumsticks", "Chicken drumsticks", ["drumstick", "drumsticks"])),
    option("chicken-cut-wings", "Wings", phrase("cut", "wings", "Chicken wings", ["wing", "wings"])),
    option("chicken-cut-tenders", "Tenders", phrase("cut", "tenders", "Chicken tenders", ["tender", "tenders"])),
    option("chicken-form-whole", "Whole chicken", phrase("form", "whole", "Whole chicken", ["whole chicken"])),
    option("chicken-form-ground", "Ground chicken", phrase("form", "ground", "Ground chicken", ["ground chicken"])),
  ]),
  group("chicken-prep", "Bone and skin", [
    option(
      "chicken-prep-boneless-skinless",
      "Boneless skinless",
      phrase("boneStyle", "boneless", "Boneless", ["boneless"]),
      phrase("skinStyle", "skinless", "Skinless", ["skinless"]),
    ),
    option("chicken-prep-bone-in", "Bone-in", phrase("boneStyle", "bone-in", "Bone-in", ["bone in", "bone-in"])),
  ]),
  group("chicken-state", "Fresh or frozen", [
    option("chicken-state-fresh", "Fresh", phrase("temperature", "fresh", "Fresh")),
    option("chicken-state-frozen", "Frozen", phrase("temperature", "frozen", "Frozen")),
  ]),
  group("chicken-package", "Package", [
    option("chicken-package-family", "Family pack", phrase("packageType", "family-pack", "Family pack", ["family pack", "value pack"])),
    option("chicken-package-tray", "Tray", phrase("packageType", "tray", "Tray")),
    option("chicken-package-bag", "Bag", phrase("packageType", "bag", "Bag", ["bag", "bagged"])),
  ]),
];

const milkGroups: FacetGroup[] = [
  group("milk-type", "Milk type", [
    option("milk-type-almond", "Almond", phrase("milkType", "almond", "Almond milk", ["almond milk", "almond"])),
    option("milk-type-oat", "Oat", phrase("milkType", "oat", "Oat milk", ["oat milk", "oat"])),
    option("milk-type-lactose-free", "Lactose free", phrase("milkType", "lactose-free", "Lactose free", ["lactose free", "lactose-free"])),
  ]),
  group("milk-fat", "Fat percentage", [
    option("milk-fat-whole", "Whole", phrase("fatPercentage", "whole", "Whole milk", ["whole milk", "whole"])),
    option("milk-fat-2", "2%", phrase("fatPercentage", "2-percent", "2% milk", ["2%", "2 percent"])),
    option("milk-fat-skim", "Skim", phrase("fatPercentage", "skim", "Skim milk", ["skim", "fat free", "nonfat"])),
  ]),
  group("milk-size", "Container size", [
    option("milk-size-gallon", "Gallon", phrase("containerSize", "gallon", "1 gallon", ["1 gallon", "gallon", "128 fl oz"])),
    option("milk-size-half-gallon", "Half gallon", phrase("containerSize", "half-gallon", "Half gallon", ["half gallon", "half-gallon", "64 fl oz"])),
  ]),
];

const chipsGroups: FacetGroup[] = [
  group("chips-brand", "Brand", [
    option("chips-brand-takis", "Takis", brand("Takis")),
    option("chips-brand-doritos", "Doritos", brand("Doritos")),
    option("chips-brand-lays", "Lay’s", brand("Lay’s", ["lays", "lay's", "lay’s"])),
    option("chips-brand-cheetos", "Cheetos", brand("Cheetos")),
  ]),
  group("chips-flavor", "Flavor", [
    option("chips-flavor-fuego", "Fuego", phrase("flavor", "fuego", "Fuego")),
    option("chips-flavor-nacho", "Nacho", phrase("flavor", "nacho", "Nacho")),
    option("chips-flavor-bbq", "Barbecue", phrase("flavor", "barbecue", "Barbecue", ["barbecue", "bbq"])),
    option("chips-flavor-sour-cream", "Sour cream & onion", phrase("flavor", "sour-cream-onion", "Sour cream and onion", ["sour cream and onion", "sour cream onion"])),
  ]),
  group("chips-size", "Bag size", [
    option("chips-size-snack", "Snack size", phrase("bagSize", "snack", "Snack size", ["snack size", "1 oz", "1 ounce"])),
    option("chips-size-standard", "Standard bag", phrase("bagSize", "standard", "Standard bag", ["standard bag", "8 oz", "9 oz", "9.9 oz", "10 oz"])),
    option("chips-size-family", "Family size", phrase("bagSize", "family", "Family size", ["family size", "party size"])),
  ]),
  group("chips-pack", "Pack quantity", [
    option("chips-pack-single", "Single bag", phrase("packCount", "1", "Single bag", ["single bag", "1 bag"])),
    option("chips-pack-multi", "Multipack", phrase("packCount", "multi", "Multipack", ["multipack", "multi pack", "variety pack"])),
  ]),
];

const cheeseGroups: FacetGroup[] = [
  group("cheese-type", "Cheese type", [
    option("cheese-type-american", "American", phrase("cheeseType", "american", "American cheese", ["american cheese", "american"])),
    option("cheese-type-cheddar", "Cheddar", phrase("cheeseType", "cheddar", "Cheddar")),
    option("cheese-type-swiss", "Swiss", phrase("cheeseType", "swiss", "Swiss cheese", ["swiss cheese", "swiss"])),
    option("cheese-type-mozzarella", "Mozzarella", phrase("cheeseType", "mozzarella", "Mozzarella")),
    option("cheese-type-provolone", "Provolone", phrase("cheeseType", "provolone", "Provolone")),
    option("cheese-type-cream", "Cream cheese", phrase("cheeseType", "cream", "Cream cheese", ["cream cheese"])),
  ]),
  group("cheese-form", "Form", [
    option("cheese-form-slices", "Slices", phrase("packageForm", "slices", "Slices", ["slice", "slices", "singles"])),
    option("cheese-form-shredded", "Shredded", phrase("packageForm", "shredded", "Shredded")),
    option("cheese-form-block", "Block", phrase("packageForm", "block", "Block")),
    option("cheese-form-string", "String cheese", phrase("packageForm", "string", "String cheese", ["string cheese", "cheese sticks"])),
  ]),
  group("cheese-brand", "Brand", [
    option("cheese-brand-kraft", "Kraft", brand("Kraft")),
    option("cheese-brand-sargento", "Sargento", brand("Sargento")),
    option("cheese-brand-tillamook", "Tillamook", brand("Tillamook")),
    option("cheese-brand-great-value", "Great Value", brand("Great Value")),
  ]),
  group("cheese-size", "Optional package size", [
    option("cheese-size-8", "8 oz", phrase("packageSize", "8-oz", "8 oz", ["8 oz", "8 ounce"])),
    option("cheese-size-16", "16 oz", phrase("packageSize", "16-oz", "16 oz", ["16 oz", "16 ounce", "1 lb"])),
  ]),
];

const eggsGroups: FacetGroup[] = [
  group("eggs-type", "Egg type", [
    option("eggs-type-large-white", "Large white", phrase("eggType", "large-white", "Large white", ["large white"])),
    option("eggs-type-large-brown", "Large brown", phrase("eggType", "large-brown", "Large brown", ["large brown"])),
    option("eggs-type-cage-free", "Cage free", phrase("eggType", "cage-free", "Cage free", ["cage free", "cage-free"])),
    option("eggs-type-organic", "Organic", phrase("eggType", "organic", "Organic")),
  ]),
  group("eggs-count", "Count", [
    option("eggs-count-6", "6 count", phrase("count", "6", "6 count", ["6 count", "6 ct", "half dozen"])),
    option("eggs-count-12", "12 count", phrase("count", "12", "12 count", ["12 count", "12 ct", "one dozen", "dozen"])),
    option("eggs-count-18", "18 count", phrase("count", "18", "18 count", ["18 count", "18 ct"])),
  ]),
];

const yogurtGroups: FacetGroup[] = [
  group("yogurt-style", "Style", [
    option("yogurt-style-greek", "Greek", phrase("yogurtStyle", "greek", "Greek yogurt", ["greek yogurt", "greek"])),
    option("yogurt-style-regular", "Regular", phrase("yogurtStyle", "regular", "Regular yogurt", ["regular yogurt"])),
    option("yogurt-style-skyr", "Skyr", phrase("yogurtStyle", "skyr", "Skyr")),
  ]),
  group("yogurt-flavor", "Flavor", [
    option("yogurt-flavor-plain", "Plain", phrase("flavor", "plain", "Plain")),
    option("yogurt-flavor-vanilla", "Vanilla", phrase("flavor", "vanilla", "Vanilla")),
    option("yogurt-flavor-strawberry", "Strawberry", phrase("flavor", "strawberry", "Strawberry")),
  ]),
  group("yogurt-package", "Package type", [
    option("yogurt-package-tub", "Tub", phrase("packageType", "tub", "Tub", ["tub", "container"])),
    option("yogurt-package-cup", "Single cup", phrase("packageType", "single-cup", "Single cup", ["single cup", "cup"])),
    option("yogurt-package-multi", "Multipack", phrase("packageType", "multipack", "Multipack", ["multipack", "multi pack", "4 pack", "6 pack"])),
  ]),
];

const PRODUCE_ITEM_PATTERN = /\b(?:cilantro|coriander leaves?|parsley|basil|apples?|bananas?|oranges?|onions?|tomatoes?|potatoes?|lettuce|spinach|carrots?|avocados?|broccoli|cranberries|cranberry|asparagus|bell\s+peppers?|peppers|cucumbers?|zucchini|squash|cauliflower|celery)\b/i;
const GENERIC_PRODUCE_PATTERN = /\b(?:produce|vegetables?|veggies?)\b/i;
const PRODUCE_FORM_PATTERN = /\b(?:fresh|frozen|canned|pickled|dried)\b/i;
const FRESH_HERB_PATTERN = /\b(?:cilantro|coriander leaves?|parsley|basil)\b/i;

const produceTypeGroup = group("produce-type", "Vegetable type", [
  option("produce-type-broccoli", "Broccoli", phrase("produceType", "broccoli", "broccoli")),
  option("produce-type-asparagus", "Asparagus", phrase("produceType", "asparagus", "asparagus")),
  option("produce-type-carrots", "Carrots", phrase("produceType", "carrots", "carrots", ["carrot", "carrots"])),
  option("produce-type-tomatoes", "Tomatoes", phrase("produceType", "tomatoes", "tomatoes", ["tomato", "tomatoes"])),
  option("produce-type-bell-peppers", "Bell peppers", phrase("produceType", "bell-peppers", "bell peppers", ["bell pepper", "bell peppers", "peppers"])),
  option("produce-type-cucumber", "Cucumber", phrase("produceType", "cucumber", "cucumber", ["cucumber", "cucumbers"])),
  option("produce-type-zucchini", "Zucchini", phrase("produceType", "zucchini", "zucchini")),
  option("produce-type-cauliflower", "Cauliflower", phrase("produceType", "cauliflower", "cauliflower")),
  option("produce-type-spinach", "Spinach", phrase("produceType", "spinach", "spinach")),
  option("produce-type-onions", "Onions", phrase("produceType", "onions", "onions", ["onion", "onions"])),
  option("produce-type-squash", "Squash", phrase("produceType", "squash", "squash")),
  option("produce-type-celery", "Celery", phrase("produceType", "celery", "celery")),
]);

const produceStateGroup = group("produce-state", "Fresh, frozen, or canned", [
  option("produce-state-fresh", "Fresh", phrase("produceState", "fresh", "fresh")),
  option("produce-state-frozen", "Frozen", phrase("produceState", "frozen", "frozen")),
  option("produce-state-canned", "Canned", phrase("produceState", "canned", "canned")),
]);

const herbStateGroup = group("produce-state", "Fresh or dried", [
  option("produce-state-fresh", "Fresh", phrase("produceState", "fresh", "fresh")),
  option("produce-state-dried", "Dried", phrase("produceState", "dried", "dried")),
]);

function produceGroups(text: string): FacetGroup[] {
  const stateGroup = FRESH_HERB_PATTERN.test(text) ? herbStateGroup : produceStateGroup;
  const varieties = /\bapples?\b/i.test(text)
    ? [
        option("produce-variety-honeycrisp", "Honeycrisp", phrase("variety", "honeycrisp", "Honeycrisp")),
        option("produce-variety-fuji", "Fuji", phrase("variety", "fuji", "Fuji")),
        option("produce-variety-gala", "Gala", phrase("variety", "gala", "Gala")),
        option("produce-variety-granny-smith", "Granny Smith", phrase("variety", "granny-smith", "Granny Smith", ["granny smith"])),
      ]
    : /\bpotato(?:es)?\b/i.test(text)
      ? [
          option("produce-variety-russet", "Russet", phrase("variety", "russet", "Russet")),
          option("produce-variety-red", "Red", phrase("variety", "red", "Red potatoes", ["red potato", "red potatoes"])),
          option("produce-variety-gold", "Gold", phrase("variety", "gold", "Gold potatoes", ["gold potato", "gold potatoes", "yukon gold"])),
        ]
      : /\btomato(?:es)?\b/i.test(text)
        ? [
            option("produce-variety-roma", "Roma", phrase("variety", "roma", "Roma")),
            option("produce-variety-cherry", "Cherry", phrase("variety", "cherry", "Cherry tomatoes", ["cherry tomato", "cherry tomatoes"])),
          ]
        : [];
  return [
    ...(GENERIC_PRODUCE_PATTERN.test(text) && !PRODUCE_ITEM_PATTERN.test(text)
      ? [produceTypeGroup]
      : []),
    stateGroup,
    ...(varieties.length ? [group("produce-variety", "Variety", varieties)] : []),
    group("produce-quantity", "Quantity", [
      option("produce-quantity-1lb", "1 lb", phrase("quantity", "1-lb", "1 lb", ["1 lb", "1 pound"])),
      option("produce-quantity-3lb", "3 lb", phrase("quantity", "3-lb", "3 lb", ["3 lb", "3 pounds"])),
      option("produce-quantity-5lb", "5 lb", phrase("quantity", "5-lb", "5 lb", ["5 lb", "5 pounds"])),
    ]),
    group("produce-package", "Bag or individual", [
      option("produce-package-bag", "Bag", phrase("packageType", "bag", "Bag", ["bag", "bagged"])),
      option("produce-package-individual", "Individual", phrase("packageType", "individual", "Individual", ["individual", "each", "single"])),
    ]),
  ];
}

const cerealGroups: FacetGroup[] = [
  group("cereal-brand", "Brand", [
    option("cereal-brand-cheerios", "Cheerios", brand("Cheerios")),
    option("cereal-brand-kelloggs", "Kellogg’s", brand("Kellogg’s", ["kelloggs", "kellogg's", "kellogg’s"])),
    option("cereal-brand-post", "Post", brand("Post")),
    option("cereal-brand-great-value", "Great Value", brand("Great Value")),
  ]),
  group("cereal-flavor", "Flavor", [
    option("cereal-flavor-original", "Original", phrase("flavor", "original", "Original")),
    option("cereal-flavor-chocolate", "Chocolate", phrase("flavor", "chocolate", "Chocolate")),
    option("cereal-flavor-cinnamon", "Cinnamon", phrase("flavor", "cinnamon", "Cinnamon")),
    option("cereal-flavor-honey", "Honey", phrase("flavor", "honey", "Honey")),
  ]),
  group("cereal-size", "Box size", [
    option("cereal-size-regular", "Regular box", phrase("boxSize", "regular", "Regular box", ["regular size", "regular box"])),
    option("cereal-size-family", "Family size", phrase("boxSize", "family", "Family size", ["family size"])),
    option("cereal-size-large", "Large size", phrase("boxSize", "large", "Large size", ["large size"])),
  ]),
];

const waterGroups: FacetGroup[] = [
  group("water-brand", "Brand", [
    option("water-brand-pure-life", "Pure Life", brand("Pure Life")),
    option("water-brand-dasani", "Dasani", brand("Dasani")),
    option("water-brand-aquafina", "Aquafina", brand("Aquafina")),
    option("water-brand-great-value", "Great Value", brand("Great Value")),
  ]),
  group("water-bottle", "Bottle size", [
    option("water-bottle-16-9", "16.9 oz", phrase("bottleSize", "16.9-oz", "16.9 oz", ["16.9 oz", "16.9 fl oz"])),
    option("water-bottle-20", "20 oz", phrase("bottleSize", "20-oz", "20 oz", ["20 oz", "20 fl oz"])),
    option("water-bottle-1l", "1 liter", phrase("bottleSize", "1-liter", "1 liter", ["1 liter", "1 l"])),
  ]),
  group("water-case", "Case quantity", [
    option("water-case-12", "12 pack", phrase("packCount", "12", "12 pack", ["12 pack", "12-pack", "12 count"])),
    option("water-case-24", "24 pack", phrase("packCount", "24", "24 pack", ["24 pack", "24-pack", "24 count"])),
    option("water-case-40", "40 pack", phrase("packCount", "40", "40 pack", ["40 pack", "40-pack", "40 count"])),
  ]),
];

const coffeeGroups: FacetGroup[] = [
  group("coffee-roast", "Roast", [
    option("coffee-roast-light", "Light roast", phrase("roast", "light", "Light roast", ["light roast"])),
    option("coffee-roast-medium", "Medium roast", phrase("roast", "medium", "Medium roast", ["medium roast"])),
    option("coffee-roast-dark", "Dark roast", phrase("roast", "dark", "Dark roast", ["dark roast"])),
  ]),
  group("coffee-format", "Format", [
    option("coffee-format-ground", "Ground", phrase("coffeeFormat", "ground", "Ground coffee", ["ground coffee", "ground"])),
    option("coffee-format-bean", "Whole bean", phrase("coffeeFormat", "whole-bean", "Whole bean", ["whole bean"])),
    option("coffee-format-kcup", "K-Cup pods", phrase("coffeeFormat", "k-cup", "K-Cup pods", ["k cup", "k-cup", "coffee pods"])),
    option("coffee-format-instant", "Instant", phrase("coffeeFormat", "instant", "Instant coffee", ["instant coffee", "instant"])),
  ]),
  group("coffee-size", "Package size", [
    option("coffee-size-10", "10 oz", phrase("packageSize", "10-oz", "10 oz", ["10 oz", "10 ounce"])),
    option("coffee-size-12", "12 oz", phrase("packageSize", "12-oz", "12 oz", ["12 oz", "12 ounce"])),
    option("coffee-size-24", "24 oz", phrase("packageSize", "24-oz", "24 oz", ["24 oz", "24 ounce"])),
  ]),
];

const meatCoreGroups: FacetGroup[] = [
  group("meat-cut", "Cut", [
    option("meat-cut-ground", "Ground", phrase("form", "ground", "Ground")),
    option("meat-cut-steak", "Steak", phrase("form", "steak", "Steak")),
    option("meat-cut-roast", "Roast", phrase("form", "roast", "Roast")),
    option("meat-cut-chops", "Chops", phrase("cut", "chops", "Chops", ["chop", "chops"])),
    option("meat-cut-ribs", "Ribs", phrase("cut", "ribs", "Ribs", ["rib", "ribs"])),
  ]),
  group("meat-weight", "Weight range", [
    option("meat-weight-1", "About 1 lb", phrase("weightRange", "1-lb", "1 lb", ["1 lb", "1 pound"])),
    option("meat-weight-3", "About 3 lb", phrase("weightRange", "3-lb", "3 lb", ["3 lb", "3 pounds"])),
    option("meat-weight-5", "About 5 lb", phrase("weightRange", "5-lb", "5 lb", ["5 lb", "5 pounds"])),
  ]),
  group("meat-state", "Fresh or frozen", [
    option("meat-state-fresh", "Fresh", phrase("temperature", "fresh", "Fresh")),
    option("meat-state-frozen", "Frozen", phrase("temperature", "frozen", "Frozen")),
  ]),
  group("meat-package", "Package", [
    option("meat-package-family", "Family pack", phrase("packageType", "family-pack", "Family pack", ["family pack", "value pack"])),
    option("meat-package-tray", "Tray", phrase("packageType", "tray", "Tray")),
    option("meat-package-vacuum", "Vacuum sealed", phrase("packageType", "vacuum-sealed", "Vacuum sealed", ["vacuum sealed", "vacuum-sealed"])),
  ]),
];

const groundMeatRatioGroup = group("ground-meat-ratio", "Lean / fat ratio", [
  option("ground-meat-ratio-80-20", "80/20", phrase("leanRatio", "80/20", "80/20", ["80/20", "80% lean", "80 percent lean", "80%"])),
  option("ground-meat-ratio-85-15", "85/15", phrase("leanRatio", "85/15", "85/15", ["85/15", "85% lean", "85 percent lean", "85%"])),
  option("ground-meat-ratio-90-10", "90/10", phrase("leanRatio", "90/10", "90/10", ["90/10", "90% lean", "90 percent lean", "90%"])),
  option("ground-meat-ratio-93-7", "93/7", phrase("leanRatio", "93/7", "93/7", ["93/7", "93% lean", "93 percent lean", "93%"])),
  option("ground-meat-ratio-96-4", "96/4", phrase("leanRatio", "96/4", "96/4", ["96/4", "96% lean", "96 percent lean", "96%"])),
  option("ground-meat-ratio-99-1", "99% lean", phrase("leanRatio", "99/1", "99% lean", ["99/1", "99% lean", "99 percent lean", "99%"])),
]);

const steakCutGroup = group("steak-cut", "Steak cut", [
  option("steak-cut-ribeye", "Ribeye", phrase("cut", "ribeye", "Ribeye", ["ribeye", "rib eye"])),
  option("steak-cut-new-york", "New York strip", phrase("cut", "new-york-strip", "New York strip", ["new york strip", "ny strip"])),
  option("steak-cut-sirloin", "Sirloin", phrase("cut", "sirloin", "Sirloin")),
  option("steak-cut-filet", "Filet mignon", phrase("cut", "filet-mignon", "Filet mignon", ["filet mignon"])),
  option("steak-cut-t-bone", "T-bone", phrase("cut", "t-bone", "T-bone", ["t bone", "t-bone"])),
]);

function meatGroups(text: string): FacetGroup[] {
  const groups = [...meatCoreGroups];
  if (/\bground\s+(?:beef|pork)\b/i.test(text)) groups.splice(1, 0, groundMeatRatioGroup);
  if (/\b(?:steaks?|ribeye|sirloin|filet\s+mignon|new\s+york\s+strip|t[ -]?bone)\b/i.test(text)) {
    groups.splice(1, 0, steakCutGroup);
  }
  return groups;
}

const turkeyGroups: FacetGroup[] = [
  group("turkey-form", "Form", [
    option("turkey-form-ground", "Ground turkey", phrase("form", "ground", "Ground turkey", ["ground turkey"])),
    option("turkey-cut-breast", "Turkey breast", phrase("cut", "breast", "Turkey breast", ["turkey breast"])),
    option("turkey-form-whole", "Whole turkey", phrase("form", "whole", "Whole turkey", ["whole turkey"])),
    option("turkey-form-deli", "Deli turkey", phrase("form", "deli", "Deli turkey", ["deli turkey"])),
  ]),
  groundMeatRatioGroup,
];

const sausageGroups: FacetGroup[] = [
  group("sausage-kind", "Kind", [
    option("sausage-breakfast", "Breakfast", phrase("sausageKind", "breakfast", "Breakfast sausage", ["breakfast sausage"])),
    option("sausage-italian", "Italian", phrase("sausageKind", "italian", "Italian sausage", ["italian sausage"])),
    option("sausage-bratwurst", "Bratwurst", phrase("sausageKind", "bratwurst", "Bratwurst", ["bratwurst", "brats"])),
    option("sausage-smoked", "Smoked", phrase("sausageKind", "smoked", "Smoked sausage", ["smoked sausage"])),
    option("sausage-chicken", "Chicken", phrase("sausageKind", "chicken", "Chicken sausage", ["chicken sausage"])),
  ]),
];

const seafoodGroups: FacetGroup[] = [
  group("seafood-species", "Species", [
    option("seafood-species-salmon", "Salmon", phrase("species", "salmon", "Salmon")),
    option("seafood-species-tilapia", "Tilapia", phrase("species", "tilapia", "Tilapia")),
    option("seafood-species-cod", "Cod", phrase("species", "cod", "Cod")),
    option("seafood-species-tuna", "Tuna", phrase("species", "tuna", "Tuna")),
    option("seafood-species-catfish", "Catfish", phrase("species", "catfish", "Catfish")),
    option("seafood-species-shrimp", "Shrimp", phrase("species", "shrimp", "Shrimp")),
  ]),
  group("seafood-form", "Form", [
    option("seafood-form-fillet", "Fillet", phrase("seafoodForm", "fillet", "Fillet", ["fillet", "fillets"])),
    option("seafood-form-portions", "Portions", phrase("seafoodForm", "portions", "Portions", ["portion", "portions"])),
    option("seafood-form-side", "Whole side", phrase("seafoodForm", "whole-side", "Whole side", ["whole side", "salmon side"])),
  ]),
  group("seafood-cooking", "Preparation", [
    option("seafood-cooking-raw", "Raw", phrase("cookingState", "raw", "Raw")),
    option("seafood-cooking-cooked", "Cooked", phrase("cookingState", "cooked", "Cooked", ["cooked", "fully cooked"])),
  ]),
  group("shrimp-size", "Shrimp size", [
    option("shrimp-size-small", "Small", phrase("shrimpSize", "small", "Small")),
    option("shrimp-size-medium", "Medium", phrase("shrimpSize", "medium", "Medium")),
    option("shrimp-size-large", "Large", phrase("shrimpSize", "large", "Large")),
    option("shrimp-size-jumbo", "Jumbo", phrase("shrimpSize", "jumbo", "Jumbo")),
  ]),
];

const cannedSeafoodGroups: FacetGroup[] = [
  group("seafood-type", "Type", [
    option("seafood-type-chunk-light", "Chunk light", phrase("seafoodType", "chunk-light", "Chunk light", ["chunk light"])),
    option("seafood-type-albacore", "Albacore", phrase("seafoodType", "albacore", "Albacore", ["albacore", "white tuna"])),
    option("seafood-type-salmon", "Salmon", phrase("seafoodType", "salmon", "Canned salmon", ["salmon", "canned salmon"])),
  ]),
  group("seafood-packed", "Packed in", [
    option("seafood-packed-water", "Water", phrase("packedIn", "water", "In water", ["in water", "packed in water"])),
    option("seafood-packed-oil", "Oil", phrase("packedIn", "oil", "In oil", ["in oil", "packed in oil"])),
  ]),
  group("seafood-package", "Package", [
    option("seafood-package-can", "Can", phrase("packageType", "can", "Can", ["can", "canned"])),
    option("seafood-package-pouch", "Pouch", phrase("packageType", "pouch", "Pouch", ["pouch", "pouches"])),
    option("seafood-package-multi", "Multipack", phrase("packageType", "multipack", "Multipack", ["multipack", "multi pack", "4 pack", "8 pack"])),
  ]),
];

const juiceGroups: FacetGroup[] = [
  group("juice-fruit", "Juice type", [
    option("juice-fruit-apple", "Apple", phrase("juiceType", "apple", "Apple juice", ["apple juice", "apple"])),
    option("juice-fruit-orange", "Orange", phrase("juiceType", "orange", "Orange juice", ["orange juice", "orange"])),
    option("juice-fruit-cranberry", "Cranberry", phrase("juiceType", "cranberry", "Cranberry juice", ["cranberry juice", "cranberry"])),
  ]),
  group("juice-style", "Style", [
    option("juice-style-100", "100% juice", phrase("juiceStyle", "100-percent", "100% juice", ["100% juice", "100 percent juice"])),
    option("juice-style-cocktail", "Juice cocktail", phrase("juiceStyle", "cocktail", "Juice cocktail", ["juice cocktail", "cocktail"])),
  ]),
  group("juice-size", "Container size", [
    option("juice-size-64", "64 fl oz", phrase("containerSize", "64-fl-oz", "64 fl oz", ["64 fl oz", "64 oz"])),
    option("juice-size-96", "96 fl oz", phrase("containerSize", "96-fl-oz", "96 fl oz", ["96 fl oz", "96 oz"])),
  ]),
];

const pastaGroups: FacetGroup[] = [
  group("pasta-shape", "Shape", [
    option("pasta-shape-spaghetti", "Spaghetti", phrase("shape", "spaghetti", "Spaghetti")),
    option("pasta-shape-penne", "Penne", phrase("shape", "penne", "Penne")),
    option("pasta-shape-elbow", "Elbow macaroni", phrase("shape", "elbow", "Elbow macaroni", ["elbow macaroni", "elbows"])),
    option("pasta-shape-fettuccine", "Fettuccine", phrase("shape", "fettuccine", "Fettuccine")),
  ]),
  group("pasta-style", "Style", [
    option("pasta-style-regular", "Regular", phrase("pastaStyle", "regular", "Regular pasta", ["regular pasta"])),
    option("pasta-style-whole-wheat", "Whole wheat", phrase("pastaStyle", "whole-wheat", "Whole wheat", ["whole wheat"])),
    option("pasta-style-gluten-free", "Gluten free", phrase("pastaStyle", "gluten-free", "Gluten free", ["gluten free", "gluten-free"])),
  ]),
  group("pasta-size", "Package size", [
    option("pasta-size-12", "12 oz", phrase("packageSize", "12-oz", "12 oz", ["12 oz", "12 ounce"])),
    option("pasta-size-16", "16 oz", phrase("packageSize", "16-oz", "16 oz", ["16 oz", "16 ounce", "1 lb"])),
  ]),
];

const riceGroups: FacetGroup[] = [
  group("rice-type", "Rice type", [
    option("rice-type-white", "White", phrase("riceType", "white", "White rice", ["white rice", "white"])),
    option("rice-type-brown", "Brown", phrase("riceType", "brown", "Brown rice", ["brown rice", "brown"])),
    option("rice-type-jasmine", "Jasmine", phrase("riceType", "jasmine", "Jasmine rice", ["jasmine rice", "jasmine"])),
    option("rice-type-basmati", "Basmati", phrase("riceType", "basmati", "Basmati rice", ["basmati rice", "basmati"])),
  ]),
  group("rice-format", "Format", [
    option("rice-format-dry", "Dry bag", phrase("packageType", "dry-bag", "Dry rice bag", ["dry rice", "bag"])),
    option("rice-format-instant", "Instant", phrase("packageType", "instant", "Instant rice", ["instant rice", "instant"])),
    option("rice-format-pouches", "Ready rice pouches", phrase("packageType", "pouches", "Ready rice pouches", ["ready rice", "pouch", "pouches"])),
  ]),
  group("rice-size", "Package size", [
    option("rice-size-1", "1 lb", phrase("packageSize", "1-lb", "1 lb", ["1 lb", "1 pound"])),
    option("rice-size-5", "5 lb", phrase("packageSize", "5-lb", "5 lb", ["5 lb", "5 pounds"])),
  ]),
];

const beansGroups: FacetGroup[] = [
  group("beans-type", "Bean type", [
    option("beans-type-black", "Black", phrase("beanType", "black", "Black beans", ["black bean", "black beans"])),
    option("beans-type-pinto", "Pinto", phrase("beanType", "pinto", "Pinto beans", ["pinto bean", "pinto beans"])),
    option("beans-type-kidney", "Kidney", phrase("beanType", "kidney", "Kidney beans", ["kidney bean", "kidney beans"])),
    option("beans-type-chickpeas", "Chickpeas", phrase("beanType", "chickpeas", "Chickpeas", ["chickpea", "chickpeas", "garbanzo beans"])),
  ]),
  group("beans-package", "Package", [
    option("beans-package-canned", "Canned", phrase("packageType", "canned", "Canned", ["can", "canned"])),
    option("beans-package-dry", "Dry bag", phrase("packageType", "dry", "Dry beans", ["dry beans", "bag"])),
  ]),
  group("beans-size", "Package size", [
    option("beans-size-15", "15 oz", phrase("packageSize", "15-oz", "15 oz", ["15 oz", "15 ounce"])),
    option("beans-size-1lb", "1 lb", phrase("packageSize", "1-lb", "1 lb", ["1 lb", "1 pound"])),
  ]),
];

const baconGroups: FacetGroup[] = [
  group("bacon-style", "Style", [
    option("bacon-style-regular", "Regular cut", phrase("baconStyle", "regular", "Regular cut", ["regular cut"])),
    option("bacon-style-thick", "Thick cut", phrase("baconStyle", "thick", "Thick cut", ["thick cut", "thick-cut"])),
    option("bacon-style-turkey", "Turkey bacon", phrase("baconStyle", "turkey", "Turkey bacon", ["turkey bacon"])),
  ]),
  group("bacon-smoke", "Smoke flavor", [
    option("bacon-smoke-hickory", "Hickory smoked", phrase("smokeFlavor", "hickory", "Hickory smoked", ["hickory", "hickory smoked"])),
    option("bacon-smoke-applewood", "Applewood smoked", phrase("smokeFlavor", "applewood", "Applewood smoked", ["applewood", "applewood smoked"])),
  ]),
  group("bacon-size", "Package size", [
    option("bacon-size-12", "12 oz", phrase("packageSize", "12-oz", "12 oz", ["12 oz", "12 ounce"])),
    option("bacon-size-16", "16 oz", phrase("packageSize", "16-oz", "16 oz", ["16 oz", "16 ounce", "1 lb"])),
  ]),
];

const DEFINITIONS: FacetDefinition[] = [
  { category: "canned-seafood", label: "Canned seafood", detect: /\b(?:tuna|albacore|canned salmon|canned sardines?)\b/i, exclude: /\b(?:cat|dog|pet)\s+(?:food|treats?)\b|\b(?:tuna|salmon|sardine)\s+(?:salad|pizza|sandwich|dip|spread)\b|\b(?:fish|cod|salmon|tuna)(?:\s+liver)?\s+(?:oil|supplements?|softgels?|capsules?|tablets?)\b/i, groups: cannedSeafoodGroups },
  { category: "seafood", label: "Seafood", detect: /\b(?:fish|salmon|tilapia|cod|catfish|shrimp)\b/i, exclude: /\b(?:cat|dog|pet)\s+(?:food|treats?)\b|\b(?:fish|salmon|shrimp|cod|tuna|tilapia|catfish)(?:\s+liver)?\s+(?:oil|seasoning|flavor|supplements?|softgels?|capsules?|tablets?)\b/i, groups: seafoodGroups },
  { category: "soda", label: "Soda", detect: /\b(?:soda|soft drink|cola|coke|coca[ -]?cola|sprite|pepsi|7\s?up|dr\.? pepper|mountain dew|mtn dew)\b/i, exclude: /\bbaking soda\b/i, groups: sodaGroups },
  { category: "juice", label: "Juice", detect: /\b(?:juice|apple juice|orange juice|cranberry juice)\b/i, groups: juiceGroups },
  { category: "bread", label: "Bread", detect: /\b(?:bread|loaf|buns?|tortillas?)\b/i, exclude: /\bbread crumbs?\b/i, groups: breadGroups },
  { category: "sausage", label: "Sausage", detect: /\b(?:sausage|bratwurst|brats)\b/i, exclude: /\bsausage\s+(?:seasoning|flavor|pizza|salad|sandwich|dip|spread)\b/i, groups: sausageGroups },
  { category: "turkey", label: "Turkey", detect: /\bturkey\b/i, exclude: /\b(?:cat|dog|pet)\s+(?:food|treats?)\b|\bturkey\s+(?:bacon|sausage|seasoning|flavor)\b/i, groups: turkeyGroups },
  { category: "chicken", label: "Chicken", detect: /\bchicken\b/i, exclude: /\b(?:chicken broth|chicken soup|chicken noodle|chicken nuggets?|chicken patties)\b/i, groups: chickenGroups },
  { category: "milk", label: "Milk", detect: /\b(?:milk|almond milk|oat milk)\b/i, exclude: /\b(?:milk chocolate|milkshake|milk shake)\b/i, groups: milkGroups },
  { category: "chips", label: "Chips", detect: /\b(?:chips?|takis|doritos|lay['’]?s|cheetos)\b/i, exclude: /\b(?:chocolate|baking|wood)\s+chips\b/i, groups: chipsGroups },
  { category: "cheese", label: "Cheese", detect: /\b(?:cheese|cheddar|mozzarella|provolone)\b/i, exclude: /\b(?:cheese[- ]flavored|cheese\s+(?:crackers?|puffs?|chips?|dip|sauce|popcorn)|mac(?:aroni)?\s+and\s+cheese)\b/i, groups: cheeseGroups },
  { category: "eggs", label: "Eggs", detect: /\beggs?\b/i, exclude: /\b(?:egg noodles?|egg rolls?)\b/i, groups: eggsGroups },
  { category: "yogurt", label: "Yogurt", detect: /\b(?:yogurt|skyr)\b/i, groups: yogurtGroups },
  { category: "produce", label: "Produce", detect: /\b(?:produce|vegetables?|veggies?|fresh herbs?|cilantro|coriander leaves?|parsley|basil|apples?|bananas?|oranges?|onions?|tomatoes?|potatoes?|lettuce|spinach|carrots?|avocados?|broccoli|cranberries|cranberry|asparagus|bell\s+peppers?|peppers|cucumbers?|zucchini|squash|cauliflower|celery)\b/i, exclude: /\b(?:apple juice|orange juice|cranberry juice|cilantro seasoning|coriander seasoning|parsley seasoning|basil seasoning|body wash|shower gel|shampoo|conditioner|soap|lotion|cleanser|toothpaste|deodorant|antiperspirant|detergent)\b/i, groups: produceGroups },
  { category: "cereal", label: "Cereal", detect: /\b(?:cereal|cheerios|corn flakes|frosted flakes)\b/i, exclude: /\bcereal bars?\b/i, groups: cerealGroups },
  { category: "water", label: "Water", detect: /\b(?:water|dasani|aquafina|pure life)\b/i, groups: waterGroups },
  { category: "coffee", label: "Coffee", detect: /\bcoffee\b/i, exclude: /\bcoffee creamer\b/i, groups: coffeeGroups },
  { category: "pasta", label: "Pasta", detect: /\b(?:pasta|spaghetti|penne|macaroni|fettuccine|linguine)\b/i, exclude: /\bpasta\s+sauce\b|\bmac(?:aroni)?\s+and\s+cheese\b/i, groups: pastaGroups },
  { category: "rice", label: "Rice", detect: /\b(?:rice|jasmine rice|basmati rice)\b/i, exclude: /\brice\s+(?:cakes?|cereal|pudding|crackers?)\b/i, groups: riceGroups },
  { category: "beans", label: "Beans", detect: /\bbeans?\b/i, exclude: /\b(?:jelly|coffee|cocoa|vanilla)\s+beans?\b/i, groups: beansGroups },
  { category: "bacon", label: "Bacon", detect: /\bbacon\b/i, exclude: /\b(?:imitation\s+)?bacon\s+bits?\b/i, groups: baconGroups },
  { category: "meat", label: "Meat", detect: /\b(?:meat|beef|pork|steak|roast|ground beef|chops?|ribs?|sausage)\b/i, exclude: /\b(?:steak|beef|pork|meat)\s+(?:seasoning|sauce|marinade|flavor|dog treats?|jerky)\b/i, groups: meatGroups },
];

function groupsFor(definition: FacetDefinition, text: string) {
  return typeof definition.groups === "function" ? definition.groups(text) : definition.groups;
}

function allOptions() {
  return DEFINITIONS.flatMap((definition) => {
    const seeds = typeof definition.groups === "function"
      ? definition.category === "meat"
        ? ["beef", "ground beef", "steak", "pork chops"]
        : ["produce", "apples", "potatoes", "tomatoes"]
      : [""];
    return seeds.flatMap((seed) => groupsFor(definition, seed).flatMap((item) => item.options));
  });
}

function optionRegistryFor(definition: FacetDefinition, text: string) {
  return new Map(groupsFor(definition, text).flatMap((item) => item.options).map((item) => [item.id, item]));
}

function constraintMatchesText(text: string, value: ConstraintTemplate | ProductConstraint) {
  return value.matchGroups.every((alternatives) => alternatives.some((term) => containsTerm(text, term)));
}

function constraintSpecificity(value: ConstraintTemplate) {
  return value.matchGroups.reduce((total, alternatives) => (
    total + Math.max(...alternatives.map((term) => normalize(term).length))
  ), 0);
}

function detectDefinition(text: string) {
  return DEFINITIONS.find((definition) =>
    definition.detect.test(text) && !(definition.exclude?.test(text) ?? false),
  );
}

export function sanitizeFacetOptionIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  const known = new Set(allOptions().map((item) => item.id));
  return [...new Set(value.filter((item): item is string => typeof item === "string" && known.has(item)))].slice(0, 12);
}

export function stableFacetItemKey(text: string) {
  return normalize(text);
}

export function analyzeProductFacets(
  text: string,
  selectedOptionIds: string[] = [],
): StructuredProductRequest {
  const definition = detectDefinition(text);
  if (!definition) {
    return {
      text,
      normalizedText: normalize(text),
      constraints: [],
      selectedOptionIds: [],
      groups: [],
    };
  }

  const groups = groupsFor(definition, text);
  const constraintText = stripFlexibleProteinPreferences(text);
  const registry = optionRegistryFor(definition, text);
  const validSelectedIds = [...new Set(selectedOptionIds)].filter((id) => registry.has(id));
  const templates = groups.flatMap((item) => item.options.flatMap((item) => item.constraints));
  const typedByAttribute = new Map<string, ProductConstraint>();
  const matchedTemplates = templates
    .filter((template) => constraintMatchesText(constraintText, template))
    .sort((a, b) => constraintSpecificity(b) - constraintSpecificity(a));
  for (const template of matchedTemplates) {
    if (!typedByAttribute.has(template.attribute)) {
      typedByAttribute.set(template.attribute, { ...template, source: "typed" });
    }
  }
  const requestedBrand = extractRequestedBrand(text);
  if (requestedBrand && !typedByAttribute.has("brand")) {
    typedByAttribute.set("brand", {
      attribute: "brand",
      value: normalize(requestedBrand.canonical),
      label: requestedBrand.canonical,
      source: "typed",
      searchText: requestedBrand.canonical,
      matchGroups: [[requestedBrand.canonical, ...requestedBrand.aliases]],
    });
  }

  const selectedByAttribute = new Map<string, ProductConstraint>();
  for (const id of validSelectedIds) {
    const selected = registry.get(id)!;
    for (const template of selected.constraints) {
      if (!typedByAttribute.has(template.attribute)) {
        selectedByAttribute.set(template.attribute, { ...template, source: "selected" });
      }
    }
  }

  const visibleGroups = groups.flatMap((facetGroup) => {
    const groupAttributes = new Set(
      facetGroup.options.flatMap((item) => item.constraints.map((item) => item.attribute)),
    );
    if ([...groupAttributes].some((attribute) => typedByAttribute.has(attribute))) return [];
    return [{
      id: facetGroup.id,
      label: facetGroup.label,
      options: facetGroup.options.map((item) => ({
        id: item.id,
        label: item.label,
        selected: validSelectedIds.includes(item.id),
        attributes: [...new Set(item.constraints.map((value) => value.attribute))],
      })),
    }];
  });

  return {
    text,
    normalizedText: normalize(text),
    category: definition.category,
    categoryLabel: definition.label,
    constraints: [...typedByAttribute.values(), ...selectedByAttribute.values()],
    selectedOptionIds: validSelectedIds,
    groups: visibleGroups,
  };
}

export function selectFacetOption(
  text: string,
  selectedOptionIds: string[],
  optionId: string,
) {
  const definition = detectDefinition(text);
  if (!definition) return [];
  const registry = optionRegistryFor(definition, text);
  const selectedOption = registry.get(optionId);
  if (!selectedOption) return sanitizeFacetOptionIds(selectedOptionIds);
  if (selectedOptionIds.includes(optionId)) {
    return selectedOptionIds.filter((id) => id !== optionId);
  }
  const selectedAttributes = new Set(selectedOption.constraints.map((item) => item.attribute));
  const withoutConflicts = selectedOptionIds.filter((id) => {
    const current = registry.get(id);
    return current && !current.constraints.some((item) => selectedAttributes.has(item.attribute));
  });
  return [...withoutConflicts, optionId];
}

export function buildFacetSearchQuery(text: string, constraints: ProductConstraint[]) {
  const additions = constraints
    .filter((item) => item.source === "selected" && !constraintMatchesText(text, item))
    .map((item) => item.searchText);
  return [text.trim(), ...new Set(additions)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

const PACKAGE_SEARCH_ATTRIBUTES = new Set([
  "bagSize",
  "bottleSize",
  "boxSize",
  "containerFormat",
  "containerSize",
  "count",
  "loafSize",
  "packCount",
  "packageSize",
  "quantity",
  "weightRange",
]);

function walmartSearchIdentity(request: StructuredProductRequest) {
  if (request.category === "produce") {
    const selectedType = request.constraints.find((item) => item.attribute === "produceType");
    return selectedType?.searchText
      ?? request.text.match(PRODUCE_ITEM_PATTERN)?.[0]
      ?? request.text.match(GENERIC_PRODUCE_PATTERN)?.[0]
      ?? "produce";
  }
  if (request.category === "canned-seafood") {
    return request.text.match(/\b(?:tuna|albacore|salmon|sardines?)\b/i)?.[0] ?? "canned seafood";
  }
  if (request.category === "seafood") {
    return request.text.match(/\b(?:salmon|tilapia|cod|catfish|shrimp|fish)\b/i)?.[0] ?? "seafood";
  }
  if (request.category === "turkey") return "turkey";
  if (request.category === "sausage") {
    return request.text.match(/\b(?:breakfast sausage|italian sausage|smoked sausage|chicken sausage|bratwurst|sausage)\b/i)?.[0] ?? "sausage";
  }
  if (request.category === "meat") {
    return request.text.match(/\b(?:beef|pork|steak|roast|chops?|ribs?|meat)\b/i)?.[0] ?? "meat";
  }
  return request.categoryLabel ?? request.category;
}

function usefulWalmartSearchConstraint(value: ProductConstraint) {
  if (value.attribute === "flavor" && value.value === "original") return false;
  if (value.attribute === "bagSize" && value.value === "standard") return false;
  if (value.attribute === "boxSize" && value.value === "regular") return false;
  if (value.attribute === "packCount" && value.value === "1") return false;
  return true;
}

/**
 * Build a concise retailer query from structured intent. Matching still uses
 * the shopper's full text and every constraint, but Walmart should not receive
 * vague UI vocabulary or stray unqualified numbers that reduce search recall.
 */
export function buildWalmartSearchQuery(request: StructuredProductRequest) {
  if (!request.category) return request.text.trim();

  const useful = request.constraints.filter(usefulWalmartSearchConstraint);
  const brandConstraints = useful.filter((item) => item.attribute === "brand");
  const descriptorConstraints = useful.filter((item) =>
    item.attribute !== "brand" && !PACKAGE_SEARCH_ATTRIBUTES.has(item.attribute));
  const packageConstraints = useful.filter((item) => PACKAGE_SEARCH_ATTRIBUTES.has(item.attribute));
  const phrases: string[] = [];
  const addPhrase = (value: string | undefined) => {
    const phraseValue = value?.replace(/\s+/g, " ").trim();
    if (!phraseValue) return;
    if (phrases.some((existing) => containsTerm(existing, phraseValue))) return;
    phrases.push(phraseValue);
  };

  for (const value of brandConstraints) addPhrase(value.searchText);
  if (request.category === "produce") {
    const identity = walmartSearchIdentity(request);
    const selectedState = descriptorConstraints.find((item) => item.attribute === "produceState");
    const typedState = request.text.match(PRODUCE_FORM_PATTERN)?.[0];
    const concreteIdentity = Boolean(
      request.constraints.some((item) => item.attribute === "produceType")
      || request.text.match(PRODUCE_ITEM_PATTERN),
    );
    addPhrase(selectedState?.searchText ?? typedState ?? (concreteIdentity ? "fresh" : undefined));
    for (const value of descriptorConstraints) {
      if (value.attribute !== "produceState" && value.attribute !== "produceType") {
        addPhrase(value.searchText);
      }
    }
    addPhrase(identity);
  } else {
    for (const value of descriptorConstraints) addPhrase(value.searchText);
    addPhrase(walmartSearchIdentity(request));
  }
  for (const value of packageConstraints) addPhrase(value.searchText);
  return phrases.join(" ");
}

function productMatchesConstraint(
  product: Pick<WalmartProduct, "title" | "brand" | "productType" | "size">,
  candidate: string,
  value: ProductConstraint,
) {
  if (value.attribute === "packCount" && /^\d+$/.test(value.value)) {
    const requestedPackCount = Number(value.value);
    if (product.size?.packCount === requestedPackCount) return true;
  }
  if (value.attribute === "count" && /^\d+$/.test(value.value) && product.size?.kind === "count") {
    const requestedCount = Number(value.value);
    if ((product.size.packCount ?? product.size.baseAmount) === requestedCount) return true;
  }
  if (value.attribute === "flavor" && value.value === "original") {
    const explicitOriginal = /\b(?:original(?:\s+taste)?|classic)\b/i.test(candidate);
    const nonOriginalVariety = /\b(?:zero(?:\s+sugar)?|diet|cherry|vanilla|cream soda|caffeine[ -]?free)\b/i.test(candidate);
    return explicitOriginal || !nonOriginalVariety;
  }
  return constraintMatchesText(candidate, value);
}

export function productConstraintIssues(
  product: Pick<WalmartProduct, "title" | "brand" | "productType" | "size">,
  constraints: ProductConstraint[],
) {
  const candidate = `${product.brand ?? ""} ${product.productType ?? ""} ${product.title} ${product.size?.label ?? ""}`;
  return constraints
    .filter((item) => (
      !productMatchesConstraint(product, candidate, item)
      || productTitleConflictsWithProteinConstraint(product.title, item.attribute, item.value)
    ))
    .map((item) => `does not match ${item.label}`);
}

export function selectedFacetLabels(request: StructuredProductRequest) {
  return request.constraints
    .filter((item) => item.source === "selected")
    .map((item) => item.label)
    .filter((label, index, labels) => labels.indexOf(label) === index);
}
