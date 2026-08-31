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
import { useCartivaLibrary } from "@/components/cartiva-library-provider";
import { CartivaShell } from "@/components/cartiva-shell";
import { CartivaUtilityRail } from "@/components/cartiva-utility-rail";
import type {
  CartState,
  CartivaLocation,
  ComparisonState,
} from "@/components/cartiva-workspace-types";
import { getCompareReadiness } from "@/lib/cartiva-workspace-readiness";
import {
  buildCartivaComparisonRecord,
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

async function cartResponseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as {
      error?: unknown;
      code?: unknown;
      retrySafe?: unknown;
    };
    return {
      message: typeof body.error === "string" && body.error.trim() ? body.error : fallback,
      code: typeof body.code === "string" ? body.code : undefined,
      retrySafe: body.retrySafe === true,
    };
  } catch {
    return { message: fallback, retrySafe: false };
  }
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
  if (!serialized) return;
  const pending = parsePendingKrogerCart(serialized);
  if (!pending) {
    window.localStorage.removeItem(KROGER_PENDING_CART_STORAGE_KEY);
    return;
  }
  if (pending.blocked) return;
  if (pending.submittedAt !== undefined) {
    const message = "A Kroger cart request was already in progress. Check your retailer cart before starting another handoff.";
    window.localStorage.setItem(
      KROGER_PENDING_CART_STORAGE_KEY,
      JSON.stringify(blockPendingKrogerCart(pending, message)),
    );
    return;
  }
  window.localStorage.removeItem(KROGER_PENDING_CART_STORAGE_KEY);
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
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
  const [krogerConnection, setKrogerConnection] = useState<{
    connected?: boolean;
    configured?: boolean;
  }>({});
  const comparisonRunRef = useRef(0);
  const cartTransferRef = useRef<string | undefined>(undefined);
  const loadedRequestRef = useRef("");

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
          code: failure.code,
          retrySafe: failure.retrySafe,
        });
        return;
      }
      let receipt: {
        success?: boolean;
        operationId?: string;
        cartUrl?: string;
        addedCount?: number;
        itemCount?: number;
        message?: string;
      };
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
      if (
        receipt.success !== true
        || receipt.operationId !== submitting.operationId
        || typeof receipt.cartUrl !== "string"
        || !/^https:\/\//.test(receipt.cartUrl)
        || receipt.itemCount !== submitting.items.length
        || !Number.isInteger(receipt.addedCount)
        || (receipt.addedCount ?? 0) < submitting.items.length
      ) {
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
        cartUrl: receipt.cartUrl,
        itemCount,
        retrySafe: false,
        message: `${itemCount} matched products were added.`,
      });
      if (lastComparisonRecord && lastComparisonRecord.id === submitting.comparisonId) {
        recordCartAdded({
          comparisonId: lastComparisonRecord.id,
          itemCount: lastComparisonRecord.itemCount,
          retailerLabel: lastComparisonRecord.retailerLabel,
        });
      }
    } finally {
      if (cartTransferRef.current === pending.operationId) {
        cartTransferRef.current = undefined;
      }
    }
    };
    if ("locks" in navigator) {
      await navigator.locks.request(`cartiva-kroger-cart-${operationId}`, transfer);
    } else {
      await transfer();
    }
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
    loadedRequestRef.current = requestKey;

    const savedList = loadListId ? library.lists.find((list) => list.id === loadListId) : undefined;
    const savedBasket = loadBasketId ? library.baskets.find((basket) => basket.id === loadBasketId) : undefined;
    const snapshot = savedList ?? savedBasket?.listSnapshot;
    if (!snapshot) {
      setComparison({ ...initialComparison, phase: "error", message: "That saved Cartiva item is no longer available on this device." });
      return;
    }

    comparisonRunRef.current += 1;
    clearPendingKrogerCartBeforeBasketChange();
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
  }, [hydrated, library.baskets, library.lists, libraryHydrated, loadBasketId, loadListId]);

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
    if (comparison.phase !== "complete") return;
    const controller = new AbortController();
    void fetch("/api/kroger/auth/status", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json().catch(() => ({})) as {
        connected?: boolean;
        configured?: boolean;
      };
      if (!controller.signal.aborted) {
        setKrogerConnection({
          connected: Boolean(body.connected),
          configured: body.configured !== false && response.ok,
        });
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setKrogerConnection({ connected: false, configured: false });
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

  const addItems = (value: string) => {
    updateRawInput(rawInput.trim() ? `${rawInput.trim()}\n${value.trim()}` : value.trim());
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
    if (resolved.selectedAttribute) {
      setProteinOrigins((current) => moveProteinOrigins(
        current,
        item,
        index,
        resolved.raw,
        {
          [resolved.selectedAttribute!.key]: resolved.selectedAttribute!.origin,
        },
      ));
    }
    updateRawInput(replaceItem(interpretation.items, index, resolved.raw));
  };

  const updateQuantity = (id: string, quantity: number) => {
    setQuantities((current) => ({ ...current, [id]: quantity }));
    invalidateComparison();
  };

  const selectLocation = (locationId: string) => {
    setSelectedLocationId(locationId);
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
    window.localStorage.setItem(KROGER_PENDING_CART_STORAGE_KEY, JSON.stringify(pending));
    const authWindow = window.open("about:blank", "cartiva-kroger-oauth", "popup,width=560,height=760");
    if (authWindow) {
      authWindow.document.title = "Connecting to Kroger";
      authWindow.document.body.textContent = "Cartiva is preparing Kroger sign-in…";
    }
    try {
      setCart({ phase: "connecting", message: "Checking your Kroger connection…", retrySafe: true });
      let authResponse = await fetch("/api/kroger/auth/status", { cache: "no-store" });
      let auth = await authResponse.json().catch(() => ({})) as { connected?: boolean; configured?: boolean; error?: string };
      setKrogerConnection({
        connected: Boolean(auth.connected),
        configured: auth.configured !== false && authResponse.ok,
      });
      if (!authResponse.ok) {
        throw new Error(
          auth.configured === false
            ? "Kroger OAuth is not configured on this deployment."
            : auth.error ?? "Cartiva could not verify the saved Kroger connection.",
        );
      }

      if (!auth.connected) {
        const startResponse = await fetch("/api/kroger/oauth/start", { method: "POST" });
        if (!startResponse.ok) throw new Error(await responseError(startResponse, "Kroger sign-in could not start."));
        const start = await startResponse.json() as { authorizationUrl?: string };
        if (!start.authorizationUrl) throw new Error("Kroger did not return an authorization link.");
        if (!authWindow) throw new Error("Your browser blocked the Kroger sign-in window. Allow pop-ups for Cartiva, then try again.");
        authWindow.location.href = start.authorizationUrl;
        setCart({
          phase: "connecting",
          message: "Finish signing in with Kroger in the new window. Cartiva will continue automatically.",
          retrySafe: true,
        });

        let connected = false;
        for (let attempt = 0; attempt < 150; attempt += 1) {
          await wait(2_000);
          authResponse = await fetch("/api/kroger/auth/status", { cache: "no-store" });
          auth = await authResponse.json().catch(() => ({})) as { connected?: boolean };
          if (auth.connected) {
            connected = true;
            setKrogerConnection({ connected: true, configured: true });
            break;
          }
        }
        if (!connected) throw new Error("Kroger sign-in was not completed. Try the handoff again when you are ready.");
      } else {
        authWindow?.close();
      }

      authWindow?.close();
      const preserved = parsePendingKrogerCart(
        window.localStorage.getItem(KROGER_PENDING_CART_STORAGE_KEY),
      );
      if (!preserved || preserved.operationId !== pending.operationId) return;
      await completePendingCart(preserved);
    } catch (error) {
      authWindow?.close();
      setCart((current) => current.retrySafe === false || current.phase === "success"
        ? current
        : {
            phase: "error",
            retrySafe: true,
            message: error instanceof Error
              ? error.message
              : "We couldn't add the basket yet. Your Cartiva basket is still saved.",
          });
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
      if (cartTransferRef.current === pending.operationId) return;
      try {
        const response = await fetch("/api/kroger/auth/status", { cache: "no-store" });
        const status = await response.json().catch(() => ({})) as {
          connected?: boolean;
          configured?: boolean;
        };
        if (disposed || !response.ok) return;
        setKrogerConnection({
          connected: Boolean(status.connected),
          configured: status.configured !== false,
        });
        if (status.connected) {
          await completePendingCart(pending);
        } else {
          setCart((current) => current.phase === "adding" || current.retrySafe === false
            ? current
            : {
                phase: "connecting",
                code: "oauth_required",
                retrySafe: true,
                message: "Your exact Kroger basket is saved. Continue sign-in to finish the handoff.",
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
    const pending = parsePendingKrogerCart(
      window.localStorage.getItem(KROGER_PENDING_CART_STORAGE_KEY),
    );
    if (!itemsWereAdded) {
      window.localStorage.removeItem(KROGER_PENDING_CART_STORAGE_KEY);
      setCart(initialCart);
      return;
    }
    const message = "You confirmed these items are already in the retailer cart. Cartiva will not send them again.";
    if (pending) {
      window.localStorage.setItem(
        KROGER_PENDING_CART_STORAGE_KEY,
        JSON.stringify(blockPendingKrogerCart(pending, message)),
      );
    }
    setCart({ phase: "error", code: "outcome_unknown", retrySafe: false, message });
  };

  const newList = () => {
    if (rawInput.trim() && !window.confirm("Start a new list? This clears the groceries in this workspace.")) return;
    clearPendingKrogerCartBeforeBasketChange();
    setRawInput("");
    setProteinOrigins({});
    setQuantities({});
    setListName("Untitled list");
    setActiveListId(undefined);
    comparisonRunRef.current += 1;
    setLastComparisonRecord(null);
    setComparison(initialComparison);
    setCart(initialCart);
  };

  const changeStore = () => {
    document.getElementById("cartiva-zip")?.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
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
            <div className={styles.pageIntro}>
              <h2>Your list, compared as one cart</h2>
              <p>Real store totals appear only when every requested item has a trustworthy match.</p>
            </div>
            <div
              className={styles.summaryBar}
              aria-label={`${interpretation.items.length} items, ${interpretation.readyCount} ready, ${interpretation.unresolvedCount} ${interpretation.unresolvedCount === 1 ? "choice" : "choices"} needed, estimated savings unavailable`}
            >
              <span><strong>{interpretation.items.length}</strong> items</span>
              <span data-tone="ready"><strong>{interpretation.readyCount}</strong> ready</span>
              <span data-tone={interpretation.unresolvedCount ? "warning" : "ready"}>
                <strong>{interpretation.unresolvedCount}</strong> {interpretation.unresolvedCount === 1 ? "choice" : "choices"} needed
              </span>
              <span className={styles.summarySavings}><strong>Estimated savings</strong><small>—</small></span>
            </div>
            <div className={styles.workspaceGrid}>
              <CartivaGroceryList
                items={interpretation.items}
                quantities={quantities}
                locations={locations}
                selectedLocationId={selectedLocationId}
                fulfillmentMode={fulfillmentMode}
                comparisonPhase={comparison.phase}
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
                onChangeStore={changeStore}
                onRetry={runComparison}
                onSaveBasket={lastComparisonRecord?.complete ? () => saveBasket(lastComparisonRecord) : undefined}
                onAddToKroger={addToKroger}
                onResolveCartReview={resolveCartReview}
              />
            </div>
          </div>
          <CartivaUtilityRail />
        </div>
      </main>
    </CartivaShell>
  );
}
