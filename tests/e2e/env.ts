import "dotenv/config";

export const E2E_PORT = 3100;
export const E2E_WORKER_HEALTH_PORT = 3101;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

function e2eUrl(raw: string | undefined): string {
  if (!raw) throw new Error("DATABASE_URL and DATABASE_ADMIN_URL are required. Run `pnpm setup:env && pnpm db:up`.");
  const url = new URL(raw);
  url.pathname = `${url.pathname.replace(/_(test|e2e)$/, "")}_e2e`;
  return url.toString();
}

/** Environment for the browser-test server and its database: a dedicated `<database>_e2e`. */
export function e2eEnv(): Record<string, string> {
  return {
    DATABASE_URL: e2eUrl(process.env.DATABASE_URL),
    DATABASE_ADMIN_URL: e2eUrl(process.env.DATABASE_ADMIN_URL),
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
    APP_BASE_URL: E2E_BASE_URL,
    SEED_USER_PASSWORD: process.env.SEED_USER_PASSWORD ?? "",
    STORAGE_DIR: ".data/storage-e2e",
    AI_PROVIDER_MODE: "demo",
    ANTHROPIC_API_KEY: "",
    AI_MODEL_ID: "",
    UPLOAD_RATE_LIMIT_PER_MINUTE: "30",
  };
}
