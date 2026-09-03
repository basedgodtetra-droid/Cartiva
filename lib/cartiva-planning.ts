const MAX_CARTIVA_INGREDIENTS = 24;

export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";
export type GoalOrigin = "user-field" | "user-prompt" | "default";
export type IngredientUnit =
  | "oz" | "lb" | "g" | "kg"
  | "cup" | "tbsp" | "tsp" | "ml"
  | "count" | "can" | "each" | "gallon"
  | "package" | "jar" | "box" | "clove" | "bunch" | "slice";

export interface GoalValue<T> {
  value: T;
  origin: GoalOrigin;
}

export interface PlannerGoalDraft {
  dailyCalories?: number;
  proteinGrams?: number;
  budgetDollars?: number;
  days?: number;
  people?: number;
  notes: string;
}

export interface PlannerGoal {
  dailyCalories?: GoalValue<number>;
  proteinGrams?: GoalValue<number>;
  budgetDollars?: GoalValue<number>;
  days: GoalValue<number>;
  people: GoalValue<number>;
  mealSlots: MealSlot[];
  preferences: string[];
  exclusions: string[];
  originalPrompt: string;
}

export interface MealIngredientNeed {
  name: string;
  amount: number;
  unit: IngredientUnit;
  optional?: boolean;
}

export interface PlannedMeal {
  id: string;
  templateId: string;
  day: number;
  slot: MealSlot;
  name: string;
  servings: number;
  estimatedCaloriesPerServing: number;
  estimatedProteinGramsPerServing: number;
  estimatedCostPerServing: number;
  ingredients: MealIngredientNeed[];
}

export interface ConsolidatedIngredient {
  id: string;
  name: string;
  amount: number;
  unit: IngredientUnit;
  sourceMealIds: string[];
  optional: boolean;
  shoppingText: string;
}

export interface MealPlan {
  schemaVersion: 1;
  id: string;
  title: string;
  goal: PlannerGoal;
  meals: PlannedMeal[];
  ingredients: ConsolidatedIngredient[];
  omittedIngredientCount: number;
  estimatedDailyCalories: number;
  estimatedDailyProteinGrams: number;
  goalWarnings?: string[];
  budgetIntent?: {
    targetDollars: number;
    estimatedTemplateCost: number;
    likelyWithinTarget: boolean;
    kind: "design-target";
  };
}

export interface RecipeImport {
  schemaVersion: 1;
  id: string;
  title: string;
  baseServings: number;
  servings: number;
  servingsConfirmed: boolean;
  ingredients: ConsolidatedIngredient[];
  omittedIngredientCount: number;
}

export type PlanMealAdjustment = "cheaper" | "higher-protein" | "lower-calorie";

export interface PlanBudgetComparison {
  targetCents: number;
  actualCents: number;
  differenceCents: number;
  status: "under" | "over" | "on-target";
  label: string;
}

interface MealTemplate {
  id: string;
  slot: MealSlot;
  name: string;
  calories: number;
  protein: number;
  cost: number;
  tags: string[];
  ingredients: MealIngredientNeed[];
}

