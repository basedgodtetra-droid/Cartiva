import type { GroceryNotepadItem } from "@/lib/grocery-notepad";
import type { KrogerMatchResult } from "@/lib/types";

export const CARTIVA_LIBRARY_KEY = "cartiva-local-library-v1";

export interface CartivaListSnapshot {
  rawInput: string;
  quantities: Record<string, number>;
  fulfillmentMode: "pickup" | "delivery";
  zipCode: string;
}

export interface CartivaSavedList extends CartivaListSnapshot {
  id: string;
  name: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CartivaSavedProduct {
  requestedItem: string;
  quantity: number;
  retailer: "kroger";
  productId: string;
  upc: string;
  title: string;
  packageLabel: string;
  packageKey: string;
  unitPriceCents: number;
  lineTotalCents: number;
  availabilityStatus: string;
  confidence: "high" | "medium" | "low";
  observedAt: string;
  provenance: {
    dataSource: "kroger_public_api";
    priceSource: "kroger_location_product";
    priceScope: "exact_store";
    priceReliability: "verified";
    exactStoreVerified: true;
    locationId: string;
    fulfillment: Array<"pickup" | "delivery" | "shipping">;
    checkedAt: string;
  };
}

export interface CartivaComparisonRecord {
  id: string;
  listId?: string;
  listName: string;
  listSnapshot: CartivaListSnapshot;
  fingerprint: string;
  retailer: "kroger";
  retailerLabel: string;
  locationId: string;
  locationName: string;
  locationAddress: string;
  fulfillmentMode: "pickup" | "delivery";
  observedAt: string;
  subtotalCents: number;
  matchedCount: number;
  itemCount: number;
  complete: boolean;
  products: CartivaSavedProduct[];
  provenanceLabel: "Official Kroger API · exact selected store";
}

export interface CartivaSavedBasket extends CartivaComparisonRecord {
  savedAt: string;
  historical: true;
}

export interface CartivaBasketObservation {
  id: string;
  comparisonId: string;
  listId?: string;
  listName: string;
  fingerprint: string;
  retailer: "kroger";
  locationId: string;
  locationName: string;
  fulfillmentMode: "pickup" | "delivery";
  observedAt: string;
  subtotalCents: number;
  itemCount: number;
  provenanceLabel: CartivaComparisonRecord["provenanceLabel"];
}

export interface CartivaProductObservation extends CartivaSavedProduct {
  id: string;
  comparisonId: string;
  locationId: string;
  locationName: string;
  fulfillmentMode: "pickup" | "delivery";
}

export type CartivaActivityType = "list_saved" | "comparison_completed" | "basket_saved" | "cart_added";

export interface CartivaActivity {
  id: string;
  type: CartivaActivityType;
  occurredAt: string;
  title: string;
  detail: string;
  href: string;
}

export interface CartivaLibraryState {
  version: 1;
  lists: CartivaSavedList[];
  baskets: CartivaSavedBasket[];
  basketHistory: CartivaBasketObservation[];
  productHistory: CartivaProductObservation[];
  activities: CartivaActivity[];
}

export interface CartivaComparisonRecordInput {
  listId?: string;
  listName: string;
  listSnapshot: CartivaListSnapshot;
  items: GroceryNotepadItem[];
  quantities: Record<string, number>;
  results: KrogerMatchResult[];
  location: {
    locationId: string;
    name: string;
    chain: string;
    address: { addressLine1: string; city?: string; state?: string; zipCode?: string };
  };
  fulfillmentMode: "pickup" | "delivery";
  observedAt: string;
}

const MAX_LISTS = 50;
const MAX_BASKETS = 50;
const MAX_BASKET_HISTORY = 250;
const MAX_PRODUCT_HISTORY = 1_000;
const MAX_ACTIVITIES = 100;

function cleanName(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled list";
}

function cleanString(value: unknown, max = 500) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validQuantity(value: unknown): value is number {
  return positiveInteger(value) && (value as number) <= 99;
}

function integerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validDate(value: unknown) {
  return typeof value === "string" && !Number.isNaN(new Date(value).valueOf());
}

function safeArray<T>(value: unknown, limit: number, guard: (item: unknown) => item is T) {
  return Array.isArray(value) ? value.filter(guard).slice(0, limit) : [];
}

function isSavedList(value: unknown): value is CartivaSavedList {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.rawInput === "string"
    && isRecord(value.quantities)
    && Object.values(value.quantities).every(validQuantity)
    && (value.fulfillmentMode === "pickup" || value.fulfillmentMode === "delivery")
    && typeof value.zipCode === "string"
    && Number.isInteger(value.itemCount)
    && validDate(value.createdAt)
    && validDate(value.updatedAt);
}

function isSavedProduct(value: unknown): value is CartivaSavedProduct {
  if (!isRecord(value) || !isRecord(value.provenance)) return false;
  return value.retailer === "kroger"
    && typeof value.requestedItem === "string"
    && positiveInteger(value.quantity)
    && typeof value.productId === "string"
    && value.productId.length > 0
    && /^\d{8,14}$/.test(String(value.upc))
    && typeof value.title === "string"
    && typeof value.packageLabel === "string"
    && typeof value.packageKey === "string"
    && positiveInteger(value.unitPriceCents)
    && positiveInteger(value.lineTotalCents)
    && validDate(value.observedAt)
    && typeof value.availabilityStatus === "string"
    && ["high", "medium", "low"].includes(String(value.confidence))
    && value.provenance.dataSource === "kroger_public_api"
    && value.provenance.priceSource === "kroger_location_product"
    && value.provenance.priceScope === "exact_store"
    && value.provenance.priceReliability === "verified"
    && value.provenance.exactStoreVerified === true
    && typeof value.provenance.locationId === "string"
    && Array.isArray(value.provenance.fulfillment)
    && value.provenance.fulfillment.every((mode) => ["pickup", "delivery", "shipping"].includes(String(mode)))
    && validDate(value.provenance.checkedAt);
}

function isListSnapshot(value: unknown): value is CartivaListSnapshot {
  return isRecord(value)
    && typeof value.rawInput === "string"
    && value.rawInput.length <= 12_000
    && isRecord(value.quantities)
    && Object.keys(value.quantities).length <= 25
    && Object.values(value.quantities).every(validQuantity)
    && (value.fulfillmentMode === "pickup" || value.fulfillmentMode === "delivery")
    && typeof value.zipCode === "string"
    && (value.zipCode === "" || /^\d{5}$/.test(value.zipCode));
}

function isComparisonRecord(value: unknown): value is CartivaComparisonRecord {
  if (!isRecord(value) || !isListSnapshot(value.listSnapshot)) return false;
  return typeof value.id === "string"
    && typeof value.listName === "string"
    && typeof value.fingerprint === "string"
    && value.retailer === "kroger"
    && typeof value.locationId === "string"
    && typeof value.locationName === "string"
    && typeof value.locationAddress === "string"
    && (value.fulfillmentMode === "pickup" || value.fulfillmentMode === "delivery")
    && validDate(value.observedAt)
    && positiveInteger(value.subtotalCents)
    && integerBetween(value.matchedCount, 0, 25)
    && integerBetween(value.itemCount, 1, 25)
    && typeof value.complete === "boolean"
    && Array.isArray(value.products)
    && value.products.length <= 25
    && value.products.every(isSavedProduct)
    && value.provenanceLabel === "Official Kroger API · exact selected store";
}

function isSavedBasket(value: unknown): value is CartivaSavedBasket {
  return isComparisonRecord(value)
    && isRecord(value)
    && value.historical === true
    && validDate(value.savedAt);
}

function isBasketObservation(value: unknown): value is CartivaBasketObservation {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.comparisonId === "string"
    && typeof value.listName === "string"
    && typeof value.fingerprint === "string"
    && value.retailer === "kroger"
    && typeof value.locationId === "string"
    && typeof value.locationName === "string"
    && (value.fulfillmentMode === "pickup" || value.fulfillmentMode === "delivery")
    && validDate(value.observedAt)
    && positiveInteger(value.subtotalCents)
    && positiveInteger(value.itemCount)
    && value.provenanceLabel === "Official Kroger API · exact selected store";
}

function isProductObservation(value: unknown): value is CartivaProductObservation {
  return isSavedProduct(value)
    && isRecord(value)
    && typeof value.id === "string"
    && typeof value.comparisonId === "string"
    && typeof value.locationId === "string"
    && typeof value.locationName === "string"
    && (value.fulfillmentMode === "pickup" || value.fulfillmentMode === "delivery");
}

function isActivity(value: unknown): value is CartivaActivity {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && ["list_saved", "comparison_completed", "basket_saved", "cart_added"].includes(String(value.type))
    && validDate(value.occurredAt)
    && typeof value.title === "string"
    && typeof value.detail === "string"
    && typeof value.href === "string"
    && /^\/(?:compare|lists|baskets|history)(?:\?[a-z]+=[A-Za-z0-9_%.-]+)?$/.test(value.href);
}

function packageIdentity(product: NonNullable<KrogerMatchResult["recommended"]>) {
  const size = product.size;
  if (!size) return `label:${cleanString(product.title, 200).toLowerCase()}`;
  return [
    size.kind,
    size.baseUnit,
    size.baseAmount,
    size.packCount ?? 1,
    size.perPackageAmount ?? "",
  ].join(":");
}

function hash(value: string) {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function prependUnique<T extends { id: string }>(items: T[], item: T, limit: number) {
  return [item, ...items.filter((candidate) => candidate.id !== item.id)].slice(0, limit);
}

export function emptyCartivaLibrary(): CartivaLibraryState {
  return {
    version: 1,
    lists: [],
    baskets: [],
    basketHistory: [],
    productHistory: [],
    activities: [],
  };
}

export function parseCartivaLibrary(serialized: string | null): CartivaLibraryState {
  if (!serialized) return emptyCartivaLibrary();
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value) || value.version !== 1) return emptyCartivaLibrary();
    return {
      version: 1,
      lists: safeArray(value.lists, MAX_LISTS, isSavedList),
      baskets: safeArray(value.baskets, MAX_BASKETS, isSavedBasket),
      basketHistory: safeArray(value.basketHistory, MAX_BASKET_HISTORY, isBasketObservation),
      productHistory: safeArray(value.productHistory, MAX_PRODUCT_HISTORY, isProductObservation),
      activities: safeArray(value.activities, MAX_ACTIVITIES, isActivity),
    };
  } catch {
    return emptyCartivaLibrary();
  }
}

