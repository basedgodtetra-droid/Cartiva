import { describe, expect, it } from "vitest";

import {
  formatCartiva500LiveReport,
  runCartiva500KrogerLive,
} from "@/tests/support/cartiva-500-live";

describe("CARTIVA 500 representative live Kroger subset", () => {
  it("checks dairy, meat, produce, canned, beverage, pantry, and household requests honestly", async () => {
    const report = await runCartiva500KrogerLive();
    console.log(formatCartiva500LiveReport(report));

    expect(report.status).not.toBe("LIVE_FAILED");
    if (report.status === "LIVE_PASSED") {
      expect(report.cases).toHaveLength(12);
      expect(report.matched).toBe(12);
      expect(report.cases.every((result) => result.selectedProduct?.productId)).toBe(true);
      expect(report.retailerCalls).toBeGreaterThan(0);
    }
  }, 300_000);
});
