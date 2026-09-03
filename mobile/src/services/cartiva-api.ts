import {
  comparisonBasketCanonicalPayload,
  type ComparisonSessionReceipt,
} from "@cartiva/shared";
import * as Crypto from "expo-crypto";
import { mobileSessionFetch } from "./mobile-session";
import { isTrustedKrogerRetailerUrl } from "./cart-submission-marker";

export type HandoffMode =
  | "CART_TRANSFER_SUPPORTED"
  | "DEEPLINK_SUPPORTED"
  | "SHOPPING_PAGE_ONLY";

export type AvailabilityStatus =
  | "in_stock"
  | "likely_available"
  | "out_of_stock"
  | "unknown";

export interface CartivaCapabilities {
  apiVersion: "v1";
  access: "ANONYMOUS_READ_ONLY" | "ANONYMOUS_WITH_TEMPORARY_SESSION";
  retailers: {
    id: "kroger";
    label: "Kroger";
    status: "ACTIVE";
    read: { locations: boolean; productSearch: boolean };
    handoff: {
      mode: HandoffMode;
      cartTransferSupported: boolean;
      requiresRetailerCheckout: true;
      requiresCustomerAuthorization?: boolean;
      cartApiLocationBound?: boolean;
      requiresStoreConfirmation?: boolean;
      reason?: string;
    };
  }[];
}

export interface KrogerLocation {
  locationId: string;
  name: string;
  chain: string;
  address: {
    addressLine1: string;
    city: string;
    state: string;
    zipCode: string;
  };
  phone?: string;
  departments?: string[];
  handoff: {
    mode: "SHOPPING_PAGE_ONLY";
    url: string;
    storeSelectionRequired: true;
  };
}

export interface KrogerLocationsResponse {
  retailer: "kroger";
  zipCode: string;
  locations: KrogerLocation[];
}

export interface ProductMeasurement {
  amount: number;
  unit: "oz" | "lb" | "fl oz" | "count";
  kind: "weight" | "volume" | "count";
  baseAmount: number;
  baseUnit: "oz" | "fl oz" | "each";
  packCount?: number;
  perPackageAmount?: number;
  label: string;
}

export interface RankedKrogerProduct {
  retailer: "kroger";
  id: string;
  productId: string;
  upc: string;
  title: string;
  brand?: string;
  productType?: string;
  price: number;
  priceCents?: number;
  link: string;
  linkType?: "product" | "search";
  thumbnail?: string;
  size?: ProductMeasurement;
  checkedAt?: string;
  inStock: boolean;
  availabilityStatus: AvailabilityStatus;
  cartEligible: boolean;
  dataSource: "kroger_public_api";
  confidence: "high" | "medium" | "low";
  score: number;
  reasons: string[];
  priceProvenance: {
    regularPriceCents?: number;
    promoPriceCents?: number;
    locationId: string;
    locationName?: string;
    chain?: string;
    checkedAt?: string;
    priceScope: "exact_store" | "localized" | "estimated";
    priceReliability: "verified" | "localized_estimate" | "unreliable";
    exactStoreVerified: boolean;
    fulfillment: ("pickup" | "delivery" | "shipping")[];
  };
}

export type RetailMatchResolution =
  | "matched"
  | "matched_check_availability"
  | "multi_package_fulfillment"
  | "substitute_available"
  | "needs_choice"
  | "truly_unavailable";

export interface RetailPackageFulfillment {
  kind: "single_package" | "multi_package" | "variable_weight";
  cartQuantity: number;
  packageCount: number;
  requestedBaseAmount?: number;
  suppliedBaseAmount?: number;
  baseUnit?: "oz" | "fl oz" | "each";
  overageBaseAmount?: number;
  overagePercent?: number;
  label: string;
  approvalRequired: boolean;
  recoveredFromStrictNoMatch?: boolean;
}

export interface KrogerMatchResult {
  retailer: "kroger";
  requestedItem: string;
  recommended: RankedKrogerProduct | null;
  alternatives: RankedKrogerProduct[];
  assumptions?: string[];
  confidence: "high" | "medium" | "low";
  status: "matched" | "review" | "no_match";
  resolution?: RetailMatchResolution;
  fulfillment?: RetailPackageFulfillment;
  explanation: string;
  clarification?: string;
  verifiedAt?: string;
  error?: string;
}

export interface KrogerSearchItemEvent {
  type: "item";
  retailer: "kroger";
  phase: "search" | "verification";
  index: number;
  mode: "live";
  checkedAt: string;
  cartAutomation: {
    enabled: true;
    requiresCustomerConnection: true;
  } | {
    enabled: false;
    reason: string;
  };
  result: KrogerMatchResult;
  diagnostics: {
    searchResultCount: number;
    selectedProductId?: string;
    verificationStatus: "verified" | "needs_review" | "no_verified_match";
    locationId: string;
    rejectionReason?: string;
  };
}

export interface KrogerSearchPerformanceEvent {
  type: "performance";
  retailer: "kroger";
  mode: "live";
  checkedAt: string;
  comparisonReceipt?: {
    comparisonId: string;
    locationId: string;
    retailerBanner: string;
    completeness: "COMPLETE" | "INCOMPLETE";
    basketDigest: string;
    persisted: true;
  };
  performance: {
    totalDurationMs: number;
    cacheHits: number;
    searchApiCalls: number;
    productApiCalls: number;
    deduplicatedRequests: number;
    upstreamCacheUsed: "yes" | "no" | "unknown" | "local cache only";
    outcomeCounts?: {
      requestedItems: number;
      matchedAutomatically: number;
      multiPackageFulfilled: number;
      shopperChoiceRequired: number;
      trulyUnavailable: number;
    };
    items: {
      index: number;
      item: string;
      searchDurationMs: number;
      verificationDurationMs: number;
      totalDurationMs: number;
    }[];
  };
}

export type KrogerSearchEvent = KrogerSearchItemEvent | KrogerSearchPerformanceEvent;

export interface KrogerSearchRequest {
  comparisonId: string;
  items: {
    text: string;
    requestedItemId: string;
    quantity: number;
    preferredProductId?: string;
    preferredTitle?: string;
  }[];
  locationId: string;
  zipCode: string;
  fulfillmentMode: "pickup" | "delivery";
}

