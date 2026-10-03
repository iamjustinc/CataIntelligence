import { and, desc, eq, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withContext, type Tx } from "@/db/client";
import { catalogRevisions, currentReleases, exportFiles, mappingReleases, merchants, publishedMappings, releaseUnresolved, taxonomyVersions, user, workspaces } from "@/db/schema";
import { ApiError, conflict, forbidden, notFound } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { toSafeCsv } from "@/lib/export/csv";
import { zip } from "@/lib/export/zip";
import { STATE_LABELS, type ReviewState } from "@/lib/review-labels";
import { objectStore } from "@/lib/storage";

interface PopulationRow extends Record<string, unknown> {
  listing_revision_id: string;
  listing_id: string;
  state: ReviewState;
  state_version: string | null;
  decision_id: string | null;
  concept_id: string | null;
  decision_reason: string | null;
  concept_ok: boolean;
}

const UNRESOLVED_REASON: Record<ReviewState, string> = {
  needs_analysis: "Not analyzed or reviewed",
  suggested: "Suggestion awaiting review",
  needs_investigation: "Needs investigation",
  needs_review: "Changed since the last decision; needs review",
  approved: "Approved against a different taxonomy version; needs revalidation",
  deferred: "Deferred",
  no_suitable_category: "No suitable category",
  stale: "Stale after a taxonomy change; needs revalidation",
};

export interface ReleasePreview {
  merchant: { id: string; name: string };
  catalogRevision: { id: string; sequence: number } | null;
  taxonomyVersion: { id: string; sequence: number } | null;
  activeListings: number;
  mapped: number;
  unresolved: number;
  unresolvedByState: Partial<Record<ReviewState, number>>;
  /** Conditions that block publication entirely. */
  blockers: string[];
  partial: boolean;
  /** Compared with the merchant's current release, by listing. */
  changes: { added: number; changed: number; removed: number; unchanged: number };
  currentRelease: { id: string; releaseNumber: number; catalogRevisionId: string } | null;
}

interface Computed {
  preview: ReleasePreview;
  mappedRows: PopulationRow[];
  unresolvedRows: PopulationRow[];
  pointerLock: number | null;
}

/**
 * Evaluates what a release of this merchant's current catalog revision against the active
 * taxonomy version would contain. Used by both preview and publication, so the published counts
 * are computed by exactly the code the administrator previewed.
 */
