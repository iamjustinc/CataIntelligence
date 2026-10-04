import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { withContext, type Tx } from "@/db/client";
import { aiUsage, analysisJobItems, analysisJobs, catalogRevisions, conceptRevisions, concepts, listingRevisions, merchants, recommendations, reviewStates, workspaces } from "@/db/schema";
import { buildUserPayload, CLAUDE_PROMPT_VERSION, SYSTEM_PROMPT } from "@/lib/ai/claude-adapter";
import { FIXTURE_PROMPT_VERSION } from "@/lib/ai/fixture-adapter";
import { resolveProviderStatus, type RecommendationProvider } from "@/lib/ai/provider";
import { SIGNAL_POLICY_VERSION, signalBand } from "@/lib/ai/validate-recommendation";
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
): Promise<{ recommendationId: string | null; appliedToState: boolean; stale: boolean }> {
  const { request, response, provider } = input;
  // Checked under the workspace row lock at write time: a recommendation for a taxonomy version
  // that is no longer active would be stale the moment it is stored.
  const [ws] = await tx.select({ active: workspaces.activeTaxonomyVersionId }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).for("share");
  if (ws?.active !== request.taxonomyVersionId) return { recommendationId: null, appliedToState: false, stale: true };
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
  if (!state) return { recommendationId: rec.id, appliedToState: false, stale: false };
  if (state.latestDecisionId) {
    await tx.update(reviewStates).set({ latestRecommendationId: rec.id, analysisFailed: false }).where(eq(reviewStates.id, state.id));
    return { recommendationId: rec.id, appliedToState: false, stale: false };
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
  return { recommendationId: rec.id, appliedToState: true, stale: false };
}

export interface AnalysisProgress {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  canceled: number;
  skippedReviewed: number;
  skippedNoFixture: number;
  skippedUpToDate: number;
}

/** States a reviewer has settled; analysis leaves these listings alone. */
export const SETTLED_STATES = ["approved", "deferred", "no_suitable_category"] as const;

export interface UsageEstimate {
  eligible: number;
  /** Estimated tokens for the eligible listings. Zero in demo mode, which calls no provider. */
  inputTokens: number;
  outputTokens: number;
  /** null when no provider pricing is configured: unknown, not zero. */
  costUsd: number | null;
  basis: string;
}

const OUTPUT_TOKENS_PER_ITEM = 600;
const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

export function costOf(inputTokens: number, outputTokens: number, pricing: { input: string | null; output: string | null }): number | null {
  if (pricing.input === null || pricing.output === null) return null;
  return (inputTokens * Number(pricing.input) + outputTokens * Number(pricing.output)) / 1_000_000;
}

interface Plan {
  ws: typeof workspaces.$inferSelect;
  mode: "demo" | "live";
  provider: string;
  modelId: string | null;
  promptVersion: string;
  revisionId: string;
  taxonomyVersionId: string;
  items: { listingRevisionId: string; skip: "already_reviewed" | "up_to_date" | null }[];
  estimate: UsageEstimate;
  caps: { jobTokenCap: number; jobSpendCapUsd: number; dailySpendCapUsd: number; jobItemCap: number; dailyCommittedUsd: number };
  /** Reasons the job may not start as configured. */
  blockers: string[];
}

/** Provider spend recorded today (UTC) plus what running jobs have reserved and not yet spent. */
export async function dailyCommittedUsd(tx: Tx): Promise<number> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const [spent] = await tx.select({ usd: sql<string>`coalesce(sum(${aiUsage.costEstimateUsd}), 0)` }).from(aiUsage).where(gte(aiUsage.createdAt, midnight));
  const [reserved] = await tx
    .select({ usd: sql<string>`coalesce(sum(greatest(coalesce(${analysisJobs.reservedCostUsd}, 0) - coalesce(${analysisJobs.costUsd}, 0), 0)), 0)` })
    .from(analysisJobs)
    .where(inArray(analysisJobs.status, ["queued", "running", "cancel_requested"]));
  return Number(spent.usd) + Number(reserved.usd);
}

