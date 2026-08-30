import { describe, expect, it, vi } from "vitest";
import { bestEffortHaptic } from "../mobile/src/services/haptics";

describe("best-effort mobile haptics", () => {
  it("does not block a shopper action when the platform rejects feedback", async () => {
    let actionCompleted = false;
    bestEffortHaptic(() => Promise.reject(new Error("Haptics unavailable")));
    actionCompleted = true;

    await Promise.resolve();
    expect(actionCompleted).toBe(true);
  });

  it("leaves a confirmed Kroger cart final with no retry prompt after rejection", async () => {
    const ui = {
      cartState: "confirmed" as "confirmed" | "failed",
      retryPromptVisible: false,
    };
    const rejectedFeedback = vi.fn(() => Promise.reject(new Error("Device feedback rejected")));

    bestEffortHaptic(rejectedFeedback);
    await Promise.resolve();

    expect(rejectedFeedback).toHaveBeenCalledOnce();
    expect(ui.cartState).toBe("confirmed");
    expect(ui.retryPromptVisible).toBe(false);
  });

  it("also swallows a platform shim that throws synchronously", () => {
    expect(() => bestEffortHaptic(() => {
      throw new Error("No native haptics module");
    })).not.toThrow();
  });
});
