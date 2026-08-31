import { AlertCircle, Check, ChevronRight, CircleDashed, ExternalLink, PackageCheck, RefreshCw, Store } from "lucide-react";
import type { GroceryNotepadItem } from "@/lib/grocery-notepad";
import type { CartState, CartivaLocation, ComparisonState } from "@/components/cartiva-workspace-types";
import styles from "@/components/cartiva-workspace.module.css";

interface CartivaComparisonProps {
  items: GroceryNotepadItem[];
  quantities: Record<string, number>;
  comparison: ComparisonState;
  selectedLocation?: CartivaLocation;
  fulfillmentMode: "pickup" | "delivery";
  cart: CartState;
  onChangeStore: () => void;
  onRetry: () => void;
  onAddToKroger: () => void;
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function itemPrice(price: number, quantity: number) {
  return money.format(price * quantity);
}

function checkedTime(value?: string) {
  if (!value) return "Waiting for a comparison";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Updated just now"
    : `Updated ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function CartivaComparison({
  items,
  quantities,
  comparison,
  selectedLocation,
  fulfillmentMode,
  cart,
  onChangeStore,
  onRetry,
  onAddToKroger,
}: CartivaComparisonProps) {
  const matchedCount = comparison.results.filter((result) => result?.status === "matched" && result.recommended).length;
  const complete = items.length > 0 && matchedCount === items.length && comparison.phase === "complete";
  const cartReady = complete && comparison.results.every((result) => result?.recommended?.cartEligible && result.recommended.upc);
  const subtotal = comparison.results.reduce((sum, result, index) => {
    const product = result?.status === "matched" ? result.recommended : null;
    return sum + (product?.price ?? 0) * (quantities[items[index]?.id] ?? 1);
  }, 0);
  const hasResults = comparison.results.some(Boolean);
  const busy = comparison.phase === "searching" || comparison.phase === "finding-store";
  const transferring = cart.phase === "connecting" || cart.phase === "adding";

  return (
    <section className={styles.comparisonColumn} id="compare" aria-labelledby="comparison-heading">
      <div className={styles.comparisonHeading}>
        <h2 id="comparison-heading">Complete basket comparison</h2>
        <p>{checkedTime(comparison.checkedAt)} · official retailer data where available</p>
      </div>

      <div className={styles.retailerGrid} aria-label="Retailer totals">
        <article className={`${styles.retailerCard} ${styles.retailerCardSelected}`}>
          <div className={styles.retailerTopline}>
            <span className={`${styles.retailerInitial} ${styles.krogerInitial}`}>K</span>
            <span><strong>Kroger</strong><small>{selectedLocation?.name ?? "Nearby store"}</small></span>
            <em>Selected</em>
          </div>
          <strong className={styles.retailerPrice}>{complete ? money.format(subtotal) : "—"}</strong>
          <p className={complete ? styles.completeText : styles.mutedStatus}>
            {busy ? <><RefreshCw className={styles.spin} aria-hidden="true" /> {comparison.completedItems} / {items.length} checked</>
              : complete ? <><Check aria-hidden="true" /> {matchedCount} / {items.length} matched</>
                : items.length ? `${matchedCount} / ${items.length} matched` : "Add a list to begin"}
          </p>
        </article>

        <article className={styles.retailerCard} data-unavailable="true">
          <div className={styles.retailerTopline}>
            <span className={`${styles.retailerInitial} ${styles.walmartInitial}`}>W</span>
            <span><strong>Walmart</strong><small>Not connected</small></span>
          </div>
          <strong className={styles.retailerPrice}>—</strong>
          <p className={styles.mutedStatus}>No live total in this workspace</p>
        </article>

        <article className={styles.retailerCard} data-unavailable="true">
          <div className={styles.retailerTopline}>
            <span className={`${styles.retailerInitial} ${styles.targetInitial}`}>T</span>
            <span><strong>Target</strong><small>Not connected</small></span>
          </div>
          <strong className={styles.retailerPrice}>—</strong>
          <p className={styles.mutedStatus}>No live total in this workspace</p>
        </article>
      </div>

      <div className={styles.evidenceBar} role="status" aria-live="polite">
        <span className={complete ? styles.evidenceIconComplete : styles.evidenceIcon}>
          {complete ? <Check aria-hidden="true" /> : busy ? <RefreshCw className={styles.spin} aria-hidden="true" /> : <CircleDashed aria-hidden="true" />}
        </span>
        <span>
          <strong>{complete ? "Complete basket" : busy ? "Checking the full basket" : comparison.phase === "error" ? "Comparison needs attention" : "Totals require a complete basket"}</strong>
          <small>{complete ? `All ${items.length} requested items matched.` : comparison.message ?? "Cartiva shows a total only after every requested item has a trustworthy match."}</small>
        </span>
        {comparison.phase === "error" ? <button type="button" onClick={onRetry}>Try again</button> : null}
      </div>

      <article className={styles.basketCard} aria-labelledby="basket-heading">
        <div className={styles.basketHeader}>
          <div>
            <h2 id="basket-heading">Kroger basket</h2>
            <p>{selectedLocation ? `${selectedLocation.chain} · ${selectedLocation.address.addressLine1} · ${fulfillmentMode} eligible` : "Choose a nearby Kroger-family store to build this basket."}</p>
          </div>
          <button type="button" className={styles.changeStoreButton} onClick={onChangeStore}><Store aria-hidden="true" /> Change store</button>
        </div>

        <div className={styles.basketItems}>
          {items.length === 0 ? (
            <div className={styles.emptyBasket}>
              <span><PackageCheck aria-hidden="true" /></span>
              <h3>Your matched basket will appear here</h3>
              <p>Add groceries, choose a ZIP, and compare to see verified Kroger products and prices.</p>
            </div>
          ) : items.map((item, index) => {
            const result = comparison.results[index];
            const product = result?.recommended;
            const quantity = quantities[item.id] ?? 1;
            const status = result?.status;
            return (
              <div className={styles.basketItem} key={item.id}>
                <span
                  className={styles.productImage}
                  style={product?.thumbnail ? { backgroundImage: `url(${JSON.stringify(product.thumbnail).slice(1, -1)})` } : undefined}
                >
                  {!product?.thumbnail ? <PackageCheck aria-hidden="true" /> : null}
                </span>
                <div className={styles.basketItemCopy}>
                  <strong>{product?.title ?? item.name}</strong>
                  <span>
                    {product
                      ? `${product.size?.label ?? item.detail ?? "Package verified"} · ${quantity > 1 ? `quantity ${quantity} · ` : ""}${result?.confidence ?? "low"} confidence`
                      : busy ? "Searching Kroger for this request…" : status === "no_match" ? result?.explanation : item.detail ?? "Waiting to compare"}
                  </span>
                  {product ? <small>Requested: {item.canonicalText}</small> : null}
                </div>
                <div className={styles.basketItemPrice}>
                  <strong>{product ? itemPrice(product.price, quantity) : "—"}</strong>
                  <span data-tone={product?.cartEligible ? "success" : status === "no_match" ? "error" : "muted"}>
                    {product?.cartEligible ? "Available" : product ? "Review at Kroger" : status === "no_match" ? "No match" : "Pending"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className={styles.subtotalPanel}>
          <div className={styles.subtotalLine}>
            <span>Product subtotal</span>
            <strong>{complete ? money.format(subtotal) : "—"}</strong>
          </div>
          <p>Taxes, fees, substitutions, and final availability are confirmed at Kroger.</p>

          {cart.phase === "error" ? (
            <div className={styles.cartNotice} data-tone="error"><AlertCircle aria-hidden="true" /><span>{cart.message}</span></div>
          ) : null}
          {cart.phase === "success" ? (
            <div className={styles.cartNotice} data-tone="success"><Check aria-hidden="true" /><span>{cart.message}</span></div>
          ) : null}

          {cart.phase === "success" && cart.cartUrl ? (
            <a className={styles.primaryButton} href={cart.cartUrl} target="_blank" rel="noreferrer">
              Open Kroger cart <ExternalLink aria-hidden="true" />
            </a>
          ) : (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={onAddToKroger}
              disabled={!cartReady || transferring}
              aria-describedby="cart-requirement"
            >
              {cart.phase === "connecting" ? "Finish Kroger sign-in…" : cart.phase === "adding" ? "Adding verified items…" : `Add all ${items.length} ${items.length === 1 ? "item" : "items"} to Kroger`}
              {!transferring ? <ChevronRight aria-hidden="true" /> : <RefreshCw className={styles.spin} aria-hidden="true" />}
            </button>
          )}
          <p id="cart-requirement" className={styles.cartRequirement}>
            {cartReady ? "Uses the exact verified UPCs and quantities shown above." : hasResults ? "Every line must be matched and cart-eligible before handoff." : "Compare the basket before adding it to Kroger."}
          </p>
        </div>
      </article>

      <p className={styles.checkoutNote}>Cartiva compares and hands off. Checkout and payment always stay with the retailer.</p>
    </section>
  );
}
