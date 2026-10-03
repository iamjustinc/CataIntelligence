# Build status

Last updated: 2026-10-03 (session 2)

Status values: **Not started** · **In progress** · **Implemented but unverified** · **Verified**.
"Verified" means an automated test or a recorded manual check exercised the behavior on the server, not that a screen renders.

## Summary

| Phase | State | Exit gate |
| --- | --- | --- |
| 0 Foundation and contracts | **Verified** | Met |
| 1 Deterministic taxonomy workflow | **Verified** | Met: a user can import, manually review, publish, refresh and reproduce the export without AI. Covered by integration tests and by the browser test from a fresh database |
| 2 Live recommendation processing | Not started | Retrieval, validation, signal policy and the provider boundary exist and are tested with the demo provider; no live adapter, worker processing, budgets or evaluation corpus |
| 3 Shared dashboard and analytics | Not started | Metric registry and AnalysisSpec contract only |
| 4 Integrated release and demonstration | Not started | |

Live AI has **not** been tested. There is no live adapter and no provider key was used. Every suggestion in this build is deterministic fixture output and is labeled Demo.

## Verification run at the end of this session

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Clean |
| `pnpm lint` | Clean |
| `pnpm test` | 165 passed in 13 files (run twice in a row) |
| `pnpm test:e2e` | Rebuilds the `_e2e` database from migrations and seed, runs `next build`, then 5 Chromium tests against the production build: all passed |
| `pnpm db:reset --yes` | Development database rebuilt from migrations and the demo seed in about 6 seconds |

Retrieval on the **demo fixtures** (not a held-out corpus, so not evidence for KPI01/KPI02): recall@10 286/289 (99.0%), top-1 261/289 (90.3%).

## Requirements

| ID | Status | Implemented behavior | Verification | Outstanding |
| --- | --- | --- | --- | --- |
| TAX01 Taxonomy ingestion | Verified | CSV staged and validated with row-specific blocking errors; commit creates a draft; published versions immutable | `taxonomy-validation.test.ts`, `taxonomy.test.ts` | XLSX is P1 |
| TAX02 Browse and search | Verified | Keyboard tree, breadcrumb, definition, synonyms, status, version selector, search, published listing and pending proposal counts, state restored on return; only active leaves selectable as targets | `taxonomy.test.ts`; `review.test.ts` (non-leaf and unknown targets rejected, concept search returns leaves only); browser | |
| TAX03 Merchant and catalog management | Verified | Merchants; catalog upload with column mapping (aliases suggested, user-editable), 20-row preview, source row number, raw payload and normalized fields kept; price requires currency; no commit before confirmation | `catalog-validation.test.ts`, `catalog-import.test.ts`, e2e | Merchant edit and deactivate UI |
| TAX04 Validation and revisions | Verified | 10 MB and 5,000-row limits, UTF-8 only; blocking row errors; exact duplicates collapsed, conflicting SKUs need a selection; count conservation; snapshot deactivates missing SKUs, delta carries forward; unchanged listings keep decisions with provenance, changed ones return to review; same-file re-upload returns the existing import; commit idempotent | `catalog-import.test.ts` (13), `review.test.ts` carry-forward case, e2e | Staged files are refused after 24 hours but not yet deleted by a job |
| TAX05 Candidate retrieval | Verified | At most 10 active leaves from one version; whole-phrase aliases, token overlap, ancestor and merchant-category hints; scores and matched terms stored; product type beats ingredient term; empty set leads to abstention | `retrieval.test.ts` | Evaluated on demo fixtures only. Semantic retrieval is P1 |
| TAX06 AI recommendations | In progress | Bounded request with field limits and truncation flags; strict response contract; server validation of IDs, candidate membership, evidence excerpts and contradictions; provider can only pick an enumerated candidate; proposals name a missing concept without minting an ID | `retrieval.test.ts` (validation and all 300 fixture listings), `review.test.ts` | Live Claude adapter, refusal and truncation handling against a real provider (Phase 2) |
| TAX07 Signal bands | Verified | High, Medium, Low, No recommendation from a server policy with a stated basis and policy version; no percentages; High disabled by a workspace gate; provider can only lower | `retrieval.test.ts`, `review.test.ts`, `scenario.test.ts` | Precision gate needs the Phase 2 evaluation |
| TAX08 Review queue and detail | Verified | Filters (merchant, revision, status, band, category, warning, search), three sorts, keyset pagination; item view with source fields, original values, evidence, alternatives, history; Approve, Change mapping, Reject, Defer, No suitable category; lock version checked; queue position kept; saves announced; J/K/A/C/Esc | `review.test.ts` (18), e2e | Catalog-revision filter is URL-only; category filter is reached from a taxonomy concept |
| TAX09 Bulk approval | Verified (server), implemented (UI) | Up to 100 explicitly selected High rows on the page, preview dialog, all-or-nothing with conflict list, batch ID, per-item decisions | `review.test.ts` AT10 cases | Not exercised in the browser: High is disabled in the demo workspace, so no row is selectable |
| TAX10 Taxonomy proposals | Verified | New leaf and synonym proposals with duplicate, structural and ambiguity checks; administrator approve, modify or reject with explanation; approval changes the draft only | `releases.test.ts`, e2e | Changing the parent during a modified approval is API-only. Reparent, merge, delete are P1 |
| TAX11 Version validation | Verified | Recommendations and decisions bound to versions; publication marks dependents stale; explicit revalidation keeps compatible human decisions, returns others to review; later recommendations never replace a decision | `releases.test.ts`, `review.test.ts` AT09, e2e | After a taxonomy publication, analysis must be run again to get new suggestions |
| TAX12 Publication and rollback | Verified | Preview with counts, unresolved by reason, blockers and change summary; full or acknowledged partial release; atomic with pointer and audit; idempotent by stored key; rollback with compatibility rule | `releases.test.ts` (19), `scenario.test.ts`, e2e | |
| TAX13 Export and audit | Verified | Mapping CSV, unresolved CSV, metadata JSON, ZIP; formula-safe cells; reproducible bytes; exports audited; audit screen with filters and pagination | `releases.test.ts`, e2e | Exports are refused after 7 days but not yet deleted by a job |
| ANA01 to ANA06 | Not started | Overview shows three live counts only | `contracts.test.ts` | Phase 3 |

