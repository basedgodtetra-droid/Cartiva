import type { FulfillmentMode } from "./types.js";

export interface KrogerCartLine {
  upc: string;
  quantity: number;
}

export function canonicalKrogerCartItems(items: KrogerCartLine[]): KrogerCartLine[] {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const upc = item.upc.trim();
    if (!/^\d{8,14}$/.test(upc) || !Number.isInteger(item.quantity) || item.quantity < 1) continue;
    quantities.set(upc, (quantities.get(upc) ?? 0) + item.quantity);
  }
  return [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([upc, quantity]) => ({ upc, quantity }));
}

export async function krogerCartOperationId(
  locationId: string,
  fulfillmentMode: Exclude<FulfillmentMode, "unknown" | "shipping">,
  items: KrogerCartLine[],
): Promise<string> {
  const canonicalItems = canonicalKrogerCartItems(items);
  if (!locationId.trim() || !canonicalItems.length) throw new Error("Kroger cart identity needs a store and at least one official UPC.");
  const input = JSON.stringify({
    retailer: "kroger",
    locationId: locationId.trim(),
    fulfillmentMode,
    items: canonicalItems,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `kroger_${hex}`;
}
