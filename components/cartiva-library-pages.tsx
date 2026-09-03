"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Copy, Pencil, Plus, RefreshCw, ShoppingBasket, Trash2 } from "lucide-react";
import { CartivaLibraryShell } from "@/components/cartiva-library-shell";
import { useCartivaLibrary } from "@/components/cartiva-library-provider";
import {
  money,
  savedProductPackageLabel,
  type CartivaBasketObservation,
  type CartivaProductObservation,
  type CartivaSavedProduct,
} from "@/lib/cartiva-library";
import styles from "@/components/cartiva-workspace.module.css";

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Recently"
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className={styles.collectionEmpty}>
      <span><ShoppingBasket aria-hidden="true" /></span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function SavedBasketProductRow({ product }: { product: CartivaSavedProduct }) {
  return (
    <div>
      <span>
        <strong>{product.title}</strong>
        <small>{savedProductPackageLabel(product)} · UPC {product.upc} · {product.confidence} confidence</small>
      </span>
      <em>{money(product.lineTotalCents)}</em>
    </div>
  );
}

export function LibraryPage() {
  const { state, hydrated } = useCartivaLibrary();
  const lists = state.lists.slice(0, 4);
  const baskets = state.baskets.slice(0, 3);

  return (
    <CartivaLibraryShell title="Library" description="Reopen the lists you use again and revisit saved basket snapshots.">
      <div className={styles.libraryOverview}>
        <section aria-labelledby="library-lists-heading">
          <div className={styles.libraryOverviewHeading}>
            <div><h2 id="library-lists-heading">My lists</h2><p>Start another comparison from a list Cartiva already remembers.</p></div>
            <Link href="/lists">Manage lists</Link>
          </div>
          {!hydrated ? <p className={styles.loadingState}>Loading lists…</p> : lists.length ? (
            <div className={styles.libraryPreviewGrid}>
              {lists.map((list) => (
                <article className={styles.collectionCard} key={list.id}>
                  <div className={styles.collectionCardHeading}><div><h3>{list.name}</h3><p>{list.itemCount} {list.itemCount === 1 ? "item" : "items"} · Updated {dateTime(list.updatedAt)}</p></div></div>
                  <p className={styles.listPreview}>{list.rawInput ? list.rawInput.split("\n").slice(0, 3).join(" · ") : "Empty list — ready for groceries"}</p>
                  <div className={styles.collectionActions}><Link href={`/compare?list=${encodeURIComponent(list.id)}`} className={styles.collectionPrimary}>Open and compare</Link></div>
                </article>
              ))}
            </div>
          ) : <EmptyState title="No saved lists yet" body="Save a grocery list and it will be ready here for your next trip." action={<Link className={styles.collectionPrimary} href="/compare">Start a list</Link>} />}
        </section>

        <section aria-labelledby="library-baskets-heading">
          <div className={styles.libraryOverviewHeading}>
            <div><h2 id="library-baskets-heading">Saved baskets</h2><p>Historical snapshots stay clearly dated; check prices again for a current result.</p></div>
            <Link href="/baskets">View all baskets</Link>
          </div>
          {!hydrated ? <p className={styles.loadingState}>Loading baskets…</p> : baskets.length ? (
            <div className={styles.collectionStack}>
              {baskets.map((basket) => (
                <article className={styles.basketHistoryCard} key={basket.id}>
                  <div className={styles.historyCardTop}>
                    <div><span className={styles.historicalBadge}>Historical result</span><h2>{basket.retailerLabel} · {money(basket.subtotalCents)}</h2><p>{basket.listName} · Saved {dateTime(basket.savedAt)} · {basket.matchedCount}/{basket.itemCount} verified</p></div>
                    <div className={styles.historyActions}><Link href={`/compare?basket=${encodeURIComponent(basket.id)}`}><RefreshCw aria-hidden="true" /> Check prices again</Link></div>
                  </div>
                </article>
              ))}
            </div>
          ) : <EmptyState title="No saved baskets yet" body="Complete a comparison and save the basket when you want a historical snapshot." action={<Link className={styles.collectionPrimary} href="/compare">Compare a basket</Link>} />}
        </section>
      </div>
    </CartivaLibraryShell>
  );
}

