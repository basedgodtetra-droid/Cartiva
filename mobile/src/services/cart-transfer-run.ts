import type {
  KrogerAuthorizationOutcome,
  KrogerAuthorizationStatus,
  KrogerCartAddOutcome,
  KrogerCartComparisonIdentity,
} from "./kroger-handoff-api";

export type CartTransferRunPhase =
  | "CHECKING_AUTHORIZATION"
  | "AUTHORIZING"
  | "AUTHORIZATION_CONNECTED"
  | "CART_WRITE_STARTED"
  | "CART_OUTCOME_RECORDED";

export type CartWriteSafetyState =
  | "IDLE"
  | "PREPARING"
  | "CART_WRITE_STARTED"
  | "OUTCOME_RECORDED";

type UnsuccessfulAuthorization = Exclude<
  KrogerAuthorizationOutcome,
  { status: "CONNECTED" }
>;

export type GuardedCartTransferResult =
  | { kind: "STALE_BEFORE_WRITE" }
  | { kind: "AUTHORIZATION_STATUS"; authorization: KrogerAuthorizationStatus }
  | { kind: "AUTHORIZATION_OUTCOME"; authorization: UnsuccessfulAuthorization }
  | { kind: "CART_OUTCOME"; outcome: KrogerCartAddOutcome };

interface GuardedCartTransferDependencies {
  identity: KrogerCartComparisonIdentity;
  signal?: AbortSignal;
  isCurrent(comparisonId: string): boolean;
  getAuthorizationStatus(signal?: AbortSignal): Promise<KrogerAuthorizationStatus>;
  authorize(
    comparisonId: string,
    options?: { signal?: AbortSignal },
  ): Promise<KrogerAuthorizationOutcome>;
  prepareCartWrite(identity: KrogerCartComparisonIdentity): Promise<void>;
  cancelPreparedCartWrite(identity: KrogerCartComparisonIdentity): Promise<unknown>;
  addToCart(identity: KrogerCartComparisonIdentity): Promise<KrogerCartAddOutcome>;
  recordCartOutcome(
    identity: KrogerCartComparisonIdentity,
    outcome: KrogerCartAddOutcome,
  ): Promise<unknown>;
  onPhase?(phase: CartTransferRunPhase): void;
}

const staleResult: GuardedCartTransferResult = { kind: "STALE_BEFORE_WRITE" };

function canContinuePreparation({
  identity,
  isCurrent,
  signal,
}: Pick<GuardedCartTransferDependencies, "identity" | "isCurrent" | "signal">) {
  return !signal?.aborted && isCurrent(identity.comparisonId);
}

function cartTransferUnavailable(status: KrogerAuthorizationStatus) {
  return status.capability.mode !== "CART_TRANSFER_SUPPORTED"
    || !status.capability.cartTransferSupported
    || !status.capability.configured
    || status.authorization === "UNAVAILABLE";
}

function unknownOutcome(): KrogerCartAddOutcome {
  return {
    status: "OUTCOME_UNKNOWN",
    success: false,
    error: "Cartiva could not record Kroger's response. Check your retailer cart before trying again.",
    code: "outcome_unknown",
    retrySafe: false,
  };
}

/**
 * Runs every read-only authorization step behind a current-comparison guard.
 * The final guard check and cart call are synchronous neighbors, so a stale
 * screen can never cross the mutation boundary. Once the POST starts, its
 * result is always returned and classified; current-screen checks must not
 * discard an ambiguous or confirmed retailer write.
 */
export async function runGuardedKrogerCartTransfer(
  dependencies: GuardedCartTransferDependencies,
): Promise<GuardedCartTransferResult> {
  const current = () => canContinuePreparation(dependencies);
  if (!current()) return staleResult;

  dependencies.onPhase?.("CHECKING_AUTHORIZATION");
  let connection: KrogerAuthorizationStatus;
  try {
    connection = await dependencies.getAuthorizationStatus(dependencies.signal);
  } catch (error) {
    if (!current()) return staleResult;
    throw error;
  }
  if (!current()) return staleResult;
  if (cartTransferUnavailable(connection)) {
    return { kind: "AUTHORIZATION_STATUS", authorization: connection };
  }

  if (connection.authorization !== "CONNECTED") {
    dependencies.onPhase?.("AUTHORIZING");
    const authorization = await dependencies.authorize(
      dependencies.identity.comparisonId,
      { signal: dependencies.signal },
    );
    if (!current()) return staleResult;
    if (authorization.status !== "CONNECTED") {
      return { kind: "AUTHORIZATION_OUTCOME", authorization };
    }
  }

  dependencies.onPhase?.("AUTHORIZATION_CONNECTED");

  await dependencies.prepareCartWrite(dependencies.identity);
  if (!current()) {
    // No mutation began, so remove the conservative SUBMITTING marker. A
    // failed cleanup remains fail-safe: restore will present outcome unknown.
    await dependencies.cancelPreparedCartWrite(dependencies.identity).catch(() => undefined);
    return staleResult;
  }

  // No await is allowed between this final identity check and the POST call.
  if (!current()) return staleResult;
  dependencies.onPhase?.("CART_WRITE_STARTED");
  let outcome: KrogerCartAddOutcome;
  try {
    outcome = await dependencies.addToCart(dependencies.identity);
  } catch {
    // The mutation may have reached Kroger. Never turn a thrown client failure
    // into a retry-safe result after the write boundary has been crossed.
    outcome = unknownOutcome();
  }
  await dependencies.recordCartOutcome(dependencies.identity, outcome).catch(() => undefined);
  dependencies.onPhase?.("CART_OUTCOME_RECORDED");
  return { kind: "CART_OUTCOME", outcome };
}

export function cartTransferBlocksNavigation(state: CartWriteSafetyState) {
  return state === "CART_WRITE_STARTED";
}

export function cartHandoffBelongsToComparison(
  handoffComparisonId: string | undefined,
  currentComparisonId: string | undefined,
) {
  return Boolean(
    handoffComparisonId
    && currentComparisonId
    && handoffComparisonId === currentComparisonId,
  );
}
