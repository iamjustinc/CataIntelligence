/**
 * Backup and restore verification (PRD section 16: required before a real-user pilot).
 *
 *   pnpm backup:check                      source: the database in DATABASE_ADMIN_URL
 *   pnpm backup:check --source <name>      another database on the same server
 *
 * Dumps the source with pg_dump (read-only), restores the dump into a scratch database named
 * "<source>_restorecheck", re-applies grants with the migration command, compares the two and
 * drops the scratch database. The source is never written to.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { APPEND_ONLY_TABLES, migrateDatabase } from "../db/migrate";

function binDir(): string {
  const candidates = [process.env.PG_BIN_DIR, "/Applications/Postgres.app/Contents/Versions/latest/bin", "/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin", "/usr/bin"];
  const found = candidates.find((d) => d && existsSync(join(d, "pg_dump")) && existsSync(join(d, "pg_restore")));
  if (!found) throw new Error("pg_dump and pg_restore were not found. Set PG_BIN_DIR.");
  return found;
}
const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
async function query<T>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end();
  }
}
async function fingerprint(url: string) {
  const tables = (await query<{ t: string }>(url, "select tablename as t from pg_tables where schemaname = 'public' order by 1")).map((r) => r.t);
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = (await query<{ n: number }>(url, `select count(*)::int as n from "${t}"`))[0].n;
  const rls = (await query<{ t: string }>(url, "select relname as t from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity order by 1")).map((r) => r.t);
  const policies = (await query<{ n: number }>(url, "select count(*)::int as n from pg_policies where schemaname = 'public'"))[0].n;
  const triggers = (await query<{ g: string }>(url, "select tgname as g from pg_trigger where not tgisinternal order by 1")).map((r) => r.g);
  const constraints = (await query<{ n: number }>(url, "select count(*)::int as n from pg_constraint where connamespace = 'public'::regnamespace"))[0].n;
  return { counts, rls, policies, triggers, constraints };
}

async function main() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!adminUrl || !appUrl) throw new Error("DATABASE_ADMIN_URL and DATABASE_URL are required.");
  const arg = process.argv.indexOf("--source");
  const source = arg >= 0 ? process.argv[arg + 1] : new URL(adminUrl).pathname.slice(1);
  const scratch = `${source}_restorecheck`;
  const bin = binDir();
  const dir = mkdtempSync(join(tmpdir(), "ci-backup-"));
  const dump = join(dir, "backup.dump");
  const maintenance = withDb(adminUrl, "postgres");
  const failures: string[] = [];
  try {
    const before = await fingerprint(withDb(adminUrl, source));
    execFileSync(join(bin, "pg_dump"), ["--format=custom", "--no-owner", `--file=${dump}`, withDb(adminUrl, source)], { stdio: ["ignore", "inherit", "inherit"] });
    console.log(`Backup of "${source}": ${statSync(dump).size} bytes, ${Object.keys(before.counts).length} tables, ${Object.values(before.counts).reduce((a, b) => a + b, 0)} rows.`);

    await query(maintenance, `drop database if exists "${scratch}" with (force)`);
    await query(maintenance, `create database "${scratch}"`);
    execFileSync(join(bin, "pg_restore"), ["--no-owner", "--exit-on-error", `--dbname=${withDb(adminUrl, scratch)}`, dump], { stdio: ["ignore", "inherit", "inherit"] });
    // A dump made with --no-owner carries no grants for the application role; the migration command restores them.
    await migrateDatabase(withDb(adminUrl, scratch), withDb(appUrl, scratch));
    const after = await fingerprint(withDb(adminUrl, scratch));

    for (const [t, n] of Object.entries(before.counts)) if (after.counts[t] !== n) failures.push(`table ${t}: ${n} rows in the source, ${after.counts[t] ?? "missing"} after restore`);
    if (JSON.stringify(before.rls) !== JSON.stringify(after.rls)) failures.push("the set of tables with row-level security differs");
    if (before.policies !== after.policies) failures.push(`policies: ${before.policies} in the source, ${after.policies} after restore`);
    if (!after.rls.includes("merchants") || !after.rls.includes("review_decisions")) failures.push("tenant tables are missing row-level security");
    if (JSON.stringify(before.triggers) !== JSON.stringify(after.triggers)) failures.push("triggers differ");
    if (before.constraints !== after.constraints) failures.push(`constraints: ${before.constraints} in the source, ${after.constraints} after restore`);

    // The restored database must still refuse to rewrite history, and must still isolate tenants. The
    // application role is not the table owner, so the policies apply to it without FORCE.
    for (const table of APPEND_ONLY_TABLES) {
      const refused = await query(withDb(adminUrl, scratch), `update "${table}" set workspace_id = workspace_id`).then(() => after.counts[table] === 0, () => true);
      if (!refused) failures.push(`${table} accepted an update after restore`);
    }
    const visible = (await query<{ n: number }>(withDb(appUrl, scratch), "select count(*)::int as n from merchants"))[0].n;
    if (visible !== 0) failures.push(`the application role saw ${visible} merchants without a workspace context`);
    console.log(`Restore into "${scratch}": ${Object.keys(after.counts).length} tables, ${after.rls.length} tables with row-level security, ${after.policies} policies, ${after.triggers.length} triggers, ${after.constraints} constraints.`);
  } finally {
    await query(maintenance, `drop database if exists "${scratch}" with (force)`).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`Restore verification FAILED:\n${failures.map((f) => `- ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("Restore verification passed: row counts, row-level security, policies, triggers and constraints match; append-only tables refuse updates; the application role sees nothing without a workspace.");
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
