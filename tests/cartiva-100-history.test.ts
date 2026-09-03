import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import fixtureSource from "@/tests/fixtures/cartiva-100.json";
import { cartiva100FixtureFingerprints } from "@/tests/support/cartiva-100";

const historyDirectory = path.join(process.cwd(), "benchmarks", "cartiva-100", "history");
const liveHistoryDirectory = path.join(historyDirectory, "live");
const sha256Pattern = /^[a-f0-9]{64}$/;
const expectedCurrentFingerprints = {
  algorithm: "recursive-key-sort-json-sha256-v1",
  oracleRevision: 2,
  requestCorpusSha256: "94b9d695bc9c38442d8a3a51104f5160d212fd0e985551ac905c76d99a2ecc86",
  oracleSha256: "7be0f6317fcb9dbe2b8ccf7486968da24b83670347e776eb60770d337ef1a730",
};
const levelKeys = ["1", "2", "3", "4", "5"];
const fixtureCases = fixtureSource.cases as Array<{ id: string; level: number }>;
const fixtureIds = new Set(fixtureCases.map(({ id }) => id));
const knownFailureCategories = new Set([
  "PARSING", "ITEM_BOUNDARY", "TYPO_NORMALIZATION", "PRODUCT_IDENTITY", "ALIAS", "BRAND", "VARIANT",
  "ATTRIBUTE_EXTRACTION", "QUANTITY_SEMANTICS", "PACKAGE_SIZE", "MULTI_PACKAGE_FULFILLMENT", "UNIT_CONVERSION",
  "CATEGORY_CLASSIFICATION", "SEARCH_QUERY", "SEARCH_TOO_LITERAL", "CANDIDATE_RETRIEVAL", "CANDIDATE_RANKING",
  "CONFIDENCE_THRESHOLD", "AVAILABILITY", "RETAILER_METADATA", "CLARIFICATION", "SUBSTITUTION", "UNKNOWN",
]);
const frozenHistoricalHashes: Record<string, string> = {
  "run-0001-baseline.json": "9b0e9a0fabf716cce63bcaa0a7fb0f28418f0f332cdb8790f9994290232e562b",
  "run-0002-transcribed-77-percent.json": "a54895b9e42028a440caa074e2a8594169361966e584e3f73539a7bf2abc3c4b",
  "run-0003-transcribed-98-percent.json": "cbe1715120a2b27d3419c9cc5c5c9b841b3c81877a544721198fd21493eec66b",
};

type ScoreSummary = {
  "3": number;
  "2": number;
  "1": number;
  "0": number;
  score2Or3Count?: number;
  score2Or3Percent: number;
  atLeast1Count?: number;
  atLeast1Percent: number;
  deadEndCount?: number;
  deadEndPercent: number;
  unsafeSelectionCount?: number | null;
  safetyGateEvaluated?: boolean;
  targetPolicy?: string;
  targetMet: boolean;
};

type LevelSummary = Record<string, { useful: number; score2Or3: number; total: number }>;

type DeterministicHistoryRecord = {
  historySchemaVersion?: number;
  recordType?: string;
  runId: string;
  recordedAt: string;
  observedAt?: string | null;
  previousRunId?: string;
  fixture?: { caseCount: number };
  benchmark?: {
    caseCount: number;
    fixtureSchemaVersion: number;
    scoringPolicy: string;
    oracleRevision: number;
    fingerprintAlgorithm: string;
    levelCounts: Record<string, number>;
    hashes: Record<string, string | null>;
    changesSincePrevious?: Array<{ caseId: string }>;
  };
  capture?: { kind: string; rawReportSha256: string | null; note?: string };
  comparability?: { status: "comparable" | "conditional" | "trend-break"; reason: string };
  source?: { sourceManifestSha256?: string | null };
  execution?: { command: string; mode: string; retailerCalls: number };
  scores: ScoreSummary;
  levels: LevelSummary;
  failureCategories: Record<string, number>;
  performance?: Record<string, string | number> | null;
  score0CaseIds?: string[] | null;
  score1CaseIds?: string[] | null;
  deadEndCaseIds?: string[] | null;
};

