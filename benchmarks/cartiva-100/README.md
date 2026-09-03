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
