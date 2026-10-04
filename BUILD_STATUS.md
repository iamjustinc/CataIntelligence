# Build status

Last updated: 2026-10-03 (session 3)

Status values: **Not started** · **In progress** · **Implemented but unverified** · **Verified**.
"Verified" means an automated test or a recorded manual check exercised the behavior on the server, not that a screen renders.

## Summary

| Phase | State | Exit gate |
| --- | --- | --- |
| 0 Foundation and contracts | **Verified** | Met |
| 1 Deterministic taxonomy workflow | **Verified** | Met |
| 2 Live recommendation processing | **Implemented; verified with deterministic providers. Live provider NOT verified** | Partly met. See "Phase 2 exit gate" below for what is met and what is blocked |
| 3 Shared dashboard and analytics | Not started | Metric registry and AnalysisSpec contract only |
| 4 Integrated release and demonstration | Not started | |

**No live provider call has been made.** This machine has no `ANTHROPIC_API_KEY`, no `ANTHROPIC_AUTH_TOKEN` and no `ant` profile. The Claude adapter is tested against a deterministic stand-in for the SDK client only. Nothing in this document claims live verification.

## Verification run at the end of this session

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Clean |
| `pnpm lint` | Clean |
| `pnpm test` | 208 passed in 17 files (run twice in a row) |
| `pnpm test:e2e` | Rebuilds the `_e2e` database, runs `next build`, starts the web server **and the real worker process**, then 8 Chromium tests: all passed (5 Phase 1, 3 Phase 2) |
| `pnpm eval:check` | Corpus passes leakage and composition checks |
| `pnpm eval --split development --provider baseline` | Ran; report in `evals/reports/development-baseline.md` |
| `pnpm eval --split heldout --provider baseline` | Ran; report in `evals/reports/heldout-baseline.md` |
| `pnpm eval --split heldout --provider claude` | **Not run**: exits with "needs ANTHROPIC_API_KEY and AI_MODEL_ID" |
| `pnpm smoke:live` | **Not run**: exits with code 2, "No provider call was made" |

The development database was **not** reset this session; the Phase 2 migration is additive and was applied with `pnpm db:migrate`.

## Phase 2 exit gate

| Gate condition (PRD section 18) | Status | Evidence |
| --- | --- | --- |
| Provider failures preserve work | Verified with scripted providers | `jobs.test.ts`: transient, invalid, refusal, truncation, fatal auth, provider unavailable. Completed items and decisions are kept; failed listings stay reviewable |
| Concurrent updates cannot overwrite decisions | Verified | `jobs.test.ts` (approval during an in-flight call, lost lease), `review.test.ts` AT08 and AT09, e2e |
| Benchmark results are reported | Partly met | Lexical baseline reported on development and held-out sets. **Live-model results are blocked on credentials; all labels are provisional** |
| Production configuration has no exposed secrets | Verified | `settings-cleanup.test.ts`: the key never appears in API responses or audit events; settings reject an `apiKey` field; the worker logs only whether a key is present |

### Blocked verification, precisely

1. **Live provider call.** Needs `ANTHROPIC_API_KEY` and a model ID. Then: `pnpm smoke:live` (three calls), and a live job from the UI with the worker running.
2. **Live-model benchmark.** Needs the same credentials and a budget: `pnpm eval --split heldout --provider claude --max-items <n>`.
3. **Independent expert labels.** All 304 evaluation records are marked `provisional_model_authored`: I wrote them. They are not expert ground truth. A domain expert must label or correct them, and a second reviewer must adjudicate the ambiguous ones, by editing `evals/corpus/*.jsonl` (`labeling.source`, `labelers`, `adjudicated`, `disagreement`).
4. **High signal band.** Stays disabled. The gate needs items 2 and 3 plus at least 50 High selections at 95% precision.

### Preliminary evaluation results (deterministic lexical baseline, provisional labels)

