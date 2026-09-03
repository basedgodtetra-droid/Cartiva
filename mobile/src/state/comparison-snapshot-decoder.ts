import {
  BasketCompleteness,
  COMPARISON_SESSION_SCHEMA_VERSION,
  assertComparisonStoreInvariant,
  availabilityForComparison,
  interpretGroceryInput,
  isRetailerHandoffAcceptedMatch,
  krogerRetailerBanner,
  parseRetailerPackageQuantity,
  type ComparisonSessionReceipt,
} from "@cartiva/shared";
import { isTrustedKrogerRetailerUrl } from "../services/cart-submission-marker";
import {
  decodeCartivaCapabilities,
  decodeRetailPackageFulfillment,
} from "../services/cartiva-api";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function exactKeys(value: UnknownRecord, required: string[], optional: string[] = []) {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function text(value: unknown, maximum = 500, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maximum
    && (allowEmpty || value.trim().length > 0);
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function stringArray(value: unknown, maximumItems: number, maximumLength = 200) {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every((entry) => text(entry, maximumLength));
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => sameJson(entry, right[index]));
  }
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && sameJson(leftRecord[key], rightRecord[key])
    ));
}

function validMeasurement(value: unknown) {
  const measurement = record(value);
  const required = ["amount", "unit", "kind", "baseAmount", "baseUnit", "label"];
  const optional = ["packCount", "perPackageAmount"];
  return Boolean(
    measurement
    && exactKeys(measurement, required, optional)
    && finite(measurement.amount, 0.001, 100_000)
    && ["oz", "lb", "fl oz", "count"].includes(String(measurement.unit))
    && ["weight", "volume", "count"].includes(String(measurement.kind))
    && finite(measurement.baseAmount, 0.001, 100_000)
    && ["oz", "fl oz", "each"].includes(String(measurement.baseUnit))
    && text(measurement.label, 100)
    && (measurement.packCount === undefined || integer(measurement.packCount, 1, 999))
    && (measurement.perPackageAmount === undefined
      || finite(measurement.perPackageAmount, 0.001, 100_000)),
  );
}

function validPriceProvenance(value: unknown, locationId: string) {
  const provenance = record(value);
  const required = [
    "locationId", "priceScope", "priceReliability", "exactStoreVerified", "fulfillment",
  ];
  const optional = [
    "regularPriceCents", "promoPriceCents", "locationName", "chain", "checkedAt",
  ];
  if (!provenance || !exactKeys(provenance, required, optional)) return false;
  const fulfillment = provenance.fulfillment;
  return provenance.locationId === locationId
    && ["exact_store", "localized", "estimated"].includes(String(provenance.priceScope))
    && ["verified", "localized_estimate", "unreliable"].includes(String(provenance.priceReliability))
    && typeof provenance.exactStoreVerified === "boolean"
    && Array.isArray(fulfillment)
    && fulfillment.length <= 3
    && new Set(fulfillment).size === fulfillment.length
    && fulfillment.every((mode) => ["pickup", "delivery", "shipping"].includes(String(mode)))
    && (provenance.regularPriceCents === undefined
      || integer(provenance.regularPriceCents, 1, 100_000_000))
    && (provenance.promoPriceCents === undefined
      || integer(provenance.promoPriceCents, 1, 100_000_000))
    && (provenance.locationName === undefined || text(provenance.locationName, 160))
    && (provenance.chain === undefined || text(provenance.chain, 80))
    && (provenance.checkedAt === undefined || isoDate(provenance.checkedAt));
}

