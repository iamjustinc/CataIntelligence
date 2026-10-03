import { createHash } from "node:crypto";
import { basename } from "node:path";
import { and, asc, count, desc, eq, gt, gte, inArray, max, sql } from "drizzle-orm";
import { withContext, type Tx } from "@/db/client";
import { catalogRevisions, conceptRevisions, importJobs, listingRevisions, merchantListings, merchants, reviewDecisions, reviewStates, user, workspaces } from "@/db/schema";
import { ApiError, conflict, forbidden, notFound } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { CsvError, parseCsv, type ParsedCsv } from "@/lib/csv";
import { objectStore } from "@/lib/storage";
import {
  MAX_CATALOG_BYTES,
  populationHash,
  suggestColumnMap,
  validateCatalog,
  type CatalogIssue,
  type CatalogValidation,
  type ColumnMap,
  type DuplicateConflict,
  type DuplicateResolutions,
  type ListingFields,
} from "./catalog-validation";

const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const ISSUE_LIMIT = 200;
const PREVIEW_ROWS = 20;

/** Uploads allowed per user per minute (catalog and taxonomy together). */
export const uploadLimitPerMinute = () => Number(process.env.UPLOAD_RATE_LIMIT_PER_MINUTE ?? 30);

/** Database-backed so the limit holds across web processes. */
export async function assertUploadRate(tx: Tx, actor: Actor): Promise<void> {
  const since = new Date(Date.now() - 60_000);
  const [{ n }] = await tx.select({ n: count() }).from(importJobs).where(and(eq(importJobs.createdBy, actor.userId), gte(importJobs.createdAt, since)));
  if (n >= uploadLimitPerMinute()) throw new ApiError("rate_limited", "Too many uploads in the last minute. Wait a moment and try again.", { retryable: true });
}

interface StoredMapping {
  fields: ColumnMap;
  resolutions: DuplicateResolutions;
}
export interface CatalogImportSummary {
  header: string[];
  suggested: ColumnMap;
  mappingErrors: string[];
  counts: CatalogValidation["counts"];
  issueCount: number;
  issues: CatalogIssue[];
  conflicts: DuplicateConflict[];
  /** First rows that would be committed, after normalization. */
  preview: { row: number; fields: ListingFields }[];
}

function parse(text: string): ParsedCsv {
  try {
    return parseCsv(text);
  } catch (err) {
    if (err instanceof CsvError) throw new ApiError("invalid", err.message);
    throw err;
  }
}

function summarize(csv: ParsedCsv, mapping: StoredMapping): { summary: CatalogImportSummary; validation: CatalogValidation } {
  const validation = validateCatalog(csv, mapping.fields, mapping.resolutions);
  return {
    validation,
    summary: {
      header: csv.header,
      suggested: suggestColumnMap(csv.header),
      mappingErrors: validation.mappingErrors,
      counts: validation.counts,
      issueCount: validation.issues.length,
      issues: validation.issues.slice(0, ISSUE_LIMIT),
      conflicts: validation.conflicts,
      preview: validation.accepted.slice(0, PREVIEW_ROWS).map((r) => ({ row: r.row, fields: r.fields })),
    },
  };
}

type ImportRow = typeof importJobs.$inferSelect;
function toView(job: ImportRow, existing = false) {
  const mapping = (job.columnMap ?? { fields: {}, resolutions: {} }) as StoredMapping;
  return {
    id: job.id,
    merchantId: job.merchantId!,
    mode: job.mode!,
    status: job.status,
    fileName: job.fileName,
    fileHash: job.fileHash,
    columnMap: mapping.fields,
    resolutions: mapping.resolutions,
    summary: job.validationSummary as CatalogImportSummary,
    resultRevisionId: job.resultRevisionId,
    createdAt: job.createdAt,
    /** True when an earlier import of the same file, merchant and mode was returned instead of a new one. */
    existing,
  };
}
const statusFor = (v: CatalogValidation): ImportRow["status"] => (v.mappingErrors.length > 0 ? "staged" : v.counts.accepted > 0 ? "validated" : "failed");

