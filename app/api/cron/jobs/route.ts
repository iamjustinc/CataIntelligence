import { timingSafeEqual } from "node:crypto";
import { drainJobs } from "@/lib/jobs/analysis-worker";
import { cleanupExpiredObjects } from "@/lib/jobs/cleanup";

export const maxDuration = 60;

/**
 * Safety net for hosts without a worker: a scheduled request that resumes any job nobody is
 * watching and removes expired files. Jobs normally run right after they are queued and whenever
 * their status is polled; this covers a job whose page was closed mid-run.
 *
 * Callable only with the CRON_SECRET that the host sends as a bearer token. With no CRON_SECRET
 * configured the route refuses every request. It returns counts only, never tenant data.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const ok = secret.length >= 16 && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return Response.json({ error: { code: "unauthenticated", message: "Not authorized." } }, { status: 401, headers: { "cache-control": "no-store" } });
  const jobs = await drainJobs({ leaseSeconds: 30 });
  const cleaned = await cleanupExpiredObjects();
  return Response.json({ jobsProcessed: jobs.length, cleaned }, { headers: { "cache-control": "no-store" } });
}
