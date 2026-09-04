const FOODS: Record<string, string> = {
  dairy: "dairy", milk: "dairy", cheese: "dairy", yogurt: "dairy", lactose: "dairy",
  egg: "eggs", eggs: "eggs", peanut: "peanuts", peanuts: "peanuts",
  nut: "tree-nuts", nuts: "tree-nuts", "tree nuts": "tree-nuts",
  almonds: "tree-nuts", cashews: "tree-nuts", walnuts: "tree-nuts",
  fish: "fish", seafood: "fish", shellfish: "shellfish", shrimp: "shellfish",
  chicken: "chicken", beef: "ground-beef", "ground beef": "ground-beef", pork: "pork",
  meat: "meat", rice: "rice", gluten: "gluten", wheat: "gluten", soy: "soy", sesame: "sesame",
};
const knownFood = Object.keys(FOODS).sort((a, b) => b.length - a.length).join("|");

export function plannerDietaryRestrictions(prompt: string) {
  const exclusions = new Set<string>();
  const vegan = /\bvegan\b/i.test(prompt);
  const vegetarian = vegan || /\b(?:vegetarian|meatless|no meat)\b/i.test(prompt);
  if (vegetarian) exclusions.add("meat");
  if (vegan) { exclusions.add("dairy"); exclusions.add("eggs"); exclusions.add("honey"); }
  const list = `(?:${knownFood})(?:(?:\\s*(?:,\\s*(?:and|or)?|and|or|&)\\s*)(?:${knownFood}))*`;
  const negative = new RegExp(`\\b(?:no|without|avoid|exclude|don'?t (?:like|want|eat)|hate|dislike|allergic to|allergy to|allergies?:)\\s+(?:any\\s+)?(${list})\\b`, "gi");
  for (const match of prompt.matchAll(negative)) {
    for (const food of match[1].toLowerCase().split(/\s*(?:,|\band\b|\bor\b|&)\s*/)) exclusions.add(FOODS[food]);
  }
  for (const match of prompt.matchAll(new RegExp(`\\b(${list})(?:[- ]free|\\s+allerg(?:y|ies))\\b`, "gi"))) {
    for (const food of match[1].toLowerCase().split(/\s*(?:,|\band\b|\bor\b|&)\s*/).filter(Boolean)) exclusions.add(FOODS[food]);
  }
  // Unrecognized allergy declarations must not be advertised as a compatible plan.
  for (const match of prompt.matchAll(/\ballerg(?:ic\s+to|y\s+to)\s+([^.;]+)/gi)) {
    const clause = match[1].split(/\b(?:for|with|under|at)\b|\d/)[0].trim().replace(/[,\s]+$/, "");
    const unknown = clause.toLowerCase().split(/\s*(?:,|\band\b|\bor\b|&)\s*/).filter(Boolean).filter((food) => !FOODS[food]);
    if (unknown.length) throw new Error(`Cartiva can't yet check the allergy “${unknown.join(", ")}”. Edit the goal or use your own reviewed grocery list.`);
  }
  for (const match of prompt.matchAll(/\b([a-z]+)\s+allerg(?:y|ies)\b/gi)) {
    if (!FOODS[match[1].toLowerCase()]) throw new Error(`Cartiva can't yet check the allergy “${match[1]}”. Use your own reviewed grocery list.`);
  }
  return { exclusions: [...exclusions].filter(Boolean), vegetarian, vegan };
}

/** Shared by templates and nutrition boosters; tags cannot override ingredients. */
export function plannerIngredientAllowed(name: string, exclusions: string[]) {
  const value = name.toLowerCase();
  const patterns: Record<string, RegExp> = {
    meat: /\b(?:chicken|beef|turkey|pork|bacon|ham|sausage|salmon|tuna|fish|shrimp|prawn|crab|lobster|gelatin)\b/,
    fish: /\b(?:salmon|tuna|fish|shrimp|seafood|cod|tilapia)\b/,
    shellfish: /\b(?:shrimp|prawn|crab|lobster|shellfish)\b/,
    chicken: /\bchicken\b/, "ground-beef": /\bbeef\b/, pork: /\b(?:pork|bacon|ham|sausage)\b/,
    dairy: /\b(?:milk|yogurt|cheese|cheddar|cottage|cream|pesto|whey|butter)\b/,
    eggs: /\beggs?\b/, peanuts: /\bpeanuts?\b/,
    "tree-nuts": /\b(?:almonds?|cashews?|walnuts?|pecans?|pistachios?|hazelnuts?|pesto)\b/,
    gluten: /\b(?:wheat|bread|tortillas?|muffins?|pasta|couscous|barley|rye|soy sauce|oats)\b/,
    soy: /\b(?:soy|tofu|edamame|tempeh|textured vegetable protein)\b/, sesame: /\b(?:sesame|tahini|hummus)\b/,
    rice: /\brice\b/, honey: /\bhoney\b/,
  };
  return exclusions.every((restriction) => {
    if (restriction === "dairy") return !patterns.dairy.test(value.replace(/\b(?:(?:almond|oat|coconut|soy) milk|peanut butter)\b/g, ""));
    if (restriction === "gluten" && /\bgluten[- ]free\b/.test(value)) return true;
    return !patterns[restriction]?.test(value);
  });
}