/** Works out what a job for this revision would process, cost and be limited by. */
async function plan(tx: Tx, actor: Actor, catalogRevisionId: string): Promise<Plan> {
  const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, actor.workspaceId));
  const modelId = ws.aiModelId ?? env().AI_MODEL_ID ?? null;
  const status = resolveProviderStatus(ws.providerMode, { ANTHROPIC_API_KEY: env().ANTHROPIC_API_KEY, AI_MODEL_ID: modelId ?? undefined }, ws.liveAiOptIn);
  if (status.state !== "demo" && status.state !== "live") throw new ApiError("provider_unavailable", `${status.label}. ${status.detail}`);
  if (!ws.activeTaxonomyVersionId) throw conflict("Publish a taxonomy version before running analysis.");
  const [revision] = await tx
    .select({ id: catalogRevisions.id, current: merchants.activeCatalogRevisionId })
    .from(catalogRevisions)
    .innerJoin(merchants, eq(merchants.id, catalogRevisions.merchantId))
    .where(eq(catalogRevisions.id, catalogRevisionId));
  if (!revision) throw notFound("Catalog revision");
  if (revision.current !== revision.id) throw conflict("This catalog revision has been superseded. Analyze the current revision.");

  const mode = status.state;
  const provider = mode === "demo" ? "fixture" : "claude";
  const listings = await tx
    .select({
      id: listingRevisions.id,
      contentHash: listingRevisions.contentHash,
      fields: listingRevisions.normalizedJson,
      state: reviewStates.state,
      decisionId: reviewStates.latestDecisionId,
      analysisFailed: reviewStates.analysisFailed,
      recVersion: recommendations.taxonomyVersionId,
      recProvider: recommendations.provider,
      recModel: recommendations.modelId,
    })
    .from(listingRevisions)
    .innerJoin(reviewStates, eq(reviewStates.listingRevisionId, listingRevisions.id))
    .leftJoin(recommendations, eq(recommendations.id, reviewStates.latestRecommendationId))
    .where(and(eq(listingRevisions.catalogRevisionId, revision.id), eq(listingRevisions.active, true)))
    .orderBy(listingRevisions.sourceRow, listingRevisions.id);

  const index = mode === "live" ? await loadVersionIndex(tx, ws.activeTaxonomyVersionId) : null;
  let inputTokens = 0;
  let eligible = 0;
  const items: Plan["items"] = listings.map((l) => {
    // A reviewer has settled it, or rejected a suggestion and is investigating: leave it alone.
    const settled = (SETTLED_STATES as readonly string[]).includes(l.state) || (l.state === "needs_investigation" && !!l.decisionId);
    if (settled) return { listingRevisionId: l.id, skip: "already_reviewed" as const };
    const current = l.recVersion === ws.activeTaxonomyVersionId && l.recProvider === provider && (l.recModel ?? null) === (mode === "live" ? modelId : null) && !l.analysisFailed;
    if (current) return { listingRevisionId: l.id, skip: "up_to_date" as const };
    eligible++;
    if (index) {
      const request = buildRequest(actor.workspaceId, { id: l.id, contentHash: l.contentHash, fields: l.fields as ListingFields }, index);
      if (request.candidates.length > 0) inputTokens += estimateTokens(SYSTEM_PROMPT) + estimateTokens(JSON.stringify(buildUserPayload(request))) + 400;
    }
    return { listingRevisionId: l.id, skip: null };
  });
  const outputTokens = mode === "live" ? eligible * OUTPUT_TOKENS_PER_ITEM : 0;
  const pricing = { input: ws.inputPricePerMtok, output: ws.outputPricePerMtok };
  const estimate: UsageEstimate = {
    eligible,
    inputTokens,
    outputTokens,
    costUsd: mode === "demo" ? 0 : costOf(inputTokens, outputTokens, pricing),
    basis:
      mode === "demo"
        ? "Demo mode calls no provider, so it uses no tokens and has no cost."
        : `Estimate: about 3.5 characters per token for the instructions, product fields and candidates, plus ${OUTPUT_TOKENS_PER_ITEM} output tokens per listing. Model reasoning can add output tokens; actual usage is recorded per call.`,
  };
  const caps = { jobTokenCap: ws.jobTokenCap, jobSpendCapUsd: Number(ws.jobSpendCapUsd), dailySpendCapUsd: Number(ws.dailySpendCapUsd), jobItemCap: ws.jobItemCap, dailyCommittedUsd: await dailyCommittedUsd(tx) };
  const blockers: string[] = [];
  if (eligible === 0) blockers.push("No listing needs analysis: every active listing is reviewed or already has a current suggestion.");
  if (eligible > caps.jobItemCap) blockers.push(`${eligible} listings exceed the per-job limit of ${caps.jobItemCap}.`);
  if (mode === "live") {
    if (inputTokens + outputTokens > caps.jobTokenCap) blockers.push(`Estimated ${inputTokens + outputTokens} tokens exceed the per-job token cap of ${caps.jobTokenCap}.`);
    if (estimate.costUsd !== null && estimate.costUsd > caps.jobSpendCapUsd) blockers.push(`Estimated cost USD ${estimate.costUsd.toFixed(2)} exceeds the per-job spending cap of USD ${caps.jobSpendCapUsd.toFixed(2)}.`);
    if (estimate.costUsd !== null && caps.dailyCommittedUsd + estimate.costUsd > caps.dailySpendCapUsd) blockers.push(`Today's committed spend (USD ${caps.dailyCommittedUsd.toFixed(2)}) plus this estimate exceeds the daily workspace cap of USD ${caps.dailySpendCapUsd.toFixed(2)}.`);
  }
  return { ws, mode, provider, modelId: mode === "live" ? modelId : null, promptVersion: mode === "demo" ? FIXTURE_PROMPT_VERSION : CLAUDE_PROMPT_VERSION, revisionId: revision.id, taxonomyVersionId: ws.activeTaxonomyVersionId, items, estimate, caps, blockers };
}

