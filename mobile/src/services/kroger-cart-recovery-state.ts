import type { KrogerCartSubmissionMarker } from "./cart-submission-marker";

export type OwnerRecoveryAuthority = "checking" | "none" | "recovered" | "unavailable";

export interface KrogerSubmissionJournalView {
  comparisonId: string;
  marker: KrogerCartSubmissionMarker | null;
  error?: string;
}

/** A successful owner-level NONE response supersedes stale device-only outcomes. */
export function visibleLocalKrogerSubmission(
  ownerRecovery: OwnerRecoveryAuthority,
  marker: KrogerCartSubmissionMarker | null,
) {
  return ownerRecovery === "none" ? null : marker;
}

/** Successful removal after server NONE also clears an earlier local-read error. */
export function journalAfterAuthoritativeOwnerNone(
  comparisonId: string | null,
  localCleanupSucceeded: boolean,
  current: KrogerSubmissionJournalView | null,
) {
  if (!localCleanupSucceeded || !comparisonId) return current;
  return { comparisonId, marker: null } satisfies KrogerSubmissionJournalView;
}

/**
 * Server acknowledgement is irreversible and authoritative. Device cleanup is
 * best effort and is retried after the next owner-level NONE response.
 */
export async function finishKrogerRecoveryReview({
  acknowledge,
  clearLocal,
  afterAcknowledgeFailure,
}: {
  acknowledge(): Promise<void>;
  clearLocal(): Promise<boolean>;
  afterAcknowledgeFailure?(): void | Promise<void>;
}) {
  try {
    await acknowledge();
  } catch (error) {
    await afterAcknowledgeFailure?.();
    throw error;
  }
  let localCleanupSucceeded = false;
  try {
    localCleanupSucceeded = await clearLocal();
  } catch {
    // The server is already authoritative; report cleanup as pending.
  }
  return {
    serverAcknowledged: true as const,
    localCleanupSucceeded,
  };
}
