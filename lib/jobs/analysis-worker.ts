/**
 * Durable processing of analysis jobs (PRD 12.2).
 *
 * A worker claims one job at a time through a lease, processes its items in batches, commits each
 * item's outcome in its own transaction, renews the lease as a heartbeat, and stops cleanly at
 * item boundaries for cancellation, lost leases, stale dependencies and budget limits. Another
 * worker can resume an abandoned job after the lease expires; finished items are never redone.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, withContext, type Tx } from "@/db/client";
import { aiUsage, analysisJobItems, analysisJobs, catalogRevisions, listingRevisions, merchants, reviewStates, workspaces } from "@/db/schema";
import { providerForJob, type ProviderResolution } from "@/lib/ai/factory";
import type { ProviderUsage, RecommendationProvider } from "@/lib/ai/provider";
import { validateRecommendation } from "@/lib/ai/validate-recommendation";
import type { ListingFields } from "@/lib/domain/catalog-validation";
import { buildRequest, computeProgress, costOf, dailyCommittedUsd, loadVersionIndex, SETTLED_STATES, storeRecommendation, type VersionIndex } from "@/lib/domain/analysis";

export const MAX_ATTEMPTS = 3;
export const BATCH_SIZE = 10;

export interface WorkerOptions {
  workerId: string;
  leaseSeconds: number;
  concurrency: number;
  /** Minimum pause between provider calls, to stay under provider rate limits. */
  itemDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Delay before retry number `attempt` (1-based) of a transient failure. */
  backoffMs: (attempt: number) => number;
  resolveProvider: (job: { providerMode: "off" | "demo" | "live"; modelId: string | null }) => ProviderResolution;
  /** Lets a graceful shutdown stop between items. */
  shouldStop: () => boolean;
  log: (event: string, extra?: Record<string, unknown>) => void;
}

/** Bounded exponential backoff with jitter: about 1s, 2s, then capped at 8s. */
export const defaultBackoffMs = (attempt: number) => Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);

export function defaultWorkerOptions(overrides: Partial<WorkerOptions> = {}): WorkerOptions {
  return {
    workerId: `worker-${randomUUID().slice(0, 8)}`,
    leaseSeconds: 60,
    concurrency: 2,
    itemDelayMs: 0,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    backoffMs: defaultBackoffMs,
    resolveProvider: providerForJob,
    shouldStop: () => false,
    log: () => undefined,
    ...overrides,
  };
}

export interface Claim {
  id: string;
  workspaceId: string;
}

/** Claims the next available job across workspaces. Returns only its ID and workspace. */
export async function claimNextJob(workerId: string, leaseSeconds: number): Promise<Claim | null> {
  const result = await db().execute<{ id: string; workspace_id: string }>(sql`select id, workspace_id from claim_analysis_job(${workerId}, ${leaseSeconds})`);
  const row = result.rows[0];
  return row ? { id: row.id, workspaceId: row.workspace_id } : null;
}

export type JobOutcome = "completed" | "partially_completed" | "failed" | "canceled" | "lost_lease" | "released";

interface ItemResult {
  status: "succeeded" | "failed" | "skipped";
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  usages: (ProviderUsage & { status: string; errorCode: string | null })[];
  /** A failure that makes continuing pointless (authentication or configuration). */
  fatal?: { code: string; message: string };
  payload?: { request: ReturnType<typeof buildRequest>; response: Parameters<typeof storeRecommendation>[1]["response"] };
}

const FAILURE_MESSAGES: Record<string, string> = {
  timeout: "The provider did not answer in time.",
  rate_limited: "The provider rate limit was reached.",
  overloaded: "The provider was overloaded.",
  network: "The provider could not be reached.",
  auth: "The provider rejected the server's credentials.",
  configuration: "The provider rejected the request configuration (for example the model ID).",
  refusal: "The model declined to answer for this listing.",
  truncated: "The model's answer was cut off before it finished.",
  stale_dependency: "The taxonomy version or catalog revision changed while the job was running.",
  budget_exceeded: "The job stopped at a configured token or spending cap.",
};

