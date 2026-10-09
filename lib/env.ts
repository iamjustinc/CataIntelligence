import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be at least 16 characters"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  AI_PROVIDER_MODE: z.enum(["off", "demo", "live"]).default("demo"),
  /** Live provider. When unset: whichever provider has a key, otherwise OpenAI. */
  AI_PROVIDER: z.enum(["openai", "anthropic"]).optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL_ID: z.string().optional(),
  STORAGE_DIR: z.string().default(".data/storage"),
  /** "local" writes under STORAGE_DIR; "database" keeps objects in PostgreSQL for hosts without a shared disk. */
  STORAGE_DRIVER: z.enum(["local", "database"]).default("local"),
  /** "worker": a separate `pnpm worker` process runs jobs. "inline": the web process runs them after responding. */
  JOB_RUNNER: z.enum(["worker", "inline"]).default("worker"),
  /** Connections per process. Serverless hosts run many processes, so keep this small there and use a pooled URL. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  JOB_TOKEN_CAP: z.coerce.number().int().positive().default(400000),
  JOB_SPEND_CAP_USD: z.coerce.number().nonnegative().default(5),
  DAILY_WORKSPACE_SPEND_CAP_USD: z.coerce.number().nonnegative().default(20),
});

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

/**
 * Server-side configuration. Database and authentication settings are mandatory and fail loudly;
 * AI settings are optional and degrade to manual workflows (PRD 14.4).
 */
export function env(): Env {
  if (cached) return cached;
  const blank = (v: string | undefined) => (v === "" ? undefined : v);
  const raw = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, blank(v)]));
  // On Vercel there is no shared disk and no long-running worker, and the public origin is known.
  // Explicit settings always win over these defaults.
  if (raw.VERCEL) {
    raw.STORAGE_DRIVER ??= "database";
    raw.JOB_RUNNER ??= "inline";
    raw.DB_POOL_MAX ??= "5";
    if (!raw.APP_BASE_URL && raw.VERCEL_PROJECT_PRODUCTION_URL) raw.APP_BASE_URL = `https://${raw.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration. ${problems}. See .env.example.`);
  }
  cached = parsed.data;
  return cached;
}
