"use client";

import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import { useCartivaLibrary } from "@/components/cartiva-library-provider";
import { money } from "@/lib/cartiva-library";
import styles from "@/components/cartiva-workspace.module.css";

function recency(value: string) {
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return "Recently";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function CartivaUtilityRail() {
  const { state, hydrated, persisted } = useCartivaLibrary();
  const historyGroups = new Map<string, typeof state.basketHistory>();
  for (const item of state.basketHistory) {
    const key = `${item.fingerprint}|${item.retailer}|${item.locationId}|${item.fulfillmentMode}`;
    historyGroups.set(key, [...(historyGroups.get(key) ?? []), item]);
  }
  const trend = [...historyGroups.values()]
    .map((group) => [...group].sort((a, b) => b.observedAt.localeCompare(a.observedAt)))
    .find((group) => group.length > 0);
  const delta = trend && trend.length > 1 ? trend[0].subtotalCents - trend[1].subtotalCents : undefined;

  return (
    <aside className={styles.utilityRail} aria-labelledby="your-cartiva-heading">
      <p className={styles.utilityEyebrow}>Your Cartiva</p>
      <h2 id="your-cartiva-heading">{persisted ? "Saved on this device" : "Your lists and history"}</h2>

      <section className={styles.utilitySection} aria-labelledby="utility-lists-heading">
        <div className={styles.utilitySectionHeading}><h3 id="utility-lists-heading">My lists</h3><Link href="/lists">View all <ArrowRight aria-hidden="true" /></Link></div>
        {!hydrated ? <p className={styles.utilityEmpty}>Loading your lists…</p> : state.lists.length ? state.lists.slice(0, 2).map((list) => (
          <Link className={styles.utilityRow} href={`/compare?list=${encodeURIComponent(list.id)}`} key={list.id}>
            <span><strong>{list.name}</strong><small>Updated {recency(list.updatedAt).toLowerCase()}</small></span>
            <em>{list.itemCount} {list.itemCount === 1 ? "item" : "items"}</em>
          </Link>
        )) : <p className={styles.utilityEmpty}>No saved lists yet.</p>}
      </section>

      <section className={styles.utilitySection} aria-labelledby="utility-baskets-heading">
        <div className={styles.utilitySectionHeading}><h3 id="utility-baskets-heading">Saved baskets</h3><Link href="/baskets">View all <ArrowRight aria-hidden="true" /></Link></div>
        {state.baskets.length ? state.baskets.slice(0, 2).map((basket) => (
          <Link className={styles.utilityRow} href="/baskets" key={basket.id}>
            <span><strong>{basket.retailerLabel}</strong><small>{basket.listName} · historical</small></span>
            <em>{money(basket.subtotalCents)}</em>
          </Link>
        )) : <p className={styles.utilityEmpty}>Save a complete basket to find it here.</p>}
      </section>

      <section className={styles.utilitySection} aria-labelledby="utility-history-heading">
        <div className={styles.utilitySectionHeading}><h3 id="utility-history-heading">Price history</h3><Link href="/history">View all <ArrowRight aria-hidden="true" /></Link></div>
        {trend ? (
          <Link className={styles.utilityRow} href="/history">
            <span><strong>{trend[0].listName}</strong><small>{trend.length} verified {trend.length === 1 ? "observation" : "observations"}</small></span>
            <em className={delta === undefined ? styles.trendNeutral : delta <= 0 ? styles.trendDown : styles.trendUp}>
              {delta === undefined ? <Minus aria-hidden="true" /> : delta <= 0 ? <ArrowDown aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
              {delta === undefined ? money(trend[0].subtotalCents) : money(Math.abs(delta))}
            </em>
          </Link>
        ) : <p className={styles.utilityEmpty}>No price history yet.</p>}
      </section>

      <section className={styles.utilitySection} aria-labelledby="utility-activity-heading">
        <div className={styles.utilitySectionHeading}><h3 id="utility-activity-heading">Recent activity</h3></div>
        {state.activities.length ? state.activities.slice(0, 3).map((activity) => (
          <Link className={styles.activityRow} href={activity.href} key={activity.id}>
            <strong>{activity.title}</strong>
            <span>{activity.detail}</span>
            <small>{recency(activity.occurredAt)}</small>
          </Link>
        )) : <p className={styles.utilityEmpty}>Your saved work and verified comparisons will appear here.</p>}
      </section>
    </aside>
  );
}
