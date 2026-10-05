import { expect, type Page } from "@playwright/test";
import { e2eEnv } from "./env";

export const PASSWORD = e2eEnv().SEED_USER_PASSWORD;
export const ORIGIN = e2eEnv().APP_BASE_URL;
export const USERS = {
  admin: "avery.admin@catalog-intelligence.test",
  taxonomist: "rin.taxonomist@catalog-intelligence.test",
  analyst: "jo.analyst@catalog-intelligence.test",
  viewer: "sam.viewer@catalog-intelligence.test",
  outsider: "dana.admin@fennel-sandbox.test",
};

/**
 * Signs in through the real form. The production build rate-limits sign-in attempts; when the
 * limiter answers, the helper waits for the window to pass and tries again rather than bypassing it.
 */
export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    const limited = page.getByText("Too many attempts. Wait a minute and try again.");
    const outcome = await Promise.race([page.waitForURL(/\/overview$/).then(() => "ok" as const), limited.waitFor().then(() => "limited" as const)]);
    if (outcome === "ok") {
      // Let the overview finish rendering. Leaving while its server render is still streaming is
      // harmless but makes the server log "The destination stream closed early" for the abandoned
      // navigation (reproduced on unrelated pages in .data/diag/abort-probe2.ts).
      await expect(page.locator("h1")).toBeVisible();
      await page.waitForLoadState("networkidle");
      return;
    }
    await page.waitForTimeout(11_000);
  }
  throw new Error(`Could not sign in as ${email}`);
}
export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** JSON API call from the signed-in page, with the headers the application requires. */
export async function apiPost<T>(page: Page, path: string, data: unknown, method: "post" | "put" = "post"): Promise<{ status: number; data: T }> {
  const res = await page.request[method](path, { data, headers: { origin: ORIGIN, "idempotency-key": `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), data: body.data as T };
}
