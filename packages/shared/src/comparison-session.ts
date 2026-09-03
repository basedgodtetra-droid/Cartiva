import {
  AttributeOrigin,
  AvailabilityStatus,
  BasketCompleteness,
  type AvailabilityStatus as AvailabilityStatusValue,
  type BasketCompleteness as BasketCompletenessValue,
} from "./types";

export const COMPARISON_SESSION_SCHEMA_VERSION = 1 as const;
export const CART_MUTATION_RECEIPT_MAX_AGE_MS = 15 * 60_000;

export type ComparisonRetailer = "kroger";
export type ComparisonFulfillmentMode = "pickup" | "delivery";
export type ComparisonMatchConfidence = "high" | "medium" | "low";

/**
 * Package quantity is the number sent to a retailer cart. It is deliberately
 * separate from package metadata such as "12 pack" or "1 gallon".
 */
export interface RetailerPackageQuantity {
  quantity: number;
  searchText: string;
  origin: typeof AttributeOrigin.USER_EXPLICIT | typeof AttributeOrigin.INFERRED;
  packageSizeText?: string;
}

export interface ComparisonLineProvenance {
  dataSource: "kroger_public_api";
  priceSource: "kroger_location_product";
  priceScope: "exact_store" | "localized" | "estimated";
  priceReliability: "verified" | "localized_estimate" | "unreliable";
  exactStoreVerified: boolean;
  sourceLocationId: string;
  fulfillment: ComparisonFulfillmentMode[];
  checkedAt?: string;
}

export type ComparisonLineStatus = "ACCEPTED" | "UNMATCHED" | "REJECTED";

export interface ComparisonBasketLine {
  lineId: string;
  requestedItemId: string;
  requestedItem: string;
  normalizedIntent: string;
  quantity: number;
  packageSizeText?: string;
  status: ComparisonLineStatus;
  retailerProductId?: string;
  upc?: string;
  matchedProduct?: string;
  matchedPackage?: string;
  priceCents?: number;
  locationId: string;
  availabilityStatus: AvailabilityStatusValue;
  matchConfidence: ComparisonMatchConfidence;
  provenance?: ComparisonLineProvenance;
}

/**
 * Immutable receipt for the product/store decision made by one comparison.
 * Authentication credentials and bearer capabilities never belong here.
 */
export interface ComparisonSessionReceipt {
  schemaVersion: typeof COMPARISON_SESSION_SCHEMA_VERSION;
  comparisonId: string;
  retailer: ComparisonRetailer;
  retailerChain: string;
  retailerBanner: string;
  locationId: string;
  locationName: string;
  locationAddress: string;
  zipCode: string;
  fulfillmentMode: ComparisonFulfillmentMode;
  requestedItemIds: string[];
  basketLines: ComparisonBasketLine[];
  completeness: BasketCompletenessValue;
  checkedAt: string;
  createdAt: string;
}

/**
 * Canonical, timestamp-free projection of every field that can change the
 * retailer cart mutation. Both the server and mobile client hash this exact
 * payload before a persisted comparison is trusted for cart handoff.
 *
 * Shopper display text and evidence timestamps intentionally stay outside the
 * projection: the mobile notepad retains the shopper's original wording while
 * the server receives its normalized search text, and the stream completion
 * timestamp is necessarily later than the stored receipt timestamp. Product,
 * package, quantity, price, store, availability, and provenance identity are
 * all included.
 */
export function comparisonBasketCanonicalPayload(
  receipt: Pick<ComparisonSessionReceipt,
    | "comparisonId"
    | "retailer"
    | "retailerBanner"
    | "locationId"
    | "zipCode"
    | "fulfillmentMode"
    | "requestedItemIds"
    | "basketLines"
    | "completeness"
  >,
) {
  return JSON.stringify({
    comparisonId: receipt.comparisonId,
    retailer: receipt.retailer,
    retailerBanner: receipt.retailerBanner,
    locationId: receipt.locationId,
    zipCode: receipt.zipCode,
    fulfillmentMode: receipt.fulfillmentMode,
    requestedItemIds: receipt.requestedItemIds,
    completeness: receipt.completeness,
    basketLines: receipt.basketLines.map((line) => ({
      lineId: line.lineId,
      requestedItemId: line.requestedItemId,
      quantity: line.quantity,
      status: line.status,
      retailerProductId: line.retailerProductId,
      upc: line.upc,
      matchedProduct: line.matchedProduct,
      matchedPackage: line.matchedPackage,
      priceCents: line.priceCents,
      locationId: line.locationId,
      availabilityStatus: line.availabilityStatus,
      matchConfidence: line.matchConfidence,
      provenance: line.provenance ? {
        dataSource: line.provenance.dataSource,
        priceSource: line.provenance.priceSource,
        priceScope: line.provenance.priceScope,
        priceReliability: line.provenance.priceReliability,
        exactStoreVerified: line.provenance.exactStoreVerified,
        sourceLocationId: line.provenance.sourceLocationId,
        fulfillment: line.provenance.fulfillment,
      } : undefined,
    })),
  });
}

