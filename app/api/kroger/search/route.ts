import { siteConfig } from "@/config/site";
import { after } from "next/server";
import { conceptForIntent } from "@/lib/knowledge/foundations";
import { lookupKnowledge, discoverWithKnowledge, learningForResult, rememberResults } from "@/lib/knowledge/pipeline";
import type { KnowledgeLearning } from "@/lib/knowledge/protocol";
import { prepareFeedbackBrowser, issueFeedbackEvidence } from "@/lib/knowledge/feedback";
import { knowledgeId } from "@/lib/knowledge/foundations";
import {
  enforceRateLimit,
  hasOnlyKeys,
  hasValidSearchItemShape,
  isRecord,
  readValidatedJson,
} from "@/lib/api-security";
import {
  KrogerProviderError,
  refreshKrogerProductIdentity,
} from "@/lib/kroger-provider";
import { krogerAdapter } from "@/lib/retailers/kroger-adapter";
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
} from "@/lib/product-search-intent";
import type { ProductIntent } from "@/lib/product-search-intent";
import { extractMeasurement, extractPackOnlyCount } from "@/lib/measurements";
import { extractRequestedBrand } from "@/lib/product-knowledge";
import {
  comparisonBasketDigest,
  saveComparisonReceipt,
} from "@/lib/mobile-comparison-receipts";
import {
  AvailabilityStatus,
  BasketCompleteness,
  COMPARISON_SESSION_SCHEMA_VERSION,
  availabilityForComparison,
  assertComparisonStoreInvariant,
  isRetailerHandoffAcceptedMatch,
  krogerRetailerBanner,
  parseRetailerPackageQuantity,
  type ComparisonBasketLine,
  type ComparisonSessionReceipt,
} from "@/packages/shared/src";
import type {
  KrogerMatchResult,
  KrogerProduct,
  KrogerSearchItemStreamEvent,
  KrogerSearchPerformanceStreamEvent,
  RetailFulfillmentMode,
  SearchPerformanceDiagnostics,
  ProductFeedback,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface KrogerSearchBody {
  retailer?: unknown;
  items?: unknown;
  locationId?: unknown;
  storeId?: unknown;
  zipCode?: unknown;
  fulfillmentMode?: unknown;
  comparisonId?: unknown;
}

interface KrogerSearchReadOptions {
  feedbackBrowser?: { owner: string; cookie?: string } | null;
  anonymousReadOnly?: boolean;
  comparisonOwnerId?: string;
  requireComparisonReceipt?: boolean;
}

interface NormalizedItem {
  index: number;
  item: string;
  matchingRequest: string;
  intent: ProductIntent;
  constraints: ProductConstraint[];
  preferredProductId?: string;
  preferredTitle?: string;
  requestedItemId: string;
  quantity: number;
}

function trustedField(entry: unknown, name: string, pattern: RegExp, maximum: number) {
  if (!entry || typeof entry !== "object" || !(name in entry)) return undefined;
  const value = (entry as Record<string, unknown>)[name];
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length <= maximum && pattern.test(cleaned) ? cleaned : undefined;
}

function optionalItemText(entry: Record<string, unknown> | undefined, name: string) {
  const value = entry?.[name];
  if (typeof value !== "string") return undefined;
  const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function normalizedIncludes(value: string, phrase: string) {
  const normalize = (text: string) => text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ` ${normalize(value)} `.includes(` ${normalize(phrase)} `);
}

/**
 * Extension parsing is advisory input, not a replacement for the shopper's
 * text. Add only missing facts to the verification request; discovery later
 * removes package syntax while strict matching continues to see it.
 */
function augmentVerificationText(item: string, record?: Record<string, unknown>) {
  const additions: string[] = [];
  const explicitBrand = optionalItemText(record, "explicitBrand");
  if (
    explicitBrand
    && !extractRequestedBrand(item)
    && !normalizedIncludes(item, explicitBrand)
  ) additions.push(explicitBrand);

  const explicitSize = optionalItemText(record, "explicitSize");
  if (explicitSize && !extractMeasurement(item) && !normalizedIncludes(item, explicitSize)) {
    additions.push(explicitSize);
  }

  const explicitPackCount = record?.explicitPackCount;
  const parsedMeasurement = extractMeasurement([item, ...additions].join(" "));
  if (
    typeof explicitPackCount === "number"
    && !extractPackOnlyCount(item)
    && !parsedMeasurement?.packCount
  ) additions.push(`${explicitPackCount} pack`);

  return [item, ...additions].join(" ").replace(/\s+/g, " ").trim();
}

function normalizeItems(value: unknown): NormalizedItem[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return null;
  const normalized: NormalizedItem[] = [];
  for (const [index, entry] of value.entries()) {
    if (!hasValidSearchItemShape(
      entry,
      ["preferredProductId", "preferredItemId", "preferredTitle", "requestedItemId"],
    )) return null;
    const record = isRecord(entry) ? entry : undefined;
    const item = typeof entry === "string"
      ? entry.normalize("NFKC").replace(/\s+/g, " ").trim()
      : record && typeof record.text === "string"
        ? record.text.normalize("NFKC").replace(/\s+/g, " ").trim()
        : "";
    if (!item) return null;
    const optionIds = record && "facetOptionIds" in record
      ? sanitizeFacetOptionIds(record.facetOptionIds)
      : [];
    const verificationText = augmentVerificationText(item, record);
    const facets = analyzeProductFacets(verificationText, optionIds);
    const matchingRequest = buildFacetSearchQuery(verificationText, facets.constraints);
    const structuredRequest = analyzeProductFacets(matchingRequest, optionIds);
    const intent = parseProductIntent(matchingRequest, structuredRequest);
    const submittedQuantity = record && typeof record.quantity === "number"
      ? record.quantity
      : undefined;
    const quantity = intent.requestedCartQuantity > 1 && submittedQuantity === 1
      ? intent.requestedCartQuantity
      : submittedQuantity ?? intent.requestedCartQuantity;
    normalized.push({
      index,
      item,
      matchingRequest,
      intent,
      constraints: structuredRequest.constraints,
      preferredProductId: trustedField(entry, "preferredProductId", /^\d{8,14}$/, 14),
      preferredTitle: trustedField(entry, "preferredTitle", /^.{1,300}$/, 300),
      requestedItemId: trustedField(entry, "requestedItemId", /^[A-Za-z0-9_-]{3,96}$/, 96)
        ?? `requested-${index}`,
      quantity,
    });
  }
  return normalized;
}

function comparisonId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|cmp_[A-Za-z0-9_-]{8,120})$/i
    .test(cleaned)
    ? cleaned
    : undefined;
}

