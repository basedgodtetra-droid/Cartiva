import { siteConfig } from "@/config/site";
import {
  enforceRateLimit,
  hasOnlyKeys,
  hasValidSearchItemShape,
  isRecord,
  readValidatedJson,
} from "@/lib/api-security";
import { normalizeShoppingItem } from "@/lib/list-parser";
import { auditProductCandidates, rankProducts } from "@/lib/matching";
import { extractMeasurement, extractPackOnlyCount } from "@/lib/measurements";
import {
  analyzeProductFacets,
  buildFacetSearchQuery,
  sanitizeFacetOptionIds,
} from "@/lib/product-facets";
import type { ProductConstraint } from "@/lib/product-facets";
import {
  explainDiscoveryFailure,
  isPlausibleDiscoveryCandidate,
  logDiscoveryDecision,
  parseProductIntent,
  retrieveCandidatesProgressively,
} from "@/lib/product-search-intent";
import type { ProductIntent } from "@/lib/product-search-intent";
import {
  getWalmartProductDetails,
  hasLiveWalmartProvider,
  searchWalmart,
  WalmartSearchError,
} from "@/lib/walmart-provider";
import type {
  MatchResult,
  SearchItemStreamEvent,
  SearchPerformanceDiagnostics,
  SearchPerformanceStreamEvent,
  WalmartCandidateDiagnostic,
  WalmartProduct,
} from "@/lib/types";
import { verifySelectedProduct } from "@/lib/verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SearchBody {
  retailer?: unknown;
  items?: unknown;
  storeId?: unknown;
  zipCode?: unknown;
  state?: unknown;
  fulfillmentMode?: unknown;
}

interface SearchStage {
  index: number;
  item: string;
  matchingRequest: string;
  constraints: ProductConstraint[];
  normalizedItem: string;
  mode: "live" | "demo";
  preliminary: MatchResult;
  searchResultCount: number;
  candidateDiagnostics?: WalmartCandidateDiagnostic[];
}

interface NormalizedRequestItem {
  index: number;
  item: string;
  matchingRequest: string;
  constraints: ProductConstraint[];
  normalizedItem: string;
  intent: ProductIntent;
  preferredProductId?: string;
  preferredItemId?: string;
  preferredTitle?: string;
}

function exactPackageMatch(request: string, product: WalmartProduct) {
  const requestedMeasurement = extractMeasurement(request);
  const requestedPackOnly = extractPackOnlyCount(request);
  if (!requestedMeasurement && requestedPackOnly === undefined) return true;
  if (!product.size) return false;

  if (requestedPackOnly !== undefined) {
    const productPack = product.size.packCount
      ?? (product.size.kind === "count" ? product.size.baseAmount : undefined);
    return productPack === requestedPackOnly;
  }

  if (!requestedMeasurement || requestedMeasurement.kind !== product.size.kind) return false;
  if (
    requestedMeasurement.packCount !== undefined
    && requestedMeasurement.packCount !== product.size.packCount
  ) return false;
  if (
    requestedMeasurement.perPackageAmount !== undefined
    && (
      product.size.perPackageAmount === undefined
      || Math.abs(
        requestedMeasurement.perPackageAmount - product.size.perPackageAmount,
      ) / Math.max(requestedMeasurement.perPackageAmount, 0.0001) > 0.02
    )
  ) return false;
  return Math.abs(requestedMeasurement.baseAmount - product.size.baseAmount)
    / Math.max(requestedMeasurement.baseAmount, 0.0001) <= 0.02;
}

function strictWalmartCandidates(request: string, products: WalmartProduct[]) {
  return products.filter((product) => exactPackageMatch(request, product));
}

function trustedStringField(entry: unknown, field: string, pattern: RegExp, maximum: number) {
  if (!entry || typeof entry !== "object" || !(field in entry)) return undefined;
  const value = (entry as Record<string, unknown>)[field];
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum && pattern.test(normalized) ? normalized : undefined;
}