/**
 * Stages a catalog upload: stores the file privately, suggests a column mapping and validates it.
 * Nothing is committed. Re-uploading the same file for the same merchant and mode returns the
 * earlier import unless a new revision is explicitly requested (PRD TAX04).
 */
export async function stageCatalogImport(
  actor: Actor,
  input: { merchantId: string; fileName: string; content: string; mode: "snapshot" | "delta"; createNewRevision?: boolean },
  requestId: string,
) {
  if (!can(actor.role, "catalog.import")) throw forbidden("Importing catalogs requires a taxonomist or administrator.");
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes === 0) throw new ApiError("invalid", "The file is empty.");
  if (bytes > MAX_CATALOG_BYTES) throw new ApiError("invalid", "The file is larger than the 10 MB catalog limit.");
  const csv = parse(input.content);
  const fileHash = createHash("sha256").update(input.content).digest("hex");

  return withContext(actor, async (tx) => {
    const [merchant] = await tx.select({ id: merchants.id, active: merchants.active }).from(merchants).where(eq(merchants.id, input.merchantId));
    if (!merchant) throw notFound("Merchant");
    if (!merchant.active) throw conflict("This merchant is inactive.");

    if (!input.createNewRevision) {
      const [same] = await tx
        .select()
        .from(importJobs)
        .where(and(eq(importJobs.kind, "catalog"), eq(importJobs.merchantId, input.merchantId), eq(importJobs.fileHash, fileHash), eq(importJobs.mode, input.mode), inArray(importJobs.status, ["committed", "validated", "staged"])))
        .orderBy(desc(importJobs.createdAt))
        .limit(1);
      if (same && (same.status === "committed" || Date.now() - same.createdAt.getTime() < STAGED_TTL_MS)) return toView(same, true);
    }
    await assertUploadRate(tx, actor);

    const mapping: StoredMapping = { fields: suggestColumnMap(csv.header), resolutions: {} };
    const { summary, validation } = summarize(csv, mapping);
    const stagedFileKey = await objectStore().put(actor.workspaceId, "imports", "csv", input.content);
    const [job] = await tx
      .insert(importJobs)
      .values({
        workspaceId: actor.workspaceId,
        kind: "catalog",
        merchantId: input.merchantId,
        mode: input.mode,
        status: statusFor(validation),
        fileName: basename(input.fileName).slice(0, 200) || "catalog.csv",
        stagedFileKey,
        fileHash,
        columnMap: mapping,
        validationSummary: summary,
        createdBy: actor.userId,
      })
      .returning();
    await recordAudit(tx, actor, requestId, {
      action: "catalog.import.stage",
      entityType: "import_job",
      entityId: job.id,
      after: { merchantId: input.merchantId, mode: input.mode, fileName: job.fileName, fileHash, counts: summary.counts },
    });
    return toView(job);
  });
}

async function loadCatalogJob(tx: Tx, importId: string, lock = false) {
  const q = tx.select().from(importJobs).where(and(eq(importJobs.id, importId), eq(importJobs.kind, "catalog")));
  const [job] = lock ? await q.for("update") : await q;
  if (!job) throw notFound("Import");
  return job;
}

async function readStaged(actor: Actor, job: ImportRow): Promise<ParsedCsv> {
  if (!job.stagedFileKey) throw conflict("The staged file is no longer available. Upload it again.");
  if (Date.now() - job.createdAt.getTime() > STAGED_TTL_MS) throw conflict("This staged import has expired. Upload the file again.");
  const text = (await objectStore().get(actor.workspaceId, job.stagedFileKey)).toString("utf8");
  if (createHash("sha256").update(text).digest("hex") !== job.fileHash) throw conflict("The staged file changed after upload. Upload it again.");
  return parse(text);
}

export async function getCatalogImport(actor: Actor, importId: string) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, async (tx) => toView(await loadCatalogJob(tx, importId)));
}