async function compute(tx: Tx, actor: Actor, merchantId: string, lock: boolean): Promise<Computed> {
  const merchantQuery = tx.select().from(merchants).where(eq(merchants.id, merchantId));
  const [merchant] = lock ? await merchantQuery.for("update") : await merchantQuery;
  if (!merchant) throw notFound("Merchant");
  const [ws] = await tx.select({ active: workspaces.activeTaxonomyVersionId }).from(workspaces).where(eq(workspaces.id, actor.workspaceId));
  const [revision] = merchant.activeCatalogRevisionId ? await tx.select({ id: catalogRevisions.id, sequence: catalogRevisions.sequence }).from(catalogRevisions).where(eq(catalogRevisions.id, merchant.activeCatalogRevisionId)) : [];
  const [version] = ws.active ? await tx.select({ id: taxonomyVersions.id, sequence: taxonomyVersions.sequence }).from(taxonomyVersions).where(eq(taxonomyVersions.id, ws.active)) : [];
  const pointerQuery = tx.select().from(currentReleases).where(eq(currentReleases.merchantId, merchantId));
  const [pointer] = lock ? await pointerQuery.for("update") : await pointerQuery;
  const [current] = pointer ? await tx.select({ id: mappingReleases.id, releaseNumber: mappingReleases.releaseNumber, catalogRevisionId: mappingReleases.catalogRevisionId }).from(mappingReleases).where(eq(mappingReleases.id, pointer.releaseId)) : [];

  const blockers: string[] = [];
  if (!revision) blockers.push("This merchant has no catalog revision.");
  if (!version) blockers.push("No taxonomy version is published.");
  let rows: PopulationRow[] = [];
  if (revision && version) {
    const result = await tx.execute<PopulationRow>(sql`
      select lr.id as listing_revision_id, lr.listing_id, rs.state, rs.taxonomy_version_id as state_version,
             d.id as decision_id, d.selected_concept_id as concept_id, d.reason as decision_reason,
             (cr.concept_id is not null and cr.status = 'active' and cr.mapping_allowed) as concept_ok
      from listing_revisions lr
      join review_states rs on rs.listing_revision_id = lr.id
      left join review_decisions d on d.id = rs.latest_decision_id
      left join concept_revisions cr on cr.taxonomy_version_id = ${version.id} and cr.concept_id = d.selected_concept_id
      where lr.catalog_revision_id = ${revision.id} and lr.active
      order by lr.id
      ${lock ? sql`for update of rs` : sql``}`);
    rows = result.rows;
  }
  const mappedRows: PopulationRow[] = [];
  const unresolvedRows: PopulationRow[] = [];
  const unresolvedByState: Partial<Record<ReviewState, number>> = {};
  let invalid = 0;
  for (const r of rows) {
    const current = r.state === "approved" && r.state_version === version!.id;
    if (current && r.concept_ok && r.decision_id && r.concept_id) mappedRows.push(r);
    else {
      if (current) invalid++;
      unresolvedRows.push(r);
      unresolvedByState[r.state] = (unresolvedByState[r.state] ?? 0) + 1;
    }
  }
  const stale = rows.filter((r) => r.state === "stale" || (r.state === "approved" && r.state_version !== version?.id)).length;
  if (stale > 0) blockers.push(`${stale} listing${stale === 1 ? " has" : "s have"} a mapping bound to an earlier taxonomy version. Revalidate dependencies first.`);
  if (invalid > 0) blockers.push(`${invalid} approved mapping${invalid === 1 ? " points" : "s point"} to a concept that is not an active leaf in the active taxonomy version.`);
  if (revision && version && mappedRows.length === 0) blockers.push("There are no approved mappings to publish.");

  const changes = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  if (current) {
    const previous = await tx.execute<{ listing_id: string; concept_id: string }>(sql`
      select lr.listing_id, pm.concept_id from published_mappings pm join listing_revisions lr on lr.id = pm.listing_revision_id where pm.release_id = ${current.id}`);
    const before = new Map(previous.rows.map((p) => [p.listing_id, p.concept_id]));
    const seen = new Set<string>();
    for (const m of mappedRows) {
      seen.add(m.listing_id);
      const was = before.get(m.listing_id);
      if (!was) changes.added++;
      else if (was !== m.concept_id) changes.changed++;
      else changes.unchanged++;
    }
    for (const id of before.keys()) if (!seen.has(id)) changes.removed++;
  } else changes.added = mappedRows.length;

  return {
    preview: {
      merchant: { id: merchant.id, name: merchant.name },
      catalogRevision: revision ?? null,
      taxonomyVersion: version ?? null,
      activeListings: rows.length,
      mapped: mappedRows.length,
      unresolved: unresolvedRows.length,
      unresolvedByState,
      blockers,
      partial: unresolvedRows.length > 0,
      changes,
      currentRelease: current ?? null,
    },
    mappedRows,
    unresolvedRows,
    pointerLock: pointer?.lockVersion ?? null,
  };
}

export async function previewRelease(actor: Actor, merchantId: string): Promise<ReleasePreview> {
  if (!can(actor.role, "release.publish")) throw forbidden("Only administrators can prepare a mapping release.");
  return withContext(actor, async (tx) => (await compute(tx, actor, merchantId, false)).preview);
}

export interface PublishInput {
  merchantId: string;
  catalogRevisionId: string;
  taxonomyVersionId: string;
  reason: string;
  acknowledgePartial: boolean;
  /** Counts the administrator saw in the preview; publication fails if they no longer match. */
  expectedMapped: number;
  expectedUnresolved: number;
}

/**
 * Atomically publishes an immutable mapping release and moves the merchant's current-release
 * pointer (PRD TAX12). The release, its mappings, its unresolved list, the pointer and the audit
 * event commit together or not at all. The same idempotency key always returns the same release.
 */
