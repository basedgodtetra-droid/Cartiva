import { interpretGroceryInput, type GroceryNotepadItem } from "@/lib/grocery-notepad";
import { parseRetailerPackageQuantity } from "@/packages/shared/src/comparison-session";

export const MAX_WORKSPACE_ITEMS = 50;

export function sanitizeWorkspaceQuantities(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, quantity]) => (
    key.length <= 100 && typeof quantity === "number" && Number.isSafeInteger(quantity)
    && quantity >= 1 && quantity <= 99
  )).slice(0, MAX_WORKSPACE_ITEMS));
}

/** Each occurrence keeps its own override even when a preceding row is removed. */
export function editWorkspaceItem(
  items: GroceryNotepadItem[], index: number, value: string | null, quantities: Record<string, number>,
) {
  const entries = items.flatMap((item, oldIndex) => oldIndex === index
    ? value?.trim() ? [{ raw: value.trim(), oldIndex }] : []
    : [{ raw: item.raw, oldIndex }]);
  const rawInput = entries.map((entry) => entry.raw).join("\n");
  const nextItems = interpretGroceryInput(rawInput).items;
  const nextQuantities: Record<string, number> = {};
  let nextIndex = 0;
  for (const entry of entries) {
    const count = interpretGroceryInput(entry.raw).items.length;
    const previous = items[entry.oldIndex];
    const next = nextItems[nextIndex];
    const override = quantities[previous.id];
    if (count === 1 && next && override !== undefined) {
      const explicitQuantityChanged = entry.oldIndex === index
        && parseRetailerPackageQuantity(previous.canonicalText).quantity !== parseRetailerPackageQuantity(next.canonicalText).quantity;
      if (!explicitQuantityChanged) nextQuantities[next.id] = override;
    }
    nextIndex += count;
  }
  return { rawInput, quantities: sanitizeWorkspaceQuantities(nextQuantities) };
}

export function writeBrowserStorage(storage: Pick<Storage, "setItem">, key: string, value: string) {
  try { storage.setItem(key, value); return true; } catch { return false; }
}
