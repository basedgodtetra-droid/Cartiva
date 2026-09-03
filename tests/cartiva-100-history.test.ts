import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
type HistoricalFixtureCase = {
  id: string;
  level: number;
  input: string;
  tags: string[];
  liveKroger?: boolean;
  expectedItems: unknown;
};
type HistoricalFixture = {
  schemaVersion: number;
  suite: { id: string; scoringPolicy: string };
  cases: HistoricalFixtureCase[];
};
const fixtureCases = (fixtureSource as HistoricalFixture).cases;
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
  "run-0004-verified-96-percent.json": "96a55f6aa3133f497f911a87b1a90161cbf6bbb85d6949bf95f9e7584508bfc2",
};
const frozenDeterministicRawHashes: Record<string, string> = {
  "run-0004-verified-96-percent.report.json": "694e6ed28d302ce59e62d5c876d6762910b0f73ad05c7a10cd3533b79f0b8e38",
};
const frozenLiveSummaryHashes: Record<string, string> = {
  "live-20260903T042847117Z-kroger.json": "f917af904d970b433f94845e73ef507ee7874146aa6120f63caa716e45576647",
};
const frozenLiveRawHashes: Record<string, string> = {
  "live-20260903T042847117Z-kroger.report.json": "6825f6daba0ba1a856c224a3d7269eb80588507fc9c917c278e8c442d0f4d6ed",
};

const verifiedSourceHashFields: Record<string, string> = {
  fixtureFileSha256: "tests/fixtures/cartiva-100.json",
  catalogFileSha256: "tests/fixtures/cartiva-100-catalog.json",
  scorerFileSha256: "tests/support/cartiva-100.ts",
  testFileSha256: "tests/cartiva-100.test.ts",
};

const liveSourceHashFields: Record<string, string> = {
  liveRunnerSha256: "tests/support/cartiva-100-live.ts",
  liveTestSha256: "tests/live/cartiva-100-kroger.test.ts",
  liveOracleTestSha256: "tests/cartiva-100-live-oracle.test.ts",
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
    suiteId: string;
    caseCount: number;
    fixtureSchemaVersion: number;
    scoringPolicy: string;
    oracleRevision: number;
    fingerprintAlgorithm: string;
    levelCounts: Record<string, number>;
    hashes: Record<string, string | null>;
    changesSincePrevious?: Array<{ caseId: string }>;
  };
  capture?: {
    kind: string;
    rawReportPath?: string;
    rawReportHashAlgorithm?: string;
    rawReportSha256: string | null;
    note?: string;
  };
  comparability?: { status: "comparable" | "conditional" | "trend-break"; reason: string };
  source?: {
    gitBaseCommit: string;
    treeState: string;
    sourceManifestAlgorithm: string;
    sourceManifestSha256?: string | null;
    sourceManifestEntryCount?: number;
    gitObjectAlgorithm?: string;
    gitBlobIds?: Record<string, string>;
  };
  execution?: { command: string; mode: string; retailerCalls: number };
  scores: ScoreSummary;
  levels: LevelSummary;
  failureCategories: Record<string, number>;
  performance?: Record<string, string | number> | null;
  score0CaseIds?: string[] | null;
  score1CaseIds?: string[] | null;
  deadEndCaseIds?: string[] | null;
};

type DeterministicRawReport = {
  suiteId: string;
  scoringPolicy: string;
  total: number;
  scoreCounts: Record<"0" | "1" | "2" | "3", number>;
  score2Or3Percent: number;
  atLeast1Percent: number;
  deadEndPercent: number;
  unsafeSelectionCount: number;
  stableOutcomeSha256: string;
  targetMet: boolean;
  levels: LevelSummary;
  failureCategories: Record<string, number>;
  performance: Record<string, number>;
  cases: Array<{
    id: string;
    level: number;
    input: string;
    score: number;
    deadEnd: boolean;
    unsafeSelection: boolean;
    category?: string;
    itemOutcomes: Array<{
      score: number;
      deadEnd: boolean;
      unsafeSelection: boolean;
      category?: string;
      reason: string;
      searchAttempts: number;
    }>;
  }>;
};

type LiveHistoryRecord = {
  historySchemaVersion: number;
  recordType: string;
  deterministicRunId: string;
  checkedAt: string;
  recordedAt: string;
  externalDataVolatile: boolean;
  validationScope: string;
  capture: {
    rawReportPath: string;
    rawReportHashAlgorithm: string;
    rawReportSha256: string;
  };
  store?: { id: string; name: string; chain: string; zipCode: string };
  execution: {
    disposition: string;
    runnerStatus: string;
    retailerCalls: number;
    credentialsConfigured: Record<string, boolean>;
  };
  counts: {
    selected: number;
    identityPackageVerified: number;
    handoffReady: number;
    matched: number;
    availabilityUnconfirmed: number;
    blocked: number;
    failed: number;
  };
  hashes: Record<string, string>;
  cases: Array<{
    caseId: string;
    status: string;
    checkedAt: string;
    attempts: Array<{ query: string; resultCount: number }>;
    returnedCandidateCount: number;
    reason: string;
    selectedProduct?: {
      productId: string;
      upc: string;
      description: string;
      brand?: string;
      productType?: string;
      size?: unknown;
      priceCents: number;
      quantity: number;
      packageCount: number;
      availability: string;
      locationId: string;
      checkedAt: string;
      sourceUrl: string;
    };
  }>;
};