| Measure | Development (151) | Held-out (153) | Target |
| --- | --- | --- | --- |
| Retrieval recall at 10 | 86.1% (99/115) | 82.4% (89/108) | 95% (KPI01): **not met** |
| Unique-exact-match precision (would-be High) | 79.1% (34/43) | 76.7% (33/43) | 95% (KPI03): **not met** |
| Correct abstention by the baseline | 91.7% (33/36) | 91.1% (41/45) | |
| Evidence faithfulness | 100% | 100% | |

What this does and does not show: retrieval alone misses the correct leaf for roughly one labelable listing in six on product families it was not tuned on, against 99% on the demo fixtures. That is a real finding about the retriever. It says nothing yet about the live model's accuracy (KPI02), and because the labels are provisional none of it is launch evidence.

## Integrity findings from the start of this session

- **"Suggestions do not survive a taxonomy publication"** meant stale, not deleted. Recommendations are append-only (trigger, no UPDATE or DELETE grant). After a publication and revalidation, every earlier recommendation is still stored and the listing still points at it; the workflow state moves to Needs analysis and a stale suggestion cannot be approved. Two gaps were fixed: the review screen now lists the full suggestion history, and a new analysis now covers listings that returned to Needs review. Covered by `jobs.test.ts` ("history is kept across taxonomy versions and re-analysis").
- **React console errors** were caused by a dependency install while the dev server was running, not by application code. `@playwright/test` is an optional peer dependency of `next`; installing it made pnpm re-link `node_modules/next`, and the open page received a hot update from a second copy of React. The dev server log recorded "node_modules is being reorganized by a concurrent install". Normal navigation, hot reload, a concurrent production build and installing an unrelated package do not reproduce it; after a restart there are no errors.
- **A real defect found in the same log:** after the database was dropped, the next request failed with a 500 on a dead pooled connection. Fixed with a pool error listener and one retry on a lost connection.

## Requirements

