import { loadEnv } from "vite";

import { KrogerAuthError } from "@/lib/kroger-auth";
import { rankKrogerProducts } from "@/lib/kroger-products";
import { extractPackOnlyCount } from "@/lib/measurements";
import { packageFulfillmentForProduct } from "@/lib/package-fulfillment";
import {
  isPlausibleDiscoveryCandidate,
  parseProductIntent,
  retrieveCandidatesProgressively,
} from "@/lib/product-search-intent";
import {
  findKrogerLocations,
  getKrogerLocation,
  KrogerProviderError,
  resetKrogerProviderForTests,
  searchKrogerProducts,
} from "@/lib/kroger-provider";
import type {
  KrogerMatchResult,
  KrogerProduct,
  RetailPackageFulfillment,
} from "@/lib/types";
import { isRetailerHandoffAcceptedMatch } from "@/packages/shared/src/comparison-session";
import {
  interpretGroceryInput,
  resolveGroceryClarification,
} from "@/packages/shared/src/grocery-notepad";
import { cartiva100LiveCases } from "@/tests/support/cartiva-100";

export type Cartiva100LiveStatus = "LIVE_PASSED" | "LIVE_FAILED" | "EXTERNAL_BLOCKED";

export interface Cartiva100LiveCaseResult {
  id: string;
  input: string;
  resolvedRequest?: string;
  status: Cartiva100LiveStatus;
  reason: string;
  searchAttempts: Array<{ level: string; query: string; resultCount: number }>;
  returnedCandidateCount: number;
  selectedProduct?: {
    productId: string;
    upc: string;
    title: string;
    brand?: string;
    productType?: string;
    size?: KrogerProduct["size"];
    priceCents: number;
    availabilityStatus: KrogerProduct["availabilityStatus"];
    locationId: string;
    checkedAt: string;
    sourceUrl: string;
    cartQuantity: number;
    packageCount: number;
  };
}

interface LiveOracle {
  requiredGroups: string[][];
  forbidden?: string[];
  exactSize?: { kind: "count" | "weight" | "volume"; baseAmount: number };
  packCount?: number;
  container?: "can";
  requestedTotal?: {
    baseAmount: number;
    baseUnit: "oz" | "fl oz" | "each";
    maxOverageRatio: number;
  };
}

const LIVE_ORACLES: Record<string, LiveOracle> = {
  "C100-L1-002": {
    requiredGroups: [["white"], ["bread"]],
    forbidden: ["whole wheat", "gluten free", "sourdough"],
  },
  "C100-L1-006": {
    requiredGroups: [["white"], ["rice"]],
    forbidden: ["brown rice", "jasmine rice", "basmati rice"],
    exactSize: { kind: "weight", baseAmount: 80 },
  },
  "C100-L1-011": {
    requiredGroups: [["chicken"], ["breast"], ["boneless"], ["skinless"]],
    forbidden: ["nuggets", "breaded", "fully cooked"],
  },
  "C100-L1-016": {
    requiredGroups: [["coca cola", "coke"], ["soda", "cola"]],
    forbidden: ["zero sugar", "diet", "cherry", "vanilla"],
    packCount: 12,
  },
  "C100-L1-017": {
    requiredGroups: [["coca cola", "coke"], ["zero sugar", "coke zero"]],
    forbidden: ["diet coke", "cherry", "vanilla"],
    packCount: 12,
  },
  "C100-L2-001": {
    requiredGroups: [["kidney"], ["beans"]],
    forbidden: ["black beans", "garbanzo", "chickpea"],
    container: "can",
  },
  "C100-L2-002": {
    requiredGroups: [["garbanzo", "chickpea", "chick peas"]],
    container: "can",
  },
  "C100-L2-008": {
    requiredGroups: [["ground"], ["turkey"]],
    forbidden: ["chicken", "beef", "pork"],
    requestedTotal: { baseAmount: 48, baseUnit: "oz", maxOverageRatio: 0.35 },
  },
  "C100-L3-001": {
    requiredGroups: [["ground"], ["beef"], ["93/7", "93 7", "93% lean"]],
    forbidden: ["turkey", "chicken", "pork"],
  },
  "C100-L3-005": {
    requiredGroups: [["milk"], ["2%", "2 percent", "reduced fat"]],
    forbidden: ["whole milk", "skim", "fat free"],
    exactSize: { kind: "volume", baseAmount: 128 },
  },
};

