import { sql } from "drizzle-orm";
import { db } from "@/db/client";

/** Liveness and database reachability. Returns no tenant data. */
export async function GET() {
  try {
    await db().execute(sql`select 1`);
    return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
