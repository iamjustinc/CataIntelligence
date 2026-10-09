# Build status

Last updated: 2026-10-08 (session 6)

Status values: **Not started** · **In progress** · **Implemented but unverified** · **Verified**.
"Verified" means an automated test or a recorded manual check exercised the behavior on the server, not that a screen renders.

## Summary

| Phase | State | Exit gate |
| --- | --- | --- |
| 0 Foundation and contracts | **Verified** | Met |
| 1 Deterministic taxonomy workflow | **Verified** | Met |
| 2 Live recommendation processing | **Implemented with deterministic verification. Live provider verification and independent quality evaluation are pending** | Partly met. See "Phase 2 exit gate" below for what is met and what is blocked |
| 3 Shared dashboard and analytics | **Implemented; verified deterministically. Live question planner NOT verified** | Met for the deterministic path: the 40 benchmark questions reconcile with reference queries and unsupported or malicious questions cause no execution. The live planner has not been run against the benchmark. See "Phase 3 exit gate" |
| 4 Integrated release and demonstration | **Implemented; demo-mode half of the exit gate verified deterministically. Live half NOT verified** | Partly met. The workflow runs from a freshly built database in demo mode in the browser suite. "Live mode is verified with configured credentials" is blocked: no credentials. See "Phase 4" below |

**Live provider calls so far: one smoke test with OpenAI on 2026-10-08 (five calls, run locally).** No live job has been run through the application, nothing live has run on the hosted site, and the Claude adapters have still only met a stand-in client. See "Presentation readiness" below.

Two kinds of verification are kept apart throughout this document:

- **Deterministic verification:** automated tests against PostgreSQL with fixture, scripted or stand-in providers, and the rule-based demo planner.
- **Live-model verification:** a real, successful provider call. **None has happened.**

## Verification run at the end of this session

