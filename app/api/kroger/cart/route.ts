import { KrogerAuthError } from "@/lib/kroger-auth";
import {
  enforceRateLimit,
  hasOnlyKeys,
  isRecord,
  readValidatedJson,
} from "@/lib/api-security";
import { createHash } from "node:crypto";
import {
  KrogerCartOperationConflictError,
  KrogerCartOutcomeUnknownError,
  runKrogerCartOperation,
} from "@/lib/kroger-cart-operations";
import {
  addToKrogerCart,
  getKrogerLocation,
  krogerCartUrl,
  isValidKrogerLocationId,
  KrogerProviderError,
  krogerCartItemsWereVerified,
} from "@/lib/kroger-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CartRequest {
  operationId?: unknown;
  locationId?: unknown;
  fulfillmentMode?: unknown;
  items?: unknown;
}

function normalizedItems(value: unknown, modality: "PICKUP" | "DELIVERY") {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) return null;
  const seen = new Set<string>();
  const normalized = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["upc", "quantity"])) return null;
    const raw = entry;
    const upc = typeof raw.upc === "string" ? raw.upc.trim() : "";
    const quantity = raw.quantity;
    if (
      !/^\d{8,14}$/.test(upc)
      || typeof quantity !== "number"
      || !Number.isInteger(quantity)
      || quantity < 1
      || quantity > 99
    ) {
      return null;
    }
    if (seen.has(upc)) return null;
    seen.add(upc);
    normalized.push({ upc, quantity, modality });
  }
  return normalized;
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "kroger-cart", { limit: 12, windowMs: 60_000 });
  if (limited) return limited;
  const parsed = await readValidatedJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.value) || !hasOnlyKeys(
    parsed.value,
    ["operationId", "locationId", "fulfillmentMode", "items"],
  )) {
    return Response.json({ error: "The Kroger cart request contains unsupported fields." }, { status: 400 });
  }
  const body = parsed.value as CartRequest;
  const locationId = typeof body.locationId === "string" ? body.locationId.trim() : "";
  if (!isValidKrogerLocationId(locationId)) {
    return Response.json({ error: "Choose a valid Kroger-family store." }, { status: 400 });
  }
  const modality = body.fulfillmentMode === "pickup"
    ? "PICKUP" as const
    : body.fulfillmentMode === "delivery" ? "DELIVERY" as const : null;
  if (!modality) {
    return Response.json({ error: "Choose Kroger pickup or delivery." }, { status: 400 });
  }
  const operationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(operationId)) {
    return Response.json(
      { error: "Start a new Cartiva cart build before adding Kroger items." },
      { status: 400 },
    );
  }
  const items = normalizedItems(body.items, modality);
  if (!items) {
    return Response.json(
      { error: "Send 1 to 24 unique Kroger UPCs, each with a numeric quantity from 1 to 99." },
      { status: 400 },
    );
  }
  const fulfillmentMode = modality === "PICKUP" ? "pickup" as const : "delivery" as const;
  try {
    const requestFingerprint = createHash("sha256").update(JSON.stringify({
      locationId,
      fulfillmentMode,
      items,
    })).digest("base64url");
    const { receipt, replayed } = await runKrogerCartOperation(operationId, requestFingerprint, async () => {
      if (!krogerCartItemsWereVerified(locationId, fulfillmentMode, items)) {
        throw new KrogerProviderError(
          "Search Kroger again before adding these items; at least one match is no longer verified for the selected store.",
          "upstream",
          409,
        );
      }
      const location = await getKrogerLocation(locationId);
      // Kroger's public cart endpoint does not accept a location ID. The store is
      // used to preserve search provenance and choose the correct banner link;
      // the shopper must confirm their active checkout store at the retailer.
      try {
        await addToKrogerCart(items);
      } catch (error) {
        if (error instanceof KrogerProviderError && error.code === "outcome_unknown") {
          throw new KrogerCartOutcomeUnknownError();
        }
        if (error instanceof KrogerAuthError || error instanceof KrogerProviderError) throw error;
        throw new KrogerCartOutcomeUnknownError();
      }
      return {
        success: true as const,
        addedCount: items.reduce((sum, item) => sum + item.quantity, 0),
        itemCount: items.length,
        cartUrl: krogerCartUrl(location.chain),
        chain: location.chain,
        selectedSearchLocation: { locationId: location.locationId, name: location.name },
        locationBoundByCartApi: false as const,
        message: "Kroger accepted these items. Review the active store, availability, quantities, and final prices in your retailer cart before checkout.",
      };
    }, (error) => (
      error instanceof KrogerAuthError
      || (error instanceof KrogerProviderError && error.code !== "outcome_unknown")
    ));
    const { expiresAt: _expiresAt, requestFingerprint: _requestFingerprint, ...publicReceipt } = receipt;
    void _expiresAt;
    void _requestFingerprint;
    return Response.json({ ...publicReceipt, replayed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof KrogerAuthError
      ? error.status
      : error instanceof KrogerProviderError ? error.status : 502;
    const ambiguous = error instanceof KrogerCartOutcomeUnknownError;
    const conflict = error instanceof KrogerCartOperationConflictError;
    return Response.json(
      ambiguous
        ? {
            error: "Kroger's response was interrupted, so Cartiva cannot safely retry automatically. Check your retailer cart before trying again.",
            code: "outcome_unknown",
            retrySafe: false,
          }
        : { error: error instanceof Error ? error.message : "Kroger cart could not be updated.", retrySafe: true },
      { status: conflict ? 409 : status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
