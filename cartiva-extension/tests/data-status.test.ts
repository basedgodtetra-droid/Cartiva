import { describe, expect, it } from "vitest";
import { dataStatusFor } from "../src/data-status";
import type { PreparedItem } from "../src/types";

function prepared(
  matchStatus: PreparedItem["matchStatus"],
  dataMode?: PreparedItem["dataMode"],
): PreparedItem {
  return {
    id: `${matchStatus}-${dataMode ?? "none"}`,
    request: {
      id: "eggs",
      text: "eggs",
      normalizedText: "eggs",
      quantity: 1,
    },
    matchStatus,
    alternatives: [],
    dataMode,
    cartStatus: matchStatus === "api_error" ? "failed" : "ready",
  };
}

describe("extension data badge", () => {
  it("does not label a failed live request as live Walmart data", () => {
    expect(dataStatusFor([prepared("api_error", "live")])).toEqual({
      mode: "error",
      label: "Walmart data unavailable",
    });
  });

  it("labels a partial live response honestly", () => {
    expect(dataStatusFor([
      prepared("matched", "live"),
      prepared("api_error", "live"),
    ])).toEqual({ mode: "partial", label: "Live data · some failed" });
  });

  it("keeps demo and successful live labels explicit", () => {
    expect(dataStatusFor([prepared("needs_review", "demo")]).label).toBe("Demo data");
    expect(dataStatusFor([prepared("matched", "live")]).label).toBe("Live Walmart data");
  });
});
