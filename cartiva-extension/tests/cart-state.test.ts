import { describe, expect, it } from "vitest";
import {
  blockingCartBuild,
  cartBuildForDisplay,
  cartContextIssue,
  cartProgress,
  cartRecoveryAction,
  claimAutomaticCartBuild,
  createCartBuild,
  freshStoreConfirmationId,
  markCurrentAdding,
  migrateLegacyStoreMismatchPause,
  resolveCurrentItem,
  resumeAfterChoice,
  resumeAfterContextPause,
  retryCurrentAfterChoice,
  startCartBuild,
} from "../src/cart-state";

const items = [
  {
    id: "one",
    requestedText: "eggs",
    productTitle: "Large White Eggs, 12 Count",
    itemId: "123456789",
    productId: "search-123456789",
    productUrl: "https://www.walmart.com/ip/large-eggs/123456789",
    priceCents: 248,
    checkedAt: new Date().toISOString(),
    quantity: 1,
  },
  {
    id: "two",
    requestedText: "milk",
    productTitle: "Whole Milk, 1 Gallon",
    itemId: "987654321",
    productId: "search-987654321",
    productUrl: "https://www.walmart.com/ip/whole-milk/987654321",
    priceCents: 366,
    checkedAt: new Date().toISOString(),
    quantity: 1,
  },
];

