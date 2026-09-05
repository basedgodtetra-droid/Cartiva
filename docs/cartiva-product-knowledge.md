# Cartiva product knowledge — September 5, 2026

## Architecture

UNDERSTAND (existing parser/facets) → KNOWN BEFORE SEARCH (shared D1) → SEARCH
(maximum 3 queries plus at most 1 historical-UPC refresh) → VERIFY (unchanged
hard-intent matcher) → FULFILL (current package arithmetic) → LEARN (bounded
post-response work) → REMEMBER (durable identity and evidence).

This is an additive architecture, not an LLM prompt or a replacement matcher.
No retailer authentication, token, cart operation, saved-list, or saved-basket
table was changed. No API calls occur while typing. The only workspace UI
addition is inside existing Match details.

## Storage and trust

The existing Sites D1 database is authoritative. Vercel uses Cartiva's existing
signed, fixed-destination bridge; no new database or credentials are required.
Generated Drizzle migrations add eight `cartiva_*` tables and indexes. They do
not recreate, rename, or migrate the five existing Kroger handoff tables.

| Data | Storage / influence |
| --- | --- |
| Canonical concepts, aliases | Reviewed vocabulary only; inferred mappings provisional |
| Contradictions and category semantics | Versioned curated facts, separate from preference |
| Retailer UPC, title, brand, package | Identity-only type; never a hydrated current offer |
| Successful query | Exact candidate-to-query attribution; hint before normal search |
| Failed query | Dated evidence; never a permanent catalog blacklist |
| Price/inventory | Separate store/fulfillment/time observation; current TTL 120 seconds |
| Package solution | Historical evidence only; quantities recalculated for this request |
| Shopper acceptance/rejection/substitution | Receipt-bound, idempotent, provisional review evidence |

Curated seed data is a separate idempotent named operation, not embedded in a
schema migration. The first supported comparison schedules it after the
response if the current foundation version is absent. Maintainers can also
run the CLI seed operation. Knowledge outages skip memory and preserve normal
comparison/recovery. Background work has a 20-second scheduling budget and
four-second bridge request deadlines; there is no unbounded retry loop.

Only official, currently verified candidates can generate successful product
observations. A remembered query can change retrieval order, but cannot change
current constraints, confidence, selected store, fulfillment, or package
requirements. Existing safe-preference ranking remains below hard checks.
Known UPCs are a last bounded recovery step and are freshly loaded through the
official product endpoint. They do not supply cached price or stock.

Query quality uses the current knowledge version and the last 90 days of
evidence, with freshness weighting. Weak inferred confidence has a 90-day
half-life. Current query ordering always preserves the final cold-plan
fallback. Recent query evidence is indexed; expired offer observations are
pruned in bounded batches. Identity can outlive offer observations.

## Corrections and privacy

The first-party web stream optionally contains encrypted, 15-minute feedback
evidence bound to a separate signed HTTP-only browser cookie, the current
intent digest, item, quantity, store, fulfillment and actual offered UPCs.
Receipts are kept only in the active comparison, not historical snapshots.
Mobile/extension read boundaries retain their existing stream contracts.

`This matches`, `Not what I meant`, and candidate choices create structured
feedback. A compatible alternative triggers full server revalidation with a
preferred product hint. A substitution requires explicitly editing the list;
it never silently clears dietary/package/variant requirements. Existing
uncertain-cart barriers remain in force. Failed feedback keeps the basket and
shows a truthful retry/edit message.

One receipt can add one logical signal, even with new transport nonces or
changed choices. Cookie rotation is not evidence of independent humans.
One or 100 shoppers cannot automatically promote an alias or a global negative
rule. Corrections are quarantined for taxonomy/catalog corroboration or
maintainer review. They are not claimed as confirmed equivalence. Rejection
does not teach retailer unavailability.

