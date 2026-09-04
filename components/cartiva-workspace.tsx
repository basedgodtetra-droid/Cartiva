"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  groceryProteinOriginKey,
  interpretGroceryInput,
  resolveGroceryClarification,
  sanitizeGroceryProteinOrigins,
  type GroceryNotepadItem,
  type GroceryProteinOriginMap,
} from "@/lib/grocery-notepad";
import type { KrogerMatchResult } from "@/lib/types";
import { decodeCartivaSearchEvent } from "@/lib/cartiva-search-event";
import { CartivaComparison } from "@/components/cartiva-comparison";
import { CartivaGroceryList } from "@/components/cartiva-grocery-list";
import {
  CartivaCreationModeTabs,
  CartivaPlanBuilder,
  CartivaRecipeImporter,
  type CartivaCreationMode,
} from "@/components/cartiva-list-creation";
import { useCartivaLibrary } from "@/components/cartiva-library-provider";
import { CartivaShell } from "@/components/cartiva-shell";
import type {
  CartState,
  CartivaLocation,
  ComparisonState,
} from "@/components/cartiva-workspace-types";
import { getCompareReadiness } from "@/lib/cartiva-workspace-readiness";
import {
  buildCartivaComparisonRecord,
  money,
  type CartivaComparisonRecord,
  type CartivaListSnapshot,
} from "@/lib/cartiva-library";
import {
  blockPendingKrogerCart,
  buildKrogerCartLines,
  createPendingKrogerCart,
  getKrogerCartReadiness,
  KROGER_PENDING_CART_STORAGE_KEY,
  markPendingKrogerCartRetryable,
  markPendingKrogerCartSubmitting,
  parsePendingKrogerCart,
  pendingKrogerCartMatches,
  resolvedKrogerCartQuantity,
  type PendingKrogerCart,
} from "@/lib/cartiva-kroger-cart";
import { trackCartivaEvent } from "@/lib/cartiva-product-events";
import { getCartivaWorkspaceContext } from "@/lib/cartiva-workspace-context";
import {
  getCartivaKrogerPreflight,
  type CartivaKrogerAuthStatusBody,
  type CartivaKrogerConnectionState,
} from "@/lib/cartiva-kroger-connection";
import {
  verifiedKrogerCartReceipt,
  type CartivaKrogerReceipt,
} from "@/lib/cartiva-kroger-receipt";
import { krogerCartUrl } from "@/lib/kroger-family-links";
import {
  matchedCommittedPlanItemIndexes,
  reconcileCommittedPlanState,
  trackStoredPlanIngredientEdit,
  type StoredPlanIngredient,
} from "@/lib/cartiva-plan-reconciliation";
import type { CartivaKrogerCartCode } from "@/lib/cartiva-kroger-handoff";
import { MAX_CARTIVA_INGREDIENTS, type ConsolidatedIngredient } from "@/lib/cartiva-planning";
import { parseRetailerPackageQuantity } from "@/packages/shared/src";
import styles from "@/components/cartiva-workspace.module.css";
import { editWorkspaceItem, sanitizeWorkspaceQuantities } from "@/lib/cartiva-workspace-state";
import { fetchBufferedResponse } from "@/lib/browser-request";

const WORKSPACE_KEY = "cartiva-web-workspace-v1";
const initialComparison: ComparisonState = {
  phase: "idle",
  results: [],
  completedItems: 0,
};
const initialCart: CartState = { phase: "idle" };

interface StoredWorkspace {
  rawInput?: string;
  zipCode?: string;
  quantities?: Record<string, number>;
  fulfillmentMode?: "pickup" | "delivery";
  listName?: string;
  activeListId?: string;
  proteinOrigins?: GroceryProteinOriginMap;
  creationMode?: CartivaCreationMode;
  activePlanBudgetDollars?: number;
  activePlanListOwnerId?: string;
  activePlanIngredients?: StoredPlanIngredient[];
  preferredLocationId?: string;
}

interface CartivaWorkspaceProps {
  loadListId?: string;
  loadBasketId?: string;
}

function proteinOriginsForItem(
  origins: GroceryProteinOriginMap,
  item: GroceryNotepadItem,
  index: number,
) {
  return origins[groceryProteinOriginKey(item.raw, index)]
    ?? origins[groceryProteinOriginKey(item.raw)];
}

function moveProteinOrigins(
  current: GroceryProteinOriginMap,
  item: GroceryNotepadItem,
  index: number,
  nextRaw: string,
  additions: GroceryProteinOriginMap[string] = {},
) {
  const previousKey = groceryProteinOriginKey(item.raw, index);
  const nextKey = groceryProteinOriginKey(nextRaw, index);
  const previous = proteinOriginsForItem(current, item, index);
  const next = { ...current };
  if (previousKey !== nextKey) delete next[previousKey];
  const merged = {
    ...(previous ?? {}),
    ...(current[nextKey] ?? {}),
    ...additions,
  };
  if (Object.keys(merged).length) next[nextKey] = merged;
  return sanitizeGroceryProteinOrigins(next);
}

function remapItemStateAfterPlanReconcile(
  currentItems: GroceryNotepadItem[],
  nextRawInput: string,
  currentQuantities: Record<string, number>,
  currentOrigins: GroceryProteinOriginMap,
) {
  const availableByRaw = new Map<string, number[]>();
  currentItems.forEach((item, index) => {
    const key = item.raw.trim().toLowerCase();
    availableByRaw.set(key, [...(availableByRaw.get(key) ?? []), index]);
  });
  const nextInterpretation = interpretGroceryInput(nextRawInput, { proteinOrigins: currentOrigins });
  const nextQuantities: Record<string, number> = {};
  const nextOrigins: GroceryProteinOriginMap = {};
  nextInterpretation.items.forEach((item, nextIndex) => {
    const candidates = availableByRaw.get(item.raw.trim().toLowerCase());
    const previousIndex = candidates?.shift();
    if (previousIndex === undefined) return;
    const previousItem = currentItems[previousIndex];
    const quantity = currentQuantities[previousItem.id];
    if (quantity !== undefined) nextQuantities[item.id] = quantity;
    const origins = proteinOriginsForItem(currentOrigins, previousItem, previousIndex);
    if (origins) nextOrigins[groceryProteinOriginKey(item.raw, nextIndex)] = origins;
  });
  return {
    quantities: nextQuantities,
    proteinOrigins: sanitizeGroceryProteinOrigins(nextOrigins),
  };
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}

async function cartResponseError(
  response: Response,
  fallback: string,
): Promise<{ message: string; code?: CartivaKrogerCartCode; retrySafe: boolean }> {
  try {
    const body = await response.json() as {
      error?: unknown;
      code?: unknown;
      retrySafe?: unknown;
    };
    return {
      message: typeof body.error === "string" && body.error.trim() ? body.error : fallback,
      code: body.code === "outcome_unknown" || body.code === "auth_expired"
        ? body.code
        : undefined,
      retrySafe: body.retrySafe === true,
    };
  } catch {
    return { message: fallback, retrySafe: false };
  }
}

async function checkKrogerConnection() {
  const response = await fetchBufferedResponse("/api/kroger/auth/status", { cache: "no-store" });
  const body = await response.json().catch(() => ({})) as CartivaKrogerAuthStatusBody;
  return getCartivaKrogerPreflight(response.ok, body);
}

async function postPendingKrogerCart(pending: PendingKrogerCart) {
    return await fetchBufferedResponse("/api/kroger/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: pending.operationId,
        locationId: pending.locationId,
        fulfillmentMode: pending.fulfillmentMode,
        items: pending.items,
      }),
    }, 45_000);
}

