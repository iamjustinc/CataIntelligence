import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { withContext, type Tx } from "@/db/client";
import { aiUsage, analysisJobItems, analysisJobs, catalogRevisions, conceptRevisions, concepts, listingRevisions, merchants, recommendations, reviewStates, workspaces } from "@/db/schema";
import { FixtureProvider } from "@/lib/ai/fixture-adapter";
import { resolveProviderStatus, type RecommendationProvider } from "@/lib/ai/provider";
import { SIGNAL_POLICY_VERSION, signalBand, validateRecommendation } from "@/lib/ai/validate-recommendation";
import { ApiError, conflict, forbidden, notFound } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { FIELD_LIMITS, type RecommendationRequest, type RecommendationResponse } from "@/lib/contracts/recommendation";
import { env } from "@/lib/env";
import { RETRIEVAL_POLICY_VERSION, retrieveCandidates, type RetrievalConcept } from "@/lib/retrieval/candidates";
import type { ListingFields } from "./catalog-validation";

export interface VersionIndex {
  versionId: string;
  leaves: RetrievalConcept[];
  /** Organizing (non-mappable) concepts by ID. */
  branches: Map<string, { conceptId: string; stableKey: string; path: string }>;
}

/** Active mappable leaves and organizing concepts of one taxonomy version. */
export async function loadVersionIndex(tx: Tx, versionId: string): Promise<VersionIndex> {
  const rows = await tx
    .select({
      conceptId: conceptRevisions.conceptId,
      stableKey: concepts.stableKey,
      parentConceptId: conceptRevisions.parentConceptId,
      name: conceptRevisions.name,
      definition: conceptRevisions.definition,
      synonyms: conceptRevisions.synonyms,
      path: conceptRevisions.path,
      status: conceptRevisions.status,
      mappingAllowed: conceptRevisions.mappingAllowed,
    })
    .from(conceptRevisions)
    .innerJoin(concepts, eq(concepts.id, conceptRevisions.conceptId))
    .where(eq(conceptRevisions.taxonomyVersionId, versionId));
  const branches = new Map<string, { conceptId: string; stableKey: string; path: string }>();
  const leaves: RetrievalConcept[] = [];
  for (const r of rows) {
    if (r.mappingAllowed && r.status === "active") leaves.push(r);
    else if (r.status === "active") branches.set(r.conceptId, { conceptId: r.conceptId, stableKey: r.stableKey, path: r.path });
  }
  return { versionId, leaves, branches };
}

const limit = (value: string | null, max: number, name: string, truncated: string[]) => {
  if (value && value.length > max) {
    truncated.push(name);
    return value.slice(0, max);
  }
  return value;
};

/** Builds the bounded provider request for one listing: limited fields plus retrieved candidates. */
export function buildRequest(workspaceId: string, listing: { id: string; contentHash: string; fields: ListingFields }, index: VersionIndex): RecommendationRequest {
  const truncated: string[] = [];
  const f = listing.fields;
  const product = {
    title: limit(f.title, FIELD_LIMITS.title, "title", truncated)!,
    description: limit(f.description, FIELD_LIMITS.description, "description", truncated),
    merchantCategoryPath: limit(f.merchantCategoryPath, FIELD_LIMITS.merchantCategoryPath, "merchant_category_path", truncated),
    brand: f.brand,
    packageSize: f.packageSize,
    gtin: f.gtin,
  };
  const candidates = retrieveCandidates(index.leaves, product).map((c) => ({ ...c, definition: c.definition.slice(0, FIELD_LIMITS.candidateDefinition) }));
  // Parents of the candidates plus the top-level domains: the only parents a proposal may name.
  const leafParent = new Map(index.leaves.map((l) => [l.conceptId, l.parentConceptId]));
  const branchIds = new Set<string>();
  for (const c of candidates) {
    const parent = leafParent.get(c.conceptId);
    if (parent) branchIds.add(parent);
  }
  for (const b of index.branches.values()) if (b.path.split(" > ").length === 2) branchIds.add(b.conceptId);
  const branches = [...branchIds].map((id) => index.branches.get(id)).filter((b): b is NonNullable<typeof b> => !!b).slice(0, 24);
  return { workspaceId, listingRevisionId: listing.id, taxonomyVersionId: index.versionId, contentHash: listing.contentHash, product, truncatedFields: truncated, candidates, branches };
}

/**
 * Stores a validated recommendation and updates the listing's workflow state. A recommendation
 * never replaces a human decision: when one exists the recommendation is kept as historical
 * evidence only (PRD TAX11, AT09).
 */