function validProduct(value: unknown, locationId: string) {
  const product = record(value);
  const required = [
    "retailer", "id", "productId", "upc", "title", "price", "link", "inStock",
    "availabilityStatus", "cartEligible", "dataSource", "confidence", "score", "reasons",
    "priceProvenance",
  ];
  const optional = [
    "brand", "productType", "priceCents", "linkType", "thumbnail", "size", "checkedAt",
  ];
  if (!product || !exactKeys(product, required, optional)) return false;
  return product.retailer === "kroger"
    && text(product.id, 128)
    && text(product.productId, 128)
    && typeof product.upc === "string"
    && /^\d{8,14}$/.test(product.upc)
    && text(product.title, 300)
    && finite(product.price, 0.01, 1_000_000)
    && (product.priceCents === undefined || integer(product.priceCents, 1, 100_000_000))
    && isTrustedKrogerRetailerUrl(product.link)
    && (product.linkType === undefined || ["product", "search"].includes(String(product.linkType)))
    && (product.thumbnail === undefined || (() => {
      try {
        return new URL(String(product.thumbnail)).protocol === "https:";
      } catch {
        return false;
      }
    })())
    && (product.brand === undefined || text(product.brand, 120))
    && (product.productType === undefined || text(product.productType, 120))
    && (product.size === undefined || validMeasurement(product.size))
    && (product.checkedAt === undefined || isoDate(product.checkedAt))
    && typeof product.inStock === "boolean"
    && ["in_stock", "likely_available", "out_of_stock", "unknown"].includes(String(product.availabilityStatus))
    && typeof product.cartEligible === "boolean"
    && product.dataSource === "kroger_public_api"
    && ["high", "medium", "low"].includes(String(product.confidence))
    && finite(product.score, -1_000_000, 1_000_000)
    && stringArray(product.reasons, 40, 300)
    && validPriceProvenance(product.priceProvenance, locationId);
}