/** Calls the provider for one listing with the bounded retry policy. Performs no database writes. */
async function runItem(provider: RecommendationProvider, request: ReturnType<typeof buildRequest>, opts: WorkerOptions): Promise<ItemResult> {
  const usages: ItemResult["usages"] = [];
  let repaired = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await provider.recommend(request);
    if (result.ok) {
      const validated = validateRecommendation(request, result.payload);
      usages.push({ ...result.usage, status: validated.ok ? "succeeded" : "invalid_output", errorCode: validated.ok ? null : validated.code });
      if (validated.ok) return { status: "succeeded", errorCode: null, errorMessage: null, attempts: attempt, usages, payload: { request, response: validated.response } };
      // One repair attempt for an invalid answer, inside the overall attempt limit.
      if (repaired || attempt === MAX_ATTEMPTS) return { status: "failed", errorCode: validated.code, errorMessage: validated.message, attempts: attempt, usages };
      repaired = true;
      continue;
    }
    const { failure } = result;
    usages.push({ ...(result.usage ?? { inputTokens: null, outputTokens: null, latencyMs: 0 }), status: failure.kind, errorCode: failure.code });
    if (failure.kind === "no_fixture") return { status: "skipped", errorCode: "not_fixture_content", errorMessage: null, attempts: attempt, usages: [] };
    if (failure.kind === "fatal") {
      const message = FAILURE_MESSAGES[failure.code];
      return { status: "failed", errorCode: failure.code, errorMessage: message, attempts: attempt, usages, fatal: { code: failure.code, message } };
    }
    if (failure.kind === "refusal" || failure.kind === "truncated") return { status: "failed", errorCode: failure.kind, errorMessage: FAILURE_MESSAGES[failure.kind], attempts: attempt, usages };
    if (attempt === MAX_ATTEMPTS) return { status: "failed", errorCode: failure.code, errorMessage: FAILURE_MESSAGES[failure.code] ?? "The provider call failed.", attempts: attempt, usages };
    await opts.sleep(opts.backoffMs(attempt));
  }
  return { status: "failed", errorCode: "network", errorMessage: "The provider call failed.", attempts: MAX_ATTEMPTS, usages };
}

/**
 * Commits one item's outcome. Idempotent: an item that already reached a final state is left
 * alone, so a duplicate delivery or a second worker cannot create a second recommendation.
 */
async function commitItem(
  workspaceId: string,
  job: { id: string; runId: string; pricing: { input: string | null; output: string | null }; highEnabled: boolean; provider: RecommendationProvider; workerId: string },
  itemId: string,
  listingRevisionId: string,
  result: ItemResult,
): Promise<void> {
  await withContext({ workspaceId }, async (tx) => {
    // Lock order is always job, then item, so concurrent commits and cancellation cannot deadlock.
    // Only the worker that still holds the lease may write results.
    const [held] = await tx.select({ owner: analysisJobs.leaseOwner }).from(analysisJobs).where(eq(analysisJobs.id, job.id)).for("update");
    if (held?.owner !== job.workerId) return;
    const [item] = await tx.select().from(analysisJobItems).where(eq(analysisJobItems.id, itemId)).for("update");
    if (!item || item.status !== "running") return;

    let status = result.status;
    let errorCode = result.errorCode;
    let errorMessage = result.errorMessage;
    let recommendationId: string | null = null;
    if (result.status === "succeeded" && result.payload) {
      const stored = await storeRecommendation(tx, { workspaceId, request: result.payload.request, response: result.payload.response, provider: job.provider, runId: job.runId, jobId: job.id, highEnabled: job.highEnabled });
      if (stored.stale) {
        status = "failed";
        errorCode = "stale_dependency";
        errorMessage = FAILURE_MESSAGES.stale_dependency;
      } else recommendationId = stored.recommendationId;
    } else if (result.status === "failed") {
      await tx.update(reviewStates).set({ analysisFailed: true }).where(eq(reviewStates.listingRevisionId, listingRevisionId));
    }
    await tx.update(analysisJobItems).set({ status, errorCode, errorMessage, attempt: item.attempt + result.attempts, recommendationId, updatedAt: new Date() }).where(eq(analysisJobItems.id, itemId));

    let input = 0;
    let output = 0;
    let unknown = false;
    for (const u of result.usages) {
      const cost = job.provider.isDemo ? 0 : u.inputTokens === null || u.outputTokens === null ? null : costOf(u.inputTokens, u.outputTokens, job.pricing);
      if (cost === null) unknown = true;
      input += u.inputTokens ?? 0;
      output += u.outputTokens ?? 0;
      await tx.insert(aiUsage).values({
        workspaceId,
        runId: job.runId,
        jobId: job.id,
        listingRevisionId,
        purpose: "recommendation",
        provider: job.provider.id,
        modelId: job.provider.modelId,
        promptVersion: job.provider.promptVersion,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        // Unknown stays NULL: it is never recorded as zero.
        costEstimateUsd: cost === null ? null : cost.toFixed(6),
        status: u.status,
        errorCode: u.errorCode,
        latencyMs: u.latencyMs,
      });
    }
    if (result.usages.length > 0) {
      const added = unknown ? null : costOf(input, output, job.pricing);
      await tx
        .update(analysisJobs)
        .set({
          inputTokens: sql`${analysisJobs.inputTokens} + ${input}`,
          outputTokens: sql`${analysisJobs.outputTokens} + ${output}`,
          costUsd: job.provider.isDemo ? "0" : added === null ? sql`${analysisJobs.costUsd}` : sql`coalesce(${analysisJobs.costUsd}, 0) + ${added.toFixed(6)}`,
        })
        .where(eq(analysisJobs.id, job.id));
    }
  });
}

