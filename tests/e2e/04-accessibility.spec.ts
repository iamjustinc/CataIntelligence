import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn, USERS } from "./helpers";

/**
 * Automated accessibility, keyboard and small-screen checks (PRD 10.4, AT27). Automated rules find
 * only part of what WCAG 2.2 AA asks for; this is a regression net, not a conformance claim.
 */
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Opens a route and waits for its content: pages stream in behind a loading skeleton. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("h1")).toBeVisible();
}

async function scan(page: Page, label: string) {
  // Entrance animations fade content in; wait for them so contrast is measured on the final colours.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 12).map((n) => n.target.join(" ")).join("\n    ")}`);
  expect.soft(summary, `${label}: ${page.url()}`).toEqual([]);
}

/** Routes with data-dependent IDs, resolved from links on the page. */
async function firstHref(page: Page, from: string, pattern: RegExp): Promise<string> {
  await open(page, from);
  const hrefs = await page.locator("main a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  const found = hrefs.find((h) => pattern.test(h));
  if (!found) throw new Error(`No link matching ${pattern} on ${from}`);
  return found;
}

const STATIC = ["/overview", "/catalogs", "/review", "/review?state=approved&published=unmapped", "/taxonomy", "/taxonomy/proposals", "/analytics", "/releases", "/audit", "/settings"];

test.describe.configure({ mode: "serial" });

test("signed-out pages have no automated accessibility violations", async ({ page }) => {
  await open(page, "/login");
  await scan(page, "login");
  await open(page, "/this-route-does-not-exist");
  await scan(page, "not found");
});

test("every screen an administrator sees has no automated accessibility violations", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, USERS.admin);
  const dynamic = [
    await firstHref(page, "/catalogs", /^\/catalogs\/[0-9a-f-]{36}$/),
    await firstHref(page, "/review", /^\/review\/[0-9a-f-]{36}/),
    await firstHref(page, "/review?state=approved", /^\/review\/[0-9a-f-]{36}/),
    "/taxonomy/import",
    "/taxonomy/proposals/new",
  ];
  dynamic.push(`${dynamic[0]}/import`);
  for (const path of [...STATIC, ...dynamic]) {
    await open(page, path);
    await scan(page, "administrator");
  }

  await test.step("analytics with an interpretation, a result and a saved report", async () => {
    await page.goto("/analytics");
    await page.getByLabel("Question").fill("Which merchant has the lowest published coverage?");
    await page.getByRole("button", { name: "Interpret" }).click();
    await expect(page.getByTestId("interpretation")).toBeVisible();
    await scan(page, "analytics interpretation");
    await page.getByRole("button", { name: "Run analysis" }).click();
    await expect(page.getByTestId("analysis-result")).toBeVisible();
    await page.getByText("Metric definition").click();
    await page.getByText("Data scope").click();
    await scan(page, "analytics result");
    await page.getByLabel("Question").fill("Has coverage improved?");
    await page.getByRole("button", { name: "Interpret" }).click();
    await expect(page.getByTestId("clarification")).toBeVisible();
    await scan(page, "analytics clarification");
    await page.getByLabel("Question").fill("How many releases were published by week?");
    await page.getByRole("button", { name: "Interpret" }).click();
    await page.getByRole("button", { name: "Run analysis" }).click();
    await expect(page.getByTestId("analysis-result")).toHaveCount(2);
    await scan(page, "analytics line chart");
    const report = await firstHref(page, "/analytics", /^\/analytics\/reports\//).catch(() => null);
    if (report) {
      await page.goto(report);
      await scan(page, "saved report");
    }
  });

  await test.step("dialogs", async () => {
    await page.goto(dynamic[0]);
    const run = page.getByRole("button", { name: /Run demo analysis/ });
    if (await run.count()) {
      await run.first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await scan(page, "analysis dialog");
    }
  });
});

test("permission-denied and empty states have no automated accessibility violations", async ({ page, browser }) => {
  await signIn(page, USERS.viewer);
  for (const path of ["/overview", "/review", "/taxonomy/import", "/taxonomy/proposals/new", "/audit", "/releases", "/settings", "/analytics", "/analytics/reports/00000000-0000-4000-8000-000000000000", "/analytics?c=00000000-0000-4000-8000-000000000000"]) {
    await open(page, path);
    await scan(page, "viewer");
  }
  const context = await browser.newContext();
  const outsider = await context.newPage();
  await signIn(outsider, USERS.outsider);
  for (const path of STATIC) {
    await open(outsider, path);
    await scan(outsider, "empty workspace");
  }
  await context.close();
});

