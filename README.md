# Catalog Intelligence

Reconcile merchant catalogs with a canonical taxonomy, publish reproducible mapping releases, and analyze the same governed data in plain language. Taxonomy is the primary workflow; analytics reads the same database, revisions, releases and permissions.

- Specification: [PRD.md](PRD.md)
- What is built and how it was verified: [BUILD_STATUS.md](BUILD_STATUS.md)
- Architecture decisions: [DECISIONS.md](DECISIONS.md)

> **Status:** Phases 0 and 1 are verified. The full deterministic workflow works end to end: import a merchant catalog, review demo or manual mappings, propose and publish taxonomy changes, revalidate, publish a mapping release and export it. Live AI (Phase 2) and analytics (Phase 3) are not built yet, and the app says so on those screens. See BUILD_STATUS.md.

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
| 4 | `pnpm db:seed` | Creates demo identities and two workspaces, then loads the demo scenario through the application services: taxonomy, three merchant catalogs, demo suggestions, review decisions, a pending proposal and four releases. Safe to rerun. |

To throw away local data and reload the demo from scratch:

```bash
pnpm db:reset --yes
```

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
| `UPLOAD_RATE_LIMIT_PER_MINUTE` | No | Catalog and taxonomy uploads allowed per user per minute. Default 30. |
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

```bash
pnpm test:e2e
```

`pnpm test` needs the database server running (`pnpm db:up`). It drops and recreates a separate `<database>_test` database from migrations on every run and never touches development data. Tests never call a live AI provider.

`pnpm test:e2e` rebuilds a third database (`<database>_e2e`) from migrations and the demo seed, makes a production build, starts it on port 3100 and runs the Chromium browser tests. The first run needs the browser once:

```bash
pnpm exec playwright install chromium
```

## Fixtures

`pnpm fixtures:generate` rebuilds the synthetic data in `fixtures/generated/` from the curated sources in `fixtures/source/`. Output is deterministic and committed; a test fails if the committed files are out of date.

- `taxonomy.csv`: 153 concepts, 106 mappable leaves, eight top-level domains
- `catalogs/*.csv`: 300 unique listings across Harbor Market, Daily Basket and Corner Goods, a second Harbor Market revision, and a small walkthrough file with deliberate errors
- `expected.json`: the curated expected concept (or abstention) for every SKU

Demo suggestions are bound to the content of these fixture rows. Change a fixture title and that listing no longer gets a demo suggestion.

## Demo walkthrough

After `pnpm db:seed` the demo workspace already holds a published taxonomy, three merchants (Harbor Market with two catalog revisions and three releases, Daily Basket with one release, Corner Goods reviewed but unpublished), 300 active listings and one proposal awaiting a decision. Every suggestion is deterministic fixture output and is labeled **Demo**.

1. Sign in as **Rin Castellanos** (taxonomist). The Overview shows live counts: 300 active listings, 172 approved, 128 pending.
2. **Merchants & Catalogs:** add a merchant named `Pier Pantry`, open it and choose **Import catalog**. Pick `fixtures/generated/catalogs/walkthrough-pier-pantry.csv`.
3. The file uses its own header names; the mapping is suggested and editable. The summary shows 14 input rows = 8 accepted + 5 rejected + 1 collapsed, with the reason for every rejected row. Choose the row to keep for the conflicting SKU `PP-004`, tick the exclusion box and commit. Revision 1 has 9 listings.
4. **Run demo analysis.** Nine demo suggestions appear. Upload a file of your own products instead and you get none: they stay available for manual mapping.
5. **Review listings.** Press `A` to approve the first item. On *Coconut Milk Shampoo* the demo suggestion was misled by the merchant category: search for `shampoo`, choose the hair care leaf, give a reason and **Change mapping**. **Defer** *Apple*. Mark *Ginger Kombucha* **No suitable category**, then reopen it and **Propose this leaf**.
6. Sign in as **Avery Okafor** (administrator). **Taxonomy → Proposals:** approve the proposal; it lands in draft version 2. Open the draft and **Publish version 2**.
7. Every earlier approval and suggestion is now stale and releases are blocked. On **Taxonomy**, choose **Revalidate dependencies**: unchanged decisions are kept, and the kombucha listing returns to review. Map it to the new leaf.
8. **Releases:** preview Pier Pantry (8 mapped, 1 unresolved), give a reason, acknowledge the partial release and publish. Export the ZIP: `mappings.csv`, `unresolved.csv` and `release.json` reconcile with the preview, and the formula-like title is neutralized in the file.
9. **Audit** lists every step with actor, reason and before/after references. In **Releases**, try **Make current (rollback)** on Harbor Market release 2.
10. Sign in as **Sam Whitlock** to see read-only states, and as **Dana Mbeki** to confirm the second workspace sees none of this.

The browser test `tests/e2e/workflow.spec.ts` performs steps 2 to 9 automatically. Analytics questions (the last step of PRD section 17) are not built yet.

## Project layout

```text
app/            routes and API handlers
components/     shared UI (shell, tree, dialogs)
db/             schema, SQL migrations, migrate and seed scripts
lib/auth/       sessions, actor resolution, role matrix
lib/api/        route wrapper: auth, validation, errors, idempotency
lib/contracts/  Zod contracts (API bodies, recommendation, AnalysisSpec)
lib/domain/     domain services (catalog import, review, analysis, taxonomy, proposals, releases, audit)
lib/retrieval/  deterministic candidate retrieval
lib/export/     spreadsheet-safe CSV and ZIP writers
lib/analytics/  governed metric registry
lib/ai/         provider interface, fixture provider, response validation and signal policy
lib/storage/    private object storage adapter
worker/         durable job worker process
fixtures/       synthetic sources, generator and generated files
tests/          unit, integration and browser (tests/e2e) tests
```
