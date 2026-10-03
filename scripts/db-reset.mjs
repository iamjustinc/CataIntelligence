#!/usr/bin/env node
// Drops and recreates the DEVELOPMENT database, then migrates and seeds it from scratch.
// Usage: node scripts/db-reset.mjs [--yes]
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import pg from "pg";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to reset a database when NODE_ENV=production.");
  process.exit(1);
}
const url = new URL(process.env.DATABASE_ADMIN_URL ?? "");
const name = url.pathname.slice(1);
if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
  console.error(`Refusing to reset "${name}" on non-local host ${url.hostname}.`);
  process.exit(1);
}
if (!process.argv.includes("--yes")) {
  console.error(`This deletes every record in the local database "${name}" and reloads the demo data.\nRun again with --yes to confirm:  pnpm db:reset --yes`);
  process.exit(1);
}
const maintenance = new URL(url);
maintenance.pathname = "/postgres";
const client = new pg.Client({ connectionString: maintenance.toString() });
await client.connect();
await client.query(`drop database if exists "${name.replaceAll('"', '""')}" with (force)`);
await client.query(`create database "${name.replaceAll('"', '""')}"`);
await client.end();
rmSync(process.env.STORAGE_DIR ?? ".data/storage", { recursive: true, force: true });
execFileSync("pnpm", ["-s", "db:migrate"], { stdio: "inherit" });
execFileSync("pnpm", ["-s", "db:seed"], { stdio: "inherit" });
