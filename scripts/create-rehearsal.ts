/**
 * Creates a separate rehearsal workspace, so practising the demo never changes the presentation
 * workspace's dashboard.
 *
 *   pnpm rehearsal:create
 *
 * Adds a workspace named "Rehearsal (synthetic data)", gives the existing seeded people the same
 * roles there as in the demo workspace, and loads the same synthetic scenario through the
 * application services. Safe to rerun: it does nothing to a rehearsal workspace that already has a
 * taxonomy. It never touches any other workspace and deletes nothing. Workspace isolation means
 * nothing done in it appears in the demo workspace, and the reverse.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { closeDb, db, withContext } from "@/db/client";
import { memberships, user, workspaces } from "@/db/schema";
import { DEMO_WORKSPACE, ensureMembership, ensureWorkspace, SEED_USERS } from "@/db/seed";
import { seedScenario } from "@/db/seed-scenario";
import { resolveActor } from "@/lib/auth/actor";

export const REHEARSAL_WORKSPACE = { slug: "rehearsal", name: "Rehearsal (synthetic data)" };

async function main() {
  // Row-level security applies to this script too: find the workspace as one of its members,
  // then read its membership list in that workspace's context.
  const [owner] = await db().select({ id: user.id }).from(user).where(eq(user.email, SEED_USERS[0].email));
  if (!owner) throw new Error("The seeded administrator does not exist. Run `pnpm db:seed` first.");
  const [demo] = await withContext({ userId: owner.id }, (tx) => tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, DEMO_WORKSPACE.slug)));
  if (!demo) throw new Error("The demo workspace does not exist. Run `pnpm db:seed` first.");
  // Copy who is who from the demo workspace; no new accounts or passwords are created.
  const members = await withContext({ workspaceId: demo.id }, (tx) => tx.select({ userId: memberships.userId, role: memberships.role, email: user.email, name: user.name }).from(memberships).innerJoin(user, eq(user.id, memberships.userId)).where(eq(memberships.workspaceId, demo.id)));
  const admin = members.find((m) => m.role === "administrator");
  const reviewer = members.find((m) => m.role === "taxonomist") ?? admin;
  if (!admin || !reviewer) throw new Error("The demo workspace has no administrator to copy.");

  const workspaceId = await ensureWorkspace(admin.userId, REHEARSAL_WORKSPACE, true);
  for (const m of members) await ensureMembership(workspaceId, m.userId, m.role);
  const actor = async (m: typeof admin) => (await resolveActor({ id: m.userId, email: m.email, name: m.name }, workspaceId))!;
  const result = await seedScenario(await actor(admin), await actor(reviewer));
  console.log(`Rehearsal workspace ${result ? "created and loaded with the synthetic scenario" : "already existed; left as it is"}: "${REHEARSAL_WORKSPACE.name}", ${members.length} members. Switch to it with the workspace selector at the top of the page.`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
