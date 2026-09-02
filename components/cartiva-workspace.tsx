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
import type { KrogerMatchResult, KrogerSearchStreamEvent } from "@/lib/types";
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
import type { CartivaKrogerCartCode } from "@/lib/cartiva-kroger-handoff";
import { MAX_CARTIVA_INGREDIENTS, type ConsolidatedIngredient } from "@/lib/cartiva-planning";
import styles from "@/components/cartiva-workspace.module.css";

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
}

interface CartivaWorkspaceProps {
  loadListId?: string;
  loadBasketId?: string;
}

function replaceItem(items: GroceryNotepadItem[], index: number, value: string | null) {
  return items
    .flatMap((item, itemIndex) => itemIndex === index ? (value?.trim() ? [value.trim()] : []) : [item.raw])
    .join("\n");
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
  const response = await fetch("/api/kroger/auth/status", { cache: "no-store" });
  const body = await response.json().catch(() => ({})) as CartivaKrogerAuthStatusBody;
  return getCartivaKrogerPreflight(response.ok, body);
}

async function postPendingKrogerCart(pending: PendingKrogerCart) {
  return fetch("/api/kroger/cart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: pending.operationId,
      locationId: pending.locationId,
      fulfillmentMode: pending.fulfillmentMode,
      items: pending.items,
    }),
  });
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
    saveList,
    recordComparison: saveComparisonHistory,
    saveBasket,
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
  const [listName, setListName] = useState("Weekly groceries");
  const [activeListId, setActiveListId] = useState<string>();
  const [lastComparisonRecord, setLastComparisonRecord] = useState<CartivaComparisonRecord | null>(null);
  const [creationMode, setCreationMode] = useState<CartivaCreationMode>("grocery-list");
  const [creationDraftKey, setCreationDraftKey] = useState(0);
  const [krogerConnection, setKrogerConnection] = useState<{
    checked?: boolean;
    checking?: boolean;
    connected?: boolean;
    configured?: boolean;
    state?: CartivaKrogerConnectionState;
  }>({});
  const comparisonRunRef = useRef(0);
  const cartTransferRef = useRef<string | undefined>(undefined);
  const handoffAttemptRef = useRef<string | undefined>(undefined);
  const loadedRequestRef = useRef("");
  const previousClarificationCountRef = useRef<number | undefined>(undefined);

  const interpretation = useMemo(
    () => interpretGroceryInput(rawInput, { proteinOrigins }),
    [proteinOrigins, rawInput],
  );
  const selectedLocation = locations.find((location) => location.locationId === selectedLocationId);
  const currentSnapshot: CartivaListSnapshot = {
    rawInput,
    quantities,
    fulfillmentMode,
    zipCode: zipInput,
    proteinOrigins,
  };
  const activeSavedList = activeListId
    ? library.lists.find((list) => list.id === activeListId)
    : undefined;
  const normalizedListName = listName.replace(/\s+/g, " ").trim() || "Untitled list";
  const listSaved = Boolean(
    activeSavedList
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
    quantities,
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
        if (value.quantities && typeof value.quantities === "object") setQuantities(value.quantities);
        if (value.fulfillmentMode === "pickup" || value.fulfillmentMode === "delivery") {
          setFulfillmentMode(value.fulfillmentMode);
        }
        if (typeof value.listName === "string") setListName(value.listName.slice(0, 80));
        if (typeof value.activeListId === "string") setActiveListId(value.activeListId);
        setProteinOrigins(sanitizeGroceryProteinOrigins(value.proteinOrigins));
      }
    } catch {
      window.localStorage.removeItem(WORKSPACE_KEY);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(WORKSPACE_KEY, JSON.stringify({
      rawInput,
      zipCode: zipInput,
      quantities,
      fulfillmentMode,
      listName,
      activeListId,
      proteinOrigins,
    } satisfies StoredWorkspace));
  }, [activeListId, fulfillmentMode, hydrated, listName, proteinOrigins, quantities, rawInput, zipInput]);

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
    console.info("[Cartiva] KROGER CART READINESS", {
      basketComplete: cartReadiness.basketComplete ? "YES" : "NO",
      acceptedLines: `${cartReadiness.acceptedLineCount} / ${cartReadiness.totalLineCount}`,
      cartEligibleLines: `${cartReadiness.cartEligibleLineCount} / ${cartReadiness.totalLineCount}`,
      upcsAvailable: `${cartReadiness.upcLineCount} / ${cartReadiness.totalLineCount}`,
      quantitiesValid: cartReadiness.quantitiesValid ? "YES" : "NO",
      customerConnected: cartReadiness.customerConnected === undefined
        ? "UNKNOWN"
        : cartReadiness.customerConnected ? "YES" : "NO",
      cartCapability: cartReadiness.cartCapability === undefined
        ? "UNKNOWN"
        : cartReadiness.cartCapability ? "YES" : "NO",
      canAddToKroger: cartReadiness.canAddToKroger ? "YES" : "NO",
      reason: cartReadiness.canAddToKroger ? undefined : cartReadiness.reason,
    });
  }, [
    cartReadiness.acceptedLineCount,
    cartReadiness.basketComplete,
    cartReadiness.canAddToKroger,
    cartReadiness.cartCapability,
    cartReadiness.cartEligibleLineCount,
    cartReadiness.customerConnected,
    cartReadiness.quantitiesValid,
    cartReadiness.reason,
    cartReadiness.totalLineCount,
    cartReadiness.upcLineCount,
    comparison.phase,
    hydrated,
  ]);

  const invalidateComparison = () => {
    comparisonRunRef.current += 1;
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
  ) => {
    const remainingSlots = Math.max(0, MAX_CARTIVA_INGREDIENTS - interpretation.items.length);
    if (!ingredients.length || ingredients.length > remainingSlots) return;
    const wasEmpty = interpretation.items.length === 0;
    addItems(ingredients.map((ingredient) => ingredient.shoppingText).join("\n"), source);
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
    const item = interpretation.items[index];
    if (item) {
      setProteinOrigins((current) => moveProteinOrigins(current, item, index, value));
    }
    updateRawInput(replaceItem(interpretation.items, index, value));
  };

  const removeItem = (index: number) => {
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
    updateRawInput(replaceItem(interpretation.items, index, null));
  };

  const clarifyItem = (index: number, clarificationId: string, value: string) => {
    const item = interpretation.items[index];
    if (!item) return;
    const resolved = resolveGroceryClarification(item.raw, clarificationId, value);
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
    const nextRawInput = replaceItem(interpretation.items, index, resolved.raw);
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
    setLocationBusy(true);
    try {
      console.info("[Cartiva] Location request", { sent: true, zipValid: true });
      const response = await fetch("/api/kroger/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zipCode: requestedZip }),
      });
      console.info("[Cartiva] Location response", { status: response.status, ok: response.ok });
      if (!response.ok) throw new Error(await responseError(response, "Kroger store lookup failed."));
      const body = await response.json() as { locations?: CartivaLocation[] };
      const nextLocations = Array.isArray(body.locations) ? body.locations : [];
      if (!nextLocations.length) {
        throw new Error("We couldn't find a participating Kroger-family store near this ZIP.");
      }
      const nextSelected = nextLocations.find((location) => location.locationId === selectedLocationId)
        ?? nextLocations[0];
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
      setLocationBusy(false);
    }
  };

  const findLocation = async () => {
    setComparison((current) => ({ ...current, phase: "finding-store", message: "Finding nearby Kroger-family stores…" }));
    try {
      await loadLocations(zipInput);
      setComparison(initialComparison);
    } catch (error) {
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
    const runId = comparisonRunRef.current + 1;
    comparisonRunRef.current = runId;
    const currentInterpretation = interpretGroceryInput(rawInput, { proteinOrigins });
    const runQuantities = Object.fromEntries(
      currentInterpretation.items.map((item) => [item.id, quantities[item.id] ?? 1]),
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
        const event = JSON.parse(line) as KrogerSearchStreamEvent;
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

      const finalResults = results.map((result, index) => result ?? {
        retailer: "kroger" as const,
        requestedItem: requestItems[index].text,
        recommended: null,
        alternatives: [],
        confidence: "low" as const,
        status: "no_match" as const,
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
        message: error instanceof Error ? error.message : "Kroger comparison failed.",
      }));
      return null;
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
        items: buildKrogerCartLines(interpretation.items, comparison.results, quantities),
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
        const startResponse = await fetch("/api/kroger/oauth/start", { method: "POST" });
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
          if (popupOutcome === "cancelled" || popupOutcome === "closed") {
            throw new KrogerOAuthCancelledError();
          }
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
      if (pending.submittedAt !== undefined) {
        const message = "A Kroger cart request was interrupted before Cartiva could confirm it. Check your retailer cart before starting another handoff.";
        const blocked = blockPendingKrogerCart(pending, message);
        window.localStorage.setItem(KROGER_PENDING_CART_STORAGE_KEY, JSON.stringify(blocked));
        setCart({ phase: "error", code: "outcome_unknown", retrySafe: false, message });
        return;
      }
      if (handoffAttemptRef.current === pending.operationId) return;
      if (cartTransferRef.current === pending.operationId) return;
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
    window.addEventListener("storage", resumeConnectedBasket);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.removeEventListener("focus", resumeConnectedBasket);
      window.removeEventListener("storage", resumeConnectedBasket);
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
    }
    if (cart.phase !== "success" && cart.retrySafe !== false) setCart(initialCart);
  };

  const newList = () => {
    if (rawInput.trim() && !window.confirm("Start a new list? This clears the groceries in this workspace.")) return;
    if (!clearPendingKrogerCartBeforeBasketChange()) return;
    setRawInput("");
    setProteinOrigins({});
    setQuantities({});
    setListName("Untitled list");
    setActiveListId(undefined);
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
              <div className={styles.workspaceGrid}>
                <CartivaGroceryList
                  items={interpretation.items}
                  quantities={quantities}
                  locations={locations}
                  selectedLocationId={selectedLocationId}
                  fulfillmentMode={fulfillmentMode}
                  comparisonPhase={comparison.phase}
                  locked={handoffBusy}
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
                  quantities={quantities}
                  comparison={comparison}
                  selectedLocation={selectedLocation}
                  fulfillmentMode={fulfillmentMode}
                  cart={cart}
                  cartReadiness={cartReadiness}
                  basketSaved={Boolean(lastComparisonRecord && library.baskets.some((basket) => basket.id === lastComparisonRecord.id))}
                  connectionChecking={Boolean(
                    comparison.phase === "complete"
                    && cart.phase === "idle"
                    && krogerConnection.checking,
                  )}
                  connectionState={krogerConnection.state}
                  onChangeStore={changeStore}
                  onRetry={runComparison}
                  onReviewItem={reviewItem}
                  onSaveBasket={lastComparisonRecord?.complete ? () => saveBasket(lastComparisonRecord) : undefined}
                  onAddToKroger={addToKroger}
                  onContinueWithoutTransfer={continueWithoutTransfer}
                  onResolveCartReview={resolveCartReview}
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
                onCommit={(ingredients, suggestedName) => commitGeneratedIngredients(ingredients, suggestedName, "plan")}
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
