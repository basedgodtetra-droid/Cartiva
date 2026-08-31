import type { GroceryNotepadItem } from "./grocery-notepad";
import type { KrogerMatchResult } from "./types";

export const KROGER_PENDING_CART_STORAGE_KEY = "cartiva-kroger-pending-cart-v1";
export const KROGER_PENDING_CART_TTL_MS = 15 * 60_000;

export interface KrogerCartLine {
  upc: string;
  quantity: number;
}

export interface PendingKrogerCart {
  version: 1;
  operationId: string;
  locationId: string;
  fulfillmentMode: "pickup" | "delivery";
  items: KrogerCartLine[];
  itemCount: number;
  createdAt: number;
  comparisonId?: string;
  submittedAt?: number;
  blocked?: {
    code: "outcome_unknown";
    message: string;
    blockedAt: number;
  };
}

export interface KrogerCartReadiness {
  basketComplete: boolean;
  acceptedLineCount: number;
  cartEligibleLineCount: number;
  upcLineCount: number;
  totalLineCount: number;
  quantitiesValid: boolean;
  customerConnected?: boolean;
  cartCapability?: boolean;
  canAddToKroger: boolean;
  reason: string;
}

function sameCartLines(left: KrogerCartLine[], right: KrogerCartLine[]) {
  if (left.length !== right.length) return false;
  return left.every((line, index) => (
    line.upc === right[index]?.upc
    && line.quantity === right[index]?.quantity
  ));
}

function validUpc(value: unknown): value is string {
  return typeof value === "string" && /^\d{8,14}$/.test(value);
}

function validQuantity(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= 99;
}

function acceptedProduct(result: KrogerMatchResult | null | undefined) {
  return result?.status === "matched" && result.recommended
    ? result.recommended
    : undefined;
}

export function buildKrogerCartLines(
  items: GroceryNotepadItem[],
  results: Array<KrogerMatchResult | null>,
  quantities: Record<string, number>,
) {
  const aggregated = new Map<string, number>();
  results.forEach((result, index) => {
    const product = acceptedProduct(result);
    const quantity = quantities[items[index]?.id] ?? 1;
    if (!product?.cartEligible || !validUpc(product.upc) || !validQuantity(quantity)) return;
    aggregated.set(product.upc, (aggregated.get(product.upc) ?? 0) + quantity);
  });
  const lines = [...aggregated].map(([upc, quantity]) => ({ upc, quantity }));
  return lines.every((line) => validQuantity(line.quantity)) ? lines : [];
}

export function getKrogerCartReadiness({
  items,
  results,
  quantities,
  comparisonComplete,
  customerConnected,
  cartCapability,
}: {
  items: GroceryNotepadItem[];
  results: Array<KrogerMatchResult | null>;
  quantities: Record<string, number>;
  comparisonComplete: boolean;
  customerConnected?: boolean;
  cartCapability?: boolean;
}): KrogerCartReadiness {
  const totalLineCount = items.length;
  const acceptedLineCount = results.filter((result) => Boolean(acceptedProduct(result))).length;
  const cartEligibleLineCount = results.filter((result) => Boolean(acceptedProduct(result)?.cartEligible)).length;
  const upcLineCount = results.filter((result) => validUpc(acceptedProduct(result)?.upc)).length;
  const individualQuantitiesValid = items.every((item) => validQuantity(quantities[item.id] ?? 1));
  const aggregatedQuantities = new Map<string, number>();
  results.forEach((result, index) => {
    const product = acceptedProduct(result);
    const quantity = quantities[items[index]?.id] ?? 1;
    if (!product?.cartEligible || !validUpc(product.upc) || !validQuantity(quantity)) return;
    aggregatedQuantities.set(
      product.upc,
      (aggregatedQuantities.get(product.upc) ?? 0) + quantity,
    );
  });
  const quantitiesValid = individualQuantitiesValid
    && [...aggregatedQuantities.values()].every(validQuantity);
  const basketComplete = comparisonComplete
    && totalLineCount > 0
    && acceptedLineCount === totalLineCount;
  // Kroger connection is deliberately not a readiness prerequisite. A complete
  // basket starts OAuth when needed, then continues with this same payload.
  const canAddToKroger = basketComplete
    && cartEligibleLineCount === totalLineCount
    && upcLineCount === totalLineCount
    && quantitiesValid;

  let reason = "Ready to connect to Kroger and add the exact verified UPCs.";
  if (!totalLineCount) reason = "Add groceries before starting a Kroger handoff.";
  else if (!basketComplete) reason = "Complete the basket comparison before adding it to Kroger.";
  else if (upcLineCount !== totalLineCount) reason = "At least one accepted Kroger match is missing its cart UPC.";
  else if (!quantitiesValid) reason = "Every Kroger cart quantity must be a whole number from 1 to 99.";
  else if (cartEligibleLineCount !== totalLineCount) reason = "At least one accepted product is not eligible for this Kroger handoff.";

  return {
    basketComplete,
    acceptedLineCount,
    cartEligibleLineCount,
    upcLineCount,
    totalLineCount,
    quantitiesValid,
    customerConnected,
    cartCapability,
    canAddToKroger,
    reason,
  };
}

