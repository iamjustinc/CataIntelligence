import { createHash } from "node:crypto";
import { basename } from "node:path";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withContext, type Tx } from "@/db/client";
import { conceptRevisions, concepts, currentReleases, importJobs, publishedMappings, taxonomyProposals, taxonomyVersions, user, workspaces } from "@/db/schema";
import { ApiError, conflict, forbidden, notFound } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { CsvError, parseCsv } from "@/lib/csv";
import { objectStore } from "@/lib/storage";
import { assertUploadRate } from "./catalog-import";
import { readTaxonomyCsv, validateTaxonomy, type ConceptInput, type TaxonomyIssue, type TaxonomyValidation } from "./taxonomy-validation";

export const MAX_TAXONOMY_BYTES = 2 * 1024 * 1024;
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const ISSUE_LIMIT = 200;

export interface TaxonomyDiff {
  baseVersionId: string | null;
  baseSequence: number | null;
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  /** Stable keys present in the base version but absent from the file (first 50). */
  removedKeys: string[];
}

export interface TaxonomyImportSummary {
  counts: TaxonomyValidation["counts"];
  errorCount: number;
  warningCount: number;
  errors: TaxonomyIssue[];
  warnings: TaxonomyIssue[];
  diff: TaxonomyDiff;
}

function validateCsvText(text: string): TaxonomyValidation {
  let csv;
  try {
    csv = parseCsv(text);
  } catch (err) {
    if (err instanceof CsvError) throw new ApiError("invalid", err.message);
    throw err;
  }
  const { inputs, errors } = readTaxonomyCsv(csv);
  return validateTaxonomy(inputs, errors);
}

/** Concept revisions of one version as validator inputs (parent expressed by stable key). */
async function loadConceptInputs(tx: Tx, versionId: string): Promise<ConceptInput[]> {
  const parent = alias(concepts, "parent");
  const rows = await tx
    .select({
      stableKey: concepts.stableKey,
      parentKey: parent.stableKey,
      name: conceptRevisions.name,
      definition: conceptRevisions.definition,
      synonyms: conceptRevisions.synonyms,
      status: conceptRevisions.status,
      mappingAllowed: conceptRevisions.mappingAllowed,
    })
    .from(conceptRevisions)
    .innerJoin(concepts, eq(concepts.id, conceptRevisions.conceptId))
    .leftJoin(parent, eq(parent.id, conceptRevisions.parentConceptId))
    .where(eq(conceptRevisions.taxonomyVersionId, versionId))
    .orderBy(conceptRevisions.path);
  return rows.map((r, i) => ({ ...r, row: i + 1 }));
}

function diffAgainst(base: ConceptInput[], next: ConceptInput[], baseVersion: { id: string; sequence: number } | null): TaxonomyDiff {
  const before = new Map(base.map((c) => [c.stableKey, c]));
  const after = new Set(next.map((c) => c.stableKey));
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const c of next) {
    const b = before.get(c.stableKey);
    if (!b) added++;
    else if (
      b.parentKey !== c.parentKey ||
      b.name !== c.name ||
      b.definition !== c.definition ||
      b.status !== c.status ||
      b.mappingAllowed !== c.mappingAllowed ||
      JSON.stringify(b.synonyms) !== JSON.stringify(c.synonyms)
    )
      changed++;
    else unchanged++;
  }
  const removedKeys = base.filter((c) => !after.has(c.stableKey)).map((c) => c.stableKey);
  return { baseVersionId: baseVersion?.id ?? null, baseSequence: baseVersion?.sequence ?? null, added, changed, removed: removedKeys.length, unchanged, removedKeys: removedKeys.slice(0, 50) };
}

