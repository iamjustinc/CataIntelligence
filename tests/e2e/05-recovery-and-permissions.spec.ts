import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import pg from "pg";
import { e2eEnv } from "./env";
import { signIn, USERS } from "./helpers";

let db: pg.Client;
let workspaceId: string;
test.beforeAll(async () => {
  db = new pg.Client({ connectionString: e2eEnv().DATABASE_ADMIN_URL });
  await db.connect();
  workspaceId = (await db.query("select id from workspaces where slug = 'tidewater-demo'")).rows[0].id;
});
test.afterAll(async () => {
  await db.end();
});

const ORIGIN = { origin: e2eEnv().APP_BASE_URL };
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = [workspaceId]) => (await db.query(sql, params)).rows[0] as T;
async function as(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return { context, page };
}

test.describe.configure({ mode: "serial" });

type Role = "administrator" | "taxonomist" | "analyst" | "viewer";
/** PRD section 3.2, written out here independently of the application's permission table. */
const ALLOWED: Record<string, Role[]> = {
  read: ["administrator", "taxonomist", "analyst", "viewer"],
  importAndAnalyze: ["administrator", "taxonomist"],
  review: ["administrator", "taxonomist"],
  propose: ["administrator", "taxonomist"],
  manageTaxonomyAndPublish: ["administrator"],
  analytics: ["administrator", "taxonomist", "analyst", "viewer"],
  shareReport: ["administrator", "taxonomist", "analyst"],
  audit: ["administrator", "taxonomist"],
  manageWorkspace: ["administrator"],
};
const ID = "00000000-0000-4000-8000-000000000000";
/** Every API route. `probe: false` marks calls that would change data for a permitted role, so only refusals are exercised. */
const ROUTES: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; needs: keyof typeof ALLOWED; probe?: boolean }[] = [
  { method: "GET", path: "/api/me", needs: "read" },
  { method: "GET", path: "/api/merchants", needs: "read" },
  { method: "POST", path: "/api/merchants", needs: "importAndAnalyze" },
  { method: "POST", path: "/api/imports", needs: "importAndAnalyze" },
  { method: "GET", path: `/api/imports/${ID}`, needs: "read" },
  { method: "PUT", path: `/api/imports/${ID}/mapping`, needs: "importAndAnalyze" },
  { method: "POST", path: `/api/imports/${ID}/commit`, needs: "importAndAnalyze" },
  { method: "GET", path: `/api/catalogs/${ID}/listings`, needs: "read" },
  { method: "POST", path: "/api/analysis-jobs", needs: "importAndAnalyze" },
  { method: "POST", path: "/api/analysis-jobs/estimate", needs: "importAndAnalyze" },
  { method: "GET", path: `/api/analysis-jobs/${ID}`, needs: "read" },
  { method: "POST", path: `/api/analysis-jobs/${ID}/cancel`, needs: "importAndAnalyze" },
  { method: "POST", path: `/api/analysis-jobs/${ID}/retry`, needs: "importAndAnalyze" },
  { method: "GET", path: "/api/review-items", needs: "read" },
  { method: "GET", path: `/api/review-items/${ID}`, needs: "read" },
  { method: "POST", path: `/api/review-items/${ID}/decisions`, needs: "review" },
  { method: "POST", path: "/api/review/bulk-approve", needs: "review" },
  { method: "GET", path: "/api/taxonomy/concepts?q=milk", needs: "read" },
  { method: "GET", path: "/api/taxonomy/versions", needs: "read" },
  { method: "GET", path: `/api/taxonomy/versions/${ID}`, needs: "read" },
  { method: "POST", path: `/api/taxonomy/versions/${ID}/publish`, needs: "manageTaxonomyAndPublish" },
  { method: "POST", path: `/api/taxonomy/versions/${ID}/discard`, needs: "manageTaxonomyAndPublish" },
  { method: "POST", path: "/api/taxonomy/imports", needs: "manageTaxonomyAndPublish" },
  { method: "GET", path: `/api/taxonomy/imports/${ID}`, needs: "manageTaxonomyAndPublish" },
  { method: "POST", path: `/api/taxonomy/imports/${ID}/commit`, needs: "manageTaxonomyAndPublish" },
  { method: "GET", path: "/api/taxonomy/proposals", needs: "propose" },
  { method: "POST", path: "/api/taxonomy/proposals", needs: "propose" },
  { method: "POST", path: `/api/taxonomy/proposals/${ID}/decision`, needs: "manageTaxonomyAndPublish" },
  { method: "POST", path: "/api/taxonomy/revalidate", needs: "manageTaxonomyAndPublish", probe: false },
  { method: "GET", path: "/api/releases", needs: "read" },
  { method: "POST", path: "/api/releases", needs: "manageTaxonomyAndPublish" },
  { method: "POST", path: "/api/releases/preview", needs: "manageTaxonomyAndPublish" },
  { method: "POST", path: `/api/releases/${ID}/activate`, needs: "manageTaxonomyAndPublish" },
  { method: "POST", path: `/api/releases/${ID}/exports`, needs: "read" },
  { method: "GET", path: `/api/exports/${ID}`, needs: "read" },
  { method: "GET", path: "/api/dashboard", needs: "analytics" },
  { method: "GET", path: "/api/analytics/context", needs: "analytics" },
  { method: "GET", path: "/api/analytics/conversations", needs: "analytics" },
  { method: "GET", path: `/api/analytics/conversations/${ID}`, needs: "analytics" },
  { method: "POST", path: "/api/analytics/interpret", needs: "analytics" },
  { method: "POST", path: "/api/analytics/execute", needs: "analytics" },
  { method: "GET", path: `/api/analytics/runs/${ID}/export`, needs: "analytics" },
  { method: "GET", path: "/api/reports", needs: "analytics" },
  { method: "POST", path: "/api/reports", needs: "analytics" },
  { method: "GET", path: `/api/reports/${ID}`, needs: "analytics" },
  { method: "PATCH", path: `/api/reports/${ID}`, needs: "shareReport" },
  { method: "DELETE", path: `/api/reports/${ID}`, needs: "analytics" },
  { method: "POST", path: `/api/reports/${ID}/refresh`, needs: "analytics" },
  { method: "GET", path: "/api/audit", needs: "audit" },
  { method: "GET", path: "/api/members", needs: "manageWorkspace" },
  { method: "GET", path: "/api/settings", needs: "manageWorkspace" },
  { method: "PUT", path: "/api/settings", needs: "manageWorkspace" },
];
const call = (request: APIRequestContext, r: (typeof ROUTES)[number]) => request.fetch(r.path, { method: r.method, headers: ORIGIN, ...(r.method === "GET" || r.method === "DELETE" ? {} : { data: {} }) });
const TABLES = ["merchants", "import_jobs", "catalog_revisions", "analysis_jobs", "review_decisions", "taxonomy_versions", "taxonomy_proposals", "mapping_releases", "export_files", "saved_reports", "analytics_runs"];
const rowCounts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await db.query(`select count(*)::int as n from ${t}`)).rows[0].n])));