| ID | Status | Implemented behavior | Verification | Outstanding |
| --- | --- | --- | --- | --- |
| TAX01 Taxonomy ingestion | Verified | CSV staged and validated with row-specific blocking errors; commit creates a draft; published versions immutable | `taxonomy-validation.test.ts`, `taxonomy.test.ts` | XLSX is P1 |
| TAX02 Browse and search | Verified | Keyboard tree, breadcrumb, definition, synonyms, status, version selector, search, published listing and pending proposal counts, state restored on return; only active leaves selectable as targets | `taxonomy.test.ts`; `review.test.ts` (non-leaf and unknown targets rejected, concept search returns leaves only); browser | |
| TAX03 Merchant and catalog management | Verified | Merchants; catalog upload with column mapping (aliases suggested, user-editable), 20-row preview, source row number, raw payload and normalized fields kept; price requires currency; no commit before confirmation | `catalog-validation.test.ts`, `catalog-import.test.ts`, e2e | Merchant edit and deactivate UI |
| TAX04 Validation and revisions | Verified | 10 MB and 5,000-row limits, UTF-8 only; blocking row errors; exact duplicates collapsed, conflicting SKUs need a selection; count conservation; snapshot deactivates missing SKUs, delta carries forward; unchanged listings keep decisions with provenance, changed ones return to review; same-file re-upload returns the existing import; commit idempotent | `catalog-import.test.ts` (13), `review.test.ts` carry-forward case, e2e | Staged files are refused after 24 hours but not yet deleted by a job |
| TAX05 Candidate retrieval | Verified | At most 10 active leaves from one version; whole-phrase aliases, token overlap, ancestor and merchant-category hints; scores and matched terms stored; product type beats ingredient term; empty set leads to abstention | `retrieval.test.ts` | Evaluated on demo fixtures only. Semantic retrieval is P1 |
| TAX06 AI recommendations | Implemented; live path unverified | Bounded request with field limits and truncation flags; strict response contract; server validation of IDs, candidate membership, evidence excerpts and contradictions; provider can only pick an enumerated candidate; proposals name a missing concept without minting an ID | `retrieval.test.ts` (validation and all 300 fixture listings), `review.test.ts` | The Claude adapter (structured output, refusal, truncation, invalid output, auth, rate limit, timeout) is covered by `claude-adapter.test.ts` with a stand-in client. **No real provider call has been made** |
| TAX07 Signal bands | Verified | High, Medium, Low, No recommendation from a server policy with a stated basis and policy version; no percentages; High disabled by a workspace gate; provider can only lower | `retrieval.test.ts`, `review.test.ts`, `scenario.test.ts` | Precision gate needs the Phase 2 evaluation |
| TAX08 Review queue and detail | Verified | Filters (merchant, revision, status, band, category, warning, search), three sorts, keyset pagination; item view with source fields, original values, evidence, alternatives, history; Approve, Change mapping, Reject, Defer, No suitable category; lock version checked; queue position kept; saves announced; J/K/A/C/Esc | `review.test.ts` (18), e2e | Catalog-revision filter is URL-only; category filter is reached from a taxonomy concept. Suggestion history is listed per listing |
| TAX09 Bulk approval | Verified (server), implemented (UI) | Up to 100 explicitly selected High rows on the page, preview dialog, all-or-nothing with conflict list, batch ID, per-item decisions | `review.test.ts` AT10 cases | Not exercised in the browser: High is disabled in the demo workspace, so no row is selectable |
| TAX10 Taxonomy proposals | Verified | New leaf and synonym proposals with duplicate, structural and ambiguity checks; administrator approve, modify or reject with explanation; approval changes the draft only | `releases.test.ts`, e2e | Changing the parent during a modified approval is API-only. Reparent, merge, delete are P1 |
| TAX11 Version validation | Verified | Recommendations and decisions bound to versions; publication marks dependents stale; explicit revalidation keeps compatible human decisions, returns others to review; later recommendations never replace a decision | `releases.test.ts`, `review.test.ts` AT09, e2e | After a taxonomy publication, analysis must be run again to get new suggestions; earlier ones stay stored and visible as stale history |
| TAX12 Publication and rollback | Verified | Preview with counts, unresolved by reason, blockers and change summary; full or acknowledged partial release; atomic with pointer and audit; idempotent by stored key; rollback with compatibility rule | `releases.test.ts` (19), `scenario.test.ts`, e2e | |
| TAX13 Export and audit | Verified | Mapping CSV, unresolved CSV, metadata JSON, ZIP; formula-safe cells; reproducible bytes; exports audited; audit screen with filters and pagination | `releases.test.ts`, e2e | Exports are refused after 7 days but not yet deleted by a job |
| Jobs (PRD 12.2, section 16) | Verified with deterministic providers | Queued jobs processed by the worker: leases, heartbeat, restart recovery, three attempts with backoff, one repair retry, immediate stop on auth or configuration failure, cancellation that keeps completed work, retry of failed items, stale-dependency stop, idempotent commits, per-item progress | `jobs.test.ts` (16), e2e `02-jobs.spec.ts` | One worker processes one job at a time; run more workers for more throughput |
| Budgets and settings (PRD 14.4, section 16) | Verified | Estimate before start; per-job item, token and spend caps and a daily workspace cap, checked before start and between batches; actual usage per call; unknown cost stored as NULL; administrator settings with version check and audit | `jobs.test.ts`, `settings-cleanup.test.ts`, e2e | Member management is still not built |
| File lifecycle (PRD 14.5) | Verified | Uncommitted staged files deleted after 24 hours, export objects after 7 days, by the worker | `settings-cleanup.test.ts` | Workspace deletion is not built |
| Evaluation (PRD 13.5) | In progress | Corpus format, 304 records in separate development and held-out sets, leakage checks, metrics, runner, High gate | `evals.test.ts`, reports | Expert labels, adjudication, live-model run, 40 analytics questions |
| ANA01 to ANA06 | Not started | Overview shows three live counts only | `contracts.test.ts` | Phase 3 |

