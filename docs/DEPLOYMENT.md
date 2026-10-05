# Deployment

Status: **these instructions have not been exercised on a hosting platform.** They describe what the application needs, verified locally with a production build (`next build`, `next start`) and the real worker process in the browser test suite. Nothing here has been deployed.

## What runs

| Process | Command | Notes |
| --- | --- | --- |
| Web | `pnpm build` once, then `pnpm start` | Next.js server. Needs Node.js 22 or newer. Listens on `PORT` (default 3000) |
| Worker | `pnpm worker` | Long-running Node process. Processes analysis jobs and deletes expired files. Exactly one is enough; more than one is safe because jobs are leased |
| Database | PostgreSQL 15 or newer | Two roles: an owner for migrations, a non-owner application role for web and worker |
| File storage | A private directory (`STORAGE_DIR`) | Staged uploads and generated exports. Must be shared by web and worker and must not be served over HTTP |

A static export or a serverless-only host cannot run this application: analysis needs the worker, and web and worker need the same private storage.

## Order of operations for a release

1. Take a database backup (see `docs/PILOT_CHECKLIST.md`).
2. Build the new version: `pnpm install --frozen-lockfile`, then `pnpm build`.
3. Apply migrations as the **owner** role: `pnpm db:migrate`. Migrations so far are additive. The command also creates the application role and its grants, and refuses to run if the owner and application URLs name the same role.
4. Restart the worker, then the web process. A worker stopped mid-job loses nothing: its lease expires and the next worker resumes without duplicating recommendations.
5. Check `GET /api/health` on the web process (200 with `{"status":"ok"}`; 503 when the database is unreachable) and `GET /health` on the worker if `WORKER_HEALTH_PORT` is set.

Do not run `pnpm db:seed` or `pnpm db:reset` against a database that holds real work. `db:seed` only adds demo identities and a demo workspace, but it is not meant for production; `db:reset` destroys everything.

## Configuration

All variables are listed in `.env.example` and the README. For a deployment:

| Variable | Requirement |
| --- | --- |
| `DATABASE_URL` | The **application** role. Row-level security applies to it. Never the owner |
| `DATABASE_ADMIN_URL` | The owner. Needed only where migrations run; do not give it to the web or worker processes |
| `BETTER_AUTH_SECRET` | At least 32 random bytes. Changing it signs everyone out |
| `APP_BASE_URL` | The public HTTPS origin. State-changing requests from any other origin are refused |
| `ANTHROPIC_API_KEY`, `AI_MODEL_ID` | Only for live AI. Set on web and worker. Without them the application works with manual mapping and shows "AI unavailable" |
| `STORAGE_DIR` | A persistent private path mounted in both processes |
| `NODE_ENV=production` | Shown to users as the "Production" badge |

The web and worker processes stop with a clear message when database or authentication settings are missing or invalid. Missing AI settings do not stop them.

## Before live AI is switched on

1. Confirm the provider's data retention and training terms for the account that owns the key. The application makes no claim about them.
2. In **Settings**, an administrator chooses Live, ticks the opt-in that lists the fields sent to the provider, sets the model ID, enters current prices and reviews the per-job and daily caps. Cost is reported as unknown, never zero, until prices are entered.
3. Run `pnpm smoke:live`. It makes a small fixed number of real calls and exits with code 2 without calling anything when credentials are missing.
4. High signal stays disabled. Enabling it requires the evaluation in `evals/PROTOCOL.md`.

## Operations

- **Logs.** The worker writes one JSON line per event with job ID, outcome and error code; it never logs the provider key or catalog text. The web process logs unexpected errors with a request ID that is also returned to the caller.
- **A cancelled navigation** is logged by the web server as "The destination stream closed early". It means a browser left a page before it finished rendering. It is not a failure.
- **Stuck job.** A job whose worker died resumes when a worker next polls. If no worker is running, jobs stay "Queued".
- **Budget stop.** A job that reaches a cap stops between batches and keeps completed work. Raise the cap in Settings or wait for the next UTC day, then retry the unfinished items.
- **Sign-in rate limit.** Repeated sign-in attempts are limited by the authentication library; the limit is per server process and resets on restart.

## Not provided

- No container image, process manager configuration or infrastructure code.
- No TLS termination, reverse proxy configuration or CDN setup.
- No metrics endpoint, alerting or log shipping. PRD section 16 asks for failed-job alerts and a model error rate; the data is in `analysis_jobs` and `ai_usage` but nothing watches it.
- No object-store adapter. Storage is a local directory behind an interface (`lib/storage`).
- No member management screen. Members are rows in `memberships`, added by a database administrator.
- No workspace deletion.