test("every API route enforces the role matrix, and requires a session (KPI06)", async ({ browser, playwright }) => {
  test.setTimeout(300_000);
  const before = await rowCounts();
  await test.step("no session: every route answers 401", async () => {
    const anonymous = await playwright.request.newContext({ baseURL: e2eEnv().APP_BASE_URL });
    for (const r of ROUTES) expect((await call(anonymous, r)).status(), `${r.method} ${r.path}`).toBe(401);
    await anonymous.dispose();
  });
  const users: [Role, string][] = [["viewer", USERS.viewer], ["analyst", USERS.analyst], ["taxonomist", USERS.taxonomist], ["administrator", USERS.admin]];
  for (const [role, email] of users) {
    await test.step(`${role}: refused exactly where the role matrix says so`, async () => {
      const { context, page } = await as(browser, email);
      let refused = 0;
      for (const r of ROUTES) {
        const permitted = ALLOWED[r.needs].includes(role);
        if (permitted && r.probe === false) continue;
        const res = await call(page.request, r);
        const label = `${role} ${r.method} ${r.path} → ${res.status()}`;
        if (permitted) {
          expect(res.status(), label).not.toBe(403);
          expect(res.status(), label).not.toBe(401);
          expect(res.status(), label).toBeLessThan(500);
        } else {
          refused++;
          expect(res.status(), label).toBe(403);
          const body = await res.json();
          expect(body.error.code, label).toBe("forbidden");
          expect(JSON.stringify(body), label).not.toMatch(/stack|at \w+ \(|node_modules/);
        }
      }
      expect(refused).toBe(ROUTES.filter((r) => !ALLOWED[r.needs].includes(role)).length);
      await context.close();
    });
  }
  // The scheduled job route is not part of the role matrix: without the host's secret it refuses everyone.
  expect((await (await browser.newContext({ baseURL: e2eEnv().APP_BASE_URL })).request.get("/api/cron/jobs", { headers: { authorization: "Bearer guess" } })).status()).toBe(401);
  // The probes used empty bodies and an unknown ID: nothing may have been created by any role.
  expect(await rowCounts()).toEqual(before);
});

test("another workspace cannot reach real records by ID: endpoints, jobs, reports and exports (AT24)", async ({ browser }) => {
  const ids = await one<Record<string, string | null>>(
    `select (select id from mapping_releases where workspace_id = $1 limit 1) as release, (select id from export_files where workspace_id = $1 limit 1) as export,
            (select id from analysis_jobs where workspace_id = $1 limit 1) as job, (select id from import_jobs where workspace_id = $1 limit 1) as import,
            (select id from listing_revisions where workspace_id = $1 limit 1) as listing, (select id from catalog_revisions where workspace_id = $1 limit 1) as revision,
            (select id from taxonomy_versions where workspace_id = $1 limit 1) as version, (select id from saved_reports where workspace_id = $1 and visibility = 'workspace' limit 1) as report,
            (select id from analytics_conversations where workspace_id = $1 limit 1) as conversation, (select id from analytics_runs where workspace_id = $1 limit 1) as run`,
  );
  for (const [name, id] of Object.entries(ids)) expect(id, `a ${name} exists in the demo workspace to test with`).toBeTruthy();
  const { context, page } = await as(browser, USERS.outsider);
  const gets = [`/api/exports/${ids.export}`, `/api/analysis-jobs/${ids.job}`, `/api/imports/${ids.import}`, `/api/review-items/${ids.listing}`, `/api/catalogs/${ids.revision}/listings`, `/api/taxonomy/versions/${ids.version}`, `/api/reports/${ids.report}`, `/api/analytics/conversations/${ids.conversation}`, `/api/analytics/runs/${ids.run}/export`];
  for (const path of gets) {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(404);
    expect(await res.text(), path).not.toMatch(/Harbor|Daily Basket|Corner Goods|Tidewater/);
  }
  const posts: [string, unknown][] = [
    [`/api/releases/${ids.release}/activate`, { expectedVersion: 0, activateCatalogRevision: false, reason: "cross-workspace probe" }],
    [`/api/releases/${ids.release}/exports`, { kind: "zip" }],
    [`/api/analysis-jobs/${ids.job}/retry`, {}],
    [`/api/analysis-jobs/${ids.job}/cancel`, {}],
    [`/api/reports/${ids.report}/refresh`, {}],
    [`/api/review-items/${ids.listing}/decisions`, { action: "defer", expectedVersion: 0 }],
    ["/api/analysis-jobs", { catalogRevisionId: ids.revision }],
  ];
  for (const [path, data] of posts) {
    const res = await page.request.post(path, { data, headers: { ...ORIGIN, "idempotency-key": `e2e-foreign-${Math.random().toString(36).slice(2)}-pad` } });
    // 503 is the caller's own workspace having no AI provider, which is checked before the revision is looked up.
    expect([404, 409, 422, 503], `${path} → ${res.status()}`).toContain(res.status());
    expect(res.status() === 503 ? path : "/api/analysis-jobs").toBe("/api/analysis-jobs");
    expect(await res.text(), path).not.toMatch(/Harbor|Daily Basket|Corner Goods|Tidewater/);
  }
  // A forged workspace cookie does not move the session into the demo workspace.
  await context.addCookies([{ name: "ci_workspace", value: workspaceId, url: e2eEnv().APP_BASE_URL }]);
  const merchants = await (await page.request.get("/api/merchants")).json();
  expect(merchants.data).toEqual([]);
  await context.close();
});

test("rollback in the browser: compatible releases switch, an incompatible one is blocked, history is kept", async ({ page }) => {
  await signIn(page, USERS.admin);
  const harbor = await one<{ id: string }>("select id from merchants where workspace_id = $1 and name = 'Harbor Market'");
  const pointer = () => one<{ n: number; mapped: number }>("select r.release_number as n, (select count(*)::int from published_mappings pm where pm.release_id = r.id) as mapped from current_releases c join mapping_releases r on r.id = c.release_id where c.merchant_id = $1", [harbor.id]);
  const releases = async () => (await one<{ n: number }>("select count(*)::int as n from mapping_releases where workspace_id = $1")).n;
  const activations = async () => (await one<{ n: number }>("select count(*)::int as n from audit_events where workspace_id = $1 and action = 'release.activate'")).n;
  const [start, total, activationsBefore] = [await pointer(), await releases(), await activations()];
  expect(start.n).toBe(3);
  const row = (n: number) => page.getByRole("row", { name: new RegExp(`Release ${n}\\b`) });
  const coverageCell = () => page.getByTestId("merchant-comparison").getByRole("row", { name: /^Harbor Market/ });

  await test.step("make release 2 current", async () => {
    await page.goto("/releases");
    await row(2).getByRole("button", { name: "Make current (rollback)" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Make release 2 current?");
    await dialog.getByLabel("Reason").fill("Browser test: roll back to release 2");
    await dialog.getByRole("button", { name: "Make current" }).click();
    await expect(row(2)).toContainText("Current");
    await expect(row(3)).toContainText("Historical");
    const now = await pointer();
    expect(now.n).toBe(2);
    // The dashboard follows the pointer; nothing was republished and no release was removed.
    await page.goto("/overview");
    await expect(coverageCell()).toContainText(`${now.mapped} of 101`);
    await expect(coverageCell()).toContainText("Release 2, revision 2");
    expect(await releases()).toBe(total);
    await expect(page.getByTestId("latest-release")).not.toContainText("Release 2 ·");
  });

  await test.step("a release from a superseded catalog revision is blocked unless that revision is activated too", async () => {
    await page.goto("/releases");
    await row(1).getByRole("button", { name: "Make current (rollback)" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("This release was made from catalog revision 1");
    await dialog.getByLabel("Reason").fill("Browser test: incompatible rollback");
    await dialog.getByRole("button", { name: "Make current" }).click();
    await expect(dialog.getByRole("alert")).not.toBeEmpty();
    expect((await pointer()).n).toBe(2);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("roll forward again; every change is in the audit trail", async () => {
    await row(3).getByRole("button", { name: "Make current (rollback)" }).click();
    await page.getByRole("dialog").getByLabel("Reason").fill("Browser test: restore release 3");
    await page.getByRole("dialog").getByRole("button", { name: "Make current" }).click();
    await expect(row(3)).toContainText("Current");
    expect(await pointer()).toEqual(start);
    // Two successful changes were recorded; the blocked attempt changed nothing and recorded nothing.
    expect(await activations()).toBe(activationsBefore + 2);
    await page.goto("/audit");
    await expect(page.getByText("release.activate").first()).toBeVisible();
  });
});

test("a failed server render shows a recoverable error, hides internals, and recovers on retry", async ({ page }) => {
  await signIn(page, USERS.taxonomist);
  const role = new URL(e2eEnv().DATABASE_URL).username;
  // Arranged fault: the application role temporarily loses read access to one table.
  await db.query(`revoke select on merchants from "${role}"`);
  try {
    await page.goto("/catalogs");
    const panel = page.getByRole("alert").filter({ hasText: "This view failed to load" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Your saved work is not affected.");
    await expect(panel).toContainText(/Reference: \d+/);
    await expect(page.locator("main")).not.toContainText(/permission denied|failed query|select |pg_|stack|merchants/i);
    // The shell survives, so the user can go elsewhere.
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    const api = await page.request.get("/api/merchants");
    expect(api.status()).toBe(500);
    const body = await api.json();
    expect(body.error.code).toBe("internal");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(/permission denied|relation|stack/i);

    await db.query(`grant select on merchants to "${role}"`);
    await panel.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("link", { name: "Harbor Market" })).toBeVisible();
    await expect(panel).toHaveCount(0);
  } finally {
    await db.query(`grant select on merchants to "${role}"`);
  }
});

test("a decision that fails to save is reported, not lost or duplicated, and can be retried", async ({ page }) => {
  await signIn(page, USERS.taxonomist);
  await page.goto("/review?state=suggested");
  await page.getByRole("table").getByRole("link").first().click();
  await page.waitForURL(/\/review\/[0-9a-f-]{36}/);
  await page.waitForLoadState("networkidle");
  const listing = new URL(page.url()).pathname.split("/").pop()!;
  const decisions = async () => (await one<{ n: number }>("select count(*)::int as n from review_decisions where listing_revision_id = $1", [listing])).n;
  const state = async () => (await one<{ state: string }>("select state from review_states where listing_revision_id = $1", [listing])).state;
  expect(await decisions()).toBe(0);
  const title = await page.locator("#listing-title").innerText();

  await test.step("the request never reaches the server", async () => {
    await page.route("**/api/review-items/*/decisions", (route) => route.abort("connectionfailed"), { times: 1 });
    await page.getByRole("button", { name: /^Approve/ }).first().click();
    await expect(page.getByRole("alert").filter({ hasText: /Could not reach the server/ })).toBeVisible();
    expect(await decisions()).toBe(0);
    expect(await state()).toBe("suggested");
    await expect(page.locator("#listing-title")).toHaveText(title);
  });

  await test.step("the server saves it but the response is lost; retrying does not create a second decision", async () => {
    await page.route(
      "**/api/review-items/*/decisions",
      async (route) => {
        await route.fetch();
        await route.abort("connectionfailed");
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: /^Approve/ }).first().click();
    await expect(page.getByRole("alert").filter({ hasText: /Could not reach the server/ })).toBeVisible();
    expect(await decisions()).toBe(1);
    // The same action again carries the same idempotency key, so the stored answer is replayed.
    await page.getByRole("button", { name: /^Approve/ }).first().click();
    await expect(page.locator("footer")).toContainText(/approved/);
    expect(await decisions()).toBe(1);
    expect(await state()).toBe("approved");
  });
});

test("analytics reports a failed request and keeps the question for another try", async ({ page }) => {
  await signIn(page, USERS.analyst);
  await page.goto("/analytics");
  await page.waitForLoadState("networkidle");
  await page.route("**/api/analytics/interpret", (route) => route.abort("connectionfailed"), { times: 1 });
  await page.getByLabel("Question").fill("How many active listings are there?");
  await page.getByRole("button", { name: "Interpret" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not reach the server" })).toBeVisible();
  await expect(page.getByLabel("Question")).toHaveValue("How many active listings are there?");
  await page.getByRole("button", { name: "Interpret" }).click();
  await expect(page.getByTestId("interpretation")).toBeVisible();

  await page.route("**/api/analytics/execute", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "provider_unavailable", message: "The service is temporarily unavailable.", retryable: true, fieldErrors: [] }, requestId: "test" }) }), { times: 1 });
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The service is temporarily unavailable." })).toBeVisible();
  // The interpretation is still there, so nothing has to be retyped.
  await expect(page.getByTestId("interpretation")).toBeVisible();
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByTestId("analysis-result")).toHaveCount(1);
});