export function ListsPage() {
  const router = useRouter();
  const { state, hydrated, saveList, renameList, duplicateList, deleteList } = useCartivaLibrary();
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string>();
  const [renameValue, setRenameValue] = useState("");

  const createList = () => {
    const id = saveList({
      name: newName,
      snapshot: { rawInput: "", quantities: {}, fulfillmentMode: "pickup", zipCode: "" },
      itemCount: 0,
    });
    setNewName("");
    router.push(`/compare?list=${encodeURIComponent(id)}`);
  };

  return (
    <CartivaLibraryShell title="My lists" description="Create, reopen, rename, duplicate, and edit grocery lists without signing up.">
      <section className={styles.createListPanel} aria-labelledby="create-list-heading">
        <div><h2 id="create-list-heading">Create a grocery list</h2><p>Name it now, then add products in the comparison workspace.</p></div>
        <form onSubmit={(event) => { event.preventDefault(); createList(); }}>
          <label htmlFor="new-list-name" className={styles.srOnly}>New list name</label>
          <input id="new-list-name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Meal prep, Party, Weekly groceries…" maxLength={80} />
          <button type="submit" disabled={!hydrated || !newName.trim()}><Plus aria-hidden="true" /> Create list</button>
        </form>
      </section>

      {!hydrated ? <p className={styles.loadingState}>Loading lists…</p> : state.lists.length ? (
        <div className={styles.collectionGrid}>
          {state.lists.map((list) => (
            <article className={styles.collectionCard} key={list.id}>
              <div className={styles.collectionCardHeading}>
                {renaming === list.id ? (
                  <form onSubmit={(event) => { event.preventDefault(); renameList(list.id, renameValue); setRenaming(undefined); }}>
                    <label htmlFor={`rename-${list.id}`} className={styles.srOnly}>Rename {list.name}</label>
                    <input id={`rename-${list.id}`} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus maxLength={80} />
                    <button type="submit">Save</button>
                  </form>
                ) : <div><h2>{list.name}</h2><p>{list.itemCount} {list.itemCount === 1 ? "item" : "items"} · Updated {dateTime(list.updatedAt)}</p></div>}
              </div>
              <p className={styles.listPreview}>{list.rawInput ? list.rawInput.split("\n").slice(0, 3).join(" · ") : "Empty list — ready for products"}</p>
              <div className={styles.collectionActions}>
                <Link href={`/compare?list=${encodeURIComponent(list.id)}`} className={styles.collectionPrimary}>Open and compare</Link>
                <button type="button" onClick={() => { setRenaming(list.id); setRenameValue(list.name); }}><Pencil aria-hidden="true" /> Rename</button>
                <button type="button" onClick={() => duplicateList(list.id)}><Copy aria-hidden="true" /> Duplicate</button>
                <button type="button" className={styles.dangerAction} onClick={() => { if (window.confirm(`Delete “${list.name}”? Historical baskets and price observations will remain.`)) deleteList(list.id); }}><Trash2 aria-hidden="true" /> Delete</button>
              </div>
            </article>
          ))}
        </div>
      ) : <EmptyState title="No saved lists yet" body="Create a list above, add your groceries, and it will remain available on this device." />}
    </CartivaLibraryShell>
  );
}

