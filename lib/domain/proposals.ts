import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withContext, type Tx } from "@/db/client";
import { conceptRevisions, concepts, listingRevisions, merchants, reviewDecisions, reviewStates, taxonomyProposals, taxonomyVersions, user, workspaces } from "@/db/schema";
import { ApiError, conflict, forbidden, notFound } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { activeVersion, loadConceptInputs } from "./taxonomy";
import { MAX_DEPTH, normalizeTerm, validateTaxonomy } from "./taxonomy-validation";

export type ProposalInput =
  | { type: "new_leaf"; name: string; definition: string; parentConceptId: string; rationale: string; evidenceListingIds: string[] }
  | { type: "synonym"; conceptId: string; synonym: string; locale?: string; rationale: string; evidenceListingIds: string[] };

export interface NewLeafPayload {
  /** Parent concept; also the concept a pending proposal is counted against. */
  conceptId: string;
  parentConceptId: string;
  parentPath: string;
  name: string;
  definition: string;
  /** Existing concepts that already use this name as a name or synonym. */
  overlaps: { conceptId: string; path: string; via: "name" | "synonym" }[];
  createdConceptId?: string;
}
export interface SynonymPayload {
  conceptId: string;
  conceptPath: string;
  /** Stored exactly as proposed: punctuation and case are preserved. */
  synonym: string;
  locale: string;
  /** Other mappable concepts that use the term; it will not act as a unique exact match. */
  ambiguousWith: string[];
}

type VersionConcept = { conceptId: string; parentConceptId: string | null; name: string; synonyms: string[]; path: string; depth: number; status: "active" | "inactive"; mappingAllowed: boolean };

async function loadVersion(tx: Tx, versionId: string): Promise<VersionConcept[]> {
  return tx
    .select({
      conceptId: conceptRevisions.conceptId,
      parentConceptId: conceptRevisions.parentConceptId,
      name: conceptRevisions.name,
      synonyms: conceptRevisions.synonyms,
      path: conceptRevisions.path,
      depth: conceptRevisions.depth,
      status: conceptRevisions.status,
      mappingAllowed: conceptRevisions.mappingAllowed,
    })
    .from(conceptRevisions)
    .where(eq(conceptRevisions.taxonomyVersionId, versionId));
}

/** Duplicate and structural checks for a new leaf (PRD TAX10). */
function checkNewLeaf(all: VersionConcept[], parentConceptId: string, name: string): { parent: VersionConcept; overlaps: NewLeafPayload["overlaps"] } {
  const parent = all.find((c) => c.conceptId === parentConceptId);
  if (!parent || parent.status !== "active") throw new ApiError("invalid", "The parent concept does not exist or is inactive in this taxonomy version.", { fieldErrors: [{ path: "parentConceptId", message: "Unknown or inactive parent." }] });
  if (parent.mappingAllowed) {
    throw new ApiError("invalid", `"${parent.name}" accepts product mappings, so it cannot have children. Choose its parent instead; restructuring an existing leaf is not supported yet.`, { fieldErrors: [{ path: "parentConceptId", message: "Parent is a mappable leaf." }] });
  }
  if (parent.depth + 1 > MAX_DEPTH) throw new ApiError("invalid", `A leaf under "${parent.name}" would exceed the maximum depth of ${MAX_DEPTH}.`);
  const n = normalizeTerm(name);
  if (all.some((c) => c.parentConceptId === parentConceptId && normalizeTerm(c.name) === n)) {
    throw new ApiError("invalid", `"${parent.name}" already has a child named "${name}".`, { fieldErrors: [{ path: "name", message: "Duplicate sibling name." }] });
  }
  const overlaps: NewLeafPayload["overlaps"] = [];
  for (const c of all) {
    if (normalizeTerm(c.name) === n) overlaps.push({ conceptId: c.conceptId, path: c.path, via: "name" });
    else if (c.synonyms.some((s) => normalizeTerm(s) === n)) overlaps.push({ conceptId: c.conceptId, path: c.path, via: "synonym" });
  }
  return { parent, overlaps };
}

