# Cartiva discovery loop — 4 September 2026

## Scope and evidence standard

This pass preserves Cartiva's interface, exact-product matching, complete-basket rules, official Kroger integration and historical-price labeling. No competitor redesign, fabricated prices, forced matches, new tracking, account creation, purchases, or Crystala changes.

Three read-only investigations mapped parsing/planning, shopper state, and security before implementation. The owner then reproduced issues, implemented generalized fixes, added permanent tests, ran regressions, and explored different failure surfaces. Tests are deterministic where stated; a mocked cart acceptance is not a real Kroger cart update.

## Product map and feature inventory

| Surface / feature | Implementation | Assumption challenged / coverage |
|---|---|---|
| Home, product explanation | `/`, `/how-it-works`, `/about`, home components | The first action is visible; demo content is not live evidence. Route/build and browser checks. |
| Grocery workspace | `/compare`, `cartiva-workspace`, `cartiva-grocery-list`, `cartiva-comparison` | Immediate entry, quantities, edits, duplicate occurrences, changing plans, aligned panels. Browser state tests. |
| Typed and pasted lists | shared `list-parser`, `grocery-notepad`; lib re-exports | Punctuation, capitalization, whitespace, typos, modifier boundaries, fractions, numeric limits.400 generated variations plus explicit regressions. |
| Clarifications | shared notepad, protein origins, workspace row controls | Answers stay attached to the correct occurrence after edits/deletion; unresolved input has an edit path. Fragment/planner/state suites. |
| Product intent and taxonomy | `product-knowledge`, `product-search-intent`, `product-facets`, `matching`, `kroger-products` | Wrong variant must not win; coconut milk/peanut butter are not automatically dairy; generic intent does not invent constraints.100/500 and category suites. |
| Quantity/package fulfillment | `measurements`, shared package grammar/comparison session, package fulfillment | Total needed differs from package size; fractions remain physical amounts; exact multipacks stay requirements. Dedicated package and new discovery tests. |
| ZIP, store and fulfillment | workspace location state; `/api/kroger/locations` | Out-of-order responses cannot restore old ZIP/store; selected preference revalidated, never old prices. Browser race test. |
| Comparison/loading/retry | `/api/kroger/search`, search pipeline, stream events | No API calls per keystroke; bounded requests, duplicate click protection, malformed/truncated streams are transport failures, not No match. Browser and decoder tests. |
| Kroger retailer adapter | `kroger-provider`, retailer adapter registry | Collection shape, exact store evidence, string UPC, finite price, stock uncertainty. Provider/live tests. |
| Other retailer adapters | `/api/search`, `/api/target/search`, Walmart/Target provider modules | Experimental adapters stay separate; unavailable retailers remain visibly unconnected in main workspace. No forced shopping totals. |
| Basket/details/subtotal | comparison, basket and handoff helpers | Only complete eligible baskets compete; explicit out-of-stock differs from unknown; quantities preserve exact UPCs. Eligibility and basket suites. |
| Saved lists | `/lists`, `/library`, library provider |25-item legacy caps must not truncate50-row work; storage failures cannot say Saved. Pure round-trip and browser quota/retry tests. |
| Saved baskets | `/baskets`, local-library historical records | Persist retailer/store/products/quantities/timestamp/provenance; old prices remain historical.50-row tests. |
| Price history/recent activity | `/history`, utility rail, library records | Basket trends require actual composition; product history already separates UPC/package/store/fulfillment. Fingerprint regressions. |
| Build My Plan | workspace creation tabs, `cartiva-planning`, reconciliation | Calories/protein/budget can conflict; preferences/allergies apply to actual ingredients and boosters, not template tags only. Planner/exclusion/reconciliation suites. |
| Recipe import | recipe importer, planning extraction | Fractions, liters, optional items, mixed instructions, invalid amounts. New extraction tests; failure gives edit/retry. |
| Kroger OAuth | auth status/start/callback/disconnect; compatibility `/api/retailers/kroger/oauth/callback`; `kroger-auth`, web session | State/PKCE, cancellation, duplicate/expired callback, token refresh, popup opener policy. Auth/session tests plus real two-origin browser-policy probe. |
| Cart transfer/recovery | `/api/kroger/cart`, pending cart journal, operations, receipt/family-link helpers | Authenticate before replay; same operation cannot replay across account generation; uncertain writes stay review-required. Route, receipt, browser mock tests. |
| Extension surfaces | `/api/extension/{search,stores,suggestions,target/search,kroger/*}`, extension source | Explicit extension-origin allowlist, legacy loopback auth scope, shared parser. Existing suites preserved; no extension-store installation test. |
| Mobile API/app | `/api/mobile/v1/{session,session/renew,capabilities,kroger/*}`, mobile services/state | Owner session, renewal, operation recovery, exact receipt bounds. Existing chaos suites and50-line recovery regression. Native iOS keyboard/device behavior still requires hardware testing. |
| Navigation/responsive/accessibility | shell/sidebar/mobile nav, shared CSS | Focus-visible, tab semantics, Escape/focus restoration, status text, reduced motion, scrollable actions. Browser widths320/375/390/430/768/1024/1440; existing semantic tests. |
| Trust/legal | `/data-sourcing`, `/retailer-independence`, `/privacy`, `/terms`, `/accessibility`, `/contact`, `/faq` | No payment processing claim, retailer-controlled checkout/store/availability, historical/estimated labels. Static copy/route review; not a legal opinion. |
| Prototype | `/prototype`, legacy/Figma assets | Separate non-production direction. User's untracked `figma-export/` left untouched. |

