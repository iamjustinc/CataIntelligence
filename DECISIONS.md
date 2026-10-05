# Architecture decisions

Newest last. Each entry records what was decided, why, and what would make us revisit it.

## D01 Stack: PRD defaults, current stable versions
Next.js 16 App Router, React 19, TypeScript 5.9, PostgreSQL, Drizzle ORM with `pg`, Zod 4, Tailwind 4, Vitest 5. TypeScript 5.9 and ESLint 9 are what the current Next.js toolchain pins; TypeScript 7 and ESLint 10 exist but are not yet the versions `eslint-config-next` supports. The lockfile is committed.

## D02 Local PostgreSQL: project-local cluster from installed binaries
The build machine has no Docker or Homebrew, but Postgres.app's PostgreSQL 17 binaries are installed. `pnpm db:up` runs `initdb`/`pg_ctl` against `.data/pg` on port 54329, so it does not touch any other PostgreSQL installation. The app only needs `DATABASE_URL` and `DATABASE_ADMIN_URL`, so any PostgreSQL 15+ server works. Rejected: the `embedded-postgres` package (only beta releases for the current major) and PGlite (single-process, cannot be shared by web and worker).

## D03 Two database roles and row-level security
Migrations run as an owner role. Web and worker connect as a separate login role with no ownership, no `BYPASSRLS` and no superuser. Every table with a `workspace_id` has an isolation policy keyed on `app.workspace_id`, set per transaction by `withContext()` from the verified session and membership. Without a context the application role sees no tenant rows. `migrate` refuses to run when both URLs use the same role. A test enumerates tenant tables and fails if one lacks a policy.

## D04 Composite foreign keys carry workspace_id
Tenant parents expose `UNIQUE (workspace_id, id)` and children reference `(workspace_id, parent_id)`. Cross-workspace references are impossible even for the owner role. Decision and recommendation targets reference `(workspace_id, taxonomy_version_id, concept_id)`, so a target must exist in the same workspace and the same taxonomy version.

## D05 Immutability enforced in the database
Triggers reject UPDATE and DELETE on audit events, mapping releases, published mappings, review decisions, recommendations, catalog revisions and listing revisions. The application role additionally has those privileges revoked. A taxonomy version and its concept revisions are frozen by trigger once the version leaves `draft`. Application code is not the only guard.

## D06 Authentication: better-auth with email and password
Database-backed sessions in HttpOnly cookies; no public sign-up; accounts are provisioned by seed (administrator-managed membership UI comes later). better-auth is the maintained successor path for Auth.js. Seeded identities replace a role switcher, as the PRD requires. Revisit for enterprise SSO (PRD P2).

## D07 One route wrapper for cross-cutting API rules
`lib/api/handler.ts` applies, in order: same-origin check for mutations, session, server-resolved workspace and role, capability check, Zod body validation, optional idempotent replay, and a uniform envelope with `requestId`. Handlers are plain `Request -> Response` functions, so integration tests call them with real sessions and no HTTP server. Domain services repeat the capability check, so authorization does not depend on the route layer.

## D08 Active workspace is a cookie, verified on every request
The `ci_workspace` cookie is only a preference. Each request re-reads the user's active memberships; a workspace the user does not belong to is ignored and never disclosed (404). Role is taken from the membership of the resolved workspace.

## D09 Idempotency in two layers
The route wrapper stores the response for an `Idempotency-Key` per workspace, route and actor and replays it; a reused key with a different body is 409. Because the handler runs before the response is stored, two truly concurrent duplicates could both execute, so operations that must be exactly-once also carry their own database guard (import job row lock and status, release idempotency key uniqueness, one-draft unique index).

## D10 Taxonomy versions: one draft per workspace, stable concept identity
A concept row holds the stable key and never changes; each version has its own concept revisions. A partial unique index allows one draft per workspace. Importing creates a draft (or replaces the draft only when explicitly requested); publishing validates the stored tree again, freezes the version and moves the workspace's active pointer in one transaction with the audit event. Taxonomy draft transactions take a workspace row lock so they are serialized. Cycles are validated in application code, as the PRD notes a foreign key cannot prevent them.