export async function publishRelease(actor: Actor, input: PublishInput, idempotencyKey: string, requestId: string, hooks: { beforePointer?: () => void } = {}) {
  if (!can(actor.role, "release.publish")) throw forbidden("Only administrators can publish a mapping release.");
  return withContext(actor, async (tx) => {
    // Serialises release numbering and publication per workspace.
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, actor.workspaceId)).for("update");
    const [existing] = await tx.select().from(mappingReleases).where(eq(mappingReleases.idempotencyKey, idempotencyKey));
    if (existing) return { releaseId: existing.id, releaseNumber: existing.releaseNumber, partial: existing.partial, counts: existing.counts as ReleaseCounts, replayed: true };

    const { preview, mappedRows, unresolvedRows, pointerLock } = await compute(tx, actor, input.merchantId, true);
    if (preview.catalogRevision?.id !== input.catalogRevisionId) throw conflict("The merchant's current catalog revision changed since the preview. Review the new preview.", { catalogRevisionId: preview.catalogRevision?.id ?? null });
    if (preview.taxonomyVersion?.id !== input.taxonomyVersionId) throw conflict("The active taxonomy version changed since the preview. Review the new preview.", { taxonomyVersionId: preview.taxonomyVersion?.id ?? null });
    if (preview.blockers.length > 0) throw new ApiError("invalid", "This release cannot be published yet.", { fieldErrors: preview.blockers.map((message) => ({ path: "release", message })) });
    if (preview.mapped !== input.expectedMapped || preview.unresolved !== input.expectedUnresolved) {
      throw conflict("Review decisions changed since the preview. Review the updated counts before publishing.", { mapped: preview.mapped, unresolved: preview.unresolved });
    }
    if (preview.partial && !input.acknowledgePartial) {
      throw new ApiError("invalid", `${preview.unresolved} listing${preview.unresolved === 1 ? " is" : "s are"} unresolved. Acknowledge the partial release to publish.`, { fieldErrors: [{ path: "acknowledgePartial", message: "Required for a partial release." }] });
    }

    const [{ last }] = await tx.select({ last: max(mappingReleases.releaseNumber) }).from(mappingReleases);
    const counts: ReleaseCounts = { activeListings: preview.activeListings, mapped: preview.mapped, unresolved: preview.unresolved, unresolvedByState: preview.unresolvedByState, changes: preview.changes };
    const [release] = await tx
      .insert(mappingReleases)
      .values({
        workspaceId: actor.workspaceId,
        merchantId: input.merchantId,
        catalogRevisionId: input.catalogRevisionId,
        taxonomyVersionId: input.taxonomyVersionId,
        releaseNumber: (last ?? 0) + 1,
        partial: preview.partial,
        reason: input.reason,
        counts,
        idempotencyKey,
        publishedBy: actor.userId,
      })
      .returning();
    for (let i = 0; i < mappedRows.length; i += 1000) {
      await tx.insert(publishedMappings).values(
        mappedRows.slice(i, i + 1000).map((m) => ({ workspaceId: actor.workspaceId, releaseId: release.id, listingRevisionId: m.listing_revision_id, taxonomyVersionId: input.taxonomyVersionId, conceptId: m.concept_id!, decisionId: m.decision_id! })),
      );
    }
    for (let i = 0; i < unresolvedRows.length; i += 1000) {
      await tx.insert(releaseUnresolved).values(
        unresolvedRows.slice(i, i + 1000).map((u) => ({
          workspaceId: actor.workspaceId,
          releaseId: release.id,
          listingRevisionId: u.listing_revision_id,
          state: u.state,
          reason: ["deferred", "no_suitable_category", "needs_investigation"].includes(u.state) && u.decision_reason ? `${UNRESOLVED_REASON[u.state]}: ${u.decision_reason}` : UNRESOLVED_REASON[u.state],
        })),
      );
    }
    hooks.beforePointer?.();
    await tx
      .insert(currentReleases)
      .values({ workspaceId: actor.workspaceId, merchantId: input.merchantId, catalogRevisionId: input.catalogRevisionId, releaseId: release.id })
      .onConflictDoUpdate({ target: [currentReleases.workspaceId, currentReleases.merchantId], set: { releaseId: release.id, catalogRevisionId: input.catalogRevisionId, lockVersion: (pointerLock ?? 0) + 1, updatedAt: new Date() } });
    await recordAudit(tx, actor, requestId, {
      action: "release.publish",
      entityType: "mapping_release",
      entityId: release.id,
      before: { currentReleaseId: preview.currentRelease?.id ?? null },
      after: { releaseNumber: release.releaseNumber, merchantId: input.merchantId, catalogRevisionId: input.catalogRevisionId, taxonomyVersionId: input.taxonomyVersionId, partial: preview.partial, counts },
      reason: input.reason,
    });
    return { releaseId: release.id, releaseNumber: release.releaseNumber, partial: release.partial, counts, replayed: false };
  });
}

