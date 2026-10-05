import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "./env";
import { signIn, signOut, USERS } from "./helpers";
import { unzip } from "./unzip";

const WALKTHROUGH = resolve(process.cwd(), "fixtures/generated/catalogs/walkthrough-pier-pantry.csv");

const title = (page: Page) => page.locator("#listing-title");
const progress = (page: Page) => page.locator("footer");
/** Decision history entries of the open listing. */
const history = (page: Page) => page.locator("section[aria-labelledby='listing-title'] ol li");

test.describe.configure({ mode: "serial" });

test("fresh setup shows the seeded demo workspace, labeled as demo data", async ({ page }) => {
  await signIn(page, USERS.admin);
  await expect(page.getByText("Demo data")).toBeVisible();
  await expect(page.getByText("Demo AI")).toBeVisible();
  // Totals come from the seeded records: 300 active listings, 172 approved, 128 pending.
  const stat = (label: string) => page.locator("dl > div", { has: page.getByText(label, { exact: true }) }).locator("dd").first();
  await expect(stat("Active listing count")).toHaveText("300");
  await expect(stat("Approved draft coverage")).toHaveText("57.3%172 of 300");
  await expect(stat("Published mapping coverage")).toHaveText("46.7%140 of 300");
  await expect(stat("Pending review count")).toHaveText("128");
  await page.goto("/releases");
  await expect(page.getByRole("row", { name: /Release 3/ })).toContainText("Current");
  await expect(page.getByRole("row", { name: /Release 1/ })).toContainText("Historical");
});

test("another workspace sees none of the demo data", async ({ page }) => {
  await signIn(page, USERS.outsider);
  await page.goto("/catalogs");
  await expect(page.getByText("No merchants yet")).toBeVisible();
  await page.goto("/review");
  await expect(page.getByText("Nothing to review yet")).toBeVisible();
  await page.goto("/releases");
  await expect(page.getByText("No releases published yet")).toBeVisible();
});

test("a viewer can read but not change anything", async ({ page }) => {
  await signIn(page, USERS.viewer);
  await page.goto("/review?state=suggested");
  await page.getByRole("table").getByRole("link").first().click();
  await expect(page.getByText("Your role can view this listing. Reviewing requires a taxonomist or administrator.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await page.goto("/taxonomy/import");
  await expect(page.getByRole("heading", { name: "Administrators only" })).toBeVisible();
  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "Taxonomists and administrators only" })).toBeVisible();
  await page.goto("/releases");
  await expect(page.getByRole("heading", { name: "Administrators publish releases" })).toBeVisible();
  // The server refuses too; hiding controls is not the protection.
  const res = await page.request.post("/api/merchants", { data: { name: "Viewer Made" }, headers: { "idempotency-key": "e2e-viewer-merchant-1", origin: e2eEnv().APP_BASE_URL } });
  expect(res.status()).toBe(403);
});

