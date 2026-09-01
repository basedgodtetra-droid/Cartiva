export type CartivaKrogerHandoffStage =
  | "comparison"
  | "basket_ready"
  | "authorizing"
  | "adding"
  | "transfer_success"
  | "review_complete"
  | "oauth_cancelled"
  | "oauth_failed"
  | "cart_add_failed"
  | "outcome_unknown";

export type CartivaKrogerCartPhase = "idle" | "authorizing" | "adding" | "success" | "reviewed" | "error";

export type CartivaKrogerCartCode =
  | "oauth_required"
  | "oauth_cancelled"
  | "oauth_failed"
  | "cart_add_failed"
  | "outcome_unknown";

export function getCartivaKrogerHandoffStage({
  basketComplete,
  cartPhase,
  cartCode,
}: {
  basketComplete: boolean;
  cartPhase: CartivaKrogerCartPhase;
  cartCode?: CartivaKrogerCartCode;
}): CartivaKrogerHandoffStage {
  if (!basketComplete) return "comparison";
  if (cartPhase === "success") return "transfer_success";
  if (cartPhase === "reviewed") return "review_complete";
  if (cartPhase === "adding") return "adding";
  if (cartPhase === "authorizing") return "authorizing";
  if (cartPhase === "error") {
    if (cartCode === "oauth_cancelled") return "oauth_cancelled";
    if (cartCode === "oauth_failed" || cartCode === "oauth_required") return "oauth_failed";
    if (cartCode === "outcome_unknown") return "outcome_unknown";
    return "cart_add_failed";
  }
  return "basket_ready";
}
