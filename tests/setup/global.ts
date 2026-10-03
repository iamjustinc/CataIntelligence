import pg from "pg";
import "dotenv/config";
import { migrateDatabase } from "../../db/migrate";
import { testUrl } from "./urls";

/** Recreates the test database from migrations before every run (PRD AT28: fresh install). */
export default async function setup() {
  const adminUrl = testUrl(process.env.DATABASE_ADMIN_URL);
  const appUrl = testUrl(process.env.DATABASE_URL);
  if (!adminUrl || !appUrl) throw new Error("DATABASE_ADMIN_URL and DATABASE_URL are required for tests. Run `pnpm setup:env && pnpm db:up`.");
  const target = new URL(adminUrl);
  const name = target.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`Refusing to reset non-test database "${name}".`);
  const maintenance = new URL(adminUrl);
  maintenance.pathname = "/postgres";
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  await client.query(`drop database if exists "${name}" with (force)`);
  await client.query(`create database "${name}"`);
  await client.end();
  await migrateDatabase(adminUrl, appUrl);
}