const MEAL_TEMPLATES: MealTemplate[] = [
  {
    id: "berry-yogurt-oats", slot: "breakfast", name: "Berry yogurt overnight oats",
    calories: 410, protein: 32, cost: 2.35, tags: ["easy", "meal-prep", "high-protein", "vegetarian"],
    ingredients: [
      { name: "Greek yogurt", amount: 8, unit: "oz" },
      { name: "Rolled oats", amount: 0.5, unit: "cup" },
      { name: "Frozen mixed berries", amount: 0.5, unit: "cup" },
      { name: "Peanut butter", amount: 1, unit: "tbsp" },
    ],
  },
  {
    id: "egg-spinach-wrap", slot: "breakfast", name: "Egg and spinach breakfast wrap",
    calories: 460, protein: 33, cost: 2.15, tags: ["easy", "cheap", "high-protein", "vegetarian"],
    ingredients: [
      { name: "Eggs", amount: 3, unit: "count" },
      { name: "Whole wheat tortillas", amount: 1, unit: "count" },
      { name: "Baby spinach", amount: 1, unit: "cup" },
      { name: "Shredded cheddar cheese", amount: 1, unit: "oz" },
    ],
  },
  {
    id: "banana-peanut-oats", slot: "breakfast", name: "Banana peanut butter oats",
    calories: 440, protein: 21, cost: 1.25, tags: ["easy", "cheap", "meal-prep", "vegetarian", "dairy-free"],
    ingredients: [
      { name: "Rolled oats", amount: 0.6, unit: "cup" },
      { name: "Bananas", amount: 1, unit: "each" },
      { name: "Peanut butter", amount: 2, unit: "tbsp" },
      { name: "Oat milk", amount: 0.5, unit: "cup" },
    ],
  },
  {
    id: "turkey-egg-sandwich", slot: "breakfast", name: "Turkey egg breakfast sandwich",
    calories: 450, protein: 39, cost: 2.75, tags: ["easy", "high-protein"],
    ingredients: [
      { name: "Eggs", amount: 2, unit: "count" },
      { name: "Deli turkey", amount: 3, unit: "oz" },
      { name: "Whole wheat English muffins", amount: 1, unit: "count" },
      { name: "Sliced cheddar cheese", amount: 1, unit: "oz" },
    ],
  },
  {
    id: "egg-potato-hash", slot: "breakfast", name: "Egg and turkey potato hash",
    calories: 470, protein: 36, cost: 2.45, tags: ["easy", "cheap", "high-protein", "dairy-free", "air-fryer"],
    ingredients: [
      { name: "Eggs", amount: 2, unit: "count" },
      { name: "Ground turkey", amount: 3, unit: "oz" },
      { name: "Baby potatoes", amount: 5, unit: "oz" },
      { name: "Baby spinach", amount: 1, unit: "cup" },
    ],
  },
  {
    id: "savory-egg-oats", slot: "breakfast", name: "Savory egg and spinach oats",
    calories: 420, protein: 28, cost: 1.55, tags: ["easy", "cheap", "meal-prep", "vegetarian", "dairy-free"],
    ingredients: [
      { name: "Eggs", amount: 3, unit: "count" },
      { name: "Rolled oats", amount: 0.5, unit: "cup" },
      { name: "Baby spinach", amount: 1, unit: "cup" },
      { name: "Salsa", amount: 0.2, unit: "cup" },
    ],
  },
  {
    id: "chicken-rice-bowl", slot: "lunch", name: "Chicken rice meal-prep bowl",
    calories: 540, protein: 52, cost: 3.15, tags: ["easy", "meal-prep", "high-protein", "cheap", "chicken", "rice"],
    ingredients: [
      { name: "Chicken breast", amount: 6, unit: "oz" },
      { name: "Brown rice", amount: 0.5, unit: "cup" },
      { name: "Frozen broccoli", amount: 1, unit: "cup" },
      { name: "Olive oil", amount: 1, unit: "tsp" },
    ],
  },
  {
    id: "beef-taco-bowl", slot: "lunch", name: "Ground beef taco bowl",
    calories: 590, protein: 43, cost: 3.65, tags: ["meal-prep", "high-protein", "ground-beef", "rice"],
    ingredients: [
      { name: "Ground beef", amount: 5, unit: "oz" },
      { name: "White rice", amount: 0.5, unit: "cup" },
      { name: "Black beans", amount: 0.5, unit: "can" },
      { name: "Salsa", amount: 0.25, unit: "cup" },
    ],
  },
  {
    id: "turkey-hummus-wrap", slot: "lunch", name: "Turkey hummus crunch wrap",
    calories: 490, protein: 38, cost: 3.1, tags: ["easy", "meal-prep", "high-protein"],
    ingredients: [
      { name: "Deli turkey", amount: 5, unit: "oz" },
      { name: "Whole wheat tortillas", amount: 1, unit: "count" },
      { name: "Hummus", amount: 2, unit: "tbsp" },
      { name: "Romaine lettuce", amount: 1, unit: "cup" },
    ],
  },
  {
    id: "black-bean-burrito-bowl", slot: "lunch", name: "Black bean burrito bowl",
    calories: 510, protein: 23, cost: 1.75, tags: ["cheap", "meal-prep", "vegetarian", "rice"],
    ingredients: [
      { name: "Black beans", amount: 0.75, unit: "can" },
      { name: "Brown rice", amount: 0.5, unit: "cup" },
      { name: "Frozen corn", amount: 0.5, unit: "cup" },
      { name: "Salsa", amount: 0.25, unit: "cup" },
    ],
  },
  {
    id: "chicken-chickpea-salad", slot: "lunch", name: "Chicken chickpea power salad",
    calories: 500, protein: 48, cost: 3.35, tags: ["easy", "meal-prep", "high-protein", "chicken", "dairy-free"],
    ingredients: [
      { name: "Chicken breast", amount: 5, unit: "oz" },
      { name: "Chickpeas", amount: 0.5, unit: "can" },
      { name: "Baby spinach", amount: 2, unit: "cup" },
      { name: "Balsamic vinaigrette", amount: 1, unit: "tbsp" },
    ],
  },
  {
    id: "lentil-chickpea-salad", slot: "lunch", name: "Lentil chickpea crunch salad",
    calories: 470, protein: 24, cost: 2.05, tags: ["easy", "cheap", "meal-prep", "vegetarian", "dairy-free"],
    ingredients: [
      { name: "Canned lentils", amount: 0.5, unit: "can" },
      { name: "Chickpeas", amount: 0.5, unit: "can" },
      { name: "Romaine lettuce", amount: 2, unit: "cup" },
      { name: "Balsamic vinaigrette", amount: 1, unit: "tbsp" },
    ],
  },
  {
    id: "sheet-pan-chicken", slot: "dinner", name: "Sheet-pan chicken and vegetables",
    calories: 560, protein: 50, cost: 3.5, tags: ["easy", "high-protein", "chicken", "air-fryer"],
    ingredients: [
      { name: "Chicken breast", amount: 7, unit: "oz" },
      { name: "Baby potatoes", amount: 8, unit: "oz" },
      { name: "Frozen broccoli", amount: 1, unit: "cup" },
      { name: "Olive oil", amount: 1, unit: "tbsp" },
    ],
  },
  {
    id: "turkey-chili", slot: "dinner", name: "One-pot turkey chili",
    calories: 550, protein: 47, cost: 2.85, tags: ["easy", "cheap", "meal-prep", "high-protein"],
    ingredients: [
      { name: "Ground turkey", amount: 6, unit: "oz" },
      { name: "Kidney beans", amount: 0.5, unit: "can" },
      { name: "Diced tomatoes", amount: 0.5, unit: "can" },
      { name: "Yellow onions", amount: 0.25, unit: "each" },
    ],
  },
  {
    id: "beef-broccoli-rice", slot: "dinner", name: "Beef and broccoli rice skillet",
    calories: 610, protein: 45, cost: 4.1, tags: ["easy", "high-protein", "ground-beef", "rice"],
    ingredients: [
      { name: "Ground beef", amount: 6, unit: "oz" },
      { name: "White rice", amount: 0.5, unit: "cup" },
      { name: "Frozen broccoli", amount: 1, unit: "cup" },
      { name: "Low sodium soy sauce", amount: 1, unit: "tbsp" },
    ],
  },
  {
    id: "salsa-chicken-tacos", slot: "dinner", name: "Salsa chicken tacos",
    calories: 570, protein: 48, cost: 3.25, tags: ["easy", "cheap", "high-protein", "chicken"],
    ingredients: [
      { name: "Chicken breast", amount: 6, unit: "oz" },
      { name: "Corn tortillas", amount: 3, unit: "count" },
      { name: "Salsa", amount: 0.3, unit: "cup" },
      { name: "Shredded cheddar cheese", amount: 1, unit: "oz" },
    ],
  },
  {
    id: "chicken-pesto-pasta", slot: "dinner", name: "Chicken pesto pasta",
    calories: 640, protein: 49, cost: 4.2, tags: ["easy", "high-protein", "chicken"],
    ingredients: [
      { name: "Chicken breast", amount: 6, unit: "oz" },
      { name: "Penne pasta", amount: 3, unit: "oz" },
      { name: "Pesto", amount: 1.5, unit: "tbsp" },
      { name: "Cherry tomatoes", amount: 0.5, unit: "cup" },
    ],
  },
  {
    id: "chickpea-curry", slot: "dinner", name: "Creamy chickpea curry",
    calories: 530, protein: 22, cost: 2.05, tags: ["cheap", "meal-prep", "vegetarian", "dairy-free", "rice"],
    ingredients: [
      { name: "Chickpeas", amount: 0.75, unit: "can" },
      { name: "Light coconut milk", amount: 0.35, unit: "can" },
      { name: "White rice", amount: 0.5, unit: "cup" },
      { name: "Baby spinach", amount: 1, unit: "cup" },
    ],
  },
  {
    id: "lentil-pasta", slot: "dinner", name: "Tomato lentil pasta skillet",
    calories: 560, protein: 31, cost: 2.5, tags: ["easy", "cheap", "meal-prep", "vegetarian", "dairy-free"],
    ingredients: [
      { name: "Red lentil pasta", amount: 3.5, unit: "oz" },
      { name: "Diced tomatoes", amount: 0.5, unit: "can" },
      { name: "Baby spinach", amount: 1, unit: "cup" },
      { name: "Olive oil", amount: 1, unit: "tsp" },
    ],
  },
  {
    id: "tofu-vegetable-skillet", slot: "dinner", name: "Tofu vegetable skillet",
    calories: 520, protein: 30, cost: 2.65, tags: ["easy", "meal-prep", "vegetarian", "dairy-free"],
    ingredients: [
      { name: "Extra firm tofu", amount: 7, unit: "oz" },
      { name: "Frozen stir-fry vegetables", amount: 2, unit: "cup" },
      { name: "Baby potatoes", amount: 6, unit: "oz" },
      { name: "Low sodium soy sauce", amount: 1, unit: "tbsp" },
    ],
  },
  {
    id: "salmon-potatoes", slot: "dinner", name: "Lemon salmon with potatoes",
    calories: 600, protein: 44, cost: 5.4, tags: ["easy", "high-protein", "fish"],
    ingredients: [
      { name: "Salmon fillets", amount: 6, unit: "oz" },
      { name: "Baby potatoes", amount: 8, unit: "oz" },
      { name: "Green beans", amount: 1, unit: "cup" },
      { name: "Lemons", amount: 0.5, unit: "each" },
    ],
  },
  {
    id: "yogurt-protein-snack", slot: "snack", name: "Yogurt protein snack box",
    calories: 300, protein: 34, cost: 2.2, tags: ["easy", "meal-prep", "high-protein", "vegetarian"],
    ingredients: [
      { name: "Greek yogurt", amount: 8, unit: "oz" },
      { name: "Almonds", amount: 1, unit: "oz" },
      { name: "Bananas", amount: 1, unit: "each" },
    ],
  },
  {
    id: "cottage-cheese-snack", slot: "snack", name: "Cottage cheese fruit bowl",
    calories: 280, protein: 31, cost: 2.05, tags: ["easy", "cheap", "high-protein", "vegetarian"],
    ingredients: [
      { name: "Cottage cheese", amount: 8, unit: "oz" },
      { name: "Frozen mixed berries", amount: 0.5, unit: "cup" },
      { name: "Almonds", amount: 0.5, unit: "oz" },
    ],
  },
  {
    id: "turkey-apple-snack", slot: "snack", name: "Turkey and apple snack box",
    calories: 290, protein: 29, cost: 2.4, tags: ["easy", "meal-prep", "high-protein", "dairy-free"],
    ingredients: [
      { name: "Deli turkey", amount: 4, unit: "oz" },
      { name: "Apples", amount: 1, unit: "each" },
      { name: "Almonds", amount: 0.5, unit: "oz" },
    ],
  },
  {
    id: "apple-peanut-snack", slot: "snack", name: "Apple peanut butter oat bites",
    calories: 310, protein: 15, cost: 1.25, tags: ["easy", "cheap", "meal-prep", "vegetarian", "dairy-free"],
    ingredients: [
      { name: "Apples", amount: 1, unit: "each" },
      { name: "Peanut butter", amount: 2, unit: "tbsp" },
      { name: "Rolled oats", amount: 0.35, unit: "cup" },
    ],
  },
  {
    id: "hummus-crunch-snack", slot: "snack", name: "Hummus crunch snack box",
    calories: 300, protein: 13, cost: 1.7, tags: ["easy", "cheap", "meal-prep", "vegetarian", "dairy-free"],
    ingredients: [
      { name: "Hummus", amount: 0.25, unit: "cup" },
      { name: "Whole grain crackers", amount: 2, unit: "oz" },
      { name: "Baby carrots", amount: 1, unit: "cup" },
    ],
  },
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, twelve: 12,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cleanNumber(value: number, precision = 2) {
  return Number(value.toFixed(precision));
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function numberFromText(value: string | undefined) {
  if (!value) return undefined;
  const numeric = Number(value.replace(/,/g, ""));
  if (Number.isFinite(numeric)) return numeric;
  return NUMBER_WORDS[value.toLowerCase()];
}

function parsedValue(
  fieldValue: number | undefined,
  promptValue: number | undefined,
  fallback: number | undefined,
  minimum: number,
  maximum: number,
): GoalValue<number> | undefined {
  if (Number.isFinite(fieldValue)) {
    return { value: clamp(Math.round(fieldValue!), minimum, maximum), origin: "user-field" };
  }
  if (Number.isFinite(promptValue)) {
    return { value: clamp(Math.round(promptValue!), minimum, maximum), origin: "user-prompt" };
  }
  return fallback === undefined ? undefined : { value: fallback, origin: "default" };
}

function promptNumber(prompt: string, expression: RegExp) {
  const match = prompt.match(expression);
  return numberFromText(match?.[1]);
}

function mealSlotsFor(prompt: string, proteinGrams?: number) {
  if (/\b(?:4|four)\s+meals?(?:\s+(?:per|a))?\s+day\b/i.test(prompt)) {
    return ["breakfast", "lunch", "dinner", "snack"] as MealSlot[];
  }
  if (/\b(?:3|three)\s+meals?(?:\s+(?:per|a))?\s+day\b/i.test(prompt)) {
    return ["breakfast", "lunch", "dinner"] as MealSlot[];
  }
  const slots: MealSlot[] = [];
  if (/\bbreakfasts?\b/i.test(prompt)) slots.push("breakfast");
  if (/\blunch(?:es)?\b/i.test(prompt)) slots.push("lunch");
  if (/\bdinners?\b/i.test(prompt)) slots.push("dinner");
  if (/\bsnacks?\b/i.test(prompt)) slots.push("snack");
  if (slots.length) return slots;
  if (/\bmeal\s*prep\b/i.test(prompt)) return ["lunch", "dinner"] as MealSlot[];
  if (/\b(?:meals?|week)\b/i.test(prompt)) {
    return ["breakfast", "lunch", "dinner"] as MealSlot[];
  }
  if (proteinGrams || /\bcalories?\b/i.test(prompt)) {
    return proteinGrams && proteinGrams >= 140
      ? ["breakfast", "lunch", "dinner", "snack"] as MealSlot[]
      : ["breakfast", "lunch", "dinner"] as MealSlot[];
  }
  return ["dinner"] as MealSlot[];
}

export function normalizePlannerGoal(draft: PlannerGoalDraft): PlannerGoal {
  const prompt = draft.notes.replace(/\s+/g, " ").trim().slice(0, 500);
  const caloriePrompt = promptNumber(prompt, /\b(\d{1,2}(?:,\d{3})|\d{3,4})\s*(?:cal(?:orie)?s?|kcal)\b/i);
  const proteinPrompt = promptNumber(
    prompt,
    /\b(\d{2,3})\s*g(?:rams?)?(?:\s*\/\s*day|\s+per\s+day)?\s*(?:of\s*)?protein\b/i,
  );
  const budgetPrompt = promptNumber(prompt, /\$(\d{1,4})(?:\.\d{1,2})?|\b(?:under|budget(?:\s+of)?|for)\s+\$?(\d{1,4})\b/i);
  const budgetMatch = prompt.match(/\$(\d{1,4})(?:\.\d{1,2})?|\b(?:under|budget(?:\s+of)?)\s+\$?(\d{1,4})\b/i);
  const budgetFromPrompt = numberFromText(budgetMatch?.[1] ?? budgetMatch?.[2]) ?? budgetPrompt;
  const dayPrompt = promptNumber(prompt, /\b(\d+|one|two|three|four|five|six|seven)\s*(?:days?|dinners?|breakfasts?|lunches?)\b/i)
    ?? (/\bwork\s*week\b/i.test(prompt) ? 5 : /\bweek\b/i.test(prompt) ? 7 : undefined);
  const peopleMatch = prompt.match(/\b(?:family|household)\s+of\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b|\bfor\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:people|adults?|kids?|persons?)\b|\bmeal\s*prep\s+for\s+(one|two|three|four)\b|\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:people|adults?|persons?)\b/i);
  const peoplePrompt = numberFromText(peopleMatch?.[1] ?? peopleMatch?.[2] ?? peopleMatch?.[3] ?? peopleMatch?.[4]);
  const dailyCalories = parsedValue(draft.dailyCalories, caloriePrompt, undefined, 900, 5000);
  const proteinGrams = parsedValue(draft.proteinGrams, proteinPrompt, undefined, 20, 350);
  const budgetDollars = parsedValue(draft.budgetDollars, budgetFromPrompt, undefined, 10, 2000);
  const days = parsedValue(draft.days, dayPrompt, 5, 1, 7)!;
  const people = parsedValue(draft.people, peoplePrompt, 1, 1, 8)!;
  const avoids = (food: string) => new RegExp(`\\b(?:no|without|avoid|exclude|don'?t (?:like|want|eat))\\s+(?:any\\s+)?${food}\\b`, "i").test(prompt);
  const noChicken = avoids("chicken");
  const noBeef = avoids("(?:ground\\s+)?beef");
  const noRice = avoids("rice");
  const noFish = avoids("fish") || /fish[- ]free/i.test(prompt);
  const noPork = avoids("pork");
  const noDairy = avoids("dairy") || /dairy[- ]free/i.test(prompt);
  const preferences = [
    /\bhigh[ -]?protein\b/i.test(prompt) || (proteinGrams?.value ?? 0) >= 120 ? "high-protein" : "",
    /\bcheap|budget|affordable|save money|under\s+\$?\d+/i.test(prompt) || Boolean(budgetDollars) ? "cheap" : "",
    /\beasy|quick|simple|low effort/i.test(prompt) ? "easy" : "",
    /\bmeal\s*prep|prep for work/i.test(prompt) ? "meal-prep" : "",
    /\bair[ -]?fryer\b/i.test(prompt) ? "air-fryer" : "",
    /\bchicken\b/i.test(prompt) && !noChicken ? "chicken" : "",
    /\bground beef|beef\b/i.test(prompt) && !noBeef ? "ground-beef" : "",
    /\brice\b/i.test(prompt) && !noRice ? "rice" : "",
    /\bvegetarian|meatless|no meat\b/i.test(prompt) ? "vegetarian" : "",
  ].filter(Boolean);
  const exclusions = [
    noFish ? "fish" : "",
    noChicken ? "chicken" : "",
    noBeef ? "ground-beef" : "",
    noRice ? "rice" : "",
    noPork ? "pork" : "",
    noDairy ? "dairy" : "",
  ].filter(Boolean);

  return {
    dailyCalories,
    proteinGrams,
    budgetDollars,
    days,
    people,
    mealSlots: mealSlotsFor(`${prompt}${dailyCalories ? " calories" : ""}`, proteinGrams?.value),
    preferences: [...new Set(preferences)],
    exclusions,
    originalPrompt: prompt,
  };
}