## D11 Paths are materialized per concept revision
`path` and `depth` are computed at import and stored on each concept revision. Reads, search and exports need the canonical path constantly, versions are immutable after publication, and draft edits (proposals) will recompute affected paths in the same transaction.

## D12 Staged files live in private storage with server-generated keys
Uploads are validated, hashed and written under `STORAGE_DIR/<workspace>/<kind>/<uuid>`. The original file name is kept as display data only. Commit re-reads the staged object, checks its hash and validates again, so nothing is trusted from the browser at commit time.

## D13 Provider status never falls back to fixtures
`resolveProviderStatus` reports live mode without credentials, or without administrator opt-in, as "AI unavailable". Demo fixtures are used only in demo mode and only for fixture content hashes (adapter lands in Phase 1/2).

## D14 Worker claims nothing until handlers exist
The Phase 0 worker validates configuration and its database role, then idles with a heartbeat. Lease-based claiming arrives with the first handler in Phase 2 so that no job is ever claimed by a process that cannot run it. Cross-workspace job discovery will use a narrowly scoped `SECURITY DEFINER` function; the worker then sets the workspace context before touching tenant rows.

## D15 Fixtures are generated from curated sources, not hand-edited
`fixtures/source` holds the taxonomy, product seeds and edge cases with their expected concept. The generator is deterministic and its output is committed. Demo seed data will be loaded through the same import services users call, so seeded counts always derive from real records.

## D16 Catalog revisions copy listings forward instead of referencing earlier rows
Every revision owns a complete set of listing revisions. A delta carries earlier active listings forward as new rows; a snapshot writes inactive rows for SKUs that disappeared. A revision's population is therefore one indexed query and never depends on later data, which is what makes releases and exports reproducible. Cost: more rows per revision (bounded by the 5,000-row upload limit).

## D17 Classification hash decides whether a decision can be carried forward
Each listing revision stores a hash of title, description, merchant category path, brand, package size and GTIN after normalization. Price and currency are excluded. An unchanged hash lets the latest human decision be re-recorded against the new revision with `carried_forward` origin and a link to the original decision, after the target concept is checked against the active taxonomy version. A changed hash sends the listing back to review. The original reviewer stays the accountable actor; the import itself is in the audit log.

## D18 Duplicate SKUs: exact duplicates collapse, conflicts need a human choice
Among otherwise valid rows, identical rows for one SKU collapse to one and are counted. Rows that share a SKU with different content are all rejected until the user selects the row to keep, and are otherwise excluded with explicit acceptance. `input = accepted + rejected + collapsed` holds in every case and is shown on screen.

## D19 Re-upload detection by file hash, merchant and mode
Staging the same bytes for the same merchant and mode returns the earlier import (committed, or still staged) instead of creating another. A new revision from the same file requires the explicit "create a new revision anyway" action. Commit is additionally guarded by a row lock on the import job.

## D20 Upload rate limit lives in the database
A user may stage at most `UPLOAD_RATE_LIMIT_PER_MINUTE` (default 30) catalog or taxonomy uploads per minute, counted from `import_jobs`. It holds across web processes without shared memory. Sign-in is rate limited by better-auth in production builds.

## D21 Retrieval is lexical and separately testable
`lib/retrieval/candidates.ts` is a pure function over the active mappable leaves of one version. It matches whole name and synonym phrases in the title, drops a phrase that sits inside a longer phrase owned by another concept (so "almond" inside "almond milk" does not point at nuts), prefers the phrase that ends last in the title, and adds weighted token overlap. Merchant category only nudges ranking and never creates a candidate. Semantic retrieval stays P1 until the held-out evaluation shows lexical misses justify it.

