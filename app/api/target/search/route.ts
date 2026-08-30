import { siteConfig } from "@/config/site";
import {
  enforceRateLimit,
  hasOnlyKeys,
  hasValidSearchItemShape,
  isRecord,
  readValidatedJson,
} from "@/lib/api-security";
import {
  getParseBotTargetStoreStock,
  searchParseBotTarget,
} from "@/lib/parsebot-target";
import type { ParseBotTargetProduct } from "@/lib/parsebot-target";
import { normalizeShoppingItem } from "@/lib/list-parser";
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
  normalizeTargetProviderProduct,
  rankTargetProducts,
  TARGET_CART_AUTOMATION_POLICY,
} from "@/lib/target-products";
import { verifyTargetSelectedProduct } from "@/lib/target-verification";
import type {
  RetailFulfillmentMode,
  SearchPerformanceDiagnostics,
  TargetMatchResult,
  TargetProduct,
  TargetSearchItemStreamEvent,
  TargetSearchPerformanceStreamEvent,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TargetSearchBody {
  retailer?: unknown;
  items?: unknown;
  storeId?: unknown;
  zipCode?: unknown;
  fulfillmentMode?: unknown;
}

interface NormalizedRequestItem {
  index: number;
  item: string;
  matchingRequest: string;
  normalizedItem: string;
  intent: ProductIntent;
  constraints: ProductConstraint[];
  preferredProductId?: string;
  preferredTitle?: string;
}

function exactPackageMatch(request: string, product: TargetProduct) {
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

function strictTargetCandidates(request: string, products: TargetProduct[]) {
  return products.filter((product) => exactPackageMatch(request, product));
}

function trustedStringField(entry: unknown, field: string, pattern: RegExp, maximum: number) {
  if (!entry || typeof entry !== "object" || !(field in entry)) return undefined;
  const value = (entry as Record<string, unknown>)[field];
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum && pattern.test(normalized) ? normalized : undefined;
}

function responseProductId(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.product && typeof record.product === "object"
    ? record.product as Record<string, unknown>
    : undefined;
  for (const candidate of [record.productId, record.tcin, nested?.productId, nested?.tcin]) {
    if (typeof candidate !== "string" && typeof candidate !== "number") continue;
    const normalized = String(candidate).replace(/^A-/i, "").trim();
    if (/^(?:\d{8}|\d{10})$/.test(normalized)) return normalized;
  }
  return undefined;
}

function withoutUnprovenSellerClaim(product: ParseBotTargetProduct) {
  // Parse's Target payload does not identify the offer seller. A Target URL is
  // product identity evidence, not proof that Target itself sells the offer.
  return {
    ...product,
    seller: undefined,
    provenance: {
      ...product.provenance,
      sellerType: "unknown" as const,
    },
  };
}

function normalizeRequestItems(value: unknown): NormalizedRequestItem[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) return null;

  const normalized: NormalizedRequestItem[] = [];
  for (const [originalIndex, entry] of value.entries()) {
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
    const preferredProductId = trustedStringField(
      entry,
      "preferredProductId",
      /^(?:\d{8}|\d{10})$/,
      10,
    );
    const preferredTitle = trustedStringField(entry, "preferredTitle", /^.{1,300}$/, 300);
    if (!item) return null;
    const optionIds = record && "facetOptionIds" in record
      ? sanitizeFacetOptionIds(record.facetOptionIds)
      : [];
    const facets = analyzeProductFacets(item, optionIds);
    const matchingRequest = buildFacetSearchQuery(item, facets.constraints);
    const intent = parseProductIntent(matchingRequest, facets);
    normalized.push({
      index: originalIndex,
      item,
      matchingRequest,
      normalizedItem: normalizeShoppingItem(
        intent.discoveryQueries[0]?.query ?? matchingRequest,
      ),
      intent,
      constraints: facets.constraints,
      preferredProductId,
      preferredTitle,
    });
  }
  return normalized;
}

function normalizeFulfillmentMode(value: unknown): RetailFulfillmentMode | null {
  return value === "delivery" || value === "shipping" || value === "pickup"
    ? value
    : value === undefined ? "pickup" : null;
}

function parseBotTargetIsConfigured() {
  const provider = process.env.TARGET_DATA_PROVIDER?.trim().toLowerCase() || "parsebot";
  return provider === "parsebot" && Boolean(process.env.PARSEBOT_API_KEY?.trim());
}

function errorResult(item: string, error: unknown): TargetMatchResult {
  return {
    retailer: "target",
    requestedItem: item,
    recommended: null,
    alternatives: [],
    confidence: "low",
    status: "review",
    explanation: "Target could not check this item.",
    error: error instanceof Error ? error.message : "Target provider error.",
  };
}

function itemDiagnostics(result: TargetMatchResult, searchResultCount: number) {
  const exactStore = result.recommended?.priceProvenance.exactStoreVerified === true;
  return {
    searchResultCount,
    selectedProductId: result.recommended?.productId,
    verificationStatus: result.status === "matched"
      ? exactStore ? "verified" as const : "localized_estimate" as const
      : result.status === "review"
        ? "needs_review" as const
        : "no_verified_match" as const,
    rejectionReason: result.status === "matched" ? undefined : result.explanation,
  };
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
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () => worker()),
  );
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "target-search", { limit: 45, windowMs: 60_000 });
  if (limited) return limited;
  const parsed = await readValidatedJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.value) || !hasOnlyKeys(
    parsed.value,
    ["retailer", "items", "storeId", "zipCode", "fulfillmentMode"],
  )) {
    return Response.json({ error: "The Target search request contains unsupported fields." }, { status: 400 });
  }
  const body = parsed.value as TargetSearchBody;

  if (body.retailer !== undefined && body.retailer !== "target") {
    return Response.json(
      { error: "Use this route only for Target searches." },
      { status: 400 },
    );
  }
  const items = normalizeRequestItems(body.items);
  if (!items) {
    return Response.json(
      { error: "Add 1 to 24 valid shopping-list items, each no longer than 300 characters." },
      { status: 400 },
    );
  }
  const storeIdInput = typeof body.storeId === "string" ? body.storeId.trim() : "";
  const zipCode = typeof body.zipCode === "string" ? body.zipCode.trim() : "";
  const fulfillmentMode = normalizeFulfillmentMode(body.fulfillmentMode);
  if (!fulfillmentMode) {
    return Response.json(
      { error: "Target fulfillment must be pickup, delivery, or shipping." },
      { status: 400 },
    );
  }
  if (storeIdInput && !/^\d{3,4}$/.test(storeIdInput)) {
    return Response.json(
      { error: "Enter a valid 3- or 4-digit Target store ID." },
      { status: 400 },
    );
  }
  const storeId = storeIdInput.replace(/^0+(?=\d)/, "");
  if (zipCode && !/^\d{5}$/.test(zipCode)) {
    return Response.json({ error: "Enter a valid 5-digit ZIP code." }, { status: 400 });
  }
  if (fulfillmentMode === "pickup" && !storeId) {
    return Response.json(
      {
        error: "Enter a Target store ID for pickup. Target store lookup is not available yet.",
        cartAutomation: TARGET_CART_AUTOMATION_POLICY,
      },
      { status: 400 },
    );
  }
  if (fulfillmentMode === "pickup" && !zipCode) {
    return Response.json(
      {
        error: "Enter a 5-digit ZIP code for Target pickup comparison.",
        cartAutomation: TARGET_CART_AUTOMATION_POLICY,
      },
      { status: 400 },
    );
  }
  if (fulfillmentMode !== "pickup" && !zipCode) {
    return Response.json(
      { error: `Enter a 5-digit ZIP code for Target ${fulfillmentMode}.` },
      { status: 400 },
    );
  }
  if (!parseBotTargetIsConfigured()) {
    return Response.json(
      {
        error: "Target live data is not configured. Set TARGET_DATA_PROVIDER=parsebot and add PARSEBOT_API_KEY on the Cartiva server.",
        cartAutomation: TARGET_CART_AUTOMATION_POLICY,
      },
      { status: 503 },
    );
  }

  // Parse.bot localizes Target discovery by ZIP. Selected-store inventory is
  // checked separately below and is never treated as exact-store price proof.
  const providerOptions = { zip: zipCode } as const;
  const encoder = new TextEncoder();
  const requestStartedAt = performance.now();
  const stream = new ReadableStream({
    async start(controller) {
      const timings: SearchPerformanceDiagnostics["items"] = items.map(({ index, item }) => ({
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

      const enqueueItem = (
        item: NormalizedRequestItem,
        result: TargetMatchResult,
        phase: TargetSearchItemStreamEvent["phase"],
        searchResultCount: number,
      ) => {
        const event: TargetSearchItemStreamEvent = {
          type: "item",
          retailer: "target",
          phase,
          index: item.index,
          mode: "live",
          checkedAt: new Date().toISOString(),
          cartAutomation: TARGET_CART_AUTOMATION_POLICY,
          result,
          diagnostics: itemDiagnostics(result, searchResultCount),
        };
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      await allSettledWithConcurrency(
        items,
        siteConfig.searchConcurrency,
        async (item) => {
          const searchStartedAt = performance.now();
          let searchResultCount = 0;
          let pooledSearchProducts: ParseBotTargetProduct[] = [];
          let preliminary: TargetMatchResult;
          const normalizeSearchProduct = (product: ParseBotTargetProduct) => (
            normalizeTargetProviderProduct(
              withoutUnprovenSellerClaim(product), {
                source: "search",
                dataSource: "parsebot",
                fulfillmentMode,
                requestedStoreId: storeId || undefined,
                requestedPostalCode: zipCode || undefined,
                checkedAt: product.checkedAt ?? new Date().toISOString(),
              },
            )
          );
          try {
            const discovery = await retrieveCandidatesProgressively<ParseBotTargetProduct>({
              intent: item.intent,
              maxSearches: 3,
              maxCandidates: 60,
              candidateKey: (candidate) => candidate.tcin,
              isPlausible: (candidate) => {
                const normalized = normalizeSearchProduct(candidate);
                return normalized
                  ? isPlausibleDiscoveryCandidate(item.intent, normalized)
                  : false;
              },
              hasVerifiedMatch: (candidates) => {
                const normalized = candidates
                  .map(normalizeSearchProduct)
                  .filter((product): product is TargetProduct => product !== null);
                return Boolean(rankTargetProducts(
                  item.matchingRequest,
                  strictTargetCandidates(item.matchingRequest, normalized),
                  item.constraints,
                  {
                    productId: item.preferredProductId,
                    title: item.preferredTitle,
                  },
                ).recommended);
              },
              search: async (query) => {
                try {
                  const response = await searchParseBotTarget(
                    normalizeShoppingItem(query),
                    providerOptions,
                    request.signal,
                  );
                  cacheHits += response.diagnostics.cacheHit ? 1 : 0;
                  searchApiCalls += response.diagnostics.apiCall ? 1 : 0;
                  deduplicatedRequests += response.diagnostics.deduplicated ? 1 : 0;
                  return response.products;
                } catch (error) {
                  searchApiCalls += 1;
                  throw error;
                }
              },
            });
            pooledSearchProducts = discovery.candidates;
            searchResultCount = pooledSearchProducts.length;
            const products = pooledSearchProducts
              .map(normalizeSearchProduct)
              .filter((product): product is TargetProduct => product !== null);
            preliminary = rankTargetProducts(
              item.matchingRequest,
              strictTargetCandidates(item.matchingRequest, products),
              item.constraints,
              {
                productId: item.preferredProductId,
                title: item.preferredTitle,
              },
            );
            if (!preliminary.recommended) {
              preliminary = {
                ...preliminary,
                explanation: explainDiscoveryFailure({
                  retailerLabel: "Target",
                  intent: item.intent,
                  candidates: products,
                  exactPackage: (product) => exactPackageMatch(item.matchingRequest, product),
                  commerceEligible: (product) => (
                    product.inStock && Number.isFinite(product.price) && product.price > 0
                  ),
                }),
              };
            }
            if (process.env.NODE_ENV === "development") {
              logDiscoveryDecision({
                intent: item.intent,
                attempts: discovery.attempts,
                candidates: products.map((candidate) => ({
                  id: candidate.productId,
                  title: candidate.title,
                })),
                candidateOutcomes: products.map((candidate) => {
                    const packageMatches = exactPackageMatch(item.matchingRequest, candidate);
                    const candidateMatch = packageMatches
                      ? rankTargetProducts(
                          item.matchingRequest,
                          [candidate],
                          item.constraints,
                        )
                      : null;
                    return {
                      id: candidate.productId,
                      title: candidate.title,
                      verified: Boolean(candidateMatch?.recommended),
                      reasons: packageMatches
                        ? candidateMatch?.recommended
                          ? []
                          : [candidateMatch?.explanation ?? "identity requirements did not match"]
                        : ["requested package size or count did not match exactly"],
                    };
                  }),
                selectedId: preliminary.recommended?.productId,
                rejectionReason: preliminary.recommended ? undefined : preliminary.explanation,
              });
            }
          } catch (error) {
            preliminary = errorResult(item.item, error);
          }
          preliminary = { ...preliminary, requestedItem: item.item };
          timings[item.index].searchDurationMs = Math.round(performance.now() - searchStartedAt);
          enqueueItem(item, preliminary, "search", searchResultCount);
          if (!preliminary.recommended) {
            timings[item.index].totalDurationMs = timings[item.index].searchDurationMs;
            return;
          }

          const verificationStartedAt = performance.now();
          const verificationCandidates = [
            preliminary.recommended,
            ...preliminary.alternatives,
          ].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
            .slice(0, 3);
          let verified: TargetMatchResult | undefined;

          for (const candidate of verificationCandidates) {
            // Parse Search returns canonical identity and ZIP-localized price.
            // Pickup alone needs the selected-store inventory call.
            let stockResponse: Awaited<ReturnType<typeof getParseBotTargetStoreStock>> | null = null;
            if (fulfillmentMode === "pickup" && zipCode) {
              try {
                stockResponse = await getParseBotTargetStoreStock(
                  candidate.productId,
                  zipCode,
                  request.signal,
                );
                cacheHits += stockResponse.diagnostics.cacheHit ? 1 : 0;
                productApiCalls += stockResponse.diagnostics.apiCall ? 1 : 0;
                deduplicatedRequests += stockResponse.diagnostics.deduplicated ? 1 : 0;
              } catch {
                productApiCalls += 1;
              }
            }

            // Availability occasionally returns a different product. Never
            // attach that inventory to this candidate; continue to the next
            // compatible candidate when one is available.
            const stockProductId = responseProductId(stockResponse);
            const stockIdentityMatches = stockProductId === candidate.productId;
            const availabilityIdentityMismatch = Boolean(
              stockProductId && stockProductId !== candidate.productId,
            );
            const availabilityIdentityMissing = Boolean(stockResponse && !stockProductId);
            const requestedStoreStock = stockIdentityMatches
              ? stockResponse?.stores.find((entry) => entry.storeId === storeId)
              : undefined;
            const providerDetailSource = pooledSearchProducts.find(
              (product) => product.tcin === candidate.productId,
            ) ?? null;
            const providerDetail = providerDetailSource && (
              fulfillmentMode !== "pickup" || requestedStoreStock
            )
              ? {
                  ...providerDetailSource,
                  inStock: fulfillmentMode === "pickup"
                    ? requestedStoreStock?.inStock
                    : providerDetailSource.inStock,
                  provenance: {
                    ...providerDetailSource.provenance,
                    observedStoreId: requestedStoreStock?.storeId,
                    // Stock proves inventory only, never an exact-store price.
                    locationVerified: false as const,
                  },
                }
              : null;
            const detail = providerDetail
              ? normalizeTargetProviderProduct(
                  withoutUnprovenSellerClaim(providerDetail), {
                    source: "search",
                    dataSource: "parsebot",
                    fulfillmentMode,
                    requestedStoreId: storeId || undefined,
                    requestedPostalCode: zipCode || undefined,
                    checkedAt: providerDetail.checkedAt,
                  },
                )
              : null;
            const candidatePreliminary: TargetMatchResult = {
              ...preliminary,
              recommended: candidate,
              alternatives: verificationCandidates.filter(
                (entry) => entry.productId !== candidate.productId,
              ),
            };
            let candidateResult = verifyTargetSelectedProduct(
              item.matchingRequest,
              candidatePreliminary,
              detail,
              {
                fulfillmentMode,
                requestedStoreId: storeId || undefined,
                requestedPostalCode: zipCode || undefined,
                constraints: item.constraints,
              },
            );
            if (availabilityIdentityMismatch) {
              candidateResult = {
                ...candidateResult,
                explanation: "Target availability returned a different product, so Cartiva did not use that inventory and this item stays out of the cart.",
              };
            } else if (availabilityIdentityMissing) {
              candidateResult = {
                ...candidateResult,
                explanation: "Target availability did not confirm the selected product identity, so Cartiva did not use that inventory and this item stays out of the cart.",
              };
            }
            verified ??= candidateResult;
            if (candidateResult.status === "matched" && candidateResult.recommended) {
              verified = candidateResult;
              break;
            }
          }
          verified ??= preliminary;
          timings[item.index].verificationDurationMs = Math.round(
            performance.now() - verificationStartedAt,
          );
          timings[item.index].totalDurationMs = timings[item.index].searchDurationMs
            + timings[item.index].verificationDurationMs;
          enqueueItem(item, verified, "verification", searchResultCount);
        },
      );

      const totalCalls = searchApiCalls + productApiCalls;
      const performanceEvent: TargetSearchPerformanceStreamEvent = {
        type: "performance",
        retailer: "target",
        mode: "live",
        checkedAt: new Date().toISOString(),
        cartAutomation: TARGET_CART_AUTOMATION_POLICY,
        performance: {
          totalDurationMs: Math.round(performance.now() - requestStartedAt),
          cacheHits,
          searchApiCalls,
          productApiCalls,
          deduplicatedRequests,
          upstreamCacheUsed: totalCalls === 0 && cacheHits > 0 ? "local cache only" : "unknown",
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
      "X-Cartiva-Cart-Automation": "disabled",
    },
  });
}
