import type { RankedProduct } from "./types";

export function calculateBasketTotalCents(
  products: Array<RankedProduct | null | undefined>,
  quantities: number[] = [],
) {
  return products.reduce((sum, product, index) => {
    const quantity = Math.max(1, Math.floor(quantities[index] ?? 1));
    const itemPriceCents = product
      ? product.priceCents ?? Math.round(product.price * 100)
      : 0;
    return sum + itemPriceCents * quantity;
  }, 0);
}

export function calculateBasketTotal(
  products: Array<RankedProduct | null | undefined>,
  quantities: number[] = [],
) {
  return calculateBasketTotalCents(products, quantities) / 100;
}