## D22 The fixture provider is bound to content hashes and behaves like a model
Demo output exists only for listings whose classification hash equals a curated fixture row. The provider receives the same bounded request a live adapter will, may select only an enumerated candidate, and its response goes through the same server validation and signal policy. Anything else is skipped as `not_fixture_content` and stays manually reviewable. One walkthrough fixture deliberately suggests a concept misled by the merchant category so the correction path can be demonstrated; it is flagged and lands in the Low band.

## D23 Signal bands are computed by the server; High is off by default
The band is derived from retrieval facts and response flags, never from a model score. `workspaces.high_signal_enabled` is false until the precision gate is met, so a would-be High suggestion is stored as Medium with that reason. Bulk approval therefore has nothing to select in the demo workspace; it is implemented and integration-tested with the flag enabled.

## D24 Phase 1 analysis runs inside the request
Demo analysis writes the job, its items and recommendations in one transaction because fixture lookup is instant. The job and item tables are the same ones the Phase 2 worker will claim with leases; only where processing happens changes. Cancel and retry endpoints arrive with the worker.

## D25 Approve versus Change mapping
Approve accepts the current suggestion, or records a manual mapping when there is no valid suggestion. Choosing a different concept than a valid suggestion requires Change mapping and a reason, so every correction of the model is explicit and explained. Reject keeps the listing unresolved without inventing a target.

## D26 Review queue pagination uses a keyset on a computed sort key
Each sort mode defines one text key (revision time and source row, merchant and title, or band rank and source row) with the listing revision ID as tie-breaker. Cursors encode `(key, id)`, so pages do not shift when other reviewers resolve items.

## D27 Taxonomy publication marks dependencies stale; revalidation is explicit
Publishing a version sets every suggested or approved state bound to an earlier version to `stale`. Revalidation, an administrator action, re-records an approval against the new version (`revalidated` origin, linked to the earlier decision) only when the target still exists as an active leaf with the same path and definition. Other approvals go to Needs review, stale suggestions to Needs analysis, and No-suitable-category listings named by an applied proposal are reopened. Releases are blocked while anything is stale.

## D28 One computation for preview and publication
`compute()` in `lib/domain/releases.ts` evaluates the release population for both the preview and the publish transaction (with row locks in the latter). Publish also receives the counts the administrator saw and fails with 409 if they changed. The release row stores the idempotency key under a unique constraint, so a repeat returns the same release even if the route-level replay is bypassed.

## D29 Unresolved listings are stored with the release
`release_unresolved` records each excluded listing with its state and reason at publication time. The unresolved export and coverage denominators come from immutable rows rather than from review state that keeps changing.

## D30 Exports are deterministic
CSV content is ordered by SKU, built only from the release's immutable rows, and the ZIP writer uses fixed entry timestamps. Exporting the same release twice yields identical bytes, which is how reproducibility is tested. Formula-leading cells are prefixed with an apostrophe in the file only.

## D31 Rollback compatibility is defined by catalog revision
A release is compatible with a merchant when it was made from the merchant's current catalog revision. Activating an incompatible release requires the administrator to also activate that catalog revision in the same request; otherwise it is refused. Nothing is deleted.

## D32 Demo data is produced by the services, and tests own their workspaces
`db/seed-scenario.ts` builds the demo through the same service calls a user triggers. Integration test files create their own workspaces, and browser tests use a third database (`_e2e`) rebuilt from migrations and seed before every run, against a production build on its own port.

## D33 Analysis is a queued job; the worker is the only processor
`startAnalysis` writes the job and one item per active listing and returns 202. Nothing is analyzed in the request. The worker (and the seed and tests, through the same `processJob`) does the work. This supersedes D24.

## D34 Cross-workspace job discovery through one narrow SECURITY DEFINER function
The worker runs as the restricted application role, so it cannot see any tenant's rows without a workspace context. `claim_analysis_job(worker, lease_seconds)` runs as the owner, picks the oldest claimable job with `FOR UPDATE SKIP LOCKED`, takes the lease and returns only the job ID and workspace ID. The worker then sets that workspace as its row-security context. `expired_storage_objects` follows the same pattern for cleanup. Execute is revoked from PUBLIC and granted to the application role.