const QUANTITY_SUFFIX = /\s+(?:x|×)\s*(\d{1,2})\s*$/i;
const QUANTITY_PREFIX_X = /^(\d{1,2})\s*(?:x|×)\s+(?=\S)/i;
const LEADING_CONTAINER_QUANTITY = /^(\d{1,2})\s+(cans?|canisters?|containers?|bottles?|jars?|bags?|boxes?|cartons?|pouch(?:es)?|trays?|tubs?|rolls?|bunches?|loaves?)\s+(?:of\s+)?(.+)$/i;
const TRAILING_CONTAINER_QUANTITY = /^(.+?)[,\s]+(\d{1,2})\s+(cans?|canisters?|containers?|bottles?|jars?|bags?|boxes?|cartons?|pouch(?:es)?|trays?|tubs?|rolls?|bunches?|loaves?)$/i;
const LEADING_VOLUME_QUANTITY = /^(\d{1,2})\s+(gallons?|gal|quarts?|qt|pints?|pt)\s+(?:of\s+)?(.+)$/i;
const LEADING_EACH_QUANTITY = /^(\d{1,2})\s+(bananas?|apples?|oranges?|avocados?|onions?|tomatoes?|potatoes?|lemons?|limes?)$/i;
const TRAILING_EACH_QUANTITY = /^(bananas?|apples?|oranges?|avocados?|onions?|tomatoes?|potatoes?|lemons?|limes?)[,\s]+(\d{1,2})(?:\s+each)?$/i;
const HOUSEHOLD_ROLL_PACKAGE = /^(?:(?:paper\s+towels?|toilet\s+paper|bath\s+tissue)[,\s]+\d{1,3}\s+rolls?|\d{1,3}\s+rolls?\s+(?:of\s+)?(?:paper\s+towels?|toilet\s+paper|bath\s+tissue))$/i;
const LEADING_DOZEN_QUANTITY = /^(?:(\d{1,2}|one|two|three|four|a)\s+)?dozen\s+(.+)$/i;

function cleanLine(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function safeQuantity(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 99 ? parsed : undefined;
}

function singularContainer(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "boxes") return "box";
  if (normalized === "bunches") return "bunch";
  if (normalized === "loaves") return "loaf";
  if (normalized === "pouches") return "pouch";
  return normalized.replace(/s$/, "");
}

function singularVolume(value: string) {
  return value.toLowerCase().replace(/s$/, "");
}

function dozenMultiplier(value: string | undefined) {
  if (!value || /^(?:a|one)$/i.test(value)) return 1;
  const words: Record<string, number> = { two: 2, three: 3, four: 4 };
  return words[value.toLowerCase()] ?? safeQuantity(value);
}

/**
 * Extracts only the number of retailer packages/eaches. Package size remains
 * in searchText so strict verification can still enforce a 12-pack, gallon,
 * or other shopper requirement. A bare leading number is intentionally not
 * enough evidence: it may be product identity ("7 Up"), a variety ("7 grain
 * bread"), or a package attribute. Shoppers can use `2 x product`, `product
 * x2`, or a named unit phrase such as `2 loaves bread` to request multiples.
 */
