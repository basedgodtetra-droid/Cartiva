import type { Measurement, WalmartProduct } from "./types";
import { extractProduceIdentity } from "./product-knowledge";

const NUMBER = "(\\d+(?:\\.\\d+)?)";
const CATALOG_UNIT = "fl\\s*oz|fluid ounces?|oz|ounces?|lbs?|pounds?|liters?|litres?|milliliters?|millilitres?|gallons?|gal|quarts?|qt|ml|l";
const FRESH_HERB = /\b(?:cilantro|coriander|parsley|basil|mint|rosemary|thyme|dill|sage|chives?)\b/i;

export function extractPackOnlyCount(value: string) {
  const pack = value.match(/\b(\d+)\s*(?:pack|pk)\b/i);
  const individualSize = value.match(
    new RegExp(`\\b\\d+(?:\\.\\d+)?[\\s-]*(?:${CATALOG_UNIT})\\b`, "i"),
  );
  return pack && !individualSize ? Number(pack[1]) : undefined;
}

function round(value: number, decimals = 4) {
  return Number(value.toFixed(decimals));
}

function buildMeasurement(
  amount: number,
  unit: Measurement["unit"],
  packCount?: number,
  perPackageAmount?: number,
): Measurement {
  const kind = unit === "count" ? "count" : unit === "fl oz" ? "volume" : "weight";
  const baseUnit = unit === "count" ? "each" : unit === "fl oz" ? "fl oz" : "oz";
  const converted = unit === "lb" ? amount * 16 : amount;
  const baseAmount = round(converted * (packCount ?? 1));
  const label = packCount && packCount > 1
    ? `${packCount} × ${perPackageAmount ?? amount} ${unit}`
    : `${amount} ${unit}`;

  return {
    amount: packCount ? baseAmount : amount,
    unit,
    kind,
    baseAmount,
    baseUnit,
    packCount,
    perPackageAmount,
    label,
  };
}

function buildProduceUnitMeasurement(amount: number, unit: "each" | "bunch") {
  return {
    ...buildMeasurement(amount, "count"),
    label: `${amount} ${unit === "bunch" && amount !== 1 ? "bunches" : unit}`,
  };
}

function normalizedCatalogMeasurement(
  amount: number,
  rawUnit: string,
  beverageContext: boolean,
) {
  const value = rawUnit.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^(?:l|liter|litre)s?$/.test(value)) {
    return { amount: round(amount * 33.814), unit: "fl oz" as const, label: `${amount} L` };
  }
  if (/^(?:ml|milliliter|millilitre)s?$/.test(value)) {
    return { amount: round(amount * 0.033814), unit: "fl oz" as const, label: `${amount} mL` };
  }
  if (/^(?:gal|gallon)s?$/.test(value)) {
    return { amount: round(amount * 128), unit: "fl oz" as const, label: `${amount} gal` };
  }
  if (/^(?:qt|quart)s?$/.test(value)) {
    return { amount: round(amount * 32), unit: "fl oz" as const, label: `${amount} qt` };
  }
  const unit = normalizeUnit(rawUnit, beverageContext);
  return { amount, unit, label: `${amount} ${unit}` };
}

function buildCatalogMeasurement(
  amount: number,
  rawUnit: string,
  beverageContext: boolean,
  packCount?: number,
) {
  const normalized = normalizedCatalogMeasurement(amount, rawUnit, beverageContext);
  return {
    ...buildMeasurement(
      normalized.amount,
      normalized.unit,
      packCount,
      packCount ? normalized.amount : undefined,
    ),
    label: packCount && packCount > 1
      ? `${packCount} × ${normalized.label}`
      : normalized.label,
  };
}