const skipCounts = (items: Plan["items"]) => ({ skippedReviewed: items.filter((i) => i.skip === "already_reviewed").length, skippedUpToDate: items.filter((i) => i.skip === "up_to_date").length });

/** Shown before a job starts: what would run, the estimated usage and the caps (PRD section 16). */
export async function estimateAnalysis(actor: Actor, input: { catalogRevisionId: string }) {
  if (!can(actor.role, "analysis.run")) throw forbidden("Running analysis requires a taxonomist or administrator.");
  return withContext(actor, async (tx) => {
    const p = await plan(tx, actor, input.catalogRevisionId);
    return { mode: p.mode, provider: p.provider, modelId: p.modelId, isDemo: p.mode === "demo", activeListings: p.items.length, ...skipCounts(p.items), estimate: p.estimate, caps: p.caps, costKnown: p.estimate.costUsd !== null, blockers: p.blockers };
  });
}

/**
 * Queues a recommendation job for a merchant's current catalog revision and returns immediately.
 * The worker process claims the job, processes it item by item and records progress; nothing is
 * analyzed inside this request.
 */
export async function startAnalysis(actor: Actor, input: { catalogRevisionId: string }, requestId: string) {
  if (!can(actor.role, "analysis.run")) throw forbidden("Running analysis requires a taxonomist or administrator.");
  return withContext(actor, async (tx) => {
    // One active job per revision; also serialises budget reservation for the workspace.
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, actor.workspaceId)).for("update");
    const p = await plan(tx, actor, input.catalogRevisionId);
    const [active] = await tx.select({ id: analysisJobs.id }).from(analysisJobs).where(and(eq(analysisJobs.catalogRevisionId, p.revisionId), inArray(analysisJobs.status, ["queued", "running", "cancel_requested"])));
    if (active) throw conflict("An analysis job is already queued or running for this catalog revision.", { jobId: active.id });
    if (p.blockers.length > 0) {
      const budget = p.blockers.some((b) => /cap|limit/.test(b));
      throw new ApiError(budget ? "rate_limited" : "invalid", p.blockers[0], { fieldErrors: p.blockers.map((message) => ({ path: "analysis", message })) });
    }
    const skipped = skipCounts(p.items);
    const progress: AnalysisProgress = { total: p.items.length, pending: p.estimate.eligible, running: 0, succeeded: 0, failed: 0, canceled: 0, skippedNoFixture: 0, ...skipped };
    const [job] = await tx
      .insert(analysisJobs)
      .values({
        workspaceId: actor.workspaceId,
        catalogRevisionId: p.revisionId,
        taxonomyVersionId: p.taxonomyVersionId,
        providerMode: p.mode,
        provider: p.provider,
        modelId: p.modelId,
        dependencyVersions: { provider: p.provider, modelId: p.modelId, promptVersion: p.promptVersion, retrievalPolicy: RETRIEVAL_POLICY_VERSION, signalPolicy: SIGNAL_POLICY_VERSION, pricing: { input: p.ws.inputPricePerMtok, output: p.ws.outputPricePerMtok } },
        status: "queued",
        progress,
        estimate: p.estimate,
        reservedCostUsd: p.estimate.costUsd === null ? null : p.estimate.costUsd.toFixed(6),
        costUsd: p.mode === "demo" ? "0" : null,
        createdBy: actor.userId,
      })
      .returning({ id: analysisJobs.id });
    const rows = p.items.map((i) => ({ workspaceId: actor.workspaceId, jobId: job.id, listingRevisionId: i.listingRevisionId, status: i.skip ? ("skipped" as const) : ("pending" as const), errorCode: i.skip }));
    for (let i = 0; i < rows.length; i += 1000) await tx.insert(analysisJobItems).values(rows.slice(i, i + 1000));
    await recordAudit(tx, actor, requestId, { action: "analysis.start", entityType: "analysis_job", entityId: job.id, after: { catalogRevisionId: p.revisionId, taxonomyVersionId: p.taxonomyVersionId, provider: p.provider, modelId: p.modelId, demo: p.mode === "demo", eligible: p.estimate.eligible, estimate: p.estimate } });
    return { id: job.id, status: "queued" as const, provider: p.provider, isDemo: p.mode === "demo", progress, estimate: p.estimate };
  });
}