export async function storeRecommendation(
  tx: Tx,
  input: { workspaceId: string; request: RecommendationRequest; response: RecommendationResponse; provider: RecommendationProvider; runId: string; jobId: string | null; highEnabled: boolean },
): Promise<{ recommendationId: string; appliedToState: boolean }> {
  const { request, response, provider } = input;
  const signal = signalBand(request, response, input.highEnabled);
  const [rec] = await tx
    .insert(recommendations)
    .values({
      workspaceId: input.workspaceId,
      listingRevisionId: request.listingRevisionId,
      taxonomyVersionId: request.taxonomyVersionId,
      runId: input.runId,
      jobId: input.jobId,
      provider: provider.id,
      isDemo: provider.isDemo,
      modelId: provider.modelId,
      promptVersion: provider.promptVersion,
      retrievalPolicyVersion: RETRIEVAL_POLICY_VERSION,
      policyVersion: SIGNAL_POLICY_VERSION,
      inputHash: request.contentHash,
      candidates: request.candidates,
      selectedConceptId: response.selectedConceptId,
      alternatives: response.alternatives,
      evidence: response.evidence,
      explanation: response.explanation,
      warnings: request.truncatedFields.map((f) => `Field ${f} was truncated before analysis.`),
      ambiguityFlags: response.ambiguityFlags,
      missingInformation: response.missingInformation,
      proposedConcept: response.proposedConcept,
      signalBand: signal.band,
      signalBasis: signal.basis,
    })
    .returning({ id: recommendations.id });

  const [state] = await tx.select().from(reviewStates).where(eq(reviewStates.listingRevisionId, request.listingRevisionId)).for("update");
  if (!state) return { recommendationId: rec.id, appliedToState: false };
  if (state.latestDecisionId) {
    await tx.update(reviewStates).set({ latestRecommendationId: rec.id, analysisFailed: false }).where(eq(reviewStates.id, state.id));
    return { recommendationId: rec.id, appliedToState: false };
  }
  const ambiguous = response.ambiguityFlags.length > 0;
  await tx
    .update(reviewStates)
    .set({
      latestRecommendationId: rec.id,
      taxonomyVersionId: request.taxonomyVersionId,
      state: response.selectedConceptId && !ambiguous ? "suggested" : "needs_investigation",
      ambiguous,
      analysisFailed: false,
      lockVersion: state.lockVersion + 1,
      updatedAt: new Date(),
    })
    .where(eq(reviewStates.id, state.id));
  return { recommendationId: rec.id, appliedToState: true };
}

export interface AnalysisProgress {
  total: number;
  succeeded: number;
  failed: number;
  skippedReviewed: number;
  skippedNoFixture: number;
}

/**
 * Starts a recommendation job for a merchant's current catalog revision.
 *
 * Phase 1 supports the labeled demo provider only and processes the job inside the request;
 * fixture lookup is instant. Listings whose content is not a curated fixture are skipped and
 * stay manually reviewable: nothing is fabricated for them. Live processing through the worker
 * arrives in Phase 2.
 */
