import {
  AvailabilityStatus,
  BasketCompleteness,
  COMPARISON_SESSION_SCHEMA_VERSION,
  applyGroceryClarification,
  assertComparisonStoreInvariant,
  availabilityForComparison,
  comparisonCanReuseLocation,
  comparisonSearchItem,
  createComparisonHydrationGuard,
  interpretGroceryInput,
  isRetailerHandoffAcceptedMatch,
  krogerRetailerBanner,
  localCorrectionMetadata,
  parseRetailerPackageQuantity,
  summarizeBasket,
  type ComparisonBasketLine,
  type ComparisonSessionReceipt,
  type GroceryNotepadItem,
} from "@cartiva/shared";
import * as Crypto from "expo-crypto";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { analytics } from "@/services/analytics";
import {
  loadPersistedCartivaState,
  savePersistedCartivaState,
} from "@/state/comparison-persistence";
import {
  ComparisonRunSupersededError,
  createComparisonRunCoordinator,
} from "@/state/comparison-run";
import {
  CartivaApiError,
  findKrogerLocations,
  getCapabilities,
  krogerComparisonReceiptMatches,
  searchKroger,
  type CartivaCapabilities,
  type KrogerLocation,
  type KrogerMatchResult,
  type RankedKrogerProduct,
} from "@/services/cartiva-api";
import { decodePersistedComparisonSnapshot } from "@/state/comparison-snapshot-decoder";
import { applyKrogerAlternativeSelection } from "@/state/kroger-alternative-selection";

export interface BasketSummary {
  status: BasketCompleteness;
  requestedCount: number;
  matchedCount: number;
  totalCents?: number;
  matchedSubtotalCents: number;
}

export interface ComparisonSnapshot extends ComparisonSessionReceipt {
  requestedItems: GroceryNotepadItem[];
  results: KrogerMatchResult[];
  location: KrogerLocation;
  locationSelectionBasis: "KROGER_PROVIDER_ORDER" | "PINNED_REVALIDATION";
  fulfillmentMode: "pickup";
  summary: BasketSummary;
  capabilities: CartivaCapabilities;
  serverReceiptPersisted: boolean;
}

export type ComparisonProgress =
  | { type: "understood"; itemCount: number }
  | { type: "location-started" }
  | { type: "location-found"; location: KrogerLocation }
  | { type: "item-search"; index: number; item: string }
  | { type: "item-verified"; index: number; item: string; matched: boolean }
  | { type: "basket-checked"; matchedCount: number; requestedCount: number };

interface CartivaContextValue {
  hydrated: boolean;
  rawInput: string;
  zipCode: string;
  comparison: ComparisonSnapshot | null;
  setRawInput(value: string): void;
  setZipCode(value: string): void;
  resolveClarification(itemIndex: number, clarificationId: string, value: string): void;
  startComparison(onProgress: (progress: ComparisonProgress) => void): Promise<ComparisonSnapshot>;
  chooseAlternative(itemIndex: number, candidate: RankedKrogerProduct): void;
  rejectMatch(itemIndex: number): void;
  removeRequestedItem(itemIndex: number): void;
  cancelComparisonRun(): void;
  clearComparison(): void;
  persistComparisonForHandoff(comparisonId: string): Promise<void>;
}

const CartivaContext = createContext<CartivaContextValue | null>(null);

export function comparablePriceCents(product: RankedKrogerProduct) {
  const regular = product.priceProvenance.regularPriceCents;
  if (typeof regular === "number" && Number.isSafeInteger(regular) && regular > 0) return regular;
  if (typeof product.priceCents === "number" && Number.isSafeInteger(product.priceCents)) {
    return product.priceCents;
  }
  return Math.round(product.price * 100);
}

function fulfillmentQuantity(result: KrogerMatchResult | undefined, fallback: number) {
  return result?.fulfillment?.cartQuantity ?? fallback;
}

function resultCanBeAccepted(result: KrogerMatchResult | undefined, locationId: string) {
  const product = result?.status === "matched" ? result.recommended : null;
  return Boolean(
    product
    && isRetailerHandoffAcceptedMatch(result)
    && product.priceProvenance.locationId === locationId
    && product.priceProvenance.exactStoreVerified
    && product.priceProvenance.fulfillment.includes("pickup")
    && product.productId
    && product.upc,
  );
}