async function activeVersion(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select({ id: taxonomyVersions.id, sequence: taxonomyVersions.sequence })
    .from(workspaces)
    .innerJoin(taxonomyVersions, eq(taxonomyVersions.id, workspaces.activeTaxonomyVersionId))
    .where(eq(workspaces.id, workspaceId));
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------
// Import: stage, inspect, commit
// ---------------------------------------------------------------------------------------------

/** Validates a taxonomy CSV and stages it. Nothing is written to the taxonomy until commit. */
export async function stageTaxonomyImport(actor: Actor, input: { fileName: string; content: string }, requestId: string) {
  if (!can(actor.role, "taxonomy.manage")) throw forbidden("Only administrators can import a taxonomy.");
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes === 0) throw new ApiError("invalid", "The file is empty.");
  if (bytes > MAX_TAXONOMY_BYTES) throw new ApiError("invalid", "The file is larger than the 2 MB taxonomy limit.");
  const validation = validateCsvText(input.content);
  const fileHash = createHash("sha256").update(input.content).digest("hex");
  const stagedFileKey = await objectStore().put(actor.workspaceId, "imports", "csv", input.content);

  return withContext(actor, async (tx) => {
    await assertUploadRate(tx, actor);
    const base = await activeVersion(tx, actor.workspaceId);
    const baseInputs = base ? await loadConceptInputs(tx, base.id) : [];
    const parsedInputs = validation.errors.length === 0 ? validation.concepts : [];
    const summary: TaxonomyImportSummary = {
      counts: validation.counts,
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
      errors: validation.errors.slice(0, ISSUE_LIMIT),
      warnings: validation.warnings.slice(0, ISSUE_LIMIT),
      diff: diffAgainst(baseInputs, parsedInputs, base),
    };
    const [job] = await tx
      .insert(importJobs)
      .values({
        workspaceId: actor.workspaceId,
        kind: "taxonomy",
        status: validation.errors.length === 0 ? "validated" : "failed",
        // The display name is data only; storage paths are generated by the server.
        fileName: basename(input.fileName).slice(0, 200) || "taxonomy.csv",
        stagedFileKey,
        fileHash,
        validationSummary: summary,
        createdBy: actor.userId,
      })
      .returning();
    await recordAudit(tx, actor, requestId, {
      action: "taxonomy.import.stage",
      entityType: "import_job",
      entityId: job.id,
      after: { fileName: job.fileName, fileHash, status: job.status, counts: summary.counts, errorCount: summary.errorCount },
    });
    return toImportView(job);
  });
}

type ImportRow = typeof importJobs.$inferSelect;
function toImportView(job: ImportRow) {
  return {
    id: job.id,
    status: job.status,
    fileName: job.fileName,
    fileHash: job.fileHash,
    createdAt: job.createdAt,
    committedAt: job.committedAt,
    resultVersionId: job.resultRevisionId,
    summary: job.validationSummary as TaxonomyImportSummary,
  };
}

export async function getTaxonomyImport(actor: Actor, importId: string) {
  if (!can(actor.role, "taxonomy.manage")) throw forbidden();
  const [job] = await withContext(actor, (tx) => tx.select().from(importJobs).where(and(eq(importJobs.id, importId), eq(importJobs.kind, "taxonomy"))));
  if (!job) throw notFound("Import");
  return toImportView(job);
}

/**
 * Creates (or, when explicitly requested, replaces) the workspace's draft taxonomy version from a
 * validated import. Never touches a published version. Committing the same import twice returns
 * the version created the first time.
 */