No full request, recipe, address, email, personal explanation, account ID,
password, or token is stored in global knowledge. The vocabulary allowlist
and raw-marker checks operate before destructive normalization. Unsupported
words still search normally, but do not train global memory. Fixture source
records are rejected in production. Benchmarks use isolated temporary SQLite
databases and never train the live catalog.

## Permanent checks and commands

- `pnpm test:knowledge`: real SQLite persistence, explicit query-string
  cold/warm oracle, privacy, replay, poisoning, freshness, wrong identity,
  missing/changed historical SKU and new-store quantity regressions.
- `pnpm test:cartiva100` and `pnpm test:cartiva500`: original suites retained.
- `pnpm test:discovery:browser http://localhost:3006/compare`: isolated browser
  fault injection, responsive containment, feedback/selection, saved state,
  and handoff regressions. Never a real cart write.
- `pnpm knowledge inspect "coke zero"`: maintainer-only inspection using
  existing server bridge environment. Does not print credentials or current
  offer claims. No public developer/admin route exists.
- `pnpm knowledge seed`: idempotently apply reviewed foundation vocabulary.
- `pnpm db:generate`: generate append-only schema migrations. Do not edit an
  already deployed migration or its journal.

## Measured results before publishing

Controlled 15-case query-string benchmark across dairy, meat, produce, canned,
beverage, pantry and household categories. The database is closed/reopened
between passes; response prices change on the warm pass. Query responses
depend on the actual query string, not an attempt/stage counter.

| Measure | A: cold | B: durable warm |
| --- | ---: | ---: |
| Correct matches | 15/15 | 15/15 |
| Search calls | 30 | 15 |
| Detail calls | 0 | 0 |
| Clarifications | 0 | 0 |
| Local mean read/search/verify latency, isolated run | 6.77 ms | 2.28 ms |

Latency is a local deterministic measurement, not a production speed promise.
The fixture intentionally exercises fallback learning. It is not a sample
from which to infer general shopper conversion or universal grocery coverage.

- CARTIVA 100: 64 automatic, 36 clarification, 0 unsafe/dead ends.
- CARTIVA 500: 502 retained cases; 309 automatic, 193 clarification,
  0 unsafe/dead ends. No difficult cases removed.
- Live Kroger regression subset: 12/12 handoff-ready, 15 retailer calls,
  approximately 30 seconds, store 03500529. Search only; no customer cart write.
- Isolated browser: 12 scenario groups passed, including six widths
  (320/375/390/430/768/1024), candidate revalidation, feedback failure,
  unchanged quantities/store, saved-list reload and handoff safeguards.
- Full automated suite: 117 files / 2,173 tests passed, including 33 focused
  knowledge tests. Both Next.js and Sites builds pass.
- Deployed Sites and Vercel: the same seven-item live basket passed 7/7 on
  each host, with seven fresh product searches each and no local cache hits.
  The live database contains the actual successful query and retailer identity
  records. Reviewed foundations were seeded after the response. Live tests
  did not pretend to be shopper-confirmed feedback or write a Kroger cart.
- Production npm lockfile synchronized with the existing Vercel install
  command; no existing package version was upgraded as part of this repair.
  New Drizzle development tools bring their own additional transitive builds.

## Discovery and remaining work

Keep every real false match as a regression; add a reviewed contradiction
only when it is a real identity conflict. This pass discovered and retained
regressions for a stale query evicting the final fallback and private markers
being lost during normalization. Gluten-free white bread is valid; color and
diet are not contradictory categories.

The architecture supports expanding to CARTIVA 1000 without replacing 100/500.
This pass does not claim a newly validated 1000-case catalog or 97% real-world
coverage. Additional international vocabulary, parser-correction aggregates,
and automatic promotion based on independently corroborated retailer taxonomy
remain deliberate follow-up work. Current corrections aid the active choice
and maintainer review; they do not automatically rewrite global semantics.

Real authenticated cart transfer still requires a shopper's authorized Kroger
session. Existing integration/fault-injection tests passing is not proof of a
new live customer-cart write; do not report one without observing it.