function checkSynonym(all: VersionConcept[], conceptId: string, synonym: string): { concept: VersionConcept; ambiguousWith: string[] } {
  const concept = all.find((c) => c.conceptId === conceptId);
  if (!concept || concept.status !== "active") throw new ApiError("invalid", "The concept does not exist or is inactive in this taxonomy version.", { fieldErrors: [{ path: "conceptId", message: "Unknown or inactive concept." }] });
  const n = normalizeTerm(synonym);
  if (normalizeTerm(concept.name) === n || concept.synonyms.some((s) => normalizeTerm(s) === n)) {
    throw new ApiError("invalid", `"${concept.name}" already has this name or synonym.`, { fieldErrors: [{ path: "synonym", message: "Already present." }] });
  }
  const ambiguousWith = all.filter((c) => c.conceptId !== conceptId && c.mappingAllowed && (normalizeTerm(c.name) === n || c.synonyms.some((s) => normalizeTerm(s) === n))).map((c) => c.path);
  return { concept, ambiguousWith };
}

/** Submits a new-leaf or synonym proposal for administrator review. Changes nothing in the taxonomy. */
export async function submitProposal(actor: Actor, input: ProposalInput, requestId: string) {
  if (!can(actor.role, "taxonomy.propose")) throw forbidden("Proposing taxonomy changes requires a taxonomist or administrator.");
  return withContext(actor, async (tx) => {
    const base = await activeVersion(tx, actor.workspaceId);
    if (!base) throw conflict("Publish a taxonomy version before proposing changes.");
    const all = await loadVersion(tx, base.id);
    const evidence = [...new Set(input.evidenceListingIds)];
    if (evidence.length) {
      const found = await tx.select({ id: listingRevisions.id }).from(listingRevisions).where(inArray(listingRevisions.id, evidence));
      if (found.length !== evidence.length) throw new ApiError("invalid", "A related listing does not exist in this workspace.", { fieldErrors: [{ path: "evidenceListingIds", message: "Unknown listing." }] });
    }
    let payload: NewLeafPayload | SynonymPayload;
    if (input.type === "new_leaf") {
      const { parent, overlaps } = checkNewLeaf(all, input.parentConceptId, input.name);
      payload = { conceptId: parent.conceptId, parentConceptId: parent.conceptId, parentPath: parent.path, name: input.name, definition: input.definition, overlaps };
    } else {
      const { concept, ambiguousWith } = checkSynonym(all, input.conceptId, input.synonym);
      payload = { conceptId: concept.conceptId, conceptPath: concept.path, synonym: input.synonym, locale: input.locale ?? "en", ambiguousWith };
    }
    const [row] = await tx
      .insert(taxonomyProposals)
      .values({ workspaceId: actor.workspaceId, type: input.type, payload, evidenceListingIds: evidence, rationale: input.rationale, baseVersionId: base.id, submittedBy: actor.userId })
      .returning();
    await recordAudit(tx, actor, requestId, { action: "taxonomy.proposal.submit", entityType: "taxonomy_proposal", entityId: row.id, after: { type: input.type, payload, evidenceListingIds: evidence }, reason: input.rationale });
    return { id: row.id, state: row.state, type: row.type, payload };
  });
}

export async function listProposals(actor: Actor) {
  if (!can(actor.role, "taxonomy.propose")) throw forbidden("Taxonomy proposals are visible to taxonomists and administrators.");
  return withContext(actor, async (tx) => {
    const decider = alias(user, "decider");
    const rows = await tx
      .select({
        id: taxonomyProposals.id,
        type: taxonomyProposals.type,
        payload: taxonomyProposals.payload,
        evidenceListingIds: taxonomyProposals.evidenceListingIds,
        rationale: taxonomyProposals.rationale,
        state: taxonomyProposals.state,
        lockVersion: taxonomyProposals.lockVersion,
        createdAt: taxonomyProposals.createdAt,
        decidedAt: taxonomyProposals.decidedAt,
        decisionReason: taxonomyProposals.decisionReason,
        submittedByName: user.name,
        decidedByName: decider.name,
        appliedSequence: taxonomyVersions.sequence,
        appliedState: taxonomyVersions.state,
      })
      .from(taxonomyProposals)
      .innerJoin(user, eq(user.id, taxonomyProposals.submittedBy))
      .leftJoin(decider, eq(decider.id, taxonomyProposals.decidedBy))
      .leftJoin(taxonomyVersions, eq(taxonomyVersions.id, taxonomyProposals.appliedVersionId))
      .orderBy(sql`(${taxonomyProposals.state} = 'submitted') desc`, desc(taxonomyProposals.createdAt));
    return rows.map((r) => ({ ...r, payload: r.payload as NewLeafPayload | SynonymPayload }));
  });
}