/** Recomputes a job's progress from its item rows, the single source of truth. */
export async function computeProgress(tx: Tx, jobId: string): Promise<AnalysisProgress> {
  const rows = await tx
    .select({ status: analysisJobItems.status, errorCode: analysisJobItems.errorCode, n: sql<number>`count(*)::int` })
    .from(analysisJobItems)
    .where(eq(analysisJobItems.jobId, jobId))
    .groupBy(analysisJobItems.status, analysisJobItems.errorCode);
  const p: AnalysisProgress = { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, canceled: 0, skippedReviewed: 0, skippedNoFixture: 0, skippedUpToDate: 0 };
  for (const r of rows) {
    p.total += r.n;
    if (r.status === "skipped") {
      if (r.errorCode === "not_fixture_content") p.skippedNoFixture += r.n;
      else if (r.errorCode === "up_to_date") p.skippedUpToDate += r.n;
      else p.skippedReviewed += r.n;
    } else p[r.status] += r.n;
  }
  return p;
}

type JobRow = typeof analysisJobs.$inferSelect;
function jobView(job: JobRow, progress: AnalysisProgress) {
  return {
    id: job.id,
    status: job.status,
    providerMode: job.providerMode,
    provider: job.provider,
    modelId: job.modelId,
    isDemo: job.providerMode === "demo",
    catalogRevisionId: job.catalogRevisionId,
    taxonomyVersionId: job.taxonomyVersionId,
    progress,
    estimate: job.estimate as UsageEstimate | null,
    usage: { inputTokens: job.inputTokens, outputTokens: job.outputTokens, costUsd: job.costUsd === null ? null : Number(job.costUsd) },
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    cancelRequested: job.cancelRequested,
    attempt: job.attempt,
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    heartbeatAt: job.heartbeatAt,
    finishedAt: job.finishedAt,
  };
}

export async function getAnalysisJob(actor: Actor, jobId: string) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, async (tx) => {
    const [job] = await tx.select().from(analysisJobs).where(eq(analysisJobs.id, jobId));
    if (!job) throw notFound("Analysis job");
    const failures = await tx
      .select({ listingRevisionId: analysisJobItems.listingRevisionId, title: listingRevisions.title, status: analysisJobItems.status, errorCode: analysisJobItems.errorCode, errorMessage: analysisJobItems.errorMessage, attempt: analysisJobItems.attempt })
      .from(analysisJobItems)
      .innerJoin(listingRevisions, eq(listingRevisions.id, analysisJobItems.listingRevisionId))
      .where(and(eq(analysisJobItems.jobId, jobId), eq(analysisJobItems.status, "failed")))
      .orderBy(listingRevisions.title)
      .limit(100);
    return { ...jobView(job, await computeProgress(tx, jobId)), failures, canManage: can(actor.role, "analysis.run") && (job.createdBy === actor.userId || actor.role === "administrator"), canRetry: can(actor.role, "analysis.run") };
  });
}

