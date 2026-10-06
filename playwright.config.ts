import { defineConfig } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORT, E2E_WORKER_HEALTH_PORT, e2eEnv, SERVERLESS } from "./tests/e2e/env";

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
  webServer: [
    {
      command: `pnpm exec next start -p ${E2E_PORT}`,
      url: `${E2E_BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: e2eEnv(),
    },
    // In serverless mode there is no worker: the web process runs jobs after responding.
    ...(SERVERLESS
      ? []
      : [
        {
          // The real worker process. A short per-item delay makes job progress observable in the browser.
          command: "pnpm exec tsx worker/index.ts",
          url: `http://127.0.0.1:${E2E_WORKER_HEALTH_PORT}/health`,
          reuseExistingServer: false,
          timeout: 60_000,
          env: { ...e2eEnv(), WORKER_HEALTH_PORT: String(E2E_WORKER_HEALTH_PORT), WORKER_POLL_MS: "300", WORKER_ITEM_DELAY_MS: "150" },
        },
        ]),
  ],
});
