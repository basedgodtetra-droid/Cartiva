import type { PendingKrogerCart } from "@/lib/cartiva-kroger-cart";
import { isKrogerFamilyCartUrl } from "@/lib/kroger-family-links";

export interface CartivaKrogerReceipt {
  success?: boolean;
  operationId?: string;
  cartUrl?: string;
  addedCount?: number;
  itemCount?: number;
  message?: string;
  selectedSearchLocation?: { locationId?: string; name?: string };
  locationBoundByCartApi?: boolean;
}

export function verifiedKrogerCartReceipt(
  receipt: CartivaKrogerReceipt,
  pending: PendingKrogerCart,
) {
  const expectedQuantity = pending.items.reduce((sum, item) => sum + item.quantity, 0);
  if (
    receipt.success !== true
    || receipt.operationId !== pending.operationId
    || typeof receipt.cartUrl !== "string"
    || !isKrogerFamilyCartUrl(receipt.cartUrl)
    || receipt.itemCount !== pending.items.length
    || !Number.isInteger(receipt.addedCount)
    || receipt.addedCount !== expectedQuantity
    || receipt.selectedSearchLocation?.locationId !== pending.locationId
    || receipt.locationBoundByCartApi !== false
    || typeof receipt.message !== "string"
    || !receipt.message.trim()
  ) {
    return null;
  }
  return {
    cartUrl: receipt.cartUrl,
    message: receipt.message.trim(),
    itemCount: pending.itemCount,
    addedCount: receipt.addedCount,
  };
}