## Acceptance scenarios

| Test | Status | Evidence |
| --- | --- | --- |
| AT01 Malformed CSV and mixed-validity rows | Verified | `catalog-import.test.ts`, e2e |
| AT02 Repeat import or commit | Verified | `catalog-import.test.ts`, e2e |
| AT03 Snapshot removes, delta retains | Verified | `catalog-import.test.ts` |
| AT04 Taxonomy cycle or invalid leaf eligibility | Verified | `taxonomy.test.ts` |
| AT05 AI selects nonexistent or foreign concept | Verified with the validation layer | `retrieval.test.ts`. Not yet exercised with a live provider |
| AT06 Prompt injection in product title | Verified for the demo path | `retrieval.test.ts`: treated as data; the provider has no database or publishing capability. Live prompt behavior is Phase 2 |
| AT07 Reviewer corrects a suggestion | Verified | `review.test.ts`, e2e |
| AT08 Two reviewers, same row version | Verified | `review.test.ts` (truly concurrent requests), e2e conflict UI |
| AT09 Recommendation after human approval | Verified | `review.test.ts` |
| AT10 Stale row in bulk selection | Verified | `review.test.ts` |
| AT11 New concept proposed and approved | Verified | `releases.test.ts`, e2e |
| AT12 Taxonomy changes after recommendation | Verified | `releases.test.ts`, e2e |
| AT13 Partial release with deferred items | Verified | `releases.test.ts`, e2e |
| AT14 Publication fails mid-write | Verified | `releases.test.ts` (failure injected before the pointer moves) |
| AT15 Rollback to incompatible revision | Verified | `releases.test.ts` |
| AT16 Export historical release after new revisions | Verified | `releases.test.ts` (byte-identical) |
| AT17 Provider timeout, 429, worker restart, cancellation | Not started | Phase 2 |
| AT18 Missing key in live mode | Verified at the service level | `review.test.ts`: 503, no fixture output, manual mapping works. No live adapter yet |
| AT19 to AT23 Analytics | Not started | Phase 3 |
| AT24 Foreign workspace ID | Verified for all existing endpoints | Each integration file asserts 404 or empty for another workspace; e2e |
| AT25 Formula-leading CSV cell | Verified | `releases.test.ts`, e2e |
| AT26 Viewer requests approval or publication via analytics | Not started | Phase 3. Viewer mutation attempts are refused today (e2e) |
| AT27 Keyboard-only operation | In progress | Tree navigation checked manually; A-to-approve in e2e. No automated accessibility audit |
| AT28 Fresh install and refresh | Verified for Phase 1 scope | e2e rebuilds the database from migrations and seed; decisions and releases persist across reloads |

## Known gaps and limitations

- **Analysis is not a background job yet.** Demo analysis runs inside the request. The job tables are in use, but there is no worker claim, lease, retry or cancel (Phase 2).
- **No live AI.** Live mode reports "AI unavailable"; manual mapping is unaffected.
- **Bulk approval has no eligible rows in the demo**, because the High band stays disabled until a precision evaluation exists. There is no settings control for that gate.
- **Evaluation corpus not built.** The 200 labeled products and 40 analytics questions (PRD 13.5) do not exist; retrieval figures above are from demo fixtures.
- **Settings are read-only**: members, provider mode and budgets.
- **Housekeeping jobs missing**: expired staged files and exports are refused on access but not deleted.
- **Browser coverage is Chromium only**, one end-to-end path plus isolation, read-only and conflict cases.
- **`pnpm setup` on a clean clone was not re-run this session.** Its steps were run individually, and `pnpm db:reset` and the e2e preparation rebuild databases from migrations and seed.
- Configuration is validated on first use by each process, not by a dedicated startup hook.

## Next steps (Phase 2)

1. Worker: lease-based claiming, per-item commit, bounded retries, cancel and retry endpoints (AT17).
2. Claude adapter behind the existing provider interface, with structured output, prompt versioning, usage and cost records, token and spend caps.
3. Evaluation corpus and harness; report retrieval, ranking, abstention and band precision; decide the High gate.
4. Settings: provider mode, live opt-in with the list of fields sent, budgets, member management.