export async function latestAnalysisJob(actor: Actor, catalogRevisionId: string) {
  const [job] = await withContext(actor, (tx) => tx.select({ id: analysisJobs.id }).from(analysisJobs).where(eq(analysisJobs.catalogRevisionId, catalogRevisionId)).orderBy(desc(analysisJobs.createdAt)).limit(1));
  return job ? getAnalysisJob(actor, job.id) : null;
}

/**
 * Requests cancellation. A queued job that no worker holds is canceled at once; a running job is
 * flagged and the worker stops at the next item boundary. Completed items are kept either way.
 */
export async function cancelAnalysis(actor: Actor, jobId: string, requestId: string) {
  if (!can(actor.role, "analysis.run")) throw forbidden("Canceling analysis requires a taxonomist or administrator.");
  return withContext(actor, async (tx) => {
    const [job] = await tx.select().from(analysisJobs).where(eq(analysisJobs.id, jobId)).for("update");
    if (!job) throw notFound("Analysis job");
    if (job.createdBy !== actor.userId && actor.role !== "administrator") throw forbidden("Only the person who started this job or an administrator can cancel it.");
    if (!["queued", "running", "cancel_requested"].includes(job.status)) throw conflict(`This job is already ${job.status.replaceAll("_", " ")}.`, { status: job.status });
    const held = job.leaseExpiresAt !== null && job.leaseExpiresAt > new Date();
    if (held) {
      await tx.update(analysisJobs).set({ cancelRequested: true, status: "cancel_requested" }).where(eq(analysisJobs.id, jobId));
    } else {
      await tx.update(analysisJobItems).set({ status: "canceled", updatedAt: new Date() }).where(and(eq(analysisJobItems.jobId, jobId), inArray(analysisJobItems.status, ["pending", "running"])));
      await tx.update(analysisJobs).set({ cancelRequested: true, status: "canceled", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, progress: await computeProgress(tx, jobId) }).where(eq(analysisJobs.id, jobId));
    }
    await recordAudit(tx, actor, requestId, { action: "analysis.cancel", entityType: "analysis_job", entityId: jobId, before: { status: job.status }, after: { status: held ? "cancel_requested" : "canceled" } });
    return { id: jobId, status: held ? ("cancel_requested" as const) : ("canceled" as const) };
  });
}

/** Re-queues the failed items of a finished job. Succeeded and skipped items are not touched. */
export async function retryAnalysis(actor: Actor, jobId: string, requestId: string) {
  if (!can(actor.role, "analysis.run")) throw forbidden("Retrying analysis requires a taxonomist or administrator.");
  return withContext(actor, async (tx) => {
    const [job] = await tx.select().from(analysisJobs).where(eq(analysisJobs.id, jobId)).for("update");
    if (!job) throw notFound("Analysis job");
    if (!["partially_completed", "failed"].includes(job.status)) throw conflict(`Only a failed or partially completed job can be retried; this one is ${job.status.replaceAll("_", " ")}.`, { status: job.status });
    const [ws] = await tx.select({ active: workspaces.activeTaxonomyVersionId }).from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    const [revision] = await tx.select({ current: merchants.activeCatalogRevisionId }).from(catalogRevisions).innerJoin(merchants, eq(merchants.id, catalogRevisions.merchantId)).where(eq(catalogRevisions.id, job.catalogRevisionId));
    if (ws.active !== job.taxonomyVersionId || revision?.current !== job.catalogRevisionId) throw conflict("The taxonomy version or catalog revision changed since this job ran. Start a new analysis instead.");
    const retried = await tx
      .update(analysisJobItems)
      .set({ status: "pending", attempt: 0, errorCode: null, errorMessage: null, updatedAt: new Date() })
      .where(and(eq(analysisJobItems.jobId, jobId), eq(analysisJobItems.status, "failed")))
      .returning({ id: analysisJobItems.id });
    const progress = await computeProgress(tx, jobId);
    if (progress.pending === 0) throw conflict("This job has no failed or unprocessed items to retry.");
    await tx.update(analysisJobs).set({ status: "queued", cancelRequested: false, errorCode: null, errorMessage: null, leaseOwner: null, leaseExpiresAt: null, finishedAt: null, progress }).where(eq(analysisJobs.id, jobId));
    await recordAudit(tx, actor, requestId, { action: "analysis.retry", entityType: "analysis_job", entityId: jobId, before: { status: job.status }, after: { status: "queued", retriedItems: retried.length, pending: progress.pending } });
    return { id: jobId, status: "queued" as const, retriedItems: retried.length, progress };
  });
}
