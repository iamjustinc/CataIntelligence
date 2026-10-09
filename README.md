# Catalog Intelligence

Reconcile merchant catalogs with a canonical taxonomy, publish reproducible mapping releases, and analyze the same governed data in plain language. Taxonomy is the primary workflow; analytics reads the same database, revisions, releases and permissions.

- Specification: [PRD.md](PRD.md)
- What is built and how it was verified: [BUILD_STATUS.md](BUILD_STATUS.md)
- Architecture decisions: [DECISIONS.md](DECISIONS.md)

> **Status:** a demonstration candidate, hosted at https://catatelligence-rho.vercel.app. The complete workflow passes in a browser on a production build, and the live OpenAI adapters have passed a small real smoke test locally. Not yet verified: the signed-in journey on the hosted site, and live AI running through the application. It is not production-ready. See BUILD_STATUS.md for the evidence and `docs/DEMO.md` for the presentation script.

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

Open http://localhost:3000. **Analysis jobs are processed by the worker**: without it a job stays "Queued". For a production build use `pnpm build` then `pnpm start`, plus `pnpm worker`. A static-only deployment cannot run this application.

`GET /api/health` reports web process and database reachability. Set `WORKER_HEALTH_PORT` to give the worker a `/health` endpoint.

Restart `pnpm dev` after installing or removing dependencies. Changing packages under a running dev server can hot-load a second copy of React into an open page ("Invalid hook call" in the browser console).

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
| `OPENAI_API_KEY` | For live AI (default provider) | Read by the web server and worker only. Never stored in the database, returned by an API or logged. When missing, live mode shows "AI unavailable" and manual workflows keep working; fixtures are never substituted. Never put a real key in `.env.example`: that file is committed. |
| `AI_PROVIDER` | No | `openai` or `anthropic`. When unset, whichever provider has a key; OpenAI if both or neither. |
| `ANTHROPIC_API_KEY` | For live AI with `AI_PROVIDER=anthropic` | Same handling as the OpenAI key. |
| `AI_MODEL_ID` | For live AI | Default model for workspaces that set none in Settings, for example `gpt-5.4-mini`. The application assumes no model. |
| `STORAGE_DIR` | No | Private directory for staged imports and exports. Not served over HTTP. |
| `STORAGE_DRIVER` | No | `local` (default) or `database`, for hosts without a shared disk. Defaults to `database` on Vercel. |
| `JOB_RUNNER` | No | `worker` (default) or `inline`, where the web process runs jobs after responding. Defaults to `inline` on Vercel. |
| `DB_POOL_MAX` | No | Database connections per process (default 10; 5 on Vercel). |
| `UPLOAD_RATE_LIMIT_PER_MINUTE` | No | Catalog and taxonomy uploads allowed per user per minute. Default 30. |
| `JOB_CONCURRENCY` | No | Provider calls in flight per job (default 2). |
| `WORKER_POLL_MS`, `WORKER_LEASE_SECONDS`, `WORKER_ITEM_DELAY_MS`, `WORKER_HEALTH_PORT` | No | Worker poll interval, lease length, pause between provider calls, and health port. |

Provider mode, live opt-in, model, prices and the per-job and daily caps are workspace settings, changed by an administrator under **Settings** and recorded in the audit log.
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

`pnpm test` needs the database server running (`pnpm db:up`). It drops and recreates a separate `<database>_test` database from migrations on every run and never touches development data. Tests never call a live AI provider. Only one run can use the test database at a time: a second `pnpm test` started while another is running stops immediately and names the process holding the lock.

```bash
pnpm backup:check
```

`pnpm backup:check` dumps a database (read-only), restores it into a scratch database, compares the two and drops the scratch database. See `docs/PILOT_CHECKLIST.md`.

`pnpm test:e2e` rebuilds a third database (`<database>_e2e`) from migrations and the demo seed, makes a production build, starts it on port 3100 together with the real worker process, and runs the Chromium browser tests: the workflow, jobs, analytics, accessibility rules and keyboard operation on every screen, the role matrix on every API route, rollback and failure recovery. The first run needs the browser once:

```bash
pnpm exec playwright install chromium
```

## Live AI

