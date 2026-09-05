"use client";

import { useState } from "react";
import type { ProductFeedback } from "@/lib/types";
import styles from "./cartiva-workspace.module.css";

/** Ephemeral receipts live only in the current comparison, not saved baskets. */
export function CartivaProductFeedback({ feedback, recommendedUpc, disabled, onChoose, onEdit }: {
  feedback: ProductFeedback; recommendedUpc?: string; disabled: boolean;
  onChoose(productId: string): void; onEdit(): void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "saved" | "error">("idle");
  async function send(upc: string, kind: "ACCEPTED" | "REJECTED" | "SUBSTITUTE", productId?: string) {
    if (disabled || state === "sending" || state === "saved") return;
    setState("sending");
    try {
      const response = await fetch("/api/knowledge/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipt: feedback.receipt, kind, upc }), signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error();
      setState("saved");
      if (productId) onChoose(productId);
      else if (kind === "REJECTED" || kind === "SUBSTITUTE") onEdit();
    } catch { setState("error"); }
  }
  const locked = disabled || state === "sending" || state === "saved";
  return (
    <div className={styles.productFeedback}>
      {recommendedUpc ? <div className={styles.feedbackActions}>
        {feedback.offers.some(p => p.upc === recommendedUpc && p.canChoose) ? <button type="button" disabled={locked} onClick={() => void send(recommendedUpc, "ACCEPTED")}>This matches</button> : null}
        <button type="button" disabled={locked} onClick={() => void send(recommendedUpc, "REJECTED")}>Not what I meant</button>
      </div> : null}
      {feedback.offers.some(p => p.upc !== recommendedUpc) ? <>
        <p>Other possibilities</p>
        <ul>{feedback.offers.filter(p => p.upc !== recommendedUpc).map(p => <li key={p.upc}>
          <span>{p.title}<small>{p.package}</small></span>
          <button type="button" disabled={locked} onClick={() => void send(p.upc, p.canChoose ? "ACCEPTED" : "SUBSTITUTE", p.canChoose ? p.productId : undefined)}>
            {p.canChoose ? "Choose & recheck" : "Choose substitute & edit"}
          </button>
        </li>)}</ul>
      </> : null}
      <span role="status">{state === "sending" ? "Saving feedback…" : state === "saved" ? "Feedback saved. Your choices help us review product matching." : state === "error" ? "Feedback wasn't saved. Your basket is unchanged; retry or edit your list." : "Alternatives are checked again before they enter your basket."}</span>
      {state === "error" ? <button type="button" onClick={onEdit}>Edit item</button> : null}
    </div>
  );
}