test("keyboard only: sign in, reach every control, ask a question and review a listing (AT27)", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").focus();
  await page.keyboard.type(USERS.taxonomist);
  await page.keyboard.press("Tab");
  await page.keyboard.type(process.env.SEED_USER_PASSWORD ?? (await import("./helpers")).PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/overview$/);
  await expect(page.locator("h1")).toBeVisible();
  await page.waitForLoadState("networkidle");

  await test.step("the skip link is the first stop and moves focus to the content", async () => {
    // A freshly loaded document: after an in-app navigation, focus stays where the user left it.
    await open(page, "/overview");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  await test.step("Tab reaches every visible control with a visible focus indicator", async () => {
    for (const path of ["/overview", "/review", "/analytics", "/catalogs", "/taxonomy"]) {
      await open(page, path);
      await page.waitForLoadState("networkidle");
      const expected = await page.locator("a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex='0']").evaluateAll((els) =>
        // Items inside a composite widget (the taxonomy tree) take tabindex -1 and are reached with arrow keys.
        els.filter((el) => (el as HTMLElement).offsetParent !== null && el.getAttribute("tabindex") !== "-1" && !el.closest("[inert]") && !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked && document.querySelector(`input[type=radio][name="${el.name}"]:checked`))).length,
      );
      const seen = new Set<string>();
      let unfocusedOutline = "";
      await page.locator("body").focus().catch(() => undefined);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      for (let i = 0; i < expected + 15; i++) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const all = [...document.querySelectorAll("*")];
          const style = getComputedStyle(el);
          return { id: String(all.indexOf(el)), outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0, what: `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}"` };
        });
        if (!info) continue;
        if (seen.has(info.id)) break;
        seen.add(info.id);
        if (!info.outline && !unfocusedOutline) unfocusedOutline = info.what;
      }
      expect.soft(seen.size, `${path}: controls reached by Tab`).toBeGreaterThanOrEqual(expected);
      expect.soft(unfocusedOutline, `${path}: control without a visible focus outline`).toBe("");
    }
  });

  await test.step("analytics: question, interpretation and run without a pointer", async () => {
    await open(page, "/analytics");
    // Wait for the page's scripts: keys typed before then would not reach the form's state.
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Question").focus();
    await page.keyboard.type("How many listings are pending review by merchant?");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("interpretation")).toBeVisible();
    // Focus moves to the interpretation so a keyboard or screen-reader user lands on it.
    await expect(page.getByTestId("interpretation").locator("[tabindex='-1']")).toBeFocused();
    for (let i = 0; i < 30 && !(await page.getByRole("button", { name: "Run analysis" }).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    const result = page.getByTestId("analysis-result");
    await expect(result).toBeVisible();
    // The chart has a text equivalent: the same cells are in a list and in a captioned table.
    await expect(result.getByRole("list", { name: /Pending review count by merchant/ })).toBeVisible();
    await expect(result.getByRole("table", { name: /Pending review count by Merchant/ })).toBeVisible();
  });

  await test.step("review: open the queue, move between listings and defer with keys", async () => {
    await open(page, "/review?state=suggested");
    await page.waitForLoadState("networkidle");
    await page.getByRole("table").getByRole("link").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/review\/[0-9a-f-]{36}/);
    const first = await page.locator("#listing-title").innerText();
    await page.keyboard.press("j");
    await expect(page.locator("#listing-title")).not.toHaveText(first);
    await page.keyboard.press("k");
    await expect(page.locator("#listing-title")).toHaveText(first);
    // "c" moves focus to the concept search; shortcuts are ignored while typing there.
    await page.keyboard.press("c");
    await expect(page.getByRole("combobox").or(page.getByRole("searchbox")).or(page.getByRole("textbox", { name: /concept/i })).first()).toBeFocused();
    await page.keyboard.type("ajk");
    await expect(page.locator("#listing-title")).toHaveText(first);
  });
});

test("small screens: reading, analytics and individual review fit a phone without sideways scrolling", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await signIn(page, USERS.taxonomist);
  const item = await firstHref(page, "/review?state=suggested", /^\/review\/[0-9a-f-]{36}/);
  for (const path of ["/overview", "/catalogs", "/review", item, "/taxonomy", "/analytics", "/releases", "/audit"]) {
    await open(page, path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect.soft(overflow, `${path}: page is wider than the screen by this many pixels`).toBeLessThanOrEqual(1);
    await expect.soft(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Analytics" }), `${path}: navigation`).toBeAttached();
    await expect.soft(page.locator("h1")).toBeVisible();
  }
  await test.step("a question can be asked and answered on a phone", async () => {
    await page.goto("/analytics");
    await page.getByLabel("Question").fill("What is the published coverage?");
    await page.getByRole("button", { name: "Interpret" }).click();
    await page.getByRole("button", { name: "Run analysis" }).click();
    await expect(page.getByTestId("result-summary")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
  await test.step("a listing can be decided on a phone", async () => {
    await page.goto(item);
    await expect(page.getByRole("button", { name: /^Defer/ }).first()).toBeVisible();
  });
  await context.close();
});