/** Marks every unprocessed item with one outcome and returns how many were changed. */
async function closeRemaining(tx: Tx, jobId: string, status: "canceled" | "failed", errorCode: string | null): Promise<number> {
  const rows = await tx
    .update(analysisJobItems)
    .set({ status, errorCode, errorMessage: errorCode ? (FAILURE_MESSAGES[errorCode] ?? null) : null, updatedAt: new Date() })
    .where(and(eq(analysisJobItems.jobId, jobId), inArray(analysisJobItems.status, ["pending", "running"])))
    .returning({ id: analysisJobItems.id });
  return rows.length;
}

async function finalize(tx: Tx, jobId: string, forced?: { status: "canceled" | "failed" | "partially_completed"; errorCode?: string; errorMessage?: string }): Promise<JobOutcome> {
  const progress = await computeProgress(tx, jobId);
  let status: "completed" | "partially_completed" | "failed" | "canceled";
  if (forced?.status === "canceled") status = "canceled";
  else if (!forced && progress.failed === 0 && progress.pending === 0) status = "completed";
  // Something went wrong: partial when at least one recommendation was produced, failed when none was.
  else status = progress.succeeded > 0 ? "partially_completed" : "failed";
  await tx
    .update(analysisJobs)
    .set({ status, progress, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, errorCode: forced?.errorCode ?? null, errorMessage: forced?.errorMessage ?? null })
    .where(eq(analysisJobs.id, jobId));
  return status;
}

/**
 * Processes a claimed job until it finishes, is canceled, loses its lease or the worker is asked
 * to stop. Safe to call again for the same job after a crash.
 */
