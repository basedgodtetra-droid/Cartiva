"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  CARTIVA_LIBRARY_KEY,
  createLibraryId,
  deleteSavedBasket,
  deleteSavedList,
  deleteSavedPlan,
  duplicateSavedList,
  emptyCartivaLibrary,
  parseCartivaLibrary,
  recordCartAdded as appendCartActivity,
  recordComparison as appendComparison,
  renameSavedList,
  saveHistoricalBasket as appendHistoricalBasket,
  serializeCartivaLibrary,
  upsertSavedPlan,
  upsertSavedList,
  type CartivaComparisonRecord,
  type CartivaLibraryState,
  type CartivaListSnapshot,
} from "@/lib/cartiva-library";
import type { MealPlan } from "@/lib/cartiva-planning";
import { trackCartivaEvent } from "@/lib/cartiva-product-events";

interface CartivaLibraryContextValue {
  state: CartivaLibraryState;
  hydrated: boolean;
  persisted: boolean;
  retrySaving: () => void;
  saveList: (input: {
    id?: string;
    name: string;
    snapshot: CartivaListSnapshot;
    itemCount: number;
  }) => string;
  renameList: (id: string, name: string) => void;
  duplicateList: (id: string) => string | undefined;
  deleteList: (id: string) => void;
  savePlan: (input: {
    id?: string;
    name: string;
    plan: MealPlan;
    ownedIngredientIds: string[];
  }) => string;
  deletePlan: (id: string) => void;
  recordComparison: (comparison: CartivaComparisonRecord) => void;
  saveBasket: (comparison: CartivaComparisonRecord) => void;
  deleteBasket: (id: string) => void;
  recordCartAdded: (input: { comparisonId: string; itemCount: number; retailerLabel: string }) => void;
}

const CartivaLibraryContext = createContext<CartivaLibraryContextValue | null>(null);

export function CartivaLibraryProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CartivaLibraryState>(emptyCartivaLibrary);
  const [hydrated, setHydrated] = useState(false);
  const [lastPersisted, setLastPersisted] = useState<string | null>(null);
  const [persistenceFailed, setPersistenceFailed] = useState(false);
  const [saveAttempt, setSaveAttempt] = useState(0);
  const serialized = useMemo(() => serializeCartivaLibrary(state), [state]);
  const persisted = hydrated && lastPersisted === serialized && !persistenceFailed;
  const retrySaving = useCallback(() => setSaveAttempt((value) => value + 1), []);

  useEffect(() => {
    const load = () => {
      try {
        setState(parseCartivaLibrary(window.localStorage.getItem(CARTIVA_LIBRARY_KEY)));
      } catch {
        setState(emptyCartivaLibrary());
      }
    };
    const hydrationTimer = window.setTimeout(() => {
      load();
      setHydrated(true);
    }, 0);
    const onStorage = (event: StorageEvent) => {
      if (event.key === CARTIVA_LIBRARY_KEY) load();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(hydrationTimer);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
    try {
      window.localStorage.setItem(CARTIVA_LIBRARY_KEY, serialized);
      setLastPersisted(serialized);
      setPersistenceFailed(false);
    } catch {
      setPersistenceFailed(true);
    }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [hydrated, serialized, saveAttempt]);

  const saveList = useCallback((input: {
    id?: string;
    name: string;
    snapshot: CartivaListSnapshot;
    itemCount: number;
  }) => {
    const id = input.id ?? createLibraryId("list");
    const now = new Date().toISOString();
    setState((current) => upsertSavedList(current, { ...input, id, now }));
    trackCartivaEvent("list_saved", { itemCount: input.itemCount });
    return id;
  }, []);

  const renameList = useCallback((id: string, name: string) => {
    const now = new Date().toISOString();
    setState((current) => renameSavedList(current, id, name, now));
  }, []);

  const savePlan = useCallback((input: {
    id?: string;
    name: string;
    plan: MealPlan;
    ownedIngredientIds: string[];
  }) => {
    const id = input.id ?? createLibraryId("plan");
    const now = new Date().toISOString();
    setState((current) => upsertSavedPlan(current, { ...input, id, now }));
    return id;
  }, []);

  const duplicateList = useCallback((id: string) => {
    if (!state.lists.some((list) => list.id === id)) return undefined;
    const duplicateId = createLibraryId("list");
    const now = new Date().toISOString();
    setState((current) => duplicateSavedList(current, id, duplicateId, now));
    return duplicateId;
  }, [state.lists]);

  const value = useMemo<CartivaLibraryContextValue>(() => ({
    state,
    hydrated,
    persisted,
    retrySaving,
    saveList,
    renameList,
    duplicateList,
    deleteList: (id) => setState((current) => deleteSavedList(current, id)),
    savePlan,
    deletePlan: (id) => setState((current) => deleteSavedPlan(current, id)),
    recordComparison: (comparison) => setState((current) => appendComparison(current, comparison)),
    saveBasket: (comparison) => {
      const savedAt = new Date().toISOString();
      setState((current) => appendHistoricalBasket(current, comparison, savedAt));
      trackCartivaEvent("basket_saved", {
        retailer: comparison.retailer,
        fulfillmentMode: comparison.fulfillmentMode,
        itemCount: comparison.itemCount,
        matchedCount: comparison.matchedCount,
        complete: comparison.complete,
      });
    },
    deleteBasket: (id) => setState((current) => deleteSavedBasket(current, id)),
    recordCartAdded: (input) => {
      const occurredAt = new Date().toISOString();
      setState((current) => appendCartActivity(current, { ...input, occurredAt }));
    },
  }), [duplicateList, hydrated, persisted, retrySaving, renameList, saveList, savePlan, state]);

  return <CartivaLibraryContext.Provider value={value}>
    {persistenceFailed && <div role="alert" style={{ padding: 16, background: "#FFF7E8", color: "#17221D" }}>
      Changes are only in this open tab. Your browser could not save them. Keep this tab open to avoid losing work.
      {" "}<button type="button" onClick={retrySaving}>Retry saving</button>
    </div>}
    {children}
  </CartivaLibraryContext.Provider>;
}

export function useCartivaLibrary() {
  const value = useContext(CartivaLibraryContext);
  if (!value) throw new Error("useCartivaLibrary must be used inside CartivaLibraryProvider.");
  return value;
}
