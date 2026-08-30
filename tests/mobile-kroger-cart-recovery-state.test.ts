import { describe, expect, it, vi } from "vitest";
import {
  finishKrogerRecoveryReview,
  journalAfterAuthoritativeOwnerNone,
  visibleLocalKrogerSubmission,
} from "@/mobile/src/services/kroger-cart-recovery-state";
import type { KrogerCartSubmissionMarker } from "@/mobile/src/services/cart-submission-marker";

const marker: KrogerCartSubmissionMarker = {
  schemaVersion: 1,
  retailer: "kroger",
  comparisonId: "comparison_previous_001",
  locationId: "62000115",
  retailerBanner: "King Soopers",
  phase: "CONFIRMED",
  updatedAt: "2026-08-24T12:00:00.000Z",
  handoffUrl: "https://www.kingsoopers.com/cart",
};

describe("Kroger cart recovery state ordering", () => {
  it("does not resurrect a stale local outcome after authoritative server NONE", () => {
    expect(visibleLocalKrogerSubmission("none", marker)).toBeNull();
    expect(visibleLocalKrogerSubmission("checking", marker)).toBe(marker);
  });

  it("clears an earlier local-read error after server NONE removes the marker", () => {
    const failedLocalRead = {
      comparisonId: "comparison_current_001",
      marker: null,
      error: "submission_journal_unavailable",
    };
    expect(journalAfterAuthoritativeOwnerNone(
      "comparison_current_001",
      true,
      failedLocalRead,
    )).toEqual({
      comparisonId: "comparison_current_001",
      marker: null,
    });
    expect(journalAfterAuthoritativeOwnerNone(
      "comparison_current_001",
      false,
      failedLocalRead,
    )).toBe(failedLocalRead);
  });

  it("keeps successful server acknowledgement authoritative when local cleanup fails", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const clearLocal = vi.fn(async () => false);

    await expect(finishKrogerRecoveryReview({ acknowledge, clearLocal })).resolves.toEqual({
      serverAcknowledged: true,
      localCleanupSucceeded: false,
    });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(clearLocal).toHaveBeenCalledOnce();
  });

  it("does not clear local evidence when server acknowledgement fails", async () => {
    const clearLocal = vi.fn(async () => true);
    const refreshOwnerRecovery = vi.fn();
    await expect(finishKrogerRecoveryReview({
      acknowledge: async () => { throw new Error("expired recovery returned 404"); },
      clearLocal,
      afterAcknowledgeFailure: refreshOwnerRecovery,
    })).rejects.toThrow("404");
    expect(clearLocal).not.toHaveBeenCalled();
    expect(refreshOwnerRecovery).toHaveBeenCalledOnce();
  });
});