export async function commitTaxonomyImport(actor: Actor, importId: string, options: { replaceDraft: boolean }, requestId: string) {
  if (!can(actor.role, "taxonomy.manage")) throw forbidden("Only administrators can change the taxonomy.");
  return withContext(actor, async (tx) => {
    // Serialise taxonomy draft changes per workspace (PRD section 11).
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, actor.workspaceId)).for("update");
    const [job] = await tx.select().from(importJobs).where(and(eq(importJobs.id, importId), eq(importJobs.kind, "taxonomy"))).for("update");
    if (!job) throw notFound("Import");
    if (job.status === "committed" && job.resultRevisionId) return { versionId: job.resultRevisionId, alreadyCommitted: true };
    if (job.status !== "validated" || !job.stagedFileKey) throw new ApiError("invalid", "This import has blocking errors and cannot be committed. Fix the file and upload it again.");
    if (Date.now() - job.createdAt.getTime() > STAGED_TTL_MS) throw conflict("This staged import has expired. Upload the file again.");

    const text = (await objectStore().get(actor.workspaceId, job.stagedFileKey)).toString("utf8");
    if (createHash("sha256").update(text).digest("hex") !== job.fileHash) throw conflict("The staged file changed after validation. Upload it again.");
    const validation = validateCsvText(text);
    if (validation.errors.length > 0) throw new ApiError("invalid", "The staged file no longer passes validation. Upload it again.");

    const base = await activeVersion(tx, actor.workspaceId);
    const [draft] = await tx.select().from(taxonomyVersions).where(eq(taxonomyVersions.state, "draft")).for("update");
    let versionId: string;
    let sequence: number;
    if (draft) {
      if (!options.replaceDraft) {
        throw conflict(`Draft version ${draft.sequence} already exists. Replace it explicitly, publish it or discard it first.`, { draftVersionId: draft.id, sequence: draft.sequence });
      }
      await tx.delete(conceptRevisions).where(eq(conceptRevisions.taxonomyVersionId, draft.id));
      await tx.update(taxonomyVersions).set({ lockVersion: draft.lockVersion + 1, note: `Imported from ${job.fileName}`, baseVersionId: base?.id ?? null }).where(eq(taxonomyVersions.id, draft.id));
      versionId = draft.id;
      sequence = draft.sequence;
    } else {
      const [{ last }] = await tx.select({ last: max(taxonomyVersions.sequence) }).from(taxonomyVersions);
      sequence = (last ?? 0) + 1;
      const [created] = await tx
        .insert(taxonomyVersions)
        .values({ workspaceId: actor.workspaceId, sequence, baseVersionId: base?.id ?? null, note: `Imported from ${job.fileName}`, createdBy: actor.userId })
        .returning({ id: taxonomyVersions.id });
      versionId = created.id;
    }

    // Stable keys keep the same concept identity across versions and are never recycled.
    const keys = validation.concepts.map((c) => c.stableKey);
    for (let i = 0; i < keys.length; i += 500) {
      await tx.insert(concepts).values(keys.slice(i, i + 500).map((stableKey) => ({ workspaceId: actor.workspaceId, stableKey }))).onConflictDoNothing();
    }
    const idRows = await tx.select({ id: concepts.id, stableKey: concepts.stableKey }).from(concepts).where(inArray(concepts.stableKey, keys));
    const idOf = new Map(idRows.map((r) => [r.stableKey, r.id]));
    const rows = validation.concepts.map((c) => ({
      workspaceId: actor.workspaceId,
      taxonomyVersionId: versionId,
      conceptId: idOf.get(c.stableKey)!,
      parentConceptId: c.parentKey ? idOf.get(c.parentKey)! : null,
      name: c.name,
      definition: c.definition,
      synonyms: c.synonyms,
      status: c.status,
      mappingAllowed: c.mappingAllowed,
      path: c.path,
      depth: c.depth,
    }));
    for (let i = 0; i < rows.length; i += 500) await tx.insert(conceptRevisions).values(rows.slice(i, i + 500));

    await tx.update(importJobs).set({ status: "committed", resultRevisionId: versionId, committedAt: new Date() }).where(eq(importJobs.id, job.id));
    await recordAudit(tx, actor, requestId, {
      action: draft ? "taxonomy.draft.replace" : "taxonomy.draft.create",
      entityType: "taxonomy_version",
      entityId: versionId,
      before: draft ? { lockVersion: draft.lockVersion } : null,
      after: { sequence, importJobId: job.id, fileHash: job.fileHash, concepts: rows.length, baseVersionId: base?.id ?? null },
    });
    return { versionId, alreadyCommitted: false };
  });
}

// ---------------------------------------------------------------------------------------------
// Publish and discard
// ---------------------------------------------------------------------------------------------

