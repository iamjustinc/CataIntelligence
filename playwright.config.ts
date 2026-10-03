import { defineConfig } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORT, e2eEnv } from "./tests/e2e/env";

/**
 * Browser tests run against a production build on its own port and its own database.
 * `pnpm test:e2e` rebuilds that database from migrations and seed before every run.
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: ".data/playwright",
  use: { baseURL: E2E_BASE_URL, trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `pnpm exec next start -p ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: e2eEnv(),
  },
});
