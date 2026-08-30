import {
  assertLoopbackBackend,
  CartivaBackendClient,
  CartivaComparisonClient,
  KrogerCartError,
} from "./backend-client.js";
import {
  COMPARISON_RETAILERS,
  comparisonContextSignature,
  comparisonListSignature,
  comparisonRetailerContextSignature,
  emptyComparisonSearchState,
  evaluateComparison,
} from "./comparison.js";
import type { ComparisonRetailerContext } from "./comparison.js";
import {
  AUTO_COMPARE_ZIP_DEBOUNCE_MS,
  automaticComparisonDelay,
  automaticComparisonKey,
  automaticRetailerReady,
  automaticallySelectedStore,
  shouldStartAutomaticComparison,
} from "./auto-comparison.js";
import {
  blockingCartBuild,
  cartBuildForDisplay,
  cartProgress,
  claimAutomaticCartBuild,
} from "./cart-state.js";
import { dataStatusFor } from "./data-status.js";
import {
  activeListFragment,
  canLookupWalmartSuggestions,
  conciseSuggestionMetadata,
  grocerySuggestionTextUpdate,
  grocerySuggestionQuery,
  WALMART_PRODUCT_LOOKUP_DEBOUNCE_MS,
  walmartProductSuggestions,
} from "./grocery-autocomplete.js";
import type { GrocerySuggestion } from "./grocery-autocomplete.js";
import type { BackgroundRequest, RuntimeBroadcast } from "./messages.js";
import {
  extractExplicitRequestDetails,
  normalizeListItem,
  parseShoppingList,
} from "./parser.js";
import { chromeStorageArea, JsonStateStore } from "./storage.js";
import {
  isWalmartStoreOption,
  normalizePickupZip,
  settingsWithSelectedStore,
  storeNameForDisplay,
} from "./store-picker.js";
import {
  formatCurrency,
  isBuildEligible,
  isFreshVerification,
  isKrogerBuildEligible,
  isReliableTargetMatch,
  isTargetBuildEligible,
  isValidTargetProductUrl,
  isValidKrogerProductUrl,
  isValidWalmartProductUrl,
  targetEstimateSubtotalCents,
  krogerSubtotalCents,
  usesLocalizedWalmartPrice,
  verifiedSubtotalCents,
} from "./totals.js";
import { DEFAULT_BACKEND_URL, restoredBackendBaseUrl } from "./sidepanel-settings.js";
import { RESULT_STATUS_LABELS, resultDisplayStatus, resultStatusLabel } from "./result-presentation.js";
import { canonicalKrogerCartItems, krogerCartOperationId } from "./kroger-cart.js";
import { isTrustedKrogerCartUrl } from "./kroger-hosts.js";
import type {
  CartBuildItem,
  CartBuildState,
  ComparisonRetailerState,
  ComparisonSearchState,
  ExtensionAppState,
  ExtensionProduct,
  FulfillmentMode,
  ParsedListItem,
  PreferredProductSelection,
  PreparedItem,
  Retailer,
  KrogerStoreOption,
  KrogerStoreLookupResult,
  WalmartPageContext,
  WalmartNearbyStoreResult,
  WalmartStoreApplyResult,
  WalmartStoreLookupResult,
  WalmartStoreOption,
} from "./types.js";

const APP_STORAGE_KEY = "cartiva.appState.v1";
const defaultPageContext = (): WalmartPageContext => ({
  onWalmart: false,
  fulfillmentMode: "unknown",
});

const defaultAppState = (): ExtensionAppState => ({
  version: 1,
  shoppingMode: "compare",
  listText: "",
  parsedItems: [],
  preparedItems: [],
  preferredProducts: {},
  pageContext: defaultPageContext(),
  settings: {
    backendBaseUrl: DEFAULT_BACKEND_URL,
    retailer: "walmart",
    fulfillmentModeOverride: "delivery",
    targetFulfillmentMode: "delivery",
    krogerFulfillmentMode: "delivery",
  },
});

const appStore = new JsonStateStore<ExtensionAppState>(
  chromeStorageArea(chrome.storage.local),
  APP_STORAGE_KEY,
  defaultAppState,
);

const backendClient = new CartivaBackendClient();
const comparisonClient = new CartivaComparisonClient();
let state = defaultAppState();
let cartBuild: CartBuildState | null = null;
let preparing = false;
let prepareSequence = 0;
let buildStartPending = false;
let nextAutomaticCartBuildActionId = 0;
let lastHandledAutomaticCartBuildActionId = 0;
let automaticCartBuildRetryAvailable = false;
let persistenceQueue: Promise<unknown> = Promise.resolve();
let toastTimer: number | undefined;
let storeLookupController: AbortController | undefined;
let storeLookupPending = false;
let storeLookupResults: WalmartStoreOption[] = [];
let krogerStoreLookupResults: KrogerStoreOption[] = [];
let storeLookupMessage = "Enter a 5-digit ZIP to find pickup stores.";
let storePickerInitialized = false;
let storeFinderTabId: number | undefined;
let visibleGrocerySuggestions: GrocerySuggestion[] = [];
let activeGrocerySuggestion = -1;
let grocerySuggestionTimer: number | undefined;
let grocerySuggestionController: AbortController | undefined;
let grocerySuggestionSequence = 0;
let grocerySuggestionLookupKey: string | undefined;
let krogerOAuthConnected = false;
let krogerOAuthChecking = false;
let krogerCartPending = false;
let krogerCartUrl = "https://www.kroger.com/cart";
let krogerConnectionPoll: number | undefined;
let comparisonLookupPending = false;
let comparisonLookupMessage = "Enter one ZIP. Cartiva automatically selects store contexts for you.";
let comparisonEditingStores = false;
let comparisonZipLookupTimer: number | undefined;
let comparisonAutoPrepareTimer: number | undefined;
let activeComparisonLookupZip: string | undefined;
let lastCompletedComparisonLookupZip: string | undefined;
let comparisonLookupRetryAvailable = false;
let automaticComparisonInFlightKey: string | undefined;
let lastAutomaticComparisonStartedAt = 0;

function byId<T extends HTMLElement>(id: string) {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing side-panel element #${id}.`);
  return value as T;
}

const elements = {
  dataStatus: byId<HTMLSpanElement>("data-status"),
  locationStep: byId<HTMLElement>("location-step"),
  comparisonSetup: byId<HTMLElement>("comparison-setup"),
  comparisonZip: byId<HTMLInputElement>("comparison-zip"),
  comparisonLookupStatus: byId<HTMLElement>("comparison-lookup-status"),
  comparisonRetryLookup: byId<HTMLButtonElement>("comparison-retry-lookup"),
  comparisonWalmartStatus: byId<HTMLElement>("comparison-walmart-status"),
  comparisonTargetStatus: byId<HTMLElement>("comparison-target-status"),
  comparisonKrogerStatus: byId<HTMLElement>("comparison-kroger-status"),
  comparisonWalmartDetail: byId<HTMLElement>("comparison-walmart-detail"),
  comparisonTargetDetail: byId<HTMLElement>("comparison-target-detail"),
  comparisonKrogerDetail: byId<HTMLElement>("comparison-kroger-detail"),
  comparisonReadyHeading: byId<HTMLElement>("comparison-ready-heading"),
  comparisonReadyCopy: byId<HTMLElement>("comparison-ready-copy"),
  listStep: byId<HTMLElement>("list-step"),
  flowLocationIndicator: byId<HTMLElement>("flow-location-indicator"),
  flowListIndicator: byId<HTMLElement>("flow-list-indicator"),
  flowResultsIndicator: byId<HTMLElement>("flow-results-indicator"),
  flowLocationLabel: byId<HTMLElement>("flow-location-label"),
  flowResultsLabel: byId<HTMLElement>("flow-results-label"),
  locationStepHeading: byId<HTMLElement>("location-step-heading"),
  locationStepCopy: byId<HTMLElement>("location-step-copy"),
  locationHeading: byId<HTMLElement>("location-heading"),
  locationName: byId<HTMLElement>("location-name"),
  locationDetail: byId<HTMLElement>("location-detail"),
  pageStatusPill: byId<HTMLSpanElement>("page-status-pill"),
  fulfillmentPill: byId<HTMLSpanElement>("fulfillment-pill"),
  offWalmartNotice: byId<HTMLElement>("off-walmart-notice"),
  krogerConnection: byId<HTMLElement>("kroger-connection"),
  krogerConnectionHeading: byId<HTMLElement>("kroger-connection-heading"),
  krogerConnectionCopy: byId<HTMLElement>("kroger-connection-copy"),
  connectKroger: byId<HTMLButtonElement>("connect-kroger"),
  refreshContext: byId<HTMLButtonElement>("refresh-context"),
  openWalmart: byId<HTMLButtonElement>("open-walmart"),
  storePicker: byId<HTMLDetailsElement>("store-picker"),
  storePickerHeading: byId<HTMLElement>("store-picker-heading"),
  storePickerDescription: byId<HTMLElement>("store-picker-description"),
  pickupZip: byId<HTMLInputElement>("pickup-zip"),
  findStores: byId<HTMLButtonElement>("find-stores"),
  storeLookupStatus: byId<HTMLElement>("store-lookup-status"),
  storeOptions: byId<HTMLElement>("store-options"),
  fulfillmentMode: byId<HTMLSelectElement>("fulfillment-mode"),
  fulfillmentSummary: byId<HTMLElement>("fulfillment-summary"),
  fulfillmentHelp: byId<HTMLElement>("fulfillment-help"),
  applyContext: byId<HTMLButtonElement>("apply-context"),
  targetStoreField: byId<HTMLElement>("target-store-field"),
  targetStoreId: byId<HTMLInputElement>("target-store-id"),
  shoppingList: byId<HTMLTextAreaElement>("shopping-list"),
  listStepCopy: byId<HTMLElement>("list-step-copy"),
  listHelp: byId<HTMLElement>("list-help"),
  voiceInput: byId<HTMLButtonElement>("voice-input"),
  grocerySuggestions: byId<HTMLElement>("grocery-suggestions"),
  parsePreview: byId<HTMLElement>("parse-preview"),
  parseSummary: byId<HTMLElement>("parse-summary"),
  parsePreviewList: byId<HTMLUListElement>("parse-preview-list"),
  entryError: byId<HTMLElement>("entry-error"),
  prepareList: byId<HTMLButtonElement>("prepare-list"),
  prepareButtonLabel: document.querySelector<HTMLSpanElement>("#prepare-list .button-label")!,
  resultsSection: byId<HTMLElement>("results-section"),
  comparisonResultsSection: byId<HTMLElement>("comparison-results-section"),
  comparisonResultsHeading: byId<HTMLElement>("comparison-results-heading"),
  comparisonProgress: byId<HTMLElement>("comparison-progress"),
  comparisonProgressLabel: byId<HTMLElement>("comparison-progress-label"),
  comparisonProgressCount: byId<HTMLElement>("comparison-progress-count"),
  comparisonBaskets: byId<HTMLElement>("comparison-baskets"),
  comparisonOutcomeHeading: byId<HTMLElement>("comparison-outcome-heading"),
  comparisonOutcomeCopy: byId<HTMLElement>("comparison-outcome-copy"),
  comparisonEditStores: byId<HTMLButtonElement>("comparison-edit-stores"),
  resultsEyebrow: byId<HTMLElement>("results-eyebrow"),
  resultsHeading: byId<HTMLElement>("results-heading"),
  prepareAgain: byId<HTMLButtonElement>("prepare-again"),
  verifiedSubtotal: byId<HTMLElement>("verified-subtotal"),
  subtotalLabel: byId<HTMLElement>("subtotal-label"),
  subtotalNote: byId<HTMLElement>("subtotal-note"),
  requestedCount: byId<HTMLElement>("requested-count"),
  matchedCount: byId<HTMLElement>("matched-count"),
  reviewCount: byId<HTMLElement>("review-count"),
  searchProgress: byId<HTMLElement>("search-progress"),
  searchProgressLabel: byId<HTMLElement>("search-progress-label"),
  searchProgressCount: byId<HTMLElement>("search-progress-count"),
  resultList: byId<HTMLElement>("result-list"),
  buildEligibilityNote: byId<HTMLElement>("build-eligibility-note"),
  buildEligibilityHeading: byId<HTMLElement>("build-eligibility-heading"),
  buildCart: byId<HTMLButtonElement>("build-cart"),
  cartProgressSection: byId<HTMLElement>("cart-progress-section"),
  cartProgressHeading: byId<HTMLElement>("cart-progress-heading"),
  cartBuildStatus: byId<HTMLElement>("cart-build-status"),
  cartProgressBar: byId<HTMLElement>("cart-progress-bar"),
  cartProgressText: byId<HTMLElement>("cart-progress-text"),
  cartPauseNotice: byId<HTMLElement>("cart-pause-notice"),
  cartPauseHeading: byId<HTMLElement>("cart-pause-heading"),
  cartPauseReason: byId<HTMLElement>("cart-pause-reason"),
  cartProgressList: byId<HTMLOListElement>("cart-progress-list"),
  resumeCart: byId<HTMLButtonElement>("resume-cart"),
  cancelCart: byId<HTMLButtonElement>("cancel-cart"),
  reviewCart: byId<HTMLButtonElement>("review-cart"),
  backendUrl: byId<HTMLInputElement>("backend-url"),
  settingsError: byId<HTMLElement>("settings-error"),
  saveSettings: byId<HTMLButtonElement>("save-settings"),
  extensionBuild: byId<HTMLElement>("extension-build"),
  confirmation: byId<HTMLDialogElement>("cart-confirmation"),
  confirmationTitle: byId<HTMLElement>("confirm-title"),
  confirmationDescription: byId<HTMLElement>("confirm-description"),
  confirmationItemCount: byId<HTMLElement>("confirm-item-count"),
  confirmationSubtotal: byId<HTMLElement>("confirm-subtotal"),
  cancelConfirmation: byId<HTMLButtonElement>("cancel-confirmation"),
  confirmCartBuild: byId<HTMLButtonElement>("confirm-cart-build"),
  toast: byId<HTMLElement>("toast"),
};

function copyState(value: ExtensionAppState) {
  return JSON.parse(JSON.stringify(value)) as ExtensionAppState;
}

function persistState() {
  const snapshot = copyState(state);
  persistenceQueue = persistenceQueue
    .catch(() => undefined)
    .then(() => appStore.save(snapshot));
  return persistenceQueue;
}

function showError(element: HTMLElement, message?: string) {
  element.textContent = message ?? "";
  element.hidden = !message;
}

function showToast(message: string) {
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
    toastTimer = undefined;
  }, 4_000);
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatTime(value?: string) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function normalizeBackendUrl(value: string) {
  const url = new URL(value.trim());
  assertLoopbackBackend(url.href);
  return url.origin;
}

