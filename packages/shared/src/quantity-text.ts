const FRACTIONS: Record<string, string> = {
  "¼": "1/4", "½": "1/2", "¾": "3/4", "⅐": "1/7", "⅑": "1/9", "⅒": "1/10",
  "⅓": "1/3", "⅔": "2/3", "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5",
  "⅙": "1/6", "⅚": "5/6", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};
const UNIT = "(?:fl\\s*oz|fluid ounces?|oz|ounces?|lbs?|pounds?|kilograms?|kgs?|kg|grams?|g|liters?|litres?|milliliters?|millilitres?|gallons?|gal|quarts?|qt|pints?|pt|ml|l|cups?|tbsp|tablespoons?|tsp|teaspoons?)";
const UNIT_AHEAD = `(?=\\s*${UNIT}\\b)`;

/** Normalize amounts before segmentation; ratios without physical units stay intact. */
export function normalizeMeasurementFractions(value: string) {
  let normalized = value
    .replace(/(\d+)\s*([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (_m, whole: string, fraction: string) => `${whole} ${FRACTIONS[fraction]}`)
    .replace(/[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (fraction) => FRACTIONS[fraction])
    .replace(/⁄/g, "/")
    .normalize("NFKC")
    .replace(new RegExp(`(?<![\\d/])(\\d+),(\\d+)${UNIT_AHEAD}`, "gi"), (match, whole: string, decimal: string, offset: number, source: string) => /\/\s*$/.test(source.slice(0, offset)) ? match : `${whole}.${decimal}`)
    .replace(new RegExp(`(^|[^\\d])\\.(\\d+)${UNIT_AHEAD}`, "gi"), (_match, prefix: string, amount: string) => `${prefix}0.${amount}`);
  normalized = normalized.replace(
    new RegExp(`\\b(\\d+)(?:\\s+|\\s*-\\s*)(\\d+)\\s*\\/\\s*(\\d+)${UNIT_AHEAD}`, "gi"),
    (match, whole: string, numerator: string, denominator: string) => Number(denominator)
      ? String(Number(whole) + Number(numerator) / Number(denominator)) : match,
  );
  return normalized.replace(
    new RegExp(`\\b(\\d+)\\s*\\/\\s*(\\d+)${UNIT_AHEAD}`, "gi"),
    (match, numerator: string, denominator: string) => Number(denominator)
      ? String(Number(numerator) / Number(denominator)) : match,
  );
}

/** Invalid explicit amounts require an edit; they must never become a default of one. */
export function invalidGroceryQuantity(raw: string): string | undefined {
  const value = normalizeMeasurementFractions(raw).replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "");
  if (/\b\d+\s*\/\s*0\b/.test(value) || /(?:^|\s|,)\s*-\s*\d/.test(value)) {
    return "Use a positive amount, such as 0.5 lb or 2 packages.";
  }
  const physicalAmounts = [...value.matchAll(new RegExp(`(?:^|[\\s,])([0-9]+(?:\\.[0-9]+)?)\\s*${UNIT}\\b`, "gi"))];
  if (physicalAmounts.some((match) => !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0)) {
    return "Enter an amount greater than zero.";
  }
  const multiplier = value.match(/(?:^|\s)(?:x|×)\s*(-?\d+(?:\.\d+)?)\s*$/i)
    ?? value.match(/^\s*(\d+(?:\.\d+)?)\s*[x×]\s*/i);
  if (multiplier && (!Number.isInteger(Number(multiplier[1])) || Number(multiplier[1]) < 1 || Number(multiplier[1]) > 99)) {
    return "Choose between 1 and 99 packages.";
  }
  const explicitCount = value.match(/^(\d+(?:\.\d+)?)\s+(?:(?:cans?|bottles?|bags?|boxes?|cartons?|jars?|loaves?)\s+)?(?=[a-z])/i)
    ?? value.match(/\b(\d+(?:\.\d+)?)\s+each\b/i);
  if (explicitCount && !new RegExp(`^\\d+(?:\\.\\d+)?\\s*${UNIT}\\b`, "i").test(value)
    && (!Number.isInteger(Number(explicitCount[1])) || Number(explicitCount[1]) > 99)) {
    return "Choose a whole quantity between 1 and 99, or specify a weight.";
  }
  if (/^0(?:\.0+)?\s+(?!%)/.test(value) || /,\s*0(?:\.0+)?\s*$/.test(value)
    || /\b(?:bananas?|apples?|oranges?|avocados?|onions?|tomatoes?|potatoes?|lemons?|limes?|yogurts?)\s+0\s*$/i.test(value)
    || /\b0\s*(?:count|ct|pack|pk|cans?|bottles?|rolls?|each)\b/i.test(value)) {
    return "Enter a quantity greater than zero, or remove this item.";
  }
  return undefined;
}
