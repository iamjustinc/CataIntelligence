import "dotenv/config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors tests/setup/urls.ts (kept inline so this config loads as a native ES module).
function testUrl(raw: string | undefined): string {
  if (!raw) return "";
  const url = new URL(raw);
  if (!url.pathname.endsWith("_test")) url.pathname = `${url.pathname}_test`;
  return url.toString();
}

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/global.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: testUrl(process.env.DATABASE_URL),
      DATABASE_ADMIN_URL: testUrl(process.env.DATABASE_ADMIN_URL),
      APP_BASE_URL: "http://localhost:3000",
      SEED_USER_PASSWORD: "test-only-password-not-a-secret",
      AI_PROVIDER_MODE: "demo",
      STORAGE_DIR: ".data/storage-test",
      ANTHROPIC_API_KEY: "",
      AI_MODEL_ID: "",
    },
  },
});