type LiveRawReport = {
  suiteId: string;
  status: "LIVE_PASSED" | "LIVE_FAILED" | "EXTERNAL_BLOCKED";
  checkedAt: string;
  location?: { locationId: string; name: string; chain: string; zipCode: string };
  retailerCalls: number;
  matched: number;
  blocked: number;
  failed: number;
  cases: Array<{
    id: string;
    input: string;
    resolvedRequest?: string;
    status: "LIVE_PASSED" | "LIVE_FAILED" | "EXTERNAL_BLOCKED";
    reason: string;
    searchAttempts: Array<{ level: string; query: string; resultCount: number }>;
    returnedCandidateCount: number;
    selectedProduct?: {
      productId: string;
      upc: string;
      title: string;
      brand?: string;
      productType?: string;
      size?: unknown;
      priceCents: number;
      availabilityStatus: string;
      locationId: string;
      checkedAt: string;
      sourceUrl: string;
      cartQuantity: number;
      packageCount: number;
    };
  }>;
};

type HistorySchemaContract = {
  $schema: string;
  properties: {
    source: {
      properties: {
        gitBaseCommit: { oneOf: Array<{ pattern: string }> };
        gitBlobIds: { additionalProperties: { oneOf: Array<{ pattern: string }> } };
      };
      allOf: Array<{
        if: { properties: { gitObjectAlgorithm: { const: string } } };
        then: {
          properties: {
            gitBaseCommit: { pattern: string };
            gitBlobIds: { additionalProperties: { pattern: string } };
          };
        };
      }>;
    };
  };
  allOf: Array<{
    if?: { properties?: { capture?: { properties?: { kind?: { const?: string } } } } };
    then?: {
      required?: string[];
      properties?: {
        capture?: { required?: string[] };
        source?: { required?: string[] };
        benchmark?: { properties?: { hashes?: { required?: string[] } } };
      };
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

function expectUniqueKnownCaseIds(ids: string[], knownIds = fixtureIds) {
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(knownIds.has(id), `unknown benchmark case ${id}`).toBe(true);
}

function canonicalJsonFileSha256(filePath: string) {
  const canonicalJson = JSON.stringify(JSON.parse(readFileSync(filePath, "utf8")));
  return createHash("sha256").update(canonicalJson).digest("hex");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        canonicalizeJson((value as Record<string, unknown>)[key]),
      ]),
    );
  }
  return value;
}

function canonicalJsonSha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalizeJson(value))).digest("hex");
}

function sha256Bytes(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveEvidencePath(root: string, relativePath: string) {
  expect(path.isAbsolute(relativePath)).toBe(false);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const fromRoot = path.relative(resolvedRoot, resolved);
  expect(fromRoot).not.toBe("");
  expect(fromRoot.startsWith(`..${path.sep}`) || fromRoot === "..").toBe(false);
  expect(existsSync(resolved), `missing evidence file ${relativePath}`).toBe(true);
  return resolved;
}

function gitOutput(args: string[], input?: Buffer) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "buffer",
    input,
    maxBuffer: 512 * 1024 * 1024,
  });
}

function gitSourceManifest(commit: string) {
  const tree = gitOutput(["ls-tree", "-r", "-z", "--full-tree", commit]);
  const entries: Array<{ objectId: string; pathBytes: Buffer }> = [];
  let entryStart = 0;
  for (let index = 0; index < tree.length; index += 1) {
    if (tree[index] !== 0) continue;
    const entry = tree.subarray(entryStart, index);
    const tab = entry.indexOf(9);
    const [mode, type, objectId] = entry.subarray(0, tab).toString("ascii").split(" ");
    if (!mode || type !== "blob" || !objectId) throw new Error("Source manifest only supports Git blob entries.");
    entries.push({ objectId, pathBytes: entry.subarray(tab + 1) });
    entryStart = index + 1;
  }
  entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));

  const batchInput = Buffer.from(`${entries.map(({ objectId }) => objectId).join("\n")}\n`, "ascii");
  const batch = gitOutput(["cat-file", "--batch"], batchInput);
  const zero = Buffer.from([0]);
  const digest = createHash("sha256");
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = batch.indexOf(10, offset);
    if (headerEnd < 0) throw new Error("Git batch output ended before its blob header.");
    const [objectId, type, sizeText] = batch.subarray(offset, headerEnd).toString("ascii").split(" ");
    const size = Number(sizeText);
    if (objectId !== entry.objectId || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Git batch output did not match the requested source blob.");
    }
    const blobStart = headerEnd + 1;
    const blobEnd = blobStart + size;
    const blob = batch.subarray(blobStart, blobEnd);
    if (batch[blobEnd] !== 10) throw new Error("Git batch output omitted its blob delimiter.");
    digest.update(entry.pathBytes).update(zero).update(blob).update(zero);
    offset = blobEnd + 1;
  }
  if (offset !== batch.length) throw new Error("Git batch output contained unexpected trailing bytes.");
  return { entryCount: entries.length, sha256: digest.digest("hex") };
}