function usablePriceCents(product: KrogerProduct) {
  const regular = product.priceProvenance.regularPriceCents;
  if (typeof regular === "number" && Number.isSafeInteger(regular) && regular > 0) return regular;
  if (typeof product.priceCents === "number" && Number.isSafeInteger(product.priceCents) && product.priceCents > 0) {
    return product.priceCents;
  }
  const value = Math.round(product.price * 100);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function comparisonAddress(location: {
  address: { addressLine1: string; city: string; state: string; zipCode: string };
}) {
  return [
    location.address.addressLine1,
    location.address.city,
    `${location.address.state} ${location.address.zipCode}`.trim(),
  ].filter(Boolean).join(", ");
}

function receiptLine(
  comparison: string,
  locationId: string,
  mode: "pickup" | "delivery",
  item: NormalizedItem,
  result: KrogerMatchResult,
): ComparisonBasketLine {
  const quantityIntent = parseRetailerPackageQuantity(item.item);
  const product = result.status === "matched" ? result.recommended : null;
  const sameStore = Boolean(
    product
    && product.priceProvenance.locationId === locationId
    && product.priceProvenance.exactStoreVerified
    && product.priceProvenance.location.storeMatched !== false
    && product.priceProvenance.fulfillment.includes(mode),
  );
  const priceCents = product ? usablePriceCents(product) : undefined;
  const accepted = Boolean(
    product
    && isRetailerHandoffAcceptedMatch(result)
    && sameStore
    && product.productId
    && product.upc
    && priceCents,
  );
  return {
    lineId: `${comparison}:${item.requestedItemId}`,
    requestedItemId: item.requestedItemId,
    requestedItem: item.item,
    normalizedIntent: quantityIntent.searchText,
    quantity: result.fulfillment?.cartQuantity ?? item.quantity,
    packageSizeText: quantityIntent.packageSizeText,
    status: accepted ? "ACCEPTED" : product ? "REJECTED" : "UNMATCHED",
    ...(accepted && product ? {
      retailerProductId: product.productId,
      upc: product.upc,
      matchedProduct: product.title,
      matchedPackage: product.size?.label,
      priceCents,
      provenance: {
        dataSource: product.dataSource,
        priceSource: product.priceProvenance.priceSource,
        priceScope: product.priceProvenance.priceScope,
        priceReliability: product.priceProvenance.priceReliability,
        exactStoreVerified: product.priceProvenance.exactStoreVerified,
        sourceLocationId: product.priceProvenance.locationId,
        fulfillment: product.priceProvenance.fulfillment
          .filter((entry): entry is "pickup" | "delivery" => entry === "pickup" || entry === "delivery"),
        checkedAt: product.priceProvenance.checkedAt ?? product.checkedAt,
      },
    } : {}),
    locationId,
    availabilityStatus: product
      ? availabilityForComparison(product.availabilityStatus)
      : AvailabilityStatus.UNKNOWN,
    matchConfidence: product ? product.confidence : "low",
  };
}

function buildComparisonReceipt({
  comparison,
  location,
  locationId,
  zipCode,
  mode,
  items,
  results,
  checkedAt,
}: {
  comparison: string;
  location: Awaited<ReturnType<typeof krogerAdapter.verifyLocation>>;
  locationId: string;
  zipCode: string;
  mode: "pickup" | "delivery";
  items: NormalizedItem[];
  results: KrogerMatchResult[];
  checkedAt: string;
}): ComparisonSessionReceipt {
  const basketLines = items.map((item) => receiptLine(
    comparison,
    locationId,
    mode,
    item,
    results[item.index] ?? errorResult(item.item, new Error("Missing verification result.")),
  ));
  const complete = basketLines.length > 0 && basketLines.every((line) => line.status === "ACCEPTED");
  return assertComparisonStoreInvariant({
    schemaVersion: COMPARISON_SESSION_SCHEMA_VERSION,
    comparisonId: comparison,
    retailer: "kroger",
    retailerChain: location.chain,
    retailerBanner: krogerRetailerBanner(location.chain),
    locationId,
    locationName: location.name,
    locationAddress: comparisonAddress(location),
    zipCode,
    fulfillmentMode: mode,
    requestedItemIds: items.map((item) => item.requestedItemId),
    basketLines,
    completeness: complete ? BasketCompleteness.COMPLETE : BasketCompleteness.INCOMPLETE,
    checkedAt,
    createdAt: checkedAt,
  });
}

function candidatePackCount(product: KrogerProduct) {
  return product.size?.packCount
    ?? extractPackOnlyCount(product.title)
    ?? (product.size?.kind === "count" && /\b(?:pack|pk)\b/i.test(product.title)
      ? product.size.baseAmount
      : undefined);
}

/** Strict package identity: equivalent units are allowed, closest sizes are not. */
function exactRequestedPackage(request: string, product: KrogerProduct) {
  const requestedPackOnly = extractPackOnlyCount(request);
  const requested = extractMeasurement(request);
  if (!requestedPackOnly && !requested) return true;
  if (requestedPackOnly) return candidatePackCount(product) === requestedPackOnly;
  if (!requested || !product.size || requested.kind !== product.size.kind) return false;

  if (requested.packCount) {
    if (candidatePackCount(product) !== requested.packCount) return false;
  } else if ((candidatePackCount(product) ?? 1) > 1) {
    return false;
  }

  if (requested.baseAmount <= 0 || product.size.baseAmount <= 0) return false;
  return Math.abs(product.size.baseAmount - requested.baseAmount) / requested.baseAmount <= 0.02;
}

function verifiedResult(item: NormalizedItem, products: KrogerProduct[]) {
  return krogerAdapter.verifyCandidates(
    item.matchingRequest,
    products,
    {
      constraints: item.constraints,
      cartQuantity: item.quantity,
      intent: item.intent,
      preferredIdentity: {
        productId: item.preferredProductId,
        title: item.preferredTitle,
      },
    },
  );
}

function specificNoMatchExplanation(item: NormalizedItem, products: KrogerProduct[]) {
  const explanation = explainDiscoveryFailure({
    retailerLabel: "Kroger",
    intent: item.intent,
    candidates: products,
    exactPackage: (product) => !item.intent.strictPackageRequest
      || exactRequestedPackage(item.intent.verificationText, product),
    commerceEligible: (product) => (
      product.availabilityStatus !== "out_of_stock"
      && product.priceProvenance.exactStoreVerified
      && Number.isFinite(product.price)
      && product.price > 0
    ),
  });
  return /none passed Cartiva's strict product checks/i.test(explanation)
    ? `Kroger found possible ${item.intent.displayName} products, but Cartiva could not verify any strongly enough against your request.`
    : explanation;
}

function fulfillmentMode(value: unknown): Extract<RetailFulfillmentMode, "pickup" | "delivery"> | null {
  if (value === "pickup" || value === "delivery") return value;
  return value === undefined ? "pickup" : null;
}

function errorResult(item: string, error: unknown): KrogerMatchResult {
  return {
    retailer: "kroger",
    requestedItem: item,
    recommended: null,
    alternatives: [],
    confidence: "low",
    status: "review",
    explanation: "Kroger could not check this item.",
    error: error instanceof Error ? error.message : "Kroger API error.",
  };
}

async function allSettledWithConcurrency<T>(
  values: T[],
  limit: number,
  task: (value: T) => Promise<void>,
) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) await task(values[cursor++]);
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () => worker()),
  );
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "kroger-search", { limit: 45, windowMs: 60_000 });
  if (limited) return limited;
  const parsed = await readValidatedJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  return handleKrogerSearchRead(parsed.value, { feedbackBrowser: await prepareFeedbackBrowser(request) });
}