function safeWalmartProductLink(product: ExtensionProduct) {
  try {
    const url = new URL(product.link);
    const walmartHost = url.hostname === "www.walmart.com" || url.hostname === "walmart.com";
    if (url.protocol !== "https:" || !walmartHost || url.username || url.password || url.port) {
      return undefined;
    }
    if (product.linkType === "product") {
      return isValidWalmartProductUrl(url.toString(), product.itemId) ? url.toString() : undefined;
    }
    return product.linkType === "search" && url.pathname === "/search" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function safeTargetProductLink(product: ExtensionProduct) {
  return isValidTargetProductUrl(product.link, product.productId) ? product.link : undefined;
}

function safeKrogerProductLink(product: ExtensionProduct) {
  return isValidKrogerProductUrl(product.link) ? product.link : undefined;
}

function effectiveRetailer(): Retailer {
  return state.settings.retailer === "target" || state.settings.retailer === "kroger"
    ? state.settings.retailer
    : "walmart";
}

function isComparisonMode() {
  return state.shoppingMode === "compare";
}

function comparisonContexts(): Record<Retailer, ComparisonRetailerContext> {
  const walmartStore = state.settings.selectedStore;
  const krogerStore = state.settings.krogerStore;
  return {
    walmart: { fulfillmentMode: "delivery", storeId: walmartStore?.id, zip: state.settings.targetZip },
    // Target comparison is ZIP-localized until an exact-store API contract is
    // available. Never carry a stale manually entered store ID into this mode.
    target: { fulfillmentMode: "delivery", zip: state.settings.targetZip },
    kroger: { fulfillmentMode: "delivery", storeId: krogerStore?.id, zip: state.settings.targetZip },
  };
}

function comparisonRetailerReady(retailer: Retailer) {
  return automaticRetailerReady(retailer, comparisonContexts()[retailer]);
}

function configuredComparisonRetailers() {
  return COMPARISON_RETAILERS.filter(comparisonRetailerReady);
}

function retailerName(retailer: Retailer = effectiveRetailer()) {
  if (retailer === "target") return "Target";
  if (retailer === "kroger") return state.settings.krogerStore?.chain || "Kroger";
  return "Walmart";
}

function effectiveFulfillmentMode(): FulfillmentMode {
  if (effectiveRetailer() === "target") {
    return state.settings.targetFulfillmentMode ?? "delivery";
  }
  if (effectiveRetailer() === "kroger") {
    return state.settings.krogerFulfillmentMode ?? "pickup";
  }
  return state.settings.fulfillmentModeOverride ?? state.pageContext.fulfillmentMode;
}

function detectedStore(): WalmartStoreOption | undefined {
  const context = state.pageContext;
  if (!/^\d{1,8}$/.test(context.storeId ?? "") || !/^\d{5}$/.test(context.zip ?? "")) {
    return undefined;
  }
  return {
    id: context.storeId!,
    name: storeNameForDisplay(context.storeName),
    address: context.address?.trim() || `Walmart location in ZIP ${context.zip}`,
    zip: context.zip!,
  };
}

function effectiveStore() {
  if (effectiveRetailer() === "target") return undefined;
  if (effectiveRetailer() === "kroger") return state.settings.krogerStore;
  return state.settings.selectedStore ?? detectedStore();
}

function recoveryStoreFor(build: CartBuildState) {
  const selected = state.settings.selectedStore;
  if (selected?.id === build.storeId) return selected;
  const candidate: WalmartStoreOption = {
    id: build.storeId ?? "",
    name: build.storeName?.trim() || "Walmart pickup store",
    address: build.storeAddress?.trim() || "",
    zip: build.zip ?? "",
  };
  return isWalmartStoreOption(candidate) ? candidate : undefined;
}

function effectiveStoreId() {
  if (effectiveRetailer() === "target") return state.settings.targetStoreId;
  return effectiveStore()?.id;
}

function effectiveZip() {
  if (effectiveRetailer() === "target") return state.settings.targetZip;
  if (effectiveRetailer() === "kroger") return state.settings.krogerZip ?? state.settings.krogerStore?.zip;
  return effectiveStore()?.zip;
}

function hasShoppingContext() {
  if (isComparisonMode()) return configuredComparisonRetailers().length >= 2;
  if (effectiveRetailer() === "walmart") return Boolean(effectiveStore());
  if (effectiveRetailer() === "kroger") return Boolean(state.settings.krogerStore)
    && ["pickup", "delivery"].includes(effectiveFulfillmentMode());
  const mode = effectiveFulfillmentMode();
  const hasZip = /^\d{5}$/.test(effectiveZip() ?? "");
  return mode === "pickup"
    ? hasZip && /^\d{3,4}$/.test(effectiveStoreId() ?? "")
    : hasZip && (mode === "delivery" || mode === "shipping");
}

function strictlyEligible(item: PreparedItem, nowMs = Date.now()) {
  if (effectiveRetailer() !== "walmart" || item.retailer === "target") return false;
  return isBuildEligible(
    item,
    effectiveFulfillmentMode(),
    nowMs,
    effectiveStoreId(),
  );
}

function cartEligibleMatch(item: PreparedItem, nowMs = Date.now()) {
  if (effectiveRetailer() === "kroger") {
    return isKrogerBuildEligible(item, effectiveFulfillmentMode(), nowMs, effectiveStoreId());
  }
  return effectiveRetailer() === "target"
    ? isTargetBuildEligible(item, effectiveFulfillmentMode(), nowMs)
    : strictlyEligible(item, nowMs);
}

function reliableDisplayMatch(item: PreparedItem, nowMs = Date.now()) {
  if (effectiveRetailer() === "kroger") {
    return isKrogerBuildEligible(item, effectiveFulfillmentMode(), nowMs, effectiveStoreId());
  }
  return effectiveRetailer() === "target"
    ? isReliableTargetMatch(item, effectiveFulfillmentMode(), nowMs)
    : strictlyEligible(item, nowMs);
}

function shoppingContextKey() {
  if (isComparisonMode()) return comparisonContextSignature(comparisonContexts());
  const store = effectiveStore();
  return [
    effectiveRetailer(),
    store?.id ?? "no-store",
    effectiveZip() ?? store?.zip ?? "",
    effectiveFulfillmentMode(),
  ].join("::");
}

function invalidatePreparedItems(message: string, clear = false) {
  if (!state.preparedItems.length) return;
  state.lastPreparedAt = new Date().toISOString();
  if (clear) {
    state.parsedItems = [];
    state.preparedItems = [];
    return;
  }
  state.preparedItems = state.preparedItems.map((item) => ({
    ...item,
    matchStatus: "needs_review",
    cartStatus: "needs_choice",
    explanation: message,
  }));
}

function relevantCartBuild() {
  if (!cartBuild) return null;
  const buildRetailer = cartBuild.retailer === "target" ? "target" : "walmart";
  if (buildRetailer !== effectiveRetailer()) return null;
  if (!state.lastPreparedAt || !cartBuild.startedAt) return cartBuild;
  return new Date(cartBuild.startedAt).getTime() >= new Date(state.lastPreparedAt).getTime()
    ? cartBuild
    : null;
}

function displayCartBuild() {
  return cartBuildForDisplay(relevantCartBuild(), state.lastPreparedAt);
}

function selectRetailer(retailer: Retailer) {
  if (retailer === effectiveRetailer() && !isComparisonMode()) return;
  if (krogerConnectionPoll !== undefined) {
    window.clearInterval(krogerConnectionPoll);
    krogerConnectionPoll = undefined;
  }
  cancelGrocerySuggestionLookup();
  cancelActivePreparation();
  comparisonClient.cancel();
  state.shoppingMode = "retailer";
  state.settings.retailer = retailer;
  if (retailer === "target") {
    state.settings.targetFulfillmentMode ??= "delivery";
  } else if (retailer === "kroger") {
    state.settings.krogerFulfillmentMode ??= "pickup";
  }
  state.preparedItems = [];
  state.parsedItems = [];
  state.preferredProducts = {};
  state.lastPreparedAt = undefined;
  automaticCartBuildRetryAvailable = false;
  storeLookupMessage = retailer === "target"
    ? "Enter a ZIP to localize Target delivery or shipping estimates."
    : retailer === "kroger"
      ? "Enter a ZIP to find an official Kroger-family store."
    : "Enter a 5-digit ZIP to find pickup stores.";
  void persistState();
  renderParsePreview();
  renderAll();
  document.querySelector<HTMLElement>("#location-step")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function sendBackground<T>(message: BackgroundRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage<T | { error: string }>(message);
  if (response && typeof response === "object" && "error" in response) {
    throw new Error(response.error);
  }
  return response as T;
}

function renderParsePreview() {
  const parsed = parseShoppingList(elements.shoppingList.value);
  elements.parsePreview.hidden = parsed.length === 0;
  elements.parseSummary.textContent = `${parsed.length} ${parsed.length === 1 ? "item" : "items"} recognized`;
  elements.parsePreviewList.replaceChildren();
  const visibleItems = parsed.slice(0, 5);
  for (const item of visibleItems) {
    const entry = document.createElement("li");
    const itemText = `${item.quantity > 1 ? `${item.quantity} × ` : ""}${item.text}`;
    entry.append(document.createTextNode(itemText));
    entry.title = itemText;
    const preferred = isComparisonMode() ? undefined : state.preferredProducts[item.normalizedText];
    if (preferred) {
      entry.classList.add("has-preferred-product");
      const cue = createTextElement(
        "small",
        "preferred-product-cue",
        `Selected at Walmart: ${preferred.preferredTitle}`,
      );
      cue.title = preferred.preferredTitle;
      entry.append(cue);
    }
    elements.parsePreviewList.append(entry);
  }
  if (parsed.length > visibleItems.length) {
    const remaining = document.createElement("li");
    remaining.textContent = `+${parsed.length - visibleItems.length} more`;
    elements.parsePreviewList.append(remaining);
  }
}

function parseListWithPreferredProducts(value: string) {
  return parseShoppingList(value).map((item) => {
    const preferred = state.preferredProducts[item.normalizedText];
    return preferred ? { ...item, ...preferred } : item;
  });
}

function comparisonParsedItems() {
  return parseShoppingList(elements.shoppingList.value);
}

function retainPreferredProductsForList(value: string) {
  const activeKeys = new Set(parseShoppingList(value).map((item) => item.normalizedText));
  state.preferredProducts = Object.fromEntries(
    Object.entries(state.preferredProducts).filter(([key]) => activeKeys.has(key)),
  );
}

function cancelGrocerySuggestionLookup() {
  grocerySuggestionSequence += 1;
  if (grocerySuggestionTimer !== undefined) window.clearTimeout(grocerySuggestionTimer);
  grocerySuggestionTimer = undefined;
  grocerySuggestionController?.abort();
  grocerySuggestionController = undefined;
  grocerySuggestionLookupKey = undefined;
}

function hideGrocerySuggestions() {
  cancelGrocerySuggestionLookup();
  visibleGrocerySuggestions = [];
  activeGrocerySuggestion = -1;
  elements.grocerySuggestions.hidden = true;
  elements.grocerySuggestions.replaceChildren();
  elements.grocerySuggestions.setAttribute("aria-busy", "false");
  elements.shoppingList.setAttribute("aria-expanded", "false");
  elements.shoppingList.removeAttribute("aria-activedescendant");
}

function setActiveGrocerySuggestion(index: number) {
  if (!visibleGrocerySuggestions.length) return;
  activeGrocerySuggestion = (index + visibleGrocerySuggestions.length) % visibleGrocerySuggestions.length;
  const options = [...elements.grocerySuggestions.querySelectorAll<HTMLElement>("[role='option']")];
  options.forEach((option, optionIndex) => {
    const active = optionIndex === activeGrocerySuggestion;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-selected", String(active));
    if (active) {
      elements.shoppingList.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

function applyGrocerySuggestion(index: number) {
  const selected = visibleGrocerySuggestions[index];
  if (!selected) return;
  const fragment = activeListFragment(
    elements.shoppingList.value,
    elements.shoppingList.selectionStart ?? elements.shoppingList.value.length,
  );
  if (selected.source === "walmart" && (selected.productId || selected.itemId)) {
    const preferredTitle = selected.exactTitle ?? selected.value;
    const parsedFragment = parseShoppingList(fragment.text);
    const requestKey = parsedFragment.length === 1
      ? parsedFragment[0].normalizedText
      : normalizeListItem(grocerySuggestionQuery(fragment.text).query);
    state.preferredProducts[requestKey] = {
      preferredProductId: selected.productId,
      preferredItemId: selected.itemId,
      preferredTitle,
    };
    hideGrocerySuggestions();
    elements.shoppingList.focus();
    renderParsePreview();
    void persistState();
    showToast(`Selected from Walmart: ${preferredTitle}`);
    return;
  }
  const replacement = grocerySuggestionTextUpdate(elements.shoppingList.value, fragment, selected);
  // Cancel the old fragment lookup before dispatching input. The input event
  // then starts a fresh Walmart lookup for the completed concrete product.
  hideGrocerySuggestions();
  elements.shoppingList.value = replacement.value;
  elements.shoppingList.setSelectionRange(replacement.caret, replacement.caret);
  elements.shoppingList.dispatchEvent(new Event("input", { bubbles: true }));
  elements.shoppingList.setSelectionRange(replacement.caret, replacement.caret);
  elements.shoppingList.focus();
}

function showGrocerySuggestions(
  products: GrocerySuggestion[],
  notice?: { kind: "checking" | "info"; text: string },
  productGroupLabel = "Walmart products",
) {
  visibleGrocerySuggestions = products;
  activeGrocerySuggestion = -1;
  elements.grocerySuggestions.replaceChildren();
  elements.shoppingList.removeAttribute("aria-activedescendant");
  if (!visibleGrocerySuggestions.length && !notice) {
    elements.grocerySuggestions.hidden = true;
    elements.grocerySuggestions.setAttribute("aria-busy", "false");
    elements.shoppingList.setAttribute("aria-expanded", "false");
    elements.shoppingList.removeAttribute("aria-activedescendant");
    return;
  }

  const appendGroup = (
    label: string,
    items: GrocerySuggestion[],
    startIndex: number,
  ) => {
    if (!items.length) return;
    const group = document.createElement("div");
    group.className = "grocery-suggestion-group";
    group.setAttribute("role", "group");
    const heading = createTextElement("div", "grocery-suggestion-heading", label);
    heading.id = `grocery-suggestion-${startIndex}-heading`;
    group.setAttribute("aria-labelledby", heading.id);
    group.append(heading);

    items.forEach((item, itemIndex) => {
      const index = startIndex + itemIndex;
      const option = document.createElement("button");
      option.id = `grocery-suggestion-${index}`;
      option.type = "button";
      option.tabIndex = -1;
      option.className = "grocery-suggestion";
      option.classList.add("is-walmart-product");
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.setAttribute("aria-posinset", String(index + 1));
      option.setAttribute("aria-setsize", String(visibleGrocerySuggestions.length));
      const copy = document.createElement("span");
      copy.className = "grocery-suggestion-copy";
      copy.append(createTextElement("strong", "", item.exactTitle ?? item.value));
      const details = conciseSuggestionMetadata(
        item.brand,
        item.flavor,
        item.format,
        item.packageSize,
      ).join(" · ");
      if (details) copy.append(createTextElement("small", "", details));
      const meta = document.createElement("span");
      meta.className = "grocery-suggestion-meta";
      meta.append(
        createTextElement("em", "", item.category),
        createTextElement("b", "", item.price ? `$${item.price.toFixed(2)}` : ""),
      );
      option.append(copy, meta);
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("click", () => applyGrocerySuggestion(index));
      group.append(option);
    });
    elements.grocerySuggestions.append(group);
  };

  appendGroup(productGroupLabel, products, 0);
  if (notice) {
    const status = document.createElement("div");
    status.className = `grocery-suggestion-notice is-${notice.kind}`;
    status.setAttribute("role", "status");
    if (notice.kind === "checking") status.append(createTextElement("span", "mini-spinner", ""));
    status.append(document.createTextNode(notice.text));
    elements.grocerySuggestions.append(status);
  }
  elements.grocerySuggestions.hidden = false;
  elements.grocerySuggestions.setAttribute("aria-busy", String(notice?.kind === "checking"));
  elements.shoppingList.setAttribute("aria-expanded", "true");
}

function renderGrocerySuggestions() {
  if (isComparisonMode()) {
    hideGrocerySuggestions();
    return;
  }
  if (document.activeElement !== elements.shoppingList) {
    hideGrocerySuggestions();
    return;
  }
  if (effectiveRetailer() !== "walmart") {
    hideGrocerySuggestions();
    return;
  }
  const fragment = activeListFragment(
    elements.shoppingList.value,
    elements.shoppingList.selectionStart ?? elements.shoppingList.value.length,
  );
  const context = grocerySuggestionQuery(fragment.text);

  const storeId = effectiveStoreId();
  const zipCode = effectiveZip();
  const query = context.query.replace(/\s+/g, " ").trim();
  if (!canLookupWalmartSuggestions(query, storeId)) {
    cancelGrocerySuggestionLookup();
    showGrocerySuggestions([]);
    return;
  }

  let backendUrl: string;
  try {
    backendUrl = normalizeBackendUrl(state.settings.backendBaseUrl);
  } catch {
    cancelGrocerySuggestionLookup();
    showGrocerySuggestions([], {
      kind: "info",
      text: "Walmart products are unavailable until Cartiva is connected.",
    });
    return;
  }

  const lookupKey = `${backendUrl}::${storeId}::${zipCode ?? ""}::${query.toLocaleLowerCase("en-US")}`;
  if (
    grocerySuggestionLookupKey === lookupKey
    && (grocerySuggestionTimer !== undefined || grocerySuggestionController)
  ) {
    return;
  }

  cancelGrocerySuggestionLookup();
  grocerySuggestionLookupKey = lookupKey;
  const sequence = ++grocerySuggestionSequence;
  showGrocerySuggestions([], {
    kind: "checking",
    text: "Checking this Walmart…",
  });
  grocerySuggestionTimer = window.setTimeout(async () => {
    grocerySuggestionTimer = undefined;
    const controller = new AbortController();
    grocerySuggestionController = controller;
    try {
      const result = await backendClient.findProductSuggestions(
        query,
        storeId!,
        backendUrl,
        controller.signal,
        zipCode,
      );
      if (sequence !== grocerySuggestionSequence || document.activeElement !== elements.shoppingList) return;
      const currentFragment = activeListFragment(
        elements.shoppingList.value,
        elements.shoppingList.selectionStart ?? elements.shoppingList.value.length,
      );
      if (grocerySuggestionQuery(currentFragment.text).query.replace(/\s+/g, " ").trim() !== query) return;

      const liveSuggestions: GrocerySuggestion[] = result.suggestions.map((item) => ({
        value: `${context.prefix}${item.title}`.replace(/\s+/g, " ").trim(),
        category: result.mode === "live" ? "Live Walmart" : "Demo sample",
        aliases: [],
        kind: "product",
        source: "walmart",
        productId: item.productId,
        itemId: item.itemId,
        exactTitle: item.title,
        brand: item.brand,
        brandSource: item.brandSource,
        flavor: item.flavor,
        format: item.format,
        fulfillment: item.fulfillment,
        price: item.price,
        packageSize: item.packageSize,
      }));
      const products = walmartProductSuggestions(liveSuggestions, 6);
      showGrocerySuggestions(
        products,
        products.length
          ? undefined
          : { kind: "info", text: "No exact products found at this Walmart yet." },
        result.mode === "live" ? "Walmart products" : "Sample products",
      );
    } catch (error) {
      if (!controller.signal.aborted && sequence === grocerySuggestionSequence) {
        showGrocerySuggestions([], {
          kind: "info",
          text: "Walmart products are temporarily unavailable. Keep typing or try again.",
        });
      }
      void error;
    } finally {
      if (grocerySuggestionController === controller) {
        grocerySuggestionController = undefined;
        grocerySuggestionLookupKey = undefined;
      }
    }
  }, WALMART_PRODUCT_LOOKUP_DEBOUNCE_MS);
}

function renderStorePicker() {
  if (effectiveRetailer() === "kroger") {
    const selected = state.settings.krogerStore;
    const hasContext = hasShoppingContext();
    elements.storePickerHeading.textContent = "Find your Kroger-family store";
    elements.storePicker.open = !hasContext || storeLookupPending;
    if (document.activeElement !== elements.pickupZip) {
      elements.pickupZip.value = state.settings.krogerZip ?? selected?.zip ?? "";
    }
    elements.findStores.disabled = storeLookupPending;
    elements.findStores.textContent = storeLookupPending ? "Finding…" : "Find stores";
    elements.storeLookupStatus.textContent = storeLookupMessage;
    elements.targetStoreField.hidden = true;
    elements.storeOptions.setAttribute("aria-busy", String(storeLookupPending));
    elements.storeOptions.setAttribute("aria-label", "Kroger-family stores near this ZIP");
    elements.storeOptions.replaceChildren();
    const displayedStores = krogerStoreLookupResults.length
      ? krogerStoreLookupResults
      : selected ? [selected] : [];
    elements.storeOptions.hidden = displayedStores.length === 0;
    for (const store of displayedStores) {
      const label = document.createElement("label");
      label.className = "store-option";
      if (selected?.id === store.id) label.classList.add("is-selected");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "kroger-store";
      radio.checked = selected?.id === store.id;
      radio.disabled = storeLookupPending;
      radio.setAttribute("aria-label", `Choose ${store.chain} at ${store.address}`);
      radio.addEventListener("change", () => {
        if (radio.checked) void chooseKrogerStore(store);
      });
      const copy = document.createElement("span");
      copy.className = "store-option-copy";
      copy.append(
        createTextElement("strong", "", store.address),
        createTextElement("small", "", `${store.chain} · ${store.name} · ZIP ${store.zip}`),
      );
      const check = createTextElement("span", "store-option-check", "✓");
      check.setAttribute("aria-hidden", "true");
      label.append(radio, copy, check);
      elements.storeOptions.append(label);
    }
    if (!preparing) {
      elements.prepareList.disabled = !hasContext;
      elements.prepareAgain.disabled = !hasContext;
    }
    return;
  }
  if (effectiveRetailer() === "target") {
    const hasContext = hasShoppingContext();
    elements.storePickerHeading.textContent = "Set your Target area";
    elements.storePicker.open = !hasContext;
    elements.pickupZip.value = state.settings.targetZip ?? "";
    elements.findStores.disabled = false;
    elements.findStores.textContent = "Use ZIP";
    elements.storeLookupStatus.textContent = hasContext
      ? `Target ${effectiveFulfillmentMode()} estimates are set for ZIP ${state.settings.targetZip}.`
      : effectiveFulfillmentMode() === "pickup"
        ? "Enter a ZIP and the 3- or 4-digit store ID shown on Target for pickup testing."
        : "Enter a ZIP to localize Target delivery or shipping estimates.";
    elements.storeOptions.hidden = true;
    elements.storeOptions.replaceChildren();
    elements.targetStoreField.hidden = false;
    if (document.activeElement !== elements.targetStoreId) {
      elements.targetStoreId.value = state.settings.targetStoreId ?? "";
    }
    if (!preparing) {
      elements.prepareList.disabled = !hasContext;
      elements.prepareAgain.disabled = !hasContext;
    }
    return;
  }
  elements.storePickerHeading.textContent = "Find a store by ZIP";
  elements.targetStoreField.hidden = true;
  const selected = state.settings.selectedStore;
  if (!storePickerInitialized) {
    elements.storePicker.open = !effectiveStore();
    storePickerInitialized = true;
  } else if (!effectiveStore() || storeLookupPending) {
    elements.storePicker.open = true;
  }
  if (document.activeElement !== elements.pickupZip) {
    elements.pickupZip.value = state.settings.pickupZip ?? selected?.zip ?? detectedStore()?.zip ?? "";
  }
  elements.findStores.disabled = storeLookupPending;
  elements.findStores.textContent = storeLookupPending ? "Finding…" : "Find stores";
  elements.storeLookupStatus.textContent = storeLookupMessage;
  elements.storeOptions.setAttribute("aria-busy", String(storeLookupPending));
  if (!preparing) {
    const hasStore = Boolean(effectiveStore());
    elements.prepareList.disabled = !hasStore;
    elements.prepareAgain.disabled = !hasStore;
  }
  const displayedStores = storeLookupResults.length
    ? storeLookupResults
    : selected
      ? [selected]
      : [];
  elements.storeOptions.replaceChildren();
  elements.storeOptions.hidden = displayedStores.length === 0;
  for (const store of displayedStores) {
    const label = document.createElement("label");
    label.className = "store-option";
    if (selected?.id === store.id) label.classList.add("is-selected");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "pickup-store";
    radio.checked = selected?.id === store.id;
    radio.disabled = storeLookupPending;
    radio.setAttribute("aria-label", `Choose Walmart at ${store.address}`);
    radio.addEventListener("change", () => {
      if (radio.checked) void choosePickupStore(store);
    });

    const copy = document.createElement("span");
    copy.className = "store-option-copy";
    copy.append(
      createTextElement("strong", "", store.address),
      createTextElement("small", "", `${store.name} · ZIP ${store.zip}`),
    );
    const check = createTextElement("span", "store-option-check", "✓");
    check.setAttribute("aria-hidden", "true");
    label.append(radio, copy, check);
    elements.storeOptions.append(label);
  }
}

function renderComparisonSetup() {
  const walmartStore = state.settings.selectedStore;
  const krogerStore = state.settings.krogerStore;
  const zip = state.settings.targetZip ?? walmartStore?.zip ?? krogerStore?.zip ?? "";
  if (document.activeElement !== elements.comparisonZip) elements.comparisonZip.value = zip;
  const ready = new Set(configuredComparisonRetailers());
  const statusByRetailer: Record<Retailer, HTMLElement> = {
    walmart: elements.comparisonWalmartStatus,
    target: elements.comparisonTargetStatus,
    kroger: elements.comparisonKrogerStatus,
  };
  for (const retailer of COMPARISON_RETAILERS) {
    const status = statusByRetailer[retailer];
    status.textContent = comparisonLookupPending
      ? "Finding…"
      : ready.has(retailer)
        ? retailer === "target" ? "ZIP estimate" : "Auto-selected for your ZIP"
        : "Unavailable";
    status.closest<HTMLElement>(".comparison-store-card")?.setAttribute("data-ready", String(ready.has(retailer)));
  }
  elements.comparisonWalmartDetail.textContent = walmartStore
    ? `${walmartStore.address} · ZIP ${walmartStore.zip}`
    : "Waiting for Walmart's automatically selected location for this ZIP.";
  elements.comparisonTargetDetail.textContent = /^\d{5}$/.test(state.settings.targetZip ?? "")
    ? `Localized to ZIP ${state.settings.targetZip}. This is an estimate, not an exact-store price.`
    : "Waiting for a valid ZIP.";
  elements.comparisonKrogerDetail.textContent = krogerStore
    ? `${krogerStore.chain} · ${krogerStore.address}`
    : "Waiting for Kroger's automatically selected location for this ZIP.";
  elements.comparisonLookupStatus.textContent = comparisonLookupMessage;
  elements.comparisonRetryLookup.hidden = !comparisonLookupRetryAvailable || comparisonLookupPending;
  elements.comparisonReadyHeading.textContent = ready.size >= 2
    ? `${ready.size} retailers ready to compare`
    : "Enter a ZIP to start";
  elements.comparisonReadyCopy.textContent = ready.size >= 2
    ? "Type one grocery list next. After it settles, Cartiva compares automatically and lets you choose one cart."
    : "Cartiva needs Target plus at least one automatically resolved nearby store.";
}

function renderContext() {
  const retailer = effectiveRetailer();
  const comparing = isComparisonMode();
  document.body.dataset.shoppingMode = comparing ? "compare" : "retailer";
  elements.comparisonSetup.hidden = !comparing;
  if (comparing) {
    elements.krogerConnection.hidden = true;
    elements.flowLocationLabel.textContent = "ZIP";
    elements.flowResultsLabel.textContent = "Compare";
    elements.listStepCopy.textContent = "Enter one list. After you pause, Cartiva automatically checks equivalent delivery baskets at every ready retailer.";
    elements.listHelp.textContent = "Include brands, package sizes, and weights when they matter. Exact sizes make the price comparison fair.";
    elements.grocerySuggestions.setAttribute("aria-label", "Grocery list suggestions");
    if (!preparing) elements.prepareButtonLabel.textContent = "Comparison starts automatically";
    renderComparisonSetup();
    return;
  }
  elements.krogerConnection.hidden = retailer !== "kroger";
  elements.flowLocationLabel.textContent = retailer === "target" ? "Area" : "Store";
  elements.flowResultsLabel.textContent = retailer === "target" ? "Matches" : "Cart";
  elements.locationHeading.textContent = retailer === "target"
    ? "Target shopping area"
    : retailer === "kroger" ? "Kroger-family location" : "Walmart location";
  elements.locationStepHeading.textContent = retailer === "target"
    ? "Set your Target shopping area"
    : retailer === "kroger"
      ? "Choose your Kroger-family store"
    : "Choose your pickup Walmart";
  elements.locationStepCopy.textContent = retailer === "target"
    ? "Cartiva verifies Target products and localizes estimates with your ZIP."
    : retailer === "kroger"
      ? "Cartiva uses Kroger's official API for this store's products and prices."
    : "Cartiva uses this store's products and pickup prices.";
  elements.listStepCopy.textContent = retailer === "target"
    ? "Type naturally. Cartiva will find and verify exact Target products."
    : retailer === "kroger"
      ? `Type naturally. Cartiva will find exact products at ${retailerName()}.`
    : "Type naturally. Cartiva will find exact products at your selected Walmart.";
  elements.listHelp.textContent = retailer === "target"
    ? "Cartiva searches exact Target products after you build the list. Target prices are estimates unless the response proves the exact store."
    : retailer === "kroger"
      ? "Official Kroger product results use your selected location. Cartiva adds verified UPCs through Kroger's official cart API."
    : "After a short pause, Cartiva shows exact products and localized pickup prices from your selected Walmart. Product identity is checked before adding.";
  elements.grocerySuggestions.setAttribute("aria-label", `${retailerName()} products`);
  elements.refreshContext.setAttribute("aria-label", retailer === "target" ? "Refresh Target area" : "Refresh Walmart location");
  elements.refreshContext.title = retailer === "target" ? "Refresh Target area" : "Refresh Walmart location";
  elements.storePickerDescription.textContent = retailer === "target"
    ? "Enter your ZIP to localize Target results. Pickup testing also uses the Target store number."
    : retailer === "kroger"
      ? "Enter your ZIP and select a nearby Kroger-family store. Cartiva uses the returned chain name automatically."
    : "Enter your ZIP and choose a store by address. Cartiva handles the store number privately.";
  elements.fulfillmentSummary.textContent = retailer === "target"
    ? "Target fulfillment options"
    : retailer === "kroger"
      ? `${retailerName()} fulfillment options`
    : "Delivery or other fulfillment options";
  elements.fulfillmentHelp.textContent = retailer === "target"
    ? "Delivery and shipping use your ZIP. Pickup also needs a Target store ID."
    : retailer === "kroger"
      ? "Availability is checked at the selected store. Verify the active store and final price in Kroger before checkout."
    : "Choosing a pickup store above automatically selects Pickup.";
  elements.applyContext.textContent = retailer === "target" ? "Apply Target area" : "Apply fulfillment";
  if (!preparing) {
    elements.prepareButtonLabel.textContent = retailer === "target"
      ? "Find my Target matches"
      : retailer === "kroger"
        ? `Build my ${retailerName()} cart`
      : "Build my Walmart cart";
  }

  if (retailer === "kroger") {
    const store = state.settings.krogerStore;
    const mode = effectiveFulfillmentMode();
    elements.locationName.textContent = store ? `${store.chain} · ${store.name}` : "Choose a Kroger-family store";
    elements.locationDetail.textContent = store
      ? `${store.address} · ZIP ${store.zip}`
      : "Enter your ZIP below to load official nearby locations.";
    elements.pageStatusPill.textContent = store ? `${store.chain} selected` : "Store needs selection";
    elements.fulfillmentPill.textContent = `${titleCase(mode)} · selected`;
    elements.offWalmartNotice.hidden = true;
    elements.refreshContext.hidden = true;
    elements.krogerConnectionHeading.textContent = krogerOAuthConnected
      ? "Kroger account connected"
      : "Connect your Kroger account once";
    elements.krogerConnectionCopy.textContent = krogerOAuthConnected
      ? `Cartiva can add official matches. Verify your active ${store?.chain ?? "Kroger"} store and price before checkout.`
      : "Required only to add official product matches to your Kroger-family cart.";
    elements.connectKroger.textContent = krogerOAuthChecking
      ? "Checking…"
      : krogerOAuthConnected ? "Disconnect" : "Connect Kroger";
    elements.connectKroger.disabled = krogerOAuthChecking || krogerCartPending;
    if (document.activeElement !== elements.fulfillmentMode) {
      elements.fulfillmentMode.value = mode;
    }
    const shippingOption = elements.fulfillmentMode.querySelector<HTMLOptionElement>('option[value="shipping"]');
    if (shippingOption) {
      shippingOption.disabled = true;
      shippingOption.textContent = "Shipping — not supported by Kroger cart";
    }
    const automaticOption = elements.fulfillmentMode.options[0];
    if (automaticOption) automaticOption.textContent = "Choose fulfillment";
    renderStorePicker();
    return;
  }

  if (retailer === "target") {
    const shippingOption = elements.fulfillmentMode.querySelector<HTMLOptionElement>('option[value="shipping"]');
    if (shippingOption) {
      shippingOption.disabled = false;
      shippingOption.textContent = "Shipping";
    }
    const zip = state.settings.targetZip;
    const mode = effectiveFulfillmentMode();
    elements.locationName.textContent = zip ? `Target area · ZIP ${zip}` : "Choose a Target shopping area";
    elements.locationDetail.textContent = zip
      ? mode === "pickup"
        ? `Pickup pilot${state.settings.targetStoreId ? ` · store ${state.settings.targetStoreId}` : " · store ID needed"}`
        : `${titleCase(mode)} estimates localized to ZIP ${zip}`
      : "Enter your ZIP below before searching Target products.";
    elements.pageStatusPill.textContent = hasShoppingContext() ? "Target area selected" : "Area needs selection";
    elements.fulfillmentPill.textContent = `${titleCase(mode)} · selected`;
    elements.offWalmartNotice.hidden = true;
    elements.refreshContext.hidden = true;
    if (document.activeElement !== elements.fulfillmentMode) {
      elements.fulfillmentMode.value = mode;
    }
    const automaticOption = elements.fulfillmentMode.options[0];
    if (automaticOption) automaticOption.textContent = "Choose fulfillment";
    renderStorePicker();
    return;
  }

  const context = state.pageContext;
  const shippingOption = elements.fulfillmentMode.querySelector<HTMLOptionElement>('option[value="shipping"]');
  if (shippingOption) {
    shippingOption.disabled = false;
    shippingOption.textContent = "Shipping — planning only";
  }
  elements.refreshContext.hidden = false;
  const selectedMode = effectiveFulfillmentMode();
  const selected = state.settings.selectedStore;
  const detected = detectedStore();

  if (selected) {
    elements.locationName.textContent = selected.name;
    const pageMismatch = context.onWalmart && context.storeId && context.storeId !== selected.id;
    elements.locationDetail.textContent = `${selected.address} · ZIP ${selected.zip}${pageMismatch ? " · Select this same store on Walmart before building" : ""}`;
    elements.pageStatusPill.textContent = "Selected pickup store";
  } else if (detected) {
    elements.locationName.textContent = detected.name;
    elements.locationDetail.textContent = `${detected.address} · ZIP ${detected.zip}`;
    elements.pageStatusPill.textContent = "Detected on Walmart";
  } else {
    elements.locationName.textContent = context.onWalmart ? "Walmart store not confirmed" : "Choose a Walmart store";
    elements.locationDetail.textContent = "Enter your ZIP below and select one store before preparing prices.";
    elements.pageStatusPill.textContent = context.onWalmart ? "Store needs selection" : "List planning mode";
  }

  elements.fulfillmentPill.textContent = selectedMode === "unknown"
    ? "Fulfillment needs selection"
    : `${titleCase(selectedMode)}${state.settings.fulfillmentModeOverride ? " · selected" : ""}`;
  elements.offWalmartNotice.hidden = context.onWalmart;
  if (document.activeElement !== elements.fulfillmentMode) {
    elements.fulfillmentMode.value = state.settings.fulfillmentModeOverride ?? "";
  }
  const automaticOption = elements.fulfillmentMode.options[0];
  if (automaticOption) automaticOption.textContent = "Use Walmart selection";
  renderStorePicker();
}

function renderDataMode() {
  if (isComparisonMode()) {
    const comparison = currentComparison();
    elements.dataStatus.dataset.mode = comparison?.status === "searching" ? "partial" : comparison ? "live" : "idle";
    elements.dataStatus.textContent = comparison?.status === "searching"
      ? "Comparing live prices"
      : comparison ? "Comparison checked" : "Not compared";
    return;
  }
  const status = dataStatusFor(state.preparedItems, effectiveRetailer());
  elements.dataStatus.dataset.mode = status.mode;
  elements.dataStatus.textContent = status.label;
}

type GuidedFlowStage = "location" | "list" | "results";

function currentComparison() {
  const comparison = state.comparison;
  if (!comparison) return undefined;
  const items = comparisonParsedItems();
  return comparison.listSignature === comparisonListSignature(items)
    && comparison.contextSignature === comparisonContextSignature(comparisonContexts())
    ? comparison
    : undefined;
}

function setFlowIndicator(
  element: HTMLElement,
  stateValue: "complete" | "current" | "upcoming",
) {
  element.dataset.state = stateValue;
  if (stateValue === "current") element.setAttribute("aria-current", "step");
  else element.removeAttribute("aria-current");
}

function renderGuidedFlow() {
  const hasStore = hasShoppingContext();
  const hasList = parseShoppingList(elements.shoppingList.value).length > 0;
  const hasResultExperience = isComparisonMode()
    ? preparing || Boolean(currentComparison())
    : preparing || state.preparedItems.length > 0 || Boolean(displayCartBuild());
  const stage: GuidedFlowStage = !hasStore || (isComparisonMode() && comparisonEditingStores)
    ? "location"
    : hasResultExperience
      ? "results"
      : "list";

  document.body.dataset.flowStage = stage;
  elements.locationStep.hidden = stage === "results";
  elements.locationStep.classList.toggle("is-complete", stage === "list");
  elements.locationStep.dataset.flowActive = String(stage === "location");
  elements.listStep.hidden = stage !== "list";
  elements.listStep.dataset.flowActive = String(stage === "list");
  elements.resultsSection.dataset.flowActive = String(stage === "results");
  elements.comparisonResultsSection.dataset.flowActive = String(stage === "results" && isComparisonMode());
  if (isComparisonMode()) elements.comparisonResultsSection.hidden = stage !== "results";
  elements.prepareList.hidden = stage !== "list" || !hasList;
  elements.prepareList.disabled = preparing || !hasStore || !hasList;

  setFlowIndicator(
    elements.flowLocationIndicator,
    stage === "location" ? "current" : "complete",
  );
  setFlowIndicator(
    elements.flowListIndicator,
    stage === "location" ? "upcoming" : stage === "list" ? "current" : "complete",
  );
  setFlowIndicator(
    elements.flowResultsIndicator,
    stage === "results" ? "current" : "upcoming",
  );
}

function buildStatusFor(item: PreparedItem) {
  return relevantCartBuild()?.items.find((entry) => entry.id === item.id)?.status
    ?? (item.retailer === "kroger" && item.cartStatus !== "ready" ? item.cartStatus : undefined);
}

function strictReviewReason(item: PreparedItem) {
  const product = item.product;
  const mode = effectiveFulfillmentMode();
  if (effectiveRetailer() === "kroger" || item.retailer === "kroger") {
    if (item.dataMode !== "live") return "Demo data is not presented as a live Kroger-family match.";
    if (!product) return "No official Kroger product identity was returned.";
    if (product.verification !== "verified" || product.identityVerified !== true) {
      return "Kroger product identity and current details were not fully verified.";
    }
    if (!isFreshVerification(item.checkedAt ?? product.checkedAt)) return "The Kroger price is missing or older than 30 minutes.";
    if (!product.inStock || product.availabilityStatus === "out_of_stock") return "The selected store did not report this product available.";
    if (!/^\d{8,14}$/.test(product.upc ?? "")) return "A valid official Kroger UPC is unavailable.";
    if (product.priceProvenance?.priceScope !== "exact_store"
      || product.priceProvenance.exactStoreVerified !== true
      || product.priceProvenance.priceReliability !== "verified"
      || product.priceProvenance.location?.requestedStoreId !== effectiveStoreId()
      || product.priceProvenance.location?.observedStoreId !== effectiveStoreId()) {
      return "The price was not verified at your selected Kroger-family store.";
    }
    return "Kroger could not verify an important product, price, or fulfillment detail.";
  }
  if (effectiveRetailer() === "target" || item.retailer === "target") {
    if (item.dataMode !== "live") return "Demo data is not presented as a live Target match.";
    if (!product) return "No Target product identity was returned.";
    if (product.verification !== "verified" || product.identityVerified !== true) {
      return "Target product identity and current details were not fully verified.";
    }
    if (!isFreshVerification(item.checkedAt ?? product.checkedAt)) {
      return "The Target price check is missing or older than 30 minutes.";
    }
    if (mode === "pickup" && (!product.inStock || product.availabilityStatus !== "in_stock")) {
      return "Target availability could not be confirmed.";
    }
    if (mode !== "pickup" && product.availabilityStatus === "out_of_stock") {
      return `Target reports this product unavailable for ${mode}.`;
    }
    if (!isValidTargetProductUrl(product.link, product.productId)) {
      return "The exact Target product page could not be verified.";
    }
    if (product.priceProvenance?.sellerType === "marketplace") {
      return "A third-party marketplace offer is not included.";
    }
    if (product.priceProvenance?.priceReliability === "unreliable") {
      return "The Target price or location evidence is unreliable.";
    }
    return "Target could not verify an important product or availability detail.";
  }
  if (mode === "unknown") return "Choose pickup, delivery, or shipping before Cartiva evaluates fulfillment.";
  if (mode === "shipping") return "Shipping remains a planning mode until Cartiva can verify shipping-specific prices.";
  if (item.dataMode !== "live") return "Demo data cannot be added to a real Walmart cart.";
  if (!product) return "No product identity was returned.";
  if (product.verification !== "verified") return "Walmart product details are not fully verified.";
  if (!isFreshVerification(item.checkedAt ?? product.checkedAt)) return "The verified price is missing or older than 30 minutes. Refresh prices.";
  if (!product.inStock) return "The product is not currently confirmed in stock.";
  if (!Number.isInteger(product.priceCents) || product.priceCents! <= 0) return "A positive verified Walmart price is unavailable.";
  if (!/^\d{6,20}$/.test(product.itemId ?? "")) return "A valid Walmart item ID is unavailable.";
  if (!isValidWalmartProductUrl(product.link, product.itemId)) return "The exact Walmart product page could not be verified.";
  if (product.priceProvenance?.sellerType !== "walmart") return "The offer is not verified as sold by Walmart.";
  const hasLocalizedWalmartPrice = usesLocalizedWalmartPrice(product);
  if (
    product.priceProvenance?.localPriceEligible !== true
    || (product.priceProvenance?.localPriceVerified !== true && !hasLocalizedWalmartPrice)
  ) {
    return `A reliable Walmart ${mode} price could not be confirmed.`;
  }
  if (product.priceProvenance.verifiedFulfillmentMode !== mode) {
    return `The selected search price was not verified specifically for ${mode}.`;
  }
  const fulfillment = product.priceProvenance.fulfillment ?? [];
  if (mode === "pickup" && !fulfillment.includes("pickup") && !fulfillment.includes("in_store")) {
    return "Pickup or in-store availability could not be verified.";
  }
  if (mode === "delivery" && !fulfillment.includes("delivery")) return "Delivery availability could not be verified.";
  const requestedStoreId = product.priceProvenance.requestedStoreId?.trim();
  const observedStoreIds = [
    requestedStoreId,
    product.priceProvenance.searchStoreId?.trim(),
    product.priceProvenance.detailStoreId?.trim(),
  ].filter((value): value is string => Boolean(value));
  const expectedStoreId = effectiveStoreId();
  if (
    !/^\d+$/.test(requestedStoreId ?? "")
    || new Set(observedStoreIds).size !== 1
    || (expectedStoreId && observedStoreIds.some((value) => value !== expectedStoreId))
  ) return "The search, product details, and selected Walmart store do not agree.";
  return "An important cart-building requirement could not be verified.";
}

function displayStatus(item: PreparedItem) {
  const buildStatus = buildStatusFor(item);
  return resultDisplayStatus(item, reliableDisplayMatch(item), buildStatus);
}

const statusLabels: Record<string, string> = {
  ...RESULT_STATUS_LABELS,
  ready: "Ready",
};

function createTextElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string,
) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function productPriceText(item: PreparedItem, product: ExtensionProduct) {
  const cents = product.priceCents ?? Math.round(product.price * 100);
  return formatCurrency(cents * item.request.quantity);
}

function createChangePanel(item: PreparedItem) {
  const panel = document.createElement("div");
  panel.className = "change-panel";
  panel.hidden = true;
  panel.id = `change-${item.id}`;

  const guidance = createTextElement(
    "p",
    "",
    "Alternatives are suggestions until Cartiva searches and verifies the selected option.",
  );
  panel.append(guidance);

  if (item.alternatives.length) {
    const list = document.createElement("div");
    list.className = "alternative-list";
    for (const alternative of item.alternatives.slice(0, 3)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "alternative-button";
      button.append(
        createTextElement("span", "", alternative.title),
        createTextElement("span", "", `Verify · ${formatCurrency(alternative.priceCents ?? Math.round(alternative.price * 100))}`),
      );
      button.addEventListener("click", () => void reprepareSingle(item, alternative.title));
      list.append(button);
    }
    panel.append(list);
  }

  const customSearch = document.createElement("div");
  customSearch.className = "custom-search";
  const input = document.createElement("input");
  input.type = "search";
  input.value = item.request.text;
  input.setAttribute("aria-label", `Search again for ${item.request.text}`);
  const search = document.createElement("button");
  search.type = "button";
  search.textContent = "Search again";
  search.addEventListener("click", () => void reprepareSingle(item, input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void reprepareSingle(item, input.value);
    }
  });
  customSearch.append(input, search);
  panel.append(customSearch);
  return panel;
}

function createProductRow(item: PreparedItem) {
  const status = displayStatus(item);
  const article = document.createElement("article");
  article.className = `product-row${["couldnt_verify", "no_match", "unavailable"].includes(status) ? " row-review" : ""}`;
  article.id = `prepared-${item.id}`;
  article.tabIndex = -1;

  const head = document.createElement("div");
  head.className = "product-row-head";
  const requested = document.createElement("div");
  requested.className = "requested-copy";
  requested.append(
    createTextElement("span", "", "You asked for"),
    createTextElement(
      "strong",
      "",
      `${item.request.quantity > 1 ? `${item.request.quantity} × ` : ""}${item.request.text}`,
    ),
  );
  const badge = createTextElement(
    "span",
    "row-status",
    resultStatusLabel(status, item.retailer ?? effectiveRetailer()),
  );
  badge.dataset.status = status;
  head.append(requested, badge);
  article.append(head);

  if (item.matchStatus === "searching" && !item.product) {
    const skeleton = document.createElement("div");
    skeleton.className = "product-main";
    const lines = document.createElement("div");
    lines.style.width = "100%";
    lines.append(
      createTextElement("div", "skeleton-line", ""),
      createTextElement("div", "skeleton-line", ""),
    );
    skeleton.append(lines);
    article.append(skeleton);
    return article;
  }

  const product = item.product;
  if (product) {
    const targetResult = item.retailer === "target" || product.retailer === "target";
    const krogerResult = item.retailer === "kroger" || product.retailer === "kroger";
    const main = document.createElement("div");
    main.className = "product-main";
    const productCopy = document.createElement("div");
    productCopy.className = "product-copy";
    productCopy.append(createTextElement("p", "product-title", product.title));
    const fulfillment = product.priceProvenance?.fulfillment?.map(titleCase).join(", ");
    const availabilityText = product.availabilityStatus === "in_stock"
      ? "In stock"
      : product.availabilityStatus === "out_of_stock"
        ? "Unavailable"
        : targetResult
          ? "Availability not confirmed"
          : "Unavailable";
    const meta = [
      product.brand,
      product.size?.label,
      availabilityText,
      fulfillment,
    ].filter(Boolean).join(" · ");
    if (meta) productCopy.append(createTextElement("p", "product-meta", meta));
    if (item.estimatedByWeight) {
      productCopy.append(createTextElement("span", "weighted-note", "Estimated by weight"));
    }

    const price = document.createElement("div");
    price.className = "price-copy";
    price.append(createTextElement("strong", "", productPriceText(item, product)));
    if (item.request.quantity > 1) {
      price.append(createTextElement(
        "span",
        "",
        `${item.request.quantity} × ${formatCurrency(product.priceCents ?? Math.round(product.price * 100))}`,
      ));
    }
    const hasLocalizedWalmartPrice = usesLocalizedWalmartPrice(product);
    const priceTrustLabel = item.dataMode === "demo"
      ? "Demo sample price"
        : targetResult
          ? reliableDisplayMatch(item)
            ? product.priceLabel ?? "Target price estimate"
            : "Target estimate · not included"
        : krogerResult
          ? reliableDisplayMatch(item)
            ? `Official ${retailerName("kroger")} store price`
            : `${retailerName("kroger")} price · not included`
        : strictlyEligible(item)
          ? hasLocalizedWalmartPrice
            ? `Localized Walmart ${effectiveFulfillmentMode()} price`
            : `Verified local Walmart ${effectiveFulfillmentMode()} price`
          : "Estimated price · not added";
    price.append(createTextElement("span", "", priceTrustLabel));
    if (product.unitLabel) price.append(createTextElement("span", "", product.unitLabel));
    main.append(productCopy, price);
    article.append(main);
  }

  if (item.assumptions?.length) {
    const assumptions = document.createElement("div");
    assumptions.className = "assumption-list";
    for (const assumption of item.assumptions) {
      assumptions.append(createTextElement("span", "", assumption));
    }
    article.append(assumptions);
  }

  if (item.explanation || (item.matchStatus === "matched" && status === "couldnt_verify")) {
    const explanation = document.createElement("p");
    explanation.className = "product-explanation";
    if (status === "matched" || status === "best_match" || status === "added") {
      explanation.append(createTextElement(
        "strong",
        "",
        status === "best_match" ? "Why this is reasonable: " : "Why this matched: ",
      ));
      explanation.append(document.createTextNode(
        item.explanation ?? (item.retailer === "target"
          ? "Verified live Target product."
          : item.retailer === "kroger" ? "Verified official Kroger-family product." : "Verified live Walmart product."),
      ));
    } else if (item.matchStatus === "matched") {
      explanation.append(createTextElement("strong", "", "Not included: "));
      explanation.append(document.createTextNode(strictReviewReason(item)));
    } else {
      explanation.append(document.createTextNode(
        item.explanation ?? `Cartiva found an option but couldn't verify it for ${item.retailer === "target" ? "Target" : item.retailer === "kroger" ? retailerName("kroger") : "this Walmart cart"}.`,
      ));
    }
    article.append(explanation);
  }

  const checkedAt = formatTime(item.checkedAt ?? product?.checkedAt);
  if (checkedAt) {
    article.append(createTextElement("p", "product-time", `Last checked ${checkedAt}`));
  }

  const buildMessage = relevantCartBuild()?.items.find((entry) => entry.id === item.id)?.message
    ?? item.cartMessage;
  if (buildMessage) article.append(createTextElement("p", "cart-message", buildMessage));

  const actions = document.createElement("div");
  actions.className = "product-actions";
  const change = document.createElement("button");
  change.type = "button";
  change.className = "small-action";
  change.textContent = "Change item";
  change.disabled = preparing || Boolean(blockingCartBuild(cartBuild));
  change.setAttribute("aria-expanded", "false");
  change.setAttribute("aria-controls", `change-${item.id}`);
  const changePanel = createChangePanel(item);
  change.addEventListener("click", () => {
    changePanel.hidden = !changePanel.hidden;
    change.setAttribute("aria-expanded", String(!changePanel.hidden));
    if (!changePanel.hidden) changePanel.querySelector<HTMLElement>("button, input")?.focus();
  });
  actions.append(change);

  const targetResult = item.retailer === "target" || product?.retailer === "target";
  const krogerResult = item.retailer === "kroger" || product?.retailer === "kroger";
  const safeProductLink = product
    ? targetResult
      ? safeTargetProductLink(product)
      : krogerResult ? safeKrogerProductLink(product) : safeWalmartProductLink(product)
    : undefined;
  if (product && safeProductLink) {
    const link = document.createElement("a");
    link.className = "product-link";
    link.href = safeProductLink;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = targetResult
      ? "View at Target"
      : krogerResult
        ? `View at ${retailerName("kroger")}`
        : product.linkType === "product" ? "View at Walmart" : "Search at Walmart";
    actions.append(link);
  }
  article.append(actions, changePanel);
  return article;
}

function comparisonRetailerLabel(retailer: Retailer) {
  return retailer === "walmart"
    ? "Walmart"
    : retailer === "target"
      ? "Target"
      : state.settings.krogerStore?.chain ?? "Kroger family";
}

function editComparisonStores() {
  comparisonEditingStores = true;
  cancelActivePreparation();
  invalidateComparison();
  void persistState();
  renderAll();
  elements.locationStep.scrollIntoView({ behavior: "smooth", block: "start" });
  elements.comparisonZip.focus();
}

async function activateComparisonRetailer(retailer: Retailer, build: boolean) {
  const comparison = currentComparison();
  const retailerResult = comparison?.retailers[retailer];
  if (!comparison || !retailerResult?.items.length) {
    showToast("Compare this list again before choosing a cart.");
    return;
  }
  const selectedContext = comparisonContexts()[retailer];
  comparisonClient.cancel();
  state.shoppingMode = "retailer";
  state.settings.retailer = retailer;
  state.settings.fulfillmentModeOverride = selectedContext.fulfillmentMode === "delivery" ? "delivery" : "pickup";
  state.settings.targetFulfillmentMode = selectedContext.fulfillmentMode === "delivery" ? "delivery" : "pickup";
  state.settings.krogerFulfillmentMode = selectedContext.fulfillmentMode === "delivery" ? "delivery" : "pickup";
  state.parsedItems = retailerResult.items.map((item) => ({ ...item.request }));
  state.preparedItems = retailerResult.items.map((item) => ({
    ...item,
    alternatives: item.alternatives.map((product) => ({ ...product })),
    product: item.product ? { ...item.product } : undefined,
  }));
  state.lastPreparedAt = comparison.updatedAt ?? new Date().toISOString();
  automaticCartBuildRetryAvailable = false;
  await persistState();
  renderAll();
  elements.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!build) return;
  if (retailer === "kroger") {
    await startKrogerCartBuild();
  } else {
    openConfirmation();
  }
}

function createComparisonBasketCard(
  retailer: Retailer,
  comparison: ComparisonSearchState,
  evaluation: ReturnType<typeof evaluateComparison>,
) {
  const basket = evaluation.baskets[retailer];
  const retailerState = comparison.retailers[retailer];
  const readyContext = comparisonRetailerReady(retailer);
  const lowest = evaluation.tiedLowestRetailers.includes(retailer);
  const tied = lowest && evaluation.tiedLowestRetailers.length > 1;
  const card = document.createElement("article");
  card.className = "comparison-basket-card";
  card.dataset.retailer = retailer;
  card.dataset.lowest = String(lowest);

  const head = document.createElement("div");
  head.className = "comparison-basket-head";
  head.append(createTextElement("strong", "", comparisonRetailerLabel(retailer)));
  const status = createTextElement(
    "span",
    `comparison-badge${lowest ? " comparison-badge-lowest" : ""}`,
    !readyContext
      ? "Not available"
      : retailerState.status === "searching"
        ? "Checking…"
        : lowest
          ? tied ? "Tied lowest" : basket.basis === "verified" ? "Lowest verified" : "Lowest estimate"
          : basket.comparable
            ? basket.basis === "verified" ? "Exact store total" : "Comparable estimate"
            : "Not comparable",
  );
  head.append(status);

  const total = document.createElement("div");
  total.className = "comparison-basket-total";
  total.append(
    createTextElement("strong", "", basket.reliableCount ? formatCurrency(basket.totalCents) : "—"),
    createTextElement(
      "span",
      "",
      basket.comparable
        ? `${basket.reliableCount} of ${basket.requestedCount} items · ${basket.basis === "verified" ? "exact" : "estimate"}`
        : `${basket.reliableCount} of ${basket.requestedCount} reliably priced`,
    ),
  );
  const coverage = document.createElement("div");
  coverage.className = "comparison-coverage";
  const coverageBar = document.createElement("span");
  coverageBar.style.width = `${basket.coveragePercent}%`;
  coverage.append(coverageBar);
  const copy = createTextElement(
    "p",
    "comparison-basket-copy",
    !readyContext
      ? "Set this store to include it the next time you compare."
      : retailerState.status === "searching"
        ? "Searching and verifying every requested product."
        : basket.reason
          ?? (basket.hasConditionalPromo
            ? `Comparison uses the regular price. A possible promo could save ${formatCurrency(basket.promoSavingsCents)}, subject to Kroger terms.`
            : "Every requested item has a reliable equivalent-size price."),
  );

  const actions = document.createElement("div");
  actions.className = "comparison-basket-actions";
  const action = document.createElement("button");
  action.type = "button";
  action.className = basket.comparable ? "accent-button compact-button" : "secondary-button compact-button";
  if (!readyContext) {
    action.textContent = "Retry area lookup";
    action.addEventListener("click", () => void findComparisonStores(elements.comparisonZip.value, true));
  } else if (retailerState.status === "error") {
    action.textContent = "Retry this retailer";
    action.addEventListener("click", () => void prepareComparisonList({ force: true }));
  } else if (retailerState.items.length) {
    action.textContent = basket.comparable ? "Choose and build this cart" : "Review these matches";
    action.addEventListener("click", () => void activateComparisonRetailer(retailer, basket.comparable));
  } else {
    action.textContent = "Waiting for results";
    action.disabled = true;
  }
  if (retailerState.status === "searching") action.disabled = true;
  actions.append(action);
  card.append(head, total, coverage, copy, actions);
  return card;
}

function renderComparisonResults() {
  const comparison = currentComparison();
  elements.resultsSection.hidden = true;
  elements.comparisonResultsSection.hidden = !comparison && !preparing;
  if (!comparison) {
    elements.comparisonBaskets.replaceChildren();
    return;
  }
  const requests = comparisonParsedItems();
  const evaluation = evaluateComparison(comparison, requests, comparisonContexts());
  const terminal = COMPARISON_RETAILERS.filter((retailer) => (
    comparison.retailers[retailer].status === "complete" || comparison.retailers[retailer].status === "error"
  )).length;
  elements.comparisonProgress.hidden = evaluation.status !== "waiting";
  elements.comparisonProgressCount.textContent = `${terminal} of 3`;
  elements.comparisonProgressLabel.textContent = "Checking complete equivalent-size baskets…";
  elements.comparisonResultsHeading.textContent = evaluation.status === "waiting"
    ? "Comparing complete baskets"
    : evaluation.status === "ready"
      ? "Choose your best complete cart"
      : "Comparison needs more complete matches";
  elements.comparisonBaskets.replaceChildren(...COMPARISON_RETAILERS.map((retailer) => (
    createComparisonBasketCard(retailer, comparison, evaluation)
  )));

  const winner = evaluation.lowestComparableRetailer
    ? evaluation.baskets[evaluation.lowestComparableRetailer]
    : undefined;
  if (winner) {
    const tiedBaskets = evaluation.tiedLowestRetailers.map((retailer) => evaluation.baskets[retailer]);
    const tie = tiedBaskets.length > 1;
    const tiedLabels = evaluation.tiedLowestRetailers.map(comparisonRetailerLabel).join(" and ");
    const tieBasis = tiedBaskets.every((basket) => basket.basis === "verified") ? "verified basket" : "comparable total";
    elements.comparisonOutcomeHeading.textContent = tie
      ? `${tiedLabels} are tied for the lowest ${tieBasis}`
      : winner.basis === "verified"
        ? `${comparisonRetailerLabel(winner.retailer)} has the lowest verified basket`
        : `${comparisonRetailerLabel(winner.retailer)} has the lowest comparable estimate`;
    elements.comparisonOutcomeCopy.textContent = `${formatCurrency(winner.totalCents)}${tie ? " each" : ""} for all ${winner.requestedCount} requested items. Product subtotal only; taxes, fees, tips, deposits, memberships, and checkout changes are excluded.`;
  } else if (evaluation.status === "waiting") {
    elements.comparisonOutcomeHeading.textContent = "Waiting for every active retailer";
    elements.comparisonOutcomeCopy.textContent = "Cartiva will not name a leader while any active search is unfinished.";
  } else if (evaluation.status === "only_complete") {
    elements.comparisonOutcomeHeading.textContent = "Only one complete basket is ready";
    elements.comparisonOutcomeCopy.textContent = "At least two complete, equivalent-size baskets are required before Cartiva can identify the lower total.";
  } else {
    elements.comparisonOutcomeHeading.textContent = "No fair complete comparison yet";
    elements.comparisonOutcomeCopy.textContent = "Missing items, stale prices, different package sizes, or unavailable products kept these baskets from being ranked. Add sizes to your list or review a retailer’s matches.";
  }
  renderDataMode();
}

function renderResults() {
  if (isComparisonMode()) {
    renderComparisonResults();
    return;
  }
  elements.comparisonResultsSection.hidden = true;
  const items = state.preparedItems;
  const targetMode = effectiveRetailer() === "target";
  const krogerMode = effectiveRetailer() === "kroger";
  const displayRetailerName = retailerName();
  const previousScrollTop = elements.resultList.scrollTop;
  elements.resultsSection.hidden = items.length === 0 && !preparing;
  elements.resultsEyebrow.textContent = `Step 3 · ${targetMode ? "Target matches" : `${displayRetailerName} cart`}`;
  elements.prepareAgain.textContent = targetMode ? "Find Target again" : `Find ${displayRetailerName} again`;
  elements.resultsHeading.textContent = preparing
    ? `Finding your best ${targetMode ? "matches" : "cart"}`
    : `Your ${displayRetailerName} matches`;
  elements.resultList.setAttribute(
    "aria-label",
    `${displayRetailerName} product matches. Scroll inside this list to inspect every item.`,
  );
  elements.resultList.replaceChildren(...items.map(createProductRow));
  elements.resultList.scrollTop = previousScrollTop;
  elements.resultList.setAttribute("aria-busy", String(preparing));

  const completed = items.filter((item) => item.matchStatus !== "searching").length;
  const selectedMode = effectiveFulfillmentMode();
  const eligible = selectedMode === "unknown"
    ? []
    : items.filter((item) => reliableDisplayMatch(item));
  const matched = eligible.length;
  const nowMs = Date.now();
  const reviews = items.filter((item) => item.matchStatus !== "searching" && !reliableDisplayMatch(item, nowMs)).length;
  const subtotal = targetMode
    ? targetEstimateSubtotalCents(items, selectedMode, nowMs)
    : krogerMode
      ? krogerSubtotalCents(items, selectedMode, nowMs, effectiveStoreId())
    : verifiedSubtotalCents(items, selectedMode, nowMs, effectiveStoreId());
  const preparedStoreId = !targetMode && eligible.length ? storeIdForBuild(eligible) : undefined;
  const activeBuild = displayCartBuild();
  const buildAlreadyHandled = Boolean(activeBuild && ["running", "paused", "complete"].includes(activeBuild.status));

  elements.requestedCount.textContent = String(items.length);
  elements.matchedCount.textContent = String(matched);
  elements.reviewCount.textContent = String(reviews);
  elements.verifiedSubtotal.textContent = formatCurrency(subtotal);
  elements.subtotalLabel.textContent = targetMode
    ? "Target estimated subtotal"
    : krogerMode ? `${displayRetailerName} subtotal` : "Walmart subtotal";
  elements.subtotalNote.textContent = targetMode
    ? reviews
      ? `${reviews} ${reviews === 1 ? "item is" : "items are"} excluded. Target prices shown are estimates; checkout is final.`
      : "Only verified Target product matches are included. Localized prices are estimates; Target checkout is final."
    : krogerMode
      ? reviews
        ? `${reviews} ${reviews === 1 ? "item was" : "items were"} excluded. Search prices use the selected store; verify active store and final checkout price.`
        : `Official selected-store prices are shown. Kroger accepts UPCs into the account cart; verify active store and checkout price.`
    : reviews
      ? `${reviews} ${reviews === 1 ? "item wasn't" : "items weren't"} verified and won't be added. Walmart checkout price is final.`
      : "Only reliable live Walmart matches are included. Localized prices are estimates; Walmart checkout is final.";

  elements.searchProgress.hidden = !preparing;
  elements.searchProgressCount.textContent = `${completed} of ${items.length}`;
  elements.searchProgressLabel.textContent = completed < items.length
    ? `Searching and verifying ${displayRetailerName}…`
    : `Finishing ${displayRetailerName} checks…`;

  if (krogerMode) {
    const added = items.filter((item) => item.cartStatus === "added").length;
    const failed = items.some((item) => item.cartStatus === "failed");
    const outcomeUnknown = items.some((item) => item.cartRetrySafe === false);
    elements.buildCart.hidden = !(outcomeUnknown || failed || added > 0 || (!krogerOAuthConnected && eligible.length > 0));
    elements.buildCart.disabled = preparing
      || krogerCartPending
      || (added === 0 && !outcomeUnknown && eligible.length === 0);
    elements.buildCart.textContent = outcomeUnknown
      ? "Open cart to check"
      : added > 0
      ? `Open ${displayRetailerName} cart`
      : !krogerOAuthConnected ? "Connect Kroger" : "Retry official cart";
    elements.buildEligibilityHeading.textContent = outcomeUnknown
      ? "Check the cart before continuing"
      : krogerOAuthConnected
      ? `Official ${displayRetailerName} cart connected`
      : "Connect Kroger once to add automatically";
    elements.buildEligibilityNote.textContent = krogerCartPending
      ? `Kroger is accepting ${eligible.length} verified ${eligible.length === 1 ? "item" : "items"} through its official cart API.`
      : outcomeUnknown
        ? "Kroger did not confirm whether the request finished. Cartiva will not retry it. Open the cart, then prepare only missing products as a new list."
      : added > 0
        ? `${added} ${added === 1 ? "item was" : "items were"} accepted by Kroger. Verify the active store, quantities, and final prices in the cart.`
        : !krogerOAuthConnected
          ? "Product search is ready now. Connect your Kroger account above once so Cartiva can add verified UPCs."
          : failed
            ? "Kroger did not finish the last cart request. Your verified matches are still ready to retry."
            : eligible.length
              ? `${eligible.length} verified ${eligible.length === 1 ? "item is" : "items are"} ready to add automatically.`
              : "No official Kroger-family matches are ready to add.";
    renderDataMode();
    return;
  }

  if (targetMode) {
    elements.buildCart.hidden = !automaticCartBuildRetryAvailable;
    elements.buildCart.disabled = preparing
      || buildStartPending
      || eligible.length === 0
      || buildAlreadyHandled;
    elements.buildCart.textContent = "Retry Target cart";
    elements.buildEligibilityHeading.textContent = "Reliable Target matches add automatically";
    elements.buildEligibilityNote.textContent = activeBuild?.status === "running"
      ? "Cartiva is adding verified products with Target's visible controls."
      : activeBuild?.status === "paused"
        ? "Target needs a visible choice or sign-in. Finish it in Target, then continue below."
        : buildAlreadyHandled && activeBuild?.status === "complete"
          ? "The Target cart build finished. Review Target's cart before checkout."
          : buildStartPending
            ? "Cartiva found verified products and is opening Target now."
            : preparing
              ? "Cartiva will add each reliable Target match as soon as matching finishes."
              : automaticCartBuildRetryAvailable
                ? "The matches are ready, but Target was not ready. Retry the cart build."
                : eligible.length
                  ? `${eligible.length} verified ${eligible.length === 1 ? "item is" : "items are"} ready and will be added automatically. ${reviews ? `${reviews} will be left out.` : ""}`
                  : "No reliable live Target products are ready to add.";
    renderDataMode();
    return;
  }

  elements.buildCart.hidden = !automaticCartBuildRetryAvailable;
  elements.buildCart.disabled = preparing
    || buildStartPending
    || eligible.length === 0
    || !preparedStoreId
    || buildAlreadyHandled;
  elements.buildCart.textContent = "Retry cart build";
  elements.buildEligibilityHeading.textContent = "Reliable matches add automatically";
  elements.buildEligibilityNote.textContent = activeBuild?.status === "running"
    ? "Cartiva is adding the verified products automatically. Keep this list open while Walmart confirms them."
    : activeBuild?.status === "paused"
      ? "An earlier cart build needs your attention. Continue or cancel it below."
    : buildAlreadyHandled && activeBuild?.status === "complete"
        ? "The automatic cart build finished. Check Walmart's cart before checkout."
      : buildStartPending
        ? "Cartiva found verified products and is starting the Walmart cart now."
      : preparing
        ? "Cartiva will automatically add each verified product when matching finishes. Unresolved items stay out."
    : selectedMode === "unknown"
      ? "Choose pickup or delivery so Cartiva can add verified products automatically."
    : selectedMode === "shipping"
      ? "Shipping is a planning mode in version 1. Cart building requires a verified pickup or delivery offer."
    : eligible.length && !preparedStoreId
      ? "Choose a Walmart store by address, then find the products again."
    : automaticCartBuildRetryAvailable
      ? "The products are verified, but the automatic cart start hit a problem. Retry when Walmart is ready."
    : eligible.length
      ? `${eligible.length} verified ${eligible.length === 1 ? "item is" : "items are"} ready and will be added automatically. ${reviews ? `${reviews} will be left out.` : ""}`
      : "No reliable live products are ready to add. Change unresolved items or check the Cartiva connection.";

  renderDataMode();
}

function renderCartProgress() {
  if (isComparisonMode()) {
    elements.cartProgressSection.hidden = true;
    return;
  }
  const build = displayCartBuild();
  elements.cartProgressSection.hidden = !build;
  if (!build) return;

  const progress = cartProgress(build);
  const targetBuild = build.retailer === "target";
  const retailerName = targetBuild ? "Target" : "Walmart";
  const percent = progress.total ? Math.round((progress.settled / progress.total) * 100) : 100;
  elements.cartProgressBar.style.width = `${percent}%`;
  elements.cartBuildStatus.textContent = titleCase(build.status);
  elements.cartBuildStatus.dataset.status = build.status;
  elements.cartProgressHeading.textContent = build.status === "complete"
    ? progress.added === progress.total
      ? `${retailerName} cart is ready`
      : progress.added > 0
        ? "Cart build finished with unresolved items"
        : "No items were confirmed as added"
    : build.status === "paused"
      ? build.pauseKind === "context"
        ? `${retailerName} setup needs attention`
        : `Waiting for your ${retailerName} choice`
      : build.status === "cancelled"
        ? "Cart build stopped"
        : `Adding to ${retailerName}`;
  elements.cartProgressText.textContent = build.status === "complete"
    ? `${progress.added} of ${progress.total} confirmed added. Check every Failed, Unavailable, or Skipped row below.`
    : build.status === "paused"
      ? `${progress.settled} of ${progress.total} processed · ${progress.added} added`
      : build.status === "cancelled"
        ? `${progress.settled} of ${progress.total} processed before stopping.`
        : `${progress.settled} of ${progress.total} processed · ${progress.added} added`;

  const recoveryStore = targetBuild ? undefined : recoveryStoreFor(build);
  const canApplyPickupStore = !targetBuild && build.status === "paused"
    && build.pauseKind === "context"
    && build.fulfillmentMode === "pickup"
    && Boolean(recoveryStore);
  elements.cartPauseNotice.hidden = build.status !== "paused";
  elements.cartPauseHeading.textContent = `${retailerName} needs your attention.`;
  elements.cartPauseReason.textContent = canApplyPickupStore
    ? `${build.pauseReason ?? "Walmart's store does not match this basket."} Cartiva can apply ${recoveryStore!.address} and continue.`
    : build.pauseReason
      ?? `Complete the required option or security step at ${retailerName}, then continue.`;
  elements.resumeCart.hidden = build.status !== "paused";
  elements.resumeCart.textContent = canApplyPickupStore
    ? "Use selected Walmart — continue"
    : "I finished the choice — continue";
  elements.cancelCart.hidden = !["running", "paused"].includes(build.status);
  elements.cancelCart.textContent = build.status === "paused"
    ? "Cancel current build"
    : "Stop after current item";
  elements.reviewCart.hidden = build.status !== "complete";
  elements.reviewCart.textContent = `Open ${retailerName} cart`;

  elements.cartProgressList.replaceChildren();
  for (const item of build.items) {
    const entry = document.createElement("li");
    const itemStatus = build.pauseKind === "context" && item.status === "needs_choice"
      ? "Store setup"
      : statusLabels[item.status] ?? titleCase(item.status);
    entry.append(
      createTextElement("strong", "", item.requestedText),
      createTextElement("span", "", itemStatus),
    );
    if (item.message) entry.append(createTextElement("p", "cart-message", item.message));
    elements.cartProgressList.append(entry);
  }
}

function renderAll() {
  renderContext();
  renderResults();
  renderCartProgress();
  renderGuidedFlow();
}

function updatePreparedItem(next: PreparedItem) {
  const index = state.preparedItems.findIndex((item) => item.id === next.id);
  if (index < 0) state.preparedItems.push(next);
  else state.preparedItems[index] = next;
  void persistState();
  renderResults();
  renderCartProgress();
}

function prepareOptions(onResult: (item: PreparedItem) => void) {
  return {
    backendBaseUrl: state.settings.backendBaseUrl,
    retailer: effectiveRetailer(),
    storeId: effectiveStoreId(),
    zip: effectiveZip(),
    fulfillmentMode: effectiveFulfillmentMode(),
    onResult: ({ item }: { item: PreparedItem }) => onResult(item),
  };
}

function setPreparing(value: boolean) {
  preparing = value;
  const disabled = value || !hasShoppingContext();
  elements.prepareList.disabled = disabled;
  elements.prepareAgain.disabled = disabled;
  if (isComparisonMode()) {
    elements.prepareButtonLabel.textContent = value ? "Comparing automatically…" : "Comparison starts after you pause";
    renderResults();
    renderGuidedFlow();
    return;
  }
  const name = retailerName();
  elements.prepareButtonLabel.textContent = value
    ? `Finding your ${name} matches…`
    : effectiveRetailer() === "target"
      ? "Find my Target matches"
      : effectiveRetailer() === "kroger" ? `Build my ${name} cart` : "Build my Walmart cart";
  renderResults();
  renderGuidedFlow();
}

function cancelActivePreparation() {
  prepareSequence += 1;
  backendClient.cancel();
  comparisonClient.cancel();
  if (preparing) setPreparing(false);
}

function invalidateComparison() {
  comparisonClient.cancel();
  state.comparison = undefined;
}

function automaticComparisonDesiredKey() {
  const parsedItems = comparisonParsedItems();
  if (!isComparisonMode()
    || comparisonEditingStores
    || comparisonLookupPending
    || parsedItems.length === 0
    || configuredComparisonRetailers().length < 2) return undefined;
  return automaticComparisonKey(parsedItems, comparisonContexts());
}

function scheduleAutomaticComparison() {
  if (comparisonAutoPrepareTimer !== undefined) {
    window.clearTimeout(comparisonAutoPrepareTimer);
    comparisonAutoPrepareTimer = undefined;
  }
  const expectedKey = automaticComparisonDesiredKey();
  const currentKey = currentComparison() ? expectedKey : undefined;
  if (!shouldStartAutomaticComparison(expectedKey, currentKey, automaticComparisonInFlightKey)) return;
  const delay = automaticComparisonDelay(Date.now(), lastAutomaticComparisonStartedAt);
  comparisonAutoPrepareTimer = window.setTimeout(() => {
    comparisonAutoPrepareTimer = undefined;
    const currentKey = automaticComparisonDesiredKey();
    if (!currentKey || currentKey !== expectedKey || automaticComparisonInFlightKey === currentKey) return;
    if (currentComparison()) return;
    lastAutomaticComparisonStartedAt = Date.now();
    void prepareComparisonList({ expectedKey: currentKey });
  }, delay);
}

function scheduleComparisonZipLookup() {
  if (comparisonZipLookupTimer !== undefined) window.clearTimeout(comparisonZipLookupTimer);
  comparisonZipLookupTimer = undefined;
  const zip = elements.comparisonZip.value.replace(/\D/g, "").slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return;
  comparisonZipLookupTimer = window.setTimeout(() => {
    comparisonZipLookupTimer = undefined;
    void findComparisonStores(zip);
  }, AUTO_COMPARE_ZIP_DEBOUNCE_MS);
}

async function findComparisonStores(zipValue = elements.comparisonZip.value, force = false) {
  let zip: string;
  try {
    zip = normalizePickupZip(zipValue);
  } catch (error) {
    elements.comparisonZip.setAttribute("aria-invalid", "true");
    comparisonLookupMessage = error instanceof Error ? error.message : "Enter a valid 5-digit ZIP code.";
    renderComparisonSetup();
    return;
  }
  if (!force && (activeComparisonLookupZip === zip || (
    lastCompletedComparisonLookupZip === zip
    && state.settings.targetZip === zip
    && configuredComparisonRetailers().length >= 2
  ))) {
    comparisonEditingStores = false;
    scheduleAutomaticComparison();
    return;
  }
  let backendUrl: string;
  try {
    backendUrl = normalizeBackendUrl(state.settings.backendBaseUrl);
  } catch (error) {
    comparisonLookupMessage = error instanceof Error ? error.message : "Set a valid Cartiva backend URL.";
    renderComparisonSetup();
    return;
  }
  elements.comparisonZip.removeAttribute("aria-invalid");
  storeLookupController?.abort();
  const controller = new AbortController();
  storeLookupController = controller;
  activeComparisonLookupZip = zip;
  comparisonLookupPending = true;
  comparisonEditingStores = true;
  comparisonLookupRetryAvailable = false;
  comparisonLookupMessage = `Automatically selecting store contexts for ZIP ${zip}…`;
  const savedWalmart = state.settings.selectedStore;
  const savedKroger = state.settings.krogerStore;
  state.settings.selectedStore = undefined;
  state.settings.krogerStore = undefined;
  storeLookupResults = [];
  krogerStoreLookupResults = [];
  state.settings.targetZip = zip;
  state.settings.targetStoreId = undefined;
  state.settings.pickupZip = zip;
  state.settings.krogerZip = zip;
  state.settings.targetFulfillmentMode = "delivery";
  state.settings.krogerFulfillmentMode = "delivery";
  state.settings.fulfillmentModeOverride = "delivery";
  cancelActivePreparation();
  invalidateComparison();
  renderComparisonSetup();
  try {
    const permitted = await backendClient.ensureBackendPermission(backendUrl);
    if (!permitted) throw new Error("Cartiva needs permission to reach the local backend.");
    const [walmartResult, krogerResult] = await Promise.allSettled([
      backendClient.findPickupStores(zip, backendUrl, controller.signal),
      backendClient.findKrogerStores(zip, backendUrl, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    storeLookupResults = walmartResult.status === "fulfilled" ? walmartResult.value.stores : [];
    krogerStoreLookupResults = krogerResult.status === "fulfilled" ? krogerResult.value.stores : [];
    state.settings.selectedStore = automaticallySelectedStore(storeLookupResults, savedWalmart, zip);
    state.settings.krogerStore = automaticallySelectedStore(krogerStoreLookupResults, savedKroger, zip);
    const found = Number(Boolean(state.settings.selectedStore)) + Number(Boolean(state.settings.krogerStore));
    comparisonLookupMessage = found === 2
      ? "Walmart and Kroger locations were automatically selected for your ZIP. Target uses a ZIP-localized estimate."
      : found === 1
        ? "One store was automatically selected for your ZIP. Target is also ready with a ZIP-localized estimate."
        : "Store directories did not answer. Target is ready, but Cartiva needs one more retailer before comparing.";
    comparisonLookupRetryAvailable = found === 0;
    lastCompletedComparisonLookupZip = zip;
    comparisonEditingStores = configuredComparisonRetailers().length < 2;
    await persistState();
  } catch (error) {
    if (!controller.signal.aborted) {
      comparisonLookupMessage = error instanceof Error ? error.message : "Cartiva could not load comparison stores.";
      comparisonLookupRetryAvailable = true;
    }
  } finally {
    if (storeLookupController === controller) {
      storeLookupController = undefined;
      if (activeComparisonLookupZip === zip) activeComparisonLookupZip = undefined;
      comparisonLookupPending = false;
      renderAll();
      scheduleAutomaticComparison();
    }
  }
}

async function findPickupStores() {
  let zip: string;
  try {
    zip = normalizePickupZip(elements.pickupZip.value);
  } catch (error) {
    elements.pickupZip.setAttribute("aria-invalid", "true");
    storeLookupMessage = error instanceof Error ? error.message : "Enter a valid 5-digit ZIP code.";
    renderStorePicker();
    return;
  }

  if (effectiveRetailer() === "target") {
    const previousContext = shoppingContextKey();
    const storeId = elements.targetStoreId.value.replace(/\D/g, "").slice(0, 4);
    if (effectiveFulfillmentMode() === "pickup" && !/^\d{3,4}$/.test(storeId)) {
      elements.targetStoreId.setAttribute("aria-invalid", "true");
      storeLookupMessage = "Pickup needs the 3- or 4-digit Target store ID. Choose delivery or shipping if you do not know it.";
      renderAll();
      elements.targetStoreId.focus();
      return;
    }
    elements.targetStoreId.removeAttribute("aria-invalid");
    state.settings.targetZip = zip;
    state.settings.targetStoreId = storeId || undefined;
    if (previousContext !== shoppingContextKey()) {
      cancelActivePreparation();
      invalidatePreparedItems("Your Target shopping area changed. Find the products again to refresh prices.", true);
    }
    storeLookupMessage = `Target ${effectiveFulfillmentMode()} estimates are set for ZIP ${zip}.`;
    await persistState();
    renderAll();
    showToast("Target shopping area saved.");
    return;
  }

  let backendUrl: string;
  try {
    backendUrl = normalizeBackendUrl(state.settings.backendBaseUrl);
  } catch (error) {
    storeLookupMessage = error instanceof Error ? error.message : "Set a valid Cartiva backend URL.";
    renderStorePicker();
    return;
  }

  if (effectiveRetailer() === "kroger") {
    storeLookupController?.abort();
    elements.pickupZip.removeAttribute("aria-invalid");
    const controller = new AbortController();
    storeLookupController = controller;
    storeLookupPending = true;
    krogerStoreLookupResults = [];
    storeLookupMessage = `Finding Kroger-family stores near ZIP ${zip}…`;
    renderStorePicker();
    try {
      const permitted = await backendClient.ensureBackendPermission(backendUrl);
      if (!permitted) throw new Error("Cartiva needs permission to reach the local backend.");
      const result: KrogerStoreLookupResult = await backendClient.findKrogerStores(zip, backendUrl, controller.signal);
      if (controller.signal.aborted) return;
      const selectedStoreChanged = Boolean(
        state.settings.krogerStore && !result.stores.some((store) => store.id === state.settings.krogerStore?.id),
      );
      if (selectedStoreChanged) {
        cancelActivePreparation();
        invalidatePreparedItems("Your Kroger-family store changed. Prepare the list again for exact local prices.", true);
      }
      krogerStoreLookupResults = result.stores;
      state.settings.krogerZip = result.zipCode;
      if (selectedStoreChanged) state.settings.krogerStore = undefined;
      storeLookupMessage = result.stores.length
        ? `Choose one of ${result.stores.length} official stores near ZIP ${result.zipCode}.`
        : `Kroger returned no nearby stores for ZIP ${result.zipCode}.`;
      await persistState();
    } catch (error) {
      if (controller.signal.aborted) return;
      krogerStoreLookupResults = [];
      storeLookupMessage = error instanceof Error ? error.message : "Cartiva could not find Kroger-family stores for that ZIP.";
    } finally {
      if (storeLookupController === controller) {
        storeLookupController = undefined;
        storeLookupPending = false;
        renderStorePicker();
      }
    }
    return;
  }

  storeLookupController?.abort();
  elements.pickupZip.removeAttribute("aria-invalid");
  const controller = new AbortController();
  storeLookupController = controller;
  storeLookupPending = true;
  storeLookupResults = [];
  storeLookupMessage = `Finding pickup Walmarts in ZIP ${zip}…`;
  renderStorePicker();
  try {
    let result: WalmartStoreLookupResult;
    try {
      const permitted = await backendClient.ensureBackendPermission(backendUrl);
      if (!permitted) throw new Error("Cartiva needs permission to reach the local backend.");
      result = await backendClient.findPickupStores(zip, backendUrl, controller.signal);
    } catch (backendError) {
      if (controller.signal.aborted) return;
      storeLookupMessage = `The Cartiva server is unavailable. Checking Walmart's visible store finder near ${zip}…`;
      renderStorePicker();
      try {
        const nearby = await sendBackground<WalmartNearbyStoreResult>({
          type: "CARTIVA_FIND_NEARBY_PICKUP_STORES",
          zipCode: zip,
          tabId: storeFinderTabId ?? state.pageContext.tabId,
        });
        storeFinderTabId = nearby.tabId;
        result = { zipCode: zip, stores: nearby.stores };
      } catch {
        throw backendError;
      }
    }
    if (controller.signal.aborted) return;
    let stores = result.stores;
    let lookupMessage: string;
    if (stores.length) {
      storeFinderTabId = undefined;
      const exactZip = stores.every((store) => store.zip === result.zipCode);
      lookupMessage = `Choose one of ${stores.length} ${stores.length === 1 ? "store" : "stores"} ${exactZip ? "in" : "near"} ZIP ${result.zipCode}.`;
    } else {
      storeLookupMessage = `No exact-ZIP directory match. Checking Walmart's visible store finder near ${zip}…`;
      renderStorePicker();
      const nearby = await sendBackground<WalmartNearbyStoreResult>({
        type: "CARTIVA_FIND_NEARBY_PICKUP_STORES",
        zipCode: zip,
        tabId: storeFinderTabId ?? state.pageContext.tabId,
      });
      if (controller.signal.aborted) return;
      stores = nearby.stores;
      storeFinderTabId = nearby.tabId;
      lookupMessage = `Walmart showed ${stores.length} ${stores.length === 1 ? "store" : "stores"} near ZIP ${nearby.zipCode}.`;
    }
    const selectedStoreChanged = Boolean(
      state.settings.selectedStore && state.settings.selectedStore.zip !== result.zipCode,
    );
    if (selectedStoreChanged) {
      cancelActivePreparation();
      invalidatePreparedItems("Your selected Walmart store was cleared when you searched a different ZIP. Choose a store and prepare the list again.");
    }
    storeLookupResults = stores;
    state.settings = {
      ...state.settings,
      backendBaseUrl: backendUrl,
      pickupZip: result.zipCode,
      selectedStore: selectedStoreChanged ? undefined : state.settings.selectedStore,
      storeIdOverride: undefined,
    };
    storeLookupMessage = lookupMessage;
    await persistState();
  } catch (error) {
    if (controller.signal.aborted) return;
    storeLookupResults = [];
    storeLookupMessage = error instanceof Error ? error.message : "Cartiva could not find Walmart stores for that ZIP.";
  } finally {
    if (storeLookupController === controller) {
      storeLookupController = undefined;
      storeLookupPending = false;
      renderStorePicker();
    }
  }
}

async function chooseKrogerStore(store: KrogerStoreOption) {
  const previousContext = shoppingContextKey();
  state.settings.krogerStore = { ...store };
  state.settings.krogerZip = store.zip;
  state.settings.krogerFulfillmentMode ??= "pickup";
  state.settings.krogerCartUrl = undefined;
  krogerCartUrl = "https://www.kroger.com/cart";
  elements.storePicker.open = false;
  storeLookupMessage = `${store.chain} at ${store.address} is selected.`;
  if (previousContext !== shoppingContextKey()) {
    cancelActivePreparation();
    invalidatePreparedItems(`Your ${store.chain} store changed. Prepare the list again for exact local prices.`, true);
  }
  await persistState();
  renderAll();
  showToast(`${store.chain} selected. Official local search is ready.`);
}

async function refreshKrogerOAuthStatus(showFailure = false) {
  if (krogerOAuthChecking) return krogerOAuthConnected;
  krogerOAuthChecking = true;
  renderContext();
  try {
    const status = await backendClient.getKrogerOAuthStatus(state.settings.backendBaseUrl);
    krogerOAuthConnected = status.connected;
    return status.connected;
  } catch (error) {
    krogerOAuthConnected = false;
    if (showFailure) showToast(error instanceof Error ? error.message : "Cartiva could not check the Kroger connection.");
    return false;
  } finally {
    krogerOAuthChecking = false;
    renderContext();
  }
}

async function connectKrogerAccount() {
  try {
    const permitted = await backendClient.ensureBackendPermission(state.settings.backendBaseUrl);
    if (!permitted) throw new Error("Cartiva needs permission to reach the local backend.");
    await sendBackground({
      type: "CARTIVA_OPEN_KROGER_URL",
      url: await backendClient.startKrogerOAuth(state.settings.backendBaseUrl),
    });
    showToast("Finish Kroger sign-in in the new tab. Cartiva will reconnect automatically.");
    if (krogerConnectionPoll !== undefined) window.clearInterval(krogerConnectionPoll);
    let attempts = 0;
    krogerConnectionPoll = window.setInterval(() => {
      attempts += 1;
      void refreshKrogerOAuthStatus(false).then((connected) => {
        if (connected || attempts >= 90) {
          if (krogerConnectionPoll !== undefined) window.clearInterval(krogerConnectionPoll);
          krogerConnectionPoll = undefined;
          if (connected) {
            showToast("Kroger connected. Official cart adding is ready.");
            if (buildEligibleItems().length) void startKrogerCartBuild();
          }
        }
      });
    }, 1_500);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Cartiva could not open Kroger sign-in.");
  }
}

async function disconnectKrogerAccount() {
  if (krogerConnectionPoll !== undefined) window.clearInterval(krogerConnectionPoll);
  krogerConnectionPoll = undefined;
  krogerOAuthChecking = true;
  renderContext();
  try {
    await backendClient.disconnectKrogerOAuth(state.settings.backendBaseUrl);
    krogerOAuthConnected = false;
    showToast("Kroger disconnected. Product search still works; reconnect when you want Cartiva to add a cart.");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Cartiva could not disconnect Kroger.");
  } finally {
    krogerOAuthChecking = false;
    renderAll();
  }
}

async function choosePickupStore(store: WalmartStoreOption) {
  if (!isWalmartStoreOption(store)) return;
  const previousStoreId = effectiveStoreId();
  state.settings = settingsWithSelectedStore(state.settings, store);
  elements.storePicker.open = false;
  storeLookupMessage = `${store.address} is selected for Cartiva pickup estimates.`;
  if (previousStoreId !== store.id) {
    cancelActivePreparation();
    invalidatePreparedItems("Your Walmart store changed. Prepare the list again to verify every price for the selected store.");
  }
  await persistState();
  renderAll();

  try {
    const applied = await sendBackground<WalmartStoreApplyResult>({
      type: "CARTIVA_SELECT_PICKUP_STORE",
      store,
      tabId: storeFinderTabId ?? state.pageContext.tabId,
    });
    if (applied.context) {
      state.pageContext = applied.context;
      if (applied.context.storeId === store.id && state.settings.selectedStore?.id === store.id) {
        state.settings = {
          ...state.settings,
          selectedStore: {
            ...state.settings.selectedStore,
            name: applied.context.storeName
              ? storeNameForDisplay(applied.context.storeName)
              : state.settings.selectedStore.name,
            address: applied.context.address?.trim() || state.settings.selectedStore.address,
          },
        };
      }
    }
    storeLookupMessage = applied.pickupConfirmed
      ? `${store.address} is selected in Cartiva and Walmart.`
      : `${store.address} is selected in Cartiva. Confirm the same pickup store on Walmart before building.`;
    await persistState();
    renderAll();
  } catch {
    storeLookupMessage = `${store.address} is selected in Cartiva. Confirm the same pickup store on Walmart before building.`;
    renderAll();
  }
}

function updateComparisonRetailerItem(retailer: Retailer, next: PreparedItem) {
  const comparison = state.comparison;
  if (!comparison) return;
  const retailerState = comparison.retailers[retailer];
  const index = retailerState.items.findIndex((item) => item.id === next.id);
  if (index < 0) retailerState.items.push(next);
  else retailerState.items[index] = next;
  retailerState.updatedAt = new Date().toISOString();
  comparison.updatedAt = retailerState.updatedAt;
  void persistState();
  renderComparisonResults();
}

async function prepareComparisonList(options: { force?: boolean; expectedKey?: string } = {}) {
  comparisonEditingStores = false;
  showError(elements.entryError);
  const parsedItems = comparisonParsedItems();
  if (!parsedItems.length) {
    showError(elements.entryError, "Add at least one grocery item before comparing stores.");
    elements.shoppingList.focus();
    return;
  }
  const configured = configuredComparisonRetailers();
  if (configured.length < 2) {
    showError(elements.entryError, "Enter your ZIP and wait for at least two retailer contexts before comparing prices.");
    elements.locationStep.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  let backendUrl: string;
  try {
    backendUrl = normalizeBackendUrl(state.settings.backendBaseUrl);
  } catch (error) {
    showError(elements.entryError, error instanceof Error ? error.message : "Set a valid Cartiva backend URL.");
    return;
  }
  const sequence = ++prepareSequence;
  const contexts = comparisonContexts();
  const runKey = automaticComparisonKey(parsedItems, contexts);
  if (options.expectedKey && options.expectedKey !== runKey) return;
  if (!options.force && currentComparison()) return;
  if (options.expectedKey && automaticComparisonInFlightKey === runKey) return;
  if (options.expectedKey) automaticComparisonInFlightKey = runKey;
  const timestamp = new Date().toISOString();
  const comparison = emptyComparisonSearchState(comparisonListSignature(parsedItems), contexts, parsedItems.length);
  comparison.status = "searching";
  comparison.startedAt = timestamp;
  comparison.updatedAt = timestamp;
  for (const retailer of COMPARISON_RETAILERS) {
    comparison.retailers[retailer] = {
      ...comparison.retailers[retailer],
      status: configured.includes(retailer) ? "searching" : "error",
      error: configured.includes(retailer) ? undefined : "This retailer is unavailable for the current ZIP.",
      items: configured.includes(retailer)
        ? parsedItems.map((request) => ({
            id: request.id,
            request,
            retailer,
            matchStatus: "searching",
            alternatives: [],
            cartStatus: "ready",
          }))
        : [],
      updatedAt: timestamp,
    };
  }
  state.settings.backendBaseUrl = backendUrl;
  state.listText = elements.shoppingList.value;
  state.parsedItems = parsedItems;
  state.comparison = comparison;
  setPreparing(true);
  await persistState();
  renderAll();
  elements.comparisonResultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const permitted = await backendClient.ensureBackendPermission(backendUrl);
    if (!permitted) throw new Error("Cartiva needs permission to connect to the configured backend.");
    const retailerOptions = Object.fromEntries(configured.map((retailer) => [retailer, contexts[retailer]]));
    await comparisonClient.prepare(parsedItems, {
      backendBaseUrl: backendUrl,
      retailers: retailerOptions,
      onResult: (retailer, result) => {
        if (sequence !== prepareSequence || state.comparison !== comparison) return;
        updateComparisonRetailerItem(retailer, result.item);
      },
      onRetailerComplete: (retailer, items) => {
        if (sequence !== prepareSequence || state.comparison !== comparison) return;
        comparison.retailers[retailer] = {
          ...comparison.retailers[retailer],
          status: "complete",
          items,
          error: undefined,
          updatedAt: new Date().toISOString(),
        };
        comparison.updatedAt = comparison.retailers[retailer].updatedAt;
        void persistState();
        renderComparisonResults();
      },
      onRetailerError: (retailer, error) => {
        if (sequence !== prepareSequence || state.comparison !== comparison) return;
        comparison.retailers[retailer] = {
          ...comparison.retailers[retailer],
          status: "error",
          error: error.message,
          updatedAt: new Date().toISOString(),
        };
        comparison.updatedAt = comparison.retailers[retailer].updatedAt;
        void persistState();
        renderComparisonResults();
      },
    });
  } catch (error) {
    if (sequence === prepareSequence && state.comparison === comparison) {
      for (const retailer of configured) {
        if (comparison.retailers[retailer].status === "searching") {
          comparison.retailers[retailer].status = "error";
          comparison.retailers[retailer].error = error instanceof Error ? error.message : "Retailer search failed.";
        }
      }
      showError(elements.entryError, error instanceof Error ? error.message : "Cartiva could not compare these stores.");
    }
  } finally {
    if (sequence === prepareSequence && state.comparison === comparison) {
      comparison.status = COMPARISON_RETAILERS.some((retailer) => comparison.retailers[retailer].status === "searching")
        ? "searching"
        : "complete";
      comparison.updatedAt = new Date().toISOString();
      setPreparing(false);
      await persistState();
      renderAll();
    }
    if (automaticComparisonInFlightKey === runKey) automaticComparisonInFlightKey = undefined;
  }
}

async function prepareCurrentList() {
  if (isComparisonMode()) {
    await prepareComparisonList({ force: true });
    return;
  }
  showError(elements.entryError);
  const parsedItems = parseListWithPreferredProducts(elements.shoppingList.value);
  if (!parsedItems.length) {
    showError(elements.entryError, "Add at least one grocery item before preparing the list.");
    elements.shoppingList.focus();
    return;
  }
  if (!hasShoppingContext()) {
    showError(
      elements.entryError,
      effectiveRetailer() === "target"
        ? effectiveFulfillmentMode() === "pickup"
          ? "Enter your ZIP and Target store ID before searching pickup products."
          : "Enter your ZIP before searching Target products."
        : effectiveRetailer() === "kroger"
          ? "Enter your ZIP and choose a Kroger-family store before searching products."
        : "Choose a Walmart store by ZIP before preparing your list.",
    );
    elements.pickupZip.focus();
    return;
  }

  let backendUrl: string;
  try {
    backendUrl = normalizeBackendUrl(state.settings.backendBaseUrl);
  } catch (error) {
    showError(elements.entryError, error instanceof Error ? error.message : "Set a valid Cartiva backend URL.");
    return;
  }

  const automaticCartBuildActionId = ++nextAutomaticCartBuildActionId;
  automaticCartBuildRetryAvailable = false;
  const sequence = ++prepareSequence;
  let preparationSucceeded = false;
  setPreparing(true);
  try {
    const permitted = await backendClient.ensureBackendPermission(backendUrl);
    if (!permitted) throw new Error("Cartiva needs permission to connect to the configured backend.");

    state.settings.backendBaseUrl = backendUrl;
    state.listText = elements.shoppingList.value;
    state.parsedItems = parsedItems;
    state.lastPreparedAt = new Date().toISOString();
    if (effectiveRetailer() === "kroger") {
      state.settings.krogerCartUrl = undefined;
      krogerCartUrl = "https://www.kroger.com/cart";
    }
    state.preparedItems = parsedItems.map((request) => ({
      id: request.id,
      request,
      retailer: effectiveRetailer(),
      matchStatus: "searching",
      alternatives: [],
      cartStatus: "ready",
    }));
    elements.resultList.scrollTop = 0;
    await persistState();
    renderAll();
    elements.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });

    await backendClient.prepare(parsedItems, prepareOptions((item) => {
      if (sequence !== prepareSequence) return;
      updatePreparedItem(item);
    }));
    preparationSucceeded = true;
  } catch (error) {
    if (sequence === prepareSequence) {
      showError(elements.entryError, error instanceof Error ? error.message : "Cartiva could not prepare the list.");
    }
  } finally {
    const sequenceCurrent = sequence === prepareSequence;
    if (sequenceCurrent) setPreparing(false);
    await maybeStartAutomaticCartBuild(
      automaticCartBuildActionId,
      preparationSucceeded,
      sequenceCurrent,
    );
  }
}

async function reprepareSingle(original: PreparedItem, query: string) {
  const text = query.trim();
  if (!text) {
    showToast("Enter a product or description to search again.");
    return;
  }
  const sequence = ++prepareSequence;
  state.lastPreparedAt = new Date().toISOString();
  if (effectiveRetailer() === "kroger") {
    state.settings.krogerCartOperationId = crypto.randomUUID();
  }
  setPreparing(true);
  try {
    const permitted = await backendClient.ensureBackendPermission(state.settings.backendBaseUrl);
    if (!permitted) throw new Error("Cartiva needs permission to reach the configured backend.");
    const request: ParsedListItem = {
      id: original.id,
      text,
      normalizedText: normalizeListItem(text),
      quantity: original.request.quantity,
      ...extractExplicitRequestDetails(text),
    };
    updatePreparedItem({
      ...original,
      matchStatus: "searching",
      alternatives: [],
      explanation: undefined,
      cartStatus: "ready",
      retailer: effectiveRetailer(),
    });
    await backendClient.prepare([request], prepareOptions((item) => {
      if (sequence !== prepareSequence) return;
      updatePreparedItem({ ...item, id: original.id, request: original.request });
    }));
    document.getElementById(`prepared-${original.id}`)?.focus({ preventScroll: false });
  } catch (error) {
    if (sequence === prepareSequence) {
      showToast(error instanceof Error ? error.message : "Cartiva could not search for another option.");
      updatePreparedItem({ ...original, matchStatus: "api_error", cartStatus: "failed" });
    }
  } finally {
    if (sequence === prepareSequence) setPreparing(false);
  }
}

function buildEligibleItems() {
  const mode = effectiveFulfillmentMode();
  return mode === "unknown"
    ? []
    : state.preparedItems.filter((item) => cartEligibleMatch(item)
      && (effectiveRetailer() !== "kroger" || (
        item.cartStatus !== "added"
        && item.cartRetrySafe !== false
      )));
}

async function startKrogerCartBuild(): Promise<boolean> {
  if (krogerCartPending) return false;
  const store = state.settings.krogerStore;
  const eligible = buildEligibleItems();
  if (!store || !eligible.length) return false;
  let connected = krogerOAuthConnected;
  if (!connected) connected = await refreshKrogerOAuthStatus(false);
  if (!connected) {
    renderAll();
    showToast("Connect your Kroger account once, then Cartiva will add these official matches automatically.");
    return false;
  }
  krogerCartPending = true;
  const eligibleIds = new Set(eligible.map((item) => item.id));
  const fulfillmentMode = effectiveFulfillmentMode();
  if (fulfillmentMode !== "pickup" && fulfillmentMode !== "delivery") {
    showToast("Choose Kroger pickup or delivery before adding products.");
    krogerCartPending = false;
    return false;
  }
  const cartItems = canonicalKrogerCartItems(eligible.map((item) => ({
    upc: item.product!.upc!,
    quantity: item.request.quantity,
  })));
  const operationId = await krogerCartOperationId(store.id, fulfillmentMode, cartItems);
  state.settings.krogerCartOperationId = operationId;
  state.preparedItems = state.preparedItems.map((item) => eligibleIds.has(item.id)
    ? {
        ...item,
        cartStatus: "adding",
        cartMessage: "Sending verified UPC to Kroger…",
        cartErrorCode: undefined,
        cartRetrySafe: undefined,
      }
    : item);
  await persistState();
  renderAll();
  try {
    const result = await backendClient.addKrogerCart(state.settings.backendBaseUrl, {
      locationId: store.id,
      fulfillmentMode,
      operationId,
      items: cartItems,
    });
    if (!result.success) throw new Error(result.message ?? "Kroger did not accept the cart request.");
    krogerCartUrl = result.cartUrl;
    state.settings.krogerCartUrl = result.cartUrl;
    state.preparedItems = state.preparedItems.map((item) => eligibleIds.has(item.id)
      ? {
          ...item,
          cartStatus: "added",
          cartMessage: "Kroger accepted this item. Verify the active store, quantity, and price in the cart.",
          cartErrorCode: undefined,
          cartRetrySafe: undefined,
        }
      : item);
    await persistState();
    await sendBackground({ type: "CARTIVA_OPEN_KROGER_URL", url: krogerCartUrl });
    showToast(`${result.addedCount} ${result.addedCount === 1 ? "item was" : "items were"} accepted. Review your ${store.chain} cart.`);
    return true;
  } catch (error) {
    const cartError = error instanceof KrogerCartError ? error : undefined;
    const outcomeUnknown = cartError?.retrySafe === false || cartError?.code === "outcome_unknown";
    if (cartError?.status === 401) krogerOAuthConnected = false;
    state.preparedItems = state.preparedItems.map((item) => eligibleIds.has(item.id)
      ? {
          ...item,
          cartStatus: outcomeUnknown ? "needs_choice" : "failed",
          cartMessage: outcomeUnknown
            ? `${error instanceof Error ? error.message : "Kroger did not confirm this cart request."} Cartiva will not retry it. Check the cart, then prepare only missing products as a new list.`
            : cartError?.status === 401
              ? "Your Kroger sign-in expired. Reconnect once and Cartiva can safely continue this protected request."
              : `${error instanceof Error ? error.message : "Kroger did not finish this cart request."} This protected request is safe to retry.`,
          cartErrorCode: cartError?.code,
          cartRetrySafe: outcomeUnknown ? false : cartError?.retrySafe,
        }
      : item);
    await persistState();
    if (outcomeUnknown) {
      try {
        await sendBackground({ type: "CARTIVA_OPEN_KROGER_URL", url: krogerCartUrl });
      } catch {
        // The persistent "Open cart to check" action remains available.
      }
      showToast("Kroger did not confirm the result. Cartiva will not retry; check the cart now.");
    } else if (cartError?.status === 401) {
      showToast("Your Kroger sign-in expired. Connect again to continue safely.");
    } else {
      showToast(error instanceof Error ? error.message : "Cartiva could not add the Kroger cart.");
    }
    return false;
  } finally {
    krogerCartPending = false;
    renderAll();
  }
}

function storeIdForBuild(items: PreparedItem[]) {
  const store = effectiveStore();
  if (!store || !items.length) return undefined;
  return items.every((item) => item.product?.priceProvenance?.requestedStoreId === store.id)
    ? store.id
    : undefined;
}

async function maybeStartAutomaticCartBuild(
  actionId: number,
  preparationSucceeded: boolean,
  sequenceCurrent: boolean,
) {
  if (effectiveRetailer() === "kroger") {
    if (!Number.isInteger(actionId) || actionId <= lastHandledAutomaticCartBuildActionId) return;
    lastHandledAutomaticCartBuildActionId = actionId;
    if (preparationSucceeded && sequenceCurrent && buildEligibleItems().length > 0) {
      await startKrogerCartBuild();
    }
    return;
  }
  const eligible = buildEligibleItems();
  const hasBuildContext = effectiveRetailer() === "target"
    ? hasShoppingContext()
    : Boolean(storeIdForBuild(eligible));

  if (
    preparationSucceeded
    && sequenceCurrent
    && eligible.length > 0
    && hasBuildContext
    && !blockingCartBuild(cartBuild)
  ) {
    try {
      const savedBuild = recoverCartBuild(
        await sendBackground<CartBuildState | null>({ type: "CARTIVA_GET_CART_BUILD" }),
      );
      if (blockingCartBuild(savedBuild)) cartBuild = savedBuild;
    } catch {
      // The normal start request below will surface a background failure and
      // leave the explicit retry control available.
    }
  }

  const decision = claimAutomaticCartBuild(actionId, lastHandledAutomaticCartBuildActionId, {
    preparationSucceeded,
    sequenceCurrent,
    preparing,
    eligibleItemCount: eligible.length,
    hasPreparedStore: hasBuildContext,
    buildStartPending,
    blockingBuild: Boolean(blockingCartBuild(cartBuild)),
  });
  lastHandledAutomaticCartBuildActionId = decision.lastHandledActionId;

  if (decision.shouldStart) {
    automaticCartBuildRetryAvailable = !(await startCartBuild({ automatic: true }));
    renderResults();
    renderCartProgress();
  } else if (blockingCartBuild(cartBuild)) {
    renderAll();
  }
}

function openConfirmation() {
  const eligible = buildEligibleItems();
  if (!eligible.length || preparing) return;
  const targetMode = effectiveRetailer() === "target";
  if (!targetMode && !storeIdForBuild(eligible)) {
    showToast("Choose a Walmart store and prepare the list again before building the cart.");
    return;
  }
  const retailerName = targetMode ? "Target" : "Walmart";
  elements.confirmationTitle.textContent = `Add these reliable matches to your ${retailerName} cart?`;
  elements.confirmationDescription.textContent = `Cartiva will add products one at a time and wait for ${retailerName} to visibly confirm each addition.`;
  elements.confirmationItemCount.textContent = `${eligible.length} verified ${eligible.length === 1 ? "item" : "items"}`;
  const subtotal = targetMode
    ? targetEstimateSubtotalCents(eligible, effectiveFulfillmentMode())
    : verifiedSubtotalCents(eligible, effectiveFulfillmentMode(), Date.now(), storeIdForBuild(eligible));
  elements.confirmationSubtotal.textContent = `${formatCurrency(subtotal)} estimated subtotal`;
  elements.confirmation.showModal();
  elements.cancelConfirmation.focus();
}

async function startCartBuild(options: { automatic?: boolean } = {}): Promise<boolean> {
  if (buildStartPending) return false;
  const eligible = buildEligibleItems();
  if (!eligible.length) {
    if (elements.confirmation.open) elements.confirmation.close();
    showToast(`No reliable live ${effectiveRetailer() === "target" ? "Target" : "Walmart"} products are ready to add.`);
    return false;
  }
  let startedOrRecovered = false;
  buildStartPending = true;
  elements.confirmCartBuild.disabled = true;
  elements.confirmCartBuild.textContent = "Starting…";
  renderResults();
  try {
    const fulfillmentMode = effectiveFulfillmentMode();
    if (fulfillmentMode === "unknown") {
      throw new Error("Choose pickup, delivery, or shipping before building the cart.");
    }
    const targetMode = effectiveRetailer() === "target";
    const items = eligible.map((item) => {
      const product = item.product!;
      const itemId = targetMode ? product.productId?.replace(/^A-/i, "") : product.itemId;
      if (!itemId) throw new Error(`A verified ${targetMode ? "Target TCIN" : "Walmart item ID"} is missing.`);
      return {
        id: item.id,
        requestedText: item.request.text,
        productTitle: product.title,
        itemId,
        productId: product.productId,
        productUrl: product.link,
        priceCents: product.priceCents!,
        checkedAt: item.checkedAt ?? product.checkedAt!,
        quantity: item.request.quantity,
      } satisfies Omit<CartBuildItem, "status">;
    });
    const storeId = targetMode ? state.settings.targetStoreId : storeIdForBuild(eligible);
    const store = effectiveStore();
    if (!targetMode && !storeId) {
      throw new Error("Cartiva could not prove that every product uses your selected Walmart store. Choose the store again and refresh prices.");
    }
    const startedBuild = await sendBackground<CartBuildState>({
      type: "CARTIVA_START_CART_BUILD",
      retailer: targetMode ? "target" : "walmart",
      confirmed: true,
      items,
      storeId,
      storeName: store?.name,
      storeAddress: store?.address,
      zip: targetMode ? state.settings.targetZip : store?.zip,
      fulfillmentMode,
    });
    cartBuild = recoverCartBuild(startedBuild);
    if (!cartBuild) throw new Error("Cartiva returned an invalid cart-build state. Nothing else was added.");
    startedOrRecovered = true;
    automaticCartBuildRetryAvailable = false;
    if (elements.confirmation.open) elements.confirmation.close();
    renderAll();
    if (!options.automatic) {
      elements.cartProgressSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    let surfacedExistingBuild = false;
    try {
      const existing = recoverCartBuild(
        await sendBackground<CartBuildState | null>({ type: "CARTIVA_GET_CART_BUILD" }),
      );
      if (existing && ["running", "paused"].includes(existing.status)) {
        cartBuild = existing;
        startedOrRecovered = true;
        automaticCartBuildRetryAvailable = false;
        if (elements.confirmation.open) elements.confirmation.close();
        renderAll();
        if (!options.automatic) {
          elements.cartProgressSection.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        showToast("An earlier retailer cart build is still active. Continue or cancel it below.");
        surfacedExistingBuild = true;
      }
    } catch {
      // Preserve the original start error when recovery state cannot be read.
    }
    if (!surfacedExistingBuild) {
      showToast(error instanceof Error ? error.message : "Cartiva could not start the cart build.");
    }
  } finally {
    buildStartPending = false;
    elements.confirmCartBuild.disabled = false;
    elements.confirmCartBuild.textContent = "Yes, build my cart";
    renderResults();
    renderCartProgress();
  }
  return startedOrRecovered;
}

async function refreshPageContext(showFailure = true) {
  elements.refreshContext.classList.add("is-loading");
  elements.refreshContext.disabled = true;
  try {
    const previousContext = shoppingContextKey();
    const nextContext = await sendBackground<WalmartPageContext>({ type: "CARTIVA_GET_PAGE_CONTEXT" });
    state.pageContext = nextContext;
    if (previousContext !== shoppingContextKey()) {
      cancelActivePreparation();
      if (isComparisonMode()) invalidateComparison();
      else invalidatePreparedItems("The Walmart store or fulfillment context changed. Prepare the list again to verify this product.");
    }
    await persistState();
    renderAll();
  } catch (error) {
    if (showFailure) showToast(error instanceof Error ? error.message : "Cartiva could not read the Walmart page.");
  } finally {
    elements.refreshContext.classList.remove("is-loading");
    elements.refreshContext.disabled = false;
  }
}

function setupVoiceInput() {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) {
    elements.voiceInput.disabled = true;
    elements.voiceInput.title = "Voice input is not supported in this browser.";
    return;
  }

  elements.voiceInput.addEventListener("click", () => {
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (!transcript) return;
      const current = elements.shoppingList.value.trim();
      elements.shoppingList.value = `${current}${current ? "\n" : ""}${transcript}`;
      state.listText = elements.shoppingList.value;
      cancelActivePreparation();
      invalidateComparison();
      invalidatePreparedItems("", true);
      setPreparing(false);
      renderCartProgress();
      void persistState();
      renderParsePreview();
      renderAll();
      scheduleAutomaticComparison();
    };
    recognition.onerror = () => showToast("Voice input did not come through. You can keep typing your list.");
    recognition.onend = () => {
      elements.voiceInput.classList.remove("is-listening");
      elements.voiceInput.setAttribute("aria-label", "Add grocery items by voice");
    };
    elements.voiceInput.classList.add("is-listening");
    elements.voiceInput.setAttribute("aria-label", "Listening for grocery items");
    recognition.start();
  });
}

function bindEvents() {
  let inputSaveTimer: number | undefined;
  elements.connectKroger.addEventListener("click", () => {
    void (krogerOAuthConnected ? disconnectKrogerAccount() : connectKrogerAccount());
  });
  elements.shoppingList.addEventListener("input", () => {
    const listChanged = state.listText !== elements.shoppingList.value;
    state.listText = elements.shoppingList.value;
    if (listChanged) {
      retainPreferredProductsForList(state.listText);
      cancelActivePreparation();
      invalidateComparison();
      invalidatePreparedItems("", true);
      setPreparing(false);
      renderCartProgress();
    }
    showError(elements.entryError);
    renderParsePreview();
    renderGrocerySuggestions();
    renderGuidedFlow();
    scheduleAutomaticComparison();
    if (inputSaveTimer !== undefined) window.clearTimeout(inputSaveTimer);
    inputSaveTimer = window.setTimeout(() => void persistState(), 250);
  });
  elements.shoppingList.addEventListener("focus", renderGrocerySuggestions);
  elements.shoppingList.addEventListener("click", renderGrocerySuggestions);
  elements.shoppingList.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (!elements.grocerySuggestions.contains(document.activeElement)) hideGrocerySuggestions();
    }, 100);
  });
  elements.shoppingList.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (elements.grocerySuggestions.hidden || !visibleGrocerySuggestions.length) return;
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveGrocerySuggestion(activeGrocerySuggestion < 0
        ? direction > 0 ? 0 : visibleGrocerySuggestions.length - 1
        : activeGrocerySuggestion + direction);
      return;
    }
    if (event.key === "Enter" && activeGrocerySuggestion >= 0) {
      event.preventDefault();
      applyGrocerySuggestion(activeGrocerySuggestion);
      return;
    }
    if (event.key === "Escape" && !elements.grocerySuggestions.hidden) {
      event.preventDefault();
      hideGrocerySuggestions();
    }
  });
  elements.pickupZip.addEventListener("input", () => {
    elements.pickupZip.value = elements.pickupZip.value.replace(/\D/g, "").slice(0, 5);
  });
  elements.targetStoreId.addEventListener("input", () => {
    elements.targetStoreId.value = elements.targetStoreId.value.replace(/\D/g, "").slice(0, 4);
  });
  elements.comparisonZip.addEventListener("input", () => {
    elements.comparisonZip.value = elements.comparisonZip.value.replace(/\D/g, "").slice(0, 5);
    const zip = elements.comparisonZip.value;
    if (zip !== (state.settings.targetZip ?? "")) {
      storeLookupController?.abort();
      storeLookupController = undefined;
      activeComparisonLookupZip = undefined;
      comparisonLookupPending = false;
      cancelActivePreparation();
      invalidateComparison();
      state.settings.selectedStore = undefined;
      state.settings.krogerStore = undefined;
      state.settings.targetStoreId = undefined;
      state.settings.targetZip = /^\d{5}$/.test(zip) ? zip : undefined;
      state.settings.pickupZip = /^\d{5}$/.test(zip) ? zip : undefined;
      state.settings.krogerZip = /^\d{5}$/.test(zip) ? zip : undefined;
      storeLookupResults = [];
      krogerStoreLookupResults = [];
      lastCompletedComparisonLookupZip = undefined;
      comparisonLookupRetryAvailable = false;
      comparisonEditingStores = true;
      comparisonLookupMessage = /^\d{5}$/.test(zip)
        ? `Waiting to select store contexts for ZIP ${zip}…`
        : "Enter all 5 ZIP digits to continue.";
      void persistState();
      renderAll();
    }
    scheduleComparisonZipLookup();
  });
  elements.comparisonZip.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (comparisonZipLookupTimer !== undefined) window.clearTimeout(comparisonZipLookupTimer);
      comparisonZipLookupTimer = undefined;
      void findComparisonStores(elements.comparisonZip.value, true);
    }
  });
  elements.pickupZip.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void findPickupStores();
    }
  });
  elements.findStores.addEventListener("click", () => void findPickupStores());
  elements.prepareList.addEventListener("click", () => void prepareCurrentList());
  elements.prepareAgain.addEventListener("click", () => void prepareCurrentList());
  elements.comparisonEditStores.addEventListener("click", editComparisonStores);
  elements.comparisonRetryLookup.addEventListener("click", () => {
    void findComparisonStores(elements.comparisonZip.value, true);
  });
  elements.refreshContext.addEventListener("click", () => void refreshPageContext());
  elements.openWalmart.addEventListener("click", () => {
    void sendBackground({ type: "CARTIVA_OPEN_WALMART" }).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : "Cartiva could not open Walmart.");
    });
  });
  elements.applyContext.addEventListener("click", () => {
    const previousContext = shoppingContextKey();
    const mode = elements.fulfillmentMode.value as Exclude<FulfillmentMode, "unknown"> | "";
    if (effectiveRetailer() === "target") {
      state.settings = {
        ...state.settings,
        targetFulfillmentMode: mode || "delivery",
        targetStoreId: elements.targetStoreId.value.trim() || undefined,
      };
    } else if (effectiveRetailer() === "kroger") {
      if (mode === "shipping") {
        showToast("Kroger's official cart supports pickup or delivery here. Choose one of those modes.");
        elements.fulfillmentMode.value = state.settings.krogerFulfillmentMode ?? "pickup";
        return;
      }
      state.settings = {
        ...state.settings,
        krogerFulfillmentMode: mode || "pickup",
      };
    } else {
      state.settings = { ...state.settings, fulfillmentModeOverride: mode || undefined };
    }
    if (previousContext !== shoppingContextKey()) {
      cancelActivePreparation();
      invalidatePreparedItems("Shopping context changed. Prepare the list again to verify this product for the selected store and fulfillment mode.");
    }
    void persistState();
    renderAll();
    showToast("Shopping context updated. Prepare the list again to refresh matches.");
  });
  elements.saveSettings.addEventListener("click", () => {
    showError(elements.settingsError);
    try {
      const backendBaseUrl = normalizeBackendUrl(elements.backendUrl.value);
      if (backendBaseUrl !== state.settings.backendBaseUrl) {
        cancelActivePreparation();
        invalidatePreparedItems("The Cartiva backend changed. Prepare the list again before building a cart.");
        invalidateComparison();
      }
      state.settings.backendBaseUrl = backendBaseUrl;
      elements.backendUrl.value = state.settings.backendBaseUrl;
      void persistState();
      renderAll();
      showToast("Backend URL saved. Permission will be requested when you prepare a list.");
    } catch (error) {
      showError(elements.settingsError, error instanceof Error ? error.message : "Enter a valid backend URL.");
    }
  });
  elements.buildCart.addEventListener("click", () => {
    if (effectiveRetailer() === "kroger") {
      if (state.preparedItems.some((item) => item.cartStatus === "added" || item.cartRetrySafe === false)) {
        void sendBackground({ type: "CARTIVA_OPEN_KROGER_URL", url: krogerCartUrl });
      } else if (!krogerOAuthConnected) {
        void connectKrogerAccount();
      } else {
        void startKrogerCartBuild();
      }
      return;
    }
    openConfirmation();
  });
  elements.cancelConfirmation.addEventListener("click", () => elements.confirmation.close());
  elements.confirmCartBuild.addEventListener("click", () => void startCartBuild());
  elements.confirmation.addEventListener("cancel", (event) => {
    if (buildStartPending) event.preventDefault();
  });
  elements.resumeCart.addEventListener("click", async () => {
    elements.resumeCart.disabled = true;
    elements.cancelCart.disabled = true;
    const pausedBuild = displayCartBuild();
    const pausedTargetBuild = pausedBuild?.retailer === "target";
    const pausedRetailerName = pausedTargetBuild ? "Target" : "Walmart";
    elements.resumeCart.textContent = !pausedTargetBuild && pausedBuild?.pauseKind === "context"
      ? "Applying Walmart…"
      : `Checking ${pausedRetailerName}…`;
    try {
      if (!pausedTargetBuild && pausedBuild?.status === "paused"
        && pausedBuild.pauseKind === "context"
        && pausedBuild.fulfillmentMode === "pickup") {
        const store = recoveryStoreFor(pausedBuild);
        if (!store) {
          throw new Error("Cartiva cannot recover the selected store for this older build. Cancel it, choose your pickup Walmart again, and refresh prices.");
        }
        cartBuild = recoverCartBuild(await sendBackground<CartBuildState | null>({
          type: "CARTIVA_APPLY_STORE_AND_RESUME",
          store,
        }));
      } else {
        cartBuild = recoverCartBuild(await sendBackground<CartBuildState | null>({ type: "CARTIVA_RESUME_CART_BUILD" }));
      }
      renderAll();
      if (cartBuild?.status === "paused") {
        showToast(cartBuild.pauseReason ?? `${pausedRetailerName} still needs your attention before Cartiva can continue.`);
      } else if (cartBuild?.status === "running") {
        showToast(`${pausedRetailerName} is confirmed. Cartiva is continuing the cart build.`);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Cartiva could not resume the cart build.");
    } finally {
      elements.resumeCart.disabled = false;
      elements.cancelCart.disabled = false;
      renderCartProgress();
    }
  });
  elements.cancelCart.addEventListener("click", async () => {
    elements.cancelCart.disabled = true;
    try {
      cartBuild = recoverCartBuild(await sendBackground<CartBuildState | null>({ type: "CARTIVA_CANCEL_CART_BUILD" }));
      renderAll();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Cartiva could not stop the cart build.");
    } finally {
      elements.cancelCart.disabled = false;
    }
  });
  elements.reviewCart.addEventListener("click", () => {
    const targetBuild = displayCartBuild()?.retailer === "target";
    void sendBackground({ type: targetBuild ? "CARTIVA_OPEN_TARGET_CART" : "CARTIVA_OPEN_WALMART_CART" }).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : `Cartiva could not open the ${targetBuild ? "Target" : "Walmart"} cart.`);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isKrogerStoreOption(value: unknown): value is KrogerStoreOption {
  return isRecord(value)
    && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 32
    && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 160
    && typeof value.chain === "string" && value.chain.length > 0 && value.chain.length <= 80
    && typeof value.address === "string" && value.address.length > 0 && value.address.length <= 240
    && typeof value.zip === "string" && /^\d{5}$/.test(value.zip);
}

function recoverPreferredProducts(value: unknown): Record<string, PreferredProductSelection> {
  if (!isRecord(value)) return {};
  const recovered: Record<string, PreferredProductSelection> = {};
  for (const [key, rawSelection] of Object.entries(value).slice(0, 48)) {
    if (!key || key.length > 300 || !isRecord(rawSelection)) continue;
    const preferredTitle = typeof rawSelection.preferredTitle === "string"
      ? rawSelection.preferredTitle.replace(/\s+/g, " ").trim()
      : "";
    const preferredProductId = typeof rawSelection.preferredProductId === "string"
      && /^[a-z0-9-]{1,64}$/i.test(rawSelection.preferredProductId)
      ? rawSelection.preferredProductId
      : undefined;
    const preferredItemId = typeof rawSelection.preferredItemId === "string"
      && /^\d{1,24}$/.test(rawSelection.preferredItemId)
      ? rawSelection.preferredItemId
      : undefined;
    if (!preferredTitle || preferredTitle.length > 300 || (!preferredProductId && !preferredItemId)) continue;
    recovered[key] = { preferredProductId, preferredItemId, preferredTitle };
  }
  return recovered;
}

function isParsedItem(value: unknown): value is ParsedListItem {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.text === "string"
    && typeof value.normalizedText === "string"
    && typeof value.quantity === "number"
    && Number.isInteger(value.quantity)
    && value.quantity >= 1
    && value.quantity <= 24;
}

function isExtensionProduct(value: unknown): value is ExtensionProduct {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string"
    || typeof value.title !== "string"
    || typeof value.link !== "string"
    || typeof value.price !== "number"
    || !Number.isFinite(value.price)
    || typeof value.inStock !== "boolean"
  ) return false;
  if (value.priceProvenance !== undefined) {
    if (!isRecord(value.priceProvenance)) return false;
    const fulfillment = value.priceProvenance.fulfillment;
    if (fulfillment !== undefined && (!Array.isArray(fulfillment) || fulfillment.some((entry) => typeof entry !== "string"))) {
      return false;
    }
    const verifiedMode = value.priceProvenance.verifiedFulfillmentMode;
    if (verifiedMode !== undefined && !["pickup", "delivery", "shipping"].includes(String(verifiedMode))) {
      return false;
    }
  }
  return true;
}

const matchStatuses = new Set(["searching", "matched", "needs_review", "no_match", "api_error"]);
const cartItemStatuses = new Set(["ready", "adding", "added", "needs_choice", "unavailable", "failed", "skipped"]);

function isPreparedItem(value: unknown): value is PreparedItem {
  if (!isRecord(value) || !isParsedItem(value.request)) return false;
  return typeof value.id === "string"
    && typeof value.matchStatus === "string"
    && matchStatuses.has(value.matchStatus)
    && typeof value.cartStatus === "string"
    && cartItemStatuses.has(value.cartStatus)
    && Array.isArray(value.alternatives)
    && value.alternatives.every(isExtensionProduct)
    && (value.product === undefined || isExtensionProduct(value.product))
    && (value.assumptions === undefined || (
      Array.isArray(value.assumptions) && value.assumptions.every((entry) => typeof entry === "string")
    ));
}

const comparisonRunStatuses = new Set(["idle", "searching", "complete", "error"]);

function recoverComparisonSearchState(value: unknown): ComparisonSearchState | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.retailers)) return undefined;
  if (
    typeof value.status !== "string"
    || !comparisonRunStatuses.has(value.status)
    || typeof value.listSignature !== "string"
    || value.listSignature.length > 20_000
    || typeof value.contextSignature !== "string"
    || value.contextSignature.length > 4_000
    || !Number.isInteger(value.requestedCount)
    || (value.requestedCount as number) < 0
    || (value.requestedCount as number) > 24
  ) return undefined;
  const rawRetailers = value.retailers;
  const retailers = {} as Record<Retailer, ComparisonRetailerState>;
  for (const retailer of COMPARISON_RETAILERS) {
    const candidate = rawRetailers[retailer];
    if (!isRecord(candidate)
      || typeof candidate.status !== "string"
      || !comparisonRunStatuses.has(candidate.status)
      || typeof candidate.contextSignature !== "string"
      || candidate.contextSignature.length > 2_000
      || !Array.isArray(candidate.items)
      || candidate.items.length > 24
      || !candidate.items.every(isPreparedItem)
      || candidate.items.some((item) => (
        item.id !== item.request.id
        || item.retailer !== retailer
        || (item.product?.retailer !== undefined && item.product.retailer !== retailer)
        || item.alternatives.some((product) => product.retailer !== undefined && product.retailer !== retailer)
      ))
      || new Set(candidate.items.map((item) => item.id)).size !== candidate.items.length
      || (candidate.error !== undefined && typeof candidate.error !== "string")) {
      return undefined;
    }
    const interrupted = candidate.status === "searching";
    retailers[retailer] = {
      status: interrupted ? "error" : candidate.status as ComparisonRetailerState["status"],
      items: candidate.items,
      contextSignature: candidate.contextSignature,
      error: interrupted
        ? "This comparison was interrupted when Cartiva closed. Compare again for current prices."
        : typeof candidate.error === "string" ? candidate.error.slice(0, 500) : undefined,
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : undefined,
    };
  }
  const interrupted = value.status === "searching"
    || Object.values(retailers).some((entry) => entry.status === "error"
      && entry.error?.startsWith("This comparison was interrupted"));
  return {
    version: 1,
    status: interrupted ? "complete" : value.status as ComparisonSearchState["status"],
    listSignature: value.listSignature,
    contextSignature: value.contextSignature,
    requestedCount: value.requestedCount as number,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    retailers,
  };
}