export function parseRetailerPackageQuantity(rawInput: string): RetailerPackageQuantity {
  const input = cleanLine(rawInput);
  const hasTerminalTotal = /\s+total\s*$/i.test(input);
  const inputWithoutTerminalTotal = cleanLine(input.replace(/\s+total\s*$/i, ""));
  const suffix = input.match(QUANTITY_SUFFIX);
  const suffixQuantity = safeQuantity(suffix?.[1]);
  if (suffix && suffixQuantity) {
    return {
      quantity: suffixQuantity,
      searchText: cleanLine(input.slice(0, suffix.index)),
      origin: AttributeOrigin.USER_EXPLICIT,
    };
  }

  const prefixX = input.match(QUANTITY_PREFIX_X);
  const prefixXQuantity = safeQuantity(prefixX?.[1]);
  if (prefixX && prefixXQuantity) {
    return {
      quantity: prefixXQuantity,
      searchText: cleanLine(input.slice(prefixX[0].length)),
      origin: AttributeOrigin.USER_EXPLICIT,
    };
  }

  // For household paper, a roll count identifies the retailer's sellable
  // package. It is not a request for that many separate cart lines.
  if (HOUSEHOLD_ROLL_PACKAGE.test(input) || HOUSEHOLD_ROLL_PACKAGE.test(inputWithoutTerminalTotal)) {
    return {
      quantity: 1,
      searchText: input,
      origin: AttributeOrigin.USER_EXPLICIT,
    };
  }

  const dozen = input.match(LEADING_DOZEN_QUANTITY);
  const dozenQuantity = dozenMultiplier(dozen?.[1]);
  if (dozen && dozenQuantity) {
    return {
      quantity: dozenQuantity,
      searchText: cleanLine(`${dozen[2]} 12 count`),
      packageSizeText: "12 count",
      origin: AttributeOrigin.USER_EXPLICIT,
    };
  }

  const volume = input.match(LEADING_VOLUME_QUANTITY);
  const volumeQuantity = safeQuantity(volume?.[1]);
  if (volume && volumeQuantity) {
    const unit = singularVolume(volume[2]);
    return {
      quantity: volumeQuantity,
      searchText: cleanLine(`${volume[3]} 1 ${unit}`),
      packageSizeText: `1 ${unit}`,
      origin: AttributeOrigin.USER_EXPLICIT,
    };
  }

  if (
    hasTerminalTotal
    && (
      LEADING_CONTAINER_QUANTITY.test(inputWithoutTerminalTotal)
      || TRAILING_CONTAINER_QUANTITY.test(inputWithoutTerminalTotal)
    )
  ) {
    return {
      quantity: 1,
      searchText: input,
      origin: AttributeOrigin.USER_EXPLICIT,
    };
  }

  const container = hasTerminalTotal
    ? null
    : inputWithoutTerminalTotal.match(LEADING_CONTAINER_QUANTITY);
  const containerQuantity = safeQuantity(container?.[1]);
  if (container && containerQuantity) {
    const unit = singularContainer(container[2]);
    return {
      quantity: containerQuantity,
      searchText: cleanLine(container[3]),
      packageSizeText: `1 ${unit}`,
      origin: AttributeOrigin.USER_EXPLICIT,
    };
  }

  const trailingContainer = hasTerminalTotal
    ? null
    : inputWithoutTerminalTotal.match(TRAILING_CONTAINER_QUANTITY);
  const trailingContainerQuantity = safeQuantity(trailingContainer?.[2]);
  if (trailingContainer && trailingContainerQuantity) {
    const unit = singularContainer(trailingContainer[3]);
    return {
      quantity: trailingContainerQuantity,
      searchText: cleanLine(trailingContainer[1].replace(/[,\s]+$/, "")),
      packageSizeText: `1 ${unit}`,
      origin: AttributeOrigin.USER_EXPLICIT,
    };
  }

  const each = input.match(LEADING_EACH_QUANTITY);
  const eachQuantity = safeQuantity(each?.[1]);
  if (each && eachQuantity) {
    return {
      quantity: eachQuantity,
      searchText: cleanLine(each[2]),
      packageSizeText: "1 each",
      origin: AttributeOrigin.USER_EXPLICIT,
    };
  }

  const trailingEach = input.match(TRAILING_EACH_QUANTITY);
  const trailingEachQuantity = safeQuantity(trailingEach?.[2]);
  if (trailingEach && trailingEachQuantity) {
    return {
      quantity: trailingEachQuantity,
      searchText: cleanLine(trailingEach[1]),
      packageSizeText: "1 each",
      origin: AttributeOrigin.USER_EXPLICIT,
    };
  }

  return {
    quantity: 1,
    searchText: input,
    origin: AttributeOrigin.INFERRED,
  };
}

const KROGER_BANNERS: Record<string, string> = {
  BAKERS: "Baker's",
  CITYMARKET: "City Market",
  DILLONS: "Dillons",
  FOOD4LESS: "Food 4 Less",
  FREDMEYER: "Fred Meyer",
  FRYS: "Fry's",
  FRYSFOOD: "Fry's",
  GERBES: "Gerbes",
  HARRISTEETER: "Harris Teeter",
  JAYC: "Jay C",
  KINGSOOPERS: "King Soopers",
  KROGER: "Kroger",
  MARIANOS: "Mariano's",
  METROMARKET: "Metro Market",
  PAYLESS: "Pay Less",
  PICKNSAVE: "Pick 'n Save",
  QFC: "QFC",
  RALPHS: "Ralphs",
  SMITHS: "Smith's",
};