### Deployment/configuration map

Next16.3.2 serves Vercel; vinext/Vite builds the Sites Worker. Installed Next documentation was consulted before edits. Both configurations now preserve supported cross-origin OAuth popups.

Server-only configuration includes Kroger client ID/secret, exact redirect URI, web-session signing secret; optional Walmart/Target provider keys; mobile session and callback settings. Public-origin hints restrict API origins. No secret values appear in this report. The approved follow-up adds a dedicated shared-state secret and private bridge configuration only; existing retailer credentials and callback URLs are preserved.

An existing Sites `DB` contains Kroger operation, comparison, customer-session, OAuth-state and rate-limit tables. Following the user's explicit full-access approval, the source reconnects that logical binding without schema changes, migrations, historical-row reads, or destructive cleanup. Sites uses native D1; Vercel uses a fixed HTTPS, HMAC-authenticated private Sites bridge. Both retain their own registered callback origins. New web owners are namespaced `web2:`; legacy customer data is untouched. Browser cookies hold a signed opaque owner, not retailer tokens. Older token cookies require one reconnect and are never imported automatically. Local/extension and mobile storage modes retain their existing boundaries; this is not a mobile multi-instance rollout.

## Reproducible issues and fixes

| Priority / ID | Reproduction and root cause | Resolution / permanent regression |
|---|---|---|
| P0 D01 OAuth appears cancelled | `COOP:same-origin` detaches a live cross-origin popup, making WindowProxy.closed true. | Both hosts use same-origin-allow-popups; closed alone no longer proves cancellation. Browser opens a real second-origin test page; explicit callback cancellation remains supported. |
| P1 D02 Unauthorized receipt replay | Cached completed operation returned200 before authentication. | Valid token and authorization generation required before lookup; generation included in fingerprint; raw operation ID unchanged; conflicting replay is review-required. Route test covers replay/disconnected/changed account with one total write. |
| P1 D03 Fraction inflation | `ground beef 1/2 lb`, `½ lb`, `1½ lb`, `.5 lb`, decimal comma parsed as wrong weight. | One shared measurement normalization before segmentation. Ratios protected from decimal-comma conversion. Fraction/ratio tests plus all108 fragment regressions. |
| P1 D04 Invalid quantities silently become1 | Zero, negative, denominator0, x100, fractional each,100 cans. | Useful clarification/edit instead of fallback quantity; recipes validate before and after parenthetical multiplication. Explicit numeric regressions. |
| P1 D05 Planner violates exclusions | Milk alias, coordinated/Oxford lists, vegan, gluten-free and soy constraints missed tags/boosters. | Canonical restrictions applied to actual template and booster ingredients; unknown allergy rejected rather than promised support. Regenerate/replace tests. This is ingredient screening, not a medical/cross-contamination guarantee. |
| P1 D06 Quantity moves after deletion | coffee/rice/bananas with banana override; delete coffee, banana reverts. IDs include position. | Remap occurrence-specific overrides and protein origins; changed explicit quantities can replace old override.100 seeded transitions and browser deletion test. |
| P1 D07 Saved50-row work disappears | Workspace accepts50 but library validation capped25. | Shared50-item bound for snapshots/products/quantities;50-row historical basket round-trip test. |
| P1 D08100-row list silently truncates | Rendering50 then editing a row rewrites only displayed items. | Count omitted rows correctly; preserve full input; explicit full-list recovery before row mutations/comparison. Browser100-row test. |
| P1 D09 Stale ZIP response wins | Resolve ZIP B before earlier ZIP A. | Abort/generation guards, context invalidation, preferred store preserved/revalidated. Browser delayed-response race. |
| P1 D10 False Saved / corrupt storage | Quota denial claims success; object/string quantity can crash or concatenate. | Validate quantities, expose failed persistence with Retry saving, gate Saved/bookmark/plan claims on successful snapshot. Browser failure/recovery test, pure corrupt-value test. |
| P1 D11 Malformed retailer response is No match | API `{data:null}` or object collection accepted as empty. | Reject malformed envelope with recoverable bad_response; legitimate empty array remains supported. Provider/network regressions. |
| P1 D12 Numeric UPC loses identity | Numeric provider UPC loses leading zeros but becomes verified string. | Require provider UPC string; regression preserves leading zeros. |
| P1 D13 Long cart receipt rejected | Server accepts50×99; receipt/mobile recovery retained24×99 limits. |50-line/4950-unit bounds plus quantity-to-line consistency. Mobile recovery tests. |
| P1 D14 Cross-shopper rate collision | All shoppers at same Origin spend one bucket. | Trusted Vercel platform IP partition; other proxy headers require explicit trusted-edge topology; coarse fallback remains documented. Spoofing/isolation tests. |
| P1 D15 Indefinite network wait | Headers arrive but body never completes; preflight/start unbounded. | Full response deadline for preflight/start/cart; submitted cart timeout remains unknown, never automatic retry. Stalled headers/body tests. |
| P1 D16 Truncated comparison looks unavailable | Null/out-of-range events crash or missing rows become truly_unavailable. | Runtime event validation and all-item completion check;150-second comparison bound; synchronous in-flight guard; cancel stale requests. Browser malformed/partial/retry tests. |
| P2 D17 Orphan modifiers silently disappear | `93/7,ground beef` or standalone `2 lb`. | Prefix attaches within segment; unattached modifier preserved as visible full-list repair requirement. Parser tests. |
| P2 D18 History compares unlike baskets | Same request with different actual UPC/package shared basket fingerprint. | Composition-v2 fingerprint includes actual UPC/package/resolved quantity; changed price alone stays comparable. Library tests. |
| P2 D19 Recipe noise/units | Dice onions becomes ingredient; liters/optional marker mishandled. | Skip directions without discarding later ingredient lines; liters normalized; optional retained; invalid extraction is recoverable. Recipe tests. |
| P2 D20 Saved basket/new-list context | Old full-list editor or unrelated preferred store carried into new work. | Reset editor; restore historical basket's store preference but require fresh lookup/prices. State audit and shared browser reload coverage. |
| P1 D21 Populated mobile basket overlaps footer | Screenshot review found rows rendered beyond their zero-basis flex region; subtotal covered products and footer overlapped them. Horizontal-only tests missed it. | Mobile list/basket content uses natural flex basis; explicit vertical-containment assertions ensure rows precede subtotal and comparison precedes footer. |
| P1 D22 Mobile API excluded from deployment | Production capabilities endpoint returned404. `.vercelignore` used unanchored `mobile/`, excluding all11 tracked `app/api/mobile` routes as well as the separate client. | Root-only client/artifact exclusions are now anchored. Permanent deployment-input regression reproduced11 unintended exclusions before the fix and0 after it, while retaining root client exclusions. Both live hosts now return200 JSON capabilities and401 JSON for unauthenticated mobile status. |
| P1 D23 Serverless auth/cart state is instance-local | Cold instances can refresh the same rotating token or lose a cart receipt; an unknown write must not become retryable after a restart. | Existing D1 tables now coordinate versioned sessions, one-use OAuth state, fenced owner leases, atomic cart claims, attempt-specific terminal writes and permanent unknown-outcome guards. Private bridge uses independent request MAC, timestamp and durable replay protection. Production web fails closed if storage is unavailable. Real SQLite and route integration tests cover independent clients, duplicate callbacks, refresh uncertainty, corruption, accepted PUT plus failed storage and explicit review. |
| P1 D24 Disconnect releases a running transfer barrier | Disconnect while PUT is unresolved, then acknowledge and retry before its response. | Revoke clears credentials/increments version but retains active lease until the original request releases or expires. Exact random lease releases cannot release a newer request. Permanent SQL regression verifies early acknowledgement rejected. |
| P1 D25 Background status burns OAuth callback | Hold owner lease, receive valid callback: consuming state before acquisition makes a retry invalid without ever exchanging code. | Acquire lease before consuming state; busy callback preserves cookies/state and offers retry. Cancellation still consumes state. GET start uses mutable redirect response headers, avoiding native immutable-header failure. |
| P1 D26 Cutover review has no reconnect action | Old browser blocked marker plus absent/expired new owner cookie returns401 while transfer is disabled. | Authentication-only reconnect preserves blocked basket and never calls cart transfer. Confirmed review is still required. Failed acknowledgement retains work; late responses clear only their captured pending ID, preserving another tab's newer marker. Permanent browser regression covers all three paths. |

