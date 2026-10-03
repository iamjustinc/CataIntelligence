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