test("import a catalog, review it, publish a partial release and export it", async ({ page }) => {
  let merchantUrl = "";

  await test.step("taxonomist imports a catalog with column mapping, validation and duplicate handling", async () => {
    await signIn(page, USERS.taxonomist);
    await page.goto("/catalogs");
    await page.getByLabel("Name").fill("Pier Pantry");
    await page.getByRole("button", { name: "Add merchant" }).click();
    await page.getByRole("link", { name: "Pier Pantry" }).click();
    await expect(page.getByRole("heading", { name: "No catalog imported yet" })).toBeVisible();
    merchantUrl = page.url();
    await page.getByRole("link", { name: "Import catalog" }).first().click();

    await page.getByLabel("Catalog CSV file").setInputFiles(WALKTHROUGH);
    // Header names differ from the canonical ones and were mapped from aliases.
    await expect(page.getByLabel(/^Merchant SKU/)).toHaveValue("Item Code");
    await expect(page.getByLabel(/^Title/)).toHaveValue("Product Name");
    await expect(page.getByText("14 input = 8 accepted + 5 rejected + 1 collapsed")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Title is required." })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Price "-1.50" is negative/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Currency is required when a price is present." })).toBeVisible();

    await page.getByRole("radio", { name: /Row 5 Moisturizing Shampoo/ }).check();
    await expect(page.getByText("14 input = 9 accepted + 4 rejected + 1 collapsed")).toBeVisible();
    const commit = page.getByRole("button", { name: "Commit 9 rows as a new snapshot revision" });
    await expect(commit).toBeDisabled();
    await page.getByRole("checkbox", { name: /Exclude 4 rejected rows/ }).check();
    await commit.click();

    await expect(page).toHaveURL(merchantUrl);
    await expect(page.getByRole("rowheader", { name: /Revision 1/ })).toContainText("Current");
    await expect(page.getByRole("cell", { name: "PP-012" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "PP-008" })).toHaveCount(0);
  });

  await test.step("the same file is not imported twice by accident", async () => {
    await page.getByRole("link", { name: "Import catalog" }).click();
    await page.getByLabel("Catalog CSV file").setInputFiles(WALKTHROUGH);
    await expect(page.getByRole("heading", { name: "This file was already imported" })).toBeVisible();
    await page.getByRole("link", { name: "View catalog" }).click();
    await expect(page.getByRole("rowheader", { name: /Revision/ })).toHaveCount(1);
  });

  await test.step("demo analysis produces labeled demo suggestions", async () => {
    await page.getByRole("button", { name: "Run demo analysis" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Run demo analysis" }).click();
    const panel = page.locator("section[aria-labelledby='analysis-heading']");
    // The job is queued by the request and processed by the worker process; the panel polls real status.
    await expect(panel.getByText("Completed", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText("9 of 9 listings processed");
    await expect(panel.getByText("Demo fixtures")).toBeVisible();
    await expect(panel.locator("div", { has: page.getByText("Suggested", { exact: true }) }).locator("dd").first()).toHaveText("9");
  });

  await test.step("reviewer approves, corrects, defers and marks no suitable category", async () => {
    await page.getByRole("link", { name: "Review listings" }).click();
    await expect(page.getByText("0 approved, 9 remaining of 9 active listings for this merchant.")).toBeVisible();
    await expect(page.getByRole("table").getByText("Demo", { exact: true }).first()).toBeVisible();
    await page.getByRole("link", { name: "Whole Milk Gallon" }).click();

    await expect(title(page)).toHaveText("Whole Milk Gallon");
    await expect(page.getByText("Demo fixture")).toBeVisible();
    await expect(page.getByText("Grocery > Dairy & Eggs > Dairy Milk").first()).toBeVisible();
    // Keyboard: A approves and the queue advances to the next item.
    await page.keyboard.press("a");
    await expect(title(page)).toHaveText("Bananas");
    await expect(progress(page)).toContainText("1 approved, 8 remaining");

    for (const next of ["Lemon Dish Soap", "Moisturizing Shampoo", "Coconut Milk Shampoo"]) {
      await page.getByRole("button", { name: /^Approve/ }).click();
      await expect(title(page)).toHaveText(next);
    }

    // The suggestion was misled by the merchant category: correct it with a reason.
    await expect(page.getByText("Low signal")).toBeVisible();
    await expect(page.getByText("Canned Cooking Milks").first()).toBeVisible();
    await page.getByLabel(/Map to a different concept/).fill("shampoo");
    await page.locator("#concept-results li", { hasText: "Hair Care > Shampoo & Conditioner" }).getByRole("button", { name: "Map to this" }).click();
    await page.getByRole("button", { name: "Change mapping" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Give a reason for changing the mapping." })).toBeVisible();
    await page.getByLabel(/Reason or note/).fill("Title says shampoo; the merchant category is misleading.");
    await page.getByRole("button", { name: "Change mapping" }).click();

    await expect(title(page)).toHaveText("Apple");
    await expect(page.getByRole("heading", { name: "Needs investigation" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Approve/ })).toBeDisabled();
    await page.getByLabel(/Reason or note/).fill("Fruit or accessory? Ask the merchant.");
    await page.getByRole("button", { name: "Defer" }).click();

    await expect(title(page)).toHaveText("Ginger Kombucha");
    await expect(page.getByText("Possible missing concept")).toBeVisible();
    await page.getByRole("button", { name: "No suitable category" }).click();

    await expect(title(page)).toHaveText("=SUM(A1:A9) Paper Towels");
    await page.getByRole("button", { name: /^Approve/ }).click();
    await expect(title(page)).toHaveText("Dry Dog Food Chicken");
    await page.getByRole("button", { name: /^Approve/ }).click();
    await expect(progress(page)).toContainText("7 approved, 2 remaining");
  });

  await test.step("decisions persist across a reload", async () => {
    await page.reload();
    await expect(progress(page)).toContainText("7 approved, 2 remaining");
    await expect(page.locator("section[aria-labelledby='listing-title']").getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(history(page).filter({ hasText: "Approved" }).first()).toContainText("Rin Castellanos");
  });

  await test.step("reviewer proposes the missing leaf", async () => {
    await page.getByRole("complementary", { name: "Queue" }).getByRole("link", { name: /Ginger Kombucha/ }).click();
    await expect(title(page)).toHaveText("Ginger Kombucha");
    await page.getByRole("link", { name: "Propose this leaf for administrator review" }).click();
    await expect(page.getByLabel("Name")).toHaveValue("Kombucha & Fermented Drinks");
    await page.getByLabel("Name").fill("Kombucha");
    await expect(page.getByLabel("Parent concept").locator("option:checked")).toHaveText("Beverages");
    await page.getByLabel("Definition").fill("Kombucha and other fermented tea drinks.");
    await page.getByLabel("Rationale").fill("Pier Pantry sells kombucha and no leaf fits.");
    await page.getByRole("button", { name: "Submit for administrator review" }).click();
    await expect(page).toHaveURL(/\/taxonomy\/proposals$/);
    await expect(page.getByRole("heading", { name: /“Kombucha” under Beverages/ })).toBeVisible();
    // A taxonomist can propose but not decide.
    await expect(page.getByRole("button", { name: "Approve into draft" })).toHaveCount(0);
    await signOut(page);
  });

  await test.step("administrator approves the proposal, publishes the taxonomy and revalidates dependencies", async () => {
    await signIn(page, USERS.admin);
    await page.goto("/taxonomy/proposals");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: /“Kombucha” under Beverages/ }) });
    await card.getByRole("button", { name: "Approve into draft" }).click();
    await expect(card.getByText("In draft v2")).toBeVisible();

    await page.goto("/taxonomy");
    await expect(page.getByText("Published · active")).toBeVisible();
    await page.getByRole("link", { name: "v2 draft" }).click();
    await page.getByRole("button", { name: "Publish version 2" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("link", { name: "v2 active" })).toBeVisible();

    // Every earlier approval and suggestion is now stale and blocks publication until revalidated.
    await expect(page.getByRole("heading", { name: /listings have a stale mapping or suggestion/ })).toBeVisible();
    await page.goto("/releases");
    const blocked = page.getByRole("region", { name: "Publish Pier Pantry" });
    await blocked.getByRole("button", { name: "Preview release" }).click();
    await expect(blocked.getByText("This release cannot be published yet")).toBeVisible();
    await expect(blocked.getByText(/Revalidate dependencies first/)).toBeVisible();

    await page.goto("/taxonomy");
    await page.getByRole("button", { name: "Revalidate dependencies" }).click();
    await expect(page.getByRole("heading", { name: /stale mapping or suggestion/ })).toHaveCount(0);
  });

  await test.step("the reopened listing is mapped to the new leaf", async () => {
    await page.goto(`${merchantUrl.replace("/catalogs/", "/review?merchant=")}&state=needs_review`);
    await page.getByRole("link", { name: "Ginger Kombucha" }).click();
    await expect(page.getByText("Stale suggestion")).toBeVisible();
    await page.getByLabel(/Map to a different concept/).fill("kombucha");
    await page.locator("#concept-results li", { hasText: "Beverages > Kombucha" }).getByRole("button", { name: "Map to this" }).click();
    await page.getByRole("button", { name: /^Approve mapping/ }).click();
    await expect(progress(page)).toContainText("8 approved, 1 remaining");
  });

  let releaseName = "";
  await test.step("administrator previews and publishes an acknowledged partial release", async () => {
    await page.goto("/releases");
    const panel = page.getByRole("region", { name: "Publish Pier Pantry" });
    await panel.getByRole("button", { name: "Preview release" }).click();
    const stat = (label: string) => panel.locator("dl > div", { has: page.getByText(label, { exact: true }) }).locator("dd");
    await expect(stat("Mapped")).toHaveText("8");
    await expect(stat("Unresolved")).toHaveText("1");
    await expect(stat("Active listings")).toHaveText("9");
    await expect(panel.getByRole("link", { name: "Deferred" })).toBeVisible();

    const publish = panel.getByRole("button", { name: "Publish partial release" });
    await expect(publish).toBeDisabled();
    await panel.getByLabel(/Release reason/).fill("First Pier Pantry release.");
    await expect(publish).toBeDisabled();
    await panel.getByRole("checkbox", { name: /I understand this is a partial release/ }).check();
    await publish.click();
    await page.getByRole("dialog").getByRole("button", { name: "Publish release" }).click();
    await expect(panel.getByText(/Published release \d+ for Pier Pantry\./)).toBeVisible();
    releaseName = (await panel.getByText(/Published release \d+ for Pier Pantry\./).innerText()).match(/release \d+/)![0].replace("r", "R");
    const row = page.getByRole("row", { name: new RegExp(`${releaseName}\\b`) });
    await expect(row).toContainText("Current");
    await expect(row).toContainText("Partial");
    await expect(row).toContainText("Taxonomy v2");
  });

  await test.step("the export downloads and its counts reconcile with the release", async () => {
    const number = releaseName.split(" ")[1];
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: `Export release ${number}: ZIP (all files)` }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`release-${number}.zip`);
    const files = unzip(readFileSync(await file.path()));
    expect(Object.keys(files)).toEqual(["mappings.csv", "unresolved.csv", "release.json"]);

    const mappings = files["mappings.csv"].trim().split("\r\n");
    expect(mappings).toHaveLength(9); // header + 8 mapped listings
    const line = (sku: string) => mappings.find((l) => l.includes(`,${sku},`))!;
    expect(line("PP-001")).toContain("GRO-DAI-MILK");
    expect(line("PP-005")).toContain("PC-HAIR-SHAMPOO");
    // Earlier approvals were explicitly revalidated against taxonomy version 2; the reviewer stays accountable.
    expect(line("PP-005")).toContain(",revalidated,Rin Castellanos,");
    expect(line("PP-007")).toContain("All Products > Beverages > Kombucha");
    expect(line("PP-007")).toContain("Avery Okafor");
    expect(line("PP-001")).toContain(",revalidated,Rin Castellanos,");
    // Spreadsheet-safe: the formula-leading title is neutralized in the file.
    expect(line("PP-011")).toContain(",'=SUM(A1:A9) Paper Towels,");

    const unresolved = files["unresolved.csv"].trim().split("\r\n");
    expect(unresolved).toHaveLength(2);
    expect(unresolved[1]).toContain("PP-006,Apple,Deferred,Deferred: Fruit or accessory? Ask the merchant.");

    const meta = JSON.parse(files["release.json"]);
    expect(meta.counts).toMatchObject({ activeListings: 9, mapped: 8, unresolved: 1 });
    expect(meta.release).toMatchObject({ partial: true, reason: "First Pier Pantry release.", publishedBy: "Avery Okafor" });
    expect(meta.taxonomyVersion.sequence).toBe(2);
    expect(meta.catalogRevision.sequence).toBe(1);
    expect(meta.files).toEqual({ "mappings.csv": { rows: 8 }, "unresolved.csv": { rows: 1 } });
  });

  await test.step("the release and its audit trail survive a reload", async () => {
    await page.reload();
    await expect(page.getByRole("row", { name: new RegExp(`${releaseName}\\b`) })).toContainText("Current");
    await page.goto("/audit?action=release");
    await expect(page.getByRole("cell", { name: "release.publish" }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "release.export" }).first()).toBeVisible();
    await expect(page.getByText("“First Pier Pantry release.”")).toBeVisible();
    await page.goto(merchantUrl);
    await expect(page.getByRole("cell", { name: "PP-006" })).toBeVisible();
    await expect(page.getByRole("row", { name: /PP-006/ })).toContainText("Deferred");
  });
});

test("a concurrent decision is not overwritten: the second reviewer sees a conflict", async ({ page }) => {
  await signIn(page, USERS.taxonomist);
  const queue = await (await page.request.get("/api/review-items?state=unresolved&limit=1")).json();
  const item = queue.data.items[0];
  await page.goto(`/review/${item.id}`);
  await expect(title(page)).toHaveText(item.title);

  // Someone else decides on the same version while this page is open.
  const other = await page.request.post(`/api/review-items/${item.id}/decisions`, {
    data: { action: "no_suitable", reason: "Decided elsewhere.", expectedVersion: item.lockVersion },
    headers: { "idempotency-key": `e2e-conflict-${item.id}`, origin: e2eEnv().APP_BASE_URL },
  });
  expect(other.status()).toBe(201);

  await page.getByRole("button", { name: "Defer" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Someone else updated this listing" })).toBeVisible();
  await page.getByRole("button", { name: "Reload this listing" }).click();
  await expect(page.locator("section[aria-labelledby='listing-title']").getByText("No suitable category", { exact: true }).first()).toBeVisible();
  // Exactly one decision exists: the first reviewer's. The second was not saved.
  await expect(history(page)).toHaveCount(1);
  await expect(history(page).first()).toContainText("Decided elsewhere.");
});