describe("sequential cart-build state", () => {
  it("auto-starts once after an explicit successful list preparation", () => {
    const ready = {
      preparationSucceeded: true,
      sequenceCurrent: true,
      preparing: false,
      eligibleItemCount: 2,
      hasPreparedStore: true,
      buildStartPending: false,
      blockingBuild: false,
    };

    const first = claimAutomaticCartBuild(1, 0, ready);
    expect(first).toEqual({ lastHandledActionId: 1, shouldStart: true });
    expect(claimAutomaticCartBuild(1, first.lastHandledActionId, ready)).toEqual({
      lastHandledActionId: 1,
      shouldStart: false,
    });
  });

  it("does not auto-start for failed, stale, unresolved, or blocked preparations", () => {
    const ready = {
      preparationSucceeded: true,
      sequenceCurrent: true,
      preparing: false,
      eligibleItemCount: 1,
      hasPreparedStore: true,
      buildStartPending: false,
      blockingBuild: false,
    };

    for (const blocked of [
      { preparationSucceeded: false },
      { sequenceCurrent: false },
      { preparing: true },
      { eligibleItemCount: 0 },
      { hasPreparedStore: false },
      { buildStartPending: true },
      { blockingBuild: true },
    ]) {
      expect(claimAutomaticCartBuild(2, 0, { ...ready, ...blocked })).toEqual({
        lastHandledActionId: 2,
        shouldStart: false,
      });
    }
  });

  it("never treats restored or rerendered state as a new explicit action", () => {
    const ready = {
      preparationSucceeded: true,
      sequenceCurrent: true,
      preparing: false,
      eligibleItemCount: 1,
      hasPreparedStore: true,
      buildStartPending: false,
      blockingBuild: false,
    };

    expect(claimAutomaticCartBuild(0, 0, ready).shouldStart).toBe(false);
    expect(claimAutomaticCartBuild(3, 4, ready).shouldStart).toBe(false);
  });

  it("requires one explicit confirmation before starting", () => {
    expect(() => startCartBuild(createCartBuild(items, false))).toThrow(/confirmation/i);
    expect(startCartBuild(createCartBuild(items, true)).status).toBe("running");
  });

  it("advances only after the current item settles", () => {
    let state = startCartBuild(createCartBuild(items, true));
    state = markCurrentAdding(state);
    expect(state.items.map((entry) => entry.status)).toEqual(["adding", "ready"]);
    state = resolveCurrentItem(state, "added", "Confirmed");
    expect(state.cursor).toBe(1);
    expect(cartProgress(state)).toEqual({ added: 1, settled: 1, total: 2 });
    state = markCurrentAdding(state);
    state = resolveCurrentItem(state, "failed", "Timed out");
    expect(state.status).toBe("complete");
    expect(state.items[1].status).toBe("failed");
  });

  it("pauses for Needs choice and resumes honestly", () => {
    let state = startCartBuild(createCartBuild(items, true));
    state = markCurrentAdding(state);
    state = resolveCurrentItem(state, "needs_choice", "Choose a substitution", 2);
    expect(state.status).toBe("paused");
    expect(state.pauseKind).toBe("item_choice");
    expect(state.cursor).toBe(0);
    state = resumeAfterChoice(state, false, "No confirmed cart increase");
    expect(state.items[0].status).toBe("skipped");
    expect(state.cursor).toBe(1);
    expect(state.status).toBe("running");
  });

  it("retries a Target choice once only when a pre-click cart count is saved", () => {
    let state = startCartBuild(createCartBuild(items, true, { retailer: "target", zip: "79912", fulfillmentMode: "delivery" }));
    state = markCurrentAdding(state);
    state = resolveCurrentItem(state, "needs_choice", "Sign in at Target", 3);
    const firstRetry = retryCurrentAfterChoice(state);
    expect(firstRetry.status).toBe("running");
    expect(firstRetry.items[0]).toMatchObject({ status: "ready", choiceRetryCount: 1, baselineCartCount: 3 });

    let secondPause = markCurrentAdding(firstRetry);
    secondPause = resolveCurrentItem(secondPause, "needs_choice", "Target still needs sign-in", 3);
    expect(retryCurrentAfterChoice(secondPause)).toBe(secondPause);

    const noBaseline = resolveCurrentItem(markCurrentAdding(startCartBuild(createCartBuild(items, true))), "needs_choice", "Choice");
    expect(retryCurrentAfterChoice(noBaseline)).toBe(noBaseline);
  });

  it("resumes an old store-context pause without making the item a choice", () => {
    const running = startCartBuild(createCartBuild(items, true, {
      storeId: "3014",
      zip: "75232",
      fulfillmentMode: "pickup",
    }));
    const paused = {
      ...running,
      status: "paused" as const,
      pauseKind: "context" as const,
      pauseReason: "The selected Walmart store does not match this prepared basket.",
      items: running.items.map((item, index) => index === running.cursor
        ? { ...item, status: "needs_choice" as const, message: "Store mismatch" }
        : item),
    };

    const resumed = resumeAfterContextPause(paused);
    expect(resumed.status).toBe("running");
    expect(resumed.pauseKind).toBeUndefined();
    expect(resumed.pauseReason).toBeUndefined();
    expect(resumed.items[0].status).toBe("ready");
    expect(resumed.items[0].message).toBeUndefined();
  });

  it("migrates the saved legacy store-mismatch pause but preserves real context pauses", () => {
    const running = startCartBuild(createCartBuild(items, true, {
      storeId: "3014",
      zip: "75232",
      fulfillmentMode: "pickup",
    }));
    const legacyPause = {
      ...running,
      status: "paused" as const,
      pauseKind: "context" as const,
      pauseReason: "The selected Walmart store does not match this prepared basket.",
      items: running.items.map((item, index) => index === running.cursor
        ? { ...item, status: "needs_choice" as const, message: "Store mismatch" }
        : item),
    };
    const fulfillmentPause = {
      ...legacyPause,
      pauseReason: "Walmart is set to delivery, but this basket was prepared for pickup.",
      items: legacyPause.items.map((item, index) => index === legacyPause.cursor
        ? { ...item, message: "Choose pickup before Cartiva adds anything." }
        : item),
    };

    expect(migrateLegacyStoreMismatchPause(legacyPause).status).toBe("running");
    expect(migrateLegacyStoreMismatchPause(fulfillmentPause)).toBe(fulfillmentPause);
  });

  it("only auto-resumes a confirmed build whose current item is Ready", () => {
    const running = startCartBuild(createCartBuild(items, true, {
      storeId: "3014",
      zip: "75216",
      fulfillmentMode: "pickup",
    }));
    expect(cartRecoveryAction(running)).toBe("resume");
    expect(cartRecoveryAction(markCurrentAdding(running))).toBe("pause");
    expect(cartRecoveryAction({ ...running, confirmed: false })).toBe("cancel");
    expect(cartRecoveryAction({ ...running, cursor: 99 })).toBe("cancel");
  });

  it("keeps an unfinished older build visible so recovery controls remain reachable", () => {
    const running = startCartBuild(createCartBuild(items, true));
    const newerPreparation = new Date(Date.parse(running.startedAt!) + 60_000).toISOString();
    expect(blockingCartBuild(running)).toBe(running);
    expect(cartBuildForDisplay(running, newerPreparation)).toBe(running);

    const paused = resolveCurrentItem(
      markCurrentAdding(running),
      "needs_choice",
      "Choose an option at Walmart",
    );
    expect(blockingCartBuild(paused)).toBe(paused);
    expect(cartBuildForDisplay(paused, newerPreparation)).toBe(paused);
  });

  it("hides terminal builds that predate the current prepared list", () => {
    const running = startCartBuild(createCartBuild(items, true));
    const newerPreparation = new Date(Date.parse(running.startedAt!) + 60_000).toISOString();
    const complete = {
      ...running,
      status: "complete" as const,
      finishedAt: new Date().toISOString(),
    };
    const cancelled = { ...running, status: "cancelled" as const };

    expect(blockingCartBuild(complete)).toBeNull();
    expect(blockingCartBuild(cancelled)).toBeNull();
    expect(cartBuildForDisplay(complete, newerPreparation)).toBeNull();
    expect(cartBuildForDisplay(cancelled, newerPreparation)).toBeNull();
  });

  it("does not turn Walmart store metadata differences into a manual choice", () => {
    const build = startCartBuild(createCartBuild(items, true, {
      storeId: "3014",
      zip: "75232",
      fulfillmentMode: "pickup",
    }));
    const baseContext = {
      onWalmart: true,
      fulfillmentMode: "pickup" as const,
    };

    expect(cartContextIssue(build, { ...baseContext, storeId: "3014" })).toBeUndefined();
    expect(cartContextIssue(build, baseContext, "3014")).toBeUndefined();
    expect(cartContextIssue(build, baseContext)).toBeUndefined();
    expect(cartContextIssue(build, { ...baseContext, storeId: "9999" }, "3014")).toBeUndefined();
    expect(cartContextIssue(build, {
      onWalmart: true,
      storeId: "9999",
      fulfillmentMode: "unknown",
    })).toMatch(/pickup or delivery/i);
  });

  it("still stops for an explicit fulfillment mismatch", () => {
    const build = startCartBuild(createCartBuild(items, true, {
      storeId: "3014",
      zip: "75232",
      fulfillmentMode: "pickup",
    }));

    expect(cartContextIssue(build, {
      onWalmart: true,
      storeId: "3014",
      fulfillmentMode: "delivery",
    }, "3014")).toMatch(/prepared for pickup/i);
  });

  it("expires exact-store selection confirmation instead of trusting stale tab state", () => {
    const confirmedAt = Date.now();
    const confirmation = { storeId: "3014", confirmedAt, buildId: "build-a" };

    expect(freshStoreConfirmationId(confirmation, confirmedAt + 60_000)).toBe("3014");
    expect(freshStoreConfirmationId(confirmation, confirmedAt + 60_000, "build-a")).toBe("3014");
    expect(freshStoreConfirmationId(confirmation, confirmedAt + 60_000, "build-b")).toBeUndefined();
    expect(freshStoreConfirmationId(confirmation, confirmedAt + 11 * 60_000)).toBeUndefined();
    expect(freshStoreConfirmationId({ storeId: "wrong", confirmedAt }, confirmedAt)).toBeUndefined();
  });
});