function gitBlobAt(commit: string, filePath: string) {
  const objectId = gitOutput(["rev-parse", `${commit}:${filePath}`]).toString("ascii").trim();
  return { objectId, bytes: gitOutput(["cat-file", "blob", objectId]) };
}

function requireRecordedCommitAvailable(commit: string) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      `Recorded CARTIVA 100 commit ${commit} is unavailable. Fetch history with depth >= 2 `
      + "including this commit, or fetch full history/unshallow the checkout, then rerun the history test.",
    );
  }
}

function fixtureAtRecordedCommit(commit: string) {
  requireRecordedCommitAvailable(commit);
  const fixtureBlob = gitBlobAt(commit, "tests/fixtures/cartiva-100.json");
  const fixture = JSON.parse(fixtureBlob.bytes.toString("utf8")) as HistoricalFixture;
  if (!Array.isArray(fixture.cases)) throw new Error(`Recorded fixture at ${commit} has no cases.`);
  return fixture;
}

function fixtureFingerprints(fixture: HistoricalFixture) {
  const requestCorpus = fixture.cases.map((testCase) => ({
    id: testCase.id,
    level: testCase.level,
    input: testCase.input,
    tags: testCase.tags,
    liveKroger: Boolean(testCase.liveKroger),
  }));
  const oracle = fixture.cases.map((testCase) => ({
    id: testCase.id,
    expectedItems: testCase.expectedItems,
  }));
  return {
    requestCorpusSha256: canonicalJsonSha256(requestCorpus),
    oracleSha256: canonicalJsonSha256(oracle),
  };
}

function expectCredentialSafe(value: unknown, parents: string[] = []) {
  if (Array.isArray(value)) {
    value.forEach((child) => expectCredentialSafe(child, parents));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const credentialLike = /(?:secret|token|password|authorization|client.?id|redirect.?uri)/i.test(key);
    const isPresenceFlag = parents.at(-1) === "credentialsConfigured" && typeof child === "boolean";
    if (credentialLike) expect(isPresenceFlag, `credential material persisted at ${[...parents, key].join(".")}`).toBe(true);
    expectCredentialSafe(child, [...parents, key]);
  }
}

function expectConfiguredCredentialValuesAbsent(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const name of ["KROGER_CLIENT_ID", "KROGER_CLIENT_SECRET", "KROGER_REDIRECT_URI"]) {
    const configuredValue = process.env[name];
    if (configuredValue && configuredValue.length >= 4) expect(serialized).not.toContain(configuredValue);
  }
}

function deterministicStableOutcomeSha256(report: DeterministicRawReport) {
  const stableOutcomes = report.cases.map((testCase) => ({
    id: testCase.id,
    score: testCase.score,
    deadEnd: testCase.deadEnd,
    unsafeSelection: testCase.unsafeSelection,
    category: testCase.category,
    itemOutcomes: testCase.itemOutcomes.map((item) => ({
      score: item.score,
      deadEnd: item.deadEnd,
      unsafeSelection: item.unsafeSelection,
      category: item.category,
      reason: item.reason,
      searchAttempts: item.searchAttempts,
    })),
  }));
  return createHash("sha256").update(JSON.stringify(stableOutcomes)).digest("hex");
}