type LiveHistoryRecord = {
  historySchemaVersion: number;
  recordType: string;
  deterministicRunId: string;
  checkedAt: string;
  externalDataVolatile: boolean;
  store?: { id: string; name: string; zipCode: string };
  execution: {
    disposition: string;
    runnerStatus: string;
    retailerCalls: number;
    credentialsConfigured: Record<string, boolean>;
  };
  counts: { selected: number; matched: number; blocked: number; failed: number };
  hashes: Record<string, string>;
  cases: Array<{
    caseId: string;
    status: string;
    checkedAt: string;
    attempts: Array<{ query: string; resultCount: number }>;
    selectedProduct?: {
      productId: string;
      upc: string;
      description: string;
      priceCents: number;
      quantity: number;
      packageCount: number;
      availability: string;
      sourceUrl: string;
    };
  }>;
};

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function expectPercent(count: number, total: number, actual: number) {
  expect(actual).toBe(Number(((count / total) * 100).toFixed(1)));
}

function expectNonnegativeInteger(value: number) {
  expect(Number.isInteger(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
}

function expectUniqueKnownCaseIds(ids: string[]) {
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(fixtureIds.has(id), `unknown benchmark case ${id}`).toBe(true);
}

function fileSha256(filePath: string) {
  const canonicalJson = JSON.stringify(JSON.parse(readFileSync(filePath, "utf8")));
  return createHash("sha256").update(canonicalJson).digest("hex");
}

describe("CARTIVA 100 append-only history", () => {
  it("keeps deterministic runs ordered, chained, and internally consistent", () => {
    const filenames = readdirSync(historyDirectory)
      .filter((filename) => /^run-\d{4}-[a-z0-9-]+\.json$/.test(filename))
      .sort();

    expect(filenames.length).toBeGreaterThanOrEqual(3);

    const records = filenames.map((filename) => ({
      filename,
      record: readJson<DeterministicHistoryRecord>(path.join(historyDirectory, filename)),
    }));

    expect(new Set(records.map(({ record }) => record.runId)).size).toBe(records.length);

    records.forEach(({ filename, record }, index) => {
      expect(filename).toBe(`${record.runId}.json`);
      expect(record.runId.startsWith(`run-${String(index + 1).padStart(4, "0")}-`)).toBe(true);
      const recordedAt = Date.parse(record.recordedAt);
      expect(Number.isNaN(recordedAt)).toBe(false);
      if (index > 0) expect(recordedAt).toBeGreaterThanOrEqual(Date.parse(records[index - 1].record.recordedAt));
      if (record.observedAt) {
        expect(Number.isNaN(Date.parse(record.observedAt))).toBe(false);
        expect(Date.parse(record.observedAt)).toBeLessThanOrEqual(recordedAt);
      }

      if (index === 0) {
        expect(record.runId).toBe("run-0001-baseline");
      } else {
        expect(record.historySchemaVersion).toBe(2);
        expect(record.recordType).toBe("deterministic");
        expect(record.previousRunId).toBe(records[index - 1].record.runId);
        expect(record.capture).toBeDefined();
        expect(record.comparability).toBeDefined();
        expect(record.comparability?.reason.trim()).not.toBe("");
        expect(record.source).toBeDefined();
        expect(record.benchmark).toBeDefined();
        expect(record.execution).toMatchObject({ mode: "deterministic-local", retailerCalls: 0 });
      }

      const caseCount = record.benchmark?.caseCount ?? record.fixture?.caseCount;
      expect(caseCount).toBeGreaterThanOrEqual(100);
      if (caseCount === undefined) throw new Error(`${record.runId} is missing its case count`);

      const score2Or3Count = record.scores["3"] + record.scores["2"];
      const atLeast1Count = score2Or3Count + record.scores["1"];
      for (const score of [record.scores["3"], record.scores["2"], record.scores["1"], record.scores["0"]]) {
        expectNonnegativeInteger(score);
      }
      expect(record.scores["3"] + record.scores["2"] + record.scores["1"] + record.scores["0"]).toBe(
        caseCount,
      );
      expect(record.scores.score2Or3Count ?? score2Or3Count).toBe(score2Or3Count);
      expect(record.scores.atLeast1Count ?? atLeast1Count).toBe(atLeast1Count);
      expectPercent(score2Or3Count, caseCount, record.scores.score2Or3Percent);
      expectPercent(atLeast1Count, caseCount, record.scores.atLeast1Percent);
      const deadEndCount = record.scores.deadEndCount ?? Math.round((record.scores.deadEndPercent / 100) * caseCount);
      expectNonnegativeInteger(deadEndCount);
      expect(deadEndCount).toBeLessThanOrEqual(record.scores["0"]);
      expectPercent(deadEndCount, caseCount, record.scores.deadEndPercent);

      expect(Object.keys(record.levels).sort()).toEqual(levelKeys);
      const levelTotals = Object.values(record.levels);
      expect(levelTotals.reduce((sum, level) => sum + level.total, 0)).toBe(caseCount);
      expect(levelTotals.reduce((sum, level) => sum + level.useful, 0)).toBe(atLeast1Count);
      expect(levelTotals.reduce((sum, level) => sum + level.score2Or3, 0)).toBe(score2Or3Count);
      for (const level of levelTotals) {
        expectNonnegativeInteger(level.total);
        expectNonnegativeInteger(level.useful);
        expectNonnegativeInteger(level.score2Or3);
        expect(level.total).toBeGreaterThanOrEqual(20);
        expect(level.score2Or3).toBeLessThanOrEqual(level.useful);
        expect(level.useful).toBeLessThanOrEqual(level.total);
      }
      if (record.benchmark) {
        expect(record.benchmark.fingerprintAlgorithm).toBe(expectedCurrentFingerprints.algorithm);
        expect(Object.keys(record.benchmark.levelCounts).sort()).toEqual(levelKeys);
        for (const level of levelKeys) expect(record.benchmark.levelCounts[level]).toBe(record.levels[level].total);
      }

      let categorizedFailures = 0;
      for (const [category, count] of Object.entries(record.failureCategories)) {
        expect(knownFailureCategories.has(category), `unknown failure category ${category}`).toBe(true);
        expectNonnegativeInteger(count);
        categorizedFailures += count;
      }
      expect(categorizedFailures).toBe(record.scores["0"] + record.scores["1"]);

      if (record.score0CaseIds !== null && record.score0CaseIds !== undefined) {
        expect(record.score0CaseIds).toHaveLength(record.scores["0"]);
        expectUniqueKnownCaseIds(record.score0CaseIds);
        for (const level of levelKeys) {
          expect(record.score0CaseIds.filter((id) => id.startsWith(`C100-L${level}-`))).toHaveLength(
            record.levels[level].total - record.levels[level].useful,
          );
        }
      }
      if (record.score1CaseIds !== null && record.score1CaseIds !== undefined) {
        expect(record.score1CaseIds).toHaveLength(record.scores["1"]);
        expectUniqueKnownCaseIds(record.score1CaseIds);
        for (const level of levelKeys) {
          expect(record.score1CaseIds.filter((id) => id.startsWith(`C100-L${level}-`))).toHaveLength(
            record.levels[level].useful - record.levels[level].score2Or3,
          );
        }
      }
      if (record.deadEndCaseIds !== null && record.deadEndCaseIds !== undefined) {
        expect(record.deadEndCaseIds).toHaveLength(deadEndCount);
        expectUniqueKnownCaseIds(record.deadEndCaseIds);
        if (record.score0CaseIds) {
          for (const id of record.deadEndCaseIds) expect(record.score0CaseIds).toContain(id);
        }
      }
      if (record.score0CaseIds && record.score1CaseIds) {
        for (const id of record.score1CaseIds) expect(record.score0CaseIds).not.toContain(id);
      }

      if (record.capture?.kind === "transcribed-session-output") {
        expect(record.capture.rawReportSha256).toBeNull();
        expect(record.source?.sourceManifestSha256).toBeNull();
        expect(record.capture.note).toMatch(/snapshot|hash/i);
        if (record.scores.unsafeSelectionCount === null) {
          expect(record.scores.safetyGateEvaluated).toBe(false);
          expect(record.scores.targetPolicy).toContain("without-unsafe-selection-gate");
        }
      }

      if (record.capture?.kind === "verified-command") {
        expect(record.observedAt).toBeTruthy();
        expect(record.capture.rawReportSha256).toMatch(sha256Pattern);
        expect(record.source?.sourceManifestSha256).toMatch(sha256Pattern);
        for (const value of Object.values(record.benchmark?.hashes ?? {})) {
          expect(value).toMatch(sha256Pattern);
        }
        expectNonnegativeInteger(record.scores.unsafeSelectionCount ?? -1);
        expect(record.scores.safetyGateEvaluated).toBe(true);
        expect(record.scores.targetMet).toBe(
          record.scores.score2Or3Percent >= 90
          && record.scores.atLeast1Percent >= 95
          && record.scores.deadEndPercent < 5
          && record.scores.unsafeSelectionCount === 0,
        );
        for (const value of Object.values(record.performance ?? {})) {
          if (typeof value === "number") {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    for (let index = 1; index < records.length; index += 1) {
      const previous = records[index - 1].record;
      const current = records[index].record;
      if (!previous.benchmark || !current.benchmark) continue;

      expect(current.benchmark.oracleRevision).toBeGreaterThanOrEqual(previous.benchmark.oracleRevision);
      const oracleChanged = current.benchmark.oracleRevision !== previous.benchmark.oracleRevision
        || current.benchmark.hashes.oracleSha256 !== previous.benchmark.hashes.oracleSha256;
      if (oracleChanged) {
        expect(current.comparability?.status).toBe("trend-break");
        expect(current.benchmark.changesSincePrevious?.length).toBeGreaterThan(0);
        for (const change of current.benchmark.changesSincePrevious ?? []) {
          expect(fixtureIds.has(change.caseId)).toBe(true);
        }
      }
      if (current.benchmark.hashes.requestCorpusSha256 !== previous.benchmark.hashes.requestCorpusSha256) {
        expect(current.comparability?.status).not.toBe("comparable");
      }
      if (current.comparability?.status === "comparable") {
        expect(current.benchmark.fixtureSchemaVersion).toBe(previous.benchmark.fixtureSchemaVersion);
        expect(current.benchmark.scoringPolicy).toBe(previous.benchmark.scoringPolicy);
        expect(current.benchmark.oracleRevision).toBe(previous.benchmark.oracleRevision);
        expect(current.benchmark.hashes.requestCorpusSha256).toBe(previous.benchmark.hashes.requestCorpusSha256);
        expect(current.benchmark.hashes.oracleSha256).toBe(previous.benchmark.hashes.oracleSha256);
      }
    }
  });

  it("locks the historical records that predate verified source capture", () => {
    for (const [filename, expectedHash] of Object.entries(frozenHistoricalHashes)) {
      expect(fileSha256(path.join(historyDirectory, filename))).toBe(expectedHash);
    }
  });

  it("binds the active fixture to an explicit request corpus and oracle revision", () => {
    expect(cartiva100FixtureFingerprints()).toEqual(expectedCurrentFingerprints);

    const filenames = readdirSync(historyDirectory)
      .filter((filename) => /^run-\d{4}-[a-z0-9-]+\.json$/.test(filename))
      .sort();
    const latest = readJson<DeterministicHistoryRecord>(path.join(historyDirectory, filenames.at(-1)!));
    if (latest.capture?.kind === "verified-command") {
      expect(latest.benchmark?.oracleRevision).toBe(expectedCurrentFingerprints.oracleRevision);
      expect(latest.benchmark?.hashes.requestCorpusSha256).toBe(expectedCurrentFingerprints.requestCorpusSha256);
      expect(latest.benchmark?.hashes.oracleSha256).toBe(expectedCurrentFingerprints.oracleSha256);
    }
  });

  it("retains complete, credential-safe evidence for every live run", () => {
    if (!existsSync(liveHistoryDirectory)) return;

    const filenames = readdirSync(liveHistoryDirectory)
      .filter((filename) => /^live-\d{8}T\d{9}Z-[a-z0-9-]+\.json$/.test(filename))
      .sort();

    for (const filename of filenames) {
      const record = readJson<LiveHistoryRecord>(path.join(liveHistoryDirectory, filename));
      expect(record.historySchemaVersion).toBe(2);
      expect(record.recordType).toBe("live-kroger");
      expect(record.deterministicRunId).toMatch(/^run-\d{4}-/);
      expect(Number.isNaN(Date.parse(record.checkedAt))).toBe(false);
      expect(record.externalDataVolatile).toBe(true);
      expect(record.counts.selected).toBe(10);
      expect(record.counts.matched + record.counts.blocked + record.counts.failed).toBe(10);
      expect(record.cases.length).toBeLessThanOrEqual(10);
      expectUniqueKnownCaseIds(record.cases.map(({ caseId }) => caseId));
      expect(record.execution.retailerCalls).toBeGreaterThanOrEqual(0);
      expect(Object.keys(record.execution.credentialsConfigured).length).toBeGreaterThan(0);
      expect(Object.values(record.execution.credentialsConfigured).every((value) => typeof value === "boolean")).toBe(
        true,
      );
      for (const value of Object.values(record.hashes)) expect(value).toMatch(sha256Pattern);

      if (record.execution.disposition === "COMPLETED") {
        expect(["LIVE_PASSED", "LIVE_FAILED"]).toContain(record.execution.runnerStatus);
        if (record.execution.runnerStatus === "LIVE_PASSED") {
          expect(record.counts).toMatchObject({ matched: 10, blocked: 0, failed: 0 });
        } else {
          expect(record.counts.failed).toBeGreaterThan(0);
        }
        expect(record.store?.id).not.toBe("");
        expect(record.store?.name).not.toBe("");
        expect(record.store?.zipCode).toMatch(/^\d{5}$/);
        expect(record.cases).toHaveLength(10);
      } else {
        expect(record.execution.runnerStatus).toBe("EXTERNAL_BLOCKED");
      }

      for (const liveCase of record.cases) {
        expect(Number.isNaN(Date.parse(liveCase.checkedAt))).toBe(false);
        for (const attempt of liveCase.attempts) {
          expect(attempt.query.trim()).not.toBe("");
          expect(attempt.resultCount).toBeGreaterThanOrEqual(0);
        }
        if (liveCase.status === "MATCHED") {
          expect(liveCase.attempts.length).toBeGreaterThan(0);
          expect(liveCase.selectedProduct).toMatchObject({ quantity: expect.any(Number), packageCount: expect.any(Number) });
          expect(liveCase.selectedProduct?.productId).not.toBe("");
          expect(liveCase.selectedProduct?.upc).not.toBe("");
          expect(liveCase.selectedProduct?.description).not.toBe("");
          expect(liveCase.selectedProduct?.priceCents).toBeGreaterThanOrEqual(0);
          expect(liveCase.selectedProduct?.sourceUrl).toMatch(/^https:\/\//);
        }
      }
    }
  });
});