## D35 Leases, heartbeats and recovery
A claim sets `lease_owner` and `lease_expires_at`. Every batch renews the lease and publishes progress. A job whose lease expired is claimable again; on claim, items left `running` go back to `pending`. On SIGTERM the worker finishes the items in flight, returns the rest to `pending` and expires its own lease so another worker continues at once.

## D36 Idempotent item commits and one lock order
Each item's outcome commits in its own transaction: lock the job row, check that this worker still holds the lease, lock the item, and stop if it is no longer `running`. A second worker or a late result therefore cannot write. The unique index on (job, listing) is the last line of defence. Every path locks the job before the item, after an early version deadlocked by upgrading a shared job lock.

## D37 Retry policy lives in the worker, not the SDK
The SDK client is created with `maxRetries: 0`. The worker allows three attempts per item: transient failures (timeout, rate limit, overload, network) back off about 1, 2, then up to 8 seconds with jitter; an invalid answer gets one repair attempt inside the same limit; refusals and truncated answers are not retried; authentication and configuration failures stop the job at once and leave unprocessed items pending for a later retry.

## D38 Job outcome definitions
Completed: no failures and nothing pending. Canceled: cancellation was honoured. Otherwise partially completed when at least one recommendation was produced, failed when none was. Progress is always recomputed from item rows.

## D39 Eligibility: analysis leaves settled listings alone
A listing is skipped as already reviewed when a reviewer approved, deferred or marked it no suitable category, or rejected a suggestion and is investigating. It is skipped as up to date when its latest recommendation is for the active taxonomy version, the same provider and model, and did not fail. Listings back in Needs review are analyzed again; the new recommendation is stored without touching the earlier decision. Eligibility is rechecked just before each provider call, so a decision made while the job runs saves the call.

## D40 A recommendation is checked against the active version when it is written
`storeRecommendation` takes a share lock on the workspace row and refuses a recommendation whose taxonomy version is no longer active; the item fails with `stale_dependency`. The job also stops at the next batch boundary when the taxonomy version or catalog revision changed, and such a job cannot be retried: a new analysis is required.

## D41 Claude adapter shape
One `messages.create` call per listing with `output_config.format` built from a per-request Zod schema in which every concept ID is an enum of the retrieved candidates. The system prompt is constant; all catalog text travels as JSON in the user turn; there are no tools. `stop_reason` `refusal` and `max_tokens` are processing failures. Unparseable text is handed to server validation, which rejects it. The model ID is configuration (workspace setting, else `AI_MODEL_ID`); the application assumes none. `thinking` and `effort` are left at the model's defaults because their accepted values differ by model. A listing with no retrieved candidates abstains without a provider call.

## D42 No server-side refusal fallback
The provider's fallback option would let a different model answer after a refusal. It is not enabled: a refusal is recorded as a failed item, and `model_id` on a recommendation always names the model that produced it. Revisit if refusals turn out to be common on real catalogs.

## D43 Budgets
An estimate (about 3.5 characters per token for the prompt plus 600 output tokens per listing) is shown before start and stored on the job with a cost reservation. A job is refused when the estimate exceeds the per-job item, token or spend cap, or when today's committed spend plus the estimate exceeds the daily cap. The same caps are checked with actual usage between batches. Prices are entered by an administrator; without them cost is NULL everywhere and only the token cap can be enforced. Demo jobs cost nothing and say so.

## D44 Settings store configuration, never secrets
Provider mode, live opt-in, model ID, prices and caps are workspace columns changed by administrators with a version check and an audit event. The API key exists only in the server environment; the application reports whether one is configured. The settings contract rejects unknown fields, including an API key.

## D45 Cleanup removes bytes, not records
The worker deletes staged files of imports that were not committed within 24 hours and export objects older than 7 days. Import rows become `expired`; export rows get `deleted_at`. Files of committed imports are retained. A release can always be exported again from its immutable rows.

