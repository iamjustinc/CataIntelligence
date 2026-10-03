import { and, count, eq, sql } from "drizzle-orm";
import { withContext } from "@/db/client";
import { catalogRevisions, mappingReleases, memberships, merchants, taxonomyVersions, user, workspaces } from "@/db/schema";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { forbidden, notFound } from "@/lib/api/errors";
import { resolveProviderStatus, type ProviderStatus } from "@/lib/ai/provider";
import { env } from "@/lib/env";

export async function getWorkspace(actor: Actor) {
  const [row] = await withContext(actor, (tx) => tx.select().from(workspaces).where(eq(workspaces.id, actor.workspaceId)));
  if (!row) throw notFound("Workspace");
  return row;
}

export async function getProviderStatus(actor: Actor): Promise<ProviderStatus> {
  const ws = await getWorkspace(actor);
  return resolveProviderStatus(ws.providerMode, env(), ws.liveAiOptIn);
}

export interface SetupProgress {
  publishedTaxonomyVersions: number;
  draftTaxonomyVersions: number;
  merchants: number;
  catalogRevisions: number;
  mappingReleases: number;
  /** Active listings in merchants' current catalog revisions, and how many are approved. */
  activeListings: number;
  approvedListings: number;
  staleListings: number;
}

/** Record counts behind the setup checklist. Every number is a live query, never a constant. */
export async function getSetupProgress(actor: Actor): Promise<SetupProgress> {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, async (tx) => {
    const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    return {
      publishedTaxonomyVersions: await one(tx.select({ n: count() }).from(taxonomyVersions).where(eq(taxonomyVersions.state, "published"))),
      draftTaxonomyVersions: await one(tx.select({ n: count() }).from(taxonomyVersions).where(eq(taxonomyVersions.state, "draft"))),
      merchants: await one(tx.select({ n: count() }).from(merchants).where(eq(merchants.active, true))),
      catalogRevisions: await one(tx.select({ n: count() }).from(catalogRevisions)),
      mappingReleases: await one(tx.select({ n: count() }).from(mappingReleases)),
      ...(
        await tx.execute<{ active: number; approved: number; stale: number }>(sql`
          select count(*)::int as active, count(*) filter (where rs.state = 'approved')::int as approved, count(*) filter (where rs.state = 'stale')::int as stale
          from review_states rs
          join listing_revisions lr on lr.id = rs.listing_revision_id and lr.active
          join merchants m on m.active_catalog_revision_id = lr.catalog_revision_id`)
      ).rows.map((r) => ({ activeListings: r.active, approvedListings: r.approved, staleListings: r.stale }))[0],
    };
  });
}

export async function listMembers(actor: Actor) {
  if (!can(actor.role, "workspace.manage")) throw forbidden("Only administrators can view workspace members.");
  return withContext(actor, (tx) =>
    tx
      .select({ id: memberships.id, userId: user.id, name: user.name, email: user.email, role: memberships.role, active: memberships.active })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, actor.workspaceId)))
      .orderBy(user.name),
  );
}
