import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { e2eEnv } from "./env";
import { apiPost, signIn, USERS } from "./helpers";

/** Rows of the Harbor Market fixture catalog; their content has curated demo suggestions. */
const FIXTURE = readFileSync(resolve(process.cwd(), "fixtures/generated/catalogs/harbor-market-r1.csv"), "utf8").trimEnd().split("\n");
const slice = (from: number, n: number) => [FIXTURE[0], ...FIXTURE.slice(1 + from, 1 + from + n)].join("\n") + "\n";

const panel = (page: Page) => page.locator("section[aria-labelledby='analysis-heading']");
/** The status row of the latest job (badges), as opposed to the count labels below it. */
const jobStatus = (page: Page) => panel(page).locator("[data-testid='analysis-job'] > div").first();
const stat = (page: Page, label: string) => panel(page).locator("dl > div", { has: page.getByText(label, { exact: true }) }).locator("dd");
const statNumber = async (page: Page, label: string) => Number(await stat(page, label).innerText());

/** Creates a merchant with fixture listings through the API, as a signed-in taxonomist. */
async function merchantWithCatalog(page: Page, name: string, from: number, n: number) {
  const merchant = await apiPost<{ id: string }>(page, "/api/merchants", { name });
  expect(merchant.status).toBe(201);
  const staged = await apiPost<{ id: string }>(page, "/api/imports", { merchantId: merchant.data.id, fileName: `${name}.csv`, content: slice(from, n), mode: "snapshot" });
  const committed = await apiPost<{ revisionId: string }>(page, `/api/imports/${staged.data.id}/commit`, { acceptExcluded: false });
  expect(committed.status).toBe(200);
  return { merchantId: merchant.data.id, revisionId: committed.data.revisionId };
}

/** Owner connection to the e2e database, used only to arrange failure states a healthy run cannot produce. */
async function database() {
  const client = new pg.Client({ connectionString: e2eEnv().DATABASE_ADMIN_URL });
  await client.connect();
  return client;
}

test.describe.configure({ mode: "serial" });