/** Shared read implementation for validated server-side API boundaries. */
export async function handleKrogerSearchRead(
  value: unknown,
  options: KrogerSearchReadOptions = {},
) {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ["retailer", "items", "locationId", "storeId", "zipCode", "fulfillmentMode", "comparisonId"],
  )) {
    return Response.json({ error: "The Kroger search request contains unsupported fields." }, { status: 400 });
  }
  const body = value as KrogerSearchBody;
  if (body.retailer !== undefined && body.retailer !== "kroger") {
    return Response.json({ error: "Use this route only for Kroger searches." }, { status: 400 });
  }
  const items = normalizeItems(body.items);
  if (!items) {
    return Response.json(
      { error: "Add 1 to 50 valid shopping-list items, each no longer than 300 characters." },
      { status: 400 },
    );
  }
  if (
    options.requireComparisonReceipt
    && new Set(items.map((item) => item.requestedItemId)).size !== items.length
  ) {
    return Response.json(
      { error: "Every comparison item needs a unique line identifier." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const locationId = typeof body.locationId === "string"
    ? body.locationId.trim()
    : typeof body.storeId === "string" ? body.storeId.trim() : "";
  if (!krogerAdapter.isValidLocationId(locationId)) {
    return Response.json({ error: "Choose a valid Kroger-family store." }, { status: 400 });
  }
  if (
    body.zipCode !== undefined
    && (typeof body.zipCode !== "string" || !/^\d{5}$/.test(body.zipCode.trim()))
  ) {
    return Response.json({ error: "Enter a valid 5-digit ZIP code." }, { status: 400 });
  }
  const mode = fulfillmentMode(body.fulfillmentMode);
  if (!mode) {
    return Response.json(
      { error: "Kroger currently supports pickup or delivery in Cartiva." },
      { status: 400 },
    );
  }
  const requestedComparisonId = comparisonId(body.comparisonId);
  if (body.comparisonId !== undefined && !requestedComparisonId) {
    return Response.json({ error: "Start a valid Cartiva comparison before searching." }, { status: 400 });
  }
  if (
    options.requireComparisonReceipt
    && (!requestedComparisonId || !options.comparisonOwnerId)
  ) {
    return Response.json(
      { error: "A secure comparison session is required for this mobile search." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let location;
  try {
    location = await krogerAdapter.verifyLocation(locationId);
  } catch (error) {
    const status = error instanceof KrogerProviderError ? error.status : 502;
    return Response.json(
      { error: error instanceof Error ? error.message : "Kroger could not verify the store." },
      { status },
    );
  }

  const encoder = new TextEncoder();
  const requestStartedAt = performance.now();
  const memory = await lookupKnowledge(items.map(item => item.intent));
  const learning: KnowledgeLearning[] = [];
  let finishLearning!: () => void;
  const finished = new Promise<void>(resolve => { finishLearning = resolve; });
  // Registered in request scope; Next/Vinext keeps bounded work alive after
  // the NDJSON response. Direct unit callers have no request lifecycle.
  try { after(async () => { await finished; await rememberResults(learning, ![...memory.values()].some(context => context.foundationsReady)); }); }
  catch { /* No detached background writes outside a supported lifecycle. */ }
  const cartAutomation = options.anonymousReadOnly
    ? {
        enabled: false as const,
        reason: "Cart transfer is unavailable on Cartiva's anonymous mobile API.",
      }
    : { enabled: true as const, requiresCustomerConnection: true as const };
  const stream = new ReadableStream({
    async start(controller) {
      try {
      const timings: SearchPerformanceDiagnostics["items"] = items.map(({ index, item }) => ({
        index,
        item,
        searchDurationMs: 0,
        verificationDurationMs: 0,
        totalDurationMs: 0,
      }));
      let searchApiCalls = 0;
      let productApiCalls = 0;
      let cacheHits = 0;
      let deduplicatedRequests = 0;
      const verifiedResults: KrogerMatchResult[] = [];

      const enqueue = (
        item: NormalizedItem,
        result: KrogerMatchResult,
        phase: KrogerSearchItemStreamEvent["phase"],
        resultCount: number,
        correction?: ProductFeedback,
      ) => {
        // The stream contract is bound to the exact normalized request line.
        // Internal facet expansion may add verification terms, but those are
        // not allowed to replace the shopper/request identity on mobile.
        const responseResult: KrogerMatchResult = {
          ...result,
          requestedItem: item.item,
        };
        const event: KrogerSearchItemStreamEvent = {
          type: "item",
          retailer: "kroger",
          phase,
          index: item.index,
          mode: "live",
          checkedAt: new Date().toISOString(),
          cartAutomation,
          result: responseResult,
          ...(correction ? { correction } : {}),
          diagnostics: {
            searchResultCount: resultCount,
            selectedProductId: responseResult.recommended?.productId,
            verificationStatus: responseResult.status === "matched"
              ? "verified"
              : responseResult.status === "review" ? "needs_review" : "no_verified_match",
            locationId,
            rejectionReason: responseResult.status === "matched" ? undefined : responseResult.explanation,
          },
        };
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      await allSettledWithConcurrency(items, siteConfig.searchConcurrency, async (item) => {
        const startedAt = performance.now();
        try {
          const discovery = await discoverWithKnowledge({
            intent: item.intent,
            memory: memory.get(conceptForIntent(item.intent)?.id ?? ""),
            search: async (query) => {
              const response = await krogerAdapter.searchProducts(query, {
                locationId,
                locationVerified: true,
                locationName: location.name,
                chain: location.chain,
                fulfillmentMode: mode,
              });
              searchApiCalls += response.diagnostics.apiCall ? 1 : 0;
              cacheHits += response.diagnostics.cacheHit ? 1 : 0;
              deduplicatedRequests += response.diagnostics.deduplicated ? 1 : 0;
              return response.products.slice(0, 20);
            },
            verify: products => verifiedResult(item, products),
            plausible: product => isPlausibleDiscoveryCandidate(item.intent, product),
            refreshIdentity: upc => refreshKrogerProductIdentity(upc, {
              locationId, locationVerified: true, locationName: location.name, chain: location.chain, fulfillmentMode: mode,
            }),
          });
          productApiCalls += discovery.detailCalls;
          const preliminaryResult = verifiedResult(item, discovery.candidates);
          const preliminary: KrogerMatchResult = preliminaryResult.status === "review"
            ? preliminaryResult
            : preliminaryResult.recommended
            ? {
                ...preliminaryResult,
                status: "review",
                explanation: "Kroger returned a possible match; Cartiva is confirming it for the selected store.",
              }
            : {
                ...preliminaryResult,
                explanation: specificNoMatchExplanation(item, discovery.candidates),
              };
          timings[item.index].searchDurationMs = Math.round(performance.now() - startedAt);
          enqueue(item, preliminary, "search", discovery.candidates.length);
          const verificationStartedAt = performance.now();
          const ranked = verifiedResult(item, discovery.candidates);
          const verified: KrogerMatchResult = ranked.recommended || ranked.status === "review"
            ? ranked
            : { ...ranked, explanation: specificNoMatchExplanation(item, discovery.candidates) };
          verifiedResults[item.index] = verified;
          timings[item.index].verificationDurationMs = Math.round(performance.now() - verificationStartedAt);
          timings[item.index].totalDurationMs = timings[item.index].searchDurationMs
            + timings[item.index].verificationDurationMs;
          let correction: ProductFeedback | undefined;
          const safeConcept = conceptForIntent(item.intent);
          if (options.feedbackBrowser && safeConcept) {
            const offers = [...(verified.recommended ? [verified.recommended] : []), ...verified.alternatives]
              .filter((p, i, all) => /^\d{12,14}$/.test(p.upc) && all.findIndex(other => other.upc === p.upc) === i).slice(0, 4)
              .map(p => ({ upc: p.upc, productId: p.productId, title: p.title, package: p.size?.label ?? "Package needs review",
                canChoose: isRetailerHandoffAcceptedMatch(verifiedResult(item, [p])) }));
            if (offers.length) correction = { offers, receipt: issueFeedbackEvidence(options.feedbackBrowser.owner, {
              conceptId: safeConcept.id, intentDigest: knowledgeId(item.intent.verificationText), itemId: item.requestedItemId,
              quantity: item.quantity, store: locationId, fulfillment: mode, recommendedUpc: verified.recommended?.upc ?? "", offers,
            }) };
          }
          enqueue(item, verified, "verification", discovery.candidates.length, correction);
          const learned = learningForResult({ intent: item.intent, result: verified, attempts: discovery.attempts,
            queryOrigins: discovery.queryOrigins, locationId, fulfillment: mode });
          if (learned) learning.push(learned);
          logDiscoveryDecision({
            intent: item.intent,
            attempts: discovery.attempts,
            candidates: discovery.candidates,
            selectedId: verified.recommended?.productId,
            rejectionReason: verified.status === "matched" ? undefined : verified.explanation,
          });
        } catch (error) {
          searchApiCalls += 1;
          const result = errorResult(item.item, error);
          verifiedResults[item.index] = result;
          timings[item.index].searchDurationMs = Math.round(performance.now() - startedAt);
          timings[item.index].totalDurationMs = timings[item.index].searchDurationMs;
          enqueue(item, result, "search", 0);
        }
      });

      const receiptCheckedAt = new Date().toISOString();
      let receiptConfirmation: KrogerSearchPerformanceStreamEvent["comparisonReceipt"];
      if (requestedComparisonId && options.comparisonOwnerId) {
        const receipt = buildComparisonReceipt({
          comparison: requestedComparisonId,
          location,
          locationId,
          zipCode: typeof body.zipCode === "string"
            ? body.zipCode.trim()
            : location.address.zipCode,
          mode,
          items,
          results: verifiedResults,
          checkedAt: receiptCheckedAt,
        });
        await saveComparisonReceipt(options.comparisonOwnerId, receipt);
        receiptConfirmation = {
          comparisonId: receipt.comparisonId,
          locationId: receipt.locationId,
          retailerBanner: receipt.retailerBanner,
          completeness: receipt.completeness,
          basketDigest: comparisonBasketDigest(receipt),
          persisted: true,
        };
      }
      const performanceEvent: KrogerSearchPerformanceStreamEvent = {
        type: "performance",
        retailer: "kroger",
        mode: "live",
        checkedAt: new Date().toISOString(),
        comparisonReceipt: receiptConfirmation,
        performance: {
          totalDurationMs: Math.round(performance.now() - requestStartedAt),
          cacheHits,
          searchApiCalls,
          productApiCalls,
          deduplicatedRequests,
          upstreamCacheUsed: searchApiCalls === 0 && cacheHits > 0 ? "local cache only" : "unknown",
          outcomeCounts: {
            requestedItems: items.length,
            matchedAutomatically: verifiedResults.filter((result) => (
              result.status === "matched" && Boolean(result.recommended)
            )).length,
            multiPackageFulfilled: verifiedResults.filter((result) => (
              result.status === "matched"
              && result.resolution === "multi_package_fulfillment"
              && result.fulfillment?.kind === "multi_package"
              && result.fulfillment.approvalRequired !== true
            )).length,
            shopperChoiceRequired: verifiedResults.filter((result) => (
              result.resolution === "needs_choice"
              || result.resolution === "substitute_available"
            )).length,
            trulyUnavailable: verifiedResults.filter((result) => (
              result.resolution === "truly_unavailable" || result.status === "no_match"
            )).length,
          },
          items: timings,
        },
      };
      controller.enqueue(encoder.encode(`${JSON.stringify(performanceEvent)}\n`));
      controller.close();
      } finally { finishLearning(); }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Cartiva-Cart-Automation": options.anonymousReadOnly
        ? "unavailable-on-anonymous-mobile-api"
        : "official-kroger-api",
      "X-Cartiva-Kroger-Location": locationId,
      ...(options.feedbackBrowser?.cookie ? { "Set-Cookie": options.feedbackBrowser.cookie } : {}),
    },
  });
}