/** Uses official location-chain data; never guesses a banner from browser state. */
export function krogerRetailerBanner(chain: string, fallback = "Kroger") {
  const key = chain.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return KROGER_BANNERS[key] ?? (cleanLine(chain) || fallback);
}

export function availabilityForComparison(
  value: "in_stock" | "likely_available" | "out_of_stock" | "unknown",
): AvailabilityStatusValue {
  if (value === "in_stock") return AvailabilityStatus.VERIFIED_IN_STOCK;
  if (value === "likely_available") return AvailabilityStatus.LIKELY_AVAILABLE;
  if (value === "out_of_stock") return AvailabilityStatus.OUT_OF_STOCK;
  return AvailabilityStatus.UNKNOWN;
}

/**
 * The minimum matcher shape needed to decide whether a verified product may be
 * handed to a retailer cart. Keeping this decision in shared code prevents the
 * server, web client, and mobile client from silently applying different
 * inventory or package-approval rules.
 */
export interface RetailerHandoffMatchCandidate {
  status: "matched" | "review" | "no_match";
  resolution?: string;
  recommended: {
    availabilityStatus: "in_stock" | "likely_available" | "out_of_stock" | "unknown";
    cartEligible: boolean;
  } | null;
  fulfillment?: {
    approvalRequired: boolean;
    kind?: "single_package" | "multi_package" | "variable_weight";
  };
}

/**
 * A retained catalog match is not automatically a handoff-safe cart line.
 * Only verified in-stock, cart-eligible matches with an accepted package plan
 * may be transferred. Missing resolution/fulfillment data remains compatible
 * with older, otherwise verified single-package results.
 */
export function isRetailerHandoffAcceptedMatch(
  result: RetailerHandoffMatchCandidate | null | undefined,
) {
  const legacyResult = result?.resolution === undefined
    && result?.fulfillment === undefined;
  const verifiedResolution = result?.fulfillment?.approvalRequired === false
    && (
      result.resolution === "matched"
      || (
        result.resolution === "multi_package_fulfillment"
        && result.fulfillment.kind === "multi_package"
      )
    );
  return Boolean(
    result?.status === "matched"
    && (legacyResult || verifiedResolution)
    && result.recommended?.availabilityStatus === "in_stock"
    && result.recommended.cartEligible
  );
}

export function assertComparisonStoreInvariant(receipt: ComparisonSessionReceipt) {
  if (!receipt.comparisonId || !receipt.locationId || !/^\d{5}$/.test(receipt.zipCode)) {
    throw new Error("Comparison receipt is missing its immutable store identity.");
  }
  if (receipt.requestedItemIds.length !== receipt.basketLines.length) {
    throw new Error("Every requested item must have exactly one basket line.");
  }
  if (new Set(receipt.requestedItemIds).size !== receipt.requestedItemIds.length) {
    throw new Error("Requested item identifiers must be unique within a comparison.");
  }
  const lineIds = new Set<string>();
  for (const [index, line] of receipt.basketLines.entries()) {
    if (
      line.requestedItemId !== receipt.requestedItemIds[index]
      || line.lineId !== `${receipt.comparisonId}:${line.requestedItemId}`
      || lineIds.has(line.lineId)
    ) {
      throw new Error("Basket line identity must be unique and bound to its requested item.");
    }
    lineIds.add(line.lineId);
    if (line.locationId !== receipt.locationId) {
      throw new Error("A basket line belongs to a different retailer location.");
    }
    if (line.quantity < 1 || line.quantity > 99 || !Number.isInteger(line.quantity)) {
      throw new Error("Basket line quantity must be an integer from 1 to 99.");
    }
    if (line.status === "ACCEPTED") {
      if (!line.retailerProductId || !line.upc || !line.provenance) {
        throw new Error("Accepted basket lines require exact retailer identifiers and provenance.");
      }
      if (
        typeof line.priceCents !== "number"
        || !Number.isSafeInteger(line.priceCents)
        || line.priceCents <= 0
      ) {
        throw new Error("Accepted basket lines require a positive verified price.");
      }
      if (
        line.provenance.sourceLocationId !== receipt.locationId
        || !line.provenance.exactStoreVerified
        || line.provenance.priceScope !== "exact_store"
        || line.provenance.priceReliability !== "verified"
        || !line.provenance.fulfillment.includes(receipt.fulfillmentMode)
      ) {
        throw new Error("Accepted basket evidence must be verified for the comparison store.");
      }
      if (line.availabilityStatus !== AvailabilityStatus.VERIFIED_IN_STOCK) {
        throw new Error("Accepted basket lines require truthful retailer availability evidence.");
      }
    }
  }
  const accepted = receipt.basketLines.filter((line) => line.status === "ACCEPTED").length;
  const shouldBeComplete = accepted > 0 && accepted === receipt.basketLines.length;
  if ((receipt.completeness === BasketCompleteness.COMPLETE) !== shouldBeComplete) {
    throw new Error("Comparison completeness does not match its accepted basket lines.");
  }
  return receipt;
}

