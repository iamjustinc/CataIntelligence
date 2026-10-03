# Catalog Intelligence

Reconcile merchant catalogs with a canonical taxonomy, publish reproducible mapping releases, and analyze the same governed data in plain language. Taxonomy is the primary workflow; analytics reads the same database, revisions, releases and permissions.

- Specification: [PRD.md](PRD.md)
- What is built and how it was verified: [BUILD_STATUS.md](BUILD_STATUS.md)
- Architecture decisions: [DECISIONS.md](DECISIONS.md)

> **Status:** Phase 0 (foundation) is verified. Phase 1 is in progress: taxonomy import, validation, versioning, publication and browsing work end to end. Catalog import, review, releases, live AI and analytics are not built yet, and the app says so on those screens. See BUILD_STATUS.md.

All merchants, brands, people and products in this repository are fictional.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · PostgreSQL 15+ · Drizzle ORM · better-auth · Zod · Tailwind CSS 4 · Vitest. One web process and one worker process share the database.

## Prerequisites

- Node.js 22+ and pnpm 10
- PostgreSQL 15+ **binaries** on the machine (for example Postgres.app, Homebrew or a system package), **or** an existing PostgreSQL server you can point the app at

## Setup

```bash
pnpm install
pnpm setup
```

`pnpm setup` runs four steps, each also available on its own:

| Step | Command | What it does |
| --- | --- | --- |
| 1 | `pnpm setup:env` | Writes `.env` with randomly generated local secrets. Never overwrites an existing file. |
| 2 | `pnpm db:up` | Creates and starts a project-local PostgreSQL cluster in `.data/pg` on port 54329, with app and test databases. Stop it with `pnpm db:down`. |
| 3 | `pnpm db:migrate` | Applies migrations as the owner role, then creates the restricted application role and its grants. |
| 4 | `pnpm db:seed` | Creates demo identities, two workspaces and three merchants. Safe to rerun. |

**Using your own PostgreSQL server:** skip `pnpm db:up`, copy `.env.example` to `.env`, and set `DATABASE_ADMIN_URL` (an owner role that may create tables and roles) and `DATABASE_URL` (a different, plain login role). `pnpm db:migrate` refuses to run if both URLs use the same role, because the application must not own the tables it is restricted on.

## Run

Start the web server and the worker in separate terminals:

```bash
pnpm dev
```

```bash
pnpm worker
```

Open http://localhost:3000. For a production build use `pnpm build` then `pnpm start`, plus `pnpm worker`. A static-only deployment cannot run this application.

`GET /api/health` reports process and database reachability.

### Sign in

`pnpm db:seed` prints the seeded email addresses. Every seeded account uses the `SEED_USER_PASSWORD` value from your local `.env`. There is no public sign-up and no role switcher: to see another role, sign out and sign in as that person.

| Person | Demo workspace role | Notes |
| --- | --- | --- |
| Avery Okafor | Administrator | Also a Viewer in the second workspace (try the workspace selector) |
| Rin Castellanos | Taxonomist | |
| Jo Lindqvist | Operations analyst | |
| Sam Whitlock | Viewer | |
| Dana Mbeki | none | Administrator of the second workspace only |

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_ADMIN_URL` | For migrations | Owner role. Used only by `pnpm db:migrate`, `pnpm db:up` and tests. |
| `DATABASE_URL` | Yes | Non-owner application role used by web and worker. Subject to row-level security. |
| `BETTER_AUTH_SECRET` | Yes | Session signing secret, 16+ characters. |
| `APP_BASE_URL` | Yes | Public origin; also the allowed origin for state-changing requests. |
| `SEED_USER_PASSWORD` | For seeding | Password given to seeded demo identities. |
| `AI_PROVIDER_MODE` | No | Default provider mode: `demo`, `live` or `off`. |
| `ANTHROPIC_API_KEY`, `AI_MODEL_ID` | For live AI | Server-side only. When missing, live mode shows "AI unavailable" and manual workflows keep working; fixtures are never substituted. |
| `STORAGE_DIR` | No | Private directory for staged imports and exports. Not served over HTTP. |
| `JOB_CONCURRENCY`, `JOB_TOKEN_CAP`, `JOB_SPEND_CAP_USD`, `DAILY_WORKSPACE_SPEND_CAP_USD` | No | Worker concurrency and spending caps (enforced from Phase 2). |
| `PG_LOCAL_PORT`, `PG_BIN_DIR` | No | Port and binary location for the optional local cluster. |

The web server and worker fail with a clear message when database or authentication configuration is missing or invalid. No secret is ever sent to the browser.

## Quality checks

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm test
```

`pnpm test` needs the database server running (`pnpm db:up`). It drops and recreates a separate `<database>_test` database from migrations on every run and never touches development data. Tests never call a live AI provider.

## Fixtures

`pnpm fixtures:generate` rebuilds the synthetic data in `fixtures/generated/` from the curated sources in `fixtures/source/`. Output is deterministic and committed; a test fails if the committed files are out of date.

- `taxonomy.csv`: 153 concepts, 106 mappable leaves, eight top-level domains
- `catalogs/*.csv`: 300 unique listings across Harbor Market, Daily Basket and Corner Goods, a second Harbor Market revision, and a small walkthrough file with deliberate errors
- `expected.json`: the curated expected concept (or abstention) for every SKU

## Demo walkthrough (what works today)

1. Sign in as **Avery Okafor**. The Overview shows a setup checklist whose counts are live queries.
2. **Taxonomy → Import taxonomy CSV.** Choose `fixtures/generated/taxonomy.csv`. The validation summary shows 153 concepts and no blocking errors. To see row-level errors instead, edit a copy first: give a parent row `mapping_allowed = true`, or point a `parent_id` at an ID that does not exist.
3. **Commit as draft version.** The draft is visible to administrators and taxonomists only and is labeled "not live".
4. **Publish version 1** and confirm. The version becomes active and immutable; the database rejects any later change to it.
5. Browse the tree with the arrow keys, open a concept, search for `almond`, navigate away and back: expansion and selection are restored.
6. Import a changed copy of the file to get a diff against the active version and a new draft; version 1 is untouched.
7. **Merchants & Catalogs:** add a merchant. Sign in as **Sam Whitlock** to see read-only and permission-denied states. Sign in as **Dana Mbeki** to confirm the second workspace sees none of this data.

The remaining walkthrough steps from PRD section 17 (catalog import, analysis, review, proposals, mapping release, export, analytics) are not built yet.

## Project layout

```text
app/            routes and API handlers
components/     shared UI (shell, tree, dialogs)
db/             schema, SQL migrations, migrate and seed scripts
lib/auth/       sessions, actor resolution, role matrix
lib/api/        route wrapper: auth, validation, errors, idempotency
lib/contracts/  Zod contracts (API bodies, recommendation, AnalysisSpec)
lib/domain/     domain services (merchants, taxonomy, workspace)
lib/analytics/  governed metric registry
lib/ai/         provider interface and provider status
lib/storage/    private object storage adapter
worker/         durable job worker process
fixtures/       synthetic sources, generator and generated files
tests/          unit and integration tests
```
