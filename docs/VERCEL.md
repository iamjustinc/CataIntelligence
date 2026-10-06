# Hosting on Vercel

Status: the repository is prepared for Vercel and the serverless code paths pass the browser tests locally in a mode that imitates it (production build, no worker process, files stored in the database). **It has not been deployed to Vercel by the author of this document.** Treat the first deployment as the real test.

## Why the first deployment showed a 404

The GitHub repository `iamjustinc/CataIntelligence` contained one commit with a single `.gitattributes` file. The application lived in a different local Git repository that had no remote and had never been pushed. Vercel built an empty repository, which takes milliseconds and serves nothing. Nothing was wrong with the application or with Vercel's settings; the code was not there.

## What Vercel provides, and what it does not

| Need | On Vercel | What to do |
| --- | --- | --- |
| The Next.js web application | Yes | Framework preset Next.js, root directory `./` (`vercel.json` sets the framework, install and build commands) |
| PostgreSQL | **No** | A hosted database: Neon, Supabase, or any PostgreSQL 15+ you can reach over the internet. Your laptop's database is not reachable from Vercel |
| A shared private disk for uploads and exports | **No** | Nothing to set up: on Vercel the application stores these in the database (`STORAGE_DRIVER=database`, the default there) |
| A long-running worker for analysis jobs | **No** | Nothing to set up for a demo: on Vercel the web function processes queued jobs after it responds (`JOB_RUNNER=inline`, the default there). See the limits below |
| Running migrations | Not automatically | Run them from your laptop against the hosted database before the first deployment and after any release that adds a migration |

## Step 1: put the real project on GitHub

The local repository is already connected: the remote `origin` points at `https://github.com/iamjustinc/CataIntelligence.git`, and the one commit that was on GitHub (a `.gitattributes` file) has been merged in, so nothing on GitHub is overwritten. One command remains, run in the project folder (`CataTelligence`):

```bash
git push -u origin main
```

If Git asks you to sign in, use your GitHub username and a personal access token, or sign in through the browser prompt.

For reference, the connection was made with `git remote add origin <url>`, `git fetch origin` and `git merge origin/main --allow-unrelated-histories`.

Then delete the stray clone inside the project folder. It is an empty copy of the GitHub repository and is not part of the application:

```bash
rm -rf CataIntelligence
```

Check on GitHub that you now see `app/`, `package.json`, `pnpm-lock.yaml` and the rest. **The repository is public**, so everything in it becomes public when you push, including the PRD and the documentation. Make the repository private on GitHub first (Settings → General → Change visibility) if you do not want that; Vercel works with private repositories. `.env` is not tracked and is never pushed.

## Step 2: create the database

These instructions use Neon; any hosted PostgreSQL works the same way.

1. Create a project and a database, for example `catalog_intelligence`. Choose a region close to the Vercel region you will use.
2. Copy the **owner** connection string. Use the **direct** (non-pooled) host for migrations. This is `DATABASE_ADMIN_URL`.
3. Decide a name and a long random password for the application role, for example `catalog_app`. You do not create it by hand: the migration command creates it with exactly the name and password in `DATABASE_URL`, as a plain login role without owner rights, so row-level security applies to it.
4. Build `DATABASE_URL` from the **pooled** host, the application role and its password, with `sslmode=require`.

The two URLs must name different roles. The migration command refuses to run otherwise.

## Step 3: migrate and seed the hosted database, from your laptop

Do not put the hosted URLs in your `.env`; that file points at your local development database. Pass them on the command line instead, in one terminal session:

```bash
export DATABASE_ADMIN_URL='postgres://OWNER:OWNER_PASSWORD@DIRECT_HOST/catalog_intelligence?sslmode=require'
```

```bash
export DATABASE_URL='postgres://catalog_app:APP_PASSWORD@POOLED_HOST/catalog_intelligence?sslmode=require'
```

```bash
export SEED_USER_PASSWORD='choose-a-password-for-the-demo-accounts'
```

```bash
pnpm db:migrate
```

To load the demo workspace (three merchants, 300 listings, four releases, five demo accounts):

```bash
STORAGE_DRIVER=database pnpm db:seed
```