/** Saves the column mapping and duplicate selections, then re-validates the staged file. */
export async function updateCatalogImportMapping(actor: Actor, importId: string, input: { columnMap: ColumnMap; resolutions: DuplicateResolutions }) {
  if (!can(actor.role, "catalog.import")) throw forbidden();
  return withContext(actor, async (tx) => {
    const job = await loadCatalogJob(tx, importId, true);
    if (job.status === "committed") throw conflict("This import is already committed.");
    const csv = await readStaged(actor, job);
    const mapping: StoredMapping = { fields: input.columnMap, resolutions: input.resolutions };
    const { summary, validation } = summarize(csv, mapping);
    const [updated] = await tx.update(importJobs).set({ columnMap: mapping, validationSummary: summary, status: statusFor(validation) }).where(eq(importJobs.id, job.id)).returning();
    return toView(updated);
  });
}

const toNumeric = (v: string | null) => v;

/**
 * Commits the accepted rows as a new immutable catalog revision (PRD TAX04).
 *
 * Snapshot: the file is the whole active population; earlier SKUs that are missing become
 * inactive in the new revision. Delta: earlier active listings are carried forward and the
 * provided SKUs are inserted or updated. A listing whose classification content is unchanged
 * keeps its latest human decision, re-recorded with carried-forward provenance after the target
 * concept is checked against the active taxonomy version. Changed listings require review.
 */
