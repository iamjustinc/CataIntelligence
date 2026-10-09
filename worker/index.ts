/**
 * Durable job worker process. Start with `pnpm worker`, separately from the web server.
 *
 * It claims queued analysis jobs through a lease, processes them item by item, renews the lease
 * as a heartbeat and resumes jobs whose worker died once their lease expires. It also removes
 * expired staged files and export objects. It runs as the restricted application role and sets
 * the job's workspace as its row-security context before touching any tenant row.
 */
import "dotenv/config";
import { createServer } from "node:http";
import { sql } from "drizzle-orm";
import { closeDb, db } from "@/db/client";
import { liveProvider } from "@/lib/ai/live";
import { env } from "@/lib/env";
import { claimNextJob, defaultWorkerOptions, processJob } from "@/lib/jobs/analysis-worker";
import { cleanupExpiredObjects } from "@/lib/jobs/cleanup";

const log = (level: "info" | "error", event: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, component: "worker", event, ...extra }));

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1000);
const LEASE_SECONDS = Number(process.env.WORKER_LEASE_SECONDS ?? 60);
const ITEM_DELAY_MS = Number(process.env.WORKER_ITEM_DELAY_MS ?? 0);
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

async function main() {
  const config = env();
  const result = await db().execute<{ role: string; bypass: boolean }>(
    sql`select current_user as role, (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as bypass`,
  );
  const { role, bypass } = result.rows[0];
  if (bypass) throw new Error(`Worker database role "${role}" can bypass row-level security. Use the application role.`);

  let stopping = false;
  const state = { startedAt: new Date().toISOString(), lastPollAt: null as string | null, currentJobId: null as string | null, jobsProcessed: 0 };
  const opts = defaultWorkerOptions({ leaseSeconds: LEASE_SECONDS, concurrency: config.JOB_CONCURRENCY, itemDelayMs: ITEM_DELAY_MS, shouldStop: () => stopping, log: (event, extra) => log("info", event, extra) });
  // A live provider key is reported as present or absent only; its value is never logged.
  log("info", "started", { workerId: opts.workerId, role, concurrency: opts.concurrency, leaseSeconds: LEASE_SECONDS, liveProvider: liveProvider().label, providerKeyConfigured: Boolean(liveProvider().apiKey) });

  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 0);
  const health = healthPort
    ? createServer((_req, res) => {
        res.writeHead(stopping ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ status: stopping ? "stopping" : "ok", workerId: opts.workerId, ...state }));
      }).listen(healthPort, "127.0.0.1")
    : null;

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "stopping", { signal });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  let lastCleanup = 0;
  while (!stopping) {
    try {
      state.lastPollAt = new Date().toISOString();
      const claim = await claimNextJob(opts.workerId, LEASE_SECONDS);
      if (claim) {
        state.currentJobId = claim.id;
        log("info", "job_claimed", { jobId: claim.id });
        const started = Date.now();
        const outcome = await processJob(claim, opts);
        state.currentJobId = null;
        state.jobsProcessed++;
        log("info", "job_finished", { jobId: claim.id, outcome, durationMs: Date.now() - started });
        continue;
      }
      if (Date.now() - lastCleanup >= CLEANUP_INTERVAL_MS) {
        lastCleanup = Date.now();
        const cleaned = await cleanupExpiredObjects();
        if (cleaned.imports + cleaned.exports + cleaned.errors > 0) log("info", "cleanup", cleaned);
      }
    } catch (err) {
      // The loop survives a failed poll (for example a database restart) and tries again.
      state.currentJobId = null;
      log("error", "loop_error", { message: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  health?.close();
  await closeDb();
  log("info", "stopped");
}

main().catch(async (err) => {
  log("error", "fatal", { message: err instanceof Error ? err.message : String(err) });
  await closeDb().catch(() => undefined);
  process.exit(1);
});
