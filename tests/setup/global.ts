import "dotenv/config";
import pg from "pg";
import { migrateDatabase } from "../../db/migrate";
import { testUrl } from "./urls";

/**
 * Recreates the test database from migrations before every run (PRD AT28: fresh install).
 *
 * Only one run may use the test database at a time. Test files share it: this setup drops and
 * recreates it, and the job engine claims queued jobs across the whole database, so a second
 * overlapping run corrupts both (demonstrated on 2026-10-04: failed queries, duplicate keys and
 * one run processing the other's jobs). A session-level advisory lock held for the whole run makes
 * a second run stop immediately with a clear message. The lock disappears with its connection, so
 * a run that is killed cannot leave it behind.
 */
export default async function setup() {
  const adminUrl = testUrl(process.env.DATABASE_ADMIN_URL);
  const appUrl = testUrl(process.env.DATABASE_URL);
  if (!adminUrl || !appUrl) throw new Error("DATABASE_ADMIN_URL and DATABASE_URL are required for tests. Run `pnpm setup:env && pnpm db:up`.");
  const target = new URL(adminUrl);
  const name = target.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`Refusing to reset non-test database "${name}".`);
  const maintenance = new URL(adminUrl);
  maintenance.pathname = "/postgres";

  const lock = new pg.Client({ connectionString: maintenance.toString(), application_name: `ci-test-run pid=${process.pid}` });
  await lock.connect();
  const { rows } = await lock.query("select pg_try_advisory_lock(hashtext($1)) as acquired", [name]);
  if (!rows[0].acquired) {
    const holder = await lock.query(
      "select a.application_name, a.backend_start from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and l.granted and l.objid = hashtext($1)::oid limit 1",
      [name],
    );
    await lock.end();
    const who = holder.rows[0] ? `${holder.rows[0].application_name}, started ${new Date(holder.rows[0].backend_start).toISOString()}` : "unknown process";
    throw new Error(`Another test run is using "${name}" (${who}). Runs share that database and cannot overlap: wait for it to finish or stop that process, then try again.`);
  }

  await lock.query(`drop database if exists "${name}" with (force)`);
  await lock.query(`create database "${name}"`);
  await migrateDatabase(adminUrl, appUrl);
  // Teardown: releasing the lock by closing its connection.
  return async () => {
    await lock.end();
  };
}
