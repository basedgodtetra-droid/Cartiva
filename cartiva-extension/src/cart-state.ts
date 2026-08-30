import type {
  CartBuildItem,
  CartBuildState,
  CartItemStatus,
  FulfillmentMode,
  WalmartPageContext,
} from "./types.js";

function now() {
  return new Date().toISOString();
}

export const STORE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export function freshStoreConfirmationId(
  confirmation: { storeId: string; confirmedAt: number; buildId?: string } | undefined,
  currentTime = Date.now(),
  expectedBuildId?: string,
) {
  if (!confirmation || !/^\d{1,8}$/.test(confirmation.storeId)) return undefined;
  if (expectedBuildId && confirmation.buildId !== expectedBuildId) return undefined;
  const age = currentTime - confirmation.confirmedAt;
  return age >= 0 && age <= STORE_CONFIRMATION_TTL_MS
    ? confirmation.storeId
    : undefined;
}

export function createCartBuild(
  items: Omit<CartBuildItem, "status">[],
  confirmed: boolean,
  context: {
    retailer?: "walmart" | "target";
    storeId?: string;
    storeName?: string;
    storeAddress?: string;
    zip?: string;
    fulfillmentMode?: FulfillmentMode;
  } = {},
): CartBuildState {
  const timestamp = now();
  return {
    version: 1,
    id: `build-${Date.now().toString(36)}`,
    status: items.length ? "idle" : "complete",
    confirmed,
    cursor: 0,
    items: items.map((item) => ({ ...item, status: "ready" })),
    updatedAt: timestamp,
    finishedAt: items.length ? undefined : timestamp,
    retailer: context.retailer ?? "walmart",
    storeId: context.storeId,
    storeName: context.storeName,
    storeAddress: context.storeAddress,
    zip: context.zip,
    fulfillmentMode: context.fulfillmentMode ?? "unknown",
  };
}

export function startCartBuild(state: CartBuildState): CartBuildState {
  if (!state.confirmed) throw new Error("Cart building requires the user's confirmation.");
  if (!state.items.length) return { ...state, status: "complete", finishedAt: now(), updatedAt: now() };
  return { ...state, status: "running", startedAt: state.startedAt ?? now(), updatedAt: now() };
}

export function markCurrentAdding(state: CartBuildState): CartBuildState {
  if (state.status !== "running") return state;
  const items = state.items.map((item, index) => index === state.cursor
    ? { ...item, status: "adding" as const, message: undefined }
    : item);
  return { ...state, items, updatedAt: now() };
}

export function resolveCurrentItem(
  state: CartBuildState,
  status: Exclude<CartItemStatus, "ready" | "adding">,
  message?: string,
  baselineCartCount?: number,
): CartBuildState {
  const items = state.items.map((item, index) => index === state.cursor
    ? { ...item, status, message, baselineCartCount }
    : item);
  if (status === "needs_choice") {
    return {
      ...state,
      items,
      status: "paused",
      pauseReason: message ?? "Complete the required choice on Walmart, then resume.",
      pauseKind: "item_choice",
      updatedAt: now(),
    };
  }
  const cursor = state.cursor + 1;
  const complete = cursor >= items.length;
  return {
    ...state,
    items,
    cursor,
    status: complete ? "complete" : "running",
    pauseReason: undefined,
    pauseKind: undefined,
    updatedAt: now(),
    finishedAt: complete ? now() : undefined,
  };
}

export function resumeAfterChoice(state: CartBuildState, added: boolean, message?: string) {
  if (state.status !== "paused") return state;
  const running = {
    ...state,
    status: "running" as const,
    pauseReason: undefined,
    pauseKind: undefined,
    updatedAt: now(),
  };
  return resolveCurrentItem(running, added ? "added" : "skipped", message);
}

export function retryCurrentAfterChoice(state: CartBuildState): CartBuildState {
  if (state.status !== "paused" || state.pauseKind !== "item_choice") return state;
  const current = state.items[state.cursor];
  if (!current || current.baselineCartCount === undefined || (current.choiceRetryCount ?? 0) >= 1) return state;
  const items = state.items.map((item, index) => index === state.cursor
    ? {
        ...item,
        status: "ready" as const,
        message: undefined,
        choiceRetryCount: (item.choiceRetryCount ?? 0) + 1,
      }
    : item);
  return {
    ...state,
    items,
    status: "running",
    pauseReason: undefined,
    pauseKind: undefined,
    updatedAt: now(),
  };
}

