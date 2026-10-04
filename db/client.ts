import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { __ciPool?: pg.Pool; __ciDb?: Database };

export function pool(): pg.Pool {
  if (!globalForDb.__ciPool) {
    globalForDb.__ciPool = new pg.Pool({ connectionString: env().DATABASE_URL, max: 10 });
    // An idle connection can be closed by the server (restart, failover, dropped database).
    // Without a listener that surfaces as an unhandled error; the pool discards the client itself.
    globalForDb.__ciPool.on("error", (err) => console.error(JSON.stringify({ level: "warn", event: "db_idle_connection_error", message: err.message })));
  }
  return globalForDb.__ciPool;
}

/**
 * Raw handle on the application role. Row-level security hides every tenant row unless a
 * context is set, so tenant data access must go through withContext().
 */
export function db(): Database {
  globalForDb.__ciDb ??= drizzle(pool(), { schema });
  return globalForDb.__ciDb;
}

export interface DbContext {
  userId?: string | null;
  workspaceId?: string | null;
}

/**
 * Runs fn in one transaction with the row-level security context bound to the transaction.
 * The values come from the authenticated session and verified membership, never from the client.
 */
export async function withContext<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = () =>
    db().transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.user_id', ${ctx.userId ?? ""}, true), set_config('app.workspace_id', ${ctx.workspaceId ?? ""}, true)`,
      );
      return fn(tx);
    });
  return retryOnceOnLostConnection(run);
}

const LOST_CONNECTION = new Set(["ECONNRESET", "EPIPE", "57P01", "57P02", "57P03", "08006", "08003"]);
function isLostConnection(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown; message?: string } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++) {
    if (e.code && LOST_CONNECTION.has(e.code)) return true;
    if (e.message && /Connection terminated|terminating connection/i.test(e.message)) return true;
  }
  return false;
}

/**
 * A pooled connection may have been closed by the server since it was last used. The failed
 * transaction was rolled back, so running it once more on a fresh connection is safe.
 */
export async function retryOnceOnLostConnection<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isLostConnection(err)) throw err;
    return run();
  }
}

export async function closeDb(): Promise<void> {
  await globalForDb.__ciPool?.end();
  globalForDb.__ciPool = undefined;
  globalForDb.__ciDb = undefined;
}
