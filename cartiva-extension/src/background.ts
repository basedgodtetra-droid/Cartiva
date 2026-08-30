import {
  cartContextIssue,
  createCartBuild,
  freshStoreConfirmationId,
  cartRecoveryAction,
  markCurrentAdding,
  migrateLegacyStoreMismatchPause,
  resolveCurrentItem,
  resumeAfterChoice,
  retryCurrentAfterChoice,
  resumeAfterContextPause,
  startCartBuild,
} from "./cart-state.js";
import type {
  BackgroundRequest,
  ContentAddResult,
  ContentRequest,
  ContentStoreLookupResult,
  ContentStoreSelectionResult,
  RuntimeBroadcast,
} from "./messages.js";
import { isBackgroundRequest, isTrustedSidePanelSender } from "./messages.js";
import { isTrustedKrogerNavigationUrl } from "./kroger-hosts.js";
import { chromeStorageArea, JsonStateStore } from "./storage.js";
import {
  isWalmartStoreOption,
  normalizePickupZip,
  storeNameForDisplay,
  walmartStoreSelectionUrl,
} from "./store-picker.js";
import type {
  CartBuildState,
  WalmartPageContext,
  WalmartNearbyStoreResult,
  WalmartStoreApplyResult,
  WalmartStoreOption,
} from "./types.js";
import { isFreshVerification, isValidTargetProductUrl, isValidWalmartProductUrl } from "./totals.js";

const buildStore = new JsonStateStore<CartBuildState | null>(
  chromeStorageArea(chrome.storage.session ?? chrome.storage.local),
  "cartiva.cartBuild.v1",
  () => null,
);

let activeBuild: Promise<void> | undefined;
let activeBuildId: string | undefined;
let rescheduleRequested = false;
const stoppedBuildIds = new Set<string>();
const automaticContextRecoveryAttempts = new Set<string>();
const confirmedStoreSelections = new Map<number, {
  storeId: string;
  confirmedAt: number;
  buildId?: string;
}>();

function recentlyConfirmedStoreId(tabId: number, buildId?: string) {
  const confirmation = confirmedStoreSelections.get(tabId);
  const storeId = freshStoreConfirmationId(confirmation, Date.now(), buildId);
  if (!storeId) {
    confirmedStoreSelections.delete(tabId);
    return undefined;
  }
  return storeId;
}

function bindStoreConfirmationToBuild(tabId: number, state: CartBuildState) {
  const confirmation = confirmedStoreSelections.get(tabId);
  const storeId = freshStoreConfirmationId(confirmation);
  if (!storeId || storeId !== state.storeId) return;
  confirmedStoreSelections.set(tabId, { ...confirmation!, buildId: state.id });
}

function contextIssueForTab(
  state: CartBuildState,
  context: WalmartPageContext,
  tabId: number,
) {
  const issue = cartContextIssue(state, context, recentlyConfirmedStoreId(tabId, state.id));
  if (context.storeId && state.storeId && context.storeId !== state.storeId) {
    confirmedStoreSelections.delete(tabId);
  }
  return issue;
}

function isStructurallyValidBuild(value: unknown): value is CartBuildState {
  if (!value || typeof value !== "object") return value === null;
  const state = value as Partial<CartBuildState>;
  if (state.version !== 1 || typeof state.id !== "string" || !state.id.trim()) return false;
  if (!["idle", "running", "paused", "complete", "cancelled"].includes(state.status ?? "")) return false;
  if (typeof state.confirmed !== "boolean" || !Array.isArray(state.items)
    || !state.items.length || state.items.length > 24) return false;
  if (!Number.isInteger(state.cursor) || state.cursor! < 0 || state.cursor! > state.items.length) return false;
  if ((state.status === "running" || state.status === "paused") && state.cursor! >= state.items.length) return false;
  if (!["pickup", "delivery", "shipping", "unknown"].includes(state.fulfillmentMode ?? "")) return false;
  const statuses = ["ready", "adding", "added", "needs_choice", "unavailable", "failed", "skipped"];
  const retailer = state.retailer === "target" ? "target" : "walmart";
  return state.items.every((item) => Boolean(item)
    && typeof item.id === "string" && Boolean(item.id.trim())
    && typeof item.requestedText === "string" && Boolean(item.requestedText.trim())
    && typeof item.productTitle === "string" && Boolean(item.productTitle.trim())
    && typeof item.itemId === "string"
    && typeof item.productUrl === "string"
    && (retailer === "target"
      ? isValidTargetProductUrl(item.productUrl, item.itemId)
      : isValidWalmartProductUrl(item.productUrl, item.itemId))
    && typeof item.checkedAt === "string"
    && Number.isInteger(item.priceCents) && item.priceCents > 0
    && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 24
    && statuses.includes(item.status));
}

