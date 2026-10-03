/**
 * Fresh setup for browser tests: drops and recreates the dedicated e2e database, applies the
 * migrations and loads the demo seed, exactly as `pnpm setup` does for development.
 */
import { rmSync } from "node:fs";
import pg from "pg";
import { e2eEnv } from "./env";

const env = e2eEnv();
Object.assign(process.env, env);

async function main() {
  const admin = new URL(env.DATABASE_ADMIN_URL);
  const name = admin.pathname.slice(1);
  if (!name.endsWith("_e2e")) throw new Error(`Refusing to reset non-e2e database "${name}".`);
  const maintenance = new URL(admin);
  maintenance.pathname = "/postgres";
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  await client.query(`drop database if exists "${name}" with (force)`);
  await client.query(`create database "${name}"`);
  await client.end();
  rmSync(env.STORAGE_DIR, { recursive: true, force: true });

  const { migrateDatabase } = await import("../../db/migrate");
  await migrateDatabase(env.DATABASE_ADMIN_URL, env.DATABASE_URL);
  const { seed } = await import("../../db/seed");
  const { closeDb } = await import("../../db/client");
  const result = await seed(env.SEED_USER_PASSWORD, { scenario: true });
  await closeDb();
  console.log(`e2e database "${name}" rebuilt from migrations; demo scenario loaded: ${result.scenarioLoaded}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
