import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { env } from "@/lib/env";

/**
 * Liveness, database reachability and which build is running. Returns no tenant data and no
 * secrets: the commit and the two deployment modes are not sensitive, and they answer "is the
 * version I pushed the one being served, and who runs the jobs?" without opening a dashboard.
 */
export async function GET() {
  const build = {
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? "unknown").slice(0, 7),
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
  };
  try {
    const config = env();
    await db().execute(sql`select 1`);
    return Response.json({ status: "ok", ...build, jobs: config.JOB_RUNNER, storage: config.STORAGE_DRIVER }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable", ...build }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