function clearPendingKrogerCartBeforeBasketChange() {
  const serialized = window.localStorage.getItem(KROGER_PENDING_CART_STORAGE_KEY);
  if (!serialized) return true;
  const pending = parsePendingKrogerCart(serialized);
  if (!pending) {
    window.localStorage.removeItem(KROGER_PENDING_CART_STORAGE_KEY);
    return true;
  }
  if (pending.blocked) return false;
  if (pending.submittedAt !== undefined) {
    const message = "A Kroger cart request was already in progress. Check your retailer cart before starting another handoff.";
    window.localStorage.setItem(
      KROGER_PENDING_CART_STORAGE_KEY,
      JSON.stringify(blockPendingKrogerCart(pending, message)),
    );
    return false;
  }
  window.localStorage.removeItem(KROGER_PENDING_CART_STORAGE_KEY);
  return true;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

class KrogerOAuthCancelledError extends Error {
  constructor(message = "Your Cartiva basket is still ready. Kroger sign-in was cancelled.") {
    super(message);
    this.name = "KrogerOAuthCancelledError";
  }
}

class KrogerOAuthFailedError extends Error {
  constructor(message = "We couldn't connect Kroger. You can try again whenever you're ready.") {
    super(message);
    this.name = "KrogerOAuthFailedError";
  }
}

function krogerOAuthPopupOutcome(authWindow: Window) {
  if (authWindow.closed) return "closed" as const;
  try {
    const current = new URL(authWindow.location.href);
    if (current.origin !== window.location.origin) return "open" as const;
    const isCartivaCallback = current.pathname.endsWith("/api/retailers/kroger/oauth/callback")
      || current.pathname.endsWith("/api/kroger/oauth/callback");
    if (!isCartivaCallback) return "open" as const;
    if (current.searchParams.has("error")) {
      return current.searchParams.get("error") === "access_denied" ? "cancelled" as const : "failed" as const;
    }
    if (/wasn['’]t connected/i.test(authWindow.document.title)) return "failed" as const;
  } catch {
    // Kroger's authorization page is cross-origin until it returns to Cartiva.
  }
  return "open" as const;
}

export function CartivaWorkspace({ loadListId, loadBasketId }: CartivaWorkspaceProps = {}) {
  const {
    state: library,
    hydrated: libraryHydrated,
    persisted: libraryPersisted,
    retrySaving,
    saveList,
    savePlan,
    recordComparison: saveComparisonHistory,
    saveBasket,
    deleteBasket,
    recordCartAdded,
  } = useCartivaLibrary();
  const [rawInput, setRawInput] = useState("");
  const [proteinOrigins, setProteinOrigins] = useState<GroceryProteinOriginMap>({});
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [zipInput, setZipInput] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [locations, setLocations] = useState<CartivaLocation[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [fulfillmentMode, setFulfillmentMode] = useState<"pickup" | "delivery">("pickup");
  const [comparison, setComparison] = useState<ComparisonState>(initialComparison);
  const [cart, setCart] = useState<CartState>(initialCart);
  const [locationBusy, setLocationBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [workspaceStorageFailed, setWorkspaceStorageFailed] = useState(false);
  const [fullListDraft, setFullListDraft] = useState<string | null>(null);
  const [listName, setListName] = useState("Weekly groceries");
  const [activeListId, setActiveListId] = useState<string>();
  const [lastComparisonRecord, setLastComparisonRecord] = useState<CartivaComparisonRecord | null>(null);
  const [creationMode, setCreationMode] = useState<CartivaCreationMode>("grocery-list");
  const [creationDraftKey, setCreationDraftKey] = useState(0);
  const [activePlanBudgetDollars, setActivePlanBudgetDollars] = useState<number>();
  const [activePlanListOwnerId, setActivePlanListOwnerId] = useState<string>();
  const [activePlanIngredients, setActivePlanIngredients] = useState<StoredPlanIngredient[]>([]);
  const [krogerConnection, setKrogerConnection] = useState<{
    checked?: boolean;
    checking?: boolean;
    connected?: boolean;
    configured?: boolean;
    state?: CartivaKrogerConnectionState;
  }>({});
  const comparisonRunRef = useRef(0);
  const comparisonAbortRef = useRef<AbortController | null>(null);
  const locationRunRef = useRef(0);
  const locationAbortRef = useRef<AbortController | null>(null);
  const preferredLocationRef = useRef("");
  const cartTransferRef = useRef<string | undefined>(undefined);
  const handoffAttemptRef = useRef<string | undefined>(undefined);
  const loadedRequestRef = useRef("");
  const previousClarificationCountRef = useRef<number | undefined>(undefined);

  const interpretation = useMemo(
    () => interpretGroceryInput(rawInput, { proteinOrigins }),
    [proteinOrigins, rawInput],
  );
  const effectiveQuantities = useMemo(() => Object.fromEntries(
    interpretation.items.map((item) => [
      item.id,
      quantities[item.id] ?? parseRetailerPackageQuantity(item.canonicalText).quantity,
    ]),
  ), [interpretation.items, quantities]);
  const selectedLocation = locations.find((location) => location.locationId === selectedLocationId);
  const currentSnapshot: CartivaListSnapshot = {
    rawInput,
    quantities: effectiveQuantities,
    fulfillmentMode,
    zipCode: zipInput,
    proteinOrigins,
  };
  const activeSavedList = activeListId
    ? library.lists.find((list) => list.id === activeListId)
    : undefined;
  const activePlanMatch = activePlanListOwnerId
    ? matchedCommittedPlanItemIndexes(interpretation.items, activePlanIngredients)
    : undefined;
  const activePlanMatchedItemCount = activePlanMatch?.matchedIndexes.size ?? 0;
  const activePlanOwnershipComplete = Boolean(
    activePlanIngredients.length
    && activePlanMatchedItemCount === activePlanIngredients.length,
  );
  const activePlanItemIds = activePlanOwnershipComplete
    ? new Set([...activePlanMatch!.matchedIndexes].map((index) => interpretation.items[index].id))
    : undefined;
  const activePlanSubtotalCents = comparison.phase === "complete" && activePlanOwnershipComplete
    ? [...activePlanMatch!.matchedIndexes].reduce<number | undefined>((subtotal, index) => {
        if (subtotal === undefined) return undefined;
        const result = comparison.results[index];
        const product = result?.status === "matched" ? result.recommended : null;
        const quantity = resolvedKrogerCartQuantity(
          result,
          effectiveQuantities[interpretation.items[index]?.id] ?? 1,
        );
        return product && quantity !== undefined
          ? subtotal + Math.round(product.price * 100) * quantity
          : undefined;
      }, 0)
    : undefined;
  const planReplacementIngredientSlots = activePlanListOwnerId
    ? Math.max(
        0,
        MAX_CARTIVA_INGREDIENTS
          - (interpretation.items.length - activePlanMatchedItemCount),
      )
    : Math.max(0, MAX_CARTIVA_INGREDIENTS - interpretation.items.length);
  const normalizedListName = listName.replace(/\s+/g, " ").trim() || "Untitled list";
  const listSaved = Boolean(
    libraryPersisted && activeSavedList
    && activeSavedList.name === normalizedListName
    && activeSavedList.rawInput === currentSnapshot.rawInput
    && activeSavedList.fulfillmentMode === currentSnapshot.fulfillmentMode
    && activeSavedList.zipCode === currentSnapshot.zipCode
    && JSON.stringify(activeSavedList.proteinOrigins ?? {}) === JSON.stringify(currentSnapshot.proteinOrigins ?? {})
    && JSON.stringify(activeSavedList.quantities) === JSON.stringify(currentSnapshot.quantities),
  );
  const readiness = getCompareReadiness({
    itemCount: interpretation.items.length,
    unresolvedCount: interpretation.unresolvedCount,
    limitReached: interpretation.limitReached,
    zipInput,
    resolvedZip: zipCode,
    selectedLocationId,
  });
  const cartReadiness = getKrogerCartReadiness({
    items: interpretation.items,
    results: comparison.results,
    quantities: effectiveQuantities,
    comparisonComplete: comparison.phase === "complete",
    customerConnected: krogerConnection.connected,
    cartCapability: krogerConnection.configured,
  });
  const matchedCount = comparison.results.filter((result) => (
    result?.status === "matched" && result.recommended
  )).length;
  const workspaceContext = getCartivaWorkspaceContext({
    itemCount: interpretation.items.length,
    unresolvedCount: interpretation.unresolvedCount,
    canCompare: readiness.canCompare,
    comparisonPhase: comparison.phase,
    completedItems: comparison.completedItems,
    matchedCount,
    cartPhase: cart.phase,
    subtotalLabel: lastComparisonRecord?.complete ? money(lastComparisonRecord.subtotalCents) : undefined,
    locationName: selectedLocation?.name,
  });
  const handoffBusy = cart.phase === "adding"
    || (cart.phase === "authorizing" && cart.code !== "oauth_required")
    || (cart.phase === "error" && cart.retrySafe === false);

  const completePendingCart = useCallback(async (pending: PendingKrogerCart) => {
    const operationId = pending.operationId;
    const transfer = async () => {
    const current = parsePendingKrogerCart(
      window.localStorage.getItem(KROGER_PENDING_CART_STORAGE_KEY),
    );
    if (!current || current.operationId !== operationId) return;
    pending = current;
    if (cartTransferRef.current === pending.operationId) return;
    if (pending.blocked) {
      setCart({
        phase: "error",
        code: pending.blocked.code,
        retrySafe: false,
        message: pending.blocked.message,
      });
      return;
    }
    if (pending.submittedAt !== undefined) {
      const message = "A Kroger cart request was interrupted before Cartiva could confirm it. Check your retailer cart before starting another handoff.";
      const blocked = blockPendingKrogerCart(pending, message);
      window.localStorage.setItem(KROGER_PENDING_CART_STORAGE_KEY, JSON.stringify(blocked));
      setCart({ phase: "error", code: "outcome_unknown", retrySafe: false, message });
      return;
    }
    cartTransferRef.current = pending.operationId;
    const submitting = markPendingKrogerCartSubmitting(pending);
    window.localStorage.setItem(KROGER_PENDING_CART_STORAGE_KEY, JSON.stringify(submitting));
    try {
      setCart({
        phase: "adding",
        message: "Adding the exact verified UPCs to Kroger…",
        retrySafe: true,
      });
      let cartResponse: Response;
      try {
        cartResponse = await postPendingKrogerCart(submitting);
      } catch {
        const message = "Cartiva lost contact while Kroger was updating the cart. Check your retailer cart before starting another handoff.";
        window.localStorage.setItem(
          KROGER_PENDING_CART_STORAGE_KEY,
          JSON.stringify(blockPendingKrogerCart(submitting, message)),
        );
        setCart({
          phase: "error",
          code: "outcome_unknown",
          retrySafe: false,
          message,
        });
        return;
      }
      if (!cartResponse.ok) {
        const failure = await cartResponseError(cartResponse, "Kroger cart could not be updated.");
        if (!failure.retrySafe) {
          window.localStorage.setItem(
            KROGER_PENDING_CART_STORAGE_KEY,
            JSON.stringify(blockPendingKrogerCart(submitting, failure.message)),
          );
        } else {
          window.localStorage.setItem(
            KROGER_PENDING_CART_STORAGE_KEY,
            JSON.stringify(markPendingKrogerCartRetryable(submitting)),
          );
        }
        setCart({
          phase: "error",
          message: failure.message,
          code: failure.code ?? "cart_add_failed",
          retrySafe: failure.retrySafe,
        });
        if (cartResponse.status === 401 || failure.code === "auth_expired") {
          setKrogerConnection({
            checked: true,
            connected: false,
            configured: true,
            state: "expired",
          });
        }
        return;
      }
      let receipt: CartivaKrogerReceipt;
      try {
        receipt = await cartResponse.json() as typeof receipt;
      } catch {
        const message = "Kroger accepted the request, but Cartiva could not confirm the receipt. Check your retailer cart before starting another handoff.";
        window.localStorage.setItem(
          KROGER_PENDING_CART_STORAGE_KEY,
          JSON.stringify(blockPendingKrogerCart(submitting, message)),
        );
        setCart({
          phase: "error",
          code: "outcome_unknown",
          retrySafe: false,
          message,
        });
        return;
      }
      const verifiedReceipt = verifiedKrogerCartReceipt(receipt, submitting);
      if (!verifiedReceipt) {
        const message = "Kroger accepted the request, but Cartiva could not verify the receipt. Check your retailer cart before starting another handoff.";
        window.localStorage.setItem(
          KROGER_PENDING_CART_STORAGE_KEY,
          JSON.stringify(blockPendingKrogerCart(submitting, message)),
        );
        setCart({
          phase: "error",
          code: "outcome_unknown",
          retrySafe: false,
          message,
        });
        return;
      }
      window.localStorage.removeItem(KROGER_PENDING_CART_STORAGE_KEY);
      const itemCount = submitting.itemCount;
      setCart({
        phase: "success",
        cartUrl: verifiedReceipt.cartUrl,
        itemCount,
        retrySafe: false,
        message: verifiedReceipt.message,
      });
      trackCartivaEvent("kroger_cart_added", {
        retailer: "kroger",
        itemCount,
      });
      if (lastComparisonRecord && lastComparisonRecord.id === submitting.comparisonId) {
        recordCartAdded({
          comparisonId: lastComparisonRecord.id,
          itemCount: lastComparisonRecord.itemCount,
          retailerLabel: lastComparisonRecord.retailerLabel,
        });
      }
      return verifiedReceipt.cartUrl;
    } finally {
      if (cartTransferRef.current === pending.operationId) {
        cartTransferRef.current = undefined;
      }
    }
    };
    if ("locks" in navigator) {
      return navigator.locks.request(`cartiva-kroger-cart-${operationId}`, transfer);
    }
    return transfer();
  }, [lastComparisonRecord, recordCartAdded]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(WORKSPACE_KEY);
      if (stored) {
        const value = JSON.parse(stored) as StoredWorkspace;
        if (typeof value.rawInput === "string") setRawInput(value.rawInput);
        if (typeof value.zipCode === "string" && /^\d{0,5}$/.test(value.zipCode)) {
          setZipInput(value.zipCode);
        }
        setQuantities(sanitizeWorkspaceQuantities(value.quantities));
        if (typeof value.preferredLocationId === "string" && /^[A-Za-z0-9]{4,16}$/.test(value.preferredLocationId)) {
          preferredLocationRef.current = value.preferredLocationId;
        }
        if (value.fulfillmentMode === "pickup" || value.fulfillmentMode === "delivery") {
          setFulfillmentMode(value.fulfillmentMode);
        }
        if (typeof value.listName === "string") setListName(value.listName.slice(0, 80));
        if (typeof value.activeListId === "string") setActiveListId(value.activeListId);
        if (value.creationMode === "grocery-list" || value.creationMode === "build-plan" || value.creationMode === "paste-recipe") {
          setCreationMode(value.creationMode);
        }
        if (
          typeof value.activePlanBudgetDollars === "number"
          && Number.isFinite(value.activePlanBudgetDollars)
          && value.activePlanBudgetDollars >= 10
          && value.activePlanBudgetDollars <= 2000
        ) {
          setActivePlanBudgetDollars(value.activePlanBudgetDollars);
        }
        if (typeof value.activePlanListOwnerId === "string" && value.activePlanListOwnerId.length <= 100) {
          setActivePlanListOwnerId(value.activePlanListOwnerId);
        }
        if (Array.isArray(value.activePlanIngredients)) {
          setActivePlanIngredients(value.activePlanIngredients.filter((ingredient): ingredient is StoredPlanIngredient => (
            Boolean(ingredient)
            && typeof ingredient === "object"
            && typeof ingredient.id === "string"
            && typeof ingredient.name === "string"
            && typeof ingredient.shoppingText === "string"
            && (ingredient.currentRaw === undefined || (
              typeof ingredient.currentRaw === "string"
              && ingredient.currentRaw.length <= 500
            ))
            && (ingredient.position === undefined || (
              Number.isSafeInteger(ingredient.position)
              && ingredient.position >= 0
              && ingredient.position < MAX_CARTIVA_INGREDIENTS
            ))
          )).slice(0, MAX_CARTIVA_INGREDIENTS));
        }
        setProteinOrigins(sanitizeGroceryProteinOrigins(value.proteinOrigins));
      }
    } catch {
      setWorkspaceStorageFailed(true);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(WORKSPACE_KEY, JSON.stringify({
      rawInput,
      zipCode: zipInput,
      quantities: effectiveQuantities,
      fulfillmentMode,
      listName,
      activeListId,
      proteinOrigins,
      creationMode,
      activePlanBudgetDollars,
      activePlanListOwnerId,
      activePlanIngredients,
      preferredLocationId: selectedLocationId || preferredLocationRef.current,
      } satisfies StoredWorkspace));
      setWorkspaceStorageFailed(false);
    } catch { setWorkspaceStorageFailed(true); }
  }, [activeListId, activePlanBudgetDollars, activePlanIngredients, activePlanListOwnerId, creationMode, effectiveQuantities, fulfillmentMode, hydrated, listName, proteinOrigins, rawInput, selectedLocationId, zipInput]);

  useEffect(() => {
    if (!hydrated || !libraryHydrated) return;
    const requestKey = loadListId
      ? `list:${loadListId}`
      : loadBasketId
        ? `basket:${loadBasketId}`
        : "";
    if (!requestKey || loadedRequestRef.current === requestKey) return;

    const savedList = loadListId ? library.lists.find((list) => list.id === loadListId) : undefined;
    const savedBasket = loadBasketId ? library.baskets.find((basket) => basket.id === loadBasketId) : undefined;
    const snapshot = savedList ?? savedBasket?.listSnapshot;
    if (!snapshot) {
      loadedRequestRef.current = requestKey;
      setComparison({ ...initialComparison, phase: "error", message: "That saved Cartiva item is no longer available on this device." });
      return;
    }

    comparisonRunRef.current += 1;
    if (!clearPendingKrogerCartBeforeBasketChange()) return;
    loadedRequestRef.current = requestKey;
    comparisonAbortRef.current?.abort();
    comparisonAbortRef.current = null;
    preferredLocationRef.current = savedBasket?.locationId ?? "";
    setFullListDraft(null);
    setRawInput(snapshot.rawInput);
    setProteinOrigins(sanitizeGroceryProteinOrigins(snapshot.proteinOrigins));
    setQuantities({ ...snapshot.quantities });
    setFulfillmentMode(snapshot.fulfillmentMode);
    setZipInput(snapshot.zipCode);
    setZipCode("");
    setLocations([]);
    setSelectedLocationId("");
    setListName(savedList?.name ?? savedBasket?.listName ?? "Weekly groceries");
    setActiveListId(savedList?.id ?? (savedBasket?.listId && library.lists.some((list) => list.id === savedBasket.listId)
      ? savedBasket.listId
      : undefined));
    setLastComparisonRecord(null);
    setActivePlanBudgetDollars(undefined);
    setActivePlanListOwnerId(undefined);
    setActivePlanIngredients([]);
    setComparison(initialComparison);
    setCart(initialCart);
  }, [cart.phase, cart.retrySafe, hydrated, library.baskets, library.lists, libraryHydrated, loadBasketId, loadListId]);

  useEffect(() => {
    if (!hydrated) return;
    console.info("[Cartiva] Compare readiness", {
      items: interpretation.items.length,
      zipValid: readiness.zipValid,
      storeSelected: readiness.storeSelected,
      clarifications: readiness.clarificationsRemaining,
      canCompare: readiness.canCompare,
    });
  }, [
    hydrated,
    interpretation.items.length,
    readiness.canCompare,
    readiness.clarificationsRemaining,
    readiness.storeSelected,
    readiness.zipValid,
  ]);

  useEffect(() => {
    if (!hydrated || !activePlanListOwnerId) return;
    if (!activePlanIngredients.length) {
      setActivePlanBudgetDollars(undefined);
      setActivePlanListOwnerId(undefined);
      return;
    }
    if (activePlanMatchedItemCount < activePlanIngredients.length) {
      setActivePlanBudgetDollars(undefined);
    }
  }, [activePlanIngredients.length, activePlanListOwnerId, activePlanMatchedItemCount, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    if (previousClarificationCountRef.current === undefined) {
      previousClarificationCountRef.current = interpretation.unresolvedCount;
      return;
    }
    if (interpretation.unresolvedCount > previousClarificationCountRef.current) {
      trackCartivaEvent("clarification_requested", {
        itemCount: interpretation.items.length,
        clarificationCount: interpretation.unresolvedCount,
      });
    }
    previousClarificationCountRef.current = interpretation.unresolvedCount;
  }, [hydrated, interpretation.items.length, interpretation.unresolvedCount]);

  useEffect(() => {
    if (comparison.phase !== "complete") return;
    const controller = new AbortController();
    setKrogerConnection((current) => ({ ...current, checking: true }));
    void fetch("/api/kroger/auth/status", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json().catch(() => ({})) as CartivaKrogerAuthStatusBody;
      const preflight = getCartivaKrogerPreflight(response.ok, body);
      if (!controller.signal.aborted) {
        setKrogerConnection({
          checked: preflight.state !== "unavailable" || preflight.configured === false,
          checking: false,
          connected: preflight.connected,
          configured: preflight.configured,
          state: preflight.state,
        });
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setKrogerConnection({
          checked: false,
          checking: false,
          connected: undefined,
          configured: undefined,
          state: "unavailable",
        });
      }
    });
    return () => controller.abort();
  }, [comparison.checkedAt, comparison.phase]);

  useEffect(() => {
    if (!hydrated || comparison.phase !== "complete") return;
    const lineDecisions = comparison.results.map((result, index) => {
      const product = result?.recommended;
      const item = interpretation.items[index];
      const quantity = resolvedKrogerCartQuantity(
        result,
        effectiveQuantities[item?.id] ?? 1,
      );
      const availability = product?.availabilityStatus === "in_stock"
        ? "VERIFIED_AVAILABLE"
        : product?.availabilityStatus === "likely_available"
          ? "LIKELY_AVAILABLE"
          : product?.availabilityStatus === "out_of_stock"
            ? "EXPLICITLY_UNAVAILABLE"
            : "AVAILABILITY_UNKNOWN";
      const productMatch = result?.status === "matched" && Boolean(product);
      const packagePass = productMatch && (
        !result?.fulfillment || result.fulfillment.approvalRequired === false
      );
      const cartEligible = Boolean(
        productMatch
        && packagePass
        && product?.cartEligible
        && product.availabilityStatus !== "out_of_stock"
        && /^\d{8,14}$/.test(product.upc)
        && Number.isFinite(product.price)
        && product.price > 0
        && quantity !== undefined,
      );
      return {
        item: item?.canonicalText ?? result?.requestedItem ?? `Line ${index + 1}`,
        identity: productMatch && product?.identityVerified ? "PASS" : "FAIL",
        package: packagePass ? "PASS" : "FAIL",
        upc: product && /^\d{8,14}$/.test(product.upc) ? "PRESENT" : "MISSING",
        price: product && Number.isFinite(product.price) && product.price > 0
          ? money(product.price * 100)
          : "MISSING",
        availability,
        productMatch: productMatch ? "PASS" : "FAIL",
        cartEligible: cartEligible ? "YES" : "NO",
        display: product?.availabilityStatus === "in_stock"
          ? "Available"
          : product?.availabilityStatus === "out_of_stock"
            ? "Out of stock"
            : "Check availability",
      };
    });
    console.info("[Cartiva] KROGER CART READINESS", {
      basketComplete: cartReadiness.basketComplete ? "YES" : "NO",
      acceptedLines: `${cartReadiness.acceptedLineCount} / ${cartReadiness.totalLineCount}`,
      cartEligibleLines: `${cartReadiness.cartEligibleLineCount} / ${cartReadiness.totalLineCount}`,
      upcsAvailable: `${cartReadiness.upcLineCount} / ${cartReadiness.totalLineCount}`,
      pricesAvailable: `${cartReadiness.pricedLineCount} / ${cartReadiness.totalLineCount}`,
      availabilityUnconfirmed: cartReadiness.availabilityUnconfirmedCount,
      explicitlyUnavailable: cartReadiness.explicitlyUnavailableCount,
      quantitiesValid: cartReadiness.quantitiesValid ? "YES" : "NO",
      customerConnected: cartReadiness.customerConnected === undefined
        ? "UNKNOWN"
        : cartReadiness.customerConnected ? "YES" : "NO",
      cartCapability: cartReadiness.cartCapability === undefined
        ? "UNKNOWN"
        : cartReadiness.cartCapability ? "YES" : "NO",
      canAddToKroger: cartReadiness.canAddToKroger ? "YES" : "NO",
      reason: cartReadiness.canAddToKroger ? undefined : cartReadiness.reason,
      lines: lineDecisions,
    });
  }, [
    cartReadiness.acceptedLineCount,
    cartReadiness.availabilityUnconfirmedCount,
    cartReadiness.basketComplete,
    cartReadiness.canAddToKroger,
    cartReadiness.cartCapability,
    cartReadiness.cartEligibleLineCount,
    cartReadiness.customerConnected,
    cartReadiness.explicitlyUnavailableCount,
    cartReadiness.pricedLineCount,
    cartReadiness.quantitiesValid,
    cartReadiness.reason,
    cartReadiness.totalLineCount,
    cartReadiness.upcLineCount,
    comparison.phase,
    comparison.results,
    effectiveQuantities,
    hydrated,
    interpretation.items,
  ]);

  const invalidateComparison = () => {
    comparisonRunRef.current += 1;
    comparisonAbortRef.current?.abort();
    comparisonAbortRef.current = null;
    locationRunRef.current += 1;
    locationAbortRef.current?.abort();
    setLocationBusy(false);
    clearPendingKrogerCartBeforeBasketChange();
    setComparison(initialComparison);
    setCart(initialCart);
    setLastComparisonRecord(null);
  };

  const saveCurrentList = () => {
    const id = saveList({
      id: activeListId,
      name: normalizedListName,
      snapshot: currentSnapshot,
      itemCount: interpretation.items.length,
    });
    setListName(normalizedListName);
    setActiveListId(id);
  };

  const updateRawInput = (value: string) => {
    setRawInput(value);
    invalidateComparison();
  };

  const addItems = (value: string, source: "single" | "paste" | "plan" | "recipe") => {
    const nextRawInput = rawInput.trim() ? `${rawInput.trim()}\n${value.trim()}` : value.trim();
    const nextInterpretation = interpretGroceryInput(nextRawInput, { proteinOrigins });
    const addedCount = Math.max(0, nextInterpretation.items.length - interpretation.items.length);
    if (!addedCount) {
      updateRawInput(nextRawInput);
      return;
    }
    if (!interpretation.items.length) {
      trackCartivaEvent("list_started", { source, itemCount: addedCount });
    }
    trackCartivaEvent("item_added", {
      source,
      addedCount,
      itemCount: nextInterpretation.items.length,
    });
    if (source === "paste") {
      trackCartivaEvent("list_pasted", {
        source,
        addedCount,
        itemCount: nextInterpretation.items.length,
      });
    }
    updateRawInput(nextRawInput);
  };

  const commitGeneratedIngredients = (
    ingredients: ConsolidatedIngredient[],
    suggestedName: string,
    source: "plan" | "recipe",
    plannedBudgetDollars?: number,
    planId?: string,
  ) => {
    const replacingCommittedPlan = source === "plan" && Boolean(planId) && activePlanListOwnerId === planId;
    const remainingSlots = replacingCommittedPlan
      ? planReplacementIngredientSlots
      : Math.max(0, MAX_CARTIVA_INGREDIENTS - interpretation.items.length);
    if ((!ingredients.length && !replacingCommittedPlan) || ingredients.length > remainingSlots) return;
    const wasEmpty = interpretation.items.length === 0;
    const generatedText = ingredients.map((ingredient) => ingredient.shoppingText).join("\n");
    let storedPlanIngredients = ingredients.map((ingredient, index) => ({
      id: ingredient.id,
      name: ingredient.name,
      shoppingText: ingredient.shoppingText,
      currentRaw: ingredient.shoppingText,
      position: interpretation.items.length + index,
    } satisfies StoredPlanIngredient));
    if (replacingCommittedPlan) {
      const reconciled = reconcileCommittedPlanState(
        interpretation.items,
        activePlanIngredients,
        ingredients,
      );
      const nextRawInput = reconciled.rawInput;
      storedPlanIngredients = reconciled.storedIngredients;
      const remapped = remapItemStateAfterPlanReconcile(
        interpretation.items,
        nextRawInput,
        quantities,
        proteinOrigins,
      );
      setRawInput(nextRawInput);
      setProteinOrigins(remapped.proteinOrigins);
      setQuantities(remapped.quantities);
      invalidateComparison();
    } else {
      addItems(generatedText, source);
    }
    if (source === "plan") {
      setActivePlanBudgetDollars(ingredients.length ? plannedBudgetDollars : undefined);
      setActivePlanListOwnerId(ingredients.length && planId ? planId : undefined);
      setActivePlanIngredients(storedPlanIngredients);
    }
    if (wasEmpty && suggestedName.trim()) {
      setListName(suggestedName.replace(/\s+/g, " ").trim().slice(0, 80));
      setActiveListId(undefined);
    }
    setCreationMode("grocery-list");
    window.requestAnimationFrame(() => {
      document.getElementById("grocery-list-heading")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    });
  };

  const editItem = (index: number, value: string) => {
    if (interpretation.limitReached || interpretation.inputIssues?.length) return;
    const item = interpretation.items[index];
    if (item) {
      setProteinOrigins((current) => moveProteinOrigins(current, item, index, value));
    }
    const trackedPlan = trackStoredPlanIngredientEdit(
      interpretation.items,
      activePlanIngredients,
      index,
      value,
    );
    if (trackedPlan.tracked) {
      setActivePlanIngredients(trackedPlan.ingredients);
      setActivePlanBudgetDollars(undefined);
      if (!trackedPlan.ingredients.length) setActivePlanListOwnerId(undefined);
    }
    const edited = editWorkspaceItem(interpretation.items, index, value, quantities);
    const origins = remapItemStateAfterPlanReconcile(interpretation.items, edited.rawInput, quantities, proteinOrigins).proteinOrigins;
    if (item && interpretGroceryInput(value).items.length === 1) {
      const chosen = proteinOriginsForItem(proteinOrigins, item, index);
      if (chosen) origins[groceryProteinOriginKey(value, index)] = chosen;
    }
    setProteinOrigins(origins);
    setQuantities(edited.quantities);
    updateRawInput(edited.rawInput);
  };

  const removeItem = (index: number) => {
    if (interpretation.limitReached || interpretation.inputIssues?.length) return;
    const trackedPlan = trackStoredPlanIngredientEdit(
      interpretation.items,
      activePlanIngredients,
      index,
      null,
    );
    if (trackedPlan.tracked) {
      setActivePlanIngredients(trackedPlan.ingredients);
      setActivePlanBudgetDollars(undefined);
      if (!trackedPlan.ingredients.length) setActivePlanListOwnerId(undefined);
    }
    setProteinOrigins((current) => {
      const next: GroceryProteinOriginMap = {};
      for (const [itemIndex, item] of interpretation.items.entries()) {
        if (itemIndex === index) continue;
        const origins = proteinOriginsForItem(current, item, itemIndex);
        if (!origins) continue;
        const nextIndex = itemIndex > index ? itemIndex - 1 : itemIndex;
        next[groceryProteinOriginKey(item.raw, nextIndex)] = origins;
      }
      return sanitizeGroceryProteinOrigins(next);
    });
    const edited = editWorkspaceItem(interpretation.items, index, null, quantities);
    setQuantities(edited.quantities);
    updateRawInput(edited.rawInput);
  };

  const clarifyItem = (index: number, clarificationId: string, value: string) => {
    if (interpretation.limitReached || interpretation.inputIssues?.length) return;
    const item = interpretation.items[index];
    if (!item) return;
    const resolved = resolveGroceryClarification(item.raw, clarificationId, value);
    setActivePlanIngredients((current) => trackStoredPlanIngredientEdit(
      interpretation.items,
      current,
      index,
      resolved.raw,
    ).ingredients);
    let nextProteinOrigins = proteinOrigins;
    if (resolved.selectedAttribute) {
      nextProteinOrigins = moveProteinOrigins(
        proteinOrigins,
        item,
        index,
        resolved.raw,
        {
          [resolved.selectedAttribute!.key]: resolved.selectedAttribute!.origin,
        },
      );
      setProteinOrigins(nextProteinOrigins);
    }
    const edited = editWorkspaceItem(interpretation.items, index, resolved.raw, quantities);
    const nextRawInput = edited.rawInput;
    setQuantities(edited.quantities);
    const nextInterpretation = interpretGroceryInput(nextRawInput, { proteinOrigins: nextProteinOrigins });
    trackCartivaEvent("clarification_completed", {
      itemCount: nextInterpretation.items.length,
      clarificationCount: nextInterpretation.unresolvedCount,
    });
    if (nextInterpretation.items[index]?.clarification) {
      trackCartivaEvent("clarification_requested", {
        itemCount: nextInterpretation.items.length,
        clarificationCount: nextInterpretation.unresolvedCount,
      });
    }
    updateRawInput(nextRawInput);
  };

  const updateQuantity = (id: string, quantity: number) => {
    setQuantities((current) => ({ ...current, [id]: quantity }));
    invalidateComparison();
  };

  const selectLocation = (locationId: string) => {
    preferredLocationRef.current = locationId;
    setSelectedLocationId(locationId);
    trackCartivaEvent("store_selected", {
      source: "manual",
      retailer: "kroger",
      fulfillmentMode,
    });
    invalidateComparison();
  };

  const selectFulfillment = (mode: "pickup" | "delivery") => {
    setFulfillmentMode(mode);
    invalidateComparison();
  };

  const loadLocations = async (requestedZip: string) => {
    if (!/^\d{5}$/.test(requestedZip)) {
      throw new Error("Enter a valid 5-digit ZIP code.");
    }
    const locationRun = ++locationRunRef.current;
    locationAbortRef.current?.abort();
    const controller = new AbortController();
    locationAbortRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    setLocationBusy(true);
    try {
      console.info("[Cartiva] Location request", { sent: true, zipValid: true });
      const response = await fetch("/api/kroger/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zipCode: requestedZip }),
        signal: controller.signal,
      });
      console.info("[Cartiva] Location response", { status: response.status, ok: response.ok });
      if (!response.ok) throw new Error(await responseError(response, "Kroger store lookup failed."));
      const body = await response.json() as { locations?: CartivaLocation[] };
      if (locationRun !== locationRunRef.current) throw new DOMException("Store lookup replaced", "AbortError");
      const nextLocations = Array.isArray(body.locations) ? body.locations.filter((location) => (
        location && typeof location.locationId === "string" && typeof location.name === "string"
        && typeof location.chain === "string" && location.address && typeof location.address.city === "string"
      )) : [];
      if (!nextLocations.length) {
        throw new Error("We couldn't find a participating Kroger-family store near this ZIP.");
      }
      const nextSelected = nextLocations.find((location) => location.locationId === (selectedLocationId || preferredLocationRef.current))
        ?? nextLocations[0];
      preferredLocationRef.current = nextSelected.locationId;
      setZipCode(requestedZip);
      setLocations(nextLocations);
      setSelectedLocationId(nextSelected.locationId);
      setCart(initialCart);
      trackCartivaEvent("zip_entered", {
        retailer: "kroger",
        fulfillmentMode,
        storeCount: nextLocations.length,
      });
      trackCartivaEvent("store_selected", {
        source: "automatic",
        retailer: "kroger",
        fulfillmentMode,
      });
      console.info("[Cartiva] Selected location", { selected: true });
      return nextSelected;
    } finally {
      window.clearTimeout(timer);
      if (locationRun === locationRunRef.current) setLocationBusy(false);
    }
  };

  const findLocation = async () => {
    const expectedRun = locationRunRef.current + 1;
    setComparison((current) => ({ ...current, phase: "finding-store", message: "Finding nearby Kroger-family stores…" }));
    try {
      await loadLocations(zipInput);
      if (locationRunRef.current !== expectedRun) return;
      setComparison(initialComparison);
    } catch (error) {
      if (locationRunRef.current !== expectedRun) return;
      setComparison({
        ...initialComparison,
        phase: "error",
        message: error instanceof Error ? error.message : "Kroger store lookup failed.",
      });
    }
  };

  const runComparison = async (): Promise<{
    results: KrogerMatchResult[];
    location: CartivaLocation;
    comparisonRecord: CartivaComparisonRecord | null;
  } | null> => {
    if (comparisonAbortRef.current) return null;
    const runId = comparisonRunRef.current + 1;
    comparisonRunRef.current = runId;
    const currentInterpretation = interpretGroceryInput(rawInput, { proteinOrigins });
    const runQuantities = Object.fromEntries(
      currentInterpretation.items.map((item) => [
        item.id,
        quantities[item.id] ?? parseRetailerPackageQuantity(item.canonicalText).quantity,
      ]),
    );
    const runListSnapshot: CartivaListSnapshot = {
      rawInput,
      quantities: runQuantities,
      fulfillmentMode,
      zipCode: zipInput,
      proteinOrigins,
    };
    const runListName = normalizedListName;
    const runListId = activeListId;
    if (!currentInterpretation.items.length) {
      setComparison({ ...initialComparison, phase: "error", message: "Add at least one grocery item first." });
      return null;
    }
    if (currentInterpretation.unresolvedCount) {
      setComparison({ ...initialComparison, phase: "error", message: "Choose the missing grocery details before comparing." });
      return null;
    }
    if (currentInterpretation.limitReached) {
      setComparison({ ...initialComparison, phase: "error", message: "Compare up to 50 groceries at once. Edit the full list to split it into smaller baskets." });
      return null;
    }
    if (!/^\d{5}$/.test(zipInput)) {
      setComparison({ ...initialComparison, phase: "error", message: "Enter a valid 5-digit ZIP code." });
      document.getElementById("cartiva-zip")?.focus();
      return null;
    }

    // A fresh comparison may produce different verified UPCs. Never let a
    // retryable transfer from the previous result resume against this run.
    if (!clearPendingKrogerCartBeforeBasketChange()) return null;

    trackCartivaEvent("comparison_started", {
      retailer: "kroger",
      fulfillmentMode,
      itemCount: currentInterpretation.items.length,
      readyCount: currentInterpretation.readyCount,
    });

    const controller = new AbortController();
    comparisonAbortRef.current = controller;
    const deadline = window.setTimeout(() => controller.abort(), 150_000);
    try {
      setComparison({
        phase: selectedLocation && zipCode === zipInput ? "searching" : "finding-store",
        results: Array.from({ length: currentInterpretation.items.length }, () => null),
        completedItems: 0,
        message: selectedLocation && zipCode === zipInput
          ? "Checking official Kroger product data…"
          : "Finding a nearby Kroger-family store…",
      });
      const location = selectedLocation && zipCode === zipInput
        ? selectedLocation
        : await loadLocations(zipInput);
      if (comparisonRunRef.current !== runId) return null;
      setComparison((current) => ({ ...current, phase: "searching", message: `Checking ${location.name}…` }));

      const requestItems = currentInterpretation.items.map((item) => ({
        text: item.canonicalText,
        quantity: runQuantities[item.id] ?? 1,
        requestedItemId: item.id,
      }));
      console.info("[Cartiva] Comparison request", {
        sent: true,
        itemCount: requestItems.length,
        storeSelected: true,
      });
      const response = await fetch("/api/kroger/search", {
        signal: controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          retailer: "kroger",
          items: requestItems,
          locationId: location.locationId,
          zipCode: zipInput,
          fulfillmentMode,
        }),
      });
      console.info("[Cartiva] Comparison response", { sent: true, status: response.status, ok: response.ok });
      if (!response.ok) throw new Error(await responseError(response, "Kroger comparison failed."));
      if (!response.body) throw new Error("Kroger comparison returned no results.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const results: Array<KrogerMatchResult | null> = Array.from({ length: requestItems.length }, () => null);
      const completed = new Set<number>();
      let buffered = "";
      let checkedAt: string | undefined;

      const acceptLine = (line: string) => {
        if (!line.trim() || comparisonRunRef.current !== runId) return;
        const event = decodeCartivaSearchEvent(JSON.parse(line), requestItems.length, location.locationId);
        checkedAt = event.checkedAt;
        if (event.type !== "item") return;
        results[event.index] = event.result;
        if (event.phase === "verification" || event.result.error) completed.add(event.index);
        setComparison({
          phase: "searching",
          results: [...results],
          completedItems: Math.max(completed.size, results.filter(Boolean).length),
          checkedAt,
          message: `Checking ${location.name} item by item…`,
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (comparisonRunRef.current !== runId) {
          await reader.cancel();
          return null;
        }
        buffered += decoder.decode(value, { stream: !done });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        lines.forEach(acceptLine);
        if (done) break;
      }
      acceptLine(buffered);
      if (results.some((result) => result === null) || completed.size !== requestItems.length) {
        throw new Error("The comparison stopped before all groceries were checked. Your list is safe. Please compare again.");
      }

      const finalResults = results.map((result, index) => result ?? {
        retailer: "kroger" as const,
        requestedItem: requestItems[index].text,
        recommended: null,
        alternatives: [],
        confidence: "low" as const,
        status: "no_match" as const,
        resolution: "truly_unavailable" as const,
        explanation: "Kroger did not return a verified result for this item.",
      });
      const matched = finalResults.filter((result) => result.status === "matched" && result.recommended).length;
      const finalCheckedAt = checkedAt ?? new Date().toISOString();
      setComparison({
        phase: "complete",
        results: finalResults,
        completedItems: finalResults.length,
        checkedAt: finalCheckedAt,
        message: matched === finalResults.length
          ? `All ${matched} items matched at ${location.name}.`
          : `${matched} of ${finalResults.length} items matched. A total is hidden until the basket is complete.`,
      });
      trackCartivaEvent("comparison_completed", {
        retailer: "kroger",
        fulfillmentMode,
        itemCount: finalResults.length,
        matchedCount: matched,
        directMatchedCount: finalResults.filter((result) => (
          result.status === "matched"
          && Boolean(result.recommended)
          && result.fulfillment?.kind !== "multi_package"
        )).length,
        multiPackageFulfilledCount: finalResults.filter((result) => (
          result.fulfillment?.kind === "multi_package"
        )).length,
        availabilityCheckCount: finalResults.filter((result) => (
          result.resolution === "matched_check_availability"
        )).length,
        shopperChoiceRequiredCount: finalResults.filter((result) => (
          result.resolution === "needs_choice" || result.resolution === "substitute_available"
        )).length,
        trulyUnavailableCount: finalResults.filter((result) => (
          result.resolution === "truly_unavailable" || result.status === "no_match"
        )).length,
        complete: matched === finalResults.length,
      });
      setCart(initialCart);
      const comparisonRecord = buildCartivaComparisonRecord({
        listId: runListId,
        listName: runListName,
        listSnapshot: runListSnapshot,
        items: currentInterpretation.items,
        quantities: runQuantities,
        results: finalResults,
        location,
        fulfillmentMode,
        observedAt: finalCheckedAt,
      });
      if (comparisonRecord) {
        setLastComparisonRecord(comparisonRecord);
        saveComparisonHistory(comparisonRecord);
      } else {
        setLastComparisonRecord(null);
      }
      return { results: finalResults, location, comparisonRecord };
    } catch (error) {
      if (comparisonRunRef.current !== runId) return null;
      trackCartivaEvent("comparison_failed", {
        retailer: "kroger",
        fulfillmentMode,
        itemCount: currentInterpretation.items.length,
        retrySafe: true,
      });
      setComparison((current) => ({
        ...current,
        phase: "error",
        message: controller.signal.aborted ? "The comparison timed out. Your list is safe. Please try again." : error instanceof Error ? error.message : "Kroger comparison failed.",
      }));
      return null;
    } finally {
      window.clearTimeout(deadline);
      if (comparisonAbortRef.current === controller) comparisonAbortRef.current = null;
    }
  };

  const addToKroger = async () => {
    const storedPending = parsePendingKrogerCart(
      window.localStorage.getItem(KROGER_PENDING_CART_STORAGE_KEY),
    );
    if (storedPending?.blocked) {
      setCart({
        phase: "error",
        message: storedPending.blocked.message,
        code: storedPending.blocked.code,
        retrySafe: false,
      });
      return;
    }
    if (storedPending?.submittedAt !== undefined) {
      const message = "A Kroger cart request was interrupted before Cartiva could confirm it. Check your retailer cart before starting another handoff.";
      const blocked = blockPendingKrogerCart(storedPending, message);
      window.localStorage.setItem(KROGER_PENDING_CART_STORAGE_KEY, JSON.stringify(blocked));
      setCart({ phase: "error", code: "outcome_unknown", retrySafe: false, message });
      return;
    }

    let pending = storedPending;
    if (selectedLocation && comparison.phase === "complete") {
      if (!cartReadiness.canAddToKroger) {
        setCart({ phase: "error", message: cartReadiness.reason, retrySafe: true });
        return;
      }
      const currentBasket = {
        locationId: selectedLocation.locationId,
        fulfillmentMode,
        items: buildKrogerCartLines(interpretation.items, comparison.results, effectiveQuantities),
        itemCount: interpretation.items.length,
      };
      pending = pending && pendingKrogerCartMatches(pending, currentBasket)
        ? pending
        : createPendingKrogerCart({
            operationId: `cartiva_${crypto.randomUUID().replace(/-/g, "")}`,
            ...currentBasket,
            comparisonId: lastComparisonRecord?.id,
          });
    }
    if (!pending) return;
    if (handoffAttemptRef.current === pending.operationId) return;
    handoffAttemptRef.current = pending.operationId;
    trackCartivaEvent("kroger_handoff_started", {
      retailer: "kroger",
      fulfillmentMode: pending.fulfillmentMode,
      itemCount: pending.itemCount,
      retrySafe: true,
    });
    window.localStorage.setItem(KROGER_PENDING_CART_STORAGE_KEY, JSON.stringify(pending));
    const cachedConnected = krogerConnection.checked === true && krogerConnection.connected === true;
    const authWindow = cachedConnected
      ? null
      : window.open("about:blank", "cartiva-kroger-oauth", "popup,width=560,height=760");
    if (authWindow) {
      authWindow.document.title = "Connecting to Kroger";
      authWindow.document.body.textContent = "Cartiva is preparing Kroger sign-in…";
    }
    try {
      setCart({ phase: "authorizing", message: "Checking your Kroger connection…", retrySafe: true });
      // Always perform a fresh server-side token check immediately before a
      // cart write. The comparison-time status is helpful UI state, but it can
      // expire or be revoked while the shopper reviews the basket.
      let preflight = await checkKrogerConnection();
      setKrogerConnection({
        checked: preflight.state !== "unavailable" || preflight.configured === false,
        connected: preflight.connected,
        configured: preflight.configured,
        state: preflight.state,
      });
      if (preflight.state === "unavailable") {
        throw new KrogerOAuthFailedError(preflight.message);
      }

      if (preflight.connected) {
        authWindow?.close();
        await completePendingCart(pending);
        return;
      }

      if (!authWindow) {
        if (!cachedConnected) {
          throw new KrogerOAuthFailedError("Your browser blocked the Kroger sign-in window. Allow pop-ups for Cartiva, then try again.");
        }
        const expired = preflight.state === "expired";
        setCart({
          phase: "error",
          code: expired ? "auth_expired" : "auth_required",
          retrySafe: true,
          message: expired
            ? "Your Kroger connection expired. Reconnect Kroger and Cartiva will resume this basket."
            : "Connect to Kroger to add your items. Your exact basket is preserved.",
        });
        return;
      }

      if (!preflight.connected) {
        const startResponse = await fetchBufferedResponse("/api/kroger/oauth/start", { method: "POST" });
        if (!startResponse.ok) {
          throw new KrogerOAuthFailedError(await responseError(startResponse, "Kroger sign-in could not start."));
        }
        const start = await startResponse.json() as { authorizationUrl?: string };
        if (!start.authorizationUrl) throw new KrogerOAuthFailedError("Kroger did not return an authorization link.");
        authWindow.location.href = start.authorizationUrl;
        setCart({
          phase: "authorizing",
          message: "Finish signing in with Kroger in the new window. Cartiva will continue automatically.",
          retrySafe: true,
        });

        let connected = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await wait(3_000);
          if (handoffAttemptRef.current !== pending.operationId) return;
          preflight = await checkKrogerConnection();
          if (preflight.connected) {
            connected = true;
            setKrogerConnection({
              checked: true,
              connected: true,
              configured: true,
              state: "connected",
            });
            break;
          }
          const popupOutcome = krogerOAuthPopupOutcome(authWindow);
          if (popupOutcome === "cancelled") {
            throw new KrogerOAuthCancelledError();
          }
          // A retailer can detach WindowProxy through its own opener policy.
          // Only an explicit callback cancellation proves that sign-in was cancelled.
          if (popupOutcome === "failed") throw new KrogerOAuthFailedError();
        }
        if (!connected) {
          throw new KrogerOAuthFailedError("Kroger sign-in was not completed. Your Cartiva basket is still ready.");
        }
      }

      const preserved = parsePendingKrogerCart(
        window.localStorage.getItem(KROGER_PENDING_CART_STORAGE_KEY),
      );
      if (!preserved || preserved.operationId !== pending.operationId) return;
      const cartUrl = await completePendingCart(preserved);
      if (cartUrl && !authWindow.closed) {
        // Reuse the user-opened OAuth window. After Cartiva verifies Kroger's
        // 204 response and signed receipt, send it only to the trusted banner
        // cart route. Kroger controls any first-party website sign-in needed.
        authWindow.location.replace(cartUrl);
      } else {
        authWindow.close();
      }
    } catch (error) {
      authWindow?.close();
      setCart((current) => current.retrySafe === false || current.phase === "success"
        ? current
        : {
            phase: "error",
            code: error instanceof KrogerOAuthCancelledError ? "oauth_cancelled" : "oauth_failed",
            retrySafe: true,
            message: error instanceof Error
              ? error.message
              : "We couldn't connect Kroger. Your Cartiva basket is still ready.",
          });
    } finally {
      if (handoffAttemptRef.current === pending.operationId) {
        handoffAttemptRef.current = undefined;
      }
    }
  };

  useEffect(() => {
    if (!hydrated) return;
    let disposed = false;
    const resumeConnectedBasket = async () => {
      if (disposed || cart.phase === "error") return;
      const serialized = window.localStorage.getItem(KROGER_PENDING_CART_STORAGE_KEY);
      if (!serialized) return;
      const pending = parsePendingKrogerCart(serialized);
      if (!pending) {
        window.localStorage.removeItem(KROGER_PENDING_CART_STORAGE_KEY);
        return;
      }
      if (pending.blocked) {
        setCart({
          phase: "error",
          code: pending.blocked.code,
          retrySafe: false,
          message: pending.blocked.message,
        });
        return;
      }
      // React re-runs this recovery effect when the click flow advances from
      // authorizing to adding. The active refs identify that same-tab request;
      // check them before interpreting submittedAt as an interrupted reload.
      if (handoffAttemptRef.current === pending.operationId) return;
      if (cartTransferRef.current === pending.operationId) return;
      if (pending.submittedAt !== undefined) {
        // Re-enter through the operation lock. A different live tab may still
        // own the request; in that case this waits for its confirmed result and
        // sees the cleared pending record instead of reporting a false failure.
        try {
          await completePendingCart(pending);
        } catch {
          const message = "Cartiva could not recover the Kroger cart request safely. Check your retailer cart before starting another handoff.";
          const blocked = blockPendingKrogerCart(pending, message);
          window.localStorage.setItem(KROGER_PENDING_CART_STORAGE_KEY, JSON.stringify(blocked));
          setCart({ phase: "error", code: "outcome_unknown", retrySafe: false, message });
        }
        return;
      }
      try {
        const preflight = await checkKrogerConnection();
        if (disposed || preflight.state === "unavailable") return;
        setKrogerConnection({
          checked: true,
          connected: preflight.connected,
          configured: preflight.configured,
          state: preflight.state,
        });
        if (preflight.connected) {
          await completePendingCart(pending);
        } else {
          const expired = preflight.state === "expired";
          setCart((current) => current.phase === "adding" || current.retrySafe === false
            ? current
            : {
                phase: "error",
                code: expired ? "auth_expired" : "auth_required",
                retrySafe: true,
                message: expired
                  ? "Your Kroger connection expired. Reconnect Kroger and Cartiva will resume this basket."
                  : "Connect to Kroger to add your items. Your exact basket is preserved.",
              });
        }
      } catch {
        // The click flow remains active; focus-based recovery is best effort.
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void resumeConnectedBasket();
    };
    void resumeConnectedBasket();
    window.addEventListener("focus", resumeConnectedBasket);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.removeEventListener("focus", resumeConnectedBasket);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [cart.phase, completePendingCart, hydrated]);

  const resolveCartReview = (itemsWereAdded: boolean) => {
    if (!itemsWereAdded) {
      window.localStorage.removeItem(KROGER_PENDING_CART_STORAGE_KEY);
      setCart(initialCart);
      return;
    }
    const message = "You confirmed these items are already in the retailer cart. Cartiva will not send them again.";
    window.localStorage.removeItem(KROGER_PENDING_CART_STORAGE_KEY);
    setCart({
      phase: "reviewed",
      cartUrl: krogerCartUrl(selectedLocation?.chain),
      retrySafe: false,
      message,
    });
  };

  const continueWithoutTransfer = () => {
    const pending = parsePendingKrogerCart(
      window.localStorage.getItem(KROGER_PENDING_CART_STORAGE_KEY),
    );
    if (pending && pending.submittedAt === undefined && !pending.blocked) {
      window.localStorage.removeItem(KROGER_PENDING_CART_STORAGE_KEY);
      handoffAttemptRef.current = undefined;
    }
    if (cart.phase !== "success" && cart.retrySafe !== false) setCart(initialCart);
  };

  const newList = () => {
    setFullListDraft(null);
    if (rawInput.trim() && !window.confirm("Start a new list? This clears the groceries in this workspace.")) return;
    if (!clearPendingKrogerCartBeforeBasketChange()) return;
    comparisonAbortRef.current?.abort();
    comparisonAbortRef.current = null;
    locationRunRef.current += 1;
    locationAbortRef.current?.abort();
    setLocationBusy(false);
    setRawInput("");
    setProteinOrigins({});
    setQuantities({});
    setListName("Untitled list");
    setActiveListId(undefined);
    setActivePlanBudgetDollars(undefined);
    setActivePlanListOwnerId(undefined);
    setActivePlanIngredients([]);
    setCreationMode("grocery-list");
    setCreationDraftKey((current) => current + 1);
    comparisonRunRef.current += 1;
    setLastComparisonRecord(null);
    setComparison(initialComparison);
    setCart(initialCart);
  };

  const changeStore = () => {
    document.getElementById("cartiva-zip")?.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const reviewItem = (index: number) => {
    const item = interpretation.items[index];
    if (!item) return;
    const row = document.getElementById(`list-item-${item.id}`);
    row?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
    window.requestAnimationFrame(() => {
      (document.getElementById(`edit-${item.id}`) as HTMLButtonElement | null)?.click();
      window.requestAnimationFrame(() => document.getElementById(`edit-input-${item.id}`)?.focus());
    });
  };

  return (
    <CartivaShell
      itemCount={interpretation.items.length}
      zipCode={zipCode}
      zipInput={zipInput}
      listName={listName}
      locationLabel={selectedLocation?.name}
      locationBusy={locationBusy}
      listSaved={listSaved}
      handoffBusy={handoffBusy}
      onListName={(value) => setListName(value)}
      onSaveList={saveCurrentList}
      onZipInput={(value) => {
        setZipInput(value);
        if (value !== zipCode) {
          preferredLocationRef.current = "";
          setZipCode("");
          setLocations([]);
          setSelectedLocationId("");
          invalidateComparison();
        }
      }}
      onFindLocation={findLocation}
      onNewList={newList}
    >
      <main className={styles.workspace} id="main-content">
        {workspaceStorageFailed ? <p role="alert">Your browser couldn’t remember these changes. Keep this tab open and copy your list before leaving.</p> : null}
        <div className={styles.workspaceLayout}>
          <div className={styles.primaryWorkspace}>
            <CartivaCreationModeTabs mode={creationMode} onMode={setCreationMode} />
            <header className={styles.contextHeader} data-state={workspaceContext.state}>
              <h1>{creationMode === "build-plan"
                ? "Turn your goal into a cart"
                : creationMode === "paste-recipe"
                  ? "Bring a recipe. Leave with a list."
                  : workspaceContext.headline}</h1>
              <p aria-live="polite">{creationMode === "build-plan"
                ? "Build an editable meal plan, review its ingredients, then send them through Cartiva’s normal comparison flow."
                : creationMode === "paste-recipe"
                  ? "Paste the recipe text and Cartiva will prepare a reviewable ingredient list."
                  : workspaceContext.supporting}</p>
            </header>
            <section
              id="creation-panel-grocery-list"
              role="tabpanel"
              aria-labelledby="creation-tab-grocery-list"
              hidden={creationMode !== "grocery-list"}
            >
              {interpretation.limitReached || interpretation.inputIssues?.length ? <div className={styles.pastePanel} role="alert">
                {interpretation.limitReached ? <p>This list has {interpretation.items.length + interpretation.omittedCount}{interpretation.omittedCount >= 451 ? "+" : ""} groceries. Compare up to 50 at once. Your full text is still here.</p> : null}
                {interpretation.inputIssues?.map((issue, index) => <p key={index}>{issue}</p>)}
                <button type="button" className={styles.secondaryButton} onClick={() => setFullListDraft(rawInput)}>Edit full list</button>
              </div> : null}
              {fullListDraft !== null ? <div className={styles.pastePanel}>
                <label htmlFor="full-list-recovery">Full grocery list</label>
                <textarea id="full-list-recovery" rows={8} value={fullListDraft} onChange={(event) => setFullListDraft(event.target.value)} />
                      <button type="button" className={styles.secondaryButton} onClick={() => {
                        const remapped = remapItemStateAfterPlanReconcile(interpretation.items, fullListDraft, quantities, proteinOrigins);
                        updateRawInput(fullListDraft); setQuantities(remapped.quantities); setProteinOrigins(remapped.proteinOrigins); setFullListDraft(null);
                      }}>Update list</button>
                <button type="button" className={styles.textButton} onClick={() => setFullListDraft(null)}>Cancel</button>
              </div> : null}
              <div className={styles.workspaceGrid}>
                <CartivaGroceryList
                  items={interpretation.items}
                  quantities={effectiveQuantities}
                  locations={locations}
                  selectedLocationId={selectedLocationId}
                  fulfillmentMode={fulfillmentMode}
                  comparisonPhase={comparison.phase}
                  locked={handoffBusy || interpretation.limitReached || Boolean(interpretation.inputIssues?.length)}
                  canCompare={readiness.canCompare}
                  compareHint={readiness.reason}
                  onAdd={addItems}
                  onEdit={editItem}
                  onRemove={removeItem}
                  onQuantity={updateQuantity}
                  onClarify={clarifyItem}
                  onLocation={selectLocation}
                  onFulfillment={selectFulfillment}
                  onCompare={runComparison}
                />
                <CartivaComparison
                  items={interpretation.items}
                  quantities={effectiveQuantities}
                  comparison={comparison}
                  selectedLocation={selectedLocation}
                  fulfillmentMode={fulfillmentMode}
                  cart={cart}
                  cartReadiness={cartReadiness}
                  basketSaved={Boolean(libraryPersisted && lastComparisonRecord && library.baskets.some((basket) => basket.id === lastComparisonRecord.id))}
                  connectionChecking={Boolean(
                    comparison.phase === "complete"
                    && cart.phase === "idle"
                    && krogerConnection.checking,
                  )}
                  connectionState={krogerConnection.state}
                  onChangeStore={changeStore}
                  onRetry={runComparison}
                  onReviewItem={reviewItem}
                  onSaveBasket={lastComparisonRecord?.complete ? () => {
                    if (library.baskets.some((basket) => basket.id === lastComparisonRecord.id)) {
                      if (!libraryPersisted) { retrySaving(); return; }
                      deleteBasket(lastComparisonRecord.id);
                    } else {
                      saveBasket(lastComparisonRecord);
                    }
                  } : undefined}
                  onAddToKroger={addToKroger}
                  onContinueWithoutTransfer={continueWithoutTransfer}
                  onResolveCartReview={resolveCartReview}
                  plannedBudgetDollars={activePlanBudgetDollars}
                  plannedItemIds={activePlanItemIds}
                  onReviewPlan={activePlanBudgetDollars ? () => {
                    setCreationMode("build-plan");
                    window.requestAnimationFrame(() => {
                      const budgetHeading = document.getElementById("lower-basket-plan-heading");
                      budgetHeading?.focus();
                      (budgetHeading ?? document.getElementById("creation-panel-build-plan"))?.scrollIntoView({
                        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                        block: "start",
                      });
                    });
                  } : undefined}
                />
              </div>
            </section>
            <section
              id="creation-panel-build-plan"
              role="tabpanel"
              aria-labelledby="creation-tab-build-plan"
              hidden={creationMode !== "build-plan"}
            >
              <CartivaPlanBuilder
                key={`plan-${creationDraftKey}`}
                availableIngredientSlots={Math.max(0, MAX_CARTIVA_INGREDIENTS - interpretation.items.length)}
                savedPlans={library.plans}
                libraryPersisted={libraryPersisted}
                basketOverageCents={
                  activePlanBudgetDollars && activePlanSubtotalCents !== undefined
                    ? Math.max(0, activePlanSubtotalCents - Math.round(activePlanBudgetDollars * 100)) || undefined
                    : undefined
                }
                committedPlanId={activePlanListOwnerId}
                replacementIngredientSlots={planReplacementIngredientSlots}
                onSavePlan={savePlan}
                onCommit={(ingredients, suggestedName, plan) => commitGeneratedIngredients(
                  ingredients,
                  suggestedName,
                  "plan",
                  plan.goal.budgetDollars?.value,
                  plan.id,
                )}
              />
            </section>
            <section
              id="creation-panel-paste-recipe"
              role="tabpanel"
              aria-labelledby="creation-tab-paste-recipe"
              hidden={creationMode !== "paste-recipe"}
            >
              <CartivaRecipeImporter
                key={`recipe-${creationDraftKey}`}
                availableIngredientSlots={Math.max(0, MAX_CARTIVA_INGREDIENTS - interpretation.items.length)}
                onCommit={(ingredients, suggestedName) => commitGeneratedIngredients(ingredients, suggestedName, "recipe")}
              />
            </section>
          </div>
        </div>
      </main>
    </CartivaShell>
  );
}