## D46 Evaluation data is separate from demo data and labeled by provenance
`evals/corpus/development.jsonl` and `heldout.jsonl` use product families and one merchant that do not appear in the demo fixtures. `pnpm eval:check` fails on shared families, duplicate or near-duplicate titles (token Jaccard of 0.8 or more) across splits or against the fixtures, labels that are not mappable leaves, and missing composition minimums. Every record states who labeled it; results on `provisional_model_authored` labels are reported as preliminary.

## D47 The High gate is computed, never applied automatically
`highSignalGate` requires the held-out split, the live model, expert labels on every record, at least 50 High selections and 95% precision. The evaluation computes bands as if High were enabled so its precision can be measured first. Nothing in the application sets `high_signal_enabled`; the settings page shows it read-only.

## D48 One retry on a lost database connection, only before the transaction body starts
A pooled connection closed by the server (restart, failover) fails the next query. `withContext` retries once on a fresh connection only when the failure happened before the caller's function began: checkout, `BEGIN` or setting the session context. Once the body has started, nothing is replayed, including when `COMMIT` fails and its outcome is unknown; the error reaches the caller, and mutating routes rely on idempotency keys for safe client retries. This replaces the Phase 2 version, which re-ran the whole transaction and could have applied a mutation twice.

`withContext` checks the connection out itself and releases it in `finally`, destroying it when the error was a lost connection. Drizzle's own `transaction` sends `BEGIN` outside its try/finally, so a failed `BEGIN` leaked the pool slot. The pool and every client have error listeners, and `connectionTimeoutMillis` bounds a wait for a slot at 15 seconds so exhaustion fails loudly instead of hanging. Session lookup retries once only on better-auth's `FAILED_TO_GET_SESSION`, which is a read. Covered by `tests/integration/connection-retry.test.ts`.

## D49 Test runs hold a lock on the test database and cannot overlap
Every Vitest run drops and recreates `<database>_test`, and the worker's `claim_analysis_job` claims queued jobs across all workspaces in the database it is connected to. Two runs at once therefore destroy each other's schema and process each other's jobs: on 2026-10-04 two deliberately overlapping runs produced 12 and 3 failures, while seven shuffled-order runs of the same code alone passed 212 of 212. Overlap happened in practice when a timed-out command kept running in the background. Global setup now takes a session advisory lock for the whole run and a second run fails immediately with the holder's PID. Test files within a run still execute in the configured order and share the database by using their own workspaces (D32).

## D50 One metric service; queries are assembled from fixed fragments
`lib/analytics/metric-service.ts` is the only place a governed metric is computed. Dashboard cards, analytics answers, charts, exports and report refreshes all call `runSpecInTx`, so they cannot disagree. A validated AnalysisSpec selects SQL fragments by registry key; every value (merchant IDs, branch names, states, bands, timestamps) is bound as a parameter after being checked against an allowed set. No text from a question or a model reaches SQL. The workspace is never part of a spec: it comes from the session through row-level security. Grouping uses output positions because a repeated expression with bound parameters is not recognised by PostgreSQL as the same expression.

## D51 Published versus draft, and what a category breakdown may claim
A listing counts as published when its merchant's current release was made from the merchant's current catalog revision and contains a mapping for that listing revision. A release for a superseded revision contributes nothing, and the result says so. A listing counts as draft-approved when its state is Approved under the active taxonomy version. Totals sum numerators and denominators; rates are never averaged (AT19).

A canonical branch exists only for a mapped listing. A breakdown by branch therefore always includes an "Unmapped" bucket, and the mapping scope (published or draft) must be stated because it decides which mapping the branch comes from. Coverage cannot be grouped by branch: every branch would show only its already-mapped listings. A branch filter on coverage is allowed, as PRD 6.4 describes, and carries a warning that the denominator is now only the listings classified there.

## D52 Review activity metrics
Reviewed listing count is the number of distinct listing revisions with a decision of origin manual, suggestion or bulk. Carried-forward and revalidated records are not reviews. Median review time uses individual decisions with a recorded duration; bulk approvals and decisions without a duration are excluded and counted in the result. Time ranges are half-open and stored in UTC. Named periods ("last month") are computed in the workspace timezone with weeks starting on Monday, and the interpretation shows the resulting instants. Day and week grouping is in UTC, as the PRD's dimensions specify, and the result says so. A listing reviewed on two days appears in both days and once in the total.

