import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, isLostConnection, retryOnceOnLostConnection, withContext } from "@/db/client";
import { merchants } from "@/db/schema";
import { sql } from "drizzle-orm";
import { adminClient, createTestWorkspace, type TestWorkspace } from "../setup/helpers";

let admin: pg.Client;
let ws: TestWorkspace;
const merchantCount = async (name: string) => (await admin.query("select count(*)::int as n from merchants where workspace_id = $1 and name = $2", [ws.id, name])).rows[0].n as number;
/**
 * Closes this test database's pooled application connections from the server side, as a database
 * restart would. Scoped to the current (test) database so no other database's sessions are touched.
 */
const killAppConnections = () =>
  admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and usename = $1 and pid <> pg_backend_pid()", [new URL(process.env.DATABASE_URL!).username]);

beforeAll(async () => {
  admin = await adminClient();
  ws = await createTestWorkspace(admin, "retry");
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

describe("retry on a lost database connection", () => {
  it("retries when the connection was already dead before the transaction body started", async () => {
    await withContext({ workspaceId: ws.id }, (tx) => tx.execute(sql`select 1`)); // ensure a pooled connection exists
    await killAppConnections();
    let calls = 0;
    await withContext({ workspaceId: ws.id }, async (tx) => {
      calls++;
      await tx.insert(merchants).values({ workspaceId: ws.id, name: "After Restart" });
    });
    expect(calls).toBe(1);
    expect(await merchantCount("After Restart")).toBe(1);
  });

  it("does not replay a transaction whose body had started when the connection was lost", async () => {
    let calls = 0;
    const attempt = withContext({ workspaceId: ws.id }, async (tx) => {
      calls++;
      await tx.insert(merchants).values({ workspaceId: ws.id, name: "Mid Transaction" });
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0].pid;
      // The server drops this very connection after the write and before COMMIT.
      await admin.query("select pg_terminate_backend($1)", [pid]);
      await tx.execute(sql`select 1`);
    });
    await expect(attempt).rejects.toSatisfy(isLostConnection);
    expect(calls).toBe(1);
    // The same holds when the failure is only discovered by a later statement on the dead connection.
    expect(isLostConnection(new Error("Client has encountered a connection error and is not queryable"))).toBe(true);
    // The interrupted transaction was rolled back by the server and was not run a second time.
    expect(await merchantCount("Mid Transaction")).toBe(0);
  });

  it("returns every connection to the pool, or destroys it, after a lost connection", async () => {
    const { pool } = await import("@/db/client");
    expect(pool().totalCount - pool().idleCount).toBe(0);
    expect(pool().waitingCount).toBe(0);
  });

  it("never retries once the caller says the outcome may be unknown, such as a failed COMMIT", async () => {
    const lost = Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
    let committedSideEffects = 0;
    let bodyStarted = false;
    const run = async () => {
      bodyStarted = true;
      committedSideEffects++; // stands for work the server may already have committed
      throw lost; // the acknowledgement of COMMIT never arrived
    };
    await expect(retryOnceOnLostConnection(run, () => !bodyStarted)).rejects.toBe(lost);
    expect(committedSideEffects).toBe(1);

    // Before the body starts, exactly one retry is made; other errors are never retried.
    let attempts = 0;
    expect(await retryOnceOnLostConnection(async () => (++attempts === 1 ? Promise.reject(lost) : "ok"), () => true)).toBe("ok");
    expect(attempts).toBe(2);
    attempts = 0;
    await expect(retryOnceOnLostConnection(async () => (attempts++, Promise.reject(new Error("unique violation"))), () => true)).rejects.toThrow("unique violation");
    expect(attempts).toBe(1);
  });
});