function ingredientKey(name: string) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (/^(?:boneless\s+)?(?:skinless\s+)?chicken\s+breasts?$/.test(normalized)) {
    return "chicken-breast";
  }
  return normalized.replace(/\s+/g, "-");
}

function amountLabel(amount: number, unit: IngredientUnit) {
  const value = cleanNumber(amount, amount >= 10 ? 0 : 1);
  const plural = value === 1 ? "" : "s";
  if (unit === "each") return `${value}`;
  if (unit === "count") return `${Math.ceil(value)} count`;
  if (unit === "can") return `${cleanNumber(value, 1)} can${plural}`;
  if (unit === "cup") return `${value} cup${plural}`;
  if (unit === "package" || unit === "jar" || unit === "box" || unit === "clove" || unit === "bunch" || unit === "slice") {
    return `${value} ${unit}${plural}`;
  }
  if (unit === "tbsp" || unit === "tsp" || unit === "oz" || unit === "lb" || unit === "g" || unit === "kg" || unit === "ml") return `${value} ${unit}`;
  return `${value} gallon${plural}`;
}

/**
 * Generated recipe totals should become useful purchase targets, not false
 * package precision. The underlying ingredient amount stays untouched; only
 * the shopper-facing list target is rounded upward so fulfillment never
 * silently undersupplies the plan.
 */