export async function commitCatalogImport(actor: Actor, importId: string, options: { acceptExcluded: boolean }, requestId: string) {
  if (!can(actor.role, "catalog.import")) throw forbidden("Importing catalogs requires a taxonomist or administrator.");
  return withContext(actor, async (tx) => {
    const job = await loadCatalogJob(tx, importId, true);
    if (job.status === "committed" && job.resultRevisionId) return { revisionId: job.resultRevisionId, alreadyCommitted: true };
    // Serialise revisions per merchant.
    const [merchant] = await tx.select().from(merchants).where(eq(merchants.id, job.merchantId!)).for("update");
    if (!merchant) throw notFound("Merchant");
    const csv = await readStaged(actor, job);
    const mapping = (job.columnMap ?? { fields: {}, resolutions: {} }) as StoredMapping;
    const validation = validateCatalog(csv, mapping.fields, mapping.resolutions);
    if (validation.mappingErrors.length > 0) throw new ApiError("invalid", "Complete the column mapping before committing.", { fieldErrors: validation.mappingErrors.map((m) => ({ path: "columnMap", message: m })) });
    if (validation.counts.accepted === 0) throw new ApiError("invalid", "No valid rows to commit.");
    if (validation.counts.rejected > 0 && !options.acceptExcluded) {
      throw new ApiError("invalid", `${validation.counts.rejected} row${validation.counts.rejected === 1 ? "" : "s"} will be excluded. Confirm the exclusion to commit the valid rows.`);
    }

    const [ws] = await tx.select({ activeVersion: workspaces.activeTaxonomyVersionId }).from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    const priorRevisionId = merchant.activeCatalogRevisionId;
    const prior = priorRevisionId
      ? await tx
          .select({
            id: listingRevisions.id,
            listingId: listingRevisions.listingId,
            sku: merchantListings.merchantSku,
            title: listingRevisions.title,
            merchantCategoryPath: listingRevisions.merchantCategoryPath,
            price: listingRevisions.price,
            currency: listingRevisions.currency,
            rawJson: listingRevisions.rawJson,
            normalizedJson: listingRevisions.normalizedJson,
            contentHash: listingRevisions.contentHash,
            state: reviewStates.state,
            decisionId: reviewStates.latestDecisionId,
          })
          .from(listingRevisions)
          .innerJoin(merchantListings, eq(merchantListings.id, listingRevisions.listingId))
          .leftJoin(reviewStates, eq(reviewStates.listingRevisionId, listingRevisions.id))
          .where(and(eq(listingRevisions.catalogRevisionId, priorRevisionId), eq(listingRevisions.active, true)))
      : [];
    const priorBySku = new Map(prior.map((p) => [p.sku, p]));

    // Listing identities: one per (merchant, SKU), reused across revisions.
    const skus = validation.accepted.map((r) => r.fields.sku);
    for (let i = 0; i < skus.length; i += 500) {
      await tx.insert(merchantListings).values(skus.slice(i, i + 500).map((merchantSku) => ({ workspaceId: actor.workspaceId, merchantId: merchant.id, merchantSku }))).onConflictDoNothing();
    }
    const listingRows = await tx.select({ id: merchantListings.id, sku: merchantListings.merchantSku }).from(merchantListings).where(eq(merchantListings.merchantId, merchant.id));
    const listingIdBySku = new Map(listingRows.map((l) => [l.sku, l.id]));

    type NewListing = typeof listingRevisions.$inferInsert & { sku: string; priorId: string | null; unchanged: boolean };
    const fileSkus = new Set(skus);
    const rows: NewListing[] = validation.accepted.map((r) => {
      const before = priorBySku.get(r.fields.sku);
      return {
        workspaceId: actor.workspaceId,
        catalogRevisionId: "",
        listingId: listingIdBySku.get(r.fields.sku)!,
        title: r.fields.title,
        merchantCategoryPath: r.fields.merchantCategoryPath,
        price: toNumeric(r.fields.price),
        currency: r.fields.currency,
        rawJson: r.raw,
        normalizedJson: r.fields,
        sourceRow: r.row,
        contentHash: r.contentHash,
        carriedFromRevisionId: before && before.contentHash === r.contentHash ? before.id : null,
        active: true,
        sku: r.fields.sku,
        priorId: before?.id ?? null,
        unchanged: !!before && before.contentHash === r.contentHash,
      };
    });
    let carriedForward = 0;
    let deactivated = 0;
    for (const p of prior) {
      if (fileSkus.has(p.sku)) continue;
      const keepActive = job.mode === "delta";
      if (keepActive) carriedForward++;
      else deactivated++;
      rows.push({
        workspaceId: actor.workspaceId,
        catalogRevisionId: "",
        listingId: p.listingId,
        title: p.title,
        merchantCategoryPath: p.merchantCategoryPath,
        price: p.price,
        currency: p.currency,
        rawJson: p.rawJson,
        normalizedJson: p.normalizedJson,
        sourceRow: null,
        contentHash: p.contentHash,
        carriedFromRevisionId: p.id,
        active: keepActive,
        sku: p.sku,
        priorId: p.id,
        unchanged: true,
      });
    }

    const active = rows.filter((r) => r.active);
    const provided = rows.filter((r) => r.sourceRow !== null);
    const counts = {
      ...validation.counts,
      active: active.length,
      new: provided.filter((r) => !r.priorId).length,
      changed: provided.filter((r) => r.priorId && !r.unchanged).length,
      unchanged: provided.filter((r) => r.unchanged).length,
      carriedForward,
      deactivated,
      decisionsCarried: 0,
    };

    // Carry forward the latest human decision for unchanged listings.
    const priorDecisionIds = active.filter((r) => r.unchanged && r.priorId).map((r) => prior.find((p) => p.id === r.priorId)!.decisionId).filter((d): d is string => !!d);
    const decisions = priorDecisionIds.length ? await tx.select().from(reviewDecisions).where(inArray(reviewDecisions.id, priorDecisionIds)) : [];
    const decisionById = new Map(decisions.map((d) => [d.id, d]));
    const mappable = ws.activeVersion
      ? new Set((await tx.select({ id: conceptRevisions.conceptId }).from(conceptRevisions).where(and(eq(conceptRevisions.taxonomyVersionId, ws.activeVersion), eq(conceptRevisions.mappingAllowed, true), eq(conceptRevisions.status, "active")))).map((c) => c.id))
      : new Set<string>();
    const priorById = new Map(prior.map((p) => [p.id, p]));

    const [{ last }] = await tx.select({ last: max(catalogRevisions.sequence) }).from(catalogRevisions).where(eq(catalogRevisions.merchantId, merchant.id));
    const sequence = (last ?? 0) + 1;

    type Carry = { row: NewListing; decision: (typeof decisions)[number]; state: typeof reviewStates.$inferInsert.state };
    const carries: Carry[] = [];
    const plain: { row: NewListing; state: typeof reviewStates.$inferInsert.state }[] = [];
    for (const row of active) {
      const before = row.priorId ? priorById.get(row.priorId) : undefined;
      const decision = before?.decisionId ? decisionById.get(before.decisionId) : undefined;
      if (row.unchanged && decision && ws.activeVersion) {
        const approved = decision.action === "approve" || decision.action === "change";
        if (!approved) carries.push({ row, decision, state: before!.state ?? "needs_investigation" });
        else if (decision.selectedConceptId && mappable.has(decision.selectedConceptId) && before!.state === "approved") carries.push({ row, decision, state: "approved" });
        else plain.push({ row, state: "needs_review" });
      } else if (!row.unchanged && before?.decisionId) plain.push({ row, state: "needs_review" });
      else plain.push({ row, state: "needs_analysis" });
    }
    counts.decisionsCarried = carries.length;

    const [revision] = await tx
      .insert(catalogRevisions)
      .values({
        workspaceId: actor.workspaceId,
        merchantId: merchant.id,
        sequence,
        mode: job.mode!,
        priorRevisionId,
        importJobId: job.id,
        fileHash: job.fileHash,
        populationHash: populationHash(active.map((r) => ({ sku: r.sku, contentHash: r.contentHash }))),
        counts,
        createdBy: actor.userId,
      })
      .returning({ id: catalogRevisions.id });

    const idByListing = new Map<string, string>();
    for (let i = 0; i < rows.length; i += 400) {
      const inserted = await tx
        .insert(listingRevisions)
        .values(
          rows.slice(i, i + 400).map((r) => ({
            workspaceId: r.workspaceId,
            catalogRevisionId: revision.id,
            listingId: r.listingId,
            title: r.title,
            merchantCategoryPath: r.merchantCategoryPath,
            price: r.price,
            currency: r.currency,
            rawJson: r.rawJson,
            normalizedJson: r.normalizedJson,
            sourceRow: r.sourceRow,
            contentHash: r.contentHash,
            carriedFromRevisionId: r.carriedFromRevisionId,
            active: r.active,
          })),
        )
        .returning({ id: listingRevisions.id, listingId: listingRevisions.listingId });
      for (const r of inserted) idByListing.set(r.listingId, r.id);
    }

    const decisionIdByListingRevision = new Map<string, string>();
    for (let i = 0; i < carries.length; i += 400) {
      const inserted = await tx
        .insert(reviewDecisions)
        .values(
          carries.slice(i, i + 400).map(({ row, decision, state }) => ({
            workspaceId: actor.workspaceId,
            listingRevisionId: idByListing.get(row.listingId)!,
            taxonomyVersionId: ws.activeVersion!,
            action: state === "approved" ? ("approve" as const) : decision.action,
            origin: "carried_forward" as const,
            selectedConceptId: state === "approved" ? decision.selectedConceptId : null,
            reason: state === "approved" ? `Carried forward: listing unchanged since catalog revision ${sequence - 1}.` : (decision.reason ?? null),
            previousDecisionId: decision.id,
            // The original reviewer stays accountable; the import is recorded in the audit log.
            actorId: decision.actorId,
          })),
        )
        .returning({ id: reviewDecisions.id, listingRevisionId: reviewDecisions.listingRevisionId });
      for (const d of inserted) decisionIdByListingRevision.set(d.listingRevisionId, d.id);
    }
    const stateRows = [...carries, ...plain].map(({ row, state }) => {
      const listingRevisionId = idByListing.get(row.listingId)!;
      const latestDecisionId = decisionIdByListingRevision.get(listingRevisionId) ?? null;
      return { workspaceId: actor.workspaceId, listingRevisionId, taxonomyVersionId: latestDecisionId ? ws.activeVersion : null, state, latestDecisionId };
    });
    for (let i = 0; i < stateRows.length; i += 500) await tx.insert(reviewStates).values(stateRows.slice(i, i + 500));

    await tx.update(merchants).set({ activeCatalogRevisionId: revision.id, lockVersion: merchant.lockVersion + 1 }).where(eq(merchants.id, merchant.id));
    await tx.update(importJobs).set({ status: "committed", resultRevisionId: revision.id, committedAt: new Date() }).where(eq(importJobs.id, job.id));
    await recordAudit(tx, actor, requestId, {
      action: "catalog.revision.create",
      entityType: "catalog_revision",
      entityId: revision.id,
      before: { activeCatalogRevisionId: priorRevisionId },
      after: { merchantId: merchant.id, sequence, mode: job.mode, importJobId: job.id, counts },
    });
    return { revisionId: revision.id, alreadyCommitted: false };
  });
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

export async function listCatalogRevisions(actor: Actor, merchantId: string) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, async (tx) => {
    const [merchant] = await tx.select().from(merchants).where(eq(merchants.id, merchantId));
    if (!merchant) throw notFound("Merchant");
    const revisions = await tx
      .select({
        id: catalogRevisions.id,
        sequence: catalogRevisions.sequence,
        mode: catalogRevisions.mode,
        counts: catalogRevisions.counts,
        fileName: importJobs.fileName,
        createdAt: catalogRevisions.createdAt,
        createdByName: user.name,
      })
      .from(catalogRevisions)
      .leftJoin(importJobs, eq(importJobs.id, catalogRevisions.importJobId))
      .innerJoin(user, eq(user.id, catalogRevisions.createdBy))
      .where(eq(catalogRevisions.merchantId, merchantId))
      .orderBy(desc(catalogRevisions.sequence));
    return { merchant, revisions };
  });
}

