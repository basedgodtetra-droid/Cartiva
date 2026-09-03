import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  formatCartiva100LiveReport,
  runCartiva100KrogerLive,
} from "@/tests/support/cartiva-100-live";

describe("Cartiva 100 opt-in live Kroger subset", () => {
  it("reports live success, external blocking, and product metadata honestly", async () => {
    const report = await runCartiva100KrogerLive();
    console.log(formatCartiva100LiveReport(report));
    if (process.env.CARTIVA100_LIVE_KROGER_REPORT_JSON === "1") {
      const reportJson = JSON.stringify(report);
      console.log(`CARTIVA100_LIVE_REPORT_SHA256=${createHash("sha256").update(reportJson).digest("hex")}`);
      console.log(`CARTIVA100_LIVE_JSON=${reportJson}`);
    }

    expect(report.status).not.toBe("LIVE_FAILED");
    if (report.status === "LIVE_PASSED") {
      expect(report.cases).toHaveLength(10);
      expect(report.matched).toBe(10);
      expect(report.cases.every((result) => result.selectedProduct?.productId)).toBe(true);
    }
  }, 240_000);
});