export function roundGeneratedPurchaseWeightOunces(ounces: number) {
  if (!Number.isFinite(ounces) || ounces <= 0) return 1;
  if (ounces >= 16) return Math.ceil(ounces / 8) * 8;
  return Math.max(1, Math.ceil(ounces));
}

function shoppingTextFor(name: string, amount: number, unit: IngredientUnit) {
  // Cup and spoon amounts are recipe measures, not package promises. Keep the
  // amount in structured plan data, but give product search a clean identity.
  if (unit === "cup" || unit === "tbsp" || unit === "tsp") return name;
  if (unit === "lb" || unit === "oz" || unit === "g" || unit === "kg") {
    const ounces = unit === "lb"
      ? amount * 16
      : unit === "kg"
        ? amount * 35.274
        : unit === "g"
          ? amount * 0.035274
          : amount;
    const purchaseOunces = roundGeneratedPurchaseWeightOunces(ounces);
    return purchaseOunces >= 16
      ? `${name} ${cleanNumber(purchaseOunces / 16, 1)} lb`
      : `${name} ${purchaseOunces} oz`;
  }
  const discretePurchaseUnits: IngredientUnit[] = ["can", "package", "jar", "box", "clove", "bunch", "slice"];
  if (unit === "count") return `${name} ${Math.max(1, Math.ceil(amount))} count`;
  if (discretePurchaseUnits.includes(unit)) {
    const purchaseQuantity = Math.max(1, Math.ceil(amount));
    return `${name} ${purchaseQuantity} ${unit}${purchaseQuantity === 1 ? "" : "s"}`;
  }
  if (unit === "each") return `${name} ${Math.max(1, Math.ceil(amount))}`;
  if (unit === "gallon") return `${name} ${cleanNumber(amount, 1)} gallon${amount === 1 ? "" : "s"}`;
  return `${name} ${amountLabel(amount, unit)}`.trim();
}

function reviewedShoppingTextFor(name: string, amount: number, unit: IngredientUnit) {
  if (unit === "cup" || unit === "tbsp" || unit === "tsp") return name;
  const discretePurchaseUnits: IngredientUnit[] = ["count", "can", "package", "jar", "box", "clove", "bunch", "slice", "each"];
  return discretePurchaseUnits.includes(unit)
    ? shoppingTextFor(name, amount, unit)
    : `${name} ${amountLabel(amount, unit)}`.trim();
}

function compatibleAmount(existing: ConsolidatedIngredient, need: MealIngredientNeed, servings: number) {
  const amount = need.amount * servings;
  const weightUnits: IngredientUnit[] = ["oz", "lb", "g", "kg"];
  if (weightUnits.includes(existing.unit) && weightUnits.includes(need.unit)) {
    const toOunces = (value: number, unit: IngredientUnit) => unit === "lb"
      ? value * 16
      : unit === "kg"
        ? value * 35.274
        : unit === "g"
          ? value * 0.035274
          : value;
    const currentOunces = toOunces(existing.amount, existing.unit);
    const nextOunces = toOunces(amount, need.unit);
    return { amount: currentOunces + nextOunces, unit: "oz" as const };
  }
  const volumeUnits: IngredientUnit[] = ["cup", "tbsp", "tsp", "ml"];
  if (volumeUnits.includes(existing.unit) && volumeUnits.includes(need.unit)) {
    const toTeaspoons = (value: number, unit: IngredientUnit) => unit === "cup"
      ? value * 48
      : unit === "tbsp"
        ? value * 3
        : unit === "ml"
          ? value / 4.92892
          : value;
    const totalTeaspoons = toTeaspoons(existing.amount, existing.unit) + toTeaspoons(amount, need.unit);
    if (totalTeaspoons >= 24) return { amount: totalTeaspoons / 48, unit: "cup" as const };
    if (totalTeaspoons >= 3) return { amount: totalTeaspoons / 3, unit: "tbsp" as const };
    return { amount: totalTeaspoons, unit: "tsp" as const };
  }
  if ((existing.unit === "count" || existing.unit === "each") && (need.unit === "count" || need.unit === "each")) {
    return { amount: existing.amount + amount, unit: existing.unit };
  }
  if (existing.unit === need.unit) return { amount: existing.amount + amount, unit: existing.unit };
  return undefined;
}

export function consolidatePlanIngredients(meals: PlannedMeal[]) {
  const combined = new Map<string, ConsolidatedIngredient>();
  for (const meal of meals) {
    for (const need of meal.ingredients) {
      const key = ingredientKey(need.name);
      const existing = combined.get(key);
      if (!existing) {
        const amount = need.amount * meal.servings;
        combined.set(key, {
          id: `ingredient-${key}`,
          name: need.name,
          amount,
          unit: need.unit,
          sourceMealIds: [meal.id],
          optional: Boolean(need.optional),
          shoppingText: shoppingTextFor(need.name, amount, need.unit),
        });
        continue;
      }
      const compatible = compatibleAmount(existing, need, meal.servings);
      if (compatible) {
        existing.amount = compatible.amount;
        existing.unit = compatible.unit;
        existing.shoppingText = shoppingTextFor(existing.name, existing.amount, existing.unit);
      } else {
        const unitKey = `${key}-${need.unit}`;
        const sameUnit = combined.get(unitKey);
        if (sameUnit) {
          sameUnit.amount += need.amount * meal.servings;
          sameUnit.shoppingText = shoppingTextFor(sameUnit.name, sameUnit.amount, sameUnit.unit);
          if (!sameUnit.sourceMealIds.includes(meal.id)) sameUnit.sourceMealIds.push(meal.id);
        } else {
          const amount = need.amount * meal.servings;
          combined.set(unitKey, {
            id: `ingredient-${unitKey}`,
            name: need.name,
            amount,
            unit: need.unit,
            sourceMealIds: [meal.id],
            optional: Boolean(need.optional),
            shoppingText: shoppingTextFor(need.name, amount, need.unit),
          });
        }
        continue;
      }
      if (!existing.sourceMealIds.includes(meal.id)) existing.sourceMealIds.push(meal.id);
      existing.optional = existing.optional && Boolean(need.optional);
    }
  }
  const ingredients = [...combined.values()].sort((left, right) => (
    Number(left.optional) - Number(right.optional) || left.name.localeCompare(right.name)
  ));
  return {
    ingredients,
    omittedIngredientCount: 0,
  };
}

