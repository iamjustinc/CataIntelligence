import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { __ciPool?: pg.Pool; __ciDb?: Database };

export function pool(): pg.Pool {
  globalForDb.__ciPool ??= new pg.Pool({ connectionString: env().DATABASE_URL, max: 10 });
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
  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.user_id', ${ctx.userId ?? ""}, true), set_config('app.workspace_id', ${ctx.workspaceId ?? ""}, true)`,
    );
    return fn(tx);
  });
}

export async function closeDb(): Promise<void> {
  await globalForDb.__ciPool?.end();
  globalForDb.__ciPool = undefined;
  globalForDb.__ciDb = undefined;
}