export interface ReleaseCounts {
  activeListings: number;
  mapped: number;
  unresolved: number;
  unresolvedByState: Partial<Record<ReviewState, number>>;
  changes: { added: number; changed: number; removed: number; unchanged: number };
}

export async function listReleases(actor: Actor) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, async (tx) => {
    const releases = await tx
      .select({
        id: mappingReleases.id,
        releaseNumber: mappingReleases.releaseNumber,
        merchantId: merchants.id,
        merchantName: merchants.name,
        catalogRevisionId: mappingReleases.catalogRevisionId,
        revisionSequence: catalogRevisions.sequence,
        taxonomySequence: taxonomyVersions.sequence,
        partial: mappingReleases.partial,
        reason: mappingReleases.reason,
        counts: mappingReleases.counts,
        publishedAt: mappingReleases.publishedAt,
        publishedByName: user.name,
        isCurrent: sql<boolean>`${currentReleases.releaseId} is not null`,
        pointerLock: sql<number | null>`(select cr2.lock_version from current_releases cr2 where cr2.merchant_id = ${merchants.id})`,
        /** A release is compatible when it was made from the merchant's current catalog revision. */
        compatible: sql<boolean>`${merchants.activeCatalogRevisionId} = ${mappingReleases.catalogRevisionId}`,
      })
      .from(mappingReleases)
      .innerJoin(merchants, eq(merchants.id, mappingReleases.merchantId))
      .innerJoin(catalogRevisions, eq(catalogRevisions.id, mappingReleases.catalogRevisionId))
      .innerJoin(taxonomyVersions, eq(taxonomyVersions.id, mappingReleases.taxonomyVersionId))
      .innerJoin(user, eq(user.id, mappingReleases.publishedBy))
      .leftJoin(currentReleases, eq(currentReleases.releaseId, mappingReleases.id))
      .orderBy(desc(mappingReleases.releaseNumber));
    return releases.map((r) => ({ ...r, counts: r.counts as ReleaseCounts }));
  });
}

/**
 * Makes an earlier release current again (rollback) or re-activates a release. History is never
 * deleted. A release made from a different catalog revision is incompatible with the merchant's
 * current catalog: the administrator must explicitly activate that revision too, or it is blocked.
 */
export async function activateRelease(actor: Actor, releaseId: string, input: { expectedVersion: number; activateCatalogRevision: boolean; reason: string }, requestId: string) {
  if (!can(actor.role, "release.publish")) throw forbidden("Only administrators can change the current release.");
  return withContext(actor, async (tx) => {
    const [release] = await tx.select().from(mappingReleases).where(eq(mappingReleases.id, releaseId));
    if (!release) throw notFound("Release");
    const [merchant] = await tx.select().from(merchants).where(eq(merchants.id, release.merchantId)).for("update");
    const [pointer] = await tx.select().from(currentReleases).where(eq(currentReleases.merchantId, release.merchantId)).for("update");
    if (!pointer) throw conflict("This merchant has no current release pointer.");
    if (pointer.lockVersion !== input.expectedVersion) throw conflict("The current release changed since you loaded this page.", { releaseId: pointer.releaseId, lockVersion: pointer.lockVersion });
    if (pointer.releaseId === release.id) throw conflict("This release is already current.", { releaseId: pointer.releaseId, lockVersion: pointer.lockVersion });
    const revisionChange = merchant.activeCatalogRevisionId !== release.catalogRevisionId;
    if (revisionChange && !input.activateCatalogRevision) {
      throw conflict("This release was made from a different catalog revision than the merchant's current one. Activating it also requires making that catalog revision current.", { requiresCatalogActivation: true, lockVersion: pointer.lockVersion });
    }
    if (revisionChange) await tx.update(merchants).set({ activeCatalogRevisionId: release.catalogRevisionId, lockVersion: merchant.lockVersion + 1 }).where(eq(merchants.id, merchant.id));
    await tx.update(currentReleases).set({ releaseId: release.id, catalogRevisionId: release.catalogRevisionId, lockVersion: pointer.lockVersion + 1, updatedAt: new Date() }).where(eq(currentReleases.merchantId, release.merchantId));
    await recordAudit(tx, actor, requestId, {
      action: "release.activate",
      entityType: "mapping_release",
      entityId: release.id,
      before: { currentReleaseId: pointer.releaseId, activeCatalogRevisionId: merchant.activeCatalogRevisionId },
      after: { currentReleaseId: release.id, releaseNumber: release.releaseNumber, activeCatalogRevisionId: release.catalogRevisionId, catalogRevisionActivated: revisionChange },
      reason: input.reason,
    });
    return { releaseId: release.id, releaseNumber: release.releaseNumber, catalogRevisionActivated: revisionChange };
  });
}

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