export function BasketsPage() {
  const { state, hydrated, deleteBasket } = useCartivaLibrary();
  return (
    <CartivaLibraryShell title="Saved baskets" description="Historical comparison snapshots. Prices shown here are not current quotes.">
      {!hydrated ? <p className={styles.loadingState}>Loading baskets…</p> : state.baskets.length ? (
        <div className={styles.collectionStack}>
          {state.baskets.map((basket) => (
            <article className={styles.basketHistoryCard} key={basket.id}>
              <div className={styles.historyCardTop}>
                <div><span className={styles.historicalBadge}>Historical result</span><h2>{basket.retailerLabel} · {money(basket.subtotalCents)}</h2><p>{basket.listName} · Saved {dateTime(basket.savedAt)}</p></div>
                <div className={styles.historyActions}>
                  <Link href={`/compare?basket=${encodeURIComponent(basket.id)}`}><RefreshCw aria-hidden="true" /> Check prices again</Link>
                  <button type="button" onClick={() => { if (window.confirm("Delete this saved basket? Price history will remain.")) deleteBasket(basket.id); }}><Trash2 aria-hidden="true" /> Delete</button>
                </div>
              </div>
              <dl className={styles.basketMetadata}>
                <div><dt>Store</dt><dd>{basket.locationName} · {basket.locationAddress}</dd></div>
                <div><dt>Compared</dt><dd>{dateTime(basket.observedAt)}</dd></div>
                <div><dt>Completeness</dt><dd>{basket.matchedCount} of {basket.itemCount} verified</dd></div>
                <div><dt>Source</dt><dd>{basket.provenanceLabel}</dd></div>
              </dl>
              <div className={styles.savedProductList}>
                {basket.products.map((product) => (
                  <SavedBasketProductRow key={`${basket.id}-${product.upc}`} product={product} />
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : <EmptyState title="No saved baskets yet" body="Complete a real comparison, then choose Save basket. Cartiva will label it as historical and preserve its store, products, source, and timestamp." action={<Link className={styles.collectionPrimary} href="/compare">Compare a basket</Link>} />}
    </CartivaLibraryShell>
  );
}

export function HistoryPage() {
  const { state, hydrated } = useCartivaLibrary();
  const basketGroups = useMemo(() => {
    const groups = new Map<string, CartivaBasketObservation[]>();
    state.basketHistory.forEach((item) => {
      const key = `${item.fingerprint}|${item.retailer}|${item.locationId}|${item.fulfillmentMode}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    });
    return [...groups.values()].map((group) => group.sort((a, b) => b.observedAt.localeCompare(a.observedAt)));
  }, [state.basketHistory]);
  const productGroups = useMemo(() => {
    const groups = new Map<string, CartivaProductObservation[]>();
    state.productHistory.forEach((item) => {
      const key = `${item.retailer}|${item.locationId}|${item.upc}|${item.packageKey}|${item.fulfillmentMode}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    });
    return [...groups.values()].map((group) => group.sort((a, b) => b.observedAt.localeCompare(a.observedAt)));
  }, [state.productHistory]);

  return (
    <CartivaLibraryShell title="Price history" description="Only time-stamped, verified exact-store observations appear here. Cartiva never invents chart points.">
      {!hydrated ? <p className={styles.loadingState}>Loading price history…</p> : !basketGroups.length && !productGroups.length ? (
        <EmptyState title="No price history yet." body="Compare a basket and Cartiva will start building your history." action={<Link className={styles.collectionPrimary} href="/compare">Start a comparison</Link>} />
      ) : (
        <div className={styles.historyLayout}>
          <section aria-labelledby="basket-history-heading"><div className={styles.sectionHeading}><h2 id="basket-history-heading">Basket history</h2><p>Only identical basket fingerprints at the same store are grouped together.</p></div>
            <div className={styles.collectionStack}>{basketGroups.map((group) => (
              <article className={styles.historySeries} key={`${group[0].fingerprint}-${group[0].locationId}`}>
                <div><h3>{group[0].listName}</h3><p>{group[0].locationName} · {group[0].itemCount} items · {group[0].fulfillmentMode}</p></div>
                <ol>{group.map((item) => <li key={item.id}><time dateTime={item.observedAt}>{dateTime(item.observedAt)}</time><strong>{money(item.subtotalCents)}</strong></li>)}</ol>
              </article>
            ))}</div>
          </section>
          <section aria-labelledby="product-history-heading"><div className={styles.sectionHeading}><h2 id="product-history-heading">Product history</h2><p>Package sizes and UPCs remain separate.</p></div>
            <div className={styles.collectionStack}>{productGroups.map((group) => (
              <article className={styles.historySeries} key={`${group[0].upc}-${group[0].locationId}-${group[0].packageKey}-${group[0].fulfillmentMode}`}>
                <div><h3>{group[0].title}</h3><p>{group[0].packageLabel} · {group[0].locationName} · {group[0].fulfillmentMode} · UPC {group[0].upc}</p></div>
                <ol>{group.map((item) => <li key={item.id}><time dateTime={item.observedAt}>{dateTime(item.observedAt)}</time><strong>{money(item.unitPriceCents)}</strong></li>)}</ol>
              </article>
            ))}</div>
          </section>
        </div>
      )}
    </CartivaLibraryShell>
  );
}
