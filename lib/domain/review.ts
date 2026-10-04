import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { withContext, type Tx } from "@/db/client";
import { catalogRevisions, conceptRevisions, concepts, listingRevisions, merchantListings, merchants, recommendations, reviewDecisions, reviewStates, taxonomyVersions, user, workspaces } from "@/db/schema";
import { ApiError, conflict, forbidden, notFound } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import type { Candidate } from "@/lib/retrieval/candidates";
import { REVIEW_STATES, SIGNAL_BANDS, type ReviewState, type SignalBand } from "@/lib/review-labels";
import { buildRequest, loadVersionIndex } from "./analysis";
import type { ListingFields } from "./catalog-validation";

export const REVIEW_SORTS = ["age", "merchant", "signal"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

export interface ReviewFilters {
  merchantId?: string | null;
  /** Defaults to each merchant's current catalog revision. */
  revisionId?: string | null;
  state?: ReviewState | "unresolved" | null;
  band?: SignalBand | null;
  /** Canonical concept ID: matches listings proposed or decided under this concept or its descendants. */
  conceptId?: string | null;
  warning?: boolean;
  q?: string | null;
  sort?: ReviewSort;
  cursor?: string | null;
  limit?: number;
}

const SORT_KEY: Record<ReviewSort, SQL> = {
  // Oldest unresolved first: revision time, then source order.
  age: sql`to_char(lr.created_at at time zone 'utc', 'YYYYMMDDHH24MISSUS') || lpad(coalesce(lr.source_row, 0)::text, 7, '0')`,
  merchant: sql`lower(m.name) || chr(1) || lower(lr.title)`,
  signal: sql`(case rec.signal_band when 'high' then '0' when 'medium' then '1' when 'low' then '2' when 'none' then '3' else '4' end) || lpad(coalesce(lr.source_row, 0)::text, 7, '0')`,
};

const encodeCursor = (key: string, id: string) => Buffer.from(JSON.stringify([key, id])).toString("base64url");
function decodeCursor(cursor: string): [string, string] {
  try {
    const [key, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof key === "string" && /^[0-9a-f-]{36}$/i.test(id)) return [key, id];
  } catch {
    /* fall through */
  }
  throw new ApiError("bad_request", "Invalid cursor.");
}

export interface ReviewQueueItem {
  id: string;
  sku: string;
  title: string;
  merchantCategoryPath: string | null;
  merchantId: string;
  merchantName: string;
  state: ReviewState;
  lockVersion: number;
  band: SignalBand | null;
  isDemo: boolean | null;
  warningCount: number;
  proposedPath: string | null;
  /** True when the proposed path comes from a human decision rather than a suggestion. */
  decided: boolean;
  recommendationStale: boolean;
}

function scopeConditions(f: ReviewFilters): SQL[] {
  const where: SQL[] = [sql`lr.active`];
  where.push(f.revisionId ? sql`cr.id = ${f.revisionId}` : sql`m.active_catalog_revision_id = cr.id`);
  if (f.merchantId) where.push(sql`m.id = ${f.merchantId}`);
  return where;
}

/** Filtered, keyset-paginated review queue (PRD TAX08). */
export async function listReviewItems(actor: Actor, f: ReviewFilters) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
  const sort = f.sort ?? "age";
  const key = SORT_KEY[sort];
  return withContext(actor, async (tx) => {
    const [ws] = await tx.select({ active: workspaces.activeTaxonomyVersionId }).from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    const scope = scopeConditions(f);
    const where = [...scope];
    if (f.state === "unresolved") where.push(sql`rs.state <> 'approved'`);
    else if (f.state) where.push(sql`rs.state = ${f.state}`);
    if (f.band) where.push(sql`rec.signal_band = ${f.band}`);
    if (f.warning) where.push(sql`(rs.ambiguous or jsonb_array_length(coalesce(rec.warnings, '[]'::jsonb)) + jsonb_array_length(coalesce(rec.ambiguity_flags, '[]'::jsonb)) + jsonb_array_length(coalesce(rec.missing_information, '[]'::jsonb)) > 0)`);
    if (f.q?.trim()) {
      const pattern = `%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(sql`(lr.title ilike ${pattern} or l.merchant_sku ilike ${pattern})`);
    }
    if (f.conceptId) {
      const [concept] = ws.active ? await tx.select({ path: conceptRevisions.path }).from(conceptRevisions).where(and(eq(conceptRevisions.taxonomyVersionId, ws.active), eq(conceptRevisions.conceptId, f.conceptId))) : [];
      if (!concept) where.push(sql`false`);
      else where.push(sql`(coalesce(dc.path, rc.path) = ${concept.path} or starts_with(coalesce(dc.path, rc.path), ${concept.path + " > "}))`);
    }
    if (f.cursor) {
      const [k, id] = decodeCursor(f.cursor);
      where.push(sql`(${key}, lr.id) > (${k}, ${id}::uuid)`);
    }
    const from = sql`
      from review_states rs
      join listing_revisions lr on lr.id = rs.listing_revision_id
      join catalog_revisions cr on cr.id = lr.catalog_revision_id
      join merchants m on m.id = cr.merchant_id
      join merchant_listings l on l.id = lr.listing_id
      left join recommendations rec on rec.id = rs.latest_recommendation_id
      left join review_decisions d on d.id = rs.latest_decision_id
      left join concept_revisions dc on dc.concept_id = d.selected_concept_id and dc.taxonomy_version_id = d.taxonomy_version_id
      left join concept_revisions rc on rc.concept_id = rec.selected_concept_id and rc.taxonomy_version_id = rec.taxonomy_version_id`;
    const result = await tx.execute<Record<string, unknown>>(sql`
      select lr.id, l.merchant_sku as sku, lr.title, lr.merchant_category_path, m.id as merchant_id, m.name as merchant_name,
             rs.state, rs.lock_version, rec.signal_band, rec.is_demo, rec.taxonomy_version_id as rec_version,
             (rs.ambiguous::int + jsonb_array_length(coalesce(rec.warnings, '[]'::jsonb)) + jsonb_array_length(coalesce(rec.missing_information, '[]'::jsonb))) as warning_count,
             coalesce(dc.path, rc.path) as proposed_path, (dc.path is not null) as decided, ${key} as sort_key
      ${from}
      where ${sql.join(where, sql` and `)}
      order by ${key}, lr.id
      limit ${limit + 1}`);
    const rows = result.rows;
    const page = rows.slice(0, limit);
    const items: ReviewQueueItem[] = page.map((r) => ({
      id: r.id as string,
      sku: r.sku as string,
      title: r.title as string,
      merchantCategoryPath: r.merchant_category_path as string | null,
      merchantId: r.merchant_id as string,
      merchantName: r.merchant_name as string,
      state: r.state as ReviewState,
      lockVersion: r.lock_version as number,
      band: (r.signal_band as SignalBand | null) ?? null,
      isDemo: r.is_demo as boolean | null,
      warningCount: Number(r.warning_count ?? 0),
      proposedPath: r.proposed_path as string | null,
      decided: r.decided as boolean,
      recommendationStale: !!r.rec_version && r.rec_version !== ws.active,
    }));
    const last = page[page.length - 1];

    // Live progress for the same merchant/revision scope, independent of the other filters.
    const totals = await tx.execute<{ state: ReviewState; n: number }>(sql`
      select rs.state, count(*)::int as n
      from review_states rs
      join listing_revisions lr on lr.id = rs.listing_revision_id
      join catalog_revisions cr on cr.id = lr.catalog_revision_id
      join merchants m on m.id = cr.merchant_id
      where ${sql.join(scope, sql` and `)}
      group by rs.state`);
    const byState = Object.fromEntries(REVIEW_STATES.map((s) => [s, 0])) as Record<ReviewState, number>;
    for (const t of totals.rows) byState[t.state] = t.n;
    const total = Object.values(byState).reduce((a, b) => a + b, 0);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor(last.sort_key as string, last.id as string) : null,
      progress: { total, approved: byState.approved, remaining: total - byState.approved, byState },
      activeTaxonomyVersionId: ws.active,
    };
  });
}

export function parseReviewFilters(get: (key: string) => string | null | undefined): ReviewFilters {
  const uuid = (v: string | null | undefined) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  const state = get("state");
  const band = get("band");
  const sort = get("sort");
  return {
    merchantId: uuid(get("merchant")),
    revisionId: uuid(get("revision")),
    state: state === "unresolved" || (REVIEW_STATES as readonly string[]).includes(state ?? "") ? (state as ReviewFilters["state"]) : null,
    band: (SIGNAL_BANDS as readonly string[]).includes(band ?? "") ? (band as SignalBand) : null,
    conceptId: uuid(get("concept")),
    warning: get("warning") === "1",
    q: get("q")?.slice(0, 200) ?? null,
    sort: (REVIEW_SORTS as readonly string[]).includes(sort ?? "") ? (sort as ReviewSort) : "age",
    cursor: get("cursor") ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Item detail
// ---------------------------------------------------------------------------------------------

export async function getReviewItem(actor: Actor, listingRevisionId: string) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, async (tx) => {
    const [row] = await tx
      .select({
        id: listingRevisions.id,
        sku: merchantListings.merchantSku,
        title: listingRevisions.title,
        raw: listingRevisions.rawJson,
        fields: listingRevisions.normalizedJson,
        contentHash: listingRevisions.contentHash,
        sourceRow: listingRevisions.sourceRow,
        active: listingRevisions.active,
        revisionId: catalogRevisions.id,
        revisionSequence: catalogRevisions.sequence,
        merchantId: merchants.id,
        merchantName: merchants.name,
        currentRevisionId: merchants.activeCatalogRevisionId,
        state: reviewStates.state,
        lockVersion: reviewStates.lockVersion,
        ambiguous: reviewStates.ambiguous,
        stateVersionId: reviewStates.taxonomyVersionId,
        recommendationId: reviewStates.latestRecommendationId,
      })
      .from(listingRevisions)
      .innerJoin(merchantListings, eq(merchantListings.id, listingRevisions.listingId))
      .innerJoin(catalogRevisions, eq(catalogRevisions.id, listingRevisions.catalogRevisionId))
      .innerJoin(merchants, eq(merchants.id, catalogRevisions.merchantId))
      .innerJoin(reviewStates, eq(reviewStates.listingRevisionId, listingRevisions.id))
      .where(eq(listingRevisions.id, listingRevisionId));
    if (!row) throw notFound("Listing");
    const [ws] = await tx.select({ active: workspaces.activeTaxonomyVersionId, highEnabled: workspaces.highSignalEnabled }).from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    const fields = row.fields as ListingFields;

    const [rec] = row.recommendationId ? await tx.select().from(recommendations).where(eq(recommendations.id, row.recommendationId)) : [];
    const history = await tx
      .select({
        id: reviewDecisions.id,
        action: reviewDecisions.action,
        origin: reviewDecisions.origin,
        reason: reviewDecisions.reason,
        createdAt: reviewDecisions.createdAt,
        actorName: user.name,
        conceptId: reviewDecisions.selectedConceptId,
        conceptPath: conceptRevisions.path,
        taxonomyVersionId: reviewDecisions.taxonomyVersionId,
      })
      .from(reviewDecisions)
      .innerJoin(user, eq(user.id, reviewDecisions.actorId))
      .leftJoin(conceptRevisions, and(eq(conceptRevisions.conceptId, reviewDecisions.selectedConceptId), eq(conceptRevisions.taxonomyVersionId, reviewDecisions.taxonomyVersionId)))
      .where(eq(reviewDecisions.listingRevisionId, listingRevisionId))
      .orderBy(asc(reviewDecisions.createdAt), asc(reviewDecisions.id));

    // Plain text matches against the active version. These are a search aid for manual mapping,
    // not a recommendation, and are shown as such.
    let textMatches: Candidate[] = [];
    if (ws.active) textMatches = buildRequest(actor.workspaceId, { id: row.id, contentHash: row.contentHash, fields }, await loadVersionIndex(tx, ws.active)).candidates;

    // Every recommendation ever made for this listing revision stays stored and inspectable.
    const recommendationHistory = await tx
      .select({
        id: recommendations.id,
        createdAt: recommendations.createdAt,
        provider: recommendations.provider,
        isDemo: recommendations.isDemo,
        modelId: recommendations.modelId,
        band: recommendations.signalBand,
        explanation: recommendations.explanation,
        taxonomyVersionId: recommendations.taxonomyVersionId,
        taxonomySequence: taxonomyVersions.sequence,
        selectedPath: conceptRevisions.path,
      })
      .from(recommendations)
      .innerJoin(taxonomyVersions, eq(taxonomyVersions.id, recommendations.taxonomyVersionId))
      .leftJoin(conceptRevisions, and(eq(conceptRevisions.conceptId, recommendations.selectedConceptId), eq(conceptRevisions.taxonomyVersionId, recommendations.taxonomyVersionId)))
      .where(eq(recommendations.listingRevisionId, listingRevisionId))
      .orderBy(desc(recommendations.createdAt), desc(recommendations.id));

    const stale = !!rec && rec.taxonomyVersionId !== ws.active;
    return {
      listing: { id: row.id, sku: row.sku, title: row.title, sourceRow: row.sourceRow, fields, raw: row.raw as Record<string, string>, active: row.active },
      merchant: { id: row.merchantId, name: row.merchantName },
      revision: { id: row.revisionId, sequence: row.revisionSequence, current: row.revisionId === row.currentRevisionId },
      review: { state: row.state, lockVersion: row.lockVersion, ambiguous: row.ambiguous, taxonomyVersionId: row.stateVersionId },
      activeTaxonomyVersionId: ws.active,
      recommendation: rec
        ? {
            id: rec.id,
            provider: rec.provider,
            modelId: rec.modelId,
            isDemo: rec.isDemo,
            band: rec.signalBand,
            basis: rec.signalBasis,
            policyVersion: rec.policyVersion,
            stale,
            selectedConceptId: rec.selectedConceptId,
            candidates: rec.candidates as Candidate[],
            alternatives: rec.alternatives as { conceptId: string; reason: string }[],
            evidence: rec.evidence as { field: string; excerpt: string; supportsConceptId: string }[],
            explanation: rec.explanation,
            warnings: rec.warnings as string[],
            ambiguityFlags: rec.ambiguityFlags as string[],
            missingInformation: rec.missingInformation as string[],
            proposedConcept: rec.proposedConcept as { name: string; parentConceptId: string | null; rationale: string } | null,
            createdAt: rec.createdAt,
          }
        : null,
      recommendationHistory: recommendationHistory.map((r) => ({ ...r, stale: r.taxonomyVersionId !== ws.active, current: r.id === rec?.id })),
      textMatches,
      history,
      canDecide: can(actor.role, "review.decide"),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

export interface DecisionInput {
  action: "approve" | "change" | "reject" | "defer" | "no_suitable";
  selectedConceptId?: string | null;
  reason?: string | null;
  expectedVersion: number;
  durationSeconds?: number | null;
}

interface LockedItem {
  stateId: string;
  listingRevisionId: string;
  state: ReviewState;
  lockVersion: number;
  ambiguous: boolean;
  latestDecisionId: string | null;
  latestRecommendationId: string | null;
  active: boolean;
  current: boolean;
}

async function lockItems(tx: Tx, ids: string[]): Promise<Map<string, LockedItem>> {
  const rows = await tx
    .select({
      stateId: reviewStates.id,
      listingRevisionId: reviewStates.listingRevisionId,
      state: reviewStates.state,
      lockVersion: reviewStates.lockVersion,
      ambiguous: reviewStates.ambiguous,
      latestDecisionId: reviewStates.latestDecisionId,
      latestRecommendationId: reviewStates.latestRecommendationId,
    })
    .from(reviewStates)
    .where(inArray(reviewStates.listingRevisionId, ids))
    .orderBy(reviewStates.id)
    .for("update");
  if (rows.length === 0) return new Map();
  const meta = await tx
    .select({ id: listingRevisions.id, active: listingRevisions.active, current: sql<boolean>`${merchants.activeCatalogRevisionId} = ${listingRevisions.catalogRevisionId}` })
    .from(listingRevisions)
    .innerJoin(catalogRevisions, eq(catalogRevisions.id, listingRevisions.catalogRevisionId))
    .innerJoin(merchants, eq(merchants.id, catalogRevisions.merchantId))
    .where(inArray(listingRevisions.id, ids));
  const metaById = new Map(meta.map((m) => [m.id, m]));
  return new Map(rows.map((r) => [r.listingRevisionId, { ...r, active: metaById.get(r.listingRevisionId)?.active ?? false, current: metaById.get(r.listingRevisionId)?.current ?? false }]));
}

async function assertMappableLeaf(tx: Tx, versionId: string, conceptId: string): Promise<{ path: string }> {
  const [concept] = await tx
    .select({ path: conceptRevisions.path, status: conceptRevisions.status, mappingAllowed: conceptRevisions.mappingAllowed })
    .from(conceptRevisions)
    .where(and(eq(conceptRevisions.taxonomyVersionId, versionId), eq(conceptRevisions.conceptId, conceptId)));
  if (!concept) throw new ApiError("invalid", "The selected concept does not exist in the active taxonomy version.", { fieldErrors: [{ path: "selectedConceptId", message: "Unknown concept." }] });
  if (!concept.mappingAllowed || concept.status !== "active") {
    throw new ApiError("invalid", "Products can only be mapped to an active leaf concept.", { fieldErrors: [{ path: "selectedConceptId", message: "Not an active leaf." }] });
  }
  return concept;
}

/**
 * Appends a human decision and moves the listing's workflow state (PRD TAX08, section 12).
 * The caller submits the lock version it saw; a mismatch returns 409 with the current record.
 */
export async function recordDecision(actor: Actor, listingRevisionId: string, input: DecisionInput, requestId: string) {
  if (!can(actor.role, "review.decide")) throw forbidden("Reviewing mappings requires a taxonomist or administrator.");
  return withContext(actor, async (tx) => {
    const item = (await lockItems(tx, [listingRevisionId])).get(listingRevisionId);
    if (!item) throw notFound("Listing");
    if (!item.active || !item.current) throw conflict("This listing belongs to a superseded catalog revision and can no longer be reviewed.");
    if (item.lockVersion !== input.expectedVersion) {
      throw conflict("Someone else updated this listing. Reload it to see the latest decision before trying again.", { state: item.state, lockVersion: item.lockVersion });
    }
    const [ws] = await tx.select({ active: workspaces.activeTaxonomyVersionId }).from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    if (!ws.active) throw conflict("Publish a taxonomy version before reviewing listings.");

    const [rec] = item.latestRecommendationId ? await tx.select().from(recommendations).where(eq(recommendations.id, item.latestRecommendationId)) : [];
    const suggestion = rec && rec.selectedConceptId && rec.taxonomyVersionId === ws.active ? rec.selectedConceptId : null;
    const reason = input.reason?.trim() || null;
    let target: string | null = null;
    let state: ReviewState;
    let origin: "manual" | "suggestion" = "manual";

    switch (input.action) {
      case "approve": {
        target = input.selectedConceptId ?? suggestion;
        if (!target) throw new ApiError("invalid", "There is no valid current target to approve. Choose a concept to map this listing manually.");
        if (suggestion && target !== suggestion) throw new ApiError("invalid", "To map to a different concept than the suggestion, use Change mapping and give a reason.");
        origin = suggestion ? "suggestion" : "manual";
        state = "approved";
        break;
      }
      case "change": {
        target = input.selectedConceptId ?? null;
        if (!target) throw new ApiError("invalid", "Choose the concept to map this listing to.", { fieldErrors: [{ path: "selectedConceptId", message: "Required." }] });
        if (!reason) throw new ApiError("invalid", "Give a reason for changing the mapping.", { fieldErrors: [{ path: "reason", message: "Required." }] });
        if (suggestion && target === suggestion) throw new ApiError("invalid", "That is the suggested concept. Use Approve instead.");
        state = "approved";
        break;
      }
      case "reject": {
        if (!rec?.selectedConceptId) throw new ApiError("invalid", "There is no suggestion to reject.");
        if (!reason) throw new ApiError("invalid", "Give a reason for rejecting the suggestion.", { fieldErrors: [{ path: "reason", message: "Required." }] });
        state = "needs_investigation";
        break;
      }
      case "defer":
        state = "deferred";
        break;
      case "no_suitable":
        state = "no_suitable_category";
        break;
    }
    const concept = target ? await assertMappableLeaf(tx, ws.active, target) : null;

    const [decision] = await tx
      .insert(reviewDecisions)
      .values({
        workspaceId: actor.workspaceId,
        listingRevisionId,
        taxonomyVersionId: ws.active,
        recommendationId: rec?.id ?? null,
        action: input.action,
        origin,
        selectedConceptId: target,
        reason,
        durationSeconds: input.durationSeconds != null ? Math.max(0, Math.min(Math.round(input.durationSeconds), 86_400)) : null,
        previousDecisionId: item.latestDecisionId,
        actorId: actor.userId,
      })
      .returning({ id: reviewDecisions.id, createdAt: reviewDecisions.createdAt });
    const lockVersion = item.lockVersion + 1;
    await tx
      .update(reviewStates)
      .set({ state, latestDecisionId: decision.id, taxonomyVersionId: ws.active, lockVersion, ambiguous: state === "approved" || state === "no_suitable_category" ? false : item.ambiguous, updatedAt: new Date() })
      .where(eq(reviewStates.id, item.stateId));
    await recordAudit(tx, actor, requestId, {
      action: `review.${input.action}`,
      entityType: "listing_revision",
      entityId: listingRevisionId,
      before: { state: item.state, decisionId: item.latestDecisionId },
      after: { state, decisionId: decision.id, conceptId: target, conceptPath: concept?.path ?? null, recommendationId: rec?.id ?? null, taxonomyVersionId: ws.active },
      reason,
    });
    return { decisionId: decision.id, state, lockVersion, conceptId: target, conceptPath: concept?.path ?? null };
  });
}

export const BULK_LIMIT = 100;

/**
 * All-or-nothing approval of explicitly selected High signal suggestions (PRD TAX09). Eligibility,
 * versions and permissions are rechecked here; if any row is stale or ineligible nothing is saved
 * and the conflicting rows are returned.
 */
export async function bulkApprove(actor: Actor, items: { listingRevisionId: string; expectedVersion: number }[], requestId: string) {
  if (!can(actor.role, "review.decide")) throw forbidden("Reviewing mappings requires a taxonomist or administrator.");
  if (items.length === 0 || items.length > BULK_LIMIT) throw new ApiError("bad_request", `Select between 1 and ${BULK_LIMIT} listings.`);
  const ids = items.map((i) => i.listingRevisionId);
  if (new Set(ids).size !== ids.length) throw new ApiError("bad_request", "A listing was selected more than once.");
  return withContext(actor, async (tx) => {
    const locked = await lockItems(tx, ids);
    const [ws] = await tx.select({ active: workspaces.activeTaxonomyVersionId }).from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    const recIds = [...locked.values()].map((l) => l.latestRecommendationId).filter((r): r is string => !!r);
    const recs = recIds.length ? await tx.select().from(recommendations).where(inArray(recommendations.id, recIds)) : [];
    const recById = new Map(recs.map((r) => [r.id, r]));
    const mappable = ws.active
      ? new Set((await tx.select({ id: conceptRevisions.conceptId }).from(conceptRevisions).where(and(eq(conceptRevisions.taxonomyVersionId, ws.active), eq(conceptRevisions.mappingAllowed, true), eq(conceptRevisions.status, "active")))).map((c) => c.id))
      : new Set<string>();

    const conflicts: { listingRevisionId: string; reason: string; state?: ReviewState; lockVersion?: number }[] = [];
    for (const { listingRevisionId, expectedVersion } of items) {
      const item = locked.get(listingRevisionId);
      const rec = item?.latestRecommendationId ? recById.get(item.latestRecommendationId) : undefined;
      const fail = (reason: string) => conflicts.push({ listingRevisionId, reason, state: item?.state, lockVersion: item?.lockVersion });
      if (!item) fail("Listing not found.");
      else if (!item.active || !item.current) fail("Listing belongs to a superseded revision.");
      else if (item.lockVersion !== expectedVersion) fail("Changed since it was selected.");
      else if (item.state !== "suggested") fail("Not awaiting approval of a suggestion.");
      else if (item.ambiguous) fail("Flagged as ambiguous.");
      else if (!rec || rec.signalBand !== "high") fail("Not a High signal suggestion.");
      else if (rec.taxonomyVersionId !== ws.active) fail("Suggestion is stale for the active taxonomy version.");
      else if (!rec.selectedConceptId || !mappable.has(rec.selectedConceptId)) fail("Suggested concept is not an active leaf.");
    }
    if (conflicts.length > 0) throw conflict(`${conflicts.length} of ${items.length} selected listings can no longer be bulk approved. Nothing was saved.`, { conflicts });

    const batchId = randomUUID();
    const inserted = await tx
      .insert(reviewDecisions)
      .values(
        items.map(({ listingRevisionId }) => {
          const item = locked.get(listingRevisionId)!;
          const rec = recById.get(item.latestRecommendationId!)!;
          return { workspaceId: actor.workspaceId, listingRevisionId, taxonomyVersionId: ws.active!, recommendationId: rec.id, action: "approve" as const, origin: "bulk" as const, selectedConceptId: rec.selectedConceptId, batchId, previousDecisionId: item.latestDecisionId, actorId: actor.userId };
        }),
      )
      .returning({ id: reviewDecisions.id, listingRevisionId: reviewDecisions.listingRevisionId });
    for (const d of inserted) {
      const item = locked.get(d.listingRevisionId)!;
      await tx.update(reviewStates).set({ state: "approved", latestDecisionId: d.id, taxonomyVersionId: ws.active, lockVersion: item.lockVersion + 1, updatedAt: new Date() }).where(eq(reviewStates.id, item.stateId));
    }
    await recordAudit(tx, actor, requestId, { action: "review.bulk_approve", entityType: "review_batch", entityId: batchId, after: { batchId, count: inserted.length, listingRevisionIds: ids, decisionIds: inserted.map((d) => d.id) } });
    return { batchId, approved: inserted.length };
  });
}

/** Mappable leaves of the active version matching a query: the concept picker for manual mapping. */
export async function searchMappableConcepts(actor: Actor, query: string) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  const q = query.trim();
  if (!q) return [];
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return withContext(actor, async (tx) => {
    const [ws] = await tx.select({ active: workspaces.activeTaxonomyVersionId }).from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    if (!ws.active) return [];
    return tx
      .select({ conceptId: conceptRevisions.conceptId, stableKey: concepts.stableKey, name: conceptRevisions.name, path: conceptRevisions.path, definition: conceptRevisions.definition })
      .from(conceptRevisions)
      .innerJoin(concepts, eq(concepts.id, conceptRevisions.conceptId))
      .where(
        and(
          eq(conceptRevisions.taxonomyVersionId, ws.active),
          eq(conceptRevisions.mappingAllowed, true),
          eq(conceptRevisions.status, "active"),
          sql`(${conceptRevisions.path} ilike ${pattern} or ${conceptRevisions.definition} ilike ${pattern} or ${conceptRevisions.synonyms}::text ilike ${pattern} or ${concepts.stableKey} ilike ${pattern})`,
        ),
      )
      .orderBy(sql`(${conceptRevisions.name} ilike ${pattern}) desc`, conceptRevisions.path)
      .limit(20);
  });
}
