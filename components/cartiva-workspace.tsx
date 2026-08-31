"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyGroceryClarification,
  interpretGroceryInput,
  type GroceryNotepadItem,
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

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
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
  const comparisonRunRef = useRef(0);
  const loadedRequestRef = useRef("");

  const interpretation = useMemo(() => interpretGroceryInput(rawInput), [rawInput]);
  const selectedLocation = locations.find((location) => location.locationId === selectedLocationId);
  const currentSnapshot: CartivaListSnapshot = {
    rawInput,
    quantities,
    fulfillmentMode,
    zipCode: zipInput,
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
    } satisfies StoredWorkspace));
  }, [activeListId, fulfillmentMode, hydrated, listName, quantities, rawInput, zipInput]);

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
    setRawInput(snapshot.rawInput);
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

  const invalidateComparison = () => {
    comparisonRunRef.current += 1;
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
    updateRawInput(replaceItem(interpretation.items, index, value));
  };

  const removeItem = (index: number) => {
    updateRawInput(replaceItem(interpretation.items, index, null));
  };

  const clarifyItem = (index: number, clarificationId: string, value: string) => {
    const item = interpretation.items[index];
    if (!item) return;
    const clarified = applyGroceryClarification(item.raw, clarificationId, value);
    updateRawInput(replaceItem(interpretation.items, index, clarified));
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
    const currentInterpretation = interpretGroceryInput(rawInput);
    const runQuantities = Object.fromEntries(
      currentInterpretation.items.map((item) => [item.id, quantities[item.id] ?? 1]),
    );
    const runListSnapshot: CartivaListSnapshot = {
      rawInput,
      quantities: runQuantities,
      fulfillmentMode,
      zipCode: zipInput,
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

  const cartPayloadItems = (results: KrogerMatchResult[]) => {
    const aggregated = new Map<string, number>();
    results.forEach((result, index) => {
      const upc = result.status === "matched" && result.recommended?.cartEligible
        ? result.recommended.upc
        : undefined;
      if (!upc) return;
      aggregated.set(upc, (aggregated.get(upc) ?? 0) + (quantities[interpretation.items[index]?.id] ?? 1));
    });
    return [...aggregated].map(([upc, quantity]) => ({ upc, quantity }));
  };

  const postCart = async (results: KrogerMatchResult[], locationId: string, operationId: string) => {
    const items = cartPayloadItems(results);
    if (!items.length || results.some((result) => result.status !== "matched" || !result.recommended?.cartEligible)) {
      throw new Error("Every grocery must have a verified, cart-eligible Kroger match before handoff.");
    }
    return fetch("/api/kroger/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId, locationId, fulfillmentMode, items }),
    });
  };

  const addToKroger = async () => {
    if (!selectedLocation || comparison.phase !== "complete") return;
    const authWindow = window.open("about:blank", "cartiva-kroger-oauth", "popup,width=560,height=760");
    if (authWindow) {
      authWindow.document.title = "Connecting to Kroger";
      authWindow.document.body.textContent = "Cartiva is preparing Kroger sign-in…";
    }
    try {
      setCart({ phase: "connecting", message: "Checking your Kroger connection…" });
      let authResponse = await fetch("/api/kroger/auth/status", { cache: "no-store" });
      let auth = await authResponse.json().catch(() => ({})) as { connected?: boolean; configured?: boolean; error?: string };
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
        setCart({ phase: "connecting", message: "Finish signing in with Kroger in the new window. Cartiva will continue automatically." });

        let connected = false;
        for (let attempt = 0; attempt < 150; attempt += 1) {
          await wait(2_000);
          authResponse = await fetch("/api/kroger/auth/status", { cache: "no-store" });
          auth = await authResponse.json().catch(() => ({})) as { connected?: boolean };
          if (auth.connected) {
            connected = true;
            break;
          }
        }
        if (!connected) throw new Error("Kroger sign-in was not completed. Try the handoff again when you are ready.");
      } else {
        authWindow?.close();
      }

      authWindow?.close();
      setCart({ phase: "adding", message: "Adding the exact verified UPCs to Kroger…" });
      const operationId = `cartiva_${crypto.randomUUID().replace(/-/g, "")}`;
      let activeResults = comparison.results.filter((result): result is KrogerMatchResult => Boolean(result));
      let activeLocation = selectedLocation;
      let activityRecord = lastComparisonRecord;
      let cartResponse = await postCart(activeResults, activeLocation.locationId, operationId);

      if (cartResponse.status === 409) {
        const refreshed = await runComparison();
        if (!refreshed) throw new Error("Cartiva could not refresh the Kroger matches before handoff.");
        activeResults = refreshed.results;
        activeLocation = refreshed.location;
        activityRecord = refreshed.comparisonRecord;
        setCart({ phase: "adding", message: "Matches refreshed. Adding the verified items to Kroger…" });
        cartResponse = await postCart(activeResults, activeLocation.locationId, operationId);
      }
      if (!cartResponse.ok) throw new Error(await responseError(cartResponse, "Kroger cart could not be updated."));
      const receipt = await cartResponse.json() as { cartUrl?: string; addedCount?: number; message?: string };
      setCart({
        phase: "success",
        cartUrl: receipt.cartUrl,
        message: receipt.message ?? `${receipt.addedCount ?? interpretation.items.length} items were accepted by Kroger.`,
      });
      if (activityRecord) {
        recordCartAdded({
          comparisonId: activityRecord.id,
          itemCount: activityRecord.itemCount,
          retailerLabel: activityRecord.retailerLabel,
        });
      }
      if (receipt.cartUrl) window.open(receipt.cartUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      authWindow?.close();
      setCart({ phase: "error", message: error instanceof Error ? error.message : "Kroger cart handoff failed." });
    }
  };

  const newList = () => {
    if (rawInput.trim() && !window.confirm("Start a new list? This clears the groceries in this workspace.")) return;
    setRawInput("");
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
                basketSaved={Boolean(lastComparisonRecord && library.baskets.some((basket) => basket.id === lastComparisonRecord.id))}
                onChangeStore={changeStore}
                onRetry={runComparison}
                onSaveBasket={lastComparisonRecord?.complete ? () => saveBasket(lastComparisonRecord) : undefined}
                onAddToKroger={addToKroger}
              />
            </div>
          </div>
          <CartivaUtilityRail />
        </div>
      </main>
    </CartivaShell>
  );
}
