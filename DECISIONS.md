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