export function pendingKrogerCartMatches(
  pending: PendingKrogerCart,
  current: Pick<PendingKrogerCart, "locationId" | "fulfillmentMode" | "items" | "itemCount">,
) {
  return pending.locationId === current.locationId
    && pending.fulfillmentMode === current.fulfillmentMode
    && pending.itemCount === current.itemCount
    && sameCartLines(pending.items, current.items);
}

export function blockPendingKrogerCart(
  pending: PendingKrogerCart,
  message: string,
  blockedAt = Date.now(),
): PendingKrogerCart {
  return {
    ...pending,
    items: pending.items.map((item) => ({ ...item })),
    blocked: {
      code: "outcome_unknown",
      message: message.replace(/\s+/g, " ").trim().slice(0, 500)
        || "Check your retailer cart before starting another handoff.",
      blockedAt,
    },
  };
}

export function markPendingKrogerCartSubmitting(
  pending: PendingKrogerCart,
  submittedAt = Date.now(),
): PendingKrogerCart {
  return {
    ...pending,
    items: pending.items.map((item) => ({ ...item })),
    submittedAt,
    blocked: undefined,
  };
}

export function markPendingKrogerCartRetryable(pending: PendingKrogerCart): PendingKrogerCart {
  return {
    ...pending,
    items: pending.items.map((item) => ({ ...item })),
    submittedAt: undefined,
    blocked: undefined,
  };
}

export function createPendingKrogerCart({
  operationId,
  locationId,
  fulfillmentMode,
  items,
  itemCount,
  comparisonId,
  createdAt = Date.now(),
}: Omit<PendingKrogerCart, "version" | "createdAt"> & { createdAt?: number }): PendingKrogerCart {
  return {
    version: 1,
    operationId,
    locationId,
    fulfillmentMode,
    items: items.map((item) => ({ ...item })),
    itemCount,
    createdAt,
    comparisonId,
  };
}

export function parsePendingKrogerCart(
  serialized: string | null,
  now = Date.now(),
): PendingKrogerCart | null {
  if (!serialized || serialized.length > 12_000) return null;
  try {
    const value = JSON.parse(serialized) as Partial<PendingKrogerCart>;
    if (
      value.version !== 1
      || typeof value.operationId !== "string"
      || !/^[A-Za-z0-9_-]{16,128}$/.test(value.operationId)
      || typeof value.locationId !== "string"
      || !/^[A-Za-z0-9_-]{3,64}$/.test(value.locationId)
      || (value.fulfillmentMode !== "pickup" && value.fulfillmentMode !== "delivery")
      || !Array.isArray(value.items)
      || value.items.length < 1
      || value.items.length > 24
      || !Number.isInteger(value.itemCount)
      || (value.itemCount ?? 0) < 1
      || (value.itemCount ?? 0) > 24
      || typeof value.createdAt !== "number"
      || !Number.isFinite(value.createdAt)
      || value.createdAt > now + 30_000
      || (!value.blocked && value.submittedAt === undefined
        && value.createdAt + KROGER_PENDING_CART_TTL_MS < now)
      || (value.comparisonId !== undefined && (
        typeof value.comparisonId !== "string"
        || value.comparisonId.length > 160
      ))
      || (value.submittedAt !== undefined && (
        typeof value.submittedAt !== "number"
        || !Number.isFinite(value.submittedAt)
        || value.submittedAt < value.createdAt
        || value.submittedAt > now + 30_000
      ))
      || (value.blocked !== undefined && (
        !value.blocked
        || typeof value.blocked !== "object"
        || value.blocked.code !== "outcome_unknown"
        || typeof value.blocked.message !== "string"
        || !value.blocked.message.trim()
        || value.blocked.message.length > 500
        || typeof value.blocked.blockedAt !== "number"
        || !Number.isFinite(value.blocked.blockedAt)
        || value.blocked.blockedAt < value.createdAt
        || value.blocked.blockedAt > now + 30_000
      ))
    ) return null;

    const seen = new Set<string>();
    const lines: KrogerCartLine[] = [];
    for (const entry of value.items) {
      if (!entry || typeof entry !== "object") return null;
      const line = entry as Partial<KrogerCartLine>;
      if (!validUpc(line.upc) || !validQuantity(line.quantity) || seen.has(line.upc)) return null;
      seen.add(line.upc);
      lines.push({ upc: line.upc, quantity: line.quantity });
    }

    return {
      version: 1,
      operationId: value.operationId,
      locationId: value.locationId,
      fulfillmentMode: value.fulfillmentMode,
      items: lines,
      itemCount: value.itemCount as number,
      createdAt: value.createdAt,
      comparisonId: value.comparisonId,
      submittedAt: value.submittedAt,
      blocked: value.blocked ? {
        code: "outcome_unknown",
        message: value.blocked.message,
        blockedAt: value.blocked.blockedAt,
      } : undefined,
    };
  } catch {
    return null;
  }
}