/** Returns the workspace's draft version, creating one as a copy of the active version if needed. */
async function ensureDraft(tx: Tx, actor: Actor, baseId: string): Promise<{ id: string; sequence: number; lockVersion: number; created: boolean }> {
  const [draft] = await tx.select().from(taxonomyVersions).where(eq(taxonomyVersions.state, "draft")).for("update");
  if (draft) return { id: draft.id, sequence: draft.sequence, lockVersion: draft.lockVersion, created: false };
  const [{ last }] = await tx.select({ last: max(taxonomyVersions.sequence) }).from(taxonomyVersions);
  const [created] = await tx
    .insert(taxonomyVersions)
    .values({ workspaceId: actor.workspaceId, sequence: (last ?? 0) + 1, baseVersionId: baseId, note: "Draft created from approved proposals", createdBy: actor.userId })
    .returning();
  await tx.execute(sql`
    insert into concept_revisions (workspace_id, taxonomy_version_id, concept_id, parent_concept_id, name, definition, synonyms, status, mapping_allowed, path, depth)
    select workspace_id, ${created.id}, concept_id, parent_concept_id, name, definition, synonyms, status, mapping_allowed, path, depth
    from concept_revisions where taxonomy_version_id = ${baseId}`);
  return { id: created.id, sequence: created.sequence, lockVersion: created.lockVersion, created: true };
}

const slug = (s: string) => s.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase().slice(0, 24) || "CONCEPT";

export interface ProposalDecision {
  decision: "approve" | "modify" | "reject";
  reason?: string | null;
  expectedVersion: number;
  modifications?: { name?: string; definition?: string; parentConceptId?: string; synonym?: string };
}

/**
 * Administrator decision on a proposal (PRD TAX10). Approval changes the draft taxonomy only;
 * nothing is live until that draft is published as a new version. The model has no path here.
 */