async function loadSafeBuild() {
  const value = await buildStore.load();
  if (isStructurallyValidBuild(value)) {
    if (!value) return value;
    const migrated = migrateLegacyStoreMismatchPause(value);
    if (migrated !== value) await buildStore.save(migrated);
    return migrated;
  }
  await buildStore.clear();
  return null;
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  confirmedStoreSelections.delete(tabId);
});

function isWalmartUrl(value?: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "www.walmart.com" || url.hostname === "walmart.com");
  } catch {
    return false;
  }
}

async function broadcast(state: CartBuildState) {
  const message: RuntimeBroadcast = { type: "CARTIVA_CART_BUILD_UPDATED", state };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // The side panel may be closed; persisted state remains authoritative.
  }
}

async function persist(state: CartBuildState) {
  await buildStore.save(state);
  await broadcast(state);
  return state;
}

async function requireRunningBuild(buildId: string) {
  const current = await loadSafeBuild();
  if (stoppedBuildIds.has(buildId)) {
    if (current?.id === buildId && current.status !== "cancelled") {
      await persist({ ...current, status: "cancelled", updatedAt: new Date().toISOString() });
    }
    return null;
  }
  return current?.id === buildId && current.status === "running" ? current : null;
}

async function safeSendToTab<T>(tabId: number, message: ContentRequest, attempts = 10): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage<T>(tabId, message);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Retailer page helper did not respond.");
}

async function activeWalmartTab() {
  const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (active?.id && isWalmartUrl(active.url)) return active;
  const existing = (await chrome.tabs.query({
    url: ["https://www.walmart.com/*"],
    currentWindow: true,
  }))[0];
  if (existing?.id) return chrome.tabs.update(existing.id, { active: true });
  return chrome.tabs.create({ url: "https://www.walmart.com/", active: true });
}

function isTargetUrl(value?: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "www.target.com" || url.hostname === "target.com");
  } catch {
    return false;
  }
}

async function activeTargetTab() {
  const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (active?.id && isTargetUrl(active.url)) return active;
  const existing = (await chrome.tabs.query({
    url: ["https://www.target.com/*"],
    currentWindow: true,
  }))[0];
  if (existing?.id) return chrome.tabs.update(existing.id, { active: true });
  return chrome.tabs.create({ url: "https://www.target.com/", active: true });
}

async function getPageContext(): Promise<WalmartPageContext> {
  const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!active?.id || !isWalmartUrl(active.url)) {
    return { onWalmart: false, fulfillmentMode: "unknown" };
  }
  try {
    const context = await safeSendToTab<WalmartPageContext>(active.id, {
      type: "CARTIVA_WALMART_GET_CONTEXT",
    }, 3);
    return { ...context, tabId: active.id, onWalmart: true };
  } catch {
    return { onWalmart: true, tabId: active.id, fulfillmentMode: "unknown" };
  }
}

async function getTabContext(tabId: number) {
  return safeSendToTab<WalmartPageContext>(tabId, {
    type: "CARTIVA_WALMART_GET_CONTEXT",
  }, 3);
}

function pauseForContext(state: CartBuildState, reason: string) {
  const items = state.items.map((item, index) => index === state.cursor
    ? { ...item, status: "needs_choice" as const, message: reason }
    : item);
  return {
    ...state,
    items,
    status: "paused" as const,
    pauseKind: "context" as const,
    pauseReason: reason,
    updatedAt: new Date().toISOString(),
  };
}

function storeForBuild(state: CartBuildState) {
  const store: WalmartStoreOption = {
    id: state.storeId ?? "",
    name: state.storeName?.trim() || "Walmart pickup store",
    address: state.storeAddress?.trim() || "",
    zip: state.zip ?? "",
  };
  return isWalmartStoreOption(store) ? store : undefined;
}

