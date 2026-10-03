import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be at least 16 characters"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  AI_PROVIDER_MODE: z.enum(["off", "demo", "live"]).default("demo"),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL_ID: z.string().optional(),
  STORAGE_DIR: z.string().default(".data/storage"),
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
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, blank(v)])));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration. ${problems}. See .env.example.`);
  }
  cached = parsed.data;
  return cached;
}
