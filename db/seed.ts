/**
 * Seeds demo identities, workspaces, merchants and the demo scenario. Idempotent: rerunning
 * changes nothing. Runs as the application role through the same row-level security and domain
 * services as the web app. Catalog and taxonomy data are loaded through the import services,
 * never inserted directly, so every seeded count derives from real records.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { closeDb, db, withContext } from "./client";
import { account, memberships, user, workspaces } from "./schema";
import { resolveActor } from "@/lib/auth/actor";
import type { Role } from "@/lib/auth/permissions";
import { createMerchant, listMerchants } from "@/lib/domain/merchants";
import { MERCHANTS } from "@/fixtures/generate";
import { seedScenario } from "./seed-scenario";

export const DEMO_WORKSPACE = { slug: "tidewater-demo", name: "Tidewater Catalog Ops (Demo)" };
export const SANDBOX_WORKSPACE = { slug: "fennel-sandbox", name: "Fennel & Fig Sandbox" };

/** Fictional people. The .test TLD is reserved and never routable. */
export const SEED_USERS = [
  { email: "avery.admin@catalog-intelligence.test", name: "Avery Okafor", demo: "administrator", sandbox: "viewer" },
  { email: "rin.taxonomist@catalog-intelligence.test", name: "Rin Castellanos", demo: "taxonomist", sandbox: null },
  { email: "jo.analyst@catalog-intelligence.test", name: "Jo Lindqvist", demo: "analyst", sandbox: null },
  { email: "sam.viewer@catalog-intelligence.test", name: "Sam Whitlock", demo: "viewer", sandbox: null },
  { email: "dana.admin@fennel-sandbox.test", name: "Dana Mbeki", demo: null, sandbox: "administrator" },
] as const satisfies readonly { email: string; name: string; demo: Role | null; sandbox: Role | null }[];

async function ensureUser(email: string, name: string, password: string): Promise<string> {
  const [existing] = await db().select({ id: user.id }).from(user).where(eq(user.email, email));
  if (existing) return existing.id;
  const id = randomUUID();
  await db().transaction(async (tx) => {
    await tx.insert(user).values({ id, email, name, emailVerified: true });
    await tx.insert(account).values({ userId: id, accountId: id, providerId: "credential", password: await hashPassword(password) });
  });
  return id;
}

export async function ensureWorkspace(ownerUserId: string, def: { slug: string; name: string }, isDemo: boolean): Promise<string> {
  const found = await withContext({ userId: ownerUserId }, (tx) => tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, def.slug)));
  if (found[0]) return found[0].id;
  const id = randomUUID();
  await withContext({ workspaceId: id }, async (tx) => {
    await tx.insert(workspaces).values({ id, slug: def.slug, name: def.name, isDemo, providerMode: isDemo ? "demo" : "off" });
  });
  return id;
}

export async function ensureMembership(workspaceId: string, userId: string, role: Role): Promise<void> {
  await withContext({ workspaceId }, (tx) => tx.insert(memberships).values({ workspaceId, userId, role }).onConflictDoNothing());
}

/**
 * Seeds identities, workspaces and merchants. With `scenario`, also loads the full demo scenario
 * into the demo workspace through the domain services (see db/seed-scenario.ts).
 */
export async function seed(password: string, options: { scenario?: boolean } = {}): Promise<{ demoWorkspaceId: string; sandboxWorkspaceId: string; scenarioLoaded: boolean }> {
  const ids = new Map<string, string>();
  for (const u of SEED_USERS) ids.set(u.email, await ensureUser(u.email, u.name, password));

  // Memberships are created with a workspace context, so the first lookup for a brand-new
  // workspace finds nothing and falls through to creation.
  const demoWorkspaceId = await ensureWorkspace(ids.get(SEED_USERS[0].email)!, DEMO_WORKSPACE, true);
  const sandboxWorkspaceId = await ensureWorkspace(ids.get(SEED_USERS[4].email)!, SANDBOX_WORKSPACE, false);
  for (const u of SEED_USERS) {
    if (u.demo) await ensureMembership(demoWorkspaceId, ids.get(u.email)!, u.demo);
    if (u.sandbox) await ensureMembership(sandboxWorkspaceId, ids.get(u.email)!, u.sandbox);
  }

  const admin = SEED_USERS[0];
  const actor = await resolveActor({ id: ids.get(admin.email)!, email: admin.email, name: admin.name }, demoWorkspaceId);
  if (!actor) throw new Error("Seed administrator has no membership.");
  const existing = new Set((await listMerchants(actor)).map((m) => m.name));
  for (const m of MERCHANTS) {
    if (!existing.has(m.name)) await createMerchant(actor, { name: m.name, externalKey: m.externalKey, region: m.region }, `seed-${randomUUID()}`);
  }
  let scenarioLoaded = false;
  if (options.scenario) {
    const rin = SEED_USERS[1];
    const reviewer = await resolveActor({ id: ids.get(rin.email)!, email: rin.email, name: rin.name }, demoWorkspaceId);
    if (!reviewer) throw new Error("Seed taxonomist has no membership.");
    scenarioLoaded = (await seedScenario(actor, reviewer)) !== null;
  }
  return { demoWorkspaceId, sandboxWorkspaceId, scenarioLoaded };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const password = process.env.SEED_USER_PASSWORD;
  if (!password || password.length < 10) {
    console.error("SEED_USER_PASSWORD (10+ characters) is required. Run `pnpm setup:env`.");
    process.exit(1);
  }
  seed(password, { scenario: !process.argv.includes("--base-only") })
    .then(({ scenarioLoaded }) => {
      console.log(scenarioLoaded ? "Seeded demo identities, workspaces, merchants and the demo scenario (taxonomy, catalogs, reviews, releases)." : "Seed is up to date: identities, workspaces and merchants exist; the demo scenario was already loaded or skipped.");
      console.log(SEED_USERS.map((u) => `  ${u.email}`).join("\n"));
      console.log("Sign in with any address above and the SEED_USER_PASSWORD value from .env.");
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
