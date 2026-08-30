import { describe, expect, it } from "vitest";
import {
  resetMobileOwnerOperationLocksForTests,
  withMobileOwnerOperationLock,
} from "@/lib/mobile-owner-operation-lock";

describe("temporary owner operation serialization", () => {
  it("does not let OAuth/disconnect state change during an owner cart operation", async () => {
    resetMobileOwnerOperationLocksForTests();
    const ownerId = "a".repeat(64);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const first = withMobileOwnerOperationLock(ownerId, async () => {
      order.push("cart-start");
      markFirstStarted();
      await firstCanFinish;
      order.push("cart-finish");
    });
    const second = withMobileOwnerOperationLock(ownerId, async () => {
      order.push("oauth-replace");
    });

    await firstStarted;
    expect(order).toEqual(["cart-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["cart-start", "cart-finish", "oauth-replace"]);
  });
});