Close that terminal afterwards so the variables do not linger. Never run `pnpm db:reset` with these variables set: it deletes everything in the database it points at.

Anyone you share the site with signs in with one of the seeded email addresses (listed in the README) and the `SEED_USER_PASSWORD` you chose. There is no sign-up page.

## Step 4: configure the Vercel project

Project → Settings:

| Setting | Value |
| --- | --- |
| Framework Preset | Next.js |
| Root Directory | `./` (leave empty) |
| Build Command, Output Directory, Install Command | Leave the overrides **off**. `vercel.json` supplies them. An "Output Directory" override such as `public` or `dist` is what makes a Next.js project serve a 404 |
| Node.js Version | 22.x or newer |

Environment variables (Production, and Preview if you use it):

| Variable | Value | Required |
| --- | --- | --- |
| `DATABASE_URL` | The application-role URL from step 2 (pooled host) | Yes |
| `BETTER_AUTH_SECRET` | 32 or more random characters. Generate with `openssl rand -base64 32` | Yes |
| `APP_BASE_URL` | The exact public origin people will use, for example `https://cataintelligence.vercel.app`. No trailing slash | Recommended. If unset on Vercel, the project's production domain is used |
| `AI_PROVIDER_MODE` | `demo` | No (default) |
| `ANTHROPIC_API_KEY`, `AI_MODEL_ID` | Only for live AI | No |

Do **not** add `DATABASE_ADMIN_URL` to Vercel. The running site never needs the owner role.

`APP_BASE_URL` matters: sign-in and every state-changing request are refused from any other origin. If you sign in on a preview URL or a custom domain that differs from it, sign-in fails. Use the one production URL.

## Step 5: deploy

Push to `main`, or press Redeploy on the latest deployment (untick "Use existing Build Cache" the first time). A real build installs dependencies and compiles for a minute or more; a build that finishes in milliseconds means Vercel is still looking at an empty repository or the wrong directory.

Then check, in order:

1. `https://YOUR-DOMAIN/api/health` returns `{"status":"ok"}`. A 503 means the function cannot reach the database: check `DATABASE_URL`.
2. `https://YOUR-DOMAIN/login` shows the sign-in page.
3. Sign in as the seeded administrator. The dashboard shows 300 active listings.

## "The website builds" is not "all backend workflows work"

| Level | What it proves | How to check |
| --- | --- | --- |
| The build succeeds | The code compiles. Nothing about the database | Vercel build log |
| `/login` renders | Routing and the framework preset are right | Open it |
| `/api/health` is ok | The function reaches the database with the application role | Open it |
| Sign-in works | `BETTER_AUTH_SECRET`, `APP_BASE_URL` and the seeded accounts are right | Sign in |
| Dashboard, review, releases, analytics | Read and write paths, row-level security | Click through; approve one listing |
| Catalog import | Database-backed storage of the staged file | Import `fixtures/generated/catalogs/walkthrough-pier-pantry.csv` |
| Demo analysis | Inline job processing | "Run demo analysis" on the imported catalog; it should complete within seconds |
| Export | Database-backed storage of the generated file | Export a release as ZIP |

Only the first row is checked by Vercel. The rest you check by using the site.

## Limits of this arrangement

- **Analysis jobs run inside a web function**, after the response, with a 60-second limit per invocation. Demo mode needs no network and finishes at once. A live AI job of more than a few dozen listings will be cut off; it resumes each time the open page polls its status, so it finishes only while someone keeps the catalog page open. For real live-AI use, run `pnpm worker` on a host with a long-running process (Railway, Render, Fly.io, a small VM) with the same `DATABASE_URL`, and set `JOB_RUNNER=worker` on Vercel.
- **Uploads are limited to about 4.5 MB** by Vercel's request size limit, below the application's own 10 MB limit.
- **Expired files are cleaned up opportunistically**, when a job poll finds nothing to do, not on a schedule.
- **Sign-in rate limiting is per function instance**, so it is weaker than on a single server.
- **Each function instance holds up to 5 database connections.** Use the pooled URL so the database is not exhausted.
- **Anyone with a seeded account can change the shared demo data.** For a read-only share, give out only the viewer account.
- **Live AI has still never been run**, here or anywhere.