export interface Cartiva100LiveReport {
  suiteId: "cartiva-100-kroger-live";
  status: Cartiva100LiveStatus;
  checkedAt: string;
  location?: {
    locationId: string;
    name: string;
    chain: string;
    zipCode: string;
  };
  retailerCalls: number;
  matched: number;
  blocked: number;
  failed: number;
  cases: Cartiva100LiveCaseResult[];
  reason?: string;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function searchableProductText(product: KrogerProduct) {
  return `${product.brand ?? ""} ${product.productType ?? ""} ${product.title}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9%/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOraclePhrase(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9%/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasOraclePhrase(text: string, phrase: string) {
  const normalized = normalizeOraclePhrase(phrase);
  return normalized.length > 0 && ` ${text} `.includes(` ${normalized} `);
}

function observedPackCounts(product: KrogerProduct) {
  const counts = new Set<number>();
  if (product.size?.packCount) counts.add(product.size.packCount);
  const titlePack = extractPackOnlyCount(product.title);
  if (titlePack) counts.add(titlePack);
  const multiplied = product.title.match(/\b(\d{1,3})\s*[x×]\s*\d+(?:\.\d+)?\s*(?:fl\s*oz|oz)\b/i);
  if (multiplied) counts.add(Number(multiplied[1]));
  if (
    product.size?.kind === "count"
    && /\b(?:pack|pk|count|ct|cans?)\b/i.test(product.title)
  ) counts.add(product.size.baseAmount);
  return [...counts].filter((count) => Number.isSafeInteger(count) && count > 0);
}

export function cartiva100LiveOracleFailure(testCaseId: string, product: KrogerProduct) {
  const oracle = LIVE_ORACLES[testCaseId];
  if (!oracle) return "The live case has no independent oracle.";
  const text = searchableProductText(product);
  const missing = oracle.requiredGroups.find((group) => !group.some((term) => hasOraclePhrase(text, term)));
  if (missing) return `Product metadata omitted required ${missing.join(" or ")}.`;
  const forbidden = oracle.forbidden?.find((term) => hasOraclePhrase(text, term));
  if (forbidden) return `Product metadata contained forbidden ${forbidden}.`;
  if (oracle.container === "can") {
    const title = normalizeOraclePhrase(product.title);
    const taxonomy = normalizeOraclePhrase(product.productType ?? "");
    const conflict = ["bag", "bags", "pouch", "pouches", "box", "boxes", "jar", "jars", "carton", "cartons", "canister", "canisters"]
      .find((term) => hasOraclePhrase(title, term));
    if (conflict) return `Product title confirmed conflicting ${conflict} packaging.`;
    const confirmsCan = ["can", "cans", "canned"].some((term) => (
      hasOraclePhrase(title, term) || hasOraclePhrase(taxonomy, term)
    ));
    if (!confirmsCan) return "Product metadata did not independently confirm canned packaging.";
  }
  if (oracle.packCount) {
    const counts = observedPackCounts(product);
    if (!counts.length) return `Product metadata did not confirm a ${oracle.packCount}-pack.`;
    if (counts.some((count) => count !== oracle.packCount)) {
      return `Product metadata reported conflicting pack count ${counts.join("/")}; expected ${oracle.packCount}.`;
    }
  }
  if (oracle.exactSize) {
    if (product.size?.kind !== oracle.exactSize.kind) {
      return `Product size kind was ${product.size?.kind ?? "missing"}; expected ${oracle.exactSize.kind}.`;
    }
    const difference = Math.abs(product.size.baseAmount - oracle.exactSize.baseAmount);
    if (difference > 0.02) {
      return `Product size was ${product.size.baseAmount}; expected ${oracle.exactSize.baseAmount}.`;
    }
  }
  return undefined;
}

export function cartiva100LiveFulfillmentFailure(
  testCase: ReturnType<typeof cartiva100LiveCases>[number],
  product: KrogerProduct,
  fulfillment: RetailPackageFulfillment,
) {
  const requestedTotal = LIVE_ORACLES[testCase.id]?.requestedTotal;
  if (!requestedTotal) {
    return fulfillment.cartQuantity === testCase.expectedCartQuantity
      && fulfillment.packageCount === testCase.expectedPackageCount
      ? undefined
      : `Returned quantity ${fulfillment.cartQuantity}/${fulfillment.packageCount}; expected ${testCase.expectedCartQuantity}/${testCase.expectedPackageCount}.`;
  }
  if (
    fulfillment.requestedBaseAmount === undefined
    || fulfillment.suppliedBaseAmount === undefined
    || fulfillment.baseUnit !== requestedTotal.baseUnit
  ) return "Fulfillment omitted independently verifiable total-quantity metadata.";
  if (Math.abs(fulfillment.requestedBaseAmount - requestedTotal.baseAmount) > 0.02) {
    return `Fulfillment requested ${fulfillment.requestedBaseAmount} ${fulfillment.baseUnit}; expected ${requestedTotal.baseAmount} ${requestedTotal.baseUnit}.`;
  }
  if (fulfillment.suppliedBaseAmount + 0.02 < requestedTotal.baseAmount) {
    return `Fulfillment undersupplied ${fulfillment.suppliedBaseAmount} ${fulfillment.baseUnit}.`;
  }
  if (!product.size || product.size.baseUnit !== requestedTotal.baseUnit) {
    return "Selected SKU size could not prove the requested total.";
  }
  const calculatedSupply = product.size.baseAmount * fulfillment.packageCount;
  if (Math.abs(calculatedSupply - fulfillment.suppliedBaseAmount) > 0.02) {
    return "Fulfillment arithmetic did not agree with the selected SKU size.";
  }
  const overageRatio = (fulfillment.suppliedBaseAmount - requestedTotal.baseAmount) / requestedTotal.baseAmount;
  if (overageRatio > requestedTotal.maxOverageRatio + 0.0001) {
    return `Fulfillment overage ${(overageRatio * 100).toFixed(1)}% exceeded the safe limit.`;
  }
  return undefined;
}

function exactStoreCandidate(product: KrogerProduct, locationId: string) {
  return product.priceProvenance.exactStoreVerified
    && product.priceProvenance.locationId === locationId
    && product.priceProvenance.priceReliability === "verified"
    && product.availabilityStatus !== "out_of_stock";
}

function resolveLiveRequest(testCase: ReturnType<typeof cartiva100LiveCases>[number]) {
  let raw = testCase.input;
  for (const step of testCase.clarificationPath) {
    const interpreted = interpretGroceryInput(raw);
    const item = interpreted.items[0];
    if (interpreted.items.length !== 1 || item?.clarification?.id !== step.id) {
      throw new Error(`Expected ${step.id}, received ${item?.clarification?.id ?? "none"}.`);
    }
    raw = resolveGroceryClarification(item.raw, step.id, step.select).raw;
  }
  const interpreted = interpretGroceryInput(raw);
  const item = interpreted.items[0];
  if (interpreted.items.length !== 1 || !item || item.status !== "ready") {
    throw new Error(`The live case did not resolve to one ready item.`);
  }
  return item.canonicalText;
}

export function selectedMetadata(
  result: KrogerMatchResult,
  expectedLocationId: string,
) {
  const product = result.recommended;
  const fulfillment = result.fulfillment;
  if (!product || !fulfillment) return undefined;
  const checkedAt = product.priceProvenance.checkedAt ?? product.checkedAt;
  const sourceUrl = product.sourceUrl ?? product.link;
  if (
    product.priceProvenance.locationId !== expectedLocationId
    || !checkedAt
    || Number.isNaN(Date.parse(checkedAt))
    || !/^https:\/\//i.test(sourceUrl)
  ) return undefined;
  return {
    productId: product.productId,
    upc: product.upc,
    title: product.title,
    brand: product.brand,
    productType: product.productType,
    size: product.size,
    priceCents: product.priceCents ?? Math.round(product.price * 100),
    availabilityStatus: product.availabilityStatus,
    locationId: product.priceProvenance.locationId,
    checkedAt,
    sourceUrl,
    cartQuantity: fulfillment.cartQuantity,
    packageCount: fulfillment.packageCount,
  };
}

function blockedReport(reason: string, retailerCalls = 0): Cartiva100LiveReport {
  return {
    suiteId: "cartiva-100-kroger-live",
    status: "EXTERNAL_BLOCKED",
    checkedAt: new Date().toISOString(),
    retailerCalls,
    matched: 0,
    blocked: cartiva100LiveCases().length,
    failed: 0,
    cases: [],
    reason,
  };
}

export async function runCartiva100KrogerLive(): Promise<Cartiva100LiveReport> {
  if (process.env.CARTIVA100_LIVE_KROGER !== "1") {
    return blockedReport("Live Kroger validation is opt-in; set CARTIVA100_LIVE_KROGER=1.");
  }

  const localEnv = loadEnv("development", process.cwd(), "");
  process.env.KROGER_CLIENT_ID ??= localEnv.KROGER_CLIENT_ID;
  process.env.KROGER_CLIENT_SECRET ??= localEnv.KROGER_CLIENT_SECRET;
  process.env.KROGER_REDIRECT_URI ??= localEnv.KROGER_REDIRECT_URI;
  if (!process.env.KROGER_CLIENT_ID || !process.env.KROGER_CLIENT_SECRET || !process.env.KROGER_REDIRECT_URI) {
    return blockedReport("Kroger credentials are not configured in this environment.");
  }

  resetKrogerProviderForTests();
  let retailerCalls = 0;
  let lastRetailerCallStartedAt = 0;
  const pacedCall = async <T>(operation: () => Promise<T>) => {
    const waitFor = Math.max(0, 2_100 - (Date.now() - lastRetailerCallStartedAt));
    if (waitFor) await delay(waitFor);
    lastRetailerCallStartedAt = Date.now();
    return operation();
  };
  let location: Awaited<ReturnType<typeof getKrogerLocation>>;
  try {
    let locationId = process.env.CARTIVA100_KROGER_LOCATION_ID?.trim();
    if (!locationId) {
      const nearby = await pacedCall(() => findKrogerLocations(
        process.env.CARTIVA100_KROGER_ZIP?.trim() || "75201",
      ));
      if (nearby.diagnostics.apiCall) retailerCalls += 1;
      locationId = nearby.locations[0]?.locationId;
    }
    if (!locationId) {
      return blockedReport("Kroger returned no eligible store near the live-validation ZIP code.", retailerCalls);
    }
    location = await pacedCall(() => getKrogerLocation(locationId!));
    retailerCalls += 1;
  } catch (error) {
    return blockedReport(
      error instanceof Error ? error.message : "Kroger location verification failed.",
      retailerCalls,
    );
  }

  const results: Cartiva100LiveCaseResult[] = [];
  const liveCases = cartiva100LiveCases();
  let stoppedForRateLimit: string | undefined;
  for (const testCase of liveCases) {
    let resolvedRequest: string;
    try {
      resolvedRequest = resolveLiveRequest(testCase);
    } catch (error) {
      results.push({
        id: testCase.id,
        input: testCase.input,
        status: "LIVE_FAILED",
        reason: error instanceof Error ? error.message : "Clarification resolution failed.",
        searchAttempts: [],
        returnedCandidateCount: 0,
      });
      continue;
    }

    const intent = parseProductIntent(resolvedRequest);
    let latest = rankKrogerProducts(resolvedRequest, [], [], undefined, { intent });
    try {
      const discovered = await retrieveCandidatesProgressively({
        intent,
        search: async (query) => {
          const response = await pacedCall(() => searchKrogerProducts(query, {
            locationId: location.locationId,
            locationVerified: true,
            locationName: location.name,
            chain: location.chain,
            fulfillmentMode: "pickup",
          }));
          if (response.diagnostics.apiCall) retailerCalls += 1;
          return response.products;
        },
        hasVerifiedMatch: (products) => {
          latest = rankKrogerProducts(resolvedRequest, products, [], undefined, { intent });
          return isRetailerHandoffAcceptedMatch(latest);
        },
        isPlausible: (product) => isPlausibleDiscoveryCandidate(intent, product),
        candidateKey: (product) => product.id,
      });
      latest = rankKrogerProducts(resolvedRequest, discovered.candidates, [], undefined, { intent });
      const metadata = selectedMetadata(latest, location.locationId);
      if (!metadata) {
        let independentCandidates = discovered.candidates;
        const alreadyValid = independentCandidates.some((candidate) => {
          const fulfillment = packageFulfillmentForProduct(intent, candidate);
          return candidate.cartEligible
            && exactStoreCandidate(candidate, location.locationId)
            && !cartiva100LiveOracleFailure(testCase.id, candidate)
            && Boolean(fulfillment && !cartiva100LiveFulfillmentFailure(testCase, candidate, fulfillment));
        });
        if (!alreadyValid) {
          const oracleQuery = LIVE_ORACLES[testCase.id].requiredGroups.map((group) => group[0]).join(" ");
          if (!discovered.attempts.some((attempt) => normalizeOraclePhrase(attempt.query) === normalizeOraclePhrase(oracleQuery))) {
            const response = await pacedCall(() => searchKrogerProducts(oracleQuery, {
              locationId: location.locationId,
              locationVerified: true,
              locationName: location.name,
              chain: location.chain,
              fulfillmentMode: "pickup",
            }));
            if (response.diagnostics.apiCall) retailerCalls += 1;
            const seen = new Set(independentCandidates.map((candidate) => candidate.id));
            independentCandidates = [
              ...independentCandidates,
              ...response.products.filter((candidate) => !seen.has(candidate.id)),
            ];
            discovered.attempts.push({
              level: "broader",
              query: oracleQuery,
              returnedCount: response.products.length,
              pooledCount: independentCandidates.length,
              outcome: "exhausted",
            });
          }
        }
        const independentlyValid = independentCandidates.find((candidate) => {
          const fulfillment = packageFulfillmentForProduct(intent, candidate);
          return candidate.cartEligible
            && exactStoreCandidate(candidate, location.locationId)
            && !cartiva100LiveOracleFailure(testCase.id, candidate)
            && Boolean(fulfillment && !cartiva100LiveFulfillmentFailure(testCase, candidate, fulfillment));
        });
        results.push({
          id: testCase.id,
          input: testCase.input,
          resolvedRequest,
          status: independentlyValid ? "LIVE_FAILED" : "EXTERNAL_BLOCKED",
          reason: independentlyValid
            ? `Cartiva missed independently valid Kroger candidate ${independentlyValid.productId}.`
            : "Kroger returned no independently valid exact-store product for this request.",
          searchAttempts: discovered.attempts.map(({ level, query, returnedCount }) => ({
            level,
            query,
            resultCount: returnedCount,
          })),
          returnedCandidateCount: discovered.candidates.length,
        });
        continue;
      }
      const provenanceMatches = latest.recommended?.priceProvenance.exactStoreVerified
        && metadata.locationId === location.locationId;
      const independentFailure = cartiva100LiveOracleFailure(testCase.id, latest.recommended!);
      const fulfillmentIssue = cartiva100LiveFulfillmentFailure(testCase, latest.recommended!, latest.fulfillment!);
      results.push({
        id: testCase.id,
        input: testCase.input,
        resolvedRequest,
        status: provenanceMatches && !fulfillmentIssue && !independentFailure ? "LIVE_PASSED" : "LIVE_FAILED",
        reason: independentFailure
          ?? (!provenanceMatches
          ? "The selected product did not preserve exact-store provenance."
          : fulfillmentIssue
            ? fulfillmentIssue
            : "Matched with exact-store Kroger metadata and safe fulfillment."),
        searchAttempts: discovered.attempts.map(({ level, query, returnedCount }) => ({
          level,
          query,
          resultCount: returnedCount,
        })),
        returnedCandidateCount: discovered.candidates.length,
        selectedProduct: metadata,
      });
    } catch (error) {
      const externallyBlocked = error instanceof KrogerProviderError || error instanceof KrogerAuthError;
      results.push({
        id: testCase.id,
        input: testCase.input,
        resolvedRequest,
        status: externallyBlocked ? "EXTERNAL_BLOCKED" : "LIVE_FAILED",
        reason: error instanceof Error ? error.message : "Kroger product search failed.",
        searchAttempts: [],
        returnedCandidateCount: 0,
      });
      if (externallyBlocked && error.code === "rate_limit") {
        stoppedForRateLimit = error.message;
        break;
      }
    }
  }

  if (stoppedForRateLimit && results.length < liveCases.length) {
    for (const testCase of liveCases.slice(results.length)) {
      results.push({
        id: testCase.id,
        input: testCase.input,
        status: "EXTERNAL_BLOCKED",
        reason: `Not attempted after Kroger rate limiting: ${stoppedForRateLimit}`,
        searchAttempts: [],
        returnedCandidateCount: 0,
      });
    }
  }

  const failed = results.filter((result) => result.status === "LIVE_FAILED").length;
  const blocked = results.filter((result) => result.status === "EXTERNAL_BLOCKED").length;
  const matched = results.filter((result) => result.status === "LIVE_PASSED").length;
  return {
    suiteId: "cartiva-100-kroger-live",
    status: failed ? "LIVE_FAILED" : blocked ? "EXTERNAL_BLOCKED" : "LIVE_PASSED",
    checkedAt: new Date().toISOString(),
    location: {
      locationId: location.locationId,
      name: location.name,
      chain: location.chain,
      zipCode: location.address.zipCode,
    },
    retailerCalls,
    matched,
    blocked,
    failed,
    cases: results,
  };
}

export function formatCartiva100LiveReport(report: Cartiva100LiveReport) {
  const lines = [
    "",
    "CARTIVA 100 · LIVE KROGER SUBSET",
    `STATUS: ${report.status}`,
    `MATCHED: ${report.matched} · EXTERNAL BLOCKED: ${report.blocked} · FAILED: ${report.failed}`,
    `RETAILER CALLS: ${report.retailerCalls}`,
  ];
  if (report.location) {
    lines.push(`STORE: ${report.location.name} (${report.location.locationId}, ${report.location.zipCode})`);
  }
  if (report.reason) lines.push(`REASON: ${report.reason}`);
  for (const result of report.cases) {
    lines.push(`${result.id} ${result.status}: ${result.selectedProduct?.title ?? result.reason}`);
  }
  return lines.join("\n");
}