## Acceptance scenarios

| Test | Status | Evidence |
| --- | --- | --- |
| AT01 Malformed CSV and mixed-validity rows | Verified | `catalog-import.test.ts`, e2e |
| AT02 Repeat import or commit | Verified | `catalog-import.test.ts`, e2e |
| AT03 Snapshot removes, delta retains | Verified | `catalog-import.test.ts` |
| AT04 Taxonomy cycle or invalid leaf eligibility | Verified | `taxonomy.test.ts` |
| AT05 AI selects nonexistent or foreign concept | Verified with scripted and stand-in providers | `retrieval.test.ts`, `claude-adapter.test.ts`, `jobs.test.ts`. Not exercised with a live provider |
| AT06 Prompt injection in product title | Verified structurally; live behavior unverified | Catalog text is sent as data in the user turn, the system prompt is constant, the adapter has no tools and no database handle (`claude-adapter.test.ts`). How the live model responds to the six adversarial corpus items is unmeasured |
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
| AT17 Provider timeout, 429, worker restart, cancellation | Verified with scripted providers | `jobs.test.ts`; restart and retry also in the browser with the real worker (`02-jobs.spec.ts`) |
| AT18 Missing key in live mode | Verified | `review.test.ts`, `jobs.test.ts` (provider unavailable at processing time), e2e: "AI unavailable", 503, no fixture output, manual mapping works |
| AT19 to AT23 Analytics | Not started | Phase 3 |
| AT24 Foreign workspace ID | Verified for all existing endpoints | Each integration file asserts 404 or empty for another workspace; e2e |
| AT25 Formula-leading CSV cell | Verified | `releases.test.ts`, e2e |
| AT26 Viewer requests approval or publication via analytics | Not started | Phase 3. Viewer mutation attempts are refused today (e2e) |
| AT27 Keyboard-only operation | In progress | Tree navigation checked manually; A-to-approve in e2e. No automated accessibility audit |
| AT28 Fresh install and refresh | Verified for Phase 1 scope | e2e rebuilds the database from migrations and seed; decisions and releases persist across reloads |

## Known gaps and limitations

- **Live AI is unverified** (see "Blocked verification"). Until a real call succeeds, treat the adapter's request shape as untested against the provider.
- **Evaluation labels are provisional** and the lexical retriever misses the 95% recall target on them. Improving retrieval (the PRD's P1 semantic retrieval) should be decided from expert-labeled results.
- **Server-side refusal fallback is not enabled.** A refusal is recorded as a failed item so the stored model ID always names the model that answered.
- **No prompt caching.** The system prompt is far below the cacheable minimum, so it would not cache.
- **One job at a time per worker**, items processed with `JOB_CONCURRENCY` calls in flight. Caps are checked between batches of ten, so in-flight calls can exceed a cap slightly; the UI says so.
- **Bulk approval still has no eligible rows in the demo**, because the High band is disabled.
- **Member management, merchant deactivation and workspace deletion** are not built.
- **The 40-question analytics benchmark** belongs to Phase 3 and does not exist.
- **Browser coverage is Chromium only**; retry and restart recovery in the browser start from failure states arranged in the test database, because a healthy demo run cannot produce them.
- **`pnpm setup` on a clean clone** was still not re-run end to end; its steps and the e2e preparation were.
- Configuration is validated on first use by each process, not by a dedicated startup hook.

## Next steps

1. With credentials: `pnpm smoke:live`, a live job from the UI, then a budgeted live evaluation on the development set.
2. Expert labeling and adjudication of the corpus; then the held-out run and the High gate decision.
3. Phase 3: metric service, dashboard, AnalysisSpec planner, governed query compiler, analytics benchmark.