function summarize(
  results: KrogerMatchResult[],
  requestedItems: GroceryNotepadItem[],
  locationId: string,
): BasketSummary {
  const sharedSummary = summarizeBasket(requestedItems.map((item, index) => {
    const result = results[index];
    const validMatch = resultCanBeAccepted(result, locationId);
    const quantity = fulfillmentQuantity(
      result,
      parseRetailerPackageQuantity(item.raw).quantity,
    );
    return {
      validMatch,
      priceCents: validMatch && result.recommended
        ? comparablePriceCents(result.recommended) * quantity
        : undefined,
    };
  }));
  return {
    status: sharedSummary.completeness,
    requestedCount: sharedSummary.requestedCount,
    matchedCount: sharedSummary.validMatchCount,
    totalCents: sharedSummary.completeTotalCents,
    matchedSubtotalCents: sharedSummary.matchedSubtotalCents,
  };
}

function locationAddress(location: KrogerLocation) {
  return [
    location.address.addressLine1,
    location.address.city,
    `${location.address.state} ${location.address.zipCode}`.trim(),
  ].filter(Boolean).join(", ");
}

function basketLinesFor(
  comparisonId: string,
  requestedItems: GroceryNotepadItem[],
  results: KrogerMatchResult[],
  locationId: string,
): ComparisonBasketLine[] {
  return requestedItems.map((request, index) => {
    const quantityIntent = parseRetailerPackageQuantity(request.raw);
    const result = results[index];
    const product = result?.status === "matched" ? result.recommended : null;
    const accepted = resultCanBeAccepted(result, locationId);
    return {
      lineId: `${comparisonId}:${request.id}`,
      requestedItemId: request.id,
      requestedItem: request.raw,
      normalizedIntent: quantityIntent.searchText,
      quantity: fulfillmentQuantity(result, quantityIntent.quantity),
      packageSizeText: quantityIntent.packageSizeText,
      status: accepted ? "ACCEPTED" : product ? "REJECTED" : "UNMATCHED",
      ...(accepted && product ? {
        retailerProductId: product.productId,
        upc: product.upc,
        matchedProduct: product.title,
        matchedPackage: product.size?.label,
        priceCents: comparablePriceCents(product),
        provenance: {
          dataSource: product.dataSource,
          priceSource: "kroger_location_product" as const,
          priceScope: product.priceProvenance.priceScope,
          priceReliability: product.priceProvenance.priceReliability,
          exactStoreVerified: product.priceProvenance.exactStoreVerified,
          sourceLocationId: product.priceProvenance.locationId,
          fulfillment: product.priceProvenance.fulfillment
            .filter((mode): mode is "pickup" | "delivery" => mode === "pickup" || mode === "delivery"),
          checkedAt: product.priceProvenance.checkedAt ?? product.checkedAt,
        },
      } : {}),
      locationId,
      availabilityStatus: product
        ? availabilityForComparison(product.availabilityStatus)
        : AvailabilityStatus.UNKNOWN,
      matchConfidence: product ? product.confidence : "low",
    };
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function createComparisonSnapshot({
  comparisonId,
  requestedItems,
  results,
  location,
  zipCode,
  capabilities,
  checkedAt,
  createdAt = checkedAt,
  serverReceiptPersisted,
  locationSelectionBasis = "KROGER_PROVIDER_ORDER",
}: {
  comparisonId: string;
  requestedItems: GroceryNotepadItem[];
  results: KrogerMatchResult[];
  location: KrogerLocation;
  zipCode: string;
  capabilities: CartivaCapabilities;
  checkedAt: string;
  createdAt?: string;
  serverReceiptPersisted: boolean;
  locationSelectionBasis?: ComparisonSnapshot["locationSelectionBasis"];
}) {
  const summary = summarize(results, requestedItems, location.locationId);
  const basketLines = basketLinesFor(comparisonId, requestedItems, results, location.locationId);
  const receipt: ComparisonSessionReceipt = {
    schemaVersion: COMPARISON_SESSION_SCHEMA_VERSION,
    comparisonId,
    retailer: "kroger",
    retailerChain: location.chain,
    retailerBanner: krogerRetailerBanner(location.chain),
    locationId: location.locationId,
    locationName: location.name,
    locationAddress: locationAddress(location),
    zipCode,
    fulfillmentMode: "pickup",
    requestedItemIds: requestedItems.map((item) => item.id),
    basketLines,
    completeness: summary.status,
    checkedAt,
    createdAt,
  };
  assertComparisonStoreInvariant(receipt);
  return deepFreeze<ComparisonSnapshot>({
    ...receipt,
    fulfillmentMode: "pickup",
    requestedItems,
    results,
    location,
    locationSelectionBasis,
    summary,
    capabilities,
    serverReceiptPersisted,
  });
}

function restorableComparison(
  value: unknown,
  rawInput: string,
  zipCode: string,
): ComparisonSnapshot | null {
  const candidate = decodePersistedComparisonSnapshot(value, rawInput, zipCode);
  return candidate ? deepFreeze(candidate as unknown as ComparisonSnapshot) : null;
}

function unresolvedResult(item: GroceryNotepadItem): KrogerMatchResult {
  return {
    retailer: "kroger",
    requestedItem: item.raw,
    recommended: null,
    alternatives: [],
    confidence: "low",
    status: "no_match",
    explanation: "Kroger did not return a verified result for this item.",
  };
}

export function CartivaProvider({ children }: PropsWithChildren) {
  const [rawInputState, setRawInputState] = useState("");
  const [zipCodeState, setZipCodeState] = useState("");
  const [comparison, setComparison] = useState<ComparisonSnapshot | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const openedRef = useRef(false);
  const listStartedRef = useRef(false);
  const hydrationGuardRef = useRef<ReturnType<typeof createComparisonHydrationGuard> | null>(null);
  const runCoordinatorRef = useRef<ReturnType<typeof createComparisonRunCoordinator> | null>(null);
  hydrationGuardRef.current ??= createComparisonHydrationGuard();
  runCoordinatorRef.current ??= createComparisonRunCoordinator();

  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    analytics.track("app_open");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadPersistedCartivaState().then((persisted) => {
      if (cancelled) return;
      const accepted = hydrationGuardRef.current?.finish(persisted) ?? null;
      if (!accepted) return;
      const restored = restorableComparison(
        accepted.comparison,
        accepted.rawInput,
        accepted.zipCode,
      );
      setRawInputState(accepted.rawInput);
      setZipCodeState(accepted.zipCode);
      setComparison(restored);
    }).finally(() => {
      if (!cancelled) {
        setHydrated(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => {
      void savePersistedCartivaState({
        rawInput: rawInputState,
        zipCode: zipCodeState,
        comparison,
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [comparison, hydrated, rawInputState, zipCodeState]);

  const setRawInput = useCallback((value: string) => {
    runCoordinatorRef.current?.invalidate();
    hydrationGuardRef.current?.markEdited();
    setRawInputState(value);
    setComparison(null);
    if (!listStartedRef.current && value.trim()) {
      listStartedRef.current = true;
      analytics.track("list_started");
    }
  }, []);

  const setZipCode = useCallback((value: string) => {
    runCoordinatorRef.current?.invalidate();
    hydrationGuardRef.current?.markEdited();
    setZipCodeState(value.replace(/\D/g, "").slice(0, 5));
    setComparison(null);
  }, []);

  const resolveClarification = useCallback((
    itemIndex: number,
    clarificationId: string,
    value: string,
  ) => {
    const interpretation = interpretGroceryInput(rawInputState);
    const next = interpretation.items.map((item, index) => (
      index === itemIndex
        ? applyGroceryClarification(item.raw, clarificationId, value)
        : item.raw
    )).join("\n");
    setRawInput(next);
  }, [rawInputState, setRawInput]);

  const startComparison = useCallback(async (
    onProgress: (progress: ComparisonProgress) => void,
  ) => {
    const run = runCoordinatorRef.current!.start();
    const rawInputAtStart = rawInputState;
    const zipCodeAtStart = zipCodeState;
    const comparisonAtStart = comparison;
    const interpretation = interpretGroceryInput(rawInputAtStart);
    if (!interpretation.items.length) {
      throw new CartivaApiError("Add at least one grocery item before comparing.", "response", 400);
    }
    if (interpretation.limitReached) {
      throw new CartivaApiError("Cartiva supports up to 24 items per comparison.", "response", 400);
    }
    if (interpretation.unresolvedCount) {
      throw new CartivaApiError("One or more items still need a quick detail.", "response", 400);
    }
    if (!/^\d{5}$/.test(zipCodeAtStart)) {
      throw new CartivaApiError("Enter a valid 5-digit ZIP code.", "response", 400);
    }

    analytics.track("comparison_started", { item_count: interpretation.items.length });
    const comparisonId = Crypto.randomUUID();
    const pinnedComparison = comparisonAtStart && comparisonCanReuseLocation(
      comparisonAtStart,
      zipCodeAtStart,
      interpretation.items.map((item) => item.id),
    ) ? comparisonAtStart : null;
    run.ifCurrent(() => onProgress({ type: "understood", itemCount: interpretation.items.length }));
    run.ifCurrent(() => onProgress({ type: "location-started" }));

    try {
      const [capabilities, locations] = await Promise.all([
        getCapabilities(run.signal),
        pinnedComparison
          ? Promise.resolve({ retailer: "kroger" as const, zipCode: zipCodeAtStart, locations: [pinnedComparison.location] })
          : findKrogerLocations(zipCodeAtStart, run.signal),
      ]);
      run.assertCurrent();
      const location = locations.locations[0];
      if (!location) {
        throw new CartivaApiError(
          "We couldn't find a Kroger-family grocery store near this ZIP code.",
          "response",
          404,
        );
      }
      run.ifCurrent(() => onProgress({ type: "location-found", location }));
      const krogerCapability = capabilities.retailers.find((retailer) => retailer.id === "kroger");
      const shouldPersistServerReceipt = capabilities.access === "ANONYMOUS_WITH_TEMPORARY_SESSION"
        && krogerCapability?.handoff.mode === "CART_TRANSFER_SUPPORTED"
        && krogerCapability.handoff.cartTransferSupported;

      const resultMap = new Map<number, KrogerMatchResult>();
      let checkedAt = new Date().toISOString();
      const receiptConfirmation = await searchKroger({
        comparisonId,
        items: interpretation.items.map((item, index) => comparisonSearchItem(
          item,
          pinnedComparison?.results[index]?.recommended,
        )),
        locationId: location.locationId,
        zipCode: zipCodeAtStart,
        fulfillmentMode: "pickup",
      }, (event) => {
        if (!run.isCurrent()) return;
        checkedAt = event.checkedAt || checkedAt;
        if (event.type !== "item") return;
        resultMap.set(event.index, event.result);
        if (event.phase === "search") {
          run.ifCurrent(() => onProgress({
            type: "item-search",
            index: event.index,
            item: interpretation.items[event.index]?.name ?? event.result.requestedItem,
          }));
        } else {
          run.ifCurrent(() => onProgress({
            type: "item-verified",
            index: event.index,
            item: interpretation.items[event.index]?.name ?? event.result.requestedItem,
            matched: event.result.status === "matched" && Boolean(event.result.recommended),
          }));
        }
      }, {
        persistServerReceipt: Boolean(shouldPersistServerReceipt),
        signal: run.signal,
      });
      run.assertCurrent();

      const results = interpretation.items.map((item, index) => (
        resultMap.get(index) ?? unresolvedResult(item)
      ));
      const summary = summarize(results, interpretation.items, location.locationId);
      run.ifCurrent(() => onProgress({
        type: "basket-checked",
        matchedCount: summary.matchedCount,
        requestedCount: summary.requestedCount,
      }));
      const provisionalSnapshot = createComparisonSnapshot({
        comparisonId,
        requestedItems: interpretation.items,
        results,
        location,
        zipCode: zipCodeAtStart,
        capabilities,
        checkedAt,
        serverReceiptPersisted: false,
        locationSelectionBasis: pinnedComparison
          ? "PINNED_REVALIDATION"
          : "KROGER_PROVIDER_ORDER",
      });
      const receiptMatches = shouldPersistServerReceipt && receiptConfirmation
        ? await krogerComparisonReceiptMatches(receiptConfirmation, provisionalSnapshot)
        : false;
      run.assertCurrent();
      if (
        shouldPersistServerReceipt
        && !receiptMatches
      ) {
        throw new CartivaApiError(
          "Cartiva could not verify that this basket remained bound to the selected store.",
          "response",
          409,
        );
      }
      const snapshot = shouldPersistServerReceipt && receiptConfirmation?.persisted
        ? deepFreeze<ComparisonSnapshot>({
            ...provisionalSnapshot,
            serverReceiptPersisted: true,
          })
        : provisionalSnapshot;
      run.assertCurrent();
      const persisted = await savePersistedCartivaState({
        rawInput: rawInputAtStart,
        zipCode: zipCodeAtStart,
        comparison: snapshot,
      });
      run.assertCurrent();
      if (!persisted) {
        throw new CartivaApiError(
          "Cartiva found your basket but could not save it safely on this device. Free device storage and compare again before continuing to Kroger.",
          "response",
          503,
        );
      }
      run.ifCurrent(() => {
        setComparison(snapshot);
        analytics.track("comparison_completed", {
          item_count: summary.requestedCount,
          matched_count: summary.matchedCount,
          complete: summary.status === BasketCompleteness.COMPLETE,
        });
      });
      run.assertCurrent();
      return snapshot;
    } catch (error) {
      if (!run.isCurrent()) throw new ComparisonRunSupersededError();
      analytics.track("comparison_failed", {
        reason: error instanceof CartivaApiError ? error.code : "unexpected",
      });
      throw error;
    }
  }, [comparison, rawInputState, zipCodeState]);

  const updateResults = useCallback((
    transform: (results: KrogerMatchResult[]) => KrogerMatchResult[],
  ) => {
    setComparison((current) => {
      if (!current) return current;
      const results = transform(current.results);
      const correction = localCorrectionMetadata(current, Crypto.randomUUID());
      return createComparisonSnapshot({
        comparisonId: correction.comparisonId,
        requestedItems: current.requestedItems,
        results,
        location: current.location,
        zipCode: current.zipCode,
        capabilities: current.capabilities,
        checkedAt: correction.checkedAt,
        createdAt: correction.createdAt,
        // A client-side correction is never treated as a server-authoritative
        // cart receipt. Recompare before any automatic retailer cart write.
        serverReceiptPersisted: correction.serverReceiptPersisted,
        locationSelectionBasis: current.locationSelectionBasis,
      });
    });
  }, []);

  const chooseAlternative = useCallback((itemIndex: number, candidate: RankedKrogerProduct) => {
    if (
      !comparison
      || candidate.priceProvenance.locationId !== comparison.locationId
      || !candidate.priceProvenance.exactStoreVerified
      || !candidate.priceProvenance.fulfillment.includes(comparison.fulfillmentMode)
    ) return;
    updateResults((results) => results.map((result, index) => {
      if (index !== itemIndex) return result;
      return applyKrogerAlternativeSelection(result, candidate);
    }));
  }, [comparison, updateResults]);

  const rejectMatch = useCallback((itemIndex: number) => {
    updateResults((results) => results.map((result, index) => {
      if (index !== itemIndex) return result;
      const {
        fulfillment: _previousFulfillment,
        resolution: _previousResolution,
        ...resultWithoutPackageDecision
      } = result;
      return {
        ...resultWithoutPackageDecision,
        alternatives: result.recommended
          ? [result.recommended, ...result.alternatives]
          : result.alternatives,
        recommended: null,
        confidence: "low",
        status: "no_match",
        resolution: "truly_unavailable",
        explanation: "You rejected Cartiva's selected match. Choose another candidate or edit the request.",
      };
    }));
  }, [updateResults]);

  const removeRequestedItem = useCallback((itemIndex: number) => {
    const sourceItems = comparison?.requestedItems ?? interpretGroceryInput(rawInputState).items;
    setRawInput(sourceItems.filter((_, index) => index !== itemIndex).map((item) => item.raw).join("\n"));
  }, [comparison, rawInputState, setRawInput]);

  const cancelComparisonRun = useCallback(() => {
    runCoordinatorRef.current?.invalidate();
  }, []);

  const clearComparison = useCallback(() => {
    runCoordinatorRef.current?.invalidate();
    setComparison(null);
  }, []);

  const persistComparisonForHandoff = useCallback(async (comparisonId: string) => {
    if (!comparison || comparison.comparisonId !== comparisonId) {
      throw new Error("This Cartiva comparison changed. Compare again before continuing to Kroger.");
    }
    const persisted = await savePersistedCartivaState({
      rawInput: rawInputState,
      zipCode: zipCodeState,
      comparison,
    });
    if (!persisted) {
      throw new Error(
        "Cartiva could not save this basket safely on the device. Nothing was sent to Kroger; free device storage and try again.",
      );
    }
  }, [comparison, rawInputState, zipCodeState]);

  const value = useMemo<CartivaContextValue>(() => ({
    hydrated,
    rawInput: rawInputState,
    zipCode: zipCodeState,
    comparison,
    setRawInput,
    setZipCode,
    resolveClarification,
    startComparison,
    chooseAlternative,
    rejectMatch,
    removeRequestedItem,
    cancelComparisonRun,
    clearComparison,
    persistComparisonForHandoff,
  }), [
    hydrated,
    rawInputState,
    zipCodeState,
    comparison,
    setRawInput,
    setZipCode,
    resolveClarification,
    startComparison,
    chooseAlternative,
    rejectMatch,
    removeRequestedItem,
    cancelComparisonRun,
    clearComparison,
    persistComparisonForHandoff,
  ]);

  return <CartivaContext.Provider value={value}>{children}</CartivaContext.Provider>;
}

export function useCartiva() {
  const value = useContext(CartivaContext);
  if (!value) throw new Error("useCartiva must be used inside CartivaProvider.");
  return value;
}