Deployment exclusion semantics were checked against [Vercel's `.vercelignore` documentation](https://vercel.com/docs/deployments/vercel-ignore). The source-boundary regression tests all tracked routes and their shared dependencies, rather than only the first missing endpoint.

## Discovery passes and actual results

1. Baseline:111 files /1,633 tests passed. Live subset12/12,15 retailer calls. This demonstrated gaps in existing tests, not a bug-free product.
2. Pass1: parser/plan properties, occurrence state, persistence limits, provider/auth review. First full rerun caught6 ratio regressions introduced by decimal-comma normalization; fixed the generalized boundary, kept all hard tests.
3. Pass2 deliberately changed areas: Oxford-list allergies, parenthetical amounts, storage quota/corruption, response bodies, malformed/truncated streams, stale ZIP responses, receipt account binding, double clicks, browser opener policy. Added permanent regressions and reran everything.
4. Final full suite before publishing:113 files /2,104 tests. Original benchmark fixtures are unchanged. Screenshot review caught D21 after horizontal checks passed; vertical containment was added to avoid repeating that blind spot.
5. Follow-up deployment discovery: read-only production API probe found D22. Regression failed with11 excluded routes before the fix and passed afterward. Full suite:114 files /2,106 tests; Next build passed with all mobile routes. No authentication/cart behavior or database schema changed in this follow-up.
6. Follow-up rollout verified: Vercel and Sites both serve mobile capabilities as200 JSON (`ANONYMOUS_READ_ONLY`), mobile status as401 JSON without a session, web status as200 JSON with same-origin context, and comparison as200 HTML. Native probes omit Origin as required by the mobile API; unconfigured browser origins remain403. The deployed Vercel browser suite passed all10 scenario groups again. Sites owner-only access is unchanged.

| Suite | Actual outcome |
|---|---|
| CARTIVA100 |64 score3;36 score2;0 score1/0.100% score2+.0 unsafe selections/dead ends in deterministic corpus. |
| CARTIVA500 (502 retained cases) |309 score3;193 score2;0 score1/0.100% score2+.0 unsafe selections/dead ends in deterministic corpus. |
| Item-fragment regression |108/108 pass. |
| Real Kroger subset, repeated after fixes |12/12 handoff-ready;0 blocked/failed;15 calls;~30 seconds; Capitol Ave03500529,75204. Covers dairy/meat/produce/canned/beverage/pantry/household. No cart write. |
| Discovery browser |10 scenario groups: immediate entry; quantity retention;1/5/10/20/50/100 rows; ZIP race;500/malformed/partial recovery; authenticated mocked transfer double-click;50-row reload; quota/retry; mobile results; cross-origin popup policy. |
| Responsive layout |320/375/390/430/768/1024/1440:0 horizontal overflow.10/20/50 desktop rows:0px panel top/height difference; actions visible, contained scrolling. |
| Perceived/local speed |Typing causes0 retailer searches. CARTIVA500 average parse0.266ms, local match2.098ms,1.51 search attempts; deterministic fixture timings, not production SLA. |
| Build |Next production and Sites Worker builds successful. Type validation passed before Worker type generation. |

## Permanent rerun procedure

`pnpm test:shared-state` runs 33 shared persistence/transport/OAuth/cart contract tests against real SQLite statements and controlled retailer responses. It is also included in `test:discovery`. Follow-up full suite:115 files /2,139 tests passed. CARTIVA100 and all502 CARTIVA500 cases remain score2+ with no unsafe selections; representative live subset12/12 with15 requests (~30s). Updated browser suite passes11 groups, including ownerless legacy recovery. Both production builds passed. Live shared-D1 rollout verification is recorded below after publication; these tests do not claim an actual shopper cart was modified.

`pnpm test:discovery` runs new property/network tests plus library and route regressions. `pnpm test:discovery:browser` launches an isolated Chrome profile and fault-injected API responses (never a real cart). `pnpm test:visual` covers common viewport/long-list alignment. Run full tests, CARTIVA100/500, fragments and the opt-in rate-bounded live subset after matcher/state changes. Discovery tests are kept even when a bug is fixed; do not delete difficult cases or change expected safety outcomes to improve a score.

Keep the next discovery pass different from the previous one. Add a record here with reproduction, root cause, fix and regression. Local temporary screenshot/report artifacts are generated by the browser scripts; no customer session is reused.

## Open limitations — do not call these passed

- **Shared-store rollout:** D23 now implements durable web-session/transfer coordination; production verification must exercise the deployed bridge and D1 binding, not only fixtures. Unknown retailer outcomes remain review-required, not a claim of end-to-end exactly-once retailer delivery. Cookie deletion/new device creates a separate browser owner and requires explicit reconnection/review; there is no cross-device account identity guarantee.
- **Infrastructure: read/search abuse limits.** OAuth start/status/disconnect, cart transfer and review now have durable web quotas, with owner quotas on sensitive recovery paths. Broad anonymous product-search/work quotas still need trusted edge enforcement for production scale; nontrusted fallback identity remains coarse.
- **Real OAuth/cart confirmation:** automated route/session chaos and mocked accepted-cart browser flow pass; the public live subset verifies retrieval/matches/readiness only. A real authenticated shopper must complete retailer consent and inspect the resulting cart. No fresh real cart mutation was made in this pass; Kroger's website session can differ from its API authorization, and its public cart API does not set checkout store.
- **Native accessibility/usability:** responsive Chrome, semantic/focus/reduced-motion review are not a screen-reader certification or an iPhone physical-keyboard test. Independent novice-user testing and real production telemetry remain necessary.
- **Coverage gaps:** multiple-tab simultaneous edits, cross-device library sync (not offered), native extension installation, authenticated retailer website redirects across banners, and distributed infrastructure fault injection need dedicated environments. Existing device-local wording remains explicit.

These gaps prevent a claim that every production P0/P1 and real-cart scenario is closed. The discovery system and verified fixes ship without a redesign; authenticated retailer acceptance still requires a real shopper session. The browser-control integration currently fails to initialize, so isolated Chrome QA cannot stand in for the user's signed-in Kroger account.