const cartBuildStatuses = new Set(["idle", "running", "paused", "complete", "cancelled"]);

function recoverCartBuild(value: unknown): CartBuildState | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) return null;
  if (
    typeof value.id !== "string"
    || typeof value.status !== "string"
    || !cartBuildStatuses.has(value.status)
    || typeof value.confirmed !== "boolean"
    || typeof value.cursor !== "number"
    || !Number.isInteger(value.cursor)
  ) return null;
  const retailer = value.retailer === "target" ? "target" : "walmart";
  const validItems = value.items.every((item) => isRecord(item)
    && typeof item.id === "string"
    && typeof item.requestedText === "string"
    && typeof item.productTitle === "string"
    && typeof item.itemId === "string"
    && (retailer === "target" ? /^\d{6,12}$/.test(item.itemId) : /^\d{6,20}$/.test(item.itemId))
    && typeof item.productUrl === "string"
    && (retailer === "target"
      ? isValidTargetProductUrl(item.productUrl, item.itemId)
      : isValidWalmartProductUrl(item.productUrl, item.itemId))
    && typeof item.priceCents === "number"
    && Number.isInteger(item.priceCents)
    && item.priceCents > 0
    && typeof item.checkedAt === "string"
    && typeof item.quantity === "number"
    && Number.isInteger(item.quantity)
    && typeof item.status === "string"
    && cartItemStatuses.has(item.status));
  return validItems ? value as unknown as CartBuildState : null;
}