function validMatchResult(value: unknown, requestedItem: string, locationId: string) {
  const result = record(value);
  const required = [
    "retailer", "requestedItem", "recommended", "alternatives", "confidence", "status", "explanation",
  ];
  const optional = [
    "assumptions", "resolution", "fulfillment", "clarification", "verifiedAt", "error",
  ];
  if (!result || !exactKeys(result, required, optional)) return false;
  if (
    result.retailer !== "kroger"
    || result.requestedItem !== requestedItem
    || !["high", "medium", "low"].includes(String(result.confidence))
    || !["matched", "review", "no_match"].includes(String(result.status))
    || (
      result.resolution !== undefined
      && ![
        "matched", "matched_check_availability", "multi_package_fulfillment",
        "substitute_available", "needs_choice", "truly_unavailable",
      ].includes(String(result.resolution))
    )
    || (
      result.fulfillment !== undefined
      && !decodeRetailPackageFulfillment(result.fulfillment)
    )
    || !text(result.explanation, 1_000)
    || (result.assumptions !== undefined && !stringArray(result.assumptions, 20, 300))
    || (result.clarification !== undefined && !text(result.clarification, 500))
    || (result.verifiedAt !== undefined && !isoDate(result.verifiedAt))
    || (result.error !== undefined && !text(result.error, 500))
    || !Array.isArray(result.alternatives)
    || result.alternatives.length > 20
    || !result.alternatives.every((product) => validProduct(product, locationId))
  ) return false;
  if (result.recommended !== null && !validProduct(result.recommended, locationId)) return false;
  if (result.status === "matched" && result.recommended === null) return false;
  if (result.status === "no_match" && result.recommended !== null) return false;
  if (result.status === "no_match" && result.fulfillment !== undefined) return false;
  if (result.resolution === "truly_unavailable" && result.status !== "no_match") return false;
  if (result.resolution === "needs_choice" && result.status !== "review") return false;
  if (
    result.resolution === "multi_package_fulfillment"
    && decodeRetailPackageFulfillment(result.fulfillment)?.kind !== "multi_package"
  ) return false;
  const recommended = record(result.recommended);
  const seen = new Set<string>();
  if (recommended) seen.add(String(recommended.id));
  for (const alternative of result.alternatives) {
    const id = String((alternative as UnknownRecord).id);
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function validLocation(value: unknown) {
  const location = record(value);
  const required = ["locationId", "name", "chain", "address", "handoff"];
  const optional = ["phone", "departments"];
  if (!location || !exactKeys(location, required, optional)) return false;
  const address = record(location.address);
  const handoff = record(location.handoff);
  return text(location.locationId, 64)
    && /^[A-Za-z0-9_-]+$/.test(location.locationId)
    && text(location.name, 160)
    && text(location.chain, 80)
    && Boolean(address)
    && exactKeys(address!, ["addressLine1", "city", "state", "zipCode"])
    && text(address!.addressLine1, 200)
    && text(address!.city, 100)
    && typeof address!.state === "string"
    && /^[A-Z]{2}$/.test(address!.state)
    && typeof address!.zipCode === "string"
    && /^\d{5}(?:-\d{4})?$/.test(address!.zipCode)
    && (location.phone === undefined || text(location.phone, 40))
    && (location.departments === undefined || stringArray(location.departments, 100, 100))
    && Boolean(handoff)
    && exactKeys(handoff!, ["mode", "url", "storeSelectionRequired"])
    && handoff!.mode === "SHOPPING_PAGE_ONLY"
    && isTrustedKrogerRetailerUrl(handoff!.url)
    && (() => {
      try {
        const url = new URL(String(handoff!.url));
        return url.pathname === "/" && !url.search && !url.hash;
      } catch {
        return false;
      }
    })()
    && handoff!.storeSelectionRequired === true;
}

function validCapabilities(value: unknown) {
  try {
    decodeCartivaCapabilities(value);
    return true;
  } catch {
    return false;
  }
}

function validLineProvenance(value: unknown, locationId: string) {
  const provenance = record(value);
  const required = [
    "dataSource", "priceSource", "priceScope", "priceReliability", "exactStoreVerified",
    "sourceLocationId", "fulfillment",
  ];
  if (!provenance || !exactKeys(provenance, required, ["checkedAt"])) return false;
  return provenance.dataSource === "kroger_public_api"
    && provenance.priceSource === "kroger_location_product"
    && ["exact_store", "localized", "estimated"].includes(String(provenance.priceScope))
    && ["verified", "localized_estimate", "unreliable"].includes(String(provenance.priceReliability))
    && typeof provenance.exactStoreVerified === "boolean"
    && provenance.sourceLocationId === locationId
    && Array.isArray(provenance.fulfillment)
    && provenance.fulfillment.length <= 2
    && provenance.fulfillment.every((mode) => ["pickup", "delivery"].includes(String(mode)))
    && (provenance.checkedAt === undefined || isoDate(provenance.checkedAt));
}

function expectedProductPriceCents(product: UnknownRecord) {
  const provenance = record(product.priceProvenance);
  if (integer(provenance?.regularPriceCents, 1, 100_000_000)) {
    return provenance.regularPriceCents;
  }
  if (integer(product.priceCents, 1, 100_000_000)) return product.priceCents;
  return Math.round(Number(product.price) * 100);
}

function validBasketLine(
  value: unknown,
  comparisonId: string,
  locationId: string,
  requestedItem: UnknownRecord,
  result: UnknownRecord,
) {
  const line = record(value);
  const required = [
    "lineId", "requestedItemId", "requestedItem", "normalizedIntent", "quantity", "status",
    "locationId", "availabilityStatus", "matchConfidence",
  ];
  const optional = [
    "packageSizeText", "retailerProductId", "upc", "matchedProduct", "matchedPackage",
    "priceCents", "provenance",
  ];
  if (!line || !exactKeys(line, required, optional)) return false;
  const quantity = parseRetailerPackageQuantity(String(requestedItem.raw));
  const fulfillment = result.fulfillment === undefined
    ? undefined
    : decodeRetailPackageFulfillment(result.fulfillment);
  if (result.fulfillment !== undefined && !fulfillment) return false;
  const expectedQuantity = fulfillment?.cartQuantity ?? quantity.quantity;
  const accepted = line.status === "ACCEPTED";
  const recommended = record(result.recommended);
  const recommendedProvenance = record(recommended?.priceProvenance);
  const shouldAccept = Boolean(
    recommended
    && isRetailerHandoffAcceptedMatch({
      status: result.status as "matched" | "review" | "no_match",
      ...(typeof result.resolution === "string" ? { resolution: result.resolution } : {}),
      recommended: {
        availabilityStatus: recommended.availabilityStatus as
          | "in_stock"
          | "likely_available"
          | "out_of_stock"
          | "unknown",
        cartEligible: recommended.cartEligible === true,
      },
      ...(fulfillment ? {
        fulfillment: {
          approvalRequired: fulfillment.approvalRequired,
          kind: fulfillment.kind,
        },
      } : {}),
    })
    && recommendedProvenance?.locationId === locationId
    && recommendedProvenance.exactStoreVerified === true
    && Array.isArray(recommendedProvenance.fulfillment)
    && recommendedProvenance.fulfillment.includes("pickup")
    && recommended.productId
    && recommended.upc,
  );
  const product = accepted ? recommended : null;
  const expectedStatus = shouldAccept
    ? "ACCEPTED"
    : result.status === "matched" && recommended ? "REJECTED" : "UNMATCHED";
  if (
    line.lineId !== `${comparisonId}:${String(requestedItem.id)}`
    || line.requestedItemId !== requestedItem.id
    || line.requestedItem !== requestedItem.raw
    || line.normalizedIntent !== quantity.searchText
    || line.quantity !== expectedQuantity
    || line.packageSizeText !== quantity.packageSizeText
    || !["ACCEPTED", "UNMATCHED", "REJECTED"].includes(String(line.status))
    || line.status !== expectedStatus
    || line.locationId !== locationId
    || !["VERIFIED_IN_STOCK", "LIKELY_AVAILABLE", "UNKNOWN", "OUT_OF_STOCK"].includes(String(line.availabilityStatus))
    || !["high", "medium", "low"].includes(String(line.matchConfidence))
  ) return false;
  if (!accepted) {
    const expectedAvailability = result.status === "matched" && recommended
      ? availabilityForComparison(recommended.availabilityStatus as never)
      : "UNKNOWN";
    return !shouldAccept
      && line.retailerProductId === undefined
      && line.upc === undefined
      && line.matchedProduct === undefined
      && line.matchedPackage === undefined
      && line.priceCents === undefined
      && line.provenance === undefined
      && line.availabilityStatus === expectedAvailability
      && line.matchConfidence === (recommended ? recommended.confidence : "low");
  }
  if (!product || !shouldAccept) return false;
  const size = record(product.size);
  return line.retailerProductId === product.productId
    && line.upc === product.upc
    && line.matchedProduct === product.title
    && line.matchedPackage === size?.label
    && line.priceCents === expectedProductPriceCents(product)
    && line.availabilityStatus === availabilityForComparison(product.availabilityStatus as never)
    && line.matchConfidence === product.confidence
    && validLineProvenance(line.provenance, locationId);
}

function locationAddress(location: UnknownRecord) {
  const address = record(location.address)!;
  return [
    address.addressLine1,
    address.city,
    `${String(address.state)} ${String(address.zipCode)}`.trim(),
  ].filter(Boolean).join(", ");
}

/** Strict decoder for untrusted AsyncStorage JSON. Any malformed nested field fails closed. */
export function decodePersistedComparisonSnapshot(
  value: unknown,
  rawInput: string,
  zipCode: string,
) {
  const snapshot = record(value);
  const required = [
    "schemaVersion", "comparisonId", "retailer", "retailerChain", "retailerBanner",
    "locationId", "locationName", "locationAddress", "zipCode", "fulfillmentMode",
    "requestedItemIds", "basketLines", "completeness", "checkedAt", "createdAt",
    "requestedItems", "results", "location", "locationSelectionBasis", "summary",
    "capabilities", "serverReceiptPersisted",
  ];
  if (!snapshot || !exactKeys(snapshot, required)) return null;
  if (
    snapshot.schemaVersion !== COMPARISON_SESSION_SCHEMA_VERSION
    || typeof snapshot.comparisonId !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/.test(snapshot.comparisonId)
    || snapshot.retailer !== "kroger"
    || !text(snapshot.retailerChain, 80)
    || !text(snapshot.retailerBanner, 80)
    || typeof snapshot.locationId !== "string"
    || !/^[A-Za-z0-9_-]{1,64}$/.test(snapshot.locationId)
    || !text(snapshot.locationName, 160)
    || !text(snapshot.locationAddress, 500)
    || snapshot.zipCode !== zipCode
    || !/^\d{5}$/.test(zipCode)
    || snapshot.fulfillmentMode !== "pickup"
    || !isoDate(snapshot.checkedAt)
    || !isoDate(snapshot.createdAt)
    || !["KROGER_PROVIDER_ORDER", "PINNED_REVALIDATION"].includes(String(snapshot.locationSelectionBasis))
    || typeof snapshot.serverReceiptPersisted !== "boolean"
    || !validLocation(snapshot.location)
    || !validCapabilities(snapshot.capabilities)
  ) return null;

  const location = snapshot.location as UnknownRecord;
  if (
    snapshot.locationId !== location.locationId
    || snapshot.locationName !== location.name
    || snapshot.retailerChain !== location.chain
    || snapshot.retailerBanner !== krogerRetailerBanner(String(location.chain))
    || snapshot.locationAddress !== locationAddress(location)
  ) return null;

  const interpretedItems = interpretGroceryInput(rawInput).items;
  if (
    !Array.isArray(snapshot.requestedItems)
    || !sameJson(snapshot.requestedItems, interpretedItems)
    || !Array.isArray(snapshot.requestedItemIds)
    || !sameJson(snapshot.requestedItemIds, interpretedItems.map((item) => item.id))
    || !Array.isArray(snapshot.results)
    || snapshot.results.length !== interpretedItems.length
    || !snapshot.results.every((result, index) => (
      validMatchResult(result, interpretedItems[index]!.raw, snapshot.locationId as string)
    ))
    || !Array.isArray(snapshot.basketLines)
    || snapshot.basketLines.length !== interpretedItems.length
  ) return null;

  for (const [index, line] of snapshot.basketLines.entries()) {
    if (!validBasketLine(
      line,
      snapshot.comparisonId,
      snapshot.locationId,
      snapshot.requestedItems[index] as UnknownRecord,
      snapshot.results[index] as UnknownRecord,
    )) return null;
  }

  const summary = record(snapshot.summary);
  if (!summary || !exactKeys(
    summary,
    ["status", "requestedCount", "matchedCount", "matchedSubtotalCents"],
    ["totalCents"],
  )) return null;
  const acceptedLines = (snapshot.basketLines as UnknownRecord[]).filter(
    (line) => line.status === "ACCEPTED",
  );
  const matchedSubtotalCents = acceptedLines.reduce(
    (total, line) => total + Number(line.priceCents) * Number(line.quantity),
    0,
  );
  const complete = acceptedLines.length > 0 && acceptedLines.length === interpretedItems.length;
  const completeness = complete ? BasketCompleteness.COMPLETE : BasketCompleteness.INCOMPLETE;
  if (
    summary.status !== completeness
    || snapshot.completeness !== completeness
    || summary.requestedCount !== interpretedItems.length
    || summary.matchedCount !== acceptedLines.length
    || summary.matchedSubtotalCents !== matchedSubtotalCents
    || (complete ? summary.totalCents !== matchedSubtotalCents : summary.totalCents !== undefined)
  ) return null;

  try {
    assertComparisonStoreInvariant(snapshot as unknown as ComparisonSessionReceipt);
  } catch {
    return null;
  }
  return snapshot;
}
