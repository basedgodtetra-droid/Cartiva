"use client";

import { useEffect, useRef } from "react";
import { AlertCircle, Bookmark, Check, CircleDashed, ExternalLink, LockKeyhole, PackageCheck, RefreshCw, Store } from "lucide-react";
import type { GroceryNotepadItem } from "@/lib/grocery-notepad";
import type { CartState, CartivaLocation, ComparisonState } from "@/components/cartiva-workspace-types";
import {
  resolvedKrogerCartQuantity,
  type KrogerCartReadiness,
} from "@/lib/cartiva-kroger-cart";
import { getCartivaKrogerHandoffStage } from "@/lib/cartiva-kroger-handoff";
import type { CartivaKrogerConnectionState } from "@/lib/cartiva-kroger-connection";
import { krogerShoppingUrl } from "@/lib/kroger-family-links";
import { comparePlanBudget } from "@/lib/cartiva-planning";
import styles from "@/components/cartiva-workspace.module.css";

interface CartivaComparisonProps {
  items: GroceryNotepadItem[];
  quantities: Record<string, number>;
  comparison: ComparisonState;
  selectedLocation?: CartivaLocation;
  fulfillmentMode: "pickup" | "delivery";
  cart: CartState;
  cartReadiness: KrogerCartReadiness;
  basketSaved: boolean;
  connectionChecking: boolean;
  connectionState?: CartivaKrogerConnectionState;
  onChangeStore: () => void;
  onRetry: () => void;
  onReviewItem: (index: number) => void;
  onSaveBasket?: () => void;
  onAddToKroger: () => void;
  onContinueWithoutTransfer: () => void;
  onResolveCartReview: (itemsWereAdded: boolean) => void;
  plannedBudgetDollars?: number;
  plannedItemIds?: ReadonlySet<string>;
  onReviewPlan?: () => void;
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function itemPrice(price: number, quantity: number) {
  return money.format((Math.round(price * 100) * quantity) / 100);
}

function checkedTime(value?: string) {
  if (!value) return "Waiting for a comparison";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Updated just now"
    : `Updated ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function confidenceLabel(value?: "high" | "medium" | "low") {
  if (value === "high") return "Strong match";
  if (value === "medium") return "Close match — review";
  return "Review match carefully";
}

export function CartivaComparison({
  items,
  quantities,
  comparison,
  selectedLocation,
  fulfillmentMode,
  cart,
  cartReadiness,
  basketSaved,
  connectionChecking,
  connectionState,
  onChangeStore,
  onRetry,
  onReviewItem,
  onSaveBasket,
  onAddToKroger,
  onContinueWithoutTransfer,
  onResolveCartReview,
  plannedBudgetDollars,
  plannedItemIds,
  onReviewPlan,
}: CartivaComparisonProps) {
  const cartNoticeRef = useRef<HTMLDivElement | null>(null);
  const cartActionRef = useRef<HTMLButtonElement | null>(null);
  const previousCartPhaseRef = useRef(cart.phase);
  const matchedCount = comparison.results.filter((result) => (
    result?.status === "matched" && result.recommended
  )).length;
  const complete = cartReadiness.basketComplete;
  const cartReady = cartReadiness.canAddToKroger;
  const availabilityCheckCount = cartReadiness.availabilityUnconfirmedCount;
  const subtotalCents = comparison.results.reduce((sum, result, index) => {
    const product = result?.status === "matched" ? result.recommended : null;
    const quantity = resolvedKrogerCartQuantity(
      result,
      quantities[items[index]?.id] ?? 1,
    );
    return sum + (product && quantity !== undefined
      ? Math.round(product.price * 100) * quantity
      : 0);
  }, 0);
  const plannedSubtotalCents = plannedItemIds?.size
    ? comparison.results.reduce((sum, result, index) => {
        if (!plannedItemIds.has(items[index]?.id)) return sum;
        const product = result?.status === "matched" ? result.recommended : null;
        const quantity = resolvedKrogerCartQuantity(
          result,
          quantities[items[index]?.id] ?? 1,
        );
        return sum + (product && quantity !== undefined
          ? Math.round(product.price * 100) * quantity
          : 0);
      }, 0)
    : undefined;
  const hasResults = comparison.results.some(Boolean);
  const planBudget = complete && plannedSubtotalCents !== undefined
    ? comparePlanBudget(plannedBudgetDollars, plannedSubtotalCents)
    : undefined;
  const busy = comparison.phase === "searching" || comparison.phase === "finding-store";
  const canResumeOAuth = cart.code === "oauth_required";
  const transferring = (cart.phase === "authorizing" || cart.phase === "adding") && !canResumeOAuth;
  const handoffStage = getCartivaKrogerHandoffStage({
    basketComplete: complete,
    cartPhase: cart.phase,
    cartCode: cart.code,
  });
  const shoppingUrl = krogerShoppingUrl(selectedLocation?.chain);
  const oauthIssue = handoffStage === "oauth_cancelled" || handoffStage === "oauth_failed";
  const cartAddIssue = handoffStage === "cart_add_failed";
  const authExpired = handoffStage === "auth_expired" || connectionState === "expired";
  const authRequired = !authExpired && (
    handoffStage === "auth_required"
    || canResumeOAuth
    || connectionState === "required"
  );
  const handoffHeading = handoffStage === "transfer_success"
    ? "Your Kroger cart is ready"
    : handoffStage === "review_complete"
      ? "Cart review recorded"
      : authExpired
        ? "Your Kroger connection expired"
      : oauthIssue
        ? "Your Cartiva basket is still ready"
        : authRequired
          ? "Connect to Kroger to add your items"
        : cartAddIssue && cartReadiness.customerConnected
          ? "Kroger is connected, but we couldn't add the basket yet"
          : handoffStage === "outcome_unknown"
            ? "Review your Kroger cart before trying again"
            : "Your Cartiva basket is ready";
  const handoffDetail = handoffStage === "transfer_success"
    ? `${cart.message ?? `${cart.itemCount ?? items.length} items were added to Kroger.`} Review availability and checkout with Kroger.`
    : handoffStage === "review_complete"
      ? cart.message ?? "Cartiva will not send this basket again."
      : handoffStage === "adding"
        ? `Adding ${items.length} ${items.length === 1 ? "item" : "items"} to Kroger…`
        : handoffStage === "authorizing"
          ? cart.message ?? "Finish signing in with Kroger. Cartiva will continue automatically."
          : authExpired
            ? cart.message ?? "Reconnect securely and Cartiva will resume this exact basket automatically."
            : authRequired
              ? cart.message ?? "Your matched products, quantities, comparison store, and fulfillment choice are preserved."
          : oauthIssue || cartAddIssue || handoffStage === "outcome_unknown"
            ? cart.message ?? "Your matched products, quantities, store, and subtotal are preserved."
            : "Review every matched product before you decide whether to transfer it.";
  const transferButtonLabel = cart.phase === "authorizing"
      ? "Finish Kroger sign-in…"
      : cart.phase === "adding"
        ? `Adding ${items.length} ${items.length === 1 ? "item" : "items"} to Kroger…`
        : connectionChecking
          ? "Checking Kroger connection…"
          : cart.retrySafe === false
            ? "Review your Kroger cart first"
            : authExpired
              ? "Reconnect Kroger"
              : authRequired || oauthIssue
                ? "Connect Kroger"
              : cartAddIssue
                ? "Try adding again"
                : "Add basket to Kroger";
  const transferRequirement = handoffStage === "review_complete"
    ? "Cartiva recorded your review and will not resend this basket."
    : handoffStage === "transfer_success"
      ? "Kroger accepted the verified UPCs and quantities. Kroger controls any website sign-in and final cart review."
    : cart.retrySafe === false
      ? "Cartiva will not send a second request until you review the retailer cart."
      : authExpired
        ? "Your exact basket is preserved. Reconnect through Kroger's official flow and Cartiva will continue automatically."
        : authRequired || canResumeOAuth
          ? "Your exact basket is preserved. Connect through Kroger's official flow and Cartiva will continue automatically."
        : cart.phase === "authorizing"
          ? cart.message ?? "You'll sign in with Kroger before anything is added."
          : cart.phase === "adding"
            ? "Kroger is connected. Cartiva is sending the exact verified UPCs and quantities shown above."
            : connectionChecking
              ? "Cartiva is checking the saved Kroger API connection."
              : cartReady && cartReadiness.customerConnected
                ? "The Kroger API connection is active. Cartiva will add the exact verified UPCs and quantities shown above."
                : cartReady
                  ? "Connect to Kroger only if you want Cartiva to add these matched products to your Kroger cart."
                  : hasResults ? cartReadiness.reason : "Compare the basket before adding it to Kroger.";
  const actionableIndexes = comparison.results.flatMap((result, index) => (
    result && result.status !== "matched" ? [index] : []
  ));

  useEffect(() => {
    const phaseChanged = previousCartPhaseRef.current !== cart.phase;
    previousCartPhaseRef.current = cart.phase;
    if (phaseChanged && (cart.phase === "error" || cart.phase === "success" || cart.phase === "reviewed")) {
      cartNoticeRef.current?.focus();
    }
  }, [cart.phase]);

  return (
    <section className={styles.comparisonColumn} id="compare" aria-labelledby="comparison-heading">
      {complete ? (
        <div
          ref={cartNoticeRef}
          className={styles.basketReadyHero}
          data-stage={handoffStage}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          tabIndex={-1}
        >
          <div className={styles.basketReadyTitle}>
            <span className={styles.basketReadyIcon}>
              {handoffStage === "authorizing" || handoffStage === "adding"
                ? <RefreshCw className={styles.spin} aria-hidden="true" />
                : handoffStage === "transfer_success" || handoffStage === "review_complete"
                  ? <Check aria-hidden="true" />
                  : authRequired || authExpired
                    ? <LockKeyhole aria-hidden="true" />
                    : cart.phase === "error"
                      ? <AlertCircle aria-hidden="true" />
                      : <Check aria-hidden="true" />}
            </span>
            <div>
              <p>{handoffStage === "transfer_success" ? "Transfer complete" : "Cartiva basket"}</p>
              <h2 id="comparison-heading">{handoffHeading}</h2>
              <span>{handoffDetail}</span>
            </div>
          </div>
          <div className={styles.basketReadySummary}>
            <div className={styles.basketReadyRetailer}>
              <span className={`${styles.retailerInitial} ${styles.krogerInitial}`}>K</span>
              <span>
                <strong>Kroger</strong>
                <small>{selectedLocation?.name ? `${selectedLocation.name}${handoffStage === "transfer_success" ? " · comparison store" : ""}` : "Nearby store"}</small>
              </span>
            </div>
            <div><strong>{matchedCount} of {items.length}</strong><span>items matched</span></div>
            <div><strong>{money.format(subtotalCents / 100)}</strong><span>product subtotal</span></div>
          </div>
          <p className={styles.basketReadyStore}>
            <Store aria-hidden="true" />
            {selectedLocation
              ? handoffStage === "transfer_success"
                ? `Compared at ${selectedLocation.chain} · ${selectedLocation.address.addressLine1} · confirm Kroger's active store before checkout`
                : `${selectedLocation.chain} · ${selectedLocation.address.addressLine1} · ${fulfillmentMode} selected`
              : "Nearby Kroger-family store"}
          </p>
        </div>
      ) : (
        <>
          <div className={styles.comparisonHeading}>
            <h2 id="comparison-heading">Kroger basket comparison</h2>
            <p>{checkedTime(comparison.checkedAt)} · official retailer data</p>
          </div>

          <div className={styles.retailerGrid} aria-label="Retailer totals">
            <article className={`${styles.retailerCard} ${styles.retailerCardSelected}`}>
              <div className={styles.retailerTopline}>
                <span className={`${styles.retailerInitial} ${styles.krogerInitial}`}>K</span>
                <span><strong>Kroger</strong><small>{selectedLocation?.name ?? "Nearby store"}</small></span>
                <em>Live</em>
              </div>
              <strong className={styles.retailerPrice}>—</strong>
              <p className={styles.mutedStatus}>
                {busy ? <><RefreshCw className={styles.spin} aria-hidden="true" /> {comparison.completedItems} / {items.length} checked</>
                  : items.length ? `${matchedCount} / ${items.length} matched` : "Add a list to begin"}
              </p>
            </article>
            <article className={styles.retailerCard} data-unavailable="true">
              <div className={styles.retailerTopline}>
                <span className={`${styles.retailerInitial} ${styles.walmartInitial}`}>W</span>
                <span><strong>Walmart</strong><small>Not connected</small></span>
              </div>
              <strong className={styles.retailerPrice}>—</strong>
              <p className={styles.mutedStatus}>Coming later</p>
            </article>
            <article className={styles.retailerCard} data-unavailable="true">
              <div className={styles.retailerTopline}>
                <span className={`${styles.retailerInitial} ${styles.targetInitial}`}>T</span>
                <span><strong>Target</strong><small>Not connected</small></span>
              </div>
              <strong className={styles.retailerPrice}>—</strong>
              <p className={styles.mutedStatus}>Coming later</p>
            </article>
          </div>

          <div className={styles.evidenceBar} role="status" aria-live="polite" aria-atomic="true">
            <span className={styles.evidenceIcon}>
              {busy ? <RefreshCw className={styles.spin} aria-hidden="true" /> : <CircleDashed aria-hidden="true" />}
            </span>
            <span>
              <strong>{busy ? "Checking the full basket" : comparison.phase === "error" ? "Comparison needs attention" : "Totals require a complete basket"}</strong>
              <small>{comparison.message ?? "Cartiva shows a total only after every requested item has a trustworthy match."}</small>
            </span>
            {comparison.phase === "error" ? <button type="button" onClick={onRetry}>Try again</button> : null}
            {comparison.phase === "complete" && actionableIndexes.length ? (
              <button type="button" onClick={() => onReviewItem(actionableIndexes[0])}>
                Review {actionableIndexes.length} {actionableIndexes.length === 1 ? "item" : "items"}
              </button>
            ) : null}
          </div>
        </>
      )}

      {planBudget ? (
        <section className={styles.planBudgetReceipt} data-status={planBudget.status} aria-labelledby="plan-budget-heading">
          <div>
            <span>Plan budget check</span>
            <h2 id="plan-budget-heading">{planBudget.label}</h2>
            <p>
              Planned {money.format(planBudget.targetCents / 100)} · matched plan groceries {money.format(planBudget.actualCents / 100)}
            </p>
          </div>
          {planBudget.status === "over" && onReviewPlan ? (
            <button type="button" onClick={onReviewPlan}>Lower my basket</button>
          ) : (
            <small>Retailer prices are the source of truth. Taxes, fees, and substitutions are not included.</small>
          )}
        </section>
      ) : null}

      <article className={styles.basketCard} data-complete={complete} aria-labelledby="basket-heading">
        <div className={styles.basketHeader}>
          <div>
            <h2 id="basket-heading">{complete ? "Kroger basket receipt" : "Kroger basket"}</h2>
            <p>{selectedLocation ? `${selectedLocation.chain} · ${selectedLocation.address.addressLine1} · ${fulfillmentMode} selected` : "Choose a nearby Kroger-family store to build this basket."}</p>
          </div>
          <div className={styles.basketHeaderActions}>
            {complete && onSaveBasket ? (
              <button
                type="button"
                className={styles.saveBasketButton}
                data-saved={basketSaved}
                onClick={onSaveBasket}
                aria-label={basketSaved ? "Remove basket from saved baskets" : "Save this basket"}
                aria-pressed={basketSaved}
                title={basketSaved ? "Saved" : "Save basket"}
              >
                <Bookmark aria-hidden="true" fill={basketSaved ? "currentColor" : "none"} />
                <span className={styles.srOnly}>{basketSaved ? "Saved" : "Save basket"}</span>
              </button>
            ) : null}
            <button type="button" className={styles.changeStoreButton} onClick={onChangeStore} disabled={transferring || cart.retrySafe === false}><Store aria-hidden="true" /> Change store</button>
          </div>
        </div>

        <div
          className={styles.basketItems}
          id="basket-products"
          role="region"
          aria-label="Kroger matched basket"
          tabIndex={items.length ? 0 : -1}
        >
          {items.length === 0 ? (
            <div className={styles.emptyBasket}>
              <span><PackageCheck aria-hidden="true" /></span>
              <h3>Your matched basket will appear here</h3>
              <p>Add groceries, choose a ZIP, and compare to see verified Kroger products and prices.</p>
            </div>
          ) : items.map((item, index) => {
            const result = comparison.results[index];
            const product = result?.recommended;
            const quantity = resolvedKrogerCartQuantity(
              result,
              quantities[item.id] ?? 1,
            );
            const status = result?.status;
            const reviewRequired = status === "review";
            const explicitlyUnavailable = product?.availabilityStatus === "out_of_stock";
            const needsAvailabilityCheck = result?.resolution === "matched_check_availability"
              || product?.availabilityStatus === "unknown"
              || product?.availabilityStatus === "likely_available";
            const fulfillmentLabel = result?.fulfillment?.label
              ?? `${product?.size?.label ?? item.detail ?? "Package verified"}${quantity !== undefined ? ` · Qty ${quantity}` : " · Quantity needs review"}`;
            const transferStatus = cart.phase === "success"
              ? "Accepted by Kroger"
              : handoffStage === "outcome_unknown"
                ? "Confirmation needed"
                : cart.phase === "error"
                  ? "Not transferred"
                  : cart.phase === "adding"
                    ? "Sending to Kroger…"
                    : undefined;
            return (
              <div
                className={styles.basketItem}
                key={item.id}
                data-state={reviewRequired ? "review" : product ? "matched" : status === "no_match" ? "unmatched" : "pending"}
              >
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
                      ? reviewRequired
                        ? `${fulfillmentLabel} · ${result?.explanation ?? "Choose or edit this package before continuing."}`
                        : fulfillmentLabel
                      : busy ? "Searching Kroger for this request…" : status === "no_match" ? result?.explanation : item.detail ?? "Waiting to compare"}
                  </span>
                  {product ? (
                    <details className={styles.matchDetails}>
                      <summary>Match details</summary>
                      <p>Requested: {item.canonicalText}</p>
                      <p>{confidenceLabel(result?.confidence)} · Official Kroger data for this store.</p>
                    </details>
                  ) : null}
                </div>
                <div className={styles.basketItemPrice}>
                  <strong>{product && quantity !== undefined ? itemPrice(product.price, quantity) : "—"}</strong>
                  <span data-tone={transferStatus === "Accepted by Kroger" ? "success" : transferStatus ? "error" : explicitlyUnavailable ? "error" : reviewRequired ? "muted" : needsAvailabilityCheck ? "muted" : product?.cartEligible ? "success" : status === "no_match" && !product ? "error" : "muted"}>
                    {transferStatus ?? (explicitlyUnavailable
                      ? "Out of stock"
                      : needsAvailabilityCheck
                      ? reviewRequired ? "Needs your choice" : "Check availability"
                      : reviewRequired
                        ? "Needs your choice"
                      : product?.cartEligible
                        ? "Available"
                        : product ? "Review at Kroger" : status === "no_match" ? "No suitable product found" : "Pending")}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className={styles.subtotalPanel}>
          <div className={styles.subtotalLine}>
            <span>Product subtotal</span>
            <strong>{complete ? money.format(subtotalCents / 100) : "—"}</strong>
          </div>
          {complete && availabilityCheckCount > 0 ? (
            <div className={styles.availabilitySummary} role="status">
              <AlertCircle aria-hidden="true" />
              <span>
                <strong>{availabilityCheckCount} {availabilityCheckCount === 1 ? "item needs" : "items need"} availability confirmation at Kroger.</strong>
                <small>Kroger will confirm final availability when you review your cart.</small>
              </span>
            </div>
          ) : null}
          <p>Taxes, fees, substitutions, availability, and payment are finalized by Kroger.</p>

          {cart.phase === "error" ? (
            <div
              className={styles.cartNotice}
              data-tone={oauthIssue || authRequired || authExpired ? "warning" : "error"}
            >
              <AlertCircle aria-hidden="true" />
              <div className={styles.cartNoticeCopy}>
                <strong>
                  {handoffStage === "outcome_unknown"
                    ? "Cartiva couldn't confirm what Kroger received."
                    : authExpired
                      ? "Your Kroger connection expired."
                      : authRequired
                        ? "Connect to Kroger to add your items."
                    : oauthIssue
                      ? "Your Cartiva basket is still ready."
                      : cartReadiness.customerConnected
                        ? "Kroger is connected, but we couldn't add the basket yet."
                        : "We couldn't add the basket yet."}
                </strong>
                <span>{cart.message ?? "Your matched basket remains in Cartiva."}</span>
                {cart.retrySafe === false ? (
                  <div className={styles.cartNoticeActions}>
                    <button type="button" onClick={() => onResolveCartReview(true)}>Items are in Kroger</button>
                    <button
                      type="button"
                      onClick={() => {
                        onResolveCartReview(false);
                        window.requestAnimationFrame(() => cartActionRef.current?.focus());
                      }}
                    >
                      Items were not added
                    </button>
                  </div>
                ) : cart.retrySafe === true ? (
                  <div className={styles.cartNoticeActions}>
                    {cartAddIssue ? <a className={styles.reviewBasketLink} href="#basket-products">Review basket</a> : null}
                    <a className={styles.reviewBasketLink} href="#main-content">Back to Cartiva</a>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {cart.phase === "success" && cart.cartUrl ? (
            <div className={styles.handoffActions}>
              <a className={styles.primaryButton} href={cart.cartUrl} target="_blank" rel="noreferrer">
                Open Kroger cart <ExternalLink aria-hidden="true" />
              </a>
              <a className={styles.secondaryHandoffLink} href="#main-content">Back to Cartiva</a>
            </div>
          ) : cart.phase === "reviewed" && cart.cartUrl ? (
            <div className={styles.handoffActions}>
              <a className={styles.primaryButton} href={cart.cartUrl} target="_blank" rel="noreferrer">
                Open Kroger cart <ExternalLink aria-hidden="true" />
              </a>
              <a className={styles.secondaryHandoffLink} href="#main-content">Back to Cartiva</a>
            </div>
          ) : (
            <div className={styles.handoffActions}>
              <button
                ref={cartActionRef}
                type="button"
                className={styles.primaryButton}
                onClick={onAddToKroger}
                disabled={(!cartReady && !canResumeOAuth) || transferring || connectionChecking || cart.retrySafe === false}
                aria-describedby="cart-requirement"
              >
                {transferButtonLabel}
                {transferring || connectionChecking
                  ? <RefreshCw className={styles.spin} aria-hidden="true" />
                  : cartReadiness.customerConnected ? <PackageCheck aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
              </button>
              {complete && !transferring && cart.retrySafe !== false ? (
                <>
                  <a
                    className={styles.secondaryHandoffLink}
                    href={shoppingUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={onContinueWithoutTransfer}
                  >
                    Open Kroger without transfer <ExternalLink aria-hidden="true" />
                  </a>
                  <small className={styles.noTransferCopy}>Your Cartiva basket will not be transferred.</small>
                </>
              ) : null}
            </div>
          )}
          <p id="cart-requirement" className={styles.cartRequirement}>
            {transferRequirement}
          </p>
        </div>
      </article>

      <p className={styles.checkoutNote}>Cartiva never processes payment.</p>
    </section>
  );
}