export function extractMeasurement(value: string): Measurement | undefined {
  const text = value.toLowerCase().replace(/,/g, " ");
  const beverageContext = /\b(?:gatorade|sports drink|soda|cola|coke|pepsi|juice|water|beverage|bottles?)\b/i.test(text);
  const freshProduceContext = (
    Boolean(extractProduceIdentity(text))
    || /\bfresh produce\b/i.test(text)
    || (FRESH_HERB.test(text) && /\b(?:fresh|organic|whole|bunch(?:es)?|each)\b/i.test(text))
  )
    && !/\b(?:frozen|canned|pickled|dried|freeze[- ]dried|jarred)\b/i.test(text);

  const packBefore = text.match(
    new RegExp(`\\b${NUMBER}\\s*(?:pack|pk|x|×|bottles?|cans?)\\b.{0,36}?${NUMBER}\\s*(fl\\s*oz|fluid ounces?|oz|ounces?|lbs?|pounds?)\\b`, "i"),
  );
  if (packBefore) {
    const packCount = Number(packBefore[1]);
    const amount = Number(packBefore[2]);
    return buildCatalogMeasurement(amount, packBefore[3], beverageContext, packCount);
  }

  const sizeBeforePack = text.match(
    new RegExp(`\\b${NUMBER}[\\s-]*(${CATALOG_UNIT})\\b.{0,24}?${NUMBER}\\s*(?:pack|pk|count|ct)\\b`, "i"),
  );
  if (sizeBeforePack) {
    const amount = Number(sizeBeforePack[1]);
    const packCount = Number(sizeBeforePack[3]);
    return buildCatalogMeasurement(amount, sizeBeforePack[2], beverageContext, packCount);
  }

  const volume = text.match(
    new RegExp(`\\b${NUMBER}[\\s-]*(fl\\s*oz|fluid ounces?|liters?|litres?|milliliters?|millilitres?|gallons?|gal|quarts?|qt|ml|l)\\b`, "i"),
  );
  if (volume) return buildCatalogMeasurement(Number(volume[1]), volume[2], true);

  // Natural shopping shorthand such as "milk gallon" still expresses a
  // concrete package. This normalizes the unit generally; discovery code can
  // remove it from the retailer query while verification keeps the volume.
  if (/\bhalf(?:[ -]a)?\s+gallons?\b/i.test(text)) {
    return buildCatalogMeasurement(64, "fl oz", true);
  }
  const implicitSingleVolume = text.match(
    /\b(?:a\s+|one\s+)?(gallons?|gal|quarts?|qt|liters?|litres?)\b/i,
  );
  if (implicitSingleVolume) {
    return buildCatalogMeasurement(1, implicitSingleVolume[1], true);
  }

  // A catalog title can report both a sellable count and the package's total
  // shipping weight (for example, "Eggs, 12 Count, 1.69 lb"). The count is the
  // comparable package identity; it is not 12 separate 1.69-pound packages.
  const count = text.match(
    new RegExp(`\\b${NUMBER}\\s*(?:(?:double|mega|triple|jumbo|regular|standard)\\s+)?(count|ct|each|pieces?|pods?|pacs?|rolls?|bars?|blades?|wipes?|sheets?)\\b`, "i"),
  );
  if (count) {
    return freshProduceContext && /^each$/i.test(count[2])
      ? buildProduceUnitMeasurement(Number(count[1]), "each")
      : buildMeasurement(Number(count[1]), "count");
  }

  const weight = text.match(
    new RegExp(`\\b${NUMBER}\\s*(oz|ounces?|lbs?|pounds?)\\b`, "i"),
  );
  if (weight) {
    return buildMeasurement(Number(weight[1]), normalizeUnit(weight[2], beverageContext));
  }

  const canCount = text.match(new RegExp(`\\b${NUMBER}\\s*cans?\\b`, "i"));
  if (canCount) return buildMeasurement(Number(canCount[1]), "count");

  const packOnly = text.match(new RegExp(`\\b${NUMBER}\\s*(?:pack|pk)\\b`, "i"));
  if (packOnly) return buildMeasurement(Number(packOnly[1]), "count");

  if (/\b(?:one|a) dozen\b/i.test(text)) return buildMeasurement(12, "count");

  // Fresh produce often has no net weight because Walmart sells it as one
  // piece or one bunch. Preserve those retailer package units as count-based
  // measurements without relaxing weight/volume rules for other products.
  if (freshProduceContext) {
    const bunchCount = text.match(new RegExp(`\\b${NUMBER}\\s*bunch(?:es)?\\b`, "i"));
    if (bunchCount) return buildProduceUnitMeasurement(Number(bunchCount[1]), "bunch");
    if (/\bbunch(?:es)?\b/i.test(text)) return buildProduceUnitMeasurement(1, "bunch");
    if (/\beach\b/i.test(text)) return buildProduceUnitMeasurement(1, "each");
  }

  return undefined;
}

function normalizeUnit(value: string, beverageContext = false): Measurement["unit"] {
  if (/^fl|fluid/.test(value)) return "fl oz";
  if (/^lb|pound/.test(value)) return "lb";
  if (beverageContext) return "fl oz";
  return "oz";
}

export function calculateUnitPrice(
  price: number,
  measurement?: Measurement,
): { value: number; label: string } | undefined {
  if (!measurement || !Number.isFinite(price) || price < 0 || measurement.baseAmount <= 0) {
    return undefined;
  }

  let value = price / measurement.baseAmount;
  let suffix: string = measurement.baseUnit;

  if (measurement.kind === "count") {
    suffix = "each";
  } else if (measurement.unit === "lb" && !measurement.packCount) {
    value = price / measurement.amount;
    suffix = "lb";
  }

  return { value: round(value), label: `$${value.toFixed(2)}/${suffix}` };
}

export function calculateComparablePrice(
  product: WalmartProduct,
  requested?: Measurement,
) {
  if (!requested || !product.size || requested.kind !== product.size.kind) {
    return product.price;
  }

  const packagesNeeded = Math.max(
    1,
    Math.ceil((requested.baseAmount - 0.0001) / product.size.baseAmount),
  );
  return round(product.price * packagesNeeded, 2);
}