export type ComparisonCartMutationReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: "BASKET_INCOMPLETE" | "INVENTORY_UNVERIFIED" | "RECEIPT_STALE";
    };

/**
 * Matching and cart mutation deliberately have different evidence thresholds.
 * A pickup listing without an inventory level may complete a comparison, but
 * only fresh, retailer-confirmed in-stock lines may be written automatically.
 */
export function comparisonCartMutationReadiness(
  receipt: Pick<ComparisonSessionReceipt, "basketLines" | "checkedAt" | "completeness">,
  now = Date.now(),
): ComparisonCartMutationReadiness {
  if (
    receipt.completeness !== BasketCompleteness.COMPLETE
    || !receipt.basketLines.length
    || receipt.basketLines.some((line) => line.status !== "ACCEPTED")
  ) {
    return { ready: false, reason: "BASKET_INCOMPLETE" };
  }
  if (receipt.basketLines.some(
    (line) => line.availabilityStatus !== AvailabilityStatus.VERIFIED_IN_STOCK,
  )) {
    return { ready: false, reason: "INVENTORY_UNVERIFIED" };
  }
  const evidenceTimes = [
    receipt.checkedAt,
    ...receipt.basketLines.map((line) => line.provenance?.checkedAt),
  ].map((value) => Date.parse(value ?? ""));
  if (evidenceTimes.some((checkedAt) => (
    !Number.isFinite(checkedAt)
    || checkedAt > now + 60_000
    || now - checkedAt > CART_MUTATION_RECEIPT_MAX_AGE_MS
  ))) {
    return { ready: false, reason: "RECEIPT_STALE" };
  }
  return { ready: true };
}

/**
 * Prevents a slow persistence read from overwriting the shopper's first edit.
 * Framework-neutral so the race can be tested without rendering React Native.
 */
export function createComparisonHydrationGuard() {
  let editedWhileLoading = false;
  let finished = false;
  return {
    markEdited() {
      if (!finished) editedWhileLoading = true;
    },
    finish<T>(persisted: T) {
      finished = true;
      return editedWhileLoading ? null : persisted;
    },
    get hydrated() {
      return finished;
    },
  };
}

/** Revalidation may reuse only the exact store bound to an unchanged request. */
export function comparisonCanReuseLocation(
  receipt: ComparisonSessionReceipt,
  zipCode: string,
  requestedItemIds: readonly string[],
) {
  return receipt.zipCode === zipCode
    && receipt.locationId.length > 0
    && requestedItemIds.length === receipt.requestedItemIds.length
    && requestedItemIds.every((id, index) => id === receipt.requestedItemIds[index]);
}

/** Local match edits cannot masquerade as a newly verified retailer receipt. */
export function localCorrectionMetadata(
  receipt: Pick<ComparisonSessionReceipt, "checkedAt" | "createdAt">,
  nextComparisonId: string,
) {
  return {
    comparisonId: nextComparisonId,
    checkedAt: receipt.checkedAt,
    createdAt: receipt.createdAt,
    serverReceiptPersisted: false as const,
  };
}

export function comparisonSearchItem(
  request: { id: string; raw: string },
  preferred?: { productId?: string; title?: string } | null,
) {
  const quantity = parseRetailerPackageQuantity(request.raw);
  return {
    // Preserve the shopper's complete wording at the API boundary. The server
    // removes cart totals from retailer discovery while retaining them for the
    // package-fulfillment decision.
    text: cleanLine(request.raw),
    requestedItemId: request.id,
    quantity: quantity.quantity,
    ...(preferred?.productId ? { preferredProductId: preferred.productId } : {}),
    ...(preferred?.title ? { preferredTitle: preferred.title } : {}),
  };
}
