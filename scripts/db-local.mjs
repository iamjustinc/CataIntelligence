#!/usr/bin/env node
// Manages an optional project-local PostgreSQL cluster in .data/pg for development and tests.
// Usage: node scripts/db-local.mjs up | down | status
import "dotenv/config";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const DATA_DIR = resolve(".data/pg");
const cmd = process.argv[2] ?? "status";

function findBinDir() {
  const candidates = [
    process.env.PG_BIN_DIR,
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
    "/opt/homebrew/opt/postgresql@17/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/16/bin",
  ].filter(Boolean);
  for (const dir of candidates) if (existsSync(join(dir, "pg_ctl"))) return dir;
  const which = spawnSync("which", ["pg_ctl"], { encoding: "utf8" });
  if (which.status === 0) return resolve(which.stdout.trim(), "..");
  throw new Error(
    "PostgreSQL binaries not found. Install PostgreSQL 15+ (or set PG_BIN_DIR), or point DATABASE_URL and DATABASE_ADMIN_URL at an existing server.",
  );
}

function adminUrl() {
  const raw = process.env.DATABASE_ADMIN_URL;
  if (!raw) throw new Error("DATABASE_ADMIN_URL is not set. Run `pnpm setup:env` first.");
  return new URL(raw);
}

function isRunning(bin) {
  return spawnSync(join(bin, "pg_ctl"), ["-D", DATA_DIR, "status"], { stdio: "ignore" }).status === 0;
}

async function ensureDatabases(url) {
  const base = url.pathname.slice(1);
  const client = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).toString() });
  await client.connect();
  try {
    for (const name of [base, `${base}_test`]) {
      const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
      if (!rowCount) {
        await client.query(`create database "${name.replaceAll('"', '""')}"`);
        console.log(`Created database ${name}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function up() {
  const bin = findBinDir();
  const url = adminUrl();
  const port = url.port || process.env.PG_LOCAL_PORT || "54329";
  if (!existsSync(join(DATA_DIR, "PG_VERSION"))) {
    mkdirSync(DATA_DIR, { recursive: true });
    const pwfile = resolve(".data/.pwfile");
    writeFileSync(pwfile, decodeURIComponent(url.password), { mode: 0o600 });
    try {
      execFileSync(
        join(bin, "initdb"),
        ["-D", DATA_DIR, "-U", decodeURIComponent(url.username), `--pwfile=${pwfile}`, "--auth=scram-sha-256", "-E", "UTF8", "--locale=C"],
        { stdio: "inherit" },
      );
    } finally {
      rmSync(pwfile, { force: true });
    }
  }
  if (!isRunning(bin)) {
    execFileSync(
      join(bin, "pg_ctl"),
      ["-D", DATA_DIR, "-l", join(DATA_DIR, "server.log"), "-w", "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, "start"],
      { stdio: "inherit" },
    );
  }
  await ensureDatabases(url);
  console.log(`PostgreSQL is running on 127.0.0.1:${port} (data: ${DATA_DIR})`);
}

function down() {
  const bin = findBinDir();
  if (isRunning(bin)) execFileSync(join(bin, "pg_ctl"), ["-D", DATA_DIR, "-m", "fast", "stop"], { stdio: "inherit" });
  else console.log("Local PostgreSQL is not running.");
}

try {
  if (cmd === "up") await up();
  else if (cmd === "down") down();
  else console.log(isRunning(findBinDir()) ? "running" : "stopped");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
