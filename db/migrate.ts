/**
 * Applies migrations as the owner role, then (re)creates the non-owner application role and its
 * grants. Usage: tsx db/migrate.ts   (targets DATABASE_ADMIN_URL / DATABASE_URL from the environment)
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Tables the application may insert into and read, but never update or delete. */
export const APPEND_ONLY_TABLES = [
  "audit_events",
  "mapping_releases",
  "published_mappings",
  "release_unresolved",
  "review_decisions",
  "recommendations",
  "catalog_revisions",
  "listing_revisions",
] as const;

export async function migrateDatabase(adminUrl: string, appUrl: string): Promise<void> {
  const app = new URL(appUrl);
  const admin = new URL(adminUrl);
  const appRole = decodeURIComponent(app.username);
  if (appRole === decodeURIComponent(admin.username)) {
    throw new Error("DATABASE_URL must use a different, non-owner role than DATABASE_ADMIN_URL so row-level security is enforced.");
  }
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });

    const role = client.escapeIdentifier(appRole);
    const password = client.escapeLiteral(decodeURIComponent(app.password));
    const exists = await client.query("select rolsuper, rolbypassrls from pg_roles where rolname = $1", [appRole]);
    if (!exists.rowCount) {
      await client.query(`CREATE ROLE ${role} LOGIN PASSWORD ${password} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    } else if (exists.rows[0].rolsuper || exists.rows[0].rolbypassrls) {
      throw new Error(`Application role "${appRole}" can bypass row-level security. Use a plain LOGIN role.`);
    }
    const db = client.escapeIdentifier(admin.pathname.slice(1));
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT EXECUTE ON FUNCTION claim_analysis_job(text, integer) TO ${role}`);
    await client.query(`GRANT EXECUTE ON FUNCTION expired_storage_objects(timestamptz) TO ${role}`);
    for (const table of APPEND_ONLY_TABLES) {
      await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ${client.escapeIdentifier(table)} FROM ${role}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!adminUrl || !appUrl) {
    console.error("DATABASE_ADMIN_URL and DATABASE_URL are required. Run `pnpm setup:env`.");
    process.exit(1);
  }
  migrateDatabase(adminUrl, appUrl)
    .then(() => console.log("Migrations applied; application role and grants are in place."))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