function templateAllowed(template: MealTemplate, goal: PlannerGoal) {
  const ingredientText = template.ingredients.map((ingredient) => ingredient.name).join(" ").toLowerCase();
  if (goal.exclusions.includes("fish") && (template.tags.includes("fish") || /salmon|tuna|fish|shrimp/.test(ingredientText))) return false;
  if (goal.exclusions.includes("chicken") && (template.tags.includes("chicken") || /chicken/.test(ingredientText))) return false;
  if (goal.exclusions.includes("ground-beef") && (template.tags.includes("ground-beef") || /\bbeef\b/.test(ingredientText))) return false;
  if (goal.exclusions.includes("rice") && (template.tags.includes("rice") || /\brice\b/.test(ingredientText))) return false;
  if (goal.exclusions.includes("pork") && /pork|bacon|ham|sausage/.test(ingredientText)) return false;
  if (goal.exclusions.includes("dairy") && !template.tags.includes("dairy-free") && /milk|yogurt|cheese|cottage|cream|pesto/.test(ingredientText)) return false;
  if (goal.preferences.includes("vegetarian") && !template.tags.includes("vegetarian")) return false;
  return true;
}

function candidateTemplates(slot: MealSlot, goal: PlannerGoal) {
  const dailyBudgetPerPerson = goal.budgetDollars
    ? goal.budgetDollars.value / goal.days.value / goal.people.value
    : undefined;
  return MEAL_TEMPLATES
    .filter((template) => template.slot === slot && templateAllowed(template, goal))
    .map((template) => {
      let score = 0;
      for (const preference of goal.preferences) {
        if (template.tags.includes(preference)) score += preference === "high-protein" ? 4 : 2;
      }
      if (
        template.tags.includes("chicken")
        && /\b(?:mostly|more|prefer)\s+chicken\b/i.test(goal.originalPrompt)
      ) score += 5;
      if (
        template.tags.includes("ground-beef")
        && /\bbeef\s+is\s+(?:okay|ok|fine)\b/i.test(goal.originalPrompt)
      ) score -= 1;
      if (dailyBudgetPerPerson !== undefined && template.cost <= dailyBudgetPerPerson / goal.mealSlots.length) score += 4;
      if (goal.proteinGrams && template.protein >= goal.proteinGrams.value / goal.mealSlots.length) score += 3;
      if (goal.proteinGrams && goal.dailyCalories) {
        const targetProteinDensity = goal.proteinGrams.value / goal.dailyCalories.value;
        const templateProteinDensity = template.protein / template.calories;
        if (templateProteinDensity >= targetProteinDensity * 0.94) score += 4;
      }
      return { template, score };
    })
    .sort((left, right) => right.score - left.score || left.template.cost - right.template.cost || left.template.id.localeCompare(right.template.id))
    .map(({ template }) => template);
}

function mealFromTemplate(template: MealTemplate, day: number, servings: number, stableSlotId?: string): PlannedMeal {
  return {
    id: stableSlotId ?? `meal-${day}-${template.slot}-${stableHash(`${day}-${template.slot}`)}`,
    templateId: template.id,
    day,
    slot: template.slot,
    name: template.name,
    servings,
    estimatedCaloriesPerServing: template.calories,
    estimatedProteinGramsPerServing: template.protein,
    estimatedCostPerServing: template.cost,
    ingredients: template.ingredients.map((ingredient) => ({ ...ingredient })),
  };
}

function applyGoalPortions(meals: PlannedMeal[], goal: PlannerGoal) {
  const targetCalories = goal.dailyCalories?.value;
  const targetProtein = goal.proteinGrams?.value;
  if (!targetCalories && !targetProtein) return meals;
  const byDay = new Map<number, PlannedMeal[]>();
  for (const meal of meals) byDay.set(meal.day, [...(byDay.get(meal.day) ?? []), meal]);
  return meals.map((meal) => {
    const dayMeals = byDay.get(meal.day) ?? [meal];
    const dayCalories = dayMeals.reduce((total, item) => total + item.estimatedCaloriesPerServing, 0);
    const dayProtein = dayMeals.reduce((total, item) => total + item.estimatedProteinGramsPerServing, 0);
    const calorieFactor = targetCalories ? targetCalories / Math.max(1, dayCalories) : 1;
    const proteinFactor = !targetCalories && targetProtein ? targetProtein / Math.max(1, dayProtein) : 1;
    const portionFactor = clamp(targetCalories ? calorieFactor : proteinFactor, 0.5, 2.5);
    return {
      ...meal,
      estimatedCaloriesPerServing: Math.round(meal.estimatedCaloriesPerServing * portionFactor),
      estimatedProteinGramsPerServing: Math.round(meal.estimatedProteinGramsPerServing * portionFactor),
      estimatedCostPerServing: cleanNumber(meal.estimatedCostPerServing * portionFactor, 2),
      ingredients: meal.ingredients.map((ingredient) => ({
        ...ingredient,
        amount: cleanNumber(ingredient.amount * portionFactor, 3),
      })),
    };
  });
}

function planEstimates(meals: PlannedMeal[], days: number) {
  const calories = meals.reduce((total, meal) => total + meal.estimatedCaloriesPerServing, 0);
  const protein = meals.reduce((total, meal) => total + meal.estimatedProteinGramsPerServing, 0);
  return {
    estimatedDailyCalories: Math.round(calories / Math.max(1, days)),
    estimatedDailyProteinGrams: Math.round(protein / Math.max(1, days)),
  };
}

function goalWarningsFor(goal: PlannerGoal, estimates: ReturnType<typeof planEstimates>) {
  const warnings: string[] = [];
  if (
    goal.proteinGrams
    && estimates.estimatedDailyProteinGrams < goal.proteinGrams.value
  ) {
    warnings.push(
      `This draft estimates ${estimates.estimatedDailyProteinGrams}g protein per day, below the ${goal.proteinGrams.value}g goal. Adjust meals before shopping.`,
    );
  }
  if (
    goal.dailyCalories
    && Math.abs(estimates.estimatedDailyCalories - goal.dailyCalories.value) > goal.dailyCalories.value * 0.1
  ) {
    warnings.push(
      `This draft estimates ${estimates.estimatedDailyCalories.toLocaleString()} calories per day, outside the ${goal.dailyCalories.value.toLocaleString()}-calorie target range.`,
    );
  }
  return warnings;
}

function budgetIntentFor(meals: PlannedMeal[], goal: PlannerGoal) {
  if (!goal.budgetDollars) return undefined;
  const estimatedTemplateCost = cleanNumber(
    meals.reduce((total, meal) => total + meal.estimatedCostPerServing * meal.servings, 0),
    2,
  );
  return {
    targetDollars: goal.budgetDollars.value,
    estimatedTemplateCost,
    likelyWithinTarget: estimatedTemplateCost <= goal.budgetDollars.value,
    kind: "design-target" as const,
  };
}