function validateBuildRequest(message: Extract<BackgroundRequest, { type: "CARTIVA_START_CART_BUILD" }>) {
  const retailer = message.retailer === "target" ? "target" : "walmart";
  if (!Array.isArray(message.items) || !message.items.length || message.items.length > 24) {
    throw new Error(`A ${retailer === "target" ? "Target" : "Walmart"} cart build must contain 1 to 24 verified items.`);
  }
  if (!["pickup", "delivery", "shipping"].includes(message.fulfillmentMode)) {
    throw new Error("Choose pickup, delivery or shipping before building the cart.");
  }
  if (retailer === "walmart" && message.fulfillmentMode === "shipping") {
    throw new Error("Shipping cart automation is not enabled until Cartiva can verify shipping-specific prices.");
  }
  if (retailer === "walmart" && !message.storeId?.trim()) {
    throw new Error("Choose a pickup Walmart before building the cart.");
  }
  if (retailer === "target" && message.fulfillmentMode === "pickup" && !/^\d{3,4}$/.test(message.storeId ?? "")) {
    throw new Error("Choose a Target pickup store before building the cart.");
  }
  const seen = new Set<string>();
  for (const item of message.items) {
    if (!item || typeof item !== "object") throw new Error("Cart build item is malformed.");
    if (!item.id?.trim() || seen.has(item.id)) throw new Error("Cart build item IDs must be unique.");
    seen.add(item.id);
    if (!item.requestedText?.trim() || !item.productTitle?.trim()) {
      throw new Error(`Every cart item needs its requested text and exact ${retailer === "target" ? "Target" : "Walmart"} title.`);
    }
    const validIdentity = retailer === "target"
      ? /^\d{6,12}$/.test(item.itemId) && isValidTargetProductUrl(item.productUrl, item.itemId)
      : /^\d{6,20}$/.test(item.itemId) && isValidWalmartProductUrl(item.productUrl, item.itemId);
    if (!validIdentity) {
      throw new Error(`Every cart item needs a numeric ${retailer === "target" ? "Target TCIN" : "Walmart item ID"} and matching HTTPS product URL.`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 24) {
      throw new Error("Cart item quantities must be whole numbers from 1 to 24.");
    }
    if (!Number.isInteger(item.priceCents) || item.priceCents <= 0) {
      throw new Error("Every cart item needs a verified positive price in cents.");
    }
    if (!isFreshVerification(item.checkedAt)) {
      throw new Error(`Every cart item needs a ${retailer === "target" ? "Target" : "Walmart"} price checked within the last 30 minutes.`);
    }
  }
}

function persistedItemsAreSafe(state: CartBuildState) {
  const retailer = state.retailer === "target" ? "target" : "walmart";
  return state.items.every((item) =>
    Boolean(item.id?.trim())
    && Boolean(item.requestedText?.trim())
    && Boolean(item.productTitle?.trim())
    && (retailer === "target"
      ? /^\d{6,12}$/.test(item.itemId) && isValidTargetProductUrl(item.productUrl, item.itemId)
      : /^\d{6,20}$/.test(item.itemId) && isValidWalmartProductUrl(item.productUrl, item.itemId))
    && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 24
    && Number.isInteger(item.priceCents) && item.priceCents > 0
    && isFreshVerification(item.checkedAt),
  );
}

async function navigateAndWait(tabId: number, url: string) {
  const updated = await chrome.tabs.update(tabId, { url, active: true });
  if (updated.status === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15_000);
    const listener = (changedTabId: number, changeInfo: { status?: string }) => {
      if (changedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function storeChoiceTab(tabId?: number) {
  if (Number.isInteger(tabId)) {
    try {
      const tab = await chrome.tabs.get(tabId!);
      if (tab.id && isWalmartUrl(tab.url)) return chrome.tabs.update(tab.id, { active: true });
    } catch {
      // The earlier finder tab may have been closed; reuse another Walmart tab.
    }
  }
  return activeWalmartTab();
}

async function findNearbyPickupStores(
  zipValue: string,
  tabId?: number,
): Promise<WalmartNearbyStoreResult> {
  const zipCode = normalizePickupZip(zipValue);
  const tab = await storeChoiceTab(tabId);
  if (!tab.id) throw new Error("Cartiva could not open Walmart's store finder.");
  await navigateAndWait(tab.id, walmartStoreSelectionUrl(zipCode));
  const result = await safeSendToTab<ContentStoreLookupResult>(tab.id, {
    type: "CARTIVA_WALMART_GET_PICKUP_STORES",
  });
  const seen = new Set<string>();
  const stores = (Array.isArray(result?.stores) ? result.stores : [])
    .filter(isWalmartStoreOption)
    .filter((store) => {
      if (seen.has(store.id)) return false;
      seen.add(store.id);
      return true;
    })
    .slice(0, 10)
    .map((store) => ({
      id: store.id,
      name: storeNameForDisplay(store.name),
      address: store.address,
      zip: store.zip,
    }));
  if (!stores.length) {
    throw new Error(`Walmart did not show pickup stores near ZIP ${zipCode}.`);
  }
  return { zipCode, stores, tabId: tab.id };
}

async function selectPickupStore(
  store: WalmartStoreOption,
  tabId?: number,
  buildId?: string,
): Promise<WalmartStoreApplyResult> {
  if (!isWalmartStoreOption(store)) throw new Error("Choose a valid Walmart from the list.");
  const tab = await storeChoiceTab(tabId);
  if (!tab.id) throw new Error("Cartiva could not reopen Walmart's store finder.");
  // Always reopen the exact ZIP search. A previously open store-finder page may
  // be showing a different ZIP and therefore cannot prove this basket's store.
  await navigateAndWait(tab.id, walmartStoreSelectionUrl(store.zip));
  const selected = await safeSendToTab<ContentStoreSelectionResult>(tab.id, {
    type: "CARTIVA_WALMART_SELECT_PICKUP_STORE",
    storeId: store.id,
  });
  if (!selected?.selected || !isWalmartStoreOption(selected.store) || selected.store.id !== store.id) {
    throw new Error(selected?.message || "Walmart did not confirm that pickup store.");
  }
  confirmedStoreSelections.set(tab.id, {
    storeId: store.id,
    confirmedAt: Date.now(),
    buildId,
  });

  await navigateAndWait(tab.id, "https://www.walmart.com/");
  const fulfillment = await safeSendToTab<{ confirmed: boolean; message: string }>(tab.id, {
    type: "CARTIVA_WALMART_SET_FULFILLMENT",
    mode: "pickup",
  }, 5);
  const context = await getTabContext(tab.id).catch(() => undefined);
  return {
    store,
    pickupConfirmed: fulfillment.confirmed,
    message: fulfillment.message,
    context: context ? { ...context, tabId: tab.id, onWalmart: true } : undefined,
  };
}

async function runTargetBuildLoop(initialState: CartBuildState) {
  let state = initialState;
  const buildId = state.id;
  activeBuildId = buildId;
  if (cartRecoveryAction(state) !== "resume" || !persistedItemsAreSafe(state)
    || state.retailer !== "target"
    || !["pickup", "delivery", "shipping"].includes(state.fulfillmentMode)
    || !/^\d{5}$/.test(state.zip ?? "")) {
    await persist({
      ...state,
      status: "cancelled",
      pauseReason: "The saved Target cart build did not pass Cartiva's safety checks. No Target control was clicked.",
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  if (state.fulfillmentMode === "pickup" && !/^\d{3,4}$/.test(state.storeId ?? "")) {
    await persist({
      ...state,
      status: "cancelled",
      pauseReason: "The saved Target pickup store was invalid. No Target control was clicked.",
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const tab = await activeTargetTab();
  if (!tab.id) throw new Error("Cartiva could not open Target.");
  const afterTabOpen = await requireRunningBuild(buildId);
  if (!afterTabOpen) return;
  state = await persist({ ...afterTabOpen, targetTabId: tab.id, updatedAt: new Date().toISOString() });

  while (state.status === "running" && state.cursor < state.items.length) {
    const persisted = await loadSafeBuild();
    if (!persisted || persisted.id !== buildId || persisted.status !== "running" || stoppedBuildIds.has(buildId)) {
      if (persisted) state = persisted;
      break;
    }
    state = persisted;
    const current = state.items[state.cursor];
    if (!isFreshVerification(current.checkedAt)) {
      state = await persist(resolveCurrentItem(
        state,
        "failed",
        "This Target price check is older than 30 minutes. Find the product again before adding it.",
      ));
      continue;
    }
    if (!isValidTargetProductUrl(current.productUrl, current.itemId)) {
      state = await persist(resolveCurrentItem(
        state,
        "failed",
        "No canonical Target product page matched the verified TCIN. Nothing was clicked.",
      ));
      continue;
    }

    try {
      await navigateAndWait(tab.id, current.productUrl);
      const beforeClick = await requireRunningBuild(buildId);
      if (!beforeClick) break;
      state = await persist(markCurrentAdding(beforeClick));
      const afterMarking = await requireRunningBuild(buildId);
      if (!afterMarking) break;
      state = afterMarking;
      const mode = state.fulfillmentMode;
      if (mode !== "pickup" && mode !== "delivery" && mode !== "shipping") {
        throw new Error("Target fulfillment mode is no longer valid.");
      }
      const result = await safeSendToTab<ContentAddResult>(tab.id, {
        type: "CARTIVA_TARGET_ADD_PRODUCT",
        tcin: current.itemId,
        productTitle: current.productTitle,
        quantity: current.quantity,
        fulfillmentMode: mode,
        storeId: state.storeId,
      });
      const latest = await requireRunningBuild(buildId);
      if (!latest) break;
      state = await persist(resolveCurrentItem(
        latest,
        result.status,
        result.message,
        result.baselineCartCount,
      ));
    } catch (error) {
      const latest = await requireRunningBuild(buildId);
      if (!latest) break;
      state = await persist(resolveCurrentItem(
        latest,
        "failed",
        error instanceof Error ? error.message : "Target did not visibly confirm the addition.",
      ));
    }
  }

  if (stoppedBuildIds.has(buildId)) await requireRunningBuild(buildId);
  if (state.status === "complete" && state.targetTabId) {
    const finalState = await loadSafeBuild();
    if (finalState?.id === buildId && finalState.status === "complete" && !stoppedBuildIds.has(buildId)) {
      await chrome.tabs.update(state.targetTabId, { url: "https://www.target.com/cart", active: true });
    }
  }
}

async function runBuildLoop() {
  let state = await loadSafeBuild();
  if (!state || state.status !== "running") return;
  if (state.retailer === "target") return runTargetBuildLoop(state);
  const buildId = state.id;
  activeBuildId = buildId;
  if (cartRecoveryAction(state) !== "resume" || !persistedItemsAreSafe(state)
    || !["pickup", "delivery"].includes(state.fulfillmentMode)
    || !state.storeId?.trim()) {
    await persist({
      ...state,
      status: "cancelled",
      pauseReason: "The saved cart build did not pass Cartiva's safety checks. No Walmart control was clicked.",
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  const tab = await activeWalmartTab();
  if (!tab.id) throw new Error("Cartiva could not open Walmart.");
  const afterTabOpen = await requireRunningBuild(buildId);
  if (!afterTabOpen) return;
  state = afterTabOpen;
  state = await persist({ ...state, walmartTabId: tab.id, updatedAt: new Date().toISOString() });
  bindStoreConfirmationToBuild(tab.id, state);

  let pickupStoreAlreadyExact = false;
  if (state.fulfillmentMode === "pickup") {
    const currentContext = await getTabContext(tab.id).catch(() => undefined);
    pickupStoreAlreadyExact = currentContext?.storeId === state.storeId
      && currentContext?.fulfillmentMode === "pickup";
  }
  if (state.fulfillmentMode === "pickup" && !pickupStoreAlreadyExact) {
    const selectedStore = storeForBuild(state);
    if (selectedStore) {
      try {
        await selectPickupStore(selectedStore, tab.id, buildId);
        const aligned = await requireRunningBuild(buildId);
        if (!aligned) return;
        state = aligned;
      } catch {
        // Store selection is best effort. Walmart's current selected store is
        // allowed to win so a metadata mismatch never blocks the cart build.
        const latest = await requireRunningBuild(buildId);
        if (!latest) return;
        state = latest;
      }
    }
  }

  while (state.status === "running" && state.cursor < state.items.length) {
    const persisted = await loadSafeBuild();
    if (!persisted || persisted.id !== buildId || persisted.status !== "running" || stoppedBuildIds.has(buildId)) {
      if (persisted) state = persisted;
      break;
    }
    state = persisted;
    const current = state.items[state.cursor];
    if (!isFreshVerification(current.checkedAt)) {
      state = await persist(resolveCurrentItem(
        state,
        "failed",
        "This Walmart price is older than 30 minutes. Prepare the item again before adding it.",
      ));
      continue;
    }
    if (!isValidWalmartProductUrl(current.productUrl, current.itemId)) {
      state = await persist(resolveCurrentItem(
        state,
        "failed",
        "No verified Walmart product page was available. Nothing was clicked.",
      ));
      continue;
    }

    try {
      await navigateAndWait(tab.id, current.productUrl);
      const beforeClick = await requireRunningBuild(buildId);
      if (!beforeClick) {
        if (beforeClick) state = beforeClick;
        break;
      }
      state = beforeClick;
      let currentPageContext = await getTabContext(tab.id);
      const afterContextRead = await requireRunningBuild(buildId);
      if (!afterContextRead) break;
      state = afterContextRead;
      let currentContextIssue = contextIssueForTab(state, currentPageContext, tab.id);

      // Walmart can lose or refresh its location metadata while navigating from
      // the store finder to a product. Reapply the exact saved pickup store once
      // and return to this product instead of making the shopper resolve it.
      if (currentContextIssue && state.fulfillmentMode === "pickup") {
        const selectedStore = storeForBuild(state);
        if (selectedStore) {
          try {
            await selectPickupStore(selectedStore, tab.id, buildId);
            const afterStoreAlignment = await requireRunningBuild(buildId);
            if (!afterStoreAlignment) break;
            state = afterStoreAlignment;
            await navigateAndWait(tab.id, current.productUrl);
            const beforeContextRetry = await requireRunningBuild(buildId);
            if (!beforeContextRetry) break;
            state = beforeContextRetry;
            currentPageContext = await getTabContext(tab.id);
            const afterContextRetry = await requireRunningBuild(buildId);
            if (!afterContextRetry) break;
            state = afterContextRetry;
            currentContextIssue = contextIssueForTab(state, currentPageContext, tab.id);
          } catch {
            // Keep the original fulfillment issue. A failed store metadata
            // refresh is not itself a reason to ask the shopper for a choice.
          }
        }
      }
      if (currentContextIssue) {
        const latest = await requireRunningBuild(buildId);
        if (!latest) break;
        state = latest;
        state = await persist(pauseForContext(state, currentContextIssue));
        break;
      }
      state = await persist(markCurrentAdding(state));
      const afterMarking = await requireRunningBuild(buildId);
      if (!afterMarking) break;
      state = afterMarking;
      const result = await safeSendToTab<ContentAddResult>(tab.id, {
        type: "CARTIVA_WALMART_ADD_PRODUCT",
        itemId: current.itemId,
        productId: current.productId,
        productTitle: current.productTitle,
        quantity: current.quantity,
      });
      const latest = await requireRunningBuild(buildId);
      if (!latest) {
        if (latest) state = latest;
        break;
      }
      state = latest;
      state = await persist(resolveCurrentItem(
        state,
        result.status,
        result.message,
        result.baselineCartCount,
      ));
    } catch (error) {
      const latest = await requireRunningBuild(buildId);
      if (!latest) {
        if (latest) state = latest;
        break;
      }
      state = latest;
      state = await persist(resolveCurrentItem(
        state,
        "failed",
        error instanceof Error ? error.message : "Walmart did not confirm the addition.",
      ));
    }
  }

  if (stoppedBuildIds.has(buildId)) await requireRunningBuild(buildId);

  if (state.status === "complete" && state.walmartTabId) {
    const finalState = await loadSafeBuild();
    if (finalState?.id === buildId && finalState.status === "complete" && !stoppedBuildIds.has(buildId)) {
      await chrome.tabs.update(state.walmartTabId, {
        url: "https://www.walmart.com/cart",
        active: true,
      });
    }
  }
}

function scheduleBuildLoop() {
  if (activeBuild) {
    rescheduleRequested = true;
    return;
  }
  rescheduleRequested = false;
  activeBuild = runBuildLoop()
    .catch(async (error: unknown) => {
      const state = await loadSafeBuild();
      if (state?.status === "running") {
        await persist({
          ...state,
          status: "paused",
          pauseReason: error instanceof Error ? error.message : "Cart building paused unexpectedly.",
          updatedAt: new Date().toISOString(),
        });
      }
    })
    .finally(() => {
      activeBuild = undefined;
      activeBuildId = undefined;
      if (rescheduleRequested) {
        rescheduleRequested = false;
        void loadSafeBuild().then((state) => {
          if (state?.status === "running") scheduleBuildLoop();
        });
      }
    });
}

async function applyStoreAndResumePausedBuild(
  current: CartBuildState,
  suppliedStore?: WalmartStoreOption,
): Promise<CartBuildState | null> {
  if (current.status !== "paused" || current.pauseKind !== "context" || !current.walmartTabId) {
    return current;
  }
  if (current.fulfillmentMode !== "pickup") {
    return persist(pauseForContext(
      current,
      "Set Walmart to the fulfillment mode used for this basket, then continue.",
    ));
  }
  const store = suppliedStore ?? storeForBuild(current);
  const buildId = current.id;
  if (store && store.id === current.storeId) {
    try {
      await selectPickupStore(store, current.walmartTabId, buildId);
    } catch {
      // The exact store switch is best effort. Resume with Walmart's current
      // store rather than asking the shopper to resolve a metadata mismatch.
      const latest = await loadSafeBuild();
      if (!latest || latest.id !== buildId || latest.status !== "paused") return latest;
    }
  }

  const latest = await loadSafeBuild();
  if (!latest || latest.id !== buildId || latest.status !== "paused"
    || latest.pauseKind !== "context") return latest;
  const resumed = await persist(resumeAfterContextPause(latest));
  scheduleBuildLoop();
  return resumed;
}

async function recoverOrResumeBuild(state: CartBuildState | null): Promise<CartBuildState | null> {
  const retailer = state?.retailer === "target" ? "target" : "walmart";
  if (retailer === "walmart" && state?.status === "paused" && state.pauseKind === "context"
    && !automaticContextRecoveryAttempts.has(state.id)) {
    automaticContextRecoveryAttempts.add(state.id);
    return applyStoreAndResumePausedBuild(state);
  }
  const action = cartRecoveryAction(state);
  if (action === "none") return state;
  if (!state) return state;
  if (action === "pause" && persistedItemsAreSafe(state)) {
    return persist({
      ...state,
      status: "paused",
      pauseKind: "recovery",
      pauseReason: `Cartiva restarted while ${retailer === "target" ? "Target" : "Walmart"} was adding this item. Check the visible cart, then resume; Cartiva will not click it twice.`,
      updatedAt: new Date().toISOString(),
    });
  }
  const validContext = retailer === "target"
    ? ["pickup", "delivery", "shipping"].includes(state.fulfillmentMode)
      && /^\d{5}$/.test(state.zip ?? "")
      && (state.fulfillmentMode !== "pickup" || /^\d{3,4}$/.test(state.storeId ?? ""))
    : ["pickup", "delivery"].includes(state.fulfillmentMode) && Boolean(state.storeId?.trim());
  if (action !== "resume" || !persistedItemsAreSafe(state) || !validContext) {
    return persist({
      ...state,
      status: "cancelled",
      pauseReason: `Cartiva could not safely recover this saved build. No ${retailer === "target" ? "Target" : "Walmart"} control was clicked.`,
      updatedAt: new Date().toISOString(),
    });
  }
  scheduleBuildLoop();
  return state;
}

async function handleRequest(message: BackgroundRequest): Promise<unknown> {
  switch (message.type) {
    case "CARTIVA_GET_PAGE_CONTEXT":
      return getPageContext();
    case "CARTIVA_FIND_NEARBY_PICKUP_STORES":
      return findNearbyPickupStores(message.zipCode, message.tabId);
    case "CARTIVA_SELECT_PICKUP_STORE":
      return selectPickupStore(message.store, message.tabId);
    case "CARTIVA_APPLY_STORE_AND_RESUME": {
      const current = await loadSafeBuild();
      if (!current) return current;
      if (!isWalmartStoreOption(message.store) || message.store.id !== current.storeId) {
        throw new Error("The selected Walmart does not match this paused basket.");
      }
      return applyStoreAndResumePausedBuild(current, message.store);
    }
    case "CARTIVA_GET_CART_BUILD": {
      const state = await loadSafeBuild();
      if (activeBuild) {
        if (state?.status === "running") rescheduleRequested = true;
        return state;
      }
      return recoverOrResumeBuild(state);
    }
    case "CARTIVA_OPEN_WALMART":
      return activeWalmartTab();
    case "CARTIVA_OPEN_WALMART_CART": {
      const tab = await activeWalmartTab();
      return tab.id ? chrome.tabs.update(tab.id, { url: "https://www.walmart.com/cart", active: true }) : null;
    }
    case "CARTIVA_OPEN_TARGET_CART": {
      const tab = await activeTargetTab();
      return tab.id ? chrome.tabs.update(tab.id, { url: "https://www.target.com/cart", active: true }) : null;
    }
    case "CARTIVA_OPEN_KROGER_URL": {
      const url = new URL(message.url);
      if (!isTrustedKrogerNavigationUrl(url.toString())) {
        throw new Error("Cartiva blocked an unexpected Kroger link.");
      }
      return chrome.tabs.create({ url: url.toString(), active: true });
    }
    case "CARTIVA_CANCEL_CART_BUILD": {
      if (activeBuildId) stoppedBuildIds.add(activeBuildId);
      const current = await loadSafeBuild();
      if (!current) return null;
      stoppedBuildIds.add(current.id);
      return persist({ ...current, status: "cancelled", updatedAt: new Date().toISOString() });
    }
    case "CARTIVA_START_CART_BUILD": {
      if (message.confirmed !== true) throw new Error("Cart confirmation was not provided.");
      validateBuildRequest(message);
      let existing = await loadSafeBuild();
      if (existing?.status === "running" || existing?.status === "paused") {
        throw new Error("Finish or cancel the current retailer cart build before starting another.");
      }
      // Cancellation persists immediately, but a guarded navigation or content
      // request from the old build may still be unwinding. Wait for that loop so
      // two builds can never overlap, then re-check authoritative storage.
      if (activeBuild) {
        await activeBuild;
        existing = await loadSafeBuild();
      }
      if (activeBuild || existing?.status === "running" || existing?.status === "paused") {
        throw new Error("Finish or cancel the current retailer cart build before starting another.");
      }
      const state = startCartBuild(createCartBuild(message.items, true, {
        retailer: message.retailer === "target" ? "target" : "walmart",
        storeId: message.storeId?.trim() || undefined,
        storeName: message.storeName?.trim() || undefined,
        storeAddress: message.storeAddress?.trim() || undefined,
        zip: message.zip?.trim() || undefined,
        fulfillmentMode: message.fulfillmentMode,
      }));
      activeBuildId = state.id;
      await persist(state);
      scheduleBuildLoop();
      return state;
    }
    case "CARTIVA_RESUME_CART_BUILD": {
      let state = await loadSafeBuild();
      if (state?.status === "running") {
        scheduleBuildLoop();
        return state;
      }
      if (!state || state.status !== "paused") return state;
      const current = state.items[state.cursor];
      const retailer = state.retailer === "target" ? "target" : "walmart";
      const retailerTabId = retailer === "target" ? state.targetTabId : state.walmartTabId;
      if (!retailerTabId) return state;
      if (state.pauseKind === "context") {
        const buildId = state.id;
        const latest = await loadSafeBuild();
        if (stoppedBuildIds.has(buildId)) {
          if (latest?.id === buildId && latest.status !== "cancelled") {
            return persist({ ...latest, status: "cancelled", updatedAt: new Date().toISOString() });
          }
          return latest;
        }
        if (!latest || latest.id !== buildId || latest.status !== "paused" || latest.pauseKind !== "context") {
          return latest;
        }
        state = latest;
        state = await persist(resumeAfterContextPause(state));
        scheduleBuildLoop();
        return state;
      }
      const buildId = state.id;
      const result = await safeSendToTab<{ added: boolean; message: string }>(retailerTabId, {
        type: retailer === "target" ? "CARTIVA_TARGET_VERIFY_MANUAL_ADD" : "CARTIVA_WALMART_VERIFY_MANUAL_ADD",
        baselineCartCount: current.baselineCartCount,
        productTitle: current.productTitle,
        expectedQuantity: current.quantity,
      });
      const latest = await loadSafeBuild();
      if (!latest || latest.id !== buildId || latest.status !== "paused") return latest;
      state = latest;
      if (retailer === "target" && !result.added) {
        const retry = retryCurrentAfterChoice(state);
        if (retry !== state) {
          state = await persist(retry);
          scheduleBuildLoop();
          return state;
        }
      }
      state = await persist(resumeAfterChoice(state, result.added, result.message));
      scheduleBuildLoop();
      return state;
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isBackgroundRequest(message)) return;
  if (!isTrustedSidePanelSender(sender, chrome.runtime.id)) {
    sendResponse({ error: "Cartiva blocked a background request from an unexpected extension page." });
    return;
  }
  void handleRequest(message).then(sendResponse).catch((error: unknown) => {
    sendResponse({ error: error instanceof Error ? error.message : "Cartiva extension error." });
  });
  return true;
});

void loadSafeBuild().then((state) => recoverOrResumeBuild(state));