export const EXPORT_KINDS = ["zip", "mapping", "unresolved", "metadata"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const MAPPING_HEADER = ["merchant", "catalog_revision", "merchant_sku", "title", "canonical_id", "canonical_path", "taxonomy_version", "mapping_release", "decision_origin", "reviewer", "decision_timestamp"];
export const UNRESOLVED_HEADER = ["merchant", "catalog_revision", "merchant_sku", "title", "status", "reason"];

/** Builds the three export documents for one release from its immutable records only. */
async function buildExport(tx: Tx, releaseId: string) {
  const publisher = alias(user, "publisher");
  const [release] = await tx
    .select({
      id: mappingReleases.id,
      releaseNumber: mappingReleases.releaseNumber,
      partial: mappingReleases.partial,
      reason: mappingReleases.reason,
      counts: mappingReleases.counts,
      publishedAt: mappingReleases.publishedAt,
      publishedBy: publisher.name,
      merchantId: merchants.id,
      merchantName: merchants.name,
      catalogRevisionId: catalogRevisions.id,
      revisionSequence: catalogRevisions.sequence,
      populationHash: catalogRevisions.populationHash,
      taxonomyVersionId: taxonomyVersions.id,
      taxonomySequence: taxonomyVersions.sequence,
    })
    .from(mappingReleases)
    .innerJoin(merchants, eq(merchants.id, mappingReleases.merchantId))
    .innerJoin(catalogRevisions, eq(catalogRevisions.id, mappingReleases.catalogRevisionId))
    .innerJoin(taxonomyVersions, eq(taxonomyVersions.id, mappingReleases.taxonomyVersionId))
    .innerJoin(publisher, eq(publisher.id, mappingReleases.publishedBy))
    .where(eq(mappingReleases.id, releaseId));
  if (!release) throw notFound("Release");

  const mapped = await tx.execute<{ sku: string; title: string; stable_key: string; path: string; origin: string; reviewer: string; decided_at: Date }>(sql`
    select l.merchant_sku as sku, lr.title, c.stable_key, cr.path, d.origin, u.name as reviewer, d.created_at as decided_at
    from published_mappings pm
    join listing_revisions lr on lr.id = pm.listing_revision_id
    join merchant_listings l on l.id = lr.listing_id
    join concepts c on c.id = pm.concept_id
    join concept_revisions cr on cr.taxonomy_version_id = pm.taxonomy_version_id and cr.concept_id = pm.concept_id
    join review_decisions d on d.id = pm.decision_id
    join "user" u on u.id = d.actor_id
    where pm.release_id = ${releaseId}
    order by l.merchant_sku`);
  const unresolved = await tx.execute<{ sku: string; title: string; state: ReviewState; reason: string }>(sql`
    select l.merchant_sku as sku, lr.title, ru.state, ru.reason
    from release_unresolved ru
    join listing_revisions lr on lr.id = ru.listing_revision_id
    join merchant_listings l on l.id = lr.listing_id
    where ru.release_id = ${releaseId}
    order by l.merchant_sku`);

  const revisionLabel = `Revision ${release.revisionSequence} (${release.catalogRevisionId})`;
  const versionLabel = `v${release.taxonomySequence} (${release.taxonomyVersionId})`;
  const releaseLabel = `Release ${release.releaseNumber} (${release.id})`;
  const mappingCsv = toSafeCsv(
    MAPPING_HEADER,
    mapped.rows.map((m) => [release.merchantName, revisionLabel, m.sku, m.title, m.stable_key, m.path, versionLabel, releaseLabel, m.origin, m.reviewer, new Date(m.decided_at).toISOString()]),
  );
  const unresolvedCsv = toSafeCsv(
    UNRESOLVED_HEADER,
    unresolved.rows.map((u) => [release.merchantName, revisionLabel, u.sku, u.title, STATE_LABELS[u.state], u.reason]),
  );
  const metadata = {
    release: { id: release.id, number: release.releaseNumber, partial: release.partial, reason: release.reason, publishedAt: release.publishedAt.toISOString(), publishedBy: release.publishedBy },
    merchant: { id: release.merchantId, name: release.merchantName },
    catalogRevision: { id: release.catalogRevisionId, sequence: release.revisionSequence, populationHash: release.populationHash },
    taxonomyVersion: { id: release.taxonomyVersionId, sequence: release.taxonomySequence },
    counts: release.counts,
    files: { "mappings.csv": { rows: mapped.rows.length }, "unresolved.csv": { rows: unresolved.rows.length } },
  };
  return { release, mappingCsv, unresolvedCsv, metadataJson: JSON.stringify(metadata, null, 2) + "\n", rowCounts: { mappings: mapped.rows.length, unresolved: unresolved.rows.length } };
}

/** Creates a private export object for one release and records the request in the audit log. */
export async function createExport(actor: Actor, releaseId: string, kind: ExportKind, requestId: string) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, async (tx) => {
    const built = await buildExport(tx, releaseId);
    const base = `release-${built.release.releaseNumber}`;
    const file =
      kind === "zip"
        ? { name: `${base}.zip`, type: "application/zip", ext: "zip", content: zip([{ name: "mappings.csv", content: built.mappingCsv }, { name: "unresolved.csv", content: built.unresolvedCsv }, { name: "release.json", content: built.metadataJson }]) as string | Uint8Array }
        : kind === "mapping"
          ? { name: `${base}-mappings.csv`, type: "text/csv; charset=utf-8", ext: "csv", content: built.mappingCsv }
          : kind === "unresolved"
            ? { name: `${base}-unresolved.csv`, type: "text/csv; charset=utf-8", ext: "csv", content: built.unresolvedCsv }
            : { name: `${base}.json`, type: "application/json; charset=utf-8", ext: "json", content: built.metadataJson };
    const storageKey = await objectStore().put(actor.workspaceId, "exports", file.ext, file.content);
    const [row] = await tx
      .insert(exportFiles)
      .values({ workspaceId: actor.workspaceId, releaseId, kind, fileName: file.name, storageKey, contentType: file.type, rowCounts: built.rowCounts, createdBy: actor.userId })
      .returning({ id: exportFiles.id });
    await recordAudit(tx, actor, requestId, { action: "release.export", entityType: "mapping_release", entityId: releaseId, after: { exportId: row.id, kind, fileName: file.name, rowCounts: built.rowCounts } });
    return { exportId: row.id, fileName: file.name, kind, rowCounts: built.rowCounts, downloadUrl: `/api/exports/${row.id}` };
  });
}

const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Reads a previously created export. Authorization is rechecked on every download. */
export async function readExport(actor: Actor, exportId: string) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  const [row] = await withContext(actor, (tx) => tx.select().from(exportFiles).where(and(eq(exportFiles.id, exportId))));
  if (!row) throw notFound("Export");
  if (Date.now() - row.createdAt.getTime() > EXPORT_TTL_MS) throw new ApiError("not_found", "This export has expired. Create it again from the release.");
  return { fileName: row.fileName, contentType: row.contentType, content: await objectStore().get(actor.workspaceId, row.storageKey) };
}