export type KrogerComparisonReceiptConfirmation = NonNullable<
  KrogerSearchPerformanceEvent["comparisonReceipt"]
>;

export class CartivaApiError extends Error {
  constructor(
    message: string,
    readonly code: "configuration" | "network" | "response" | "timeout",
    readonly status?: number,
  ) {
    super(message);
    this.name = "CartivaApiError";
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function exactKeys(value: UnknownRecord, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function validShoppingHandoffUrl(value: unknown): value is string {
  if (!isTrustedKrogerRetailerUrl(value)) return false;
  try {
    const url = new URL(value);
    return url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function decodeCartivaCapabilities(value: unknown): CartivaCapabilities {
  const root = record(value);
  const invalid = () => new CartivaApiError(
    "Cartiva returned invalid retailer capabilities.",
    "response",
  );
  if (
    !root
    || !exactKeys(root, ["apiVersion", "access", "retailers"])
    || root.apiVersion !== "v1"
    || !["ANONYMOUS_READ_ONLY", "ANONYMOUS_WITH_TEMPORARY_SESSION"].includes(String(root.access))
    || !Array.isArray(root.retailers)
    || root.retailers.length !== 1
  ) throw invalid();

  const retailer = record(root.retailers[0]);
  const read = record(retailer?.read);
  const handoff = record(retailer?.handoff);
  if (
    !retailer
    || !exactKeys(retailer, ["id", "label", "status", "read", "handoff"])
    || retailer.id !== "kroger"
    || retailer.label !== "Kroger"
    || retailer.status !== "ACTIVE"
    || !read
    || !exactKeys(read, ["locations", "productSearch"])
    || read.locations !== true
    || read.productSearch !== true
    || !handoff
    || !exactKeys(
      handoff,
      ["mode", "cartTransferSupported", "requiresRetailerCheckout"],
      [
        "requiresCustomerAuthorization",
        "cartApiLocationBound",
        "requiresStoreConfirmation",
        "reason",
      ],
    )
    || !["CART_TRANSFER_SUPPORTED", "DEEPLINK_SUPPORTED", "SHOPPING_PAGE_ONLY"].includes(String(handoff.mode))
    || typeof handoff.cartTransferSupported !== "boolean"
    || handoff.requiresRetailerCheckout !== true
    || (handoff.reason !== undefined && !boundedText(handoff.reason, 500))
    || (
      handoff.requiresCustomerAuthorization !== undefined
      && typeof handoff.requiresCustomerAuthorization !== "boolean"
    )
    || (handoff.cartApiLocationBound !== undefined && typeof handoff.cartApiLocationBound !== "boolean")
    || (
      handoff.requiresStoreConfirmation !== undefined
      && typeof handoff.requiresStoreConfirmation !== "boolean"
    )
  ) throw invalid();

  const transfer = handoff.mode === "CART_TRANSFER_SUPPORTED";
  if (
    handoff.cartTransferSupported !== transfer
    || (transfer && root.access !== "ANONYMOUS_WITH_TEMPORARY_SESSION")
    || (!transfer && root.access !== "ANONYMOUS_READ_ONLY")
    || (transfer && handoff.requiresCustomerAuthorization !== true)
    || (transfer && handoff.cartApiLocationBound !== false)
    || (transfer && handoff.requiresStoreConfirmation !== true)
  ) throw invalid();

  return value as CartivaCapabilities;
}

function decodeKrogerLocation(value: unknown): KrogerLocation | null {
  const location = record(value);
  const address = record(location?.address);
  const handoff = record(location?.handoff);
  if (
    !location
    || !exactKeys(location, ["locationId", "name", "chain", "address", "handoff"], ["phone", "departments"])
    || !boundedText(location.locationId, 64)
    || !/^[A-Za-z0-9_-]+$/.test(location.locationId)
    || !boundedText(location.name, 160)
    || !boundedText(location.chain, 80)
    || !address
    || !exactKeys(address, ["addressLine1", "city", "state", "zipCode"])
    || !boundedText(address.addressLine1, 200)
    || !boundedText(address.city, 100)
    || typeof address.state !== "string"
    || !/^[A-Z]{2}$/.test(address.state)
    || typeof address.zipCode !== "string"
    || !/^\d{5}$/.test(address.zipCode)
    || (location.phone !== undefined && !boundedText(location.phone, 40))
    || (
      location.departments !== undefined
      && (
        !Array.isArray(location.departments)
        || location.departments.length > 100
        || location.departments.some((department) => !boundedText(department, 100))
      )
    )
    || !handoff
    || !exactKeys(handoff, ["mode", "url", "storeSelectionRequired"])
    || handoff.mode !== "SHOPPING_PAGE_ONLY"
    || !validShoppingHandoffUrl(handoff.url)
    || handoff.storeSelectionRequired !== true
  ) return null;
  return value as KrogerLocation;
}

export function decodeKrogerLocationsResponse(
  value: unknown,
  requestedZipCode: string,
): KrogerLocationsResponse {
  const root = record(value);
  if (
    !root
    || !exactKeys(root, ["retailer", "zipCode", "locations"])
    || root.retailer !== "kroger"
    || root.zipCode !== requestedZipCode
    || !Array.isArray(root.locations)
    || root.locations.length > 10
  ) {
    throw new CartivaApiError("Cartiva returned invalid Kroger locations.", "response");
  }
  const locations = root.locations.map(decodeKrogerLocation);
  if (locations.some((location) => !location)) {
    throw new CartivaApiError("Cartiva returned invalid Kroger locations.", "response");
  }
  const locationIds = locations.map((location) => location!.locationId);
  if (new Set(locationIds).size !== locationIds.length) {
    throw new CartivaApiError("Cartiva returned duplicate Kroger locations.", "response");
  }
  return {
    retailer: "kroger",
    zipCode: requestedZipCode,
    locations: locations as KrogerLocation[],
  };
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function boundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumText: number,
): value is string[] {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every((entry) => boundedText(entry, maximumText));
}

function safeHttpsUrl(value: unknown, trustedRetailer = false): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  if (trustedRetailer && !isTrustedKrogerRetailerUrl(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port;
  } catch {
    return false;
  }
}

function decodeMeasurement(value: unknown): ProductMeasurement | null {
  const measurement = record(value);
  if (
    !measurement
    || !exactKeys(
      measurement,
      ["amount", "unit", "kind", "baseAmount", "baseUnit", "label"],
      ["packCount", "perPackageAmount"],
    )
    || !finiteNumber(measurement.amount, 0.001, 100_000)
    || !["oz", "lb", "fl oz", "count"].includes(String(measurement.unit))
    || !["weight", "volume", "count"].includes(String(measurement.kind))
    || !finiteNumber(measurement.baseAmount, 0.001, 100_000)
    || !["oz", "fl oz", "each"].includes(String(measurement.baseUnit))
    || !boundedText(measurement.label, 100)
    || (measurement.packCount !== undefined && !safeInteger(measurement.packCount, 1, 999))
    || (
      measurement.perPackageAmount !== undefined
      && !finiteNumber(measurement.perPackageAmount, 0.001, 100_000)
    )
  ) return null;
  return value as ProductMeasurement;
}

export function decodeRetailPackageFulfillment(value: unknown): RetailPackageFulfillment | null {
  const fulfillment = record(value);
  if (
    !fulfillment
    || !exactKeys(
      fulfillment,
      ["kind", "cartQuantity", "packageCount", "label", "approvalRequired"],
      [
        "requestedBaseAmount", "suppliedBaseAmount", "baseUnit", "overageBaseAmount",
        "overagePercent", "recoveredFromStrictNoMatch",
      ],
    )
    || !["single_package", "multi_package", "variable_weight"].includes(String(fulfillment.kind))
    || !safeInteger(fulfillment.cartQuantity, 1, 99)
    || !safeInteger(fulfillment.packageCount, 1, 99)
    || fulfillment.cartQuantity !== fulfillment.packageCount
    || (
      fulfillment.kind === "multi_package"
        ? fulfillment.packageCount < 2
        : fulfillment.packageCount !== 1
    )
    || (
      fulfillment.requestedBaseAmount !== undefined
      && !finiteNumber(fulfillment.requestedBaseAmount, 0.001, 10_000_000)
    )
    || (
      fulfillment.suppliedBaseAmount !== undefined
      && !finiteNumber(fulfillment.suppliedBaseAmount, 0.001, 10_000_000)
    )
    || (
      fulfillment.requestedBaseAmount !== undefined
      && fulfillment.suppliedBaseAmount !== undefined
      && fulfillment.suppliedBaseAmount + 0.0001 < fulfillment.requestedBaseAmount
    )
    || (
      fulfillment.baseUnit !== undefined
      && !["oz", "fl oz", "each"].includes(String(fulfillment.baseUnit))
    )
    || (
      fulfillment.overageBaseAmount !== undefined
      && !finiteNumber(fulfillment.overageBaseAmount, 0, 10_000_000)
    )
    || (
      fulfillment.overagePercent !== undefined
      && !finiteNumber(fulfillment.overagePercent, 0, 100_000)
    )
    || !boundedText(fulfillment.label, 200)
    || typeof fulfillment.approvalRequired !== "boolean"
    || (
      fulfillment.recoveredFromStrictNoMatch !== undefined
      && typeof fulfillment.recoveredFromStrictNoMatch !== "boolean"
    )
  ) return null;

  return {
    kind: fulfillment.kind as RetailPackageFulfillment["kind"],
    cartQuantity: fulfillment.cartQuantity,
    packageCount: fulfillment.packageCount,
    ...(fulfillment.requestedBaseAmount !== undefined
      ? { requestedBaseAmount: fulfillment.requestedBaseAmount as number }
      : {}),
    ...(fulfillment.suppliedBaseAmount !== undefined
      ? { suppliedBaseAmount: fulfillment.suppliedBaseAmount as number }
      : {}),
    ...(fulfillment.baseUnit !== undefined
      ? { baseUnit: fulfillment.baseUnit as RetailPackageFulfillment["baseUnit"] }
      : {}),
    ...(fulfillment.overageBaseAmount !== undefined
      ? { overageBaseAmount: fulfillment.overageBaseAmount as number }
      : {}),
    ...(fulfillment.overagePercent !== undefined
      ? { overagePercent: fulfillment.overagePercent as number }
      : {}),
    label: fulfillment.label as string,
    approvalRequired: fulfillment.approvalRequired,
    ...(fulfillment.recoveredFromStrictNoMatch !== undefined
      ? { recoveredFromStrictNoMatch: fulfillment.recoveredFromStrictNoMatch as boolean }
      : {}),
  };
}

function decodeRankedKrogerProduct(
  value: unknown,
  request: KrogerSearchRequest,
): RankedKrogerProduct | null {
  const product = record(value);
  const provenance = record(product?.priceProvenance);
  const location = record(provenance?.location);
  const productKeys = [
    "retailer", "id", "productId", "itemId", "upc", "title", "price", "priceCents",
    "link", "linkType", "sourceUrl", "productPageUnavailable", "thumbnail", "seller",
    "brand", "productType", "inStock", "availabilityStatus", "sponsored", "size",
    "reportedUnitPrice", "reportedUnitBasis", "checkedAt", "verification",
    "verificationIssues", "cartEligible", "dataSource", "identityVerified", "score",
    "confidence", "unitPrice", "unitLabel", "comparablePrice", "matchedTerms", "reasons",
    "priceProvenance",
  ];
  if (
    !product
    || !exactKeys(product, [
      "retailer", "id", "productId", "upc", "title", "price", "link", "inStock",
      "availabilityStatus", "sponsored", "cartEligible", "dataSource", "identityVerified",
      "score", "confidence", "comparablePrice", "matchedTerms", "reasons", "priceProvenance",
    ], productKeys)
    || product.retailer !== "kroger"
    || typeof product.id !== "string"
    || !/^\d{8,14}$/.test(product.id)
    || typeof product.productId !== "string"
    || !/^\d{8,14}$/.test(product.productId)
    || product.id !== product.productId
    || typeof product.upc !== "string"
    || !/^\d{8,14}$/.test(product.upc)
    || !boundedText(product.title, 300)
    || !finiteNumber(product.price, 0.01, 1_000_000)
    || (product.priceCents !== undefined && !safeInteger(product.priceCents, 1, 100_000_000))
    || !safeHttpsUrl(product.link, true)
    || (product.linkType !== undefined && !["product", "search"].includes(String(product.linkType)))
    || (product.sourceUrl !== undefined && !safeHttpsUrl(product.sourceUrl, true))
    || (product.productPageUnavailable !== undefined && typeof product.productPageUnavailable !== "boolean")
    || (product.thumbnail !== undefined && !safeHttpsUrl(product.thumbnail))
    || (product.itemId !== undefined && !boundedText(product.itemId, 128))
    || (product.seller !== undefined && !boundedText(product.seller, 120))
    || (product.brand !== undefined && !boundedText(product.brand, 120))
    || (product.productType !== undefined && !boundedText(product.productType, 160))
    || typeof product.inStock !== "boolean"
    || !["in_stock", "likely_available", "out_of_stock", "unknown"].includes(String(product.availabilityStatus))
    || product.inStock !== (product.availabilityStatus === "in_stock")
    || product.sponsored !== false
    || (product.size !== undefined && !decodeMeasurement(product.size))
    || (product.reportedUnitPrice !== undefined && !finiteNumber(product.reportedUnitPrice, 0, 1_000_000))
    || (
      product.reportedUnitBasis !== undefined
      && !["oz", "fl oz", "lb", "each"].includes(String(product.reportedUnitBasis))
    )
    || (product.checkedAt !== undefined && !isoTimestamp(product.checkedAt))
    || (product.verification !== undefined && product.verification !== "verified")
    || (
      product.verificationIssues !== undefined
      && !boundedStringArray(product.verificationIssues, 20, 300)
    )
    || typeof product.cartEligible !== "boolean"
    || (
      product.cartEligible
      && !["in_stock", "likely_available"].includes(String(product.availabilityStatus))
    )
    || product.dataSource !== "kroger_public_api"
    || product.identityVerified !== true
    || !["high", "medium", "low"].includes(String(product.confidence))
    || !finiteNumber(product.score, -10_000, 10_000)
    || !finiteNumber(product.comparablePrice, 0.001, 1_000_000)
    || (product.unitPrice !== undefined && !finiteNumber(product.unitPrice, 0.001, 1_000_000))
    || (product.unitLabel !== undefined && !boundedText(product.unitLabel, 80))
    || !boundedStringArray(product.matchedTerms, 50, 100)
    || !boundedStringArray(product.reasons, 50, 300)
    || !provenance
    || !exactKeys(provenance, [
      "retailer", "priceSource", "priceScope", "priceReliability", "exactStoreVerified",
      "location", "fulfillment", "locationId",
    ], ["regularPriceCents", "promoPriceCents", "locationName", "chain", "checkedAt"])
    || provenance.retailer !== "kroger"
    || provenance.priceSource !== "kroger_location_product"
    || provenance.priceScope !== "exact_store"
    || provenance.priceReliability !== "verified"
    || provenance.exactStoreVerified !== true
    || provenance.locationId !== request.locationId
    || !location
    || !exactKeys(location, ["responseProvesLocation"], [
      "requestedStoreId", "observedStoreId", "requestedPostalCode", "observedPostalCode",
      "storeMatched", "postalCodeMatched",
    ])
    || location.responseProvesLocation !== true
    || location.requestedStoreId !== request.locationId
    || location.observedStoreId !== request.locationId
    || location.storeMatched !== true
    || !Array.isArray(provenance.fulfillment)
    || provenance.fulfillment.length < 1
    || provenance.fulfillment.length > 3
    || new Set(provenance.fulfillment).size !== provenance.fulfillment.length
    || provenance.fulfillment.some((mode) => !["pickup", "delivery", "shipping"].includes(String(mode)))
    || (provenance.regularPriceCents !== undefined && !safeInteger(provenance.regularPriceCents, 1, 100_000_000))
    || (provenance.promoPriceCents !== undefined && !safeInteger(provenance.promoPriceCents, 1, 100_000_000))
    || (provenance.locationName !== undefined && !boundedText(provenance.locationName, 160))
    || (provenance.chain !== undefined && !boundedText(provenance.chain, 80))
    || (provenance.checkedAt !== undefined && !isoTimestamp(provenance.checkedAt))
  ) return null;

  return {
    retailer: "kroger",
    id: product.id,
    productId: product.productId,
    upc: product.upc,
    title: product.title,
    ...(product.brand !== undefined ? { brand: product.brand as string } : {}),
    ...(product.productType !== undefined ? { productType: product.productType as string } : {}),
    price: product.price,
    ...(product.priceCents !== undefined ? { priceCents: product.priceCents as number } : {}),
    link: product.link,
    ...(product.linkType !== undefined ? { linkType: product.linkType as "product" | "search" } : {}),
    ...(product.thumbnail !== undefined ? { thumbnail: product.thumbnail as string } : {}),
    ...(product.size !== undefined ? { size: product.size as ProductMeasurement } : {}),
    ...(product.checkedAt !== undefined ? { checkedAt: product.checkedAt as string } : {}),
    inStock: product.inStock,
    availabilityStatus: product.availabilityStatus as AvailabilityStatus,
    cartEligible: product.cartEligible,
    dataSource: "kroger_public_api",
    confidence: product.confidence as RankedKrogerProduct["confidence"],
    score: product.score,
    reasons: product.reasons as string[],
    priceProvenance: {
      ...(provenance.regularPriceCents !== undefined
        ? { regularPriceCents: provenance.regularPriceCents as number }
        : {}),
      ...(provenance.promoPriceCents !== undefined
        ? { promoPriceCents: provenance.promoPriceCents as number }
        : {}),
      locationId: provenance.locationId as string,
      ...(provenance.locationName !== undefined ? { locationName: provenance.locationName as string } : {}),
      ...(provenance.chain !== undefined ? { chain: provenance.chain as string } : {}),
      ...(provenance.checkedAt !== undefined ? { checkedAt: provenance.checkedAt as string } : {}),
      priceScope: "exact_store",
      priceReliability: "verified",
      exactStoreVerified: true,
      fulfillment: provenance.fulfillment as ("pickup" | "delivery" | "shipping")[],
    },
  };
}

function decodeKrogerMatchResult(
  value: unknown,
  request: KrogerSearchRequest,
  index: number,
): KrogerMatchResult | null {
  const result = record(value);
  if (
    !result
    || !exactKeys(result, [
      "retailer", "requestedItem", "recommended", "alternatives", "confidence", "status",
      "explanation",
    ], ["assumptions", "resolution", "fulfillment", "clarification", "verifiedAt", "error"])
    || result.retailer !== "kroger"
    || result.requestedItem !== request.items[index]?.text
    || !["high", "medium", "low"].includes(String(result.confidence))
    || !["matched", "review", "no_match"].includes(String(result.status))
    || (
      result.resolution !== undefined
      && ![
        "matched", "matched_check_availability", "multi_package_fulfillment",
        "substitute_available", "needs_choice", "truly_unavailable",
      ].includes(String(result.resolution))
    )
    || !boundedText(result.explanation, 1_000)
    || (result.assumptions !== undefined && !boundedStringArray(result.assumptions, 20, 300))
    || (result.clarification !== undefined && !boundedText(result.clarification, 500))
    || (result.verifiedAt !== undefined && !isoTimestamp(result.verifiedAt))
    || (result.error !== undefined && !boundedText(result.error, 500))
    || !Array.isArray(result.alternatives)
    || result.alternatives.length > 3
  ) return null;
  const fulfillment = result.fulfillment === undefined
    ? undefined
    : decodeRetailPackageFulfillment(result.fulfillment);
  if (result.fulfillment !== undefined && !fulfillment) return null;
  const recommended = result.recommended === null
    ? null
    : decodeRankedKrogerProduct(result.recommended, request);
  if (result.recommended !== null && !recommended) return null;
  const alternatives = result.alternatives.map((entry) => decodeRankedKrogerProduct(entry, request));
  if (alternatives.some((entry) => !entry)) return null;
  if (result.status === "matched" && !recommended) return null;
  if (result.status === "no_match" && recommended) return null;
  if (result.status === "no_match" && fulfillment) return null;
  if (result.resolution === "truly_unavailable" && result.status !== "no_match") return null;
  if (result.resolution === "needs_choice" && result.status !== "review") return null;
  if (
    result.resolution === "multi_package_fulfillment"
    && fulfillment?.kind !== "multi_package"
  ) return null;
  if (recommended && result.confidence !== recommended.confidence) return null;
  const ids = [recommended?.id, ...alternatives.map((entry) => entry!.id)].filter(Boolean);
  if (new Set(ids).size !== ids.length) return null;
  return {
    retailer: "kroger",
    requestedItem: result.requestedItem as string,
    recommended,
    alternatives: alternatives as RankedKrogerProduct[],
    ...(result.assumptions !== undefined ? { assumptions: result.assumptions as string[] } : {}),
    confidence: result.confidence as KrogerMatchResult["confidence"],
    status: result.status as KrogerMatchResult["status"],
    ...(result.resolution !== undefined
      ? { resolution: result.resolution as RetailMatchResolution }
      : {}),
    ...(fulfillment ? { fulfillment } : {}),
    explanation: result.explanation as string,
    ...(result.clarification !== undefined ? { clarification: result.clarification as string } : {}),
    ...(result.verifiedAt !== undefined ? { verifiedAt: result.verifiedAt as string } : {}),
    ...(result.error !== undefined ? { error: result.error as string } : {}),
  };
}

function decodeCartAutomation(value: unknown, enabled: boolean) {
  const policy = record(value);
  if (!policy || policy.enabled !== enabled) return null;
  if (enabled) {
    return exactKeys(policy, ["enabled", "requiresCustomerConnection"])
      && policy.requiresCustomerConnection === true
      ? { enabled: true as const, requiresCustomerConnection: true as const }
      : null;
  }
  return exactKeys(policy, ["enabled", "reason"])
    && boundedText(policy.reason, 500)
    ? { enabled: false as const, reason: policy.reason }
    : null;
}

export function decodeKrogerSearchEvent(
  value: unknown,
  request: KrogerSearchRequest,
  persistServerReceipt: boolean,
): KrogerSearchEvent {
  const invalid = () => new CartivaApiError("Cartiva received an invalid Kroger result.", "response");
  const event = record(value);
  if (!event || !boundedText(event.type, 20)) throw invalid();
  if (event.type === "item") {
    if (
      !exactKeys(event, [
        "type", "retailer", "phase", "index", "mode", "checkedAt", "cartAutomation",
        "result", "diagnostics",
      ])
      || event.retailer !== "kroger"
      || !["search", "verification"].includes(String(event.phase))
      || !safeInteger(event.index, 0, request.items.length - 1)
      || event.mode !== "live"
      || !isoTimestamp(event.checkedAt)
    ) throw invalid();
    const automation = decodeCartAutomation(event.cartAutomation, persistServerReceipt);
    const result = decodeKrogerMatchResult(event.result, request, event.index);
    const diagnostics = record(event.diagnostics);
    const expectedVerification = result?.status === "matched"
      ? "verified"
      : result?.status === "review" ? "needs_review" : "no_verified_match";
    if (
      !automation
      || !result
      || !diagnostics
      || !exactKeys(diagnostics, [
        "searchResultCount", "verificationStatus", "locationId",
      ], ["selectedProductId", "rejectionReason"])
      || !safeInteger(diagnostics.searchResultCount, 0, 60)
      || diagnostics.verificationStatus !== expectedVerification
      || diagnostics.locationId !== request.locationId
      || (
        result.recommended
          ? diagnostics.selectedProductId !== result.recommended.productId
          : diagnostics.selectedProductId !== undefined
      )
      || (
        result.status === "matched"
          ? diagnostics.rejectionReason !== undefined
          : diagnostics.rejectionReason !== result.explanation
      )
    ) throw invalid();
    return {
      type: "item",
      retailer: "kroger",
      phase: event.phase as KrogerSearchItemEvent["phase"],
      index: event.index,
      mode: "live",
      checkedAt: event.checkedAt,
      cartAutomation: automation,
      result,
      diagnostics: {
        searchResultCount: diagnostics.searchResultCount,
        ...(diagnostics.selectedProductId !== undefined
          ? { selectedProductId: diagnostics.selectedProductId as string }
          : {}),
        verificationStatus: diagnostics.verificationStatus as KrogerSearchItemEvent["diagnostics"]["verificationStatus"],
        locationId: diagnostics.locationId as string,
        ...(diagnostics.rejectionReason !== undefined
          ? { rejectionReason: diagnostics.rejectionReason as string }
          : {}),
      },
    };
  }

  if (
    event.type !== "performance"
    || !exactKeys(event, ["type", "retailer", "mode", "checkedAt", "performance"], ["comparisonReceipt"])
    || event.retailer !== "kroger"
    || event.mode !== "live"
    || !isoTimestamp(event.checkedAt)
  ) throw invalid();
  const performance = record(event.performance);
  const maximumCalls = request.items.length * 3;
  if (
    !performance
    || !exactKeys(performance, [
      "totalDurationMs", "cacheHits", "searchApiCalls", "productApiCalls",
      "deduplicatedRequests", "upstreamCacheUsed", "items",
    ], ["outcomeCounts"])
    || !safeInteger(performance.totalDurationMs, 0, 600_000)
    || !safeInteger(performance.cacheHits, 0, maximumCalls)
    || !safeInteger(performance.searchApiCalls, 0, maximumCalls)
    || !safeInteger(performance.productApiCalls, 0, maximumCalls)
    || !safeInteger(performance.deduplicatedRequests, 0, maximumCalls)
    || !["yes", "no", "unknown", "local cache only"].includes(String(performance.upstreamCacheUsed))
    || !Array.isArray(performance.items)
    || performance.items.length !== request.items.length
  ) throw invalid();
  const outcomeCounts = performance.outcomeCounts === undefined
    ? undefined
    : record(performance.outcomeCounts);
  if (
    performance.outcomeCounts !== undefined
    && (
      !outcomeCounts
      || !exactKeys(outcomeCounts, [
        "requestedItems", "matchedAutomatically", "multiPackageFulfilled",
        "shopperChoiceRequired", "trulyUnavailable",
      ])
      || outcomeCounts.requestedItems !== request.items.length
      || !safeInteger(outcomeCounts.matchedAutomatically, 0, request.items.length)
      || !safeInteger(outcomeCounts.multiPackageFulfilled, 0, request.items.length)
      || !safeInteger(outcomeCounts.shopperChoiceRequired, 0, request.items.length)
      || !safeInteger(outcomeCounts.trulyUnavailable, 0, request.items.length)
      || outcomeCounts.multiPackageFulfilled > outcomeCounts.matchedAutomatically
      || outcomeCounts.shopperChoiceRequired + outcomeCounts.trulyUnavailable > request.items.length
    )
  ) throw invalid();
  const decodedTimings = performance.items.map((value, index) => {
    const timing = record(value);
    if (
      !timing
      || !exactKeys(timing, [
        "index", "item", "searchDurationMs", "verificationDurationMs", "totalDurationMs",
      ])
      || timing.index !== index
      || timing.item !== request.items[index]?.text
      || !safeInteger(timing.searchDurationMs, 0, 600_000)
      || !safeInteger(timing.verificationDurationMs, 0, 600_000)
      || !safeInteger(timing.totalDurationMs, 0, 600_000)
      || timing.totalDurationMs !== timing.searchDurationMs + timing.verificationDurationMs
    ) throw invalid();
    return {
      index,
      item: timing.item as string,
      searchDurationMs: timing.searchDurationMs,
      verificationDurationMs: timing.verificationDurationMs,
      totalDurationMs: timing.totalDurationMs,
    };
  });

  const receipt = record(event.comparisonReceipt);
  if (persistServerReceipt !== Boolean(receipt)) throw invalid();
  let comparisonReceipt: KrogerComparisonReceiptConfirmation | undefined;
  if (receipt) {
    if (
      !exactKeys(receipt, [
        "comparisonId", "locationId", "retailerBanner", "completeness", "basketDigest", "persisted",
      ])
      || receipt.comparisonId !== request.comparisonId
      || receipt.locationId !== request.locationId
      || !boundedText(receipt.retailerBanner, 80)
      || !["COMPLETE", "INCOMPLETE"].includes(String(receipt.completeness))
      || typeof receipt.basketDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(receipt.basketDigest)
      || receipt.persisted !== true
    ) throw invalid();
    comparisonReceipt = receipt as unknown as KrogerComparisonReceiptConfirmation;
  }
  return {
    type: "performance",
    retailer: "kroger",
    mode: "live",
    checkedAt: event.checkedAt,
    ...(comparisonReceipt ? { comparisonReceipt } : {}),
    performance: {
      totalDurationMs: performance.totalDurationMs,
      cacheHits: performance.cacheHits,
      searchApiCalls: performance.searchApiCalls,
      productApiCalls: performance.productApiCalls,
      deduplicatedRequests: performance.deduplicatedRequests,
      upstreamCacheUsed: performance.upstreamCacheUsed as KrogerSearchPerformanceEvent["performance"]["upstreamCacheUsed"],
      ...(outcomeCounts ? {
        outcomeCounts: {
          requestedItems: outcomeCounts.requestedItems as number,
          matchedAutomatically: outcomeCounts.matchedAutomatically as number,
          multiPackageFulfilled: outcomeCounts.multiPackageFulfilled as number,
          shopperChoiceRequired: outcomeCounts.shopperChoiceRequired as number,
          trulyUnavailable: outcomeCounts.trulyUnavailable as number,
        },
      } : {}),
      items: decodedTimings,
    },
  };
}

export async function comparisonBasketDigestForMobile(
  receipt: ComparisonSessionReceipt,
) {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    comparisonBasketCanonicalPayload(receipt),
  );
}

export async function krogerComparisonReceiptMatches(
  confirmation: KrogerComparisonReceiptConfirmation,
  receipt: ComparisonSessionReceipt,
) {
  if (
    confirmation.comparisonId !== receipt.comparisonId
    || confirmation.locationId !== receipt.locationId
    || confirmation.retailerBanner !== receipt.retailerBanner
    || confirmation.completeness !== receipt.completeness
    || confirmation.persisted !== true
  ) return false;
  return confirmation.basketDigest === await comparisonBasketDigestForMobile(receipt);
}

const configuredOrigin = process.env.EXPO_PUBLIC_CARTIVA_API_URL?.trim().replace(/\/+$/, "");

export function cartivaApiOrigin() {
  return configuredOrigin || "http://127.0.0.1:3000";
}

function endpoint(pathname: string) {
  const origin = cartivaApiOrigin();
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new CartivaApiError(
      "The Cartiva backend address is invalid. Check EXPO_PUBLIC_CARTIVA_API_URL.",
      "configuration",
    );
  }
  if (!__DEV__ && parsed.protocol !== "https:") {
    throw new CartivaApiError(
      "Production Cartiva builds require an HTTPS backend.",
      "configuration",
    );
  }
  return new URL(pathname, `${parsed.toString().replace(/\/+$/, "")}/`).toString();
}

function timeoutError() {
  return new CartivaApiError("Kroger took too long to respond. Please try again.", "timeout");
}

function comparisonNetworkError() {
  return new CartivaApiError(
    "Cartiva could not reach the comparison service. You can keep editing your list and retry when you're online.",
    "network",
  );
}

function comparisonAbortError() {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The comparison was cancelled.", "AbortError");
  }
  const error = new Error("The comparison was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * Keeps one abort signal alive until a streaming response is fully consumed.
 * The deadline is refreshed whenever bytes arrive, so a healthy long-running
 * comparison can continue while a silent connection still fails predictably.
 */
function activeStreamTimeout(timeoutMs: number, externalSignal?: AbortSignal) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let cancelled = false;
  let rejectExpiry!: (error: CartivaApiError) => void;
  let rejectCancellation!: (error: Error) => void;
  const expiry = new Promise<never>((_resolve, reject) => {
    rejectExpiry = reject;
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancelFromConsumer = () => {
    if (cancelled || expired) return;
    cancelled = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    controller.abort();
    rejectCancellation(comparisonAbortError());
  };
  if (externalSignal?.aborted) {
    cancelFromConsumer();
  } else {
    externalSignal?.addEventListener("abort", cancelFromConsumer, { once: true });
  }
  const refresh = () => {
    if (expired || cancelled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (cancelled) return;
      expired = true;
      controller.abort();
      rejectExpiry(timeoutError());
    }, timeoutMs);
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    externalSignal?.removeEventListener("abort", cancelFromConsumer);
  };
  refresh();
  return {
    controller,
    expiry,
    cancellation,
    refresh,
    stop,
    didExpire: () => expired,
    wasCancelled: () => cancelled,
  };
}

async function errorFromResponse(response: Response) {
  let message = `Cartiva returned an unexpected response (${response.status}).`;
  try {
    const value = await response.json() as { error?: unknown };
    if (typeof value.error === "string" && value.error.trim()) message = value.error;
  } catch {
    // Keep the controlled status message when the body is not JSON.
  }
  return new CartivaApiError(message, "response", response.status);
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
) {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline!: (error: CartivaApiError) => void;
  let rejectCancellation!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancelFromConsumer = () => {
    if (cancelled || timedOut) return;
    cancelled = true;
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    controller.abort();
    rejectCancellation(comparisonAbortError());
  };
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", cancelFromConsumer, { once: true });
  }
  timeout = setTimeout(() => {
    if (cancelled) return;
    timedOut = true;
    controller.abort();
    rejectDeadline(timeoutError());
  }, timeoutMs);
  const request = async () => {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw await errorFromResponse(response);
    try {
      return await response.json() as T;
    } catch (error) {
      if (timedOut || cancelled) throw error;
      throw new CartivaApiError("Cartiva returned an unreadable response.", "response", response.status);
    }
  };
  try {
    // The deadline remains active through error and success body decoding, not
    // merely until headers arrive.
    return await Promise.race([request(), deadline, cancellation]);
  } catch (error) {
    if (timedOut) {
      throw timeoutError();
    }
    if (cancelled || externalSignal?.aborted) throw comparisonAbortError();
    if (error instanceof CartivaApiError) throw error;
    throw new CartivaApiError(
      "Cartiva could not reach the comparison service. You can keep editing your list and retry when you're online.",
      "network",
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", cancelFromConsumer);
  }
}

async function postJson(
  pathname: string,
  body: unknown,
  timeoutMs = 15_000,
  signal?: AbortSignal,
) {
  return fetchJsonWithTimeout<unknown>(endpoint(pathname), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Cartiva-Client": "expo-mobile-v1",
    },
    body: JSON.stringify(body),
  }, timeoutMs, signal);
}

async function postStreamingJson(
  pathname: string,
  body: unknown,
  timeoutMs: number,
  useMobileSession: boolean,
  signal?: AbortSignal,
) {
  const deadline = activeStreamTimeout(timeoutMs, signal);
  const init: RequestInit = {
    method: "POST",
    headers: {
      Accept: "application/x-ndjson, application/json",
      "Content-Type": "application/json",
      "X-Cartiva-Client": "expo-mobile-v1",
    },
    body: JSON.stringify(body),
    signal: deadline.controller.signal,
  };
  try {
    const response = await Promise.race([
      useMobileSession
        ? mobileSessionFetch(pathname, init)
        : fetch(endpoint(pathname), init),
      deadline.expiry,
      deadline.cancellation,
    ]);
    // Receiving headers proves the connection is active, not that the NDJSON
    // body will finish. Keep the same timer alive for body consumption.
    deadline.refresh();
    if (!response.ok) {
      throw await Promise.race([
        errorFromResponse(response),
        deadline.expiry,
        deadline.cancellation,
      ]);
    }
    return { response, deadline };
  } catch (error) {
    deadline.stop();
    if (deadline.didExpire() || (error instanceof CartivaApiError && error.code === "timeout")) {
      throw timeoutError();
    }
    if (deadline.wasCancelled()) throw comparisonAbortError();
    if (error instanceof CartivaApiError) throw error;
    throw comparisonNetworkError();
  }
}

export async function getCapabilities(signal?: AbortSignal) {
  const value = await fetchJsonWithTimeout<unknown>(endpoint("api/mobile/v1/capabilities"), {
    headers: { Accept: "application/json", "X-Cartiva-Client": "expo-mobile-v1" },
  }, 10_000, signal);
  return decodeCartivaCapabilities(value);
}

export async function findKrogerLocations(zipCode: string, signal?: AbortSignal) {
  const value = await postJson(
    "api/mobile/v1/kroger/locations",
    { zipCode },
    15_000,
    signal,
  );
  return decodeKrogerLocationsResponse(value, zipCode);
}

const MAX_KROGER_EVENT_TEXT = 1_000_000;

function consumeLines(buffer: string, onEvent: (event: unknown) => void) {
  if (buffer.length > MAX_KROGER_EVENT_TEXT) {
    throw new CartivaApiError("Cartiva received an oversized Kroger result.", "response");
  }
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_KROGER_EVENT_TEXT) {
      throw new CartivaApiError("Cartiva received an oversized Kroger result.", "response");
    }
    onEvent(JSON.parse(trimmed) as unknown);
  }
  return remainder;
}