function planTitle(goal: PlannerGoal) {
  if (goal.originalPrompt) {
    const cleaned = goal.originalPrompt.replace(/[.!?]+$/, "");
    return cleaned.length <= 58 ? titleCase(cleaned) : `${titleCase(cleaned.slice(0, 55).trim())}…`;
  }
  if (goal.proteinGrams) return `${goal.days.value}-day protein plan`;
  return `${goal.days.value}-day meal plan`;
}

export function generateMealPlan(draft: PlannerGoalDraft): MealPlan {
  const goal = normalizePlannerGoal(draft);
  const seed = Number.parseInt(stableHash(JSON.stringify(goal)), 36) || 0;
  const meals: PlannedMeal[] = [];
  for (let day = 1; day <= goal.days.value; day += 1) {
    goal.mealSlots.forEach((slot, slotIndex) => {
      const candidates = candidateTemplates(slot, goal);
      const rotationSize = goal.mealSlots.length >= 3 && (slot === "breakfast" || slot === "snack")
        ? 1
        : Math.min(candidates.length, goal.mealSlots.length >= 3 ? 2 : 3);
      const template = candidates[(seed + day + slotIndex) % Math.max(1, rotationSize)]
        ?? MEAL_TEMPLATES.find((item) => item.slot === slot && templateAllowed(item, goal))
        ?? MEAL_TEMPLATES.find((item) => item.slot === slot)!;
      meals.push(mealFromTemplate(template, day, goal.people.value));
    });
  }
  const portionedMeals = applyGoalPortions(meals, goal);
  const consolidated = consolidatePlanIngredients(portionedMeals);
  const estimates = planEstimates(portionedMeals, goal.days.value);
  const goalWarnings = goalWarningsFor(goal, estimates);
  return {
    schemaVersion: 1,
    id: `plan-${stableHash(JSON.stringify(goal))}`,
    title: planTitle(goal),
    goal,
    meals: portionedMeals,
    ...consolidated,
    ...estimates,
    ...(goalWarnings.length ? { goalWarnings } : {}),
    ...(budgetIntentFor(portionedMeals, goal) ? { budgetIntent: budgetIntentFor(portionedMeals, goal) } : {}),
  };
}

/** Regenerates the contents of an existing planning session without changing its lineage. */
export function regenerateMealPlan(previous: MealPlan, draft: PlannerGoalDraft): MealPlan {
  return { ...generateMealPlan(draft), id: previous.id };
}

function rebuildPlan(plan: MealPlan, meals: PlannedMeal[]): MealPlan {
  const consolidated = consolidatePlanIngredients(meals);
  const estimates = planEstimates(meals, plan.goal.days.value);
  const goalWarnings = goalWarningsFor(plan.goal, estimates);
  return {
    ...plan,
    meals,
    ...consolidated,
    ...estimates,
    ...(goalWarnings.length ? { goalWarnings } : { goalWarnings: undefined }),
    ...(plan.goal.budgetDollars ? { budgetIntent: budgetIntentFor(meals, plan.goal) } : {}),
  };
}

export function removePlanMeal(plan: MealPlan, mealId: string) {
  return rebuildPlan(plan, plan.meals.filter((meal) => meal.id !== mealId));
}

export function updatePlanMealServings(plan: MealPlan, mealId: string, servings: number) {
  return rebuildPlan(plan, plan.meals.map((meal) => meal.id === mealId
    ? { ...meal, servings: clamp(Math.round(servings), 1, 12) }
    : meal));
}

export function replacePlanMeal(plan: MealPlan, mealId: string, step = 1) {
  const current = plan.meals.find((meal) => meal.id === mealId);
  if (!current) return plan;
  const candidates = candidateTemplates(current.slot, plan.goal);
  const currentIndex = Math.max(0, candidates.findIndex((template) => template.id === current.templateId));
  const next = candidates[(currentIndex + Math.max(1, step)) % candidates.length];
  if (!next) return plan;
  const currentTemplate = MEAL_TEMPLATES.find((template) => template.id === current.templateId);
  const portionFactor = currentTemplate
    ? current.estimatedCaloriesPerServing / currentTemplate.calories
    : 1;
  const baseReplacement = mealFromTemplate(next, current.day, current.servings, current.id);
  const replacement = {
    ...baseReplacement,
    estimatedCaloriesPerServing: Math.round(baseReplacement.estimatedCaloriesPerServing * portionFactor),
    estimatedProteinGramsPerServing: Math.round(baseReplacement.estimatedProteinGramsPerServing * portionFactor),
    estimatedCostPerServing: cleanNumber(baseReplacement.estimatedCostPerServing * portionFactor, 2),
    ingredients: baseReplacement.ingredients.map((ingredient) => ({
      ...ingredient,
      amount: cleanNumber(ingredient.amount * portionFactor, 3),
    })),
  };
  return rebuildPlan(plan, plan.meals.map((meal) => meal.id === mealId ? replacement : meal));
}

/**
 * Adjust one meal while preserving every unrelated meal. These are planning
 * comparisons only; retailer-priced savings remain a later Cartiva step.
 */
export function adjustPlanMeal(
  plan: MealPlan,
  mealId: string,
  adjustment: PlanMealAdjustment,
) {
  const current = plan.meals.find((meal) => meal.id === mealId);
  if (!current) return plan;
  const currentTemplate = MEAL_TEMPLATES.find((template) => template.id === current.templateId);
  const portionFactor = currentTemplate
    ? current.estimatedCaloriesPerServing / currentTemplate.calories
    : 1;
  const protectsProtein = Boolean(plan.goal.proteinGrams) || plan.goal.preferences.includes("high-protein");
  const proteinFloor = protectsProtein && adjustment !== "higher-protein"
    ? current.estimatedProteinGramsPerServing * 0.85
    : 0;
  let candidates = candidateTemplates(current.slot, plan.goal)
    .filter((template) => {
      if (template.id === current.templateId) return false;
      if (template.protein * portionFactor < proteinFloor) return false;
      if (adjustment === "cheaper") return template.cost * portionFactor < current.estimatedCostPerServing;
      if (adjustment === "higher-protein") return template.protein * portionFactor > current.estimatedProteinGramsPerServing;
      return template.calories * portionFactor < current.estimatedCaloriesPerServing;
    });
  const stronglyPreferredTag = currentTemplate?.tags.includes("chicken")
    && /\b(?:mostly|more|prefer)\s+chicken\b/i.test(plan.goal.originalPrompt)
    ? "chicken"
    : undefined;
  const preferencePreserving = stronglyPreferredTag
    ? candidates.filter((template) => template.tags.includes(stronglyPreferredTag))
    : [];
  if (preferencePreserving.length) candidates = preferencePreserving;
  candidates.sort((left, right) => {
      if (adjustment === "cheaper") {
        return left.cost - right.cost
          || right.protein - left.protein
          || left.calories - right.calories;
      }
      if (adjustment === "higher-protein") {
        return right.protein - left.protein
          || left.calories - right.calories
          || left.cost - right.cost;
      }
      return left.calories - right.calories
        || right.protein - left.protein
        || left.cost - right.cost;
    });
  const next = candidates[0];
  if (!next) return plan;
  const baseReplacement = mealFromTemplate(next, current.day, current.servings, current.id);
  const replacement: PlannedMeal = {
    ...baseReplacement,
    estimatedCaloriesPerServing: Math.round(baseReplacement.estimatedCaloriesPerServing * portionFactor),
    estimatedProteinGramsPerServing: Math.round(baseReplacement.estimatedProteinGramsPerServing * portionFactor),
    estimatedCostPerServing: cleanNumber(baseReplacement.estimatedCostPerServing * portionFactor, 2),
    ingredients: baseReplacement.ingredients.map((ingredient) => ({
      ...ingredient,
      amount: cleanNumber(ingredient.amount * portionFactor, 3),
    })),
  };
  return rebuildPlan(plan, plan.meals.map((meal) => meal.id === mealId ? replacement : meal));
}