## D53 Snapshot metrics have no history
Listing count, coverage, pending, ambiguous and failed counts are as-of counts of current catalogs. The application does not record periodic snapshots, so "compared with last week", "has coverage improved" and a time range on those metrics are answered with an explanation or a clarification, never with numbers reconstructed from current data. The PRD's publication-day trend is not built; the dashboard shows the most recent publication and review completions by day.

## D54 Guards, then a planner; the demo planner is rules, not AI
Every question first passes fixed guards for requests that no planner may interpret: SQL, other workspaces, changes to data, transaction or engagement data, and comparisons with unrecorded history. They run before any provider call and answer identically in every mode.

The demo planner is a phrase matcher. It accepts a question only when every word outside a small stopword list was consumed by a rule; otherwise it lists the words it could not account for and refuses. This is stricter than a list of fixed example sentences but has the same property: an arbitrary question never receives an invented interpretation. It is labeled "Demo planner (rule-based, not AI)" wherever its output appears. The live planner sends the question as data with the registry and the workspace's merchant and branch names to Claude with structured output; the server converts the answer to a spec and validates it against the registry and that vocabulary. A provider error, refusal or invalid answer is reported as not interpreted. Live mode without credentials is "AI unavailable"; it never falls back to the demo planner. The analysis builder needs no planner at all.

"Coverage" without a scope produces a clarification offering published and draft, each as a complete interpretation. PRD 6.4 shows published being proposed directly while ANA03 requires asking; asking was chosen, with published listed first.

## D55 Interpreting never runs anything
`POST /api/analytics/interpret` returns an outcome only. Execution is a separate call with a spec the user has seen and may have edited. A run stores its validated spec, data scope and full result and is append-only (trigger), which is what makes a saved report's snapshot trustworthy. A run executed from an edited interpretation is recorded as built with controls, not as the planner's.

## D56 Conversations are private in the service layer; reports are shared explicitly
Row-level security isolates workspaces. Within a workspace, a conversation and its runs are readable only by their owner, enforced in `lib/domain/analytics.ts`; another member, including an administrator, gets the same 404 as for a missing ID. A saved report is private until its owner, in a role with `report.share`, shares it. A shared report exposes the runs it points to and nothing else of the owner's conversation. Refresh creates a new run and leaves the saved snapshot untouched; a non-owner's refresh is shown to them and not stored on the report.

## D57 Drilldowns are exact or absent
A result cell links to the review queue only when queue filters express exactly the listings it counts. The queue gained filters for ambiguous, failed analysis, published or not, and unanalyzed listings, and reports how many listings match. A canonical branch has no exact queue filter, so those rows say so instead of linking to an approximation. Tests assert that every offered link opens a queue with the metric's count.

## D58 The analytics benchmark and what it does and does not show
`evals/analytics/benchmark.ts` holds 40 questions with a reference spec or an expected clarification or refusal, and hand-written reference SQL that does not use the metric service. A supported question passes only when the planner's spec equals the reference and the executed rows equal the reference rows. Date boundaries are literals, with decisions arranged at the first and last instants of each interval.

The demo planner's rules and these questions were written by the same author in the same session, so 40 of 40 shows that the rules, compiler and metric SQL agree with independent queries and that nothing unauthorized runs. It is a regression check, not a measurement of how well free-form questions are understood. The live planner has not been run against it.

## D59 The held-out evaluation set is inspected
The held-out set's baseline misses were printed and read while building the Phase 2 harness. Nothing was tuned against it, but it is no longer untouched. `HELDOUT_STATUS` records this, reports on that split are labeled INSPECTED, and the High gate refuses an inspected set. Tuning uses the development set. An independent assessment needs a new set, authored and labeled by someone else, in `evals/corpus/reserved.jsonl`; it does not exist yet.