function normalizeRequestItems(value: unknown): NormalizedRequestItem[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return null;

  const normalized: NormalizedRequestItem[] = [];
  for (const [index, entry] of value.entries()) {
    if (!hasValidSearchItemShape(
      entry,
      ["preferredProductId", "preferredItemId", "preferredTitle"],
    )) return null;
    const record = isRecord(entry) ? entry : undefined;
    const item = typeof entry === "string"
      ? entry.normalize("NFKC").replace(/\s+/g, " ").trim()
      : record && typeof record.text === "string"
        ? record.text.normalize("NFKC").replace(/\s+/g, " ").trim()
        : "";
    if (!item) return null;

    const preferredProductId = trustedStringField(
      entry,
      "preferredProductId",
      /^[a-z0-9-]{1,64}$/i,
      64,
    );
    const preferredItemId = trustedStringField(entry, "preferredItemId", /^\d{1,24}$/, 24);
    const preferredTitle = trustedStringField(entry, "preferredTitle", /^.{1,300}$/, 300);
    if (
      record && (
        ("preferredProductId" in record && !preferredProductId)
        || ("preferredItemId" in record && !preferredItemId)
        || ("preferredTitle" in record && !preferredTitle)
      )
    ) return null;

    const optionIds = record && "facetOptionIds" in record
      ? sanitizeFacetOptionIds(record.facetOptionIds)
      : [];
    const facets = analyzeProductFacets(item, optionIds);
    const matchingRequest = buildFacetSearchQuery(item, facets.constraints);
    const intent = parseProductIntent(matchingRequest, facets);
    normalized.push({
      index,
      item,
      matchingRequest,
      constraints: facets.constraints,
      // Discovery is intentionally package-light. matchingRequest remains
      // unchanged and is the strict source of truth during candidate ranking.
      normalizedItem: normalizeShoppingItem(
        intent.discoveryQueries[0]?.query ?? matchingRequest,
      ),
      intent,
      preferredProductId,
      preferredItemId,
      preferredTitle,
    });
  }
  return normalized;
}

function errorResult(item: string, error: unknown): MatchResult {
  return {
    requestedItem: item,
    recommended: null,
    alternatives: [],
    confidence: "low",
    status: "review",
    explanation: "Walmart could not check this item after one retry.",
    error: error instanceof Error ? error.message : "Walmart API error.",
  };
}

function diagnosticsFor(
  result: MatchResult,
  searchResultCount: number,
  candidates?: WalmartCandidateDiagnostic[],
) {
  const selectedProductId = result.recommended?.productId
    ?? result.recommended?.itemId
    ?? result.recommended?.id;
  const verificationStatus = result.status === "matched"
    ? result.assumptions?.length
      ? "best_reasonable_match" as const
      : "verified" as const
    : result.status === "review"
      ? "needs_review" as const
      : "no_verified_match" as const;

  return {
    searchResultCount,
    selectedProductId,
    verificationStatus,
    rejectionReason: result.status === "matched" ? undefined : result.explanation,
    candidates,
  };
}

function isTemporaryError(error: unknown) {
  return error instanceof WalmartSearchError
    && ["timeout", "rate_limit", "api_error"].includes(error.code);
}

async function withOneTemporaryRetry<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (!isTemporaryError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return operation();
  }
}

async function allSettledWithConcurrency<T>(
  values: T[],
  limit: number,
  task: (value: T) => Promise<void>,
) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const value = values[cursor++];
      await task(value);
    }
  };
  return Promise.allSettled(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
}

/**
 * Start queued work as soon as an independent slot is available. Unlike a
 * second batch pass, this lets product verification overlap with searches
 * that are still in flight while retaining a strict concurrency ceiling.
 */