export function formatIngredientAmount(
  ingredient: Pick<ConsolidatedIngredient, "amount" | "unit"> & Partial<Pick<ConsolidatedIngredient, "name" | "shoppingText">>,
) {
  if (ingredient.name && ingredient.shoppingText) {
    const prefix = `${ingredient.name} `;
    if (ingredient.shoppingText.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) {
      return ingredient.shoppingText.slice(prefix.length);
    }
  }
  return amountLabel(ingredient.amount, ingredient.unit);
}

export function updateConsolidatedIngredientAmount(
  ingredients: ConsolidatedIngredient[],
  ingredientId: string,
  amount: number,
) {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) return ingredients;
  const safeAmount = cleanNumber(amount, 3);
  return ingredients.map((ingredient) => ingredient.id === ingredientId
    ? {
        ...ingredient,
        amount: safeAmount,
        shoppingText: reviewedShoppingTextFor(ingredient.name, safeAmount, ingredient.unit),
      }
    : ingredient);
}

export function isPantryIngredient(ingredient: Pick<ConsolidatedIngredient, "name">) {
  const name = ingredient.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return /^(?:(?:kosher|sea|table) salt|salt|(?:ground |black |white )?pepper|(?:extra virgin )?olive oil|vegetable oil|canola oil|avocado oil|cooking spray|garlic powder|onion powder|paprika|(?:italian|taco|chili|poultry) seasoning|soy sauce|(?:white|apple cider|red wine|balsamic) vinegar|vinegar)$/.test(name);
}

export function comparePlanBudget(
  targetDollars: number | undefined,
  actualSubtotalCents: number,
): PlanBudgetComparison | undefined {
  if (!Number.isFinite(targetDollars) || (targetDollars ?? 0) <= 0) return undefined;
  if (!Number.isSafeInteger(actualSubtotalCents) || actualSubtotalCents < 0) return undefined;
  const targetCents = Math.round((targetDollars as number) * 100);
  const differenceCents = actualSubtotalCents - targetCents;
  const status = differenceCents > 0 ? "over" : differenceCents < 0 ? "under" : "on-target";
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(Math.abs(differenceCents) / 100);
  return {
    targetCents,
    actualCents: actualSubtotalCents,
    differenceCents,
    status,
    label: status === "on-target" ? "On budget" : `${amount} ${status} budget`,
  };
}

export function planIngredientsAsText(ingredients: ConsolidatedIngredient[]) {
  return ingredients.map((ingredient) => ingredient.shoppingText).join("\n");
}

function unicodeFractions(value: string) {
  return value
    .replace(/(\d)\s*½/g, "$1 1/2").replace(/½/g, "1/2")
    .replace(/(\d)\s*¼/g, "$1 1/4").replace(/¼/g, "1/4")
    .replace(/(\d)\s*¾/g, "$1 3/4").replace(/¾/g, "3/4")
    .replace(/(\d)\s*⅓/g, "$1 1/3").replace(/⅓/g, "1/3")
    .replace(/(\d)\s*⅔/g, "$1 2/3").replace(/⅔/g, "2/3");
}

function parseAmount(value: string | undefined) {
  if (!value) return 1;
  if (NUMBER_WORDS[value.toLowerCase()]) return NUMBER_WORDS[value.toLowerCase()];
  if (/^\d+\s+\d+\/\d+$/.test(value)) {
    const [whole, fraction] = value.split(/\s+/);
    const [numerator, denominator] = fraction.split("/").map(Number);
    return Number(whole) + numerator / denominator;
  }
  if (/^\d+\/\d+$/.test(value)) {
    const [numerator, denominator] = value.split("/").map(Number);
    return numerator / denominator;
  }
  if (/^\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?$/.test(value)) {
    const [minimum, maximum] = value.split(/[-–—]/).map(Number);
    return (minimum + maximum) / 2;
  }
  return Number(value) || 1;
}

const UNIT_ALIASES: Record<string, IngredientUnit> = {
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  g: "g", gram: "g", grams: "g",
  kg: "kg", kilogram: "kg", kilograms: "kg",
  cup: "cup", cups: "cup", c: "cup",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  count: "count", ct: "count",
  can: "can", cans: "can",
  gallon: "gallon", gallons: "gallon", gal: "gallon",
  ml: "ml", milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  piece: "each", pieces: "each", item: "each", items: "each",
  package: "package", packages: "package", pkg: "package",
  jar: "jar", jars: "jar", box: "box", boxes: "box",
  clove: "clove", cloves: "clove", bunch: "bunch", bunches: "bunch",
  slice: "slice", slices: "slice",
};

const DIRECTION_START = /^(?:preheat|bake|cook|stir|mix|combine|heat|serve|simmer|whisk|add|place|pour|bring|reduce|cover|fold|blend|roast|grill|let)\b/i;

function parseRecipeIngredient(line: string, insideIngredientSection: boolean): MealIngredientNeed | undefined {
  const cleaned = unicodeFractions(line)
    .replace(/^\s*(?:[-*•▪◦]\s*|\d+[.)]\s+)/, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 180 || /^https?:\/\//i.test(cleaned)) return undefined;
  if (/^(?:directions?|instructions?|method|steps?|notes?|nutrition)\b/i.test(cleaned)) return undefined;
  if (/\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer|user)\s+(?:instructions?|prompts?|messages?)\b/i.test(cleaned)) return undefined;
  if (DIRECTION_START.test(cleaned)) return undefined;
  if (/^[^\d]+:\s*$/.test(cleaned)) return undefined;
  const match = cleaned.match(/^(?:(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+|\s*-\s*))?(?:(cups?|c|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|lbs?|pounds?|g|grams?|kg|kilograms?|ml|millilit(?:er|re)s?|count|ct|cans?|gallons?|gal|pieces?|items?|packages?|pkg|jars?|boxes?|cloves?|bunch(?:es)?|slices?)\s+(?:of\s+)?)?(.*)$/i);
  if (!match) return undefined;
  let amount = parseAmount(match[1]);
  let unit = match[2] ? UNIT_ALIASES[match[2].toLowerCase()] : undefined;
  let name = match[3].trim();
  const parenthetical = name.match(/^\((\d+(?:\.\d+)?)\s*[- ]?(oz|ounces?|g|grams?|ml|millilit(?:er|re)s?)\)\s*(cans?|packages?|pkg|jars?|boxes?)?\s*(.*)$/i);
  if (parenthetical) {
    const container = parenthetical[3]?.toLowerCase();
    if (container) unit = UNIT_ALIASES[container] ?? unit;
    else if (!unit) {
      amount *= Number(parenthetical[1]);
      unit = UNIT_ALIASES[parenthetical[2].toLowerCase()] ?? "oz";
    }
    name = parenthetical[4].trim();
  }
  if (!unit) unit = "each";
  name = name
    .replace(/^an?\s+/i, "")
    .replace(/,.*$/, "")
    .replace(/^(?:diced|chopped|minced|sliced|crushed|drained|rinsed)\s+/i, "")
    .replace(/\s+(?:divided|diced|chopped|minced|sliced|drained|rinsed|softened|melted|to taste)\s*$/i, "")
    .replace(/[.;:]+$/, "")
    .trim();
  if (!name || name.length < 2) return undefined;
  const hasAmount = Boolean(match[1] || match[2] || parenthetical);
  if (!insideIngredientSection && !hasAmount) return undefined;
  return { name: titleCase(name), amount: cleanNumber(amount, 2), unit };
}