export async function processJob(claim: Claim, opts: WorkerOptions): Promise<JobOutcome> {
  const ctx = { workspaceId: claim.workspaceId };
  const setup = await withContext(ctx, async (tx) => {
    const [job] = await tx.select().from(analysisJobs).where(eq(analysisJobs.id, claim.id));
    if (!job || job.leaseOwner !== opts.workerId) return null;
    // Items a previous worker had in flight when it stopped go back to pending.
    await tx.update(analysisJobItems).set({ status: "pending", updatedAt: new Date() }).where(and(eq(analysisJobItems.jobId, job.id), eq(analysisJobItems.status, "running")));
    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, claim.workspaceId));
    return { job, ws };
  });
  if (!setup) return "lost_lease";
  const { job } = setup;

  const resolved = opts.resolveProvider({ providerMode: job.providerMode, modelId: job.modelId });
  if (!resolved.ok) {
    opts.log("job_provider_unavailable", { jobId: job.id });
    // Pending items are kept so the job can be retried once the provider is configured.
    return withContext(ctx, (tx) => finalize(tx, job.id, { status: "failed", errorCode: resolved.code, errorMessage: resolved.message }));
  }
  const provider = resolved.provider;
  const pricing = (job.dependencyVersions as { pricing?: { input: string | null; output: string | null } }).pricing ?? { input: null, output: null };
  const runId = randomUUID();
  let index: VersionIndex | null = null;

  for (;;) {
    // Batch boundary: lease, cancellation, dependencies and budgets are all rechecked here.
    const gate = await withContext(ctx, async (tx) => {
      const [current] = await tx.select().from(analysisJobs).where(eq(analysisJobs.id, job.id)).for("update");
      if (!current || current.leaseOwner !== opts.workerId) return { stop: "lost_lease" as const };
      if (current.cancelRequested) {
        await closeRemaining(tx, job.id, "canceled", null);
        return { stop: await finalize(tx, job.id, { status: "canceled" }) };
      }
      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, claim.workspaceId));
      const [revision] = await tx.select({ current: merchants.activeCatalogRevisionId }).from(catalogRevisions).innerJoin(merchants, eq(merchants.id, catalogRevisions.merchantId)).where(eq(catalogRevisions.id, job.catalogRevisionId));
      if (ws.activeTaxonomyVersionId !== job.taxonomyVersionId || revision?.current !== job.catalogRevisionId) {
        await closeRemaining(tx, job.id, "failed", "stale_dependency");
        return { stop: await finalize(tx, job.id, { status: "partially_completed", errorCode: "stale_dependency", errorMessage: FAILURE_MESSAGES.stale_dependency }) };
      }
      if (!provider.isDemo) {
        const tokens = current.inputTokens + current.outputTokens;
        const spent = current.costUsd === null ? null : Number(current.costUsd);
        const overDaily = (await dailyCommittedUsd(tx)) - Math.max(Number(current.reservedCostUsd ?? 0) - (spent ?? 0), 0) >= Number(ws.dailySpendCapUsd);
        if (tokens >= ws.jobTokenCap || (spent !== null && spent >= Number(ws.jobSpendCapUsd)) || overDaily) {
          await closeRemaining(tx, job.id, "failed", "budget_exceeded");
          return { stop: await finalize(tx, job.id, { status: "partially_completed", errorCode: "budget_exceeded", errorMessage: FAILURE_MESSAGES.budget_exceeded }) };
        }
      }
      const batch = await tx
        .select({ itemId: analysisJobItems.id, listingRevisionId: listingRevisions.id, contentHash: listingRevisions.contentHash, fields: listingRevisions.normalizedJson, state: reviewStates.state, decisionId: reviewStates.latestDecisionId })
        .from(analysisJobItems)
        .innerJoin(listingRevisions, eq(listingRevisions.id, analysisJobItems.listingRevisionId))
        .innerJoin(reviewStates, eq(reviewStates.listingRevisionId, listingRevisions.id))
        .where(and(eq(analysisJobItems.jobId, job.id), eq(analysisJobItems.status, "pending")))
        .orderBy(asc(listingRevisions.sourceRow), asc(analysisJobItems.id))
        .limit(BATCH_SIZE);
      if (batch.length === 0) return { stop: await finalize(tx, job.id) };
      await tx.update(analysisJobItems).set({ status: "running", updatedAt: new Date() }).where(inArray(analysisJobItems.id, batch.map((b) => b.itemId)));
      // Heartbeat: renew the lease and publish progress.
      await tx.update(analysisJobs).set({ leaseExpiresAt: sql`now() + make_interval(secs => ${opts.leaseSeconds})`, heartbeatAt: new Date(), status: "running", progress: await computeProgress(tx, job.id) }).where(eq(analysisJobs.id, job.id));
      index ??= await loadVersionIndex(tx, job.taxonomyVersionId);
      return { batch, highEnabled: ws.highSignalEnabled };
    });
    if ("stop" in gate) return gate.stop!;

    const commitCtx = { id: job.id, runId, pricing, highEnabled: gate.highEnabled, provider, workerId: opts.workerId };
    let fatal: ItemResult["fatal"];
    const queue = [...gate.batch];
    const lane = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        if (fatal || opts.shouldStop()) return;
        // A reviewer may have settled the listing since the job was queued: do not spend a call on it.
        const settled = (SETTLED_STATES as readonly string[]).includes(item.state) || (item.state === "needs_investigation" && !!item.decisionId);
        const result: ItemResult = settled
          ? { status: "skipped", errorCode: "already_reviewed", errorMessage: null, attempts: 0, usages: [] }
          : await runItem(provider, buildRequest(claim.workspaceId, { id: item.listingRevisionId, contentHash: item.contentHash, fields: item.fields as ListingFields }, index!), opts);
        if (result.fatal) {
          fatal = result.fatal;
          return;
        }
        await commitItem(claim.workspaceId, commitCtx, item.itemId, item.listingRevisionId, result);
        if (opts.itemDelayMs > 0) await opts.sleep(opts.itemDelayMs);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, gate.batch.length)) }, lane));

    if (fatal) {
      // Authentication or configuration failure: stop at once and keep unprocessed items pending for a retry.
      opts.log("job_fatal", { jobId: job.id, code: fatal.code });
      return withContext(ctx, async (tx) => {
        await tx.update(analysisJobItems).set({ status: "pending", updatedAt: new Date() }).where(and(eq(analysisJobItems.jobId, job.id), eq(analysisJobItems.status, "running")));
        return finalize(tx, job.id, { status: "failed", errorCode: fatal!.code, errorMessage: fatal!.message });
      });
    }
    if (opts.shouldStop()) {
      // Graceful shutdown: hand the job back so another worker can continue immediately.
      await withContext(ctx, async (tx) => {
        await tx.update(analysisJobItems).set({ status: "pending", updatedAt: new Date() }).where(and(eq(analysisJobItems.jobId, job.id), eq(analysisJobItems.status, "running")));
        await tx.update(analysisJobs).set({ leaseExpiresAt: sql`now()`, progress: await computeProgress(tx, job.id) }).where(and(eq(analysisJobs.id, job.id), eq(analysisJobs.leaseOwner, opts.workerId)));
      });
      return "released";
    }
  }
}

/** Claims and processes jobs until none are available. Used by the seed and by tests. */
export async function drainJobs(overrides: Partial<WorkerOptions> = {}): Promise<{ jobId: string; outcome: JobOutcome }[]> {
  const opts = defaultWorkerOptions(overrides);
  const done: { jobId: string; outcome: JobOutcome }[] = [];
  for (let claim = await claimNextJob(opts.workerId, opts.leaseSeconds); claim; claim = await claimNextJob(opts.workerId, opts.leaseSeconds)) {
    done.push({ jobId: claim.id, outcome: await processJob(claim, opts) });
  }
  return done;
}
