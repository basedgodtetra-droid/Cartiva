import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  cartiva100FixtureSummary,
  formatCartiva100Report,
  runCartiva100,
} from "@/tests/support/cartiva-100";

describe("CARTIVA 100 permanent grocery-intelligence benchmark", () => {
  it("retains the original 100 cases while allowing the suite to grow", () => {
    const summary = cartiva100FixtureSummary();

    expect(summary.caseCount).toBeGreaterThanOrEqual(100);
    for (const count of Object.values(summary.levelCounts)) expect(count).toBeGreaterThanOrEqual(20);
    expect(summary.liveKrogerCaseIds).toHaveLength(10);
  });

  it("meets the Cartiva 100 shopper-outcome targets", async () => {
    const report = await runCartiva100();

    console.log(formatCartiva100Report(report));
    if (process.env.CARTIVA100_REPORT_JSON === "1") {
      const reportJson = JSON.stringify(report);
      console.log(`CARTIVA100_REPORT_SHA256=${createHash("sha256").update(reportJson).digest("hex")}`);
      console.log(`CARTIVA100_REPORT_JSON=${reportJson}`);
    }

    expect(report.score2Or3Percent, "at least 90% must score 2 or 3").toBeGreaterThanOrEqual(90);
    expect(report.atLeast1Percent, "at least 95% must score at least 1").toBeGreaterThanOrEqual(95);
    expect(report.deadEndPercent, "true dead ends must stay below 5%").toBeLessThan(5);
    expect(report.unsafeSelectionCount, "unsafe automatic selections are never allowed").toBe(0);
  });
});