function recoverPageContext(value: unknown): WalmartPageContext {
  if (!isRecord(value)) return defaultPageContext();
  const modes = new Set<FulfillmentMode>(["pickup", "delivery", "shipping", "unknown"]);
  const pages = new Set(["home", "search", "product", "cart", "other"]);
  return {
    onWalmart: value.onWalmart === true,
    tabId: typeof value.tabId === "number" ? value.tabId : undefined,
    storeId: typeof value.storeId === "string" ? value.storeId : undefined,
    storeName: typeof value.storeName === "string" ? value.storeName : undefined,
    address: typeof value.address === "string" ? value.address : undefined,
    zip: typeof value.zip === "string" ? value.zip : undefined,
    fulfillmentMode: typeof value.fulfillmentMode === "string" && modes.has(value.fulfillmentMode as FulfillmentMode)
      ? value.fulfillmentMode as FulfillmentMode
      : "unknown",
    pageType: typeof value.pageType === "string" && pages.has(value.pageType)
      ? value.pageType as WalmartPageContext["pageType"]
      : undefined,
  };
}

function restoreAppState(loaded: unknown) {
  const fallback = defaultAppState();
  if (!isRecord(loaded) || loaded.version !== 1) return fallback;
  const rawPrepared = Array.isArray(loaded.preparedItems)
    ? loaded.preparedItems.filter(isPreparedItem)
    : [];
  const preparedItems = rawPrepared.map((item) => item.matchStatus === "matched"
    && !isFreshVerification(item.checkedAt ?? item.product?.checkedAt)
    ? {
        ...item,
        matchStatus: "needs_review" as const,
        cartStatus: "needs_choice" as const,
        explanation: item.retailer === "target"
          ? "This saved Target price is older than 30 minutes. Refresh matches."
          : "This saved Walmart price is older than 30 minutes. Refresh prices before building the cart.",
      }
    : item);
  const rawSettings = isRecord(loaded.settings) ? loaded.settings : {};
  const backendBaseUrl = restoredBackendBaseUrl(rawSettings.backendBaseUrl);
  const selectedStore = isWalmartStoreOption(rawSettings.selectedStore)
    ? { ...rawSettings.selectedStore }
    : undefined;
  const pickupZip = typeof rawSettings.pickupZip === "string" && /^\d{5}$/.test(rawSettings.pickupZip)
    ? rawSettings.pickupZip
    : selectedStore?.zip;
  const retailer: Retailer = rawSettings.retailer === "target" || rawSettings.retailer === "kroger"
    ? rawSettings.retailer
    : "walmart";
  const targetZip = typeof rawSettings.targetZip === "string" && /^\d{5}$/.test(rawSettings.targetZip)
    ? rawSettings.targetZip
    : undefined;
  const krogerStore = isKrogerStoreOption(rawSettings.krogerStore)
    ? { ...rawSettings.krogerStore }
    : undefined;
  const krogerZip = typeof rawSettings.krogerZip === "string" && /^\d{5}$/.test(rawSettings.krogerZip)
    ? rawSettings.krogerZip
    : krogerStore?.zip;
  const krogerCartOperationId = typeof rawSettings.krogerCartOperationId === "string"
    && /^[A-Za-z0-9_-]{16,128}$/.test(rawSettings.krogerCartOperationId)
    ? rawSettings.krogerCartOperationId
    : undefined;
  const krogerCartUrl = typeof rawSettings.krogerCartUrl === "string"
    && isTrustedKrogerCartUrl(rawSettings.krogerCartUrl)
    ? rawSettings.krogerCartUrl
    : undefined;
  const listText = typeof loaded.listText === "string" ? loaded.listText : "";
  const parsedItems = Array.isArray(loaded.parsedItems) ? loaded.parsedItems.filter(isParsedItem) : [];
  const pageContext = recoverPageContext(loaded.pageContext);
  const restoredComparisonContexts: Record<Retailer, ComparisonRetailerContext> = {
    walmart: {
      fulfillmentMode: "delivery",
      storeId: selectedStore?.id,
      zip: targetZip,
    },
    target: { fulfillmentMode: "delivery", zip: targetZip },
    kroger: { fulfillmentMode: "delivery", storeId: krogerStore?.id, zip: targetZip },
  };
  const recoveredComparison = recoverComparisonSearchState(loaded.comparison);
  const rawComparisonItems = parseShoppingList(listText);
  const comparison = recoveredComparison
    && recoveredComparison.requestedCount === rawComparisonItems.length
    && recoveredComparison.listSignature === comparisonListSignature(rawComparisonItems)
    && recoveredComparison.contextSignature === comparisonContextSignature(restoredComparisonContexts)
    && COMPARISON_RETAILERS.every((comparisonRetailer) => (
      recoveredComparison.retailers[comparisonRetailer].contextSignature
        === comparisonRetailerContextSignature(comparisonRetailer, restoredComparisonContexts[comparisonRetailer])
    ))
      ? recoveredComparison
      : undefined;
  return {
    version: 1 as const,
    shoppingMode: "compare",
    listText,
    parsedItems,
    preparedItems,
    preferredProducts: recoverPreferredProducts(loaded.preferredProducts),
    pageContext,
    settings: {
      backendBaseUrl,
      retailer,
      pickupZip,
      selectedStore,
      targetZip,
      targetStoreId: undefined,
      targetFulfillmentMode: "delivery",
      krogerZip,
      krogerStore,
      krogerFulfillmentMode: "delivery",
      krogerCartOperationId,
      krogerCartUrl,
      storeIdOverride: undefined,
      fulfillmentModeOverride: "delivery",
    },
    comparison,
    lastPreparedAt: typeof loaded.lastPreparedAt === "string" ? loaded.lastPreparedAt : undefined,
  } satisfies ExtensionAppState;
}

