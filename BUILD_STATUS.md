# Build status

Last updated: 2026-10-03 (session 1)

Status values: **Not started** · **In progress** · **Implemented but unverified** · **Verified**.
"Verified" means an automated test or a recorded manual check exercised the behavior on the server, not that a screen renders.

## Summary

| Phase | State | Exit gate |
| --- | --- | --- |
| 0 Foundation and contracts | **Verified** | Met: workspace isolation tests pass; a fresh database is built from migrations on every test run |
| 1 Deterministic taxonomy workflow | **In progress** | Not met: taxonomy import to publish works; catalog import, review, proposals, releases, export and audit UI remain |
| 2 Live recommendation processing | Not started | |
| 3 Shared dashboard and analytics | Not started (metric registry and AnalysisSpec contract exist) | |
| 4 Integrated release and demonstration | Not started | |

Checks at the end of this session: `pnpm typecheck` clean, `pnpm lint` clean, `pnpm test` 89 passed in 7 files, `pnpm build` succeeded.

Live AI has **not** been tested. No provider key was available and no provider adapter exists yet.

## Phase 0 deliverables

| Deliverable | Status | Evidence |
| --- | --- | --- |
| Repository structure, lockfile, lint and typecheck commands | Verified | `pnpm-lock.yaml`; commands above |
| Database migrations | Verified | `tests/setup/global.ts` drops and recreates the test database from `db/migrations` each run; `isolation.test.ts` asserts 2 migrations and 29 tables |
| Authentication | Verified | `api.test.ts`: 401 without session, forged cookie rejected, wrong password rejected, public sign-up disabled. Manual: browser sign-in and sign-out on localhost |
| Workspace permissions | Verified | `permissions.test.ts` checks every cell of the PRD 3.2 matrix; `isolation.test.ts` and `api.test.ts` check enforcement in services and routes |
| Workspace isolation | Verified | RLS on every tenant table (enumerated by test), no rows without context, foreign-workspace write rejected, forged workspace cookie ignored, by-ID read returns 404, composite FK blocks cross-workspace reference even for the owner |
| Fixture generator | Verified | `fixtures.test.ts`: deterministic output, 153 concepts, 300 unique listings, PRD section 17 edge cases, revision 2 deltas |
| Domain schemas and contracts | Verified (schemas only) | `contracts.test.ts`: PRD example payloads accepted; unknown keys, unregistered metrics, wrong scope and the literal `uuid-or-null` rejected. Not yet exercised by features |
| Metric definitions | Implemented but unverified | `lib/analytics/metric-registry.ts` holds the eight PRD section 9 definitions. No query compiler yet |
| Provider interfaces | Verified (status logic only) | Interface in `lib/ai/provider.ts`; test proves live mode without credentials reports "AI unavailable" and never demo |
| `.env.example`, README | Verified | Setup steps were run in order on a clean directory during this session |
| Audit foundation | Verified | Audit event commits with the change and is absent when the change fails; UPDATE and DELETE rejected for both roles |
| Idempotency foundation | Verified | Missing key 400, repeat replays the same response with one row and one audit event, reused key with a different body 409 |
| Worker process | In progress | Starts, verifies it runs as the restricted role, heartbeats, stops on SIGTERM (manual run). No job handlers or leases yet |
| Application shell | Verified (manual) | Navigation, workspace selector, demo-data, provider and environment badges, sign-out, loading, error, empty and permission-denied states viewed in the browser at desktop and phone widths |

## Requirements