export function createConcurrencyLimiter(limit: number) {
  const concurrency = Math.max(1, Math.floor(limit));
  const queue: Array<() => void> = [];
  let active = 0;

  const drain = () => {
    while (active < concurrency && queue.length) {
      queue.shift()?.();
    }
  };

  return function schedule<T>(task: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active += 1;
        void Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            drain();
          });
      });
      drain();
    });
  };
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "walmart-search", { limit: 45, windowMs: 60_000 });
  if (limited) return limited;
  const parsed = await readValidatedJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.value) || !hasOnlyKeys(
    parsed.value,
    ["retailer", "items", "storeId", "zipCode", "state", "fulfillmentMode"],
  )) {
    return Response.json({ error: "The Walmart search request contains unsupported fields." }, { status: 400 });
  }
  const body = parsed.value as SearchBody;
  if (body.retailer !== undefined && body.retailer !== "walmart") {
    return Response.json({ error: "Use this route only for Walmart searches." }, { status: 400 });
  }

  const normalizedItems = normalizeRequestItems(body.items);
  const requestedStoreId = typeof body.storeId === "string" ? body.storeId.trim() : "";
  const requestedZipCode = typeof body.zipCode === "string" ? body.zipCode.trim() : "";
  const requestedState = typeof body.state === "string" ? body.state.trim().toUpperCase() : "";
  if (requestedStoreId && !/^\d{1,8}$/.test(requestedStoreId)) {
    return Response.json({ error: "Choose a valid Walmart pickup store." }, { status: 400 });
  }
  if (requestedZipCode && !/^\d{5}$/.test(requestedZipCode)) {
    return Response.json({ error: "Enter a valid 5-digit ZIP code." }, { status: 400 });
  }
  if (requestedState && !/^[A-Z]{2}$/.test(requestedState)) {
    return Response.json({ error: "Choose a valid U.S. state." }, { status: 400 });
  }
  if (requestedZipCode && !requestedStoreId) {
    return Response.json(
      { error: "Choose a Walmart pickup store for this ZIP before searching." },
      { status: 400 },
    );
  }
  const storeId = requestedStoreId || process.env.WALMART_STORE_ID?.trim() || "";
  const fulfillmentMode = body.fulfillmentMode === "delivery"
    || body.fulfillmentMode === "shipping"
    || body.fulfillmentMode === "pickup"
    ? body.fulfillmentMode
    : body.fulfillmentMode === undefined ? "pickup" : null;

  if (!normalizedItems) {
    return Response.json(
      { error: "Add 1 to 50 valid shopping-list items, each no longer than 300 characters." },
      { status: 400 },
    );
  }
  if (!fulfillmentMode) {
    return Response.json(
      { error: "Walmart fulfillment must be pickup, delivery, or shipping." },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const requestStartedAt = performance.now();

  const stream = new ReadableStream({
    async start(controller) {
      const searchStages: Array<SearchStage | undefined> = Array(normalizedItems.length);
      const timings: SearchPerformanceDiagnostics["items"] = normalizedItems.map(({ index, item }) => ({
        index,
        item,
        searchDurationMs: 0,
        verificationDurationMs: 0,
        totalDurationMs: 0,
      }));
      let cacheHits = 0;
      let searchApiCalls = 0;
      let productApiCalls = 0;
      let deduplicatedRequests = 0;
      let sawDemo = !hasLiveWalmartProvider();
      const upstreamCacheSignals: Array<boolean | null> = [];
      const verificationTasks: Promise<void>[] = [];
      const scheduleVerification = createConcurrencyLimiter(
        siteConfig.verificationConcurrency,
      );

      const enqueueItem = (
        stage: SearchStage,
        result: MatchResult,
        phase: SearchItemStreamEvent["phase"],
      ) => {
        const event: SearchItemStreamEvent = {
          type: "item",
          phase,
          index: stage.index,
          mode: stage.mode,
          checkedAt: new Date().toISOString(),
          result,
          diagnostics: diagnosticsFor(
            result,
            stage.searchResultCount,
            stage.candidateDiagnostics,
          ),
        };
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      const verifyStage = async (stage: SearchStage) => {
        const startedAt = performance.now();
        const candidates = [
          stage.preliminary.recommended,
          ...stage.preliminary.alternatives,
        ].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
          .slice(0, 3);
        let finalResult: MatchResult | undefined;
        const fetchDetail = async (productIdentifier: string) => {
          let attempts = 0;
          try {
            const detailResponse = await withOneTemporaryRetry(() => {
              attempts += 1;
              return getWalmartProductDetails(
                productIdentifier,
                storeId,
                request.signal,
                {
                  fulfillmentMode,
                  zipCode: requestedZipCode,
                  state: requestedState,
                },
              );
            });
            productApiCalls += (attempts - 1) + (detailResponse.diagnostics.apiCall ? 1 : 0);
            cacheHits += detailResponse.diagnostics.cacheHit ? 1 : 0;
            deduplicatedRequests += detailResponse.diagnostics.deduplicated ? 1 : 0;
            if (detailResponse.diagnostics.apiCall) {
              upstreamCacheSignals.push(detailResponse.diagnostics.serpApiCacheUsed);
            }
            return {
              product: detailResponse.product,
              definitiveNotFound: detailResponse.product === null,
            };
          } catch {
            productApiCalls += attempts;
            // A timeout/rate-limit must not trigger another identifier and
            // another full retry budget. Verification will finish as review.
            return { product: null, definitiveNotFound: false };
          }
        };

        for (const candidate of candidates) {
          let detail = null;
          // Walmart's numeric item ID is the most reliable Product API lookup
          // key. Keep product_id as a bounded identity fallback.
          const primaryIdentifier = candidate.itemId ?? candidate.productId ?? candidate.id;
          const primaryDetail = await fetchDetail(primaryIdentifier);
          detail = primaryDetail.product;
          if (
            primaryDetail.definitiveNotFound
            && candidate.productId
            && candidate.productId !== primaryIdentifier
          ) {
            detail = (await fetchDetail(candidate.productId)).product;
          }

          const candidatePreliminary: MatchResult = {
            ...stage.preliminary,
            recommended: candidate,
            alternatives: candidates.filter((item) => item.id !== candidate.id),
          };
          const verified = verifySelectedProduct(
            stage.matchingRequest,
            candidatePreliminary,
            detail,
            undefined,
            stage.constraints,
            fulfillmentMode,
          );
          finalResult ??= verified;
          if (verified.status === "matched" && verified.recommended) {
            finalResult = verified;
            break;
          }
        }

        const verified = finalResult ?? stage.preliminary;
        timings[stage.index].verificationDurationMs = Math.round(performance.now() - startedAt);
        timings[stage.index].totalDurationMs =
          timings[stage.index].searchDurationMs + timings[stage.index].verificationDurationMs;
        enqueueItem(stage, verified, "verification");
      };

      await allSettledWithConcurrency(
        normalizedItems,
        siteConfig.searchConcurrency,
        async ({
          index,
          item,
          matchingRequest,
          constraints,
          normalizedItem,
          intent,
          preferredProductId,
          preferredItemId,
          preferredTitle,
        }) => {
          const startedAt = performance.now();
          try {
            let mode: "live" | "demo" = hasLiveWalmartProvider() ? "live" : "demo";
            const discovery = await retrieveCandidatesProgressively<WalmartProduct>({
              intent,
              maxSearches: 3,
              maxCandidates: 60,
              candidateKey: (candidate) => candidate.productId
                ?? candidate.itemId
                ?? candidate.id,
              isPlausible: (candidate) => isPlausibleDiscoveryCandidate(intent, candidate),
              hasVerifiedMatch: (candidates) => Boolean(rankProducts(
                matchingRequest,
                strictWalmartCandidates(matchingRequest, candidates),
                constraints,
                {
                  productId: preferredProductId,
                  itemId: preferredItemId,
                  title: preferredTitle,
                },
              ).recommended),
              search: async (query) => {
                let queryAttempts = 0;
                try {
                  const search = await withOneTemporaryRetry(() => {
                    queryAttempts += 1;
                    return searchWalmart(normalizeShoppingItem(query), storeId, request.signal, {
                      fulfillmentMode,
                      zipCode: requestedZipCode,
                      state: requestedState,
                    });
                  });
                  searchApiCalls += (queryAttempts - 1) + (search.diagnostics.apiCall ? 1 : 0);
                  cacheHits += search.diagnostics.cacheHit ? 1 : 0;
                  deduplicatedRequests += search.diagnostics.deduplicated ? 1 : 0;
                  if (search.diagnostics.apiCall) {
                    upstreamCacheSignals.push(search.diagnostics.serpApiCacheUsed);
                  }
                  mode = search.mode;
                  sawDemo = sawDemo || search.mode === "demo";
                  return search.products;
                } catch (error) {
                  searchApiCalls += queryAttempts;
                  throw error;
                }
              },
            });

            const eligibleProducts = strictWalmartCandidates(
              matchingRequest,
              discovery.candidates,
            );
            const ranked = rankProducts(matchingRequest, eligibleProducts, constraints, {
              productId: preferredProductId,
              itemId: preferredItemId,
              title: preferredTitle,
            });
            const preliminary = {
              ...ranked,
              requestedItem: item,
              explanation: ranked.recommended
                ? ranked.explanation
                : explainDiscoveryFailure({
                    retailerLabel: "Walmart",
                    intent,
                    candidates: discovery.candidates,
                    exactPackage: (product) => exactPackageMatch(matchingRequest, product),
                    commerceEligible: (product) => (
                      product.inStock
                      && Number.isFinite(product.price)
                      && product.price > 0
                      && product.priceProvenance?.localPriceEligible !== false
                    ),
                  }),
            };
            const candidateDiagnostics = process.env.NODE_ENV === "development"
              ? auditProductCandidates(matchingRequest, discovery.candidates, constraints)
              : undefined;
            if (process.env.NODE_ENV === "development") {
              logDiscoveryDecision({
                intent,
                attempts: discovery.attempts,
                candidates: discovery.candidates.map((candidate) => ({
                  id: candidate.productId ?? candidate.itemId ?? candidate.id,
                  title: candidate.title,
                })),
                candidateOutcomes: candidateDiagnostics?.map((candidate, candidateIndex) => ({
                  id: candidate.productId ?? candidate.itemId ?? `candidate-${candidateIndex}`,
                  title: candidate.title,
                  verified: !candidate.rejectionReason,
                  reasons: candidate.rejectionReason ? [candidate.rejectionReason] : [],
                })),
                selectedId: preliminary.recommended?.productId
                  ?? preliminary.recommended?.itemId
                  ?? preliminary.recommended?.id,
                rejectionReason: preliminary.recommended ? undefined : preliminary.explanation,
              });
            }
            const stage: SearchStage = {
              index,
              item,
              matchingRequest,
              constraints,
              normalizedItem,
              mode,
              preliminary,
              searchResultCount: discovery.candidates.length,
              candidateDiagnostics,
            };
            searchStages[index] = stage;
            timings[index].searchDurationMs = Math.round(performance.now() - startedAt);
            if (!preliminary.recommended) {
              timings[index].totalDurationMs = timings[index].searchDurationMs;
            }
            enqueueItem(stage, preliminary, "search");
            if (preliminary.recommended) {
              // Enqueue only after the search event so each item always keeps
              // search-before-verification ordering, even for cache hits.
              verificationTasks.push(
                scheduleVerification(() => verifyStage(stage)).catch(() => undefined),
              );
            }
          } catch (error) {
            const result = errorResult(item, error);
            const stage: SearchStage = {
              index,
              item,
              matchingRequest,
              constraints,
              normalizedItem,
              mode: hasLiveWalmartProvider() ? "live" : "demo",
              preliminary: result,
              searchResultCount: 0,
            };
            searchStages[index] = stage;
            timings[index].searchDurationMs = Math.round(performance.now() - startedAt);
            timings[index].totalDurationMs = timings[index].searchDurationMs;
            enqueueItem(stage, result, "search");
          }
        },
      );
      // Searches may have queued verifications at any point. Do not close the
      // stream or emit final diagnostics until every queued verification has
      // settled, including work still waiting for a verification slot.
      await Promise.allSettled(verificationTasks);

      const upstreamCacheUsed = searchApiCalls + productApiCalls === 0 && cacheHits > 0
        ? "local cache only" as const
        : upstreamCacheSignals.some((value) => value === true)
          ? "yes" as const
          : upstreamCacheSignals.length && upstreamCacheSignals.every((value) => value === false)
            ? "no" as const
            : "unknown" as const;
      const performanceEvent: SearchPerformanceStreamEvent = {
        type: "performance",
        mode: sawDemo ? "demo" : "live",
        checkedAt: new Date().toISOString(),
        performance: {
          totalDurationMs: Math.round(performance.now() - requestStartedAt),
          cacheHits,
          searchApiCalls,
          productApiCalls,
          deduplicatedRequests,
          upstreamCacheUsed,
          items: timings,
        },
      };
      controller.enqueue(encoder.encode(`${JSON.stringify(performanceEvent)}\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