async function initialize() {
  elements.extensionBuild.textContent = `Extension ${chrome.runtime.getManifest().version}`;
  bindEvents();
  setupVoiceInput();
  try {
    state = restoreAppState(await appStore.load());
  } catch {
    state = defaultAppState();
  }
  elements.shoppingList.value = state.listText;
  elements.backendUrl.value = state.settings.backendBaseUrl;
  krogerCartUrl = state.settings.krogerCartUrl ?? "https://www.kroger.com/cart";
  if (state.settings.selectedStore) {
    storeLookupResults = [state.settings.selectedStore];
    storeLookupMessage = `${state.settings.selectedStore.address} is selected for Cartiva.`;
  }
  if (effectiveRetailer() === "target") {
    storeLookupMessage = state.settings.targetZip
      ? `Target ${effectiveFulfillmentMode()} estimates are set for ZIP ${state.settings.targetZip}.`
      : "Enter a ZIP to localize Target delivery or shipping estimates.";
  }
  if (effectiveRetailer() === "kroger") {
    if (state.settings.krogerStore) {
      krogerStoreLookupResults = [state.settings.krogerStore];
      storeLookupMessage = `${state.settings.krogerStore.chain} at ${state.settings.krogerStore.address} is selected.`;
    } else {
      storeLookupMessage = "Enter a ZIP to find an official Kroger-family store.";
    }
    void refreshKrogerOAuthStatus(false);
  }
  if (isComparisonMode()) {
    const zip = state.settings.targetZip;
    const ready = configuredComparisonRetailers().length;
    comparisonEditingStores = ready < 2;
    if (/^\d{5}$/.test(zip ?? "") && ready >= 2) {
      lastCompletedComparisonLookupZip = zip;
      comparisonLookupMessage = "Store contexts are automatically selected for your ZIP. Target remains a clearly labeled ZIP estimate.";
    }
  }
  renderParsePreview();
  renderAll();
  if (isComparisonMode()) {
    if (configuredComparisonRetailers().length >= 2) scheduleAutomaticComparison();
    else scheduleComparisonZipLookup();
  }

  chrome.runtime.onMessage.addListener((message: unknown) => {
    const broadcast = message as RuntimeBroadcast;
    if (broadcast?.type === "CARTIVA_CART_BUILD_UPDATED") {
      cartBuild = recoverCartBuild(broadcast.state);
      renderAll();
    } else if (broadcast?.type === "CARTIVA_PAGE_CONTEXT_UPDATED") {
      const previousContext = shoppingContextKey();
      state.pageContext = broadcast.context;
      if (previousContext !== shoppingContextKey()) {
        cancelActivePreparation();
        if (isComparisonMode()) invalidateComparison();
        else if (effectiveRetailer() === "walmart") {
          invalidatePreparedItems("The Walmart store or fulfillment context changed. Prepare the list again before building a cart.");
        }
      }
      void persistState();
      renderAll();
    }
  });

  const [buildResult] = await Promise.allSettled([
    sendBackground<CartBuildState | null>({ type: "CARTIVA_GET_CART_BUILD" }),
    refreshPageContext(false),
  ]);
  if (buildResult.status === "fulfilled") cartBuild = recoverCartBuild(buildResult.value);
  if (cartBuild && (cartBuild.status === "running" || cartBuild.status === "paused")) {
    state.shoppingMode = "retailer";
    state.settings.retailer = cartBuild.retailer === "target" ? "target" : "walmart";
  }
  renderAll();
}

window.addEventListener("pagehide", () => {
  if (krogerConnectionPoll !== undefined) window.clearInterval(krogerConnectionPoll);
  krogerConnectionPoll = undefined;
  backendClient.cancel();
  comparisonClient.cancel();
  if (comparisonZipLookupTimer !== undefined) window.clearTimeout(comparisonZipLookupTimer);
  if (comparisonAutoPrepareTimer !== undefined) window.clearTimeout(comparisonAutoPrepareTimer);
});

void initialize();