export async function startAnalysis(actor: Actor, input: { catalogRevisionId: string }, requestId: string) {
  if (!can(actor.role, "analysis.run")) throw forbidden("Running analysis requires a taxonomist or administrator.");
  return withContext(actor, async (tx) => {
    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    const status = resolveProviderStatus(ws.providerMode, env(), ws.liveAiOptIn);
    if (status.state === "live") throw new ApiError("provider_unavailable", "Live recommendations are not available in this build yet. Manual mapping is available.");
    if (status.state !== "demo") throw new ApiError("provider_unavailable", `${status.label}. ${status.detail}`);
    if (!ws.activeTaxonomyVersionId) throw conflict("Publish a taxonomy version before running analysis.");

    const [revision] = await tx
      .select({ id: catalogRevisions.id, merchantId: catalogRevisions.merchantId, current: merchants.activeCatalogRevisionId })
      .from(catalogRevisions)
      .innerJoin(merchants, eq(merchants.id, catalogRevisions.merchantId))
      .where(eq(catalogRevisions.id, input.catalogRevisionId));
    if (!revision) throw notFound("Catalog revision");
    if (revision.current !== revision.id) throw conflict("This catalog revision has been superseded. Analyze the current revision.");

    const provider = new FixtureProvider();
    const index = await loadVersionIndex(tx, ws.activeTaxonomyVersionId);
    const listings = await tx
      .select({ id: listingRevisions.id, contentHash: listingRevisions.contentHash, fields: listingRevisions.normalizedJson, decisionId: reviewStates.latestDecisionId })
      .from(listingRevisions)
      .innerJoin(reviewStates, eq(reviewStates.listingRevisionId, listingRevisions.id))
      .where(and(eq(listingRevisions.catalogRevisionId, revision.id), eq(listingRevisions.active, true)))
      .orderBy(listingRevisions.sourceRow, listingRevisions.id);

    const runId = randomUUID();
    const progress: AnalysisProgress = { total: listings.length, succeeded: 0, failed: 0, skippedReviewed: 0, skippedNoFixture: 0 };
    const [job] = await tx
      .insert(analysisJobs)
      .values({
        workspaceId: actor.workspaceId,
        catalogRevisionId: revision.id,
        taxonomyVersionId: ws.activeTaxonomyVersionId,
        providerMode: "demo",
        dependencyVersions: { provider: provider.id, promptVersion: provider.promptVersion, retrievalPolicy: RETRIEVAL_POLICY_VERSION, signalPolicy: SIGNAL_POLICY_VERSION },
        status: "running",
        createdBy: actor.userId,
        startedAt: new Date(),
      })
      .returning({ id: analysisJobs.id });

    const items: (typeof analysisJobItems.$inferInsert)[] = [];
    for (const listing of listings) {
      const item = { workspaceId: actor.workspaceId, jobId: job.id, listingRevisionId: listing.id, attempt: 1 };
      if (listing.decisionId) {
        progress.skippedReviewed++;
        items.push({ ...item, status: "skipped", errorCode: "already_reviewed" });
        continue;
      }
      const request = buildRequest(actor.workspaceId, { id: listing.id, contentHash: listing.contentHash, fields: listing.fields as ListingFields }, index);
      const result = await provider.recommend(request);
      if (!result.ok) {
        if (result.failure.kind === "no_fixture") {
          progress.skippedNoFixture++;
          items.push({ ...item, status: "skipped", errorCode: "not_fixture_content" });
        } else {
          progress.failed++;
          items.push({ ...item, status: "failed", errorCode: result.failure.code });
        }
        continue;
      }
      const validated = validateRecommendation(request, result.payload);
      if (!validated.ok) {
        progress.failed++;
        items.push({ ...item, status: "failed", errorCode: validated.code });
        await tx.update(reviewStates).set({ analysisFailed: true }).where(eq(reviewStates.listingRevisionId, listing.id));
        continue;
      }
      const stored = await storeRecommendation(tx, { workspaceId: actor.workspaceId, request, response: validated.response, provider, runId, jobId: job.id, highEnabled: ws.highSignalEnabled });
      progress.succeeded++;
      items.push({ ...item, status: "succeeded", recommendationId: stored.recommendationId });
    }
    for (let i = 0; i < items.length; i += 500) await tx.insert(analysisJobItems).values(items.slice(i, i + 500));
    const finalStatus = progress.failed > 0 ? "partially_completed" : "completed";
    await tx.update(analysisJobs).set({ status: finalStatus, progress, finishedAt: new Date() }).where(eq(analysisJobs.id, job.id));
    // No provider was called: demo output costs nothing and is recorded as such.
    await tx.insert(aiUsage).values({ workspaceId: actor.workspaceId, runId, jobId: job.id, purpose: "recommendation", provider: provider.id, promptVersion: provider.promptVersion, inputTokens: 0, outputTokens: 0, costEstimateUsd: "0", status: finalStatus, latencyMs: 0 });
    await recordAudit(tx, actor, requestId, { action: "analysis.run", entityType: "analysis_job", entityId: job.id, after: { catalogRevisionId: revision.id, taxonomyVersionId: ws.activeTaxonomyVersionId, provider: provider.id, demo: true, progress } });
    return { id: job.id, status: finalStatus, provider: provider.id, isDemo: true, progress };
  });
}

export async function getAnalysisJob(actor: Actor, jobId: string) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, async (tx) => {
    const [job] = await tx.select().from(analysisJobs).where(eq(analysisJobs.id, jobId));
    if (!job) throw notFound("Analysis job");
    const failures = await tx
      .select({ listingRevisionId: analysisJobItems.listingRevisionId, status: analysisJobItems.status, errorCode: analysisJobItems.errorCode })
      .from(analysisJobItems)
      .where(and(eq(analysisJobItems.jobId, jobId), eq(analysisJobItems.status, "failed")))
      .limit(100);
    return { id: job.id, status: job.status, providerMode: job.providerMode, catalogRevisionId: job.catalogRevisionId, taxonomyVersionId: job.taxonomyVersionId, progress: job.progress as AnalysisProgress, createdAt: job.createdAt, finishedAt: job.finishedAt, failures };
  });
}

export async function latestAnalysisJob(actor: Actor, catalogRevisionId: string) {
  return withContext(actor, async (tx) => {
    const [job] = await tx.select().from(analysisJobs).where(eq(analysisJobs.catalogRevisionId, catalogRevisionId)).orderBy(desc(analysisJobs.createdAt)).limit(1);
    return job ? { id: job.id, status: job.status, providerMode: job.providerMode, progress: job.progress as AnalysisProgress, createdAt: job.createdAt, taxonomyVersionId: job.taxonomyVersionId } : null;
  });
}