function assertCompleteKrogerStream(
  request: KrogerSearchRequest,
  phases: Map<number, { search: boolean; verification: boolean; searchWasError: boolean }>,
  performanceSeen: boolean,
) {
  const complete = performanceSeen && request.items.every((_item, index) => {
    const observed = phases.get(index);
    return Boolean(observed?.search && (observed.verification || observed.searchWasError));
  });
  if (!complete) {
    throw new CartivaApiError("Cartiva received an incomplete Kroger comparison.", "response");
  }
}

export async function searchKroger(
  request: KrogerSearchRequest,
  onEvent: (event: KrogerSearchEvent) => void,
  options: { persistServerReceipt: boolean; timeoutMs?: number; signal?: AbortSignal },
) {
  const body = {
    retailer: "kroger",
    ...request,
  };
  const { response, deadline } = await postStreamingJson(
    "api/mobile/v1/kroger/search",
    body,
    options.timeoutMs ?? 75_000,
    options.persistServerReceipt,
    options.signal,
  );
  let receiptConfirmation: KrogerComparisonReceiptConfirmation | undefined;
  const phases = new Map<number, { search: boolean; verification: boolean; searchWasError: boolean }>();
  let performanceSeen = false;
  const dispatch = (value: unknown) => {
    const event = decodeKrogerSearchEvent(value, request, options.persistServerReceipt);
    if (event.type === "item") {
      if (performanceSeen) {
        throw new CartivaApiError("Cartiva received Kroger results out of order.", "response");
      }
      const observed = phases.get(event.index) ?? {
        search: false,
        verification: false,
        searchWasError: false,
      };
      if (
        (event.phase === "search" && observed.search)
        || (event.phase === "verification" && (!observed.search || observed.verification))
      ) {
        throw new CartivaApiError("Cartiva received duplicate Kroger results.", "response");
      }
      if (event.phase === "search") {
        observed.search = true;
        observed.searchWasError = Boolean(event.result.error);
      } else {
        observed.verification = true;
      }
      phases.set(event.index, observed);
    } else {
      if (performanceSeen) {
        throw new CartivaApiError("Cartiva received duplicate Kroger completion data.", "response");
      }
      performanceSeen = true;
    }
    if (event.type === "performance" && event.comparisonReceipt) {
      receiptConfirmation = event.comparisonReceipt;
    }
    onEvent(event);
  };
  const reader = response.body?.getReader?.();
  let streamFinished = false;
  try {
    if (!reader) {
      const text = await Promise.race([
        response.text(),
        deadline.expiry,
        deadline.cancellation,
      ]);
      streamFinished = true;
      const remainder = consumeLines(`${text}\n`, dispatch);
      if (remainder.trim()) dispatch(JSON.parse(remainder) as unknown);
      assertCompleteKrogerStream(request, phases, performanceSeen);
      if (
        options.persistServerReceipt
        && (!receiptConfirmation || receiptConfirmation.comparisonId !== request.comparisonId)
      ) {
        throw new CartivaApiError("Cartiva could not preserve this comparison for retailer handoff.", "response");
      }
      return receiptConfirmation;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        deadline.expiry,
        deadline.cancellation,
      ]);
      if (done) {
        streamFinished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeLines(buffer, dispatch);
      // A progressing comparison may legitimately take longer than one fixed
      // wall-clock window. Only a silent interval is considered stalled.
      deadline.refresh();
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatch(JSON.parse(buffer) as unknown);
  } catch (error) {
    if (deadline.didExpire() || (error instanceof CartivaApiError && error.code === "timeout")) {
      throw timeoutError();
    }
    if (deadline.wasCancelled()) throw comparisonAbortError();
    if (error instanceof SyntaxError) {
      throw new CartivaApiError("Cartiva received an invalid Kroger result.", "response");
    }
    if (
      error instanceof TypeError
      || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
    ) {
      throw comparisonNetworkError();
    }
    throw error;
  } finally {
    deadline.stop();
    if (reader && !streamFinished) {
      deadline.controller.abort();
      await reader.cancel().catch(() => undefined);
    }
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        // An aborted platform stream may release its lock itself.
      }
    }
  }
  assertCompleteKrogerStream(request, phases, performanceSeen);
  if (
    options.persistServerReceipt
    && (!receiptConfirmation || receiptConfirmation.comparisonId !== request.comparisonId)
  ) {
    throw new CartivaApiError("Cartiva could not preserve this comparison for retailer handoff.", "response");
  }
  return receiptConfirmation;
}