/** Paginated listing population of one catalog revision, ordered by SKU with a stable cursor. */
export async function listCatalogListings(actor: Actor, revisionId: string, options: { cursor?: string | null; limit?: number; includeInactive?: boolean }) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return withContext(actor, async (tx) => {
    const [revision] = await tx.select({ id: catalogRevisions.id, sequence: catalogRevisions.sequence, merchantId: catalogRevisions.merchantId }).from(catalogRevisions).where(eq(catalogRevisions.id, revisionId));
    if (!revision) throw notFound("Catalog revision");
    const rows = await tx
      .select({
        id: listingRevisions.id,
        sku: merchantListings.merchantSku,
        title: listingRevisions.title,
        merchantCategoryPath: listingRevisions.merchantCategoryPath,
        price: listingRevisions.price,
        currency: listingRevisions.currency,
        active: listingRevisions.active,
        sourceRow: listingRevisions.sourceRow,
        state: reviewStates.state,
      })
      .from(listingRevisions)
      .innerJoin(merchantListings, eq(merchantListings.id, listingRevisions.listingId))
      .leftJoin(reviewStates, eq(reviewStates.listingRevisionId, listingRevisions.id))
      .where(and(eq(listingRevisions.catalogRevisionId, revisionId), options.includeInactive ? undefined : eq(listingRevisions.active, true), options.cursor ? gt(merchantListings.merchantSku, options.cursor) : undefined))
      .orderBy(asc(merchantListings.merchantSku))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return { revision, items: page, nextCursor: rows.length > limit ? page[page.length - 1].sku : null };
  });
}

/** Active and inactive listing counts of a revision, from the stored rows. */
export async function revisionPopulation(tx: Tx, revisionId: string) {
  const [row] = await tx
    .select({ active: sql<number>`count(*) filter (where ${listingRevisions.active})::int`, inactive: sql<number>`count(*) filter (where not ${listingRevisions.active})::int` })
    .from(listingRevisions)
    .where(eq(listingRevisions.catalogRevisionId, revisionId));
  return row;
}