export function resumeAfterContextPause(state: CartBuildState): CartBuildState {
  if (state.status !== "paused" || state.pauseKind !== "context") return state;
  const items = state.items.map((item, index) => index === state.cursor
    ? { ...item, status: "ready" as const, message: undefined }
    : item);
  return {
    ...state,
    items,
    status: "running",
    pauseKind: undefined,
    pauseReason: undefined,
    updatedAt: now(),
  };
}

export function migrateLegacyStoreMismatchPause(state: CartBuildState): CartBuildState {
  if (state.status !== "paused" || state.pauseKind !== "context") return state;
  const currentMessage = state.items[state.cursor]?.message ?? "";
  const reason = `${state.pauseReason ?? ""} ${currentMessage}`.toLowerCase();
  const isLegacyStorePause = reason.includes("selected walmart store does not match")
    || reason.includes("verify walmart's exact store")
    || reason.includes("switch walmart automatically")
    || reason.includes("recover the pickup walmart");
  return isLegacyStorePause ? resumeAfterContextPause(state) : state;
}

export function cartProgress(state: CartBuildState) {
  const added = state.items.filter((item) => item.status === "added").length;
  const settled = state.items.filter((item) =>
    ["added", "failed", "unavailable", "skipped"].includes(item.status),
  ).length;
  return { added, settled, total: state.items.length };
}

export function blockingCartBuild(state: CartBuildState | null) {
  return state && (state.status === "running" || state.status === "paused")
    ? state
    : null;
}

export interface AutomaticCartBuildReadiness {
  preparationSucceeded: boolean;
  sequenceCurrent: boolean;
  preparing: boolean;
  eligibleItemCount: number;
  hasPreparedStore: boolean;
  buildStartPending: boolean;
  blockingBuild: boolean;
}

export interface AutomaticCartBuildDecision {
  lastHandledActionId: number;
  shouldStart: boolean;
}

/**
 * Claims one explicit list-submission action and decides whether that action
 * may start the guided Walmart cart. Claiming before returning keeps renders,
 * restored state, and later cart-status broadcasts from starting it again.
 */
export function claimAutomaticCartBuild(
  actionId: number,
  lastHandledActionId: number,
  readiness: AutomaticCartBuildReadiness,
): AutomaticCartBuildDecision {
  if (!Number.isInteger(actionId) || actionId <= 0 || actionId <= lastHandledActionId) {
    return { lastHandledActionId, shouldStart: false };
  }

  return {
    lastHandledActionId: actionId,
    shouldStart: readiness.preparationSucceeded
      && readiness.sequenceCurrent
      && !readiness.preparing
      && readiness.eligibleItemCount > 0
      && readiness.hasPreparedStore
      && !readiness.buildStartPending
      && !readiness.blockingBuild,
  };
}

export function cartContextIssue(
  state: CartBuildState,
  context: WalmartPageContext,
  recentlyConfirmedStoreId?: string,
) {
  void recentlyConfirmedStoreId;
  // Walmart does not expose its selected store consistently on every product
  // page. A missing or different store must not turn an otherwise addable item
  // into a manual choice. Cartiva uses Walmart's current store selection and
  // leaves the final price to checkout.
  if (context.fulfillmentMode === "unknown") {
    return "Choose pickup or delivery on Walmart before Cartiva adds anything.";
  }
  if (context.fulfillmentMode !== state.fulfillmentMode) {
    return `Walmart is set to ${context.fulfillmentMode}, but this basket was prepared for ${state.fulfillmentMode}.`;
  }
  if (!state.storeId) {
    return "Cartiva could not verify the Walmart store prepared for this basket.";
  }
  return undefined;
}

/**
 * Keep unfinished builds visible even after a newer list is prepared. The
 * background safety lock remains active until the shopper resumes or cancels,
 * so hiding these controls would leave the UI in an unrecoverable state.
 */
export function cartBuildForDisplay(
  state: CartBuildState | null,
  lastPreparedAt?: string,
) {
  if (!state) return null;
  const blocking = blockingCartBuild(state);
  if (blocking) return blocking;
  if (!lastPreparedAt || !state.startedAt) return state;

  const startedAt = Date.parse(state.startedAt);
  const preparedAt = Date.parse(lastPreparedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(preparedAt)) return state;
  return startedAt >= preparedAt ? state : null;
}

export function cartRecoveryAction(state: CartBuildState | null) {
  if (!state || state.status !== "running") return "none" as const;
  if (state.version !== 1 || state.confirmed !== true) return "cancel" as const;
  if (!Array.isArray(state.items) || !state.items.length || state.items.length > 24) return "cancel" as const;
  if (!Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor >= state.items.length) return "cancel" as const;
  const current = state.items[state.cursor];
  if (!current || current.status === "adding") return "pause" as const;
  return current.status === "ready" ? "resume" as const : "cancel" as const;
}