async function lockDraft(tx: Tx, actor: Actor, versionId: string, expectedVersion: number) {
  await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, actor.workspaceId)).for("update");
  const [version] = await tx.select().from(taxonomyVersions).where(eq(taxonomyVersions.id, versionId)).for("update");
  if (!version) throw notFound("Taxonomy version");
  const current = { state: version.state, lockVersion: version.lockVersion };
  if (version.state !== "draft") throw conflict(`Version ${version.sequence} is already ${version.state}.`, current);
  if (version.lockVersion !== expectedVersion) throw conflict("This draft changed since you loaded it. Review the latest draft before continuing.", current);
  return version;
}

/**
 * Publishes a draft as an immutable taxonomy version and makes it the workspace's active version
 * in one transaction. The stored tree is validated again; an invalid tree cannot be published.
 */
export async function publishTaxonomyVersion(actor: Actor, versionId: string, expectedVersion: number, requestId: string) {
  if (!can(actor.role, "taxonomy.manage")) throw forbidden("Only administrators can publish a taxonomy version.");
  return withContext(actor, async (tx) => {
    const version = await lockDraft(tx, actor, versionId, expectedVersion);
    const validation = validateTaxonomy(await loadConceptInputs(tx, versionId));
    if (validation.errors.length > 0) {
      throw new ApiError("invalid", `The draft has ${validation.errors.length} structural error${validation.errors.length === 1 ? "" : "s"} and cannot be published.`, {
        fieldErrors: validation.errors.slice(0, 20).map((e) => ({ path: e.conceptId ?? "taxonomy", message: e.message })),
      });
    }
    if (validation.counts.mappable === 0) throw new ApiError("invalid", "The draft has no concept that accepts mappings.");

    const previous = await activeVersion(tx, actor.workspaceId);
    const publishedAt = new Date();
    await tx
      .update(taxonomyVersions)
      .set({ state: "published", publishedBy: actor.userId, publishedAt, lockVersion: version.lockVersion + 1 })
      .where(eq(taxonomyVersions.id, versionId));
    await tx.update(workspaces).set({ activeTaxonomyVersionId: versionId }).where(eq(workspaces.id, actor.workspaceId));
    await recordAudit(tx, actor, requestId, {
      action: "taxonomy.publish",
      entityType: "taxonomy_version",
      entityId: versionId,
      before: { activeVersionId: previous?.id ?? null, activeSequence: previous?.sequence ?? null },
      after: { activeVersionId: versionId, sequence: version.sequence, concepts: validation.counts.concepts, mappable: validation.counts.mappable },
    });
    return { versionId, sequence: version.sequence, state: "published" as const, publishedAt };
  });
}

export async function discardTaxonomyDraft(actor: Actor, versionId: string, expectedVersion: number, requestId: string) {
  if (!can(actor.role, "taxonomy.manage")) throw forbidden("Only administrators can discard a taxonomy draft.");
  return withContext(actor, async (tx) => {
    const version = await lockDraft(tx, actor, versionId, expectedVersion);
    await tx.update(taxonomyVersions).set({ state: "discarded", lockVersion: version.lockVersion + 1 }).where(eq(taxonomyVersions.id, versionId));
    await recordAudit(tx, actor, requestId, { action: "taxonomy.draft.discard", entityType: "taxonomy_version", entityId: versionId, before: { state: "draft" }, after: { state: "discarded" } });
    return { versionId, sequence: version.sequence, state: "discarded" as const };
  });
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

/** Drafts and discarded versions are visible to roles that can change or propose taxonomy. */
const canSeeUnpublished = (actor: Actor) => can(actor.role, "taxonomy.propose");

export async function listTaxonomyVersions(actor: Actor) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, async (tx) => {
    const publisher = alias(user, "publisher");
    const rows = await tx
      .select({
        id: taxonomyVersions.id,
        sequence: taxonomyVersions.sequence,
        state: taxonomyVersions.state,
        note: taxonomyVersions.note,
        lockVersion: taxonomyVersions.lockVersion,
        createdAt: taxonomyVersions.createdAt,
        publishedAt: taxonomyVersions.publishedAt,
        publishedByName: publisher.name,
        concepts: sql<number>`(select count(*)::int from concept_revisions cr where cr.taxonomy_version_id = ${taxonomyVersions.id})`,
      })
      .from(taxonomyVersions)
      .leftJoin(publisher, eq(publisher.id, taxonomyVersions.publishedBy))
      .orderBy(desc(taxonomyVersions.sequence));
    const active = await activeVersion(tx, actor.workspaceId);
    const visible = canSeeUnpublished(actor) ? rows.filter((v) => v.state !== "discarded") : rows.filter((v) => v.state === "published");
    return { activeVersionId: active?.id ?? null, versions: visible };
  });
}