export async function decideProposal(actor: Actor, proposalId: string, input: ProposalDecision, requestId: string) {
  if (!can(actor.role, "taxonomy.manage")) throw forbidden("Only administrators can decide taxonomy proposals.");
  return withContext(actor, async (tx) => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, actor.workspaceId)).for("update");
    const [proposal] = await tx.select().from(taxonomyProposals).where(eq(taxonomyProposals.id, proposalId)).for("update");
    if (!proposal) throw notFound("Proposal");
    const current = { state: proposal.state, lockVersion: proposal.lockVersion };
    if (proposal.state !== "submitted") throw conflict(`This proposal was already ${proposal.state}.`, current);
    if (proposal.lockVersion !== input.expectedVersion) throw conflict("This proposal changed since you loaded it.", current);
    const reason = input.reason?.trim() || null;
    const mods = input.modifications ?? {};
    if (input.decision === "reject" && !reason) throw new ApiError("invalid", "Explain why the proposal is rejected.", { fieldErrors: [{ path: "reason", message: "Required." }] });
    if (input.decision === "modify" && (!reason || Object.values(mods).every((v) => v === undefined))) {
      throw new ApiError("invalid", "A modified approval needs at least one change and an explanation.", { fieldErrors: [{ path: "reason", message: "Required." }] });
    }

    let payload = proposal.payload as NewLeafPayload | SynonymPayload;
    let applied: { id: string; sequence: number } | null = null;
    if (input.decision !== "reject") {
      const base = await activeVersion(tx, actor.workspaceId);
      if (!base) throw conflict("There is no active taxonomy version to change.");
      const draft = await ensureDraft(tx, actor, base.id);
      const all = await loadVersion(tx, draft.id);
      if (proposal.type === "new_leaf") {
        const p = payload as NewLeafPayload;
        const name = (input.decision === "modify" && mods.name?.trim()) || p.name;
        const definition = (input.decision === "modify" && mods.definition?.trim()) || p.definition;
        const parentId = (input.decision === "modify" && mods.parentConceptId) || p.parentConceptId;
        const { parent, overlaps } = checkNewLeaf(all, parentId, name);
        const [parentKey] = await tx.select({ key: concepts.stableKey }).from(concepts).where(eq(concepts.id, parent.conceptId));
        // Stable keys are never recycled: find an unused one.
        let key = `${parentKey.key}-${slug(name)}`.slice(0, 90);
        for (let i = 2; (await tx.select({ id: concepts.id }).from(concepts).where(eq(concepts.stableKey, key))).length > 0; i++) key = `${parentKey.key}-${slug(name)}-${i}`.slice(0, 90);
        const [concept] = await tx.insert(concepts).values({ workspaceId: actor.workspaceId, stableKey: key }).returning({ id: concepts.id });
        await tx.insert(conceptRevisions).values({
          workspaceId: actor.workspaceId,
          taxonomyVersionId: draft.id,
          conceptId: concept.id,
          parentConceptId: parent.conceptId,
          name,
          definition,
          synonyms: [],
          status: "active",
          mappingAllowed: true,
          path: `${parent.path} > ${name}`,
          depth: parent.depth + 1,
        });
        payload = { ...p, name, definition, parentConceptId: parent.conceptId, conceptId: parent.conceptId, parentPath: parent.path, overlaps, createdConceptId: concept.id };
      } else {
        const p = payload as SynonymPayload;
        const synonym = (input.decision === "modify" && mods.synonym?.trim()) || p.synonym;
        const { concept, ambiguousWith } = checkSynonym(all, p.conceptId, synonym);
        await tx
          .update(conceptRevisions)
          .set({ synonyms: [...concept.synonyms, synonym] })
          .where(and(eq(conceptRevisions.taxonomyVersionId, draft.id), eq(conceptRevisions.conceptId, concept.conceptId)));
        payload = { ...p, synonym, ambiguousWith };
      }
      const validation = validateTaxonomy(await loadConceptInputs(tx, draft.id));
      if (validation.errors.length > 0) throw new ApiError("invalid", `Applying this proposal would make the draft invalid: ${validation.errors[0].message}`);
      await tx.update(taxonomyVersions).set({ lockVersion: draft.lockVersion + 1 }).where(eq(taxonomyVersions.id, draft.id));
      applied = { id: draft.id, sequence: draft.sequence };
    }

    const state = input.decision === "reject" ? "rejected" : input.decision === "modify" ? "modified" : "approved";
    await tx
      .update(taxonomyProposals)
      .set({ state, payload, decidedBy: actor.userId, decidedAt: new Date(), decisionReason: reason, appliedVersionId: applied?.id ?? null, lockVersion: proposal.lockVersion + 1 })
      .where(eq(taxonomyProposals.id, proposal.id));
    await recordAudit(tx, actor, requestId, {
      action: `taxonomy.proposal.${input.decision}`,
      entityType: "taxonomy_proposal",
      entityId: proposal.id,
      before: { state: "submitted", payload: proposal.payload },
      after: { state, payload, draftVersionId: applied?.id ?? null, draftSequence: applied?.sequence ?? null },
      reason,
    });
    return { id: proposal.id, state, draftVersionId: applied?.id ?? null, draftSequence: applied?.sequence ?? null };
  });
}

/** Number of listings in current catalogs whose review state is stale. */
export async function countStale(actor: Actor): Promise<number> {
  return withContext(actor, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(reviewStates)
      .innerJoin(listingRevisions, eq(listingRevisions.id, reviewStates.listingRevisionId))
      .innerJoin(merchants, eq(merchants.activeCatalogRevisionId, listingRevisions.catalogRevisionId))
      .where(and(eq(reviewStates.state, "stale"), eq(listingRevisions.active, true)));
    return row.n;
  });
}

/**
 * Deterministic compatibility check after a taxonomy publication (PRD TAX11). A stale human
 * approval is retained, by an explicit revalidated decision against the new version, only when
 * its target concept still exists there as an active leaf with the same path and definition.
 * Anything else returns to review; stale suggestions need a new analysis.
 */