describe("CARTIVA 100 append-only history", () => {
  it("keeps the dependency-free history schema contract internally aligned", () => {
    const schema = readJson<HistorySchemaContract>(path.join(historyDirectory, "schema-v2.json"));
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const expectedObjectIdPatterns = ["^[a-f0-9]{40}$", "^[a-f0-9]{64}$"];
    const commitPatterns = schema.properties.source.properties.gitBaseCommit.oneOf.map(({ pattern }) => pattern);
    const blobPatterns = schema.properties.source.properties.gitBlobIds.additionalProperties.oneOf
      .map(({ pattern }) => pattern);
    expect(commitPatterns).toEqual(expectedObjectIdPatterns);
    expect(blobPatterns).toEqual(expectedObjectIdPatterns);
    for (const length of [40, 64]) {
      const objectId = "a".repeat(length);
      expect(commitPatterns.filter((pattern) => new RegExp(pattern).test(objectId))).toHaveLength(1);
      expect(blobPatterns.filter((pattern) => new RegExp(pattern).test(objectId))).toHaveLength(1);
    }
    for (const length of [0, 39, 41, 63, 65]) {
      const objectId = "a".repeat(length);
      expect(commitPatterns.some((pattern) => new RegExp(pattern).test(objectId))).toBe(false);
      expect(blobPatterns.some((pattern) => new RegExp(pattern).test(objectId))).toBe(false);
    }

    const algorithmRules = Object.fromEntries(schema.properties.source.allOf.map((rule) => [
      rule.if.properties.gitObjectAlgorithm.const,
      {
        commit: rule.then.properties.gitBaseCommit.pattern,
        blob: rule.then.properties.gitBlobIds.additionalProperties.pattern,
      },
    ]));
    expect(algorithmRules).toEqual({
      sha1: { commit: "^[a-f0-9]{40}$", blob: "^[a-f0-9]{40}$" },
      sha256: { commit: "^[a-f0-9]{64}$", blob: "^[a-f0-9]{64}$" },
    });

    const verifiedRule = schema.allOf.find((rule) => (
      rule.if?.properties?.capture?.properties?.kind?.const === "verified-command"
    ));
    expect(verifiedRule?.then?.required).toContain("observedAt");
    expect(verifiedRule?.then?.properties?.capture?.required).toEqual([
      "rawReportPath", "rawReportHashAlgorithm", "rawReportSha256",
    ]);
    expect(verifiedRule?.then?.properties?.source?.required).toEqual([
      "sourceManifestSha256", "sourceManifestEntryCount", "gitObjectAlgorithm", "gitBlobIds",
    ]);
    expect(new Set(verifiedRule?.then?.properties?.benchmark?.properties?.hashes?.required)).toEqual(new Set([
      "requestCorpusSha256", "oracleSha256", "fixtureFileSha256", "catalogFileSha256",
      "scorerFileSha256", "testFileSha256", "stableOutcomeSha256",
    ]));

    expect(() => requireRecordedCommitAvailable("0".repeat(40))).toThrowError(
      /depth >= 2.*full history\/unshallow/i,
    );
  });

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
      const recordedFixtureForRun = record.capture?.kind === "verified-command" && record.source
        ? fixtureAtRecordedCommit(record.source.gitBaseCommit)
        : undefined;
      const recordFixtureIds = recordedFixtureForRun
        ? new Set(recordedFixtureForRun.cases.map(({ id }) => id))
        : fixtureIds;
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
        expectUniqueKnownCaseIds(record.score0CaseIds, recordFixtureIds);
        for (const level of levelKeys) {
          expect(record.score0CaseIds.filter((id) => id.startsWith(`C100-L${level}-`))).toHaveLength(
            record.levels[level].total - record.levels[level].useful,
          );
        }
      }
      if (record.score1CaseIds !== null && record.score1CaseIds !== undefined) {
        expect(record.score1CaseIds).toHaveLength(record.scores["1"]);
        expectUniqueKnownCaseIds(record.score1CaseIds, recordFixtureIds);
        for (const level of levelKeys) {
          expect(record.score1CaseIds.filter((id) => id.startsWith(`C100-L${level}-`))).toHaveLength(
            record.levels[level].useful - record.levels[level].score2Or3,
          );
        }
      }
      if (record.deadEndCaseIds !== null && record.deadEndCaseIds !== undefined) {
        expect(record.deadEndCaseIds).toHaveLength(deadEndCount);
        expectUniqueKnownCaseIds(record.deadEndCaseIds, recordFixtureIds);
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
        if (!record.source || !record.benchmark || !record.capture.rawReportPath) {
          throw new Error(`${record.runId} omitted verified-run provenance.`);
        }
        expect(record.observedAt).toBeTruthy();
        expect(record.capture.rawReportHashAlgorithm).toBe("json-stringify-utf8-sha256-v1");
        expect(record.capture.rawReportSha256).toMatch(sha256Pattern);
        expect(record.source.sourceManifestAlgorithm).toBe("sha256-path-nul-bytes-nul-v1");
        expect(record.source.sourceManifestSha256).toMatch(sha256Pattern);
        expect(record.source.treeState).toBe("tracked-files-match-commit; untracked-files-excluded");
        expect(record.source.gitObjectAlgorithm).toBe(
          gitOutput(["rev-parse", "--show-object-format"]).toString("ascii").trim(),
        );
        const recordedFixture = recordedFixtureForRun ?? fixtureAtRecordedCommit(record.source.gitBaseCommit);
        const recordedFixtureById = new Map(recordedFixture.cases.map((testCase) => [testCase.id, testCase]));
        const recordedFingerprints = fixtureFingerprints(recordedFixture);
        expect(gitOutput(["cat-file", "-t", record.source.gitBaseCommit]).toString("ascii").trim()).toBe("commit");
        const sourceManifest = gitSourceManifest(record.source.gitBaseCommit);
        expect(record.source.sourceManifestEntryCount).toBe(sourceManifest.entryCount);
        expect(record.source.sourceManifestSha256).toBe(sourceManifest.sha256);

        const expectedBlobPaths = [...Object.values(verifiedSourceHashFields), ...Object.values(liveSourceHashFields)].sort();
        expect(Object.keys(record.source.gitBlobIds ?? {}).sort()).toEqual(expectedBlobPaths);
        for (const filePath of expectedBlobPaths) {
          const sourceBlob = gitBlobAt(record.source.gitBaseCommit, filePath);
          expect(record.source.gitBlobIds?.[filePath]).toBe(sourceBlob.objectId);
        }
        for (const [hashField, filePath] of Object.entries(verifiedSourceHashFields)) {
          const sourceBlob = gitBlobAt(record.source.gitBaseCommit, filePath);
          expect(record.benchmark.hashes[hashField]).toBe(sha256Bytes(sourceBlob.bytes));
        }
        for (const value of Object.values(record.benchmark.hashes)) {
          expect(value).toMatch(sha256Pattern);
        }

        const rawReportPath = resolveEvidencePath(historyDirectory, record.capture.rawReportPath);
        const rawReport = readJson<DeterministicRawReport>(rawReportPath);
        expect(canonicalJsonFileSha256(rawReportPath)).toBe(record.capture.rawReportSha256);
        expect(record.benchmark.fixtureSchemaVersion).toBe(recordedFixture.schemaVersion);
        expect(record.benchmark.suiteId).toBe(recordedFixture.suite.id);
        expect(record.benchmark.scoringPolicy).toBe(recordedFixture.suite.scoringPolicy);
        expect(record.benchmark.caseCount).toBe(recordedFixture.cases.length);
        expect(record.benchmark.hashes.requestCorpusSha256).toBe(recordedFingerprints.requestCorpusSha256);
        expect(record.benchmark.hashes.oracleSha256).toBe(recordedFingerprints.oracleSha256);
        const recordedLevelCounts = Object.fromEntries(levelKeys.map((level) => [
          level,
          recordedFixture.cases.filter((testCase) => String(testCase.level) === level).length,
        ]));
        expect(record.benchmark.levelCounts).toEqual(recordedLevelCounts);
        expect(rawReport.suiteId).toBe(record.benchmark.suiteId);
        expect(rawReport.scoringPolicy).toBe(record.benchmark.scoringPolicy);
        expect(rawReport.total).toBe(record.benchmark.caseCount);
        expect(rawReport.cases.map(({ id }) => id)).toEqual(recordedFixture.cases.map(({ id }) => id));
        rawReport.cases.forEach((rawCase) => {
          expect(rawCase.level).toBe(recordedFixtureById.get(rawCase.id)?.level);
          expect(rawCase.input).toBe(recordedFixtureById.get(rawCase.id)?.input);
        });
        const derivedScoreCounts = { "0": 0, "1": 0, "2": 0, "3": 0 };
        for (const rawCase of rawReport.cases) {
          if (![0, 1, 2, 3].includes(rawCase.score)) throw new Error(`Invalid score for ${rawCase.id}.`);
          derivedScoreCounts[String(rawCase.score) as keyof typeof derivedScoreCounts] += 1;
        }
        expect(rawReport.scoreCounts).toEqual(derivedScoreCounts);
        expect(record.scores).toMatchObject({
          ...rawReport.scoreCounts,
          score2Or3Count: rawReport.scoreCounts["2"] + rawReport.scoreCounts["3"],
          score2Or3Percent: rawReport.score2Or3Percent,
          atLeast1Count: rawReport.total - rawReport.scoreCounts["0"],
          atLeast1Percent: rawReport.atLeast1Percent,
          deadEndCount: rawReport.cases.filter(({ deadEnd }) => deadEnd).length,
          deadEndPercent: rawReport.deadEndPercent,
          unsafeSelectionCount: rawReport.unsafeSelectionCount,
          targetMet: rawReport.targetMet,
        });
        expect(record.levels).toEqual(rawReport.levels);
        expect(record.failureCategories).toEqual(rawReport.failureCategories);
        expect(record.performance).toEqual(rawReport.performance);
        expect(record.score0CaseIds).toEqual(rawReport.cases.filter(({ score }) => score === 0).map(({ id }) => id));
        expect(record.score1CaseIds).toEqual(rawReport.cases.filter(({ score }) => score === 1).map(({ id }) => id));
        expect(record.deadEndCaseIds).toEqual(rawReport.cases.filter(({ deadEnd }) => deadEnd).map(({ id }) => id));
        expect(rawReport.stableOutcomeSha256).toBe(deterministicStableOutcomeSha256(rawReport));
        expect(record.benchmark.hashes.stableOutcomeSha256).toBe(rawReport.stableOutcomeSha256);
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
      if (current.capture?.kind === "verified-command" && previous.capture?.kind === "transcribed-session-output") {
        expect(current.comparability?.status).toBe("conditional");
        expect(current.comparability?.reason).toMatch(/transcribed|raw output|source capture|safety gate/i);
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

  it("freezes every deterministic and live history artifact with exact coverage", () => {
    const deterministicFilenames = readdirSync(historyDirectory)
      .filter((filename) => /^run-\d{4}-[a-z0-9-]+\.json$/.test(filename))
      .sort();
    const deterministicRawDirectory = path.join(historyDirectory, "raw");
    const deterministicRawFilenames = readdirSync(deterministicRawDirectory)
      .filter((filename) => /^run-\d{4}-[a-z0-9-]+\.report\.json$/.test(filename))
      .sort();
    const liveSummaryFilenames = readdirSync(liveHistoryDirectory)
      .filter((filename) => /^live-\d{8}T\d{9}Z-[a-z0-9-]+\.json$/.test(filename))
      .sort();
    const liveRawDirectory = path.join(liveHistoryDirectory, "raw");
    const liveRawFilenames = readdirSync(liveRawDirectory)
      .filter((filename) => /^live-\d{8}T\d{9}Z-[a-z0-9-]+\.report\.json$/.test(filename))
      .sort();

    expect(deterministicFilenames).toEqual(Object.keys(frozenHistoricalHashes).sort());
    expect(deterministicRawFilenames).toEqual(Object.keys(frozenDeterministicRawHashes).sort());
    expect(liveSummaryFilenames).toEqual(Object.keys(frozenLiveSummaryHashes).sort());
    expect(liveRawFilenames).toEqual(Object.keys(frozenLiveRawHashes).sort());
    for (const [filename, expectedHash] of Object.entries(frozenHistoricalHashes)) {
      expect(canonicalJsonFileSha256(path.join(historyDirectory, filename))).toBe(expectedHash);
    }
    for (const [filename, expectedHash] of Object.entries(frozenDeterministicRawHashes)) {
      expect(canonicalJsonFileSha256(path.join(deterministicRawDirectory, filename))).toBe(expectedHash);
    }
    for (const [filename, expectedHash] of Object.entries(frozenLiveSummaryHashes)) {
      expect(canonicalJsonFileSha256(path.join(liveHistoryDirectory, filename))).toBe(expectedHash);
    }
    for (const [filename, expectedHash] of Object.entries(frozenLiveRawHashes)) {
      expect(canonicalJsonFileSha256(path.join(liveRawDirectory, filename))).toBe(expectedHash);
    }
  });

  it("binds active and historical fixtures without rewriting prior runs", () => {
    expect(cartiva100FixtureFingerprints()).toEqual(expectedCurrentFingerprints);

    const filenames = readdirSync(historyDirectory)
      .filter((filename) => /^run-\d{4}-[a-z0-9-]+\.json$/.test(filename))
      .sort();
    const latest = readJson<DeterministicHistoryRecord>(path.join(historyDirectory, filenames.at(-1)!));
    if (latest.capture?.kind === "verified-command" && latest.source && latest.benchmark) {
      const historicalFingerprints = fixtureFingerprints(fixtureAtRecordedCommit(latest.source.gitBaseCommit));
      expect(latest.benchmark.hashes.requestCorpusSha256).toBe(historicalFingerprints.requestCorpusSha256);
      expect(latest.benchmark.hashes.oracleSha256).toBe(historicalFingerprints.oracleSha256);
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
      expect(record.deterministicRunId).toMatch(/^run-\d{4}-[a-z0-9-]+$/);
      const deterministicRecordPath = path.join(historyDirectory, `${record.deterministicRunId}.json`);
      expect(existsSync(deterministicRecordPath)).toBe(true);
      const deterministicRecord = readJson<DeterministicHistoryRecord>(deterministicRecordPath);
      expect(deterministicRecord.capture?.kind).toBe("verified-command");
      if (!deterministicRecord.source || !deterministicRecord.benchmark || !deterministicRecord.capture) {
        throw new Error(`${record.deterministicRunId} cannot anchor live evidence.`);
      }
      const recordedFixture = fixtureAtRecordedCommit(deterministicRecord.source.gitBaseCommit);
      const recordedFixtureById = new Map(recordedFixture.cases.map((testCase) => [testCase.id, testCase]));
      const recordedLiveCaseIds = recordedFixture.cases
        .filter(({ liveKroger }) => liveKroger)
        .map(({ id }) => id)
        .sort();

      expect(Number.isNaN(Date.parse(record.checkedAt))).toBe(false);
      expect(Number.isNaN(Date.parse(record.recordedAt))).toBe(false);
      expect(Date.parse(record.checkedAt)).toBeLessThanOrEqual(Date.parse(record.recordedAt));
      expect(record.externalDataVolatile).toBe(true);
      expect(record.capture.rawReportHashAlgorithm).toBe("json-stringify-utf8-sha256-v1");
      expect(record.capture.rawReportSha256).toMatch(sha256Pattern);
      const rawReportPath = resolveEvidencePath(liveHistoryDirectory, record.capture.rawReportPath);
      const rawReport = readJson<LiveRawReport>(rawReportPath);
      expect(canonicalJsonFileSha256(rawReportPath)).toBe(record.capture.rawReportSha256);
      expect(record.hashes.rawReportSha256).toBe(record.capture.rawReportSha256);
      expect(record.hashes.deterministicReportSha256).toBe(deterministicRecord.capture.rawReportSha256);
      expect(record.hashes.sourceManifestSha256).toBe(deterministicRecord.source.sourceManifestSha256);
      expect(record.hashes.requestCorpusSha256).toBe(deterministicRecord.benchmark.hashes.requestCorpusSha256);
      expect(record.hashes.oracleSha256).toBe(deterministicRecord.benchmark.hashes.oracleSha256);
      for (const [hashField, filePath] of Object.entries(liveSourceHashFields)) {
        const sourceBlob = gitBlobAt(deterministicRecord.source.gitBaseCommit, filePath);
        expect(deterministicRecord.source.gitBlobIds?.[filePath]).toBe(sourceBlob.objectId);
        expect(record.hashes[hashField]).toBe(sha256Bytes(sourceBlob.bytes));
      }

      expectCredentialSafe(record);
      expectCredentialSafe(rawReport);
      expectConfiguredCredentialValuesAbsent(record);
      expectConfiguredCredentialValuesAbsent(rawReport);
      expect(rawReport.suiteId).toBe("cartiva-100-kroger-live");
      expect(record.validationScope).toBe(
        "retailer-handoff-readiness; identity and package validity are evaluated separately from confirmed in-stock availability",
      );
      expect(rawReport.checkedAt).toBe(record.checkedAt);
      expect(rawReport.retailerCalls).toBe(record.execution.retailerCalls);
      const rawCounts = {
        matched: rawReport.cases.filter(({ status }) => status === "LIVE_PASSED").length,
        blocked: rawReport.cases.filter(({ status }) => status === "EXTERNAL_BLOCKED").length,
        failed: rawReport.cases.filter(({ status }) => status === "LIVE_FAILED").length,
      };
      expect({ matched: rawReport.matched, blocked: rawReport.blocked, failed: rawReport.failed }).toEqual(rawCounts);
      expect(rawReport.status).toBe(rawCounts.failed
        ? "LIVE_FAILED"
        : rawCounts.blocked ? "EXTERNAL_BLOCKED" : "LIVE_PASSED");
      const availabilityUnconfirmedCases = rawReport.cases.filter((rawCase) => (
        rawCase.status === "EXTERNAL_BLOCKED"
        && rawCase.selectedProduct?.availabilityStatus === "likely_available"
        && /verified in-stock availability is required/i.test(rawCase.reason)
      ));
      const identityPackageVerifiedCases = rawReport.cases.filter((rawCase) => (
        rawCase.status === "LIVE_PASSED"
        || availabilityUnconfirmedCases.some(({ id }) => id === rawCase.id)
      ));
      const selectedCount = rawReport.cases.filter(({ selectedProduct }) => selectedProduct).length;
      expect(record.counts).toEqual({
        selected: selectedCount,
        identityPackageVerified: identityPackageVerifiedCases.length,
        handoffReady: rawCounts.matched,
        ...rawCounts,
        availabilityUnconfirmed: availabilityUnconfirmedCases.length,
      });
      expect(record.counts.handoffReady).toBe(record.counts.matched);
      expect(record.counts.identityPackageVerified).toBeGreaterThanOrEqual(record.counts.handoffReady);
      expect(record.counts.identityPackageVerified).toBeLessThanOrEqual(record.counts.selected);
      expect(record.counts.availabilityUnconfirmed).toBeLessThanOrEqual(record.counts.blocked);
      expect(record.execution.runnerStatus).toBe(rawReport.status);
      expect(record.execution.retailerCalls).toBeGreaterThanOrEqual(0);
      expect(Object.keys(record.execution.credentialsConfigured).length).toBeGreaterThan(0);
      expect(Object.values(record.execution.credentialsConfigured).every((value) => typeof value === "boolean")).toBe(
        true,
      );
      for (const value of Object.values(record.hashes)) expect(value).toMatch(sha256Pattern);

      if (record.execution.disposition === "COMPLETED") {
        expect(["LIVE_PASSED", "LIVE_FAILED", "EXTERNAL_BLOCKED"]).toContain(record.execution.runnerStatus);
        expect(record.execution.retailerCalls).toBeGreaterThan(0);
        expect(rawReport.cases.map(({ id }) => id).sort()).toEqual(recordedLiveCaseIds);
        expect(record.cases.map(({ caseId }) => caseId).sort()).toEqual(recordedLiveCaseIds);
        expect(record.counts.selected).toBe(recordedLiveCaseIds.length);
        expectUniqueKnownCaseIds(
          record.cases.map(({ caseId }) => caseId),
          new Set(recordedFixture.cases.map(({ id }) => id)),
        );
        for (const rawCase of rawReport.cases) {
          expect(rawCase.input).toBe(recordedFixtureById.get(rawCase.id)?.input);
        }
        if (record.execution.runnerStatus === "LIVE_PASSED") {
          expect(record.counts).toMatchObject({
            handoffReady: recordedLiveCaseIds.length,
            matched: recordedLiveCaseIds.length,
            blocked: 0,
            failed: 0,
          });
        } else if (record.execution.runnerStatus === "LIVE_FAILED") {
          expect(record.counts.failed).toBeGreaterThan(0);
        } else {
          expect(record.counts.blocked).toBeGreaterThan(0);
          expect(record.counts.failed).toBe(0);
        }
        expect(record.store?.id).not.toBe("");
        expect(record.store?.name).not.toBe("");
        expect(record.store?.zipCode).toMatch(/^\d{5}$/);
        expect(record.cases).toHaveLength(recordedLiveCaseIds.length);
        expect(record.store).toEqual(rawReport.location && {
          id: rawReport.location.locationId,
          name: rawReport.location.name,
          chain: rawReport.location.chain,
          zipCode: rawReport.location.zipCode,
        });
      } else {
        expect(record.execution.runnerStatus).toBe("EXTERNAL_BLOCKED");
      }

      const expectedCases = rawReport.cases.map((rawCase) => {
        const product = rawCase.selectedProduct;
        return {
          caseId: rawCase.id,
          status: rawCase.status === "LIVE_PASSED"
            ? "HANDOFF_READY"
            : rawCase.status === "LIVE_FAILED" ? "FAILED" : "EXTERNAL_BLOCKED",
          checkedAt: product?.checkedAt ?? rawReport.checkedAt,
          attempts: rawCase.searchAttempts.map(({ query, resultCount }) => ({ query, resultCount })),
          returnedCandidateCount: rawCase.returnedCandidateCount,
          reason: rawCase.reason,
          ...(product ? {
            selectedProduct: {
              productId: product.productId,
              upc: product.upc,
              description: product.title,
              ...(product.brand === undefined ? {} : { brand: product.brand }),
              ...(product.productType === undefined ? {} : { productType: product.productType }),
              ...(product.size === undefined ? {} : { size: product.size }),
              priceCents: product.priceCents,
              quantity: product.cartQuantity,
              packageCount: product.packageCount,
              availability: product.availabilityStatus,
              locationId: product.locationId,
              checkedAt: product.checkedAt,
              sourceUrl: product.sourceUrl,
            },
          } : {}),
        };
      });
      expect(record.cases).toEqual(expectedCases);

      for (const rawCase of rawReport.cases) {
        expectNonnegativeInteger(rawCase.returnedCandidateCount);
        expect(rawCase.resolvedRequest?.trim()).toBeTruthy();
        for (const attempt of rawCase.searchAttempts) {
          expect(["normalized", "simplified", "broader"]).toContain(attempt.level);
          expect(attempt.query.trim()).not.toBe("");
          expectNonnegativeInteger(attempt.resultCount);
        }
      }
      for (const liveCase of record.cases) {
        expect(Number.isNaN(Date.parse(liveCase.checkedAt))).toBe(false);
        expect(Date.parse(liveCase.checkedAt)).toBeLessThanOrEqual(Date.parse(record.checkedAt));
        for (const attempt of liveCase.attempts) {
          expect(attempt.query.trim()).not.toBe("");
          expectNonnegativeInteger(attempt.resultCount);
        }
        if (liveCase.selectedProduct) {
          expect(liveCase.attempts.length).toBeGreaterThan(0);
          expect(liveCase.selectedProduct).toMatchObject({ quantity: expect.any(Number), packageCount: expect.any(Number) });
          expect(liveCase.selectedProduct?.productId).not.toBe("");
          expect(liveCase.selectedProduct?.upc).not.toBe("");
          expect(liveCase.selectedProduct?.description).not.toBe("");
          expectNonnegativeInteger(liveCase.selectedProduct?.priceCents ?? -1);
          expectNonnegativeInteger(liveCase.selectedProduct?.quantity ?? -1);
          expectNonnegativeInteger(liveCase.selectedProduct?.packageCount ?? -1);
          expect(liveCase.selectedProduct?.quantity).toBeGreaterThan(0);
          expect(liveCase.selectedProduct?.packageCount).toBeGreaterThan(0);
          expect(liveCase.selectedProduct?.locationId).toBe(record.store?.id);
          expect(liveCase.selectedProduct?.checkedAt).toBe(liveCase.checkedAt);
          expect(liveCase.selectedProduct?.sourceUrl).toMatch(/^https:\/\//);
        }
        if (liveCase.status === "HANDOFF_READY") {
          expect(liveCase.selectedProduct).toBeDefined();
          expect(liveCase.selectedProduct?.availability).toBe("in_stock");
          expect(liveCase.reason).toMatch(/handoff ready/i);
        }
        if (liveCase.status === "EXTERNAL_BLOCKED" && liveCase.selectedProduct) {
          expect(liveCase.selectedProduct.availability).toBe("likely_available");
          expect(liveCase.reason).toMatch(/verified in-stock availability is required/i);
        }
      }
    }
  });
});