export interface ConceptNode {
  conceptId: string;
  stableKey: string;
  parentConceptId: string | null;
  name: string;
  definition: string;
  synonyms: string[];
  status: "active" | "inactive";
  mappingAllowed: boolean;
  path: string;
  depth: number;
  /** Listings mapped to this concept in merchants' current releases. */
  publishedListings: number;
  pendingProposals: number;
}

/**
 * Returns one version's concepts. With `query`, only concepts whose name, path, definition,
 * synonyms or stable ID match are returned; IDs are the same stable concept IDs used by mapping.
 */
export async function getTaxonomyVersion(actor: Actor, versionId: string, query?: string | null) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, async (tx) => {
    const [version] = await tx.select().from(taxonomyVersions).where(eq(taxonomyVersions.id, versionId));
    // Unpublished versions are reported as absent to roles that may not see them.
    if (!version || (version.state !== "published" && !canSeeUnpublished(actor))) throw notFound("Taxonomy version");

    const q = query?.trim();
    const pattern = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const rows = await tx
      .select({
        conceptId: conceptRevisions.conceptId,
        stableKey: concepts.stableKey,
        parentConceptId: conceptRevisions.parentConceptId,
        name: conceptRevisions.name,
        definition: conceptRevisions.definition,
        synonyms: conceptRevisions.synonyms,
        status: conceptRevisions.status,
        mappingAllowed: conceptRevisions.mappingAllowed,
        path: conceptRevisions.path,
        depth: conceptRevisions.depth,
      })
      .from(conceptRevisions)
      .innerJoin(concepts, eq(concepts.id, conceptRevisions.conceptId))
      .where(
        and(
          eq(conceptRevisions.taxonomyVersionId, versionId),
          pattern
            ? sql`(${conceptRevisions.path} ilike ${pattern} or ${conceptRevisions.definition} ilike ${pattern} or ${conceptRevisions.synonyms}::text ilike ${pattern} or ${concepts.stableKey} ilike ${pattern})`
            : undefined,
        ),
      )
      .orderBy(conceptRevisions.path);

    const mapped = await tx
      .select({ conceptId: publishedMappings.conceptId, n: sql<number>`count(*)::int` })
      .from(publishedMappings)
      .innerJoin(currentReleases, eq(currentReleases.releaseId, publishedMappings.releaseId))
      .groupBy(publishedMappings.conceptId);
    const proposals = await tx
      .select({ conceptId: sql<string>`${taxonomyProposals.payload}->>'conceptId'`, n: sql<number>`count(*)::int` })
      .from(taxonomyProposals)
      .where(eq(taxonomyProposals.state, "submitted"))
      .groupBy(sql`${taxonomyProposals.payload}->>'conceptId'`);
    const mappedBy = new Map(mapped.map((m) => [m.conceptId, m.n]));
    const proposalsBy = new Map(proposals.map((p) => [p.conceptId, p.n]));

    const nodes: ConceptNode[] = rows.map((r) => ({ ...r, publishedListings: mappedBy.get(r.conceptId) ?? 0, pendingProposals: proposalsBy.get(r.conceptId) ?? 0 }));
    return {
      version: { id: version.id, sequence: version.sequence, state: version.state, lockVersion: version.lockVersion, note: version.note, publishedAt: version.publishedAt, createdAt: version.createdAt },
      concepts: nodes,
    };
  });
}