export async function revalidateDependencies(actor: Actor, requestId: string) {
  if (!can(actor.role, "taxonomy.manage")) throw forbidden("Only administrators can revalidate mappings.");
  return withContext(actor, async (tx) => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, actor.workspaceId)).for("update");
    const active = await activeVersion(tx, actor.workspaceId);
    if (!active) throw conflict("There is no active taxonomy version.");
    const stale = await tx
      .select({ stateId: reviewStates.id, listingRevisionId: reviewStates.listingRevisionId, lockVersion: reviewStates.lockVersion, decisionId: reviewStates.latestDecisionId })
      .from(reviewStates)
      .innerJoin(listingRevisions, eq(listingRevisions.id, reviewStates.listingRevisionId))
      .innerJoin(merchants, eq(merchants.activeCatalogRevisionId, listingRevisions.catalogRevisionId))
      .where(and(eq(reviewStates.state, "stale"), eq(listingRevisions.active, true)))
      .for("update", { of: reviewStates });

    const decisionIds = stale.map((s) => s.decisionId).filter((d): d is string => !!d);
    const decisions = decisionIds.length ? await tx.select().from(reviewDecisions).where(inArray(reviewDecisions.id, decisionIds)) : [];
    const decisionById = new Map(decisions.map((d) => [d.id, d]));
    const versions = [...new Set([active.id, ...decisions.map((d) => d.taxonomyVersionId)])];
    const revisions = await tx
      .select({ versionId: conceptRevisions.taxonomyVersionId, conceptId: conceptRevisions.conceptId, path: conceptRevisions.path, definition: conceptRevisions.definition, status: conceptRevisions.status, mappingAllowed: conceptRevisions.mappingAllowed })
      .from(conceptRevisions)
      .where(inArray(conceptRevisions.taxonomyVersionId, versions));
    const rev = new Map(revisions.map((r) => [`${r.versionId}:${r.conceptId}`, r]));

    const counts = { revalidated: 0, needsReview: 0, needsAnalysis: 0, reopened: 0 };
    for (const s of stale) {
      const decision = s.decisionId ? decisionById.get(s.decisionId) : undefined;
      const set = (state: "approved" | "needs_review" | "needs_analysis", latestDecisionId?: string) =>
        tx.update(reviewStates).set({ state, taxonomyVersionId: active.id, lockVersion: s.lockVersion + 1, updatedAt: new Date(), ...(latestDecisionId ? { latestDecisionId } : {}) }).where(eq(reviewStates.id, s.stateId));
      if (!decision?.selectedConceptId) {
        await set(decision ? "needs_review" : "needs_analysis");
        if (decision) counts.needsReview++;
        else counts.needsAnalysis++;
        continue;
      }
      const before = rev.get(`${decision.taxonomyVersionId}:${decision.selectedConceptId}`);
      const after = rev.get(`${active.id}:${decision.selectedConceptId}`);
      const compatible = !!before && !!after && after.status === "active" && after.mappingAllowed && after.path === before.path && after.definition === before.definition;
      if (!compatible) {
        await set("needs_review");
        counts.needsReview++;
        continue;
      }
      const [revalidated] = await tx
        .insert(reviewDecisions)
        .values({
          workspaceId: actor.workspaceId,
          listingRevisionId: s.listingRevisionId,
          taxonomyVersionId: active.id,
          action: "approve",
          origin: "revalidated",
          selectedConceptId: decision.selectedConceptId,
          reason: `Revalidated against taxonomy version ${active.sequence}: target concept unchanged.`,
          previousDecisionId: decision.id,
          actorId: decision.actorId,
        })
        .returning({ id: reviewDecisions.id });
      await set("approved", revalidated.id);
      counts.revalidated++;
    }

    // Listings marked "no suitable category" that motivated a proposal now applied in the active version.
    const applied = await tx.select({ evidence: taxonomyProposals.evidenceListingIds }).from(taxonomyProposals).where(and(eq(taxonomyProposals.appliedVersionId, active.id), inArray(taxonomyProposals.state, ["approved", "modified"])));
    const evidence = [...new Set(applied.flatMap((a) => a.evidence))];
    if (evidence.length) {
      const reopened = await tx
        .update(reviewStates)
        .set({ state: "needs_review", taxonomyVersionId: active.id, lockVersion: sql`${reviewStates.lockVersion} + 1`, updatedAt: new Date() })
        .where(and(inArray(reviewStates.listingRevisionId, evidence), eq(reviewStates.state, "no_suitable_category")))
        .returning({ id: reviewStates.id });
      counts.reopened = reopened.length;
    }
    await recordAudit(tx, actor, requestId, { action: "taxonomy.revalidate", entityType: "taxonomy_version", entityId: active.id, after: { sequence: active.sequence, ...counts } });
    return { taxonomyVersionId: active.id, sequence: active.sequence, ...counts };
  });
}