test("analysis runs as a background job: progress, cancellation, re-run and a human approval made while it runs", async ({ page }) => {
  await signIn(page, USERS.taxonomist);
  const { merchantId } = await merchantWithCatalog(page, "Queue Market", 0, 60);
  await page.goto(`/catalogs/${merchantId}`);

  await test.step("the estimate is shown before anything starts", async () => {
    await page.getByRole("button", { name: "Run demo analysis" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("60 of 60 active listings will be analyzed");
    await expect(dialog).toContainText("Provider cost: none");
    await dialog.getByRole("button", { name: "Run demo analysis" }).click();
  });

  let suggested = 0;
  await test.step("progress is real and the job can be canceled, keeping completed work", async () => {
    const bar = panel(page).getByRole("progressbar", { name: "Listings processed" });
    await expect(bar).toBeVisible();
    // Wait until the worker has committed at least one item, then cancel.
    await expect.poll(async () => Number(await bar.getAttribute("aria-valuenow")), { timeout: 30_000 }).toBeGreaterThan(0);
    await panel(page).getByRole("button", { name: "Cancel job" }).click();
    await expect(jobStatus(page)).toContainText("Canceled", { timeout: 30_000 });
    suggested = await statNumber(page, "Suggested");
    const canceled = await statNumber(page, "Canceled");
    expect(suggested).toBeGreaterThan(0);
    expect(canceled).toBeGreaterThan(0);
    expect(suggested + canceled).toBe(60);
    // The suggestions produced before cancellation are in the review queue.
    const queue = await (await page.request.get(`/api/review-items?merchant=${merchantId}&state=suggested&limit=1`)).json();
    expect(queue.data.progress.byState.suggested + queue.data.progress.byState.needs_investigation).toBe(suggested);
  });

  await test.step("a reviewer approves a listing while the next job is running; the job does not overwrite it", async () => {
    await page.reload();
    await page.getByRole("button", { name: "Run demo analysis again" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`${60 - suggested} of 60 active listings will be analyzed`);
    await expect(dialog).toContainText(`${suggested} with a current suggestion`);
    await dialog.getByRole("button", { name: "Run demo analysis" }).click();
    await expect(panel(page).getByRole("progressbar", { name: "Listings processed" })).toBeVisible();

    // The last listing in source order: the worker reaches it last.
    const pending = await (await page.request.get(`/api/review-items?merchant=${merchantId}&state=needs_analysis&sort=age&limit=100`)).json();
    const target = pending.data.items[pending.data.items.length - 1];
    const concepts = await (await page.request.get("/api/taxonomy/concepts?q=Notebooks")).json();
    const decision = await apiPost<{ state: string }>(page, `/api/review-items/${target.id}/decisions`, { action: "approve", selectedConceptId: concepts.data[0].conceptId, expectedVersion: target.lockVersion });
    expect(decision.status).toBe(201);

    await expect(jobStatus(page)).toContainText("Completed", { timeout: 60_000 });
    await expect(panel(page)).toContainText("60 of 60 listings processed");
    expect(await statNumber(page, "Failed")).toBe(0);

    await page.goto(`/review/${target.id}`);
    const listing = page.locator("section[aria-labelledby='listing-title']");
    await expect(listing.getByText("Approved", { exact: true }).first()).toBeVisible();
    const history = listing.locator("ol li");
    await expect(history).toHaveCount(1);
    await expect(history.first()).toContainText("Office & School > Notebooks & Paper");
    await expect(history.first()).toContainText("Rin Castellanos · Manual");
  });
});

test("failed items can be retried from the browser, and a job abandoned by a dead worker is recovered", async ({ page }) => {
  await signIn(page, USERS.taxonomist);
  const db = await database();
  try {
    const context = (await db.query("select w.id as ws, w.active_taxonomy_version_id as version, u.id as user from workspaces w, \"user\" u where w.slug = 'tidewater-demo' and u.email = $1", [USERS.taxonomist])).rows[0];
    const arrange = async (revisionId: string, job: { status: string; errorCode: string | null; errorMessage: string | null; lease: string | null }, itemStatus: (i: number) => { status: string; code: string | null }) => {
      const inserted = await db.query(
        `insert into analysis_jobs (workspace_id, catalog_revision_id, taxonomy_version_id, provider_mode, provider, dependency_versions, status, progress, attempt, error_code, error_message, lease_owner, lease_expires_at, cost_usd, created_by, started_at)
         values ($1, $2, $3, 'demo', 'fixture', '{"provider":"fixture"}', $4, '{}', 1, $5, $6, $7, ${job.lease ? "now() - interval '5 seconds'" : "null"}, 0, $8, now()) returning id`,
        [context.ws, revisionId, context.version, job.status, job.errorCode, job.errorMessage, job.lease, context.user],
      );
      const listings = (await db.query("select id from listing_revisions where catalog_revision_id = $1 order by source_row", [revisionId])).rows;
      for (const [i, l] of listings.entries()) {
        const s = itemStatus(i);
        await db.query("insert into analysis_job_items (workspace_id, job_id, listing_revision_id, status, attempt, error_code, error_message) values ($1, $2, $3, $4, $5, $6, $7)", [context.ws, inserted.rows[0].id, l.id, s.status, s.code ? 3 : 0, s.code, s.code ? "The provider did not answer in time." : null]);
      }
      return inserted.rows[0].id as string;
    };

    await test.step("retry: a job whose provider calls timed out is re-queued and completed by the worker", async () => {
      const { merchantId, revisionId } = await merchantWithCatalog(page, "Retry Market", 60, 10);
      // Arranged state: what a job looks like after every provider call timed out three times.
      await arrange(revisionId, { status: "failed", errorCode: null, errorMessage: null, lease: null }, () => ({ status: "failed", code: "timeout" }));
      await page.goto(`/catalogs/${merchantId}`);
      await expect(jobStatus(page)).toContainText("Failed");
      await panel(page).getByText(/10 listings failed analysis/).click();
      await expect(panel(page).getByText("The provider did not answer in time.").first()).toBeVisible();
      expect(await statNumber(page, "Failed")).toBe(10);

      await panel(page).getByRole("button", { name: "Retry 10 unfinished" }).click();
      await expect(jobStatus(page)).toContainText("Completed", { timeout: 60_000 });
      expect(await statNumber(page, "Suggested")).toBe(10);
      expect(await statNumber(page, "Failed")).toBe(0);
      await expect(panel(page).getByText(/failed analysis/)).toHaveCount(0);
    });

    await test.step("restart recovery: the worker takes over a job whose previous worker died mid-batch", async () => {
      const { merchantId, revisionId } = await merchantWithCatalog(page, "Crash Market", 70, 8);
      // Arranged state: a worker that no longer exists held the lease and had three items in flight.
      const jobId = await arrange(revisionId, { status: "running", errorCode: null, errorMessage: null, lease: "worker-that-died" }, (i) => ({ status: i < 3 ? "running" : "pending", code: null }));
      await page.goto(`/catalogs/${merchantId}`);
      await expect(jobStatus(page)).toContainText("Completed", { timeout: 60_000 });
      await expect(panel(page)).toContainText("8 of 8 listings processed");
      expect(await statNumber(page, "Suggested")).toBe(8);
      const row = (await db.query("select attempt, lease_owner, (select count(*)::int from recommendations r where r.job_id = j.id) as recs, (select count(*)::int from (select listing_revision_id from recommendations where job_id = j.id group by 1 having count(*) > 1) d) as duplicates from analysis_jobs j where id = $1", [jobId])).rows[0];
      expect(row).toEqual({ attempt: 2, lease_owner: null, recs: 8, duplicates: 0 });
    });
  } finally {
    await db.end();
  }
});

test("live mode without a server key shows AI unavailable, never demo output, and manual mapping still works", async ({ page }) => {
  await signIn(page, USERS.admin);
  const { merchantId } = await merchantWithCatalog(page, "Manual Market", 78, 4);

  await page.goto("/settings");
  await expect(page.getByText("Not configured")).toBeVisible();
  await page.getByRole("radio", { name: /^Live/ }).check();
  await page.getByRole("textbox", { name: "Model ID" }).fill("claude-opus-5-5");
  await page.getByRole("checkbox", { name: /Allow this workspace to send catalog data/ }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/Settings saved/)).toBeVisible();
  await expect(page.getByText("AI unavailable").first()).toBeVisible();

  await page.goto(`/catalogs/${merchantId}`);
  await expect(panel(page).getByText("AI unavailable")).toBeVisible();
  await expect(panel(page)).toContainText("no OpenAI key or model ID");
  await expect(panel(page).getByRole("button", { name: /Run (demo|live) analysis/ })).toHaveCount(0);
  // The API refuses too, and creates neither a job nor any suggestion.
  const revision = await (await page.request.get(`/api/review-items?merchant=${merchantId}&limit=1`)).json();
  const listing = revision.data.items[0];
  const item = await (await page.request.get(`/api/review-items/${listing.id}`)).json();
  const refused = await apiPost(page, "/api/analysis-jobs", { catalogRevisionId: item.data.revision.id });
  expect(refused.status).toBe(503);
  expect(item.data.recommendation).toBeNull();

  // Manual mapping is unaffected.
  await page.goto(`/review/${listing.id}`);
  await expect(page.getByRole("heading", { name: "No recommendation" })).toBeVisible();
  await page.getByRole("button", { name: "Map to this" }).first().click();
  await page.getByRole("button", { name: /^Approve mapping/ }).click();
  await expect(page.locator("footer")).toContainText("1 approved, 3 remaining");

  // Restore demo mode for anyone inspecting the e2e database afterwards.
  await page.goto("/settings");
  await page.getByRole("radio", { name: /^Demo/ }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/Settings saved/)).toBeVisible();
  await expect(page.getByText("Demo AI").first()).toBeVisible();
});
