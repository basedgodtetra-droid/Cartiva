import { describe, expect, it } from "vitest";
import {
  RESULT_STATUS_LABELS,
  resultDisplayStatus,
} from "../src/result-presentation";
import type { PreparedItem } from "../src/types";

function prepared(overrides: Partial<PreparedItem> = {}): PreparedItem {
  return {
    id: "pepsi",
    request: {
      id: "pepsi",
      text: "Pepsi",
      normalizedText: "pepsi",
      quantity: 1,
      brand: "Pepsi",
    },
    matchStatus: "matched",
    alternatives: [],
    cartStatus: "ready",
    ...overrides,
  };
}

describe("result presentation", () => {
  it("calls a strictly verified assumption a best reasonable match", () => {
    const item = prepared({ assumptions: ["Assumed a common package size"] });
    expect(resultDisplayStatus(item, true)).toBe("best_match");
    expect(RESULT_STATUS_LABELS.best_match).toBe("Best reasonable match");
  });

  it("keeps an exact verified product labeled Matched", () => {
    expect(resultDisplayStatus(prepared(), true)).toBe("matched");
  });

  it("does not turn an unverified assumption into an addable-looking match", () => {
    const item = prepared({ assumptions: ["Assumed a common package size"] });
    expect(resultDisplayStatus(item, false)).toBe("couldnt_verify");
    expect(RESULT_STATUS_LABELS.couldnt_verify).toBe("Couldn't verify");
  });

  it("uses honest failure labels without visible review wording", () => {
    expect(resultDisplayStatus(prepared({ matchStatus: "needs_review" }), false)).toBe("couldnt_verify");
    expect(resultDisplayStatus(prepared({ matchStatus: "no_match" }), false)).toBe("no_match");
    expect(Object.values(RESULT_STATUS_LABELS).join(" ")).not.toMatch(/needs review/i);
  });
});