1. Put `OPENAI_API_KEY` and `AI_MODEL_ID` in the server environment (your private `.env`, or the host's settings) and restart the web server and worker. For Claude instead, set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.
2. As an administrator open **Settings**: choose Live, enter the model ID and provider prices, tick the opt-in that lists the fields sent, and save.
3. Open a merchant and choose **Run live analysis**. The dialog shows the estimated tokens and cost and the caps before anything is sent.

A separately budgeted smoke test makes five real calls (three recommendations, two analytics interpretations) and prints actual usage. It exits with code 2 and makes no call when credentials are missing:

```bash
AI_MODEL_ID=gpt-5.4-mini pnpm smoke:live --input-price 0.75 --output-price 4.50 --budget 2
```

The prices are the provider's current prices per million tokens for that model; the script uses them to stop before the budget is exceeded.

## Analytics

The **Overview** dashboard and the **Analytics** page read the same metric service (`lib/analytics/metric-service.ts`). Eight registered metrics are computed from stored records, scoped to the signed-in workspace.

A question goes through three steps, and nothing runs until the last one:

1. **Interpret.** Fixed rules first refuse what analytics may never do: run SQL, read another workspace, change data, or report sales and revenue that are not recorded. Then a planner proposes an analysis.
2. **Check or edit** the interpretation with the controls. The controls also work on their own, with no planner.
3. **Run.** The server validates the analysis against the metric registry, builds the query itself and stores the run.

Which planner answers depends on the workspace's AI mode, and every result says which one produced it:

| Mode | Planner | What it is |
| --- | --- | --- |
| Demo | Demo planner | Rule-based phrase matching, **not AI**. It refuses any question it cannot match completely |
| Live, with a server key | Live AI | Claude proposes a structured analysis; the server validates it. Usage is recorded. **Not yet run against a real model** |
| Off, or live without a key | None | Only the fixed rules and the controls. There is no fallback to the demo planner |

Results can be saved as reports. A report keeps the result as it was when saved; **Refresh** computes a separate result from current data. Reports are private until their owner shares them, and conversations are always private to their owner.

The 40-question benchmark runs as part of `pnpm test` (`tests/integration/analytics-benchmark.test.ts`) and writes `evals/reports/analytics-benchmark-demo.json`. It checks the demo planner and the metric SQL against hand-written reference queries. It was written by the same author as the planner rules, so it is a regression check, not an independent accuracy measurement.

The 40 analytics questions can be put to the live planner, about 30 real calls, with:

```bash
pnpm eval:analytics:live
```

Both commands refuse to run without credentials. Neither has ever been run with them.

## Evaluation

The full protocol is in `evals/PROTOCOL.md`. In short: the two existing sets are development data, and a launch gate needs a frozen, expert-labeled test set that does not exist yet.

`evals/corpus/` holds a development set and a held-out set (304 records, three fictional merchants, eight domains) that share no product family, and no title, with each other or with the demo fixtures.

```bash
pnpm eval:check
```

```bash
pnpm eval --split development --provider baseline
```

**The held-out set has been inspected.** Its baseline misses were printed and read while the harness was built, so it is no longer an untouched evaluation: reports on it say INSPECTED and it cannot open the High signal gate. Tune against the development set only. It is development data now. An independent assessment needs the frozen set described in `evals/PROTOCOL.md`; `pnpm eval --split frozen` refuses to run until that set exists, matches its manifest and is fully expert-labeled.

`baseline` is a deterministic lexical yardstick, not a model. `--provider claude --max-items <n>` runs the live adapter and spends money. Reports are written to `evals/reports/`.

**The labels are provisional.** They were written by the model that built this application, not by an independent expert, so results on them are preliminary and cannot satisfy a launch gate. To make them ground truth, have a domain expert correct `evals/corpus/*.jsonl` and set `labeling.source` to `expert`, with a second reviewer adjudicating ambiguous items.

## Fixtures

`pnpm fixtures:generate` rebuilds the synthetic data in `fixtures/generated/` from the curated sources in `fixtures/source/`. Output is deterministic and committed; a test fails if the committed files are out of date.

- `taxonomy.csv`: 153 concepts, 106 mappable leaves, eight top-level domains
- `catalogs/*.csv`: 300 unique listings across Harbor Market, Daily Basket and Corner Goods, a second Harbor Market revision, and a small walkthrough file with deliberate errors
- `expected.json`: the curated expected concept (or abstention) for every SKU

Demo suggestions are bound to the content of these fixture rows. Change a fixture title and that listing no longer gets a demo suggestion.

## Demo walkthrough

After `pnpm db:seed` the demo workspace already holds a published taxonomy, three merchants (Harbor Market with two catalog revisions and three releases, Daily Basket with one release, Corner Goods reviewed but unpublished), 300 active listings and one proposal awaiting a decision. Every suggestion is deterministic fixture output and is labeled **Demo**.

1. Sign in as **Rin Castellanos** (taxonomist). The Overview dashboard shows 300 active listings, published coverage 46.7% (140 of 300), approved draft coverage 57.3% (172 of 300) and 128 pending. Each card links to the same listings in the review queue.
2. **Merchants & Catalogs:** add a merchant named `Pier Pantry`, open it and choose **Import catalog**. Pick `fixtures/generated/catalogs/walkthrough-pier-pantry.csv`.
3. The file uses its own header names; the mapping is suggested and editable. The summary shows 14 input rows = 8 accepted + 5 rejected + 1 collapsed, with the reason for every rejected row. Choose the row to keep for the conflicting SKU `PP-004`, tick the exclusion box and commit. Revision 1 has 9 listings.
4. **Run demo analysis.** The dialog shows what will be analyzed and that demo mode has no provider cost; the job is queued and the worker processes it while the panel shows live progress. Nine demo suggestions appear. Upload a file of your own products instead and you get none: they stay available for manual mapping.
5. **Review listings.** Press `A` to approve the first item. On *Coconut Milk Shampoo* the demo suggestion was misled by the merchant category: search for `shampoo`, choose the hair care leaf, give a reason and **Change mapping**. **Defer** *Apple*. Mark *Ginger Kombucha* **No suitable category**, then reopen it and **Propose this leaf**.
6. Sign in as **Avery Okafor** (administrator). **Taxonomy → Proposals:** approve the proposal; it lands in draft version 2. Open the draft and **Publish version 2**.
7. Every earlier approval and suggestion is now stale and releases are blocked. On **Taxonomy**, choose **Revalidate dependencies**: unchanged decisions are kept, and the kombucha listing returns to review. Map it to the new leaf.
8. **Releases:** preview Pier Pantry (8 mapped, 1 unresolved), give a reason, acknowledge the partial release and publish. Export the ZIP: `mappings.csv`, `unresolved.csv` and `release.json` reconcile with the preview, and the formula-like title is neutralized in the file.
9. **Audit** lists every step with actor, reason and before/after references. In **Releases**, try **Make current (rollback)** on Harbor Market release 2.
10. Sign in as **Sam Whitlock** to see read-only states, and as **Dana Mbeki** to confirm the second workspace sees none of this.

11. Sign in as **Jo Lindqvist** (analyst) and open **Analytics**. Ask "Which merchant still needs the most review?" and follow a row's link into the review queue. Then ask "Which merchant has the lowest published coverage?", read the interpretation, run it, then follow up with "Only grocery products". Corner Goods shows 0% with a note that it has never published. Save the result as a report, publish another release as the administrator, and use **Refresh** to see the new figure beside the saved snapshot.

The browser tests `tests/e2e/01-workflow.spec.ts` (steps 2 to 9), `02-jobs.spec.ts`, `03-analytics.spec.ts` (dashboard reconciliation, question to drilldown, report refresh, permissions), `04-accessibility.spec.ts` and `05-recovery-and-permissions.spec.ts` perform these automatically.

## Deployment and pilot

**To host it on Vercel, follow `docs/VERCEL.md`.** It needs a hosted PostgreSQL database; uploads, exports and analysis jobs then work without a separate worker or disk.

`docs/DEPLOYMENT.md` describes the web and worker processes, configuration and release order. `docs/PILOT_CHECKLIST.md` covers backup, restore and what must be true before real users and real data. Neither has been exercised on a host.

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
lib/analytics/  metric registry, metric service (query compiler), planners (guards, demo rules, Claude), time and formatting
lib/ai/         provider interface, Claude adapter, fixture provider, response validation and signal policy
lib/jobs/       job engine the worker runs (leases, retries, cancellation) and storage cleanup
evals/          evaluation protocol, corpus, leakage checks, metrics, runner, reports and the analytics benchmark (evals/analytics)
docs/           deployment guide and pilot checklist
lib/storage/    private object storage adapter
worker/         durable job worker process
fixtures/       synthetic sources, generator and generated files
tests/          unit, integration and browser (tests/e2e) tests
```
