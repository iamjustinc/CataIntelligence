/**
 * Durable job worker process. Start with `pnpm worker`, separately from the web server.
 *
 * Phase 0 scope: validates configuration, verifies the database connection and that it runs as
 * the restricted application role, then idles with a heartbeat and shuts down cleanly. Job
 * handlers (analysis, export) and lease-based claiming are added in Phase 2; until then the
 * worker never claims work it cannot process.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { closeDb, db } from "@/db/client";
import { env } from "@/lib/env";

const log = (level: "info" | "error", event: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, component: "worker", event, ...extra }));

/** Job types this build can process. Empty until Phase 2 registers handlers. */
const HANDLERS: Record<string, never> = {};

async function main() {
  const config = env();
  const result = await db().execute<{ role: string; bypass: boolean }>(
    sql`select current_user as role, (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as bypass`,
  );
  const { role, bypass } = result.rows[0];
  if (bypass) throw new Error(`Worker database role "${role}" can bypass row-level security. Use the application role.`);
  log("info", "started", { role, concurrency: config.JOB_CONCURRENCY, handlers: Object.keys(HANDLERS) });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "stopping", { signal });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  let lastBeat = 0;
  while (!stopping) {
    if (Date.now() - lastBeat >= 30_000) {
      await db().execute(sql`select 1`);
      log("info", "heartbeat", { handlers: Object.keys(HANDLERS).length });
      lastBeat = Date.now();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await closeDb();
  log("info", "stopped");
}

main().catch(async (err) => {
  log("error", "fatal", { message: err instanceof Error ? err.message : String(err) });
  await closeDb().catch(() => undefined);
  process.exit(1);
});
