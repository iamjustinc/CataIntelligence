/**
 * Live analytics planner benchmark. Separately budgeted and never part of `pnpm test`.
 *
 *   pnpm eval:analytics:live      (needs ANTHROPIC_API_KEY and AI_MODEL_ID)
 *
 * Asks the 40 benchmark questions through the real Claude planner (about 30 provider calls: the
 * fixed guards answer the rest) against the isolated test database, and writes
 * evals/reports/analytics-benchmark-live.json. Without credentials it exits with code 2 and makes
 * no call, so a missing report can never be mistaken for a successful live verification.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";

if (!process.env.ANTHROPIC_API_KEY || !process.env.AI_MODEL_ID) {
  console.error("Live analytics benchmark NOT RUN: ANTHROPIC_API_KEY and AI_MODEL_ID are required. No provider call was made.");
  process.exit(2);
}
const run = spawnSync("pnpm", ["exec", "vitest", "run", "tests/integration/analytics-benchmark.test.ts"], { stdio: "inherit", env: { ...process.env, LIVE_ANALYTICS_BENCHMARK: "1" } });
process.exit(run.status ?? 1);
