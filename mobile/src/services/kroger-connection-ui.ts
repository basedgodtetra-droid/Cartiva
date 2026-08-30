export type KrogerConnectionUiState =
  | "checking"
  | "connected"
  | "not_connected"
  | "unavailable";

export function showKrogerDisconnectControl(state: KrogerConnectionUiState) {
  return state === "connected" || state === "unavailable";
}

export function krogerConnectionControl(state: KrogerConnectionUiState) {
  if (state === "connected") {
    return {
      title: "Kroger account connected",
      detail: "Disconnect before adding this basket if you want to sign in with a different Kroger account. Cartiva does not show or invent account identity.",
      resetLabel: "Disconnect / change account",
      resetAccessibilityLabel: "Disconnect Kroger account",
      canRetry: false,
      canResetSession: false,
    };
  }
  if (state === "unavailable") {
    return {
      title: "Kroger connection needs attention",
      detail: "Cartiva could not verify whether a Kroger connection is saved. Retry the check, or reset Cartiva’s saved Kroger connection and sign in again later. Resetting does not change the retailer cart.",
      resetLabel: "Reset saved Kroger connection",
      resetAccessibilityLabel: "Reset saved Kroger connection",
      canRetry: true,
      canResetSession: true,
    };
  }
  return null;
}

export function krogerConnectionAfterCartTransferPhase(
  current: KrogerConnectionUiState,
  phase: "CHECKING_AUTHORIZATION" | "AUTHORIZING" | "AUTHORIZATION_CONNECTED" | "CART_WRITE_STARTED" | "CART_OUTCOME_RECORDED",
) {
  return phase === "AUTHORIZATION_CONNECTED" ? "connected" : current;
}
