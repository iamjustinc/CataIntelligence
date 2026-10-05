import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, withContext } from "@/db/client";
import { APPEND_ONLY_TABLES } from "@/db/migrate";
import { auditEvents, merchants, workspaces } from "@/db/schema";
import { seed, SEED_USERS } from "@/db/seed";
import { ApiError } from "@/lib/api/errors";
import { listWorkspacesForUser, resolveActor, type Actor } from "@/lib/auth/actor";
import { createMerchant, getMerchant, listMerchants } from "@/lib/domain/merchants";
import { listMembers } from "@/lib/domain/workspace";
import { adminClient, PASSWORD } from "../setup/helpers";

let admin: pg.Client;
let demoId: string;
let sandboxId: string;
const actors: Record<string, Actor> = {};

async function actorFor(email: string, workspaceId: string): Promise<Actor> {
  const { rows } = await admin.query('select id, name from "user" where email = $1', [email]);
  const actor = await resolveActor({ id: rows[0].id, email, name: rows[0].name }, workspaceId);
  if (!actor) throw new Error(`no actor for ${email}`);
  return actor;
}

beforeAll(async () => {
  admin = await adminClient();
  ({ demoWorkspaceId: demoId, sandboxWorkspaceId: sandboxId } = await seed(PASSWORD));
  actors.admin = await actorFor(SEED_USERS[0].email, demoId);
  actors.taxonomist = await actorFor(SEED_USERS[1].email, demoId);
  actors.viewer = await actorFor(SEED_USERS[3].email, demoId);
  actors.outsider = await actorFor(SEED_USERS[4].email, sandboxId);
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

describe("fresh database from migrations", () => {
  it("applies all migrations and creates every table", async () => {
    const migrations = await admin.query("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(migrations.rows[0].n).toBe(5);
    const tables = await admin.query("select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
    expect(tables.rows[0].n).toBe(31);
  });
  it("seeding twice is idempotent", async () => {
    await seed(PASSWORD);
    const users = await admin.query('select count(*)::int as n from "user" where email = any($1)', [SEED_USERS.map((u) => u.email)]);
    const merchantCount = await admin.query("select count(*)::int as n from merchants where workspace_id = $1 and external_key in ('HARBOR', 'DAILY', 'CORNER')", [demoId]);
    expect(users.rows[0].n).toBe(SEED_USERS.length);
    expect(merchantCount.rows[0].n).toBe(3);
  });
});

describe("row-level security", () => {
  it("covers every table that has a workspace_id column", async () => {
    const { rows } = await admin.query(`
      select c.relname, c.relrowsecurity, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped)`);
    expect(rows.length).toBeGreaterThanOrEqual(24);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} must enable RLS`).toBe(true);
      expect(row.policies, `${row.relname} must have a policy`).toBeGreaterThan(0);
    }
    const ws = await admin.query("select relrowsecurity from pg_class where relname = 'workspaces'");
    expect(ws.rows[0].relrowsecurity).toBe(true);
  });
  it("runs the application as a non-owner role that cannot bypass policies", async () => {
    const { rows } = await db().execute<{ rolsuper: boolean; rolbypassrls: boolean; owns: number }>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "select r.rolsuper, r.rolbypassrls, (select count(*)::int from pg_tables t where t.schemaname = 'public' and t.tableowner = current_user) as owns from pg_roles r where r.rolname = current_user" as any,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owns: 0 });
  });
  it("returns nothing without a context", async () => {
    expect(await db().select().from(merchants)).toHaveLength(0);
    expect(await db().select().from(workspaces)).toHaveLength(0);
    expect(await db().select().from(auditEvents)).toHaveLength(0);
  });
  it("shows only the current workspace's rows", async () => {
    const demo = await withContext({ workspaceId: demoId }, (tx) => tx.select().from(merchants));
    const sandbox = await withContext({ workspaceId: sandboxId }, (tx) => tx.select().from(merchants));
    expect(demo.length).toBeGreaterThanOrEqual(3);
    expect(demo.every((m) => m.workspaceId === demoId)).toBe(true);
    expect(sandbox).toHaveLength(0);
  });
  it("rejects writing a row for another workspace", async () => {
    await expect(
      withContext({ workspaceId: sandboxId }, (tx) => tx.insert(merchants).values({ workspaceId: demoId, name: "Smuggled" })),
    ).rejects.toThrow();
    const check = await admin.query("select count(*)::int as n from merchants where name = 'Smuggled'");
    expect(check.rows[0].n).toBe(0);
  });
  it("cannot update or read a foreign workspace's row by ID", async () => {
    const [target] = await withContext({ workspaceId: demoId }, (tx) => tx.select().from(merchants).limit(1));
    const updated = await withContext({ workspaceId: sandboxId }, (tx) =>
      tx.update(merchants).set({ name: "Hijacked" }).where(eq(merchants.id, target.id)).returning(),
    );
    expect(updated).toHaveLength(0);
    const after = await admin.query("select name from merchants where id = $1", [target.id]);
    expect(after.rows[0].name).toBe(target.name);
  });
});

describe("database integrity", () => {
  it("composite foreign keys block cross-workspace references even for the owner role", async () => {
    const merchant = await admin.query("select id from merchants where workspace_id = $1 limit 1", [demoId]);
    const userRow = await admin.query('select id from "user" limit 1');
    await expect(
      admin.query(
        `insert into catalog_revisions (workspace_id, merchant_id, sequence, mode, file_hash, population_hash, counts, created_by)
         values ($1, $2, 1, 'snapshot', 'h', 'p', '{}', $3)`,
        [sandboxId, merchant.rows[0].id, userRow.rows[0].id],
      ),
    ).rejects.toThrow(/catalog_revisions_merchant_fk/);
  });
  it("requires a currency whenever a price is present and forbids negative prices", async () => {
    const { rows } = await admin.query("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'listing_revisions_price_currency'");
    expect(rows[0].def).toMatch(/price.*>=.*0/s);
    expect(rows[0].def).toMatch(/currency IS NOT NULL/);
  });
  it("makes audit events append-only for the application role and the owner", async () => {
    await expect(withContext({ workspaceId: demoId }, (tx) => tx.update(auditEvents).set({ action: "tampered" }))).rejects.toThrow();
    await expect(withContext({ workspaceId: demoId }, (tx) => tx.delete(auditEvents))).rejects.toThrow();
    await expect(admin.query("update audit_events set action = 'tampered'")).rejects.toThrow(/append-only/);
    for (const table of APPEND_ONLY_TABLES) {
      const grants = await admin.query(
        "select has_table_privilege($1, $2, 'UPDATE') as u, has_table_privilege($1, $2, 'DELETE') as d, has_table_privilege($1, $2, 'INSERT') as i",
        [new URL(process.env.DATABASE_URL!).username, table],
      );
      expect(grants.rows[0], table).toEqual({ u: false, d: false, i: true });
    }
  });
  it("freezes a taxonomy version and its concepts once published", async () => {
    const userRow = await admin.query('select id from "user" limit 1');
    const versionId = randomUUID();
    const conceptId = randomUUID();
    await admin.query("insert into taxonomy_versions (id, workspace_id, sequence, created_by) values ($1, $2, 900, $3)", [versionId, sandboxId, userRow.rows[0].id]);
    await admin.query("insert into concepts (id, workspace_id, stable_key) values ($1, $2, 'T-ROOT')", [conceptId, sandboxId]);
    await admin.query(
      "insert into concept_revisions (workspace_id, taxonomy_version_id, concept_id, name, path, depth) values ($1, $2, $3, 'Root', 'Root', 1)",
      [sandboxId, versionId, conceptId],
    );
    await admin.query("update taxonomy_versions set state = 'published', published_by = $2, published_at = now() where id = $1", [versionId, userRow.rows[0].id]);
    await expect(admin.query("update concept_revisions set name = 'Changed' where taxonomy_version_id = $1", [versionId])).rejects.toThrow(/cannot be changed/);
    await expect(admin.query("delete from concept_revisions where taxonomy_version_id = $1", [versionId])).rejects.toThrow(/cannot be changed/);
    await expect(
      admin.query("insert into concept_revisions (workspace_id, taxonomy_version_id, concept_id, name, path, depth) values ($1, $2, $3, 'Late', 'Late', 1)", [sandboxId, versionId, randomUUID()]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(admin.query("update taxonomy_versions set note = 'edit' where id = $1", [versionId])).rejects.toThrow(/cannot be changed/);
  });
  it("allows only one draft taxonomy version per workspace", async () => {
    const userRow = await admin.query('select id from "user" limit 1');
    await admin.query("insert into taxonomy_versions (workspace_id, sequence, created_by) values ($1, 901, $2)", [sandboxId, userRow.rows[0].id]);
    await expect(
      admin.query("insert into taxonomy_versions (workspace_id, sequence, created_by) values ($1, 902, $2)", [sandboxId, userRow.rows[0].id]),
    ).rejects.toThrow(/taxonomy_versions_one_draft_uq/);
    await admin.query("delete from taxonomy_versions where workspace_id = $1 and sequence = 901", [sandboxId]);
  });
});

describe("membership and service authorization", () => {
  it("ignores a requested workspace the user does not belong to", async () => {
    const rin = actors.taxonomist;
    const forged = await resolveActor({ id: rin.userId, email: rin.email, name: rin.name }, sandboxId);
    expect(forged?.workspaceId).toBe(demoId);
    expect(await listWorkspacesForUser(rin.userId)).toHaveLength(1);
  });
  it("gives a user different roles in different workspaces", async () => {
    const avery = actors.admin;
    const inSandbox = await resolveActor({ id: avery.userId, email: avery.email, name: avery.name }, sandboxId);
    expect(avery.role).toBe("administrator");
    expect(inSandbox?.role).toBe("viewer");
  });
  it("returns no actor for a user without memberships or with a deactivated one", async () => {
    expect(await resolveActor({ id: randomUUID(), email: "nobody@example.test", name: "Nobody" }, demoId)).toBeNull();
    const sam = actors.viewer;
    await admin.query("update memberships set active = false where user_id = $1", [sam.userId]);
    expect(await resolveActor({ id: sam.userId, email: sam.email, name: sam.name }, demoId)).toBeNull();
    await admin.query("update memberships set active = true where user_id = $1", [sam.userId]);
  });
  it("hides another workspace's merchants from list and by-ID reads (404, not 403)", async () => {
    const [demoMerchant] = await listMerchants(actors.admin);
    expect(await listMerchants(actors.outsider)).toHaveLength(0);
    await expect(getMerchant(actors.outsider, demoMerchant.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("enforces role capabilities in the service layer, not only the route", async () => {
    await expect(createMerchant(actors.viewer, { name: "Viewer Made" }, "req-test")).rejects.toBeInstanceOf(ApiError);
    await expect(createMerchant(actors.viewer, { name: "Viewer Made" }, "req-test")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listMembers(actors.taxonomist)).rejects.toMatchObject({ code: "forbidden" });
    expect((await listMembers(actors.admin)).map((m) => m.role).sort()).toEqual(["administrator", "analyst", "taxonomist", "viewer"]);
  });
  it("writes the audit event in the same transaction as the change", async () => {
    const created = await createMerchant(actors.taxonomist, { name: "Audit Probe Market", region: "US" }, "req-audit-1");
    const events = await admin.query("select actor_role, action, request_id, workspace_id from audit_events where entity_id = $1", [created.id]);
    expect(events.rows).toEqual([{ actor_role: "taxonomist", action: "merchant.create", request_id: "req-audit-1", workspace_id: demoId }]);
    await expect(createMerchant(actors.taxonomist, { name: "audit probe market" }, "req-audit-2")).rejects.toMatchObject({ code: "conflict" });
    const after = await admin.query("select count(*)::int as n from audit_events where request_id = 'req-audit-2'");
    expect(after.rows[0].n).toBe(0);
  });
});