export function serializeCartivaLibrary(state: CartivaLibraryState) {
  return JSON.stringify(state);
}

export function createLibraryId(prefix: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

export function upsertSavedList(
  state: CartivaLibraryState,
  input: {
    id: string;
    name: string;
    snapshot: CartivaListSnapshot;
    itemCount: number;
    now: string;
  },
) {
  const existing = state.lists.find((list) => list.id === input.id);
  const list: CartivaSavedList = {
    id: input.id,
    name: cleanName(input.name),
    rawInput: cleanString(input.snapshot.rawInput, 12_000),
    quantities: Object.fromEntries(
      Object.entries(input.snapshot.quantities)
        .filter(([, quantity]) => Number.isInteger(quantity) && quantity >= 1 && quantity <= 99)
        .slice(0, 25),
    ),
    fulfillmentMode: input.snapshot.fulfillmentMode,
    zipCode: /^\d{5}$/.test(input.snapshot.zipCode) ? input.snapshot.zipCode : "",
    itemCount: Math.max(0, Math.min(25, Math.floor(input.itemCount))),
    createdAt: existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  const activity: CartivaActivity = {
    id: `activity_list_${list.id}_${hash(input.now)}`,
    type: "list_saved",
    occurredAt: input.now,
    title: existing ? "List updated" : "List saved",
    detail: `${list.name} · ${list.itemCount} ${list.itemCount === 1 ? "item" : "items"}`,
    href: `/compare?list=${encodeURIComponent(list.id)}`,
  };
  return {
    ...state,
    lists: prependUnique(state.lists, list, MAX_LISTS),
    activities: prependUnique(state.activities, activity, MAX_ACTIVITIES),
  };
}

export function renameSavedList(state: CartivaLibraryState, id: string, name: string, now: string) {
  const list = state.lists.find((candidate) => candidate.id === id);
  if (!list) return state;
  return upsertSavedList(state, {
    id,
    name,
    snapshot: list,
    itemCount: list.itemCount,
    now,
  });
}

export function duplicateSavedList(
  state: CartivaLibraryState,
  sourceId: string,
  duplicateId: string,
  now: string,
) {
  const source = state.lists.find((list) => list.id === sourceId);
  if (!source) return state;
  return upsertSavedList(state, {
    id: duplicateId,
    name: `${source.name} copy`,
    snapshot: source,
    itemCount: source.itemCount,
    now,
  });
}

export function deleteSavedList(state: CartivaLibraryState, id: string) {
  return { ...state, lists: state.lists.filter((list) => list.id !== id) };
}

export function buildCartivaComparisonRecord(
  input: CartivaComparisonRecordInput,
): CartivaComparisonRecord | null {
  const observedAt = new Date(input.observedAt);
  if (
    Number.isNaN(observedAt.valueOf())
    || !input.items.length
    || !input.location.locationId.trim()
  ) return null;

  const products = input.results.flatMap((result, index): CartivaSavedProduct[] => {
    const product = result.status === "matched" ? result.recommended : null;
    const provenance = product?.priceProvenance;
    const authoritativePriceCents = product?.priceCents;
    if (
      !product
      || product.dataSource !== "kroger_public_api"
      || !provenance
      || provenance.priceSource !== "kroger_location_product"
      || provenance.priceScope !== "exact_store"
      || provenance.priceReliability !== "verified"
      || provenance.exactStoreVerified !== true
      || provenance.location.responseProvesLocation !== true
      || provenance.location.storeMatched !== true
      || provenance.location.requestedStoreId !== input.location.locationId
      || provenance.location.observedStoreId !== input.location.locationId
      || provenance.locationId !== input.location.locationId
      || product.identityVerified !== true
      || typeof provenance.checkedAt !== "string"
      || !provenance.fulfillment.includes(input.fulfillmentMode)
      || !Number.isSafeInteger(authoritativePriceCents)
      || (authoritativePriceCents ?? 0) <= 0
      || !/^\d{8,14}$/.test(product.upc)
      || !product.productId.trim()
    ) return [];
    const item = input.items[index];
    if (!item) return [];
    const productObservedAt = new Date(provenance.checkedAt);
    if (Number.isNaN(productObservedAt.valueOf())) return [];
    const requestedQuantity = input.quantities[item.id] ?? 1;
    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 99) return [];
    const quantity = requestedQuantity;
    const unitPriceCents = authoritativePriceCents as number;
    return [{
      requestedItem: item.canonicalText,
      quantity,
      retailer: "kroger",
      productId: product.productId,
      upc: product.upc,
      title: product.title,
      packageLabel: product.size?.label ?? "Package not specified",
      packageKey: packageIdentity(product),
      unitPriceCents,
      lineTotalCents: unitPriceCents * quantity,
      availabilityStatus: product.availabilityStatus,
      confidence: result.confidence,
      observedAt: provenance.checkedAt,
      provenance: {
        dataSource: "kroger_public_api",
        priceSource: "kroger_location_product",
        priceScope: "exact_store",
        priceReliability: "verified",
        exactStoreVerified: true,
        locationId: input.location.locationId,
        fulfillment: [...provenance.fulfillment],
        checkedAt: provenance.checkedAt,
      },
    }];
  });
  if (!products.length) return null;
  const fingerprintSource = [input.fulfillmentMode, ...input.items
    .map((item) => `${item.canonicalText.toLowerCase()}|${input.quantities[item.id] ?? 1}`)
    .sort()]
    .join("\n");
  const fingerprint = `basket_${hash(fingerprintSource)}`;
  const evidenceFingerprint = products
    .map((product) => `${product.upc}|${product.packageKey}|${product.unitPriceCents}|${product.observedAt}`)
    .sort()
    .join("\n");
  const id = `comparison_${hash(`${input.location.locationId}|${fingerprint}|${evidenceFingerprint}`)}`;
  return {
    id,
    listId: input.listId,
    listName: cleanName(input.listName),
    listSnapshot: {
      rawInput: input.listSnapshot.rawInput,
      quantities: { ...input.listSnapshot.quantities },
      fulfillmentMode: input.listSnapshot.fulfillmentMode,
      zipCode: input.listSnapshot.zipCode,
    },
    fingerprint,
    retailer: "kroger",
    retailerLabel: input.location.chain,
    locationId: input.location.locationId,
    locationName: input.location.name,
    locationAddress: [
      input.location.address.addressLine1,
      [input.location.address.city, input.location.address.state].filter(Boolean).join(", "),
      input.location.address.zipCode,
    ].filter(Boolean).join(" · "),
    fulfillmentMode: input.fulfillmentMode,
    observedAt: input.observedAt,
    subtotalCents: products.reduce((sum, product) => sum + product.lineTotalCents, 0),
    matchedCount: products.length,
    itemCount: input.items.length,
    complete: input.results.length === input.items.length && products.length === input.items.length,
    products,
    provenanceLabel: "Official Kroger API · exact selected store",
  };
}

export function recordComparison(
  state: CartivaLibraryState,
  comparison: CartivaComparisonRecord,
) {
  let productHistory = state.productHistory;
  for (const product of comparison.products) {
    const observation: CartivaProductObservation = {
      ...product,
      id: `product_${hash(`${comparison.locationId}|${comparison.fulfillmentMode}|${product.upc}|${product.packageKey}|${product.unitPriceCents}|${product.observedAt}`)}`,
      comparisonId: comparison.id,
      locationId: comparison.locationId,
      locationName: comparison.locationName,
      fulfillmentMode: comparison.fulfillmentMode,
    };
    productHistory = prependUnique(productHistory, observation, MAX_PRODUCT_HISTORY);
  }

  let basketHistory = state.basketHistory;
  if (comparison.complete) {
    const basketObservation: CartivaBasketObservation = {
      id: `basket_observation_${comparison.id}`,
      comparisonId: comparison.id,
      listId: comparison.listId,
      listName: comparison.listName,
      fingerprint: comparison.fingerprint,
      retailer: "kroger",
      locationId: comparison.locationId,
      locationName: comparison.locationName,
      fulfillmentMode: comparison.fulfillmentMode,
      observedAt: comparison.observedAt,
      subtotalCents: comparison.subtotalCents,
      itemCount: comparison.itemCount,
      provenanceLabel: comparison.provenanceLabel,
    };
    basketHistory = prependUnique(basketHistory, basketObservation, MAX_BASKET_HISTORY);
  }

  const activity: CartivaActivity = {
    id: `activity_comparison_${comparison.id}`,
    type: "comparison_completed",
    occurredAt: comparison.observedAt,
    title: comparison.complete ? "Basket compared" : "Products checked",
    detail: comparison.complete
      ? `${comparison.listName} · ${comparison.retailerLabel} · ${money(comparison.subtotalCents)}`
      : `${comparison.matchedCount} of ${comparison.itemCount} verified products`,
    href: "/history",
  };
  return {
    ...state,
    basketHistory,
    productHistory,
    activities: prependUnique(state.activities, activity, MAX_ACTIVITIES),
  };
}

export function saveHistoricalBasket(
  state: CartivaLibraryState,
  comparison: CartivaComparisonRecord,
  savedAt: string,
) {
  if (!comparison.complete) return state;
  const basket: CartivaSavedBasket = { ...comparison, savedAt, historical: true };
  const activity: CartivaActivity = {
    id: `activity_saved_basket_${comparison.id}`,
    type: "basket_saved",
    occurredAt: savedAt,
    title: "Basket saved",
    detail: `${comparison.retailerLabel} · ${comparison.listName} · ${money(comparison.subtotalCents)}`,
    href: "/baskets",
  };
  return {
    ...state,
    baskets: prependUnique(state.baskets, basket, MAX_BASKETS),
    activities: prependUnique(state.activities, activity, MAX_ACTIVITIES),
  };
}

export function deleteSavedBasket(state: CartivaLibraryState, id: string) {
  return { ...state, baskets: state.baskets.filter((basket) => basket.id !== id) };
}

export function recordCartAdded(
  state: CartivaLibraryState,
  input: { comparisonId: string; itemCount: number; retailerLabel: string; occurredAt: string },
) {
  const activity: CartivaActivity = {
    id: `activity_cart_${input.comparisonId}`,
    type: "cart_added",
    occurredAt: input.occurredAt,
    title: `${input.retailerLabel} basket added`,
    detail: `${input.itemCount} ${input.itemCount === 1 ? "item" : "items"} · checkout stays with the retailer`,
    href: "/baskets",
  };
  return { ...state, activities: prependUnique(state.activities, activity, MAX_ACTIVITIES) };
}

export function money(valueInCents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(valueInCents / 100);
}