function consolidateRecipeNeeds(needs: MealIngredientNeed[], servings: number) {
  const meal: PlannedMeal = {
    id: "recipe-meal",
    templateId: "recipe",
    day: 1,
    slot: "dinner",
    name: "Imported recipe",
    servings,
    estimatedCaloriesPerServing: 0,
    estimatedProteinGramsPerServing: 0,
    estimatedCostPerServing: 0,
    ingredients: needs,
  };
  const consolidated = consolidatePlanIngredients([meal]);
  return {
    ...consolidated,
    ingredients: consolidated.ingredients.map((ingredient) => ({
      ...ingredient,
      shoppingText: reviewedShoppingTextFor(ingredient.name, ingredient.amount, ingredient.unit),
    })),
  };
}

export function parseRecipeText(rawText: string): RecipeImport {
  const text = rawText.replace(/\r/g, "").slice(0, 20_000);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const servingMatch = text.match(/\b(?:serves?|servings?|yield)\s*[:\-]?\s*(\d{1,2})\b|\b(\d{1,2})\s+servings?\b/i);
  const baseServings = clamp(Number(servingMatch?.[1] ?? servingMatch?.[2]) || 4, 1, 24);
  const ingredientHeadingIndex = lines.findIndex((line) => /^ingredients?\s*:??$/i.test(line));
  const directionIndex = lines.findIndex((line, index) => index > ingredientHeadingIndex && /^(?:directions?|instructions?|method|steps?|preparation|procedure)\s*:??$/i.test(line));
  const titleSearch = ingredientHeadingIndex >= 0 ? lines.slice(0, ingredientHeadingIndex) : lines.slice(0, 3);
  const titleCandidate = titleSearch.find((line) => (
    !/^(?:ingredients?|serves?|servings?|yield)\b/i.test(line)
    && line.length <= 80
    && !parseRecipeIngredient(line, false)
  ));
  const needs: MealIngredientNeed[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (ingredientHeadingIndex >= 0 && index <= ingredientHeadingIndex) continue;
    if (directionIndex >= 0 && index >= directionIndex) break;
    const insideIngredientSection = ingredientHeadingIndex >= 0 && (directionIndex < 0 || index < directionIndex);
    if (insideIngredientSection && DIRECTION_START.test(line)) break;
    const parsed = parseRecipeIngredient(line, insideIngredientSection);
    if (parsed) needs.push(parsed);
  }
  const consolidated = consolidateRecipeNeeds(needs, 1);
  return {
    schemaVersion: 1,
    id: `recipe-${stableHash(text)}`,
    title: titleCandidate ? titleCase(titleCandidate.replace(/[.:]+$/, "")) : "Imported recipe",
    baseServings,
    servings: baseServings,
    servingsConfirmed: Boolean(servingMatch),
    ...consolidated,
  };
}

export function scaleRecipeImport(recipe: RecipeImport, servings: number): RecipeImport {
  const nextServings = clamp(Math.round(servings), 1, 24);
  const factor = nextServings / recipe.servings;
  return {
    ...recipe,
    servings: nextServings,
    ingredients: recipe.ingredients.map((ingredient) => {
      const amount = ingredient.amount * factor;
      return {
        ...ingredient,
        amount,
        shoppingText: reviewedShoppingTextFor(ingredient.name, amount, ingredient.unit),
      };
    }),
  };
}

export function confirmRecipeServings(recipe: RecipeImport) {
  return { ...recipe, servingsConfirmed: true };
}

export function updateConsolidatedIngredient(
  ingredients: ConsolidatedIngredient[],
  ingredientId: string,
  name: string,
) {
  const safeName = name.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!safeName) return ingredients;
  const renamed = ingredients.map((ingredient) => ingredient.id === ingredientId
    ? {
        ...ingredient,
        name: safeName,
        shoppingText: reviewedShoppingTextFor(safeName, ingredient.amount, ingredient.unit),
      }
    : ingredient);
  const combined = new Map<string, ConsolidatedIngredient>();
  for (const ingredient of renamed) {
    const key = ingredientKey(ingredient.name);
    const existing = combined.get(key);
    if (!existing) {
      combined.set(key, ingredient);
      continue;
    }
    const compatible = compatibleAmount(existing, {
      name: ingredient.name,
      amount: ingredient.amount,
      unit: ingredient.unit,
      optional: ingredient.optional,
    }, 1);
    if (!compatible) {
      combined.set(`${key}-${ingredient.unit}`, ingredient);
      continue;
    }
    existing.amount = compatible.amount;
    existing.unit = compatible.unit;
    existing.shoppingText = shoppingTextFor(existing.name, existing.amount, existing.unit);
    existing.sourceMealIds = [...new Set([...existing.sourceMealIds, ...ingredient.sourceMealIds])];
    existing.optional = existing.optional && ingredient.optional;
  }
  return [...combined.values()];
}

/**
 * Applies the amount while the edited row still has its original identity.
 * Renaming can merge that row into an existing ingredient, so applying the
 * amount second would target an id that no longer exists and silently lose
 * the shopper's quantity change.
 */
export function updateConsolidatedIngredientDetails(
  ingredients: ConsolidatedIngredient[],
  ingredientId: string,
  name: string,
  amount: number,
) {
  return updateConsolidatedIngredient(
    updateConsolidatedIngredientAmount(ingredients, ingredientId, amount),
    ingredientId,
    name,
  );
}

export function preserveReviewedPlanIngredients(previous: MealPlan, next: MealPlan) {
  const generatedBefore = consolidatePlanIngredients(previous.meals).ingredients;
  const reviewedById = new Map(previous.ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const removedIds = new Set(
    generatedBefore
      .filter((ingredient) => !reviewedById.has(ingredient.id))
      .map((ingredient) => ingredient.id),
  );
  let ingredients = next.ingredients.filter((ingredient) => !removedIds.has(ingredient.id));
  for (const generated of generatedBefore) {
    const reviewed = reviewedById.get(generated.id);
    if (!reviewed) continue;
    if (reviewed.name !== generated.name) {
      ingredients = updateConsolidatedIngredient(ingredients, generated.id, reviewed.name);
    }
    if (reviewed.amount !== generated.amount || reviewed.unit !== generated.unit) {
      ingredients = ingredients.map((ingredient) => ingredient.id === generated.id
        ? {
            ...ingredient,
            amount: reviewed.amount,
            unit: reviewed.unit,
            shoppingText: reviewedShoppingTextFor(ingredient.name, reviewed.amount, reviewed.unit),
          }
        : ingredient);
    }
  }
  return { ...next, ingredients };
}

export const plannerExamplePrompts = [
  { label: "High-protein week under $80", draft: { notes: "High-protein week under $80", days: 7, budgetDollars: 80 } },
  { label: "5 cheap dinners", draft: { notes: "5 cheap, easy dinners", days: 5 } },
  { label: "Meal prep for one", draft: { notes: "Easy meal prep for one person", days: 5, people: 1 } },
  { label: "Family meals under $120", draft: { notes: "Family dinners under $120", days: 5, people: 4, budgetDollars: 120 } },
  { label: "1,800 calories · 160g protein", draft: { notes: "Easy high-protein meals", dailyCalories: 1800, proteinGrams: 160, days: 5 } },
  { label: "Easy air-fryer meals", draft: { notes: "Easy air-fryer breakfast, lunch, and dinner", days: 5 } },
  { label: "Cheap meals with chicken and ground beef", draft: { notes: "Cheap meals with chicken and ground beef", days: 5 } },
] satisfies Array<{ label: string; draft: Partial<PlannerGoalDraft> & { notes: string } }>;

export { MAX_CARTIVA_INGREDIENTS };
