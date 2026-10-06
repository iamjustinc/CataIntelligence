import { after } from "next/server";
import { env } from "@/lib/env";
import { drainJobs } from "./analysis-worker";
import { cleanupExpiredObjects } from "./cleanup";

/**
 * Job processing for hosts without a long-running worker (JOB_RUNNER=inline, the default on
 * Vercel). After a response is sent, the same web function claims and processes queued jobs with
 * the ordinary job engine: leases, retries, caps and idempotent commits are unchanged.
 *
 * A function has a time limit. If it is cut off mid-job, the lease expires and the next kick,
 * which every poll of the job's status issues, resumes without repeating finished items. This
 * suits demo mode and small live jobs. A large live job should use the worker process instead.
 */
const LEASE_SECONDS = 30;
let lastCleanup = 0;

export function kickJobs(reason: string): void {
  if (env().JOB_RUNNER !== "inline") return;
  after(async () => {
    try {
      const done = await drainJobs({ leaseSeconds: LEASE_SECONDS, log: (event, extra) => console.log(JSON.stringify({ component: "inline-jobs", reason, event, ...extra })) });
      if (done.length === 0 && Date.now() - lastCleanup > 60 * 60 * 1000) {
        lastCleanup = Date.now();
        await cleanupExpiredObjects();
      }
    } catch (err) {
      console.error(JSON.stringify({ component: "inline-jobs", reason, event: "error", message: err instanceof Error ? err.message : String(err) }));
    }
  });
}