| Check | Kind | Result |
| --- | --- | --- |
| `pnpm typecheck` | Deterministic | Clean |
| `pnpm lint` | Deterministic | Clean |
| `pnpm test` (unit and integration, isolated `_test` database) | Deterministic | 305 passed, 1 skipped, in 22 files. The skipped test is the live analytics benchmark, which runs only with credentials |
| `pnpm build` (inside `pnpm test:e2e`) | Deterministic | Production build succeeded |
| `pnpm test:e2e` (isolated `_e2e` database rebuilt from migrations and seed, production build, real worker) | Deterministic | 24 Chromium tests passed in five files, in two consecutive full runs, the second on the final code: 5 Phase 1, 3 Phase 2, 5 Phase 3, 11 Phase 4. The only server errors logged are the ones the recovery test causes on purpose (the application role's read access to one table is revoked, then restored) |
| Analytics benchmark (inside `pnpm test`) | Deterministic, demo planner | 40 of 40 |
| `pnpm backup:check` | Deterministic, local | Passed against the development database as a read-only source: 31 tables and 3,056 rows dumped, restored into a scratch database, compared, scratch database dropped |
| `pnpm eval:check` | Deterministic | Corpus passes leakage and composition checks |
| `pnpm eval --split development` and `--split heldout`, `--provider baseline` | Deterministic | Re-run. The former held-out set is labeled INSPECTED, development data |
| `pnpm eval --split frozen` | Deterministic | Refuses: "No frozen test set exists yet", exit 2 |
| `pnpm smoke:live` | Live model | **Not run.** Exits 2: "No provider call was made" |
| `pnpm eval:analytics:live` | Live model | **Not run.** Exits 2: "No provider call was made" |
| `pnpm eval --provider claude` | Live model | **Not run.** "Nothing was run" |

Each of the five Phase 4 commits was also checked out on its own in a clean worktree and passed typecheck, lint and the full unit and integration suite (301 tests for the first three, 305 plus the skipped live benchmark from the fourth). The browser suite was run on the final code, not on each commit.

The development database was not reset and no row in it was changed this session. `pnpm backup:check` read it with `pg_dump` and wrote only to a scratch database that it then dropped. No migration was added. Test runs remain serialized by the advisory lock (D49); the browser suite uses its own `_e2e` database.

## Phase 4

PRD section 18: "Deliver polished responsive UI, keyboard/accessibility checks, complete seed scenario, end-to-end tests, worker deployment instructions, backup/restore pilot checklist, release notes, and known limitations. Exit when the five-minute workflow works from fresh setup in demo mode and live mode is verified with configured credentials."

### Deliverables

| Deliverable | Status | Evidence | What is left |
| --- | --- | --- | --- |
| Polished responsive UI | Implemented; verified by automated checks and a visual pass at phone width | `04-accessibility.spec.ts`: eight screens at 390 px have no sideways scroll, navigation and headings are present, a question can be answered and a listing decided | Bulk approval and the taxonomy tree are usable but cramped on a phone; the queue says so. No tablet-specific layout |
| Interface states (PRD 10.4) | Verified for the states listed | Loading skeleton on every route (the browser suite waits through it); empty states in an empty workspace; permission-denied states for a viewer; failed state with retry (`05`: a server render fails and recovers); stale state after a taxonomy publication (`01`); all job states (`02`); "AI unavailable" (`02`) | The root-level error page (`app/global-error.tsx`) is written to the framework's contract but has not been triggered in a test |
| Keyboard and accessibility checks | Verified by automation; **no manual screen-reader pass** | `04`: axe rules for WCAG 2.0, 2.1 and 2.2 A and AA report no violations on 16 administrator screens, analytics with an interpretation, result, clarification and line chart, a saved report, a dialog, ten viewer screens and ten empty-workspace screens. Keyboard only: sign in, skip link, Tab reaches every control with a visible focus ring on five screens, ask and run a question, move through and operate a review item | Automated rules cover part of WCAG. No conformance claim. Catalog import by keyboard is not automated (file choosing cannot be driven by keys in the test browser) |
| Clear demo and live labels | Verified | Shell badges "Demo data", "Demo AI" or "AI unavailable", and the environment; "Demo planner (rule-based, not AI)" on interpretations and "Demo planner · not AI" on results; demo suggestions labeled per item (`01`, `02`, `03`) | Live labels have only been seen with a stand-in provider |
| Complete seed scenario | Verified | `scenario.test.ts` pins every seeded total; the e2e database is built from migrations and seed on every run | |
| End-to-end tests | Verified | 24 browser tests in five files. New this phase: role matrix on all 52 API routes for four roles and no session; cross-workspace access by real ID; rollback; failed server render; failed and lost saves; analytics request failures; accessibility; keyboard; phone | Chromium only |
| Worker deployment instructions | Written, **not exercised** | `docs/DEPLOYMENT.md` | Never deployed to a host. No container or process-manager configuration |
| Backup and restore pilot checklist | Written; restore verified locally | `docs/PILOT_CHECKLIST.md`, `pnpm backup:check` | Scheduled backups, point-in-time recovery and a timed restore drill on a host are not done |
| Release notes and known limitations | Written | `RELEASE_NOTES.md`, "Known gaps and limitations" below | |

### Exit gate

| Condition | Status | Evidence |
| --- | --- | --- |
| The five-minute workflow works from fresh setup in demo mode | Met, deterministic | `pnpm test:e2e` drops and recreates its database, applies migrations, seeds, builds, starts web and worker, then `01-workflow` imports a catalog, runs demo analysis, approves, corrects, defers, proposes a leaf, publishes the taxonomy, revalidates, publishes a partial release and exports it; `03-analytics` asks questions and drills down. The walkthrough's closing question, "Which merchant still needs the most review?", is covered by a planner test |
| Live mode is verified with configured credentials | **Not met: blocked** | No `ANTHROPIC_API_KEY` exists on this machine. Nothing was substituted for it |
| Both taxonomy and analytics complete | Implemented | See Requirements. Open P0 items are listed under "Implementation gaps" |

`pnpm setup` itself (which writes `.env` and starts a local cluster) was not re-run on a clean clone. Its database steps, migrations and seed, are what the browser suite runs from nothing.

### What remains, by cause

**Blocked by credentials** (ready to run, never run):

1. `pnpm smoke:live`: three recommendation calls and two analytics planner calls through the real adapters.
2. A live analysis job from the UI with the worker, and a live analytics question.
3. `pnpm eval --split development --provider claude --max-items <n>`.
4. `pnpm eval:analytics:live`: the 40 questions through the live planner.

**Blocked by people** (protocol written, nothing started):

5. A frozen, expert-labeled, adjudicated test set (`evals/PROTOCOL.md`). Until it exists KPI01 to KPI03 are unmeasured and High signal stays disabled.
6. Independently written analytics questions (KPI05 is 100% only on questions written by the planner's author).
7. Review-time study (KPI04) and usability sessions (KPI08).
8. A manual accessibility pass with a screen reader.
9. A security review, and provider retention terms checked by the data owner.

**Implementation gaps** (could be built without either):

10. Member management screen (PRD 10.2 lists members under Settings; members are database rows today).
11. Merchant deactivation and workspace deletion (PRD 14.5).
12. Bounded export job for results over 1,000 rows (PRD 13.4).
13. Alerts on failed jobs and model error rate (PRD section 16). The data is recorded; nothing watches it.
14. Performance measurement at 5,000 listings with three reviewers (PRD section 16).
15. An object-store adapter; storage is a local directory behind an interface.
16. Deployment to a real host, with its backup schedule and restore drill.

### Readiness assessment

| For | Ready? | Basis |
| --- | --- | --- |
| A guided demonstration in demo mode, on a laptop | **Yes** | The whole workflow passes in a browser from a freshly built database, with every figure reconciled against independent queries |
| Evaluation by the product owner in demo mode, unassisted | Probably, with the README walkthrough | Not tested with a person who has not seen it (KPI08) |
| A pilot with real users and real catalogs | **No** | Live AI has never run; nothing is deployed; no backup schedule; no member management; the pilot checklist is unticked |
| Production | **No** | All of the above, plus unmeasured accuracy, unmeasured performance, no monitoring and no security review |

This build is a demonstration candidate. Nothing in the evidence supports calling it production-ready, and this document does not.

## Presentation readiness (2026-10-08)

| Item | Status | Evidence |
| --- | --- | --- |
| Hosted site serves the intended commit | Verified on Vercel | `/api/health` reports the commit; it matched `origin/main` after each push this session |
| Hosted health, database, HTTPS, refusal of unauthenticated requests | Verified on Vercel | `/api/health` ok; `/overview` redirects to sign-in; API returns 401; the scheduled route returns 401 without its secret |
| OpenAI recommendation adapter and analytics planner | **Verified with real calls, locally** | `pnpm smoke:live` on `gpt-5.4-mini`: 3 of 3 recommendations and 2 of 2 interpretations passed server validation; 5 calls, 9,097 input and 958 output tokens, about USD 0.01 of an enforced USD 2.00 budget. 16 unit tests with a stand-in client |
| OpenAI through the application (a live job, a live question in the UI) | **Not verified** | Needs the key and model set where the app runs, live mode switched on in Settings, and a run |
| OpenAI on the hosted site | **Not verified** | Whether `OPENAI_API_KEY` and `AI_MODEL_ID` are set in Vercel has not been checked |
| Rehearsal workspace | Created on the hosted database | "Rehearsal (synthetic data)", same four members, same synthetic scenario; the demo workspace was not touched |
| Signed-in journey on the hosted site: import, analysis, review, release, export, analytics | **Not verified** | No signed-in browser session was available to the author of this document, who does not enter passwords on live sites. The same journey passes locally on a production build, including with no worker process and database storage |
| Hosted inline job: completion, failure, recovery | **Not verified on Vercel** | Verified locally only (`pnpm test:e2e:serverless`, `02-jobs.spec.ts`) |
| Administrator and viewer permissions, sign-out, session persistence on the hosted site | **Not verified on Vercel** | Verified locally by the role-matrix browser test on all 52 routes |
| Local checks on the final code | Verified | Typecheck and lint clean; 322 unit and integration tests pass, 1 skipped (live benchmark); production build; 24 of 24 browser tests |

One finding to act on: a real OpenAI key had been pasted into `.env.example`, which is tracked in a public repository. It was never committed or pushed, and the file was restored to placeholders. Because the key briefly sat in a tracked file, rotating it is the cautious choice.

The presentation script, checklist and fallback are in `docs/DEMO.md`.

## Hosting on Vercel (2026-10-05)

A Vercel deployment showed "Ready" with a 404 and a 21-millisecond build. Cause: the GitHub repository held a single `.gitattributes` commit; the application was in a separate local repository with no remote and had never been pushed.

| Item | Status | Evidence |
| --- | --- | --- |
| Repository is complete and builds from tracked files alone | Verified locally | A fresh `git clone` of the repository, `pnpm install --frozen-lockfile` and `pnpm build` with no `.env` file and no database variables succeeded (`VERCEL=1` set). 251+ tracked files include the app, `package.json`, `pnpm-lock.yaml`, `next.config.ts`, six migrations and `public/`. Typecheck and lint clean; 306 unit and integration tests pass; the standard browser suite passes 24 of 24 |
| Vercel configuration | Written, **not deployed** | `vercel.json` sets the Next.js framework, install and build commands and the output directory, overriding any static-site setting |
| Uploads and exports without a shared disk | Verified locally | `STORAGE_DRIVER=database`: `settings-cleanup.test.ts` (round trip, workspace isolation); serverless browser run |
| Analysis jobs without a worker process | Verified locally | `JOB_RUNNER=inline`: `pnpm test:e2e:serverless` runs the workflow and analytics specs against a production build with **no worker process**: import, demo analysis, review, publish and export pass (10 tests) |
| A real Vercel deployment with a hosted database | **Not done** | Needs your GitHub push, a hosted PostgreSQL database and environment variables. Steps in `docs/VERCEL.md` |

"Verified locally" means `next start` on this machine in a mode that imitates Vercel. It is not Vercel: the function time limit, request size limit and connection behavior there have not been exercised.

## Connection fix (start of this session)

The Phase 2 commit retried a whole transaction after a lost connection, which could have replayed a mutation whose commit had already succeeded.

| Item | Result |
| --- | --- |
| Retry rule | `withContext` retries once only if the failure happened before the caller's function started (checkout, `BEGIN`, setting the session context). Nothing is replayed after the body starts, including when `COMMIT` fails with an unknown outcome |
| Connection release | `withContext` checks the connection out itself and releases it in `finally`, destroying it after a lost connection. Drizzle's `transaction` sends `BEGIN` outside its own try/finally, which leaked the pool slot when `BEGIN` failed and made `pool.end()` hang |
| Error events | Pool-level and per-client listeners; a wait for a pool slot is bounded at 15 seconds |
| Tests | `connection-retry.test.ts`: retry before the body; no replay after mid-transaction termination; no checked-out or waiting clients afterwards; no retry once the body started |
| The suite stall | Not reproducible on the fixed code alone: seven shuffled-order runs and repeated ordered runs all passed. Reproduced as a class by overlapping runs: two runs at once drop each other's `_test` database and the worker engine claims the other run's jobs (12 and 3 failures in a deliberate overlap). Overlap happened in practice when a timed-out command kept running in the background. Global setup now holds an advisory lock and a second run stops immediately, naming the holder |
| Not established | The exact trigger of the first stall was not captured. The leaked connection on a failed `BEGIN` could also hang teardown and is fixed; which of the two occurred that time is unknown |

No test was skipped, no timeout was raised and no process exit is forced. Tests still run in the configured order; serial execution across runs is required because every run recreates one shared database (DECISIONS D49).

## Phase 3 exit gate

| Gate condition (PRD section 18) | Status | Evidence |
| --- | --- | --- |
| Benchmark questions reconcile with reference queries | Met with the demo planner (deterministic). **Not run with a live model** | `analytics-benchmark.test.ts`: 26 of 26 supported questions produce the reference AnalysisSpec and the same rows as hand-written reference SQL; report in `evals/reports/analytics-benchmark-demo.json` |
| Unsupported or malicious questions cause no unauthorized execution | Met (deterministic) | 14 of 14 clarification, refusal and attack questions are declined and none produces a run; row counts of decisions, releases, concepts and review-state versions are unchanged after the whole benchmark; `analytics-api.test.ts`; `03-analytics.spec.ts` |

### Analytics benchmark (deterministic, demo planner)

| Measure | Result |
| --- | --- |
| Supported-question accuracy (spec and numbers both correct) | 26 of 26 |
| Correct clarification or refusal | 14 of 14 |
| Questions that should not run but produced an executable spec | 0 |
| By category | totals 3/3, rates 4/4, merchants 3/3, publication scope 5/5, follow-ups 8/8, time 9/9, unsupported 3/3, zero denominators 2/2, permission attacks 3/3 |
| Live planner on the same questions | **Not run** (no credentials) |

How to read this: the planner rules and the benchmark were written by the same author in the same session. The result shows that the rules, the query compiler and the metric SQL agree with independent reference queries, and that nothing unauthorized runs. It is a regression check. It does not measure how well free-form questions are understood, and it says nothing about the live model.

### What "demo planner" means

In demo mode a question is interpreted by rule-based phrase matching, labeled "Demo planner (rule-based, not AI)" on the interpretation and "Demo planner · not AI" on the result. It accepts a question only when every meaningful word matched a rule; otherwise it names the words it could not account for and refuses. Live mode without credentials shows "AI unavailable" and never falls back to these rules. The analysis builder (fixed controls) and the dashboard need no planner.

## Phase 2 exit gate

| Gate condition (PRD section 18) | Status | Evidence |
| --- | --- | --- |
| Provider failures preserve work | Verified with scripted providers | `jobs.test.ts`: transient, invalid, refusal, truncation, fatal auth, provider unavailable. Completed items and decisions are kept; failed listings stay reviewable |
| Concurrent updates cannot overwrite decisions | Verified | `jobs.test.ts` (approval during an in-flight call, lost lease), `review.test.ts` AT08 and AT09, e2e |
| Benchmark results are reported | Partly met | Lexical baseline reported on development and held-out sets. **Live-model results are blocked on credentials; all labels are provisional; the held-out set has been inspected** |
| Production configuration has no exposed secrets | Verified | `settings-cleanup.test.ts`: the key never appears in API responses or audit events; settings reject an `apiKey` field; the worker logs only whether a key is present |

### Blocked verification, precisely

1. **Live provider call.** Needs `ANTHROPIC_API_KEY` and a model ID. Then: `pnpm smoke:live` (three calls), and a live job from the UI with the worker running.
2. **Live-model benchmark.** Needs the same credentials and a budget: `pnpm eval --split heldout --provider claude --max-items <n>`.
3. **Independent expert labels.** All 304 evaluation records are marked `provisional_model_authored`: I wrote them. They are not expert ground truth. A domain expert must label or correct them, and a second reviewer must adjudicate the ambiguous ones, by editing `evals/corpus/*.jsonl` (`labeling.source`, `labelers`, `adjudicated`, `disagreement`).
4. **An untouched evaluation set.** The held-out set's baseline misses were printed and read while the harness was built (2026-10-04). Nothing was tuned against it, but it is **inspected, not untouched**: its reports are labeled INSPECTED and the High gate now refuses it. Tuning must use the development set. Independent assessment needs a new set written and labeled by someone else (`evals/corpus/reserved.jsonl`), which does not exist.
5. **Live analytics planner.** Needs the same credentials. Then set the workspace to live mode and ask the benchmark questions; no automated live benchmark run exists yet.
6. **High signal band.** Stays disabled (`high_signal_enabled` is false and nothing sets it). The gate needs items 2 and 3 plus at least 50 High selections at 95% precision.

### Preliminary evaluation results (deterministic lexical baseline, provisional labels, inspected held-out set)

| Measure | Development (151) | Held-out, inspected (153) | Target |
| --- | --- | --- | --- |
| Retrieval recall at 10 | 86.1% (99/115) | 82.4% (89/108) | 95% (KPI01): **not met** |
| Unique-exact-match precision (would-be High) | 79.1% (34/43) | 76.7% (33/43) | 95% (KPI03): **not met** |
| Correct abstention by the baseline | 91.7% (33/36) | 91.1% (41/45) | |
| Evidence faithfulness | 100% | 100% | |

What this does and does not show: retrieval alone misses the correct leaf for roughly one labelable listing in six on product families it was not tuned on, against 99% on the demo fixtures. That is a real finding about the retriever. It says nothing yet about the live model's accuracy (KPI02), and because the labels are provisional none of it is launch evidence.

## Integrity findings

- **Server log line "The destination stream closed early"** during browser tests is the framework reporting a cancelled render, not a data error. Reproduced with a real browser against the production build (`.data/diag/abort-probe2.ts`): it appears when the browser leaves a page whose client-side navigation is still streaming (4 of 4 on Review Queue, 2 of 4 on Releases, both untouched by Phase 3, and 4 of 4 on Overview) and never when the navigation settles (0 of 12). Aborted plain HTTP requests do not produce it (0 of 120). The tests triggered it by navigating immediately after sign-in; the sign-in helper now waits for the page to finish.
- **A dropped test attribute** made the first analytics browser run fail: `Card` did not forward `data-testid`. The interpretation was on screen; the test could not find it. Fixed in the component.

### From earlier sessions


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
| Evaluation (PRD 13.5) | In progress | Corpus format, 304 records in separate development and held-out sets, leakage checks, metrics, runner, High gate; held-out set marked inspected; 40-question analytics benchmark | `evals.test.ts`, `analytics-benchmark.test.ts`, reports | Expert labels, adjudication, live-model runs, a new untouched reserved set |
| Metric service (PRD section 9) | Verified | Eight registered metrics from stored records in one service used by dashboard, analytics, exports and report refresh. Coverage is summed numerators over summed denominators. Published coverage uses each merchant's current release for its current catalog revision; no release means zero with a stated reason. Zero denominators return Not applicable. Branch breakdowns carry an Unmapped bucket | `analytics-metrics.test.ts` (16): every metric against independently written SQL; unregistered metrics, values and combinations rejected with 422 | Spec allows two group-by dimensions; the UI offers one |
| ANA01 Operational dashboard | Verified | Active listings, published and approved-draft coverage, pending, ambiguous, failed analysis, most recent publication; merchant comparison with a summed Total row; review-state distribution; review completions by UTC day. Every card states scope and denominator and links to the review queue | `analytics-metrics.test.ts` (dashboard equals the service and the pinned scenario; every drilldown link opens a queue with exactly the metric's count), `03-analytics.spec.ts` (cards equal direct SQL on the e2e database) | "Review completions over time" covers the last 30 days. No historical coverage trend: past values are not recorded |
| ANA02 Governed interpretation | Verified deterministically; live planner unverified | A question becomes a validated AnalysisSpec or is declined. The server compiles the query from fixed fragments with bound values; workspace comes from the session. Guards refuse SQL, other workspaces, mutations and unrecorded data before any planner or provider call | `analytics-planner.test.ts` (46), `analytics-api.test.ts`, benchmark | **No live model call.** The Claude planner is tested with a stand-in client: request shape, validation of nine kinds of bad answers, failure handling |
| ANA03 Clarification and time | Verified deterministically | Clarifies coverage without a scope, periods without dates, months without a year, improvement without a baseline; nothing runs until resolved; the interpretation is editable before execution; named periods use the workspace timezone and show the interpreted instants; half-open intervals; comparisons with unrecorded history are reported as unavailable | `analytics-planner.test.ts` (daylight-saving and month boundaries), benchmark time questions with decisions placed at interval edges, e2e | Publication-day trend metric is not built |
| ANA04 Results and evidence | Verified | Template summary built only from result cells, bar or line chart, paginated table with totals, metric definition, population, filters, release and revision per merchant, timestamp, warnings, run ID. Not applicable for zero denominators; "No matching records" for empty sets | `analytics-metrics.test.ts`, `analytics-api.test.ts`, e2e (chart and table cells equal the reference query) | Narrative text is template-only; no model-written summary |
| ANA05 Follow-ups and saved reports | Verified deterministically | A follow-up derives from the conversation's last executed spec and lists what changed; a complete new question does not inherit filters; conversations are private to their owner; reports save name, spec, chart type and visibility; refresh computes a new run and keeps the saved snapshot; CSV export includes interpreted scope and run time | `analytics-planner.test.ts`, `analytics-api.test.ts` (17), e2e | A non-owner's refresh of a shared report is shown to them but not stored on the report |
| ANA06 Cross-module actions | Verified | Results link to the review queue, releases and taxonomy. Analytics has no write path to listings, decisions, taxonomy or releases; a request to approve or publish gets an explanation and navigation links | `analytics-api.test.ts` and benchmark (row counts unchanged), e2e | Branch rows have no exact queue filter, so they show no link |

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
| AT15 Rollback to incompatible revision | Verified | `releases.test.ts`; in the browser, `05-recovery-and-permissions.spec.ts` |
| AT16 Export historical release after new revisions | Verified | `releases.test.ts` (byte-identical) |
| AT17 Provider timeout, 429, worker restart, cancellation | Verified with scripted providers | `jobs.test.ts`; restart and retry also in the browser with the real worker (`02-jobs.spec.ts`) |
| AT18 Missing key in live mode | Verified | `review.test.ts`, `jobs.test.ts` (provider unavailable at processing time), e2e: "AI unavailable", 503, no fixture output, manual mapping works |
| AT19 Coverage aggregated across merchants | Verified | `analytics-metrics.test.ts`: total is 140 of 300 and differs from the average of merchant rates; dashboard Total row in e2e |
| AT20 Metric without scope, or an absent sales metric | Verified deterministically | Benchmark S1, S2, U1; `analytics-planner.test.ts`; e2e. Live planner unverified |
| AT21 Follow-up changes merchant or date | Verified deterministically | Benchmark F1 to F8 and D5; changes listed in the interpretation; e2e |
| AT22 Category coverage including unmapped items | Verified | Benchmark S5 and F1; branch filter warning; coverage cannot be grouped by branch (`analytics-metrics.test.ts`) |
| AT23 Empty dataset or zero denominator | Verified | `analytics-metrics.test.ts`, benchmark Z1 and Z2: Not applicable and "No matching records" |
| AT24 Foreign workspace ID | Verified for all existing endpoints | Each integration file asserts 404 or empty for another workspace, now including conversations, runs, reports and exports; e2e |
| AT25 Formula-leading CSV cell | Verified | `releases.test.ts`, e2e |
| AT26 Viewer requests approval or publication via analytics | Verified | `analytics-api.test.ts`, e2e: explanation and navigation links, no rows changed |
| AT27 Keyboard-only import, review, and analytics | Verified for review and analytics; import partly | `04-accessibility.spec.ts`: keyboard-only sign-in, review and analytics; charts have list and table equivalents; focus moves to new content. Import: every control is reachable by Tab, but choosing a file by keyboard is not automated |
| AT28 Fresh install and refresh | Verified | e2e rebuilds the database from migrations and seed; decisions, releases, jobs and saved reports persist across reloads (`01`, `02`, `03`) |

## Known gaps and limitations

- **Live AI is unverified** (see "Blocked verification"). Until a real call succeeds, treat the adapter's request shape as untested against the provider.
- **Evaluation labels are provisional** and the lexical retriever misses the 95% recall target on them. Improving retrieval (the PRD's P1 semantic retrieval) should be decided from expert-labeled results.
- **Server-side refusal fallback is not enabled.** A refusal is recorded as a failed item so the stored model ID always names the model that answered.
- **No prompt caching.** The system prompt is far below the cacheable minimum, so it would not cache.
- **One job at a time per worker**, items processed with `JOB_CONCURRENCY` calls in flight. Caps are checked between batches of ten, so in-flight calls can exceed a cap slightly; the UI says so.
- **Bulk approval still has no eligible rows in the demo**, because the High band is disabled.
- **Member management, merchant deactivation and workspace deletion** are not built.
- **The live analytics planner is unverified**, like the live recommendation adapter. Its prompt and request shape have never met the real API.
- **The analytics benchmark is not independent of the planner it tests** (same author). A fair measure of question understanding needs questions written by someone else, and a live run.
- **The held-out evaluation set is inspected**; an untouched reserved set does not exist.
- **The demo planner is strict.** Phrasings outside its rules are refused with the unmatched words listed; the controls are the fallback. That is deliberate, and it will feel rigid.
- **No history for as-of metrics.** Coverage and backlog over time cannot be shown because snapshots are not recorded, and none are backfilled (D60). Two things are recorded by date and shown: review completions and publications.
- **Conversation privacy is enforced in the service layer**, not by row-level security (which isolates workspaces). Every read goes through one owner check.
- **Charts are hand-built HTML and SVG** with text equivalents; a single-day series renders as one point.
- **Result export is CSV of up to 1,000 rows.** The PRD's separate bounded job for larger exports is not built.
- **Keyboard focus after an in-app navigation stays where it was**; only a fresh page load starts at "Skip to content".
- **Typing into a form in the first moments after a page loads can be lost**, before the page's scripts attach. Found by the keyboard test; not fixed.
- **Browser coverage is Chromium only**; retry and restart recovery in the browser start from failure states arranged in the test database, because a healthy demo run cannot produce them.
- **`pnpm setup` on a clean clone** was still not re-run end to end; its steps and the e2e preparation were.
- Configuration is validated on first use by each process, not by a dedicated startup hook.

## Next steps

In order of what unblocks the most:

1. Provide `ANTHROPIC_API_KEY` and a model ID, then run the four credential-blocked checks listed under Phase 4. Expect to adjust the prompts: neither has met the real API.
2. Engage two labelers and an adjudicator and build the frozen test set (`evals/PROTOCOL.md`).
3. Decide whether a pilot is wanted. If so, work through `docs/PILOT_CHECKLIST.md`, starting with hosting, backups and member management.
