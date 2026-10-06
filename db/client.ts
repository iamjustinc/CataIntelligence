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
    // connectionTimeoutMillis: if every connection is busy, waiting for one fails with a clear
    // error after 15 seconds instead of waiting forever. It bounds the wait for a pool slot only;
    // it is not a statement timeout.
    globalForDb.__ciPool = new pg.Pool({ connectionString: env().DATABASE_URL, max: env().DB_POOL_MAX, connectionTimeoutMillis: 15_000, keepAlive: true });
    // An idle connection can be closed by the server (restart, failover, dropped database).
    // Without a listener that surfaces as an unhandled error; the pool discards the client itself.
    const warn = (event: string) => (err: Error) => console.error(JSON.stringify({ level: "warn", event, message: err.message }));
    globalForDb.__ciPool.on("error", warn("db_idle_connection_error"));
    // A connection that is checked out reports a server-side close on the client itself. The
    // running query is rejected as usual; this listener keeps the extra event from being unhandled.
    globalForDb.__ciPool.on("connect", (client) => client.on("error", warn("db_connection_error")));
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
  // Set once the transaction body begins. From that point the outcome of a failed transaction can
  // be unknown (most importantly when the connection drops during COMMIT), so it is never replayed.
  let bodyStarted = false;
  const run = async () => {
    // The connection is checked out and released here rather than by the ORM, which issues BEGIN
    // outside its own try/finally and would leak the connection if BEGIN fails.
    const client = await pool().connect();
    let broken = false;
    try {
      return await drizzle(client, { schema }).transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.user_id', ${ctx.userId ?? ""}, true), set_config('app.workspace_id', ${ctx.workspaceId ?? ""}, true)`,
        );
        bodyStarted = true;
        return fn(tx);
      });
    } catch (err) {
      broken = isLostConnection(err);
      throw err;
    } finally {
      // A broken connection is destroyed instead of being returned to the pool.
      client.release(broken ? true : undefined);
    }
  };
  return retryOnceOnLostConnection(run, () => !bodyStarted);
}

const LOST_CONNECTION = new Set(["ECONNRESET", "EPIPE", "57P01", "57P02", "57P03", "08006", "08003"]);
export function isLostConnection(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown; message?: string } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++) {
    if (e.code && LOST_CONNECTION.has(e.code)) return true;
    // "not queryable" is what the driver reports for any later statement, such as the ROLLBACK
    // the ORM attempts, on a connection that has already failed.
    if (e.message && /Connection terminated|terminating connection|not queryable/i.test(e.message)) return true;
  }
  return false;
}

/**
 * Runs `run` again once when a pooled connection turns out to have been closed by the server,
 * but only while `safeToRetry()` holds. For transactions that means the failure happened while
 * acquiring the connection, at BEGIN, or setting the row-security context: nothing of the
 * caller's work was sent, so nothing can be applied twice. A failure after the body started,
 * including an unknown COMMIT outcome, is surfaced to the caller instead of replayed.
 */
export async function retryOnceOnLostConnection<T>(run: () => Promise<T>, safeToRetry: () => boolean): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isLostConnection(err) || !safeToRetry()) throw err;
    return run();
  }
}

export async function closeDb(): Promise<void> {
  await globalForDb.__ciPool?.end();
  globalForDb.__ciPool = undefined;
  globalForDb.__ciDb = undefined;
}
