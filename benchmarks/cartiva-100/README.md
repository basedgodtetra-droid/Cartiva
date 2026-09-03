# CARTIVA 100 run history

This directory keeps immutable summaries from meaningful Cartiva 100 runs.
The deterministic fixture and scorer live under `tests/fixtures` and
`tests/support`; `pnpm test:cartiva100` reruns the same 100 shopper requests.

Rules:

- Never replace or delete an original benchmark case because it fails.
- Add real shopper regressions as new cases instead of weakening an oracle.
- Never overwrite an existing run file.
- Compare runs only when their request corpus, oracle revision, fixture schema, and scoring policy match.
- Keep live Kroger checks separate because inventory and store results change.
- The original 100 cases and 20 cases per level are floors, not ceilings; append
  newly discovered regressions so this suite can grow without deleting history.
- Any unsafe automatic selection fails the benchmark even when percentage
  thresholds would otherwise pass.
- Persist content hashes and a stable per-case outcome digest for verified runs.

## Evidence layout

- `history/run-*.json` contains the immutable deterministic summaries.
- `history/raw/*.report.json` contains the complete reports emitted by verified
  deterministic commands.
- `history/live/live-*.json` contains immutable Kroger-run summaries.
- `history/live/raw/*.report.json` contains the complete, credential-safe live
  reports. Live evidence is a store-and-time observation, not a timeless claim
  about availability.

Live reporting keeps product intelligence separate from retailer readiness.
`identityPackageVerified` means the selected SKU and fulfillment passed the
independent identity/package checks. `HANDOFF_READY` and `handoffReady` require
confirmed `in_stock` availability as well. A completed run may therefore have
top status `EXTERNAL_BLOCKED`: this is an honest availability limitation, not a
matcher failure. `availabilityUnconfirmed` counts only selected products whose
identity/package checks passed but whose retailer metadata reported
`likely_available`; those cases must never be relabeled as handoff-ready.

The `rawReportSha256` value uses SHA-256 over UTF-8
`JSON.stringify(JSON.parse(reportFile))`, matching the string emitted by the
benchmark command. It is intentionally different from a byte-for-byte hash of
the pretty-printed file. Verified deterministic summaries must derive their
scores, level totals, failures, performance, unresolved case IDs, safety count,
and stable outcome digest from that retained raw report.

The source manifest is computed from the exact recorded Git commit. Sort full
repository paths by raw path bytes, then hash each path, a NUL byte, its Git blob
bytes, and another NUL byte. Working-tree files and line-ending conversion must
not be used. Named Git blob IDs and SHA-256 file hashes additionally bind the
fixture, catalog, deterministic runner/test, and live runner/tests.

History validation therefore requires each verified run's recorded commit to be
present in the local Git object database. A shallow or source-only checkout must
fetch history with depth >= 2 including the recorded commit, or fetch full
history/unshallow the checkout, before running the history test. The test fails
with that recovery guidance when a commit is unavailable; it must never fall
back to today's fixture because CARTIVA 100 is intentionally allowed to grow.
Both deterministic cases and the selected live subset are checked against the
fixture blob from their own recorded commit.

A verified run that follows a transcribed run is marked `conditional` even when
the corpus and oracle match: the score is useful trend evidence, but the older
run lacks equivalent raw-output, source-manifest, and safety-gate proof. History
tests freeze every summary and raw artifact with exact filename coverage, so a
new run must be deliberately registered rather than silently escaping the
append-only checks.
