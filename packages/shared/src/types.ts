/** The source of a requirement or fact carried by Cartiva's product intent. */
export const AttributeOrigin = {
  USER_EXPLICIT: "USER_EXPLICIT",
  USER_SELECTED: "USER_SELECTED",
  INFERRED: "INFERRED",
  RETAILER_METADATA: "RETAILER_METADATA",
} as const;

export type AttributeOrigin =
  (typeof AttributeOrigin)[keyof typeof AttributeOrigin];

/** Retailer-neutral availability; missing evidence always normalizes to UNKNOWN. */
export const AvailabilityStatus = {
  VERIFIED_IN_STOCK: "VERIFIED_IN_STOCK",
  LIKELY_AVAILABLE: "LIKELY_AVAILABLE",
  UNKNOWN: "UNKNOWN",
  OUT_OF_STOCK: "OUT_OF_STOCK",
} as const;

export type AvailabilityStatus =
  (typeof AvailabilityStatus)[keyof typeof AvailabilityStatus];

/** Only COMPLETE baskets are eligible to compete on total price. */
export const BasketCompleteness = {
  COMPLETE: "COMPLETE",
  INCOMPLETE: "INCOMPLETE",
} as const;

export type BasketCompleteness =
  (typeof BasketCompleteness)[keyof typeof BasketCompleteness];

/** The strongest truthful retailer handoff available for a comparison. */
export const HandoffCapability = {
  CART_TRANSFER_SUPPORTED: "CART_TRANSFER_SUPPORTED",
  DEEPLINK_SUPPORTED: "DEEPLINK_SUPPORTED",
  SHOPPING_PAGE_ONLY: "SHOPPING_PAGE_ONLY",
} as const;

export type HandoffCapability =
  (typeof HandoffCapability)[keyof typeof HandoffCapability];

export type ProductAttributeValue = string | number | boolean;

export interface OriginatedValue<T> {
  value: T;
  origin: AttributeOrigin;
}

export interface ProductIntentAttribute<
  TValue extends ProductAttributeValue = ProductAttributeValue,
> extends OriginatedValue<TValue> {
  key: string;
  label?: string;
}

export type ProductQuantityUnit =
  | "each"
  | "bunch"
  | "bag"
  | "box"
  | "carton"
  | "bottle"
  | "can"
  | "jar"
  | "roll"
  | "pack"
  | "load";

export interface ProductQuantity extends OriginatedValue<number> {
  unit: ProductQuantityUnit;
}

export type ProductWeightUnit = "oz" | "lb" | "g" | "kg";
export type ProductVolumeUnit =
  | "fl oz"
  | "cup"
  | "pint"
  | "quart"
  | "gallon"
  | "mL"
  | "L";

export interface ProductMeasurement<TUnit extends string>
  extends OriginatedValue<number> {
  unit: TUnit;
}

/**
 * Retailer-neutral shopper intent. Retailer titles, package metadata, prices,
 * inventory, and product identifiers belong on retailer candidate contracts,
 * never on this request model.
 */
export interface ProductIntent {
  rawInput: string;
  normalizedName: string;
  category: string;
  brand?: OriginatedValue<string>;
  variant?: OriginatedValue<string>;
  quantity?: ProductQuantity;
  packageCount?: OriginatedValue<number>;
  weight?: ProductMeasurement<ProductWeightUnit>;
  volume?: ProductMeasurement<ProductVolumeUnit>;
  containerType?: OriginatedValue<string>;
  dietaryAttributes: ProductIntentAttribute<string>[];
  explicitAttributes: ProductIntentAttribute[];
  selectedAttributes: ProductIntentAttribute[];
  inferredAttributes: ProductIntentAttribute[];
}