| ID | Status | Implemented behavior | Verification | Outstanding |
| --- | --- | --- | --- | --- |
| TAX01 Taxonomy ingestion | Verified | CSV staged and validated; duplicate IDs, missing parents, cycles, multiple or no root, depth over eight, mapping on non-leaf or inactive all block with row-specific errors; ambiguous synonyms warn; commit creates a draft; a published version cannot be mutated; stable keys keep concept identity | `taxonomy-validation.test.ts` (12 tests), `taxonomy.test.ts` (12 tests), browser run of the import wizard with an invalid file and of publish | XLSX is P1 |
| TAX02 Browse and search | Verified for browsing | Expandable keyboard-navigable tree, breadcrumb path, definition, synonyms, status, version selector with historical versions, search over names, paths, definitions, synonyms and IDs, published listing and pending proposal counts from live queries, expansion and selection restored on return | `taxonomy.test.ts` search cases; browser: keyboard navigation, search, restore after navigation | "Cannot select inactive or internal concepts as targets" is enforced when review lands (TAX08). Counts are zero until releases and proposals exist |
| TAX03 Merchant and catalog management | In progress | Create and list merchants with name, external key, region, active flag; unique per workspace | `api.test.ts`, `isolation.test.ts`, browser | Catalog CSV import, column mapping, preview |
| TAX04 Validation and revisions | Not started | Schema only (catalog and listing revisions, price and currency constraint) | Constraint definition asserted | Everything else |
| TAX05 Candidate retrieval | Not started | | | |
| TAX06 AI recommendations | Not started | Response contract only | `contracts.test.ts` | Adapter, semantic validation |
| TAX07 Signal bands | Not started | | | |
| TAX08 Review queue and detail | Not started | Schema only | | |
| TAX09 Bulk approval | Not started | | | |
| TAX10 Taxonomy proposals | Not started | Schema only | | |
| TAX11 Version validation | Not started | Version binding columns exist | | Stale marking on taxonomy publish must ship with review state |
| TAX12 Publication and rollback | Not started | Schema, immutability triggers | Trigger behavior asserted for audit events | |
| TAX13 Export and audit | In progress | Append-only audit events written for merchant and taxonomy actions | `isolation.test.ts`, `taxonomy.test.ts` | Audit screen, exports |
| ANA01 to ANA06 | Not started | Metric registry and AnalysisSpec contract only | `contracts.test.ts` | Metric service, dashboard, planner, UI |

## Acceptance scenarios

| Test | Status | Note |
| --- | --- | --- |
| AT04 Taxonomy cycle or invalid leaf eligibility blocks publish | Verified | Blocked at import and again at publish against the stored tree |
| AT24 Foreign workspace ID in endpoint | Verified for existing endpoints | Merchants, taxonomy versions, workspace switch. Jobs, reports and exports do not exist yet |
| AT27 Keyboard-only operation | In progress | Taxonomy tree and dialogs checked manually; no automated accessibility test |
| AT28 Fresh install and refresh | In progress | Migrations and seed verified; taxonomy state survives refresh. Decisions, releases, jobs and reports do not exist yet |
| AT18 Missing key in live mode | In progress | Status logic verified; no live adapter to exercise |
| All others (AT01 to AT03, AT05 to AT17, AT19 to AT23, AT25, AT26) | Not started | |

## Known gaps and limitations

- The demo seed creates identities, workspaces and merchants only. Taxonomy and catalogs will be seeded through the import services once catalog import exists, so the full PRD section 17 scenario is not yet reproducible from `pnpm db:seed` alone.
- No rate limiting on uploads yet (PRD 14.3). Authentication rate limiting is enabled in production builds only.
- No browser automation suite yet; browser checks so far were manual and are listed above.
- Staged files are not yet expired by a job; commit refuses staged imports older than 24 hours.
- Publishing a new taxonomy version does not yet mark dependent review state stale, because review state does not exist yet (TAX11).
- Members, provider mode and budgets are read-only in Settings.
- Configuration is validated on first use by each process, not by a dedicated startup hook.

## Next steps (Phase 1, in order)

1. Catalog CSV import: stage, column mapping, preview, validation with count conservation, snapshot and delta revisions, idempotent commit (TAX03, TAX04; AT01 to AT03).
2. Review queue and item detail with manual decisions and optimistic locking (TAX08; AT07, AT08).
3. Deterministic fixture adapter and candidate retrieval for labeled demo suggestions (TAX05, part of TAX06 and TAX07).
4. Proposals and version revalidation (TAX10, TAX11; AT11, AT12).
5. Publication, rollback, export, audit screen (TAX12, TAX13; AT13 to AT16, AT25).
6. Seed the full demo scenario through those services and add the browser test for import, review, publish, refresh.
