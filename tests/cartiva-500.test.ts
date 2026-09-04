import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import cartiva100Source from "@/tests/fixtures/cartiva-100.json";
import cartiva500Source from "@/tests/fixtures/cartiva-500.json";
import {
  cartiva500FixtureSummary,
  formatCartiva500Report,
  runCartiva500,
} from "@/tests/support/cartiva-500";

interface RegressionCase {
  id: string;
}

interface Cartiva500FixtureCase {
  id: string;
  group: "A" | "B" | "C" | "D" | "E";
  regressionId?: string;
  input: string;
}

const originalCases = (cartiva100Source as { cases: RegressionCase[] }).cases;
const fixtureCases = (cartiva500Source as { cases: Cartiva500FixtureCase[] }).cases;

describe("CARTIVA 500 permanent grocery-intelligence benchmark", () => {
  it("keeps the original 500 cases plus permanent shopper regressions", () => {
    const summary = cartiva500FixtureSummary();

    expect(summary.caseCount).toBe(502);
    expect(summary.levelCounts).toEqual({ 1: 100, 2: 100, 3: 100, 4: 102, 5: 100 });
    expect(new Set(fixtureCases.map((testCase) => testCase.id)).size).toBe(502);
    expect(fixtureCases.every((testCase) => testCase.input.trim().length > 0)).toBe(true);
    expect(fixtureCases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "C500-R-001", input: "Ground beef, 93/7, 1 lb" }),
      expect.objectContaining({ id: "C500-R-002", input: "Bananas, 6" }),
    ]));
  });

  it("embeds every CARTIVA 100 regression without replacing the original suite", () => {
    const regressionIds = new Set(fixtureCases.flatMap((testCase) => (
      testCase.regressionId ? [testCase.regressionId] : []
    )));

    expect(regressionIds.size).toBe(originalCases.length);
    for (const testCase of originalCases) expect(regressionIds.has(testCase.id)).toBe(true);
  });

  it("meets the CARTIVA 500 shopper-outcome targets", async () => {
    const report = await runCartiva500();

    console.log(formatCartiva500Report(report));
    if (process.env.CARTIVA500_REPORT_JSON === "1") {
      const reportJson = JSON.stringify(report);
      console.log(`CARTIVA500_REPORT_SHA256=${createHash("sha256").update(reportJson).digest("hex")}`);
      console.log(`CARTIVA500_REPORT_JSON=${reportJson}`);
    }

    expect(report.score2Or3Percent, "at least 95% must score 2 or 3").toBeGreaterThanOrEqual(95);
    expect(report.atLeast1Percent, "at least 99% must score at least 1").toBeGreaterThanOrEqual(99);
    expect(report.deadEndPercent, "unexplained shopper dead ends are not allowed").toBe(0);
    expect(report.unsafeSelectionCount, "unsafe automatic selections are never allowed").toBe(0);
    expect(report.performance.averageSearchAttempts, "bounded retrieval must average no more than three attempts").toBeLessThanOrEqual(3);
  }, 15_000);
});
