// A placeholder so live mode resolves as configured. It is never sent anywhere: every test below
// replaces the provider with a deterministic script.
process.env.ANTHROPIC_API_KEY = "sk-test-placeholder-not-a-real-key";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as cancelRoute } from "@/app/api/analysis-jobs/[id]/cancel/route";
import { POST as retryRoute } from "@/app/api/analysis-jobs/[id]/retry/route";
import { GET as jobRoute } from "@/app/api/analysis-jobs/[id]/route";
import { POST as estimateRoute } from "@/app/api/analysis-jobs/estimate/route";
import { POST as startRoute } from "@/app/api/analysis-jobs/route";
import { GET as itemRoute } from "@/app/api/review-items/[id]/route";
import { closeDb, db, withContext } from "@/db/client";
import { analysisJobs } from "@/db/schema";
import { buildFixtures, catalogCsv, WALKTHROUGH_CSV } from "@/fixtures/generate";
import type { ProviderResult, RecommendationProvider, RecommendationRequest } from "@/lib/ai/provider";
import { cancelAnalysis } from "@/lib/domain/analysis";
import { revalidateDependencies } from "@/lib/domain/proposals";
import { recordDecision } from "@/lib/domain/review";
import { claimNextJob, defaultWorkerOptions, drainJobs, processJob, type WorkerOptions } from "@/lib/jobs/analysis-worker";
import { actorFor, adminClient, createTestWorkspace, ctx, idemKey, request, type TestWorkspace } from "../setup/helpers";
import { conceptIds, FAST, FIXTURE_TAXONOMY, importCatalog, listingIds, publishTaxonomy, runAnalysis } from "../setup/scenario";

let admin: pg.Client;
let ws: TestWorkspace;
let other: TestWorkspace;
const harbor = buildFixtures().catalogs["harbor-market"];
let merchantSeq = 0;

type Role = keyof TestWorkspace["cookie"];
type Script = (req: RecommendationRequest, call: number) => ProviderResult | Promise<ProviderResult>;

/** A well-formed answer choosing the top retrieved candidate, with real excerpts as evidence. */
const good = (req: RecommendationRequest, tokens = { inputTokens: 400, outputTokens: 50 }): ProviderResult => {
  const top = req.candidates[0];
  return {
    ok: true,
    usage: { ...tokens, latencyMs: 5 },
    payload: {
      listingRevisionId: req.listingRevisionId,
      taxonomyVersionId: req.taxonomyVersionId,
      selectedConceptId: top?.conceptId ?? null,
      alternatives: [],
      evidence: top ? top.evidence.filter((e) => e.field !== "merchant_category_path").map((e) => ({ field: e.field, excerpt: e.excerpt, supportsConceptId: top.conceptId })) : [],
      explanation: "Scripted test answer.",
      ambiguityFlags: [],
      missingInformation: top ? [] : ["No candidates."],
      proposedConcept: null,
    },
  };
};
const transient = (code: "rate_limited" | "timeout" = "rate_limited"): ProviderResult => ({ ok: false, failure: { kind: "transient", code }, usage: null });

/** Deterministic provider: the script decides each call's outcome; nothing touches the network. */
function scripted(script: Script) {
  const calls: string[] = [];
  const perListing = new Map<string, number>();
  const provider: RecommendationProvider = {
    id: "claude",
    isDemo: false,
    modelId: "test-model",
    promptVersion: "test-prompt",
    async recommend(req) {
      const n = (perListing.get(req.listingRevisionId) ?? 0) + 1;
      perListing.set(req.listingRevisionId, n);
      calls.push(req.product.title);
      return script(req, n);
    },
  };
  return { provider, calls, options: (extra: Partial<WorkerOptions> = {}): Partial<WorkerOptions> => ({ ...FAST, concurrency: 1, resolveProvider: () => ({ ok: true, provider }), ...extra }) };
}

const start = (revisionId: string, role: Role = "taxonomist", w = ws) => startRoute(request("/api/analysis-jobs", { method: "POST", cookie: w.cookie[role], body: { catalogRevisionId: revisionId }, headers: { "idempotency-key": idemKey("job") } }));
const startId = async (revisionId: string) => (await (await start(revisionId)).json()).data.id as string;
const job = async (id: string, role: Role = "viewer", w = ws) => (await (await jobRoute(request(`/api/analysis-jobs/${id}`, { cookie: w.cookie[role] }), ctx(id))).json()).data;
const retry = (id: string, role: Role = "taxonomist") => retryRoute(request(`/api/analysis-jobs/${id}/retry`, { method: "POST", cookie: ws.cookie[role], body: {}, headers: { "idempotency-key": idemKey("retry") } }), ctx(id));
const cancel = (id: string, role: Role = "taxonomist") => cancelRoute(request(`/api/analysis-jobs/${id}/cancel`, { method: "POST", cookie: ws.cookie[role], body: {} }), ctx(id));
const count = async (sql: string, params: unknown[]) => (await admin.query(`select count(*)::int as n from ${sql}`, params)).rows[0].n as number;
const itemStatuses = async (jobId: string) => Object.fromEntries((await admin.query("select coalesce(error_code, status::text) as k, count(*)::int as n from analysis_job_items where job_id = $1 group by 1", [jobId])).rows.map((r) => [r.k, r.n]));
/** A new merchant with `n` fixture listings that all have retrievable candidates. */
async function freshCatalog(n: number, from = 0) {
  return importCatalog(ws, { merchantName: `Job Merchant ${++merchantSeq}`, content: catalogCsv(harbor.slice(from, from + n)) });
}

beforeAll(async () => {
  admin = await adminClient();
  ws = await createTestWorkspace(admin, "jobs");
  other = await createTestWorkspace(admin, "jobs-other");
  await publishTaxonomy(ws);
  // Live mode with administrator opt-in and a configured model. Pricing is added per test.
  await admin.query("update workspaces set provider_mode = 'live', live_ai_opt_in = true, ai_model_id = 'test-model' where id = $1", [ws.id]);
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

describe("queueing, estimates and permissions", () => {
  let revisionId: string;
  it("shows estimated usage before starting and reports unknown cost as unknown, not zero", async () => {
    ({ revisionId } = await freshCatalog(6));
    const estimate = (role: Role = "taxonomist") => estimateRoute(request("/api/analysis-jobs/estimate", { method: "POST", cookie: ws.cookie[role], body: { catalogRevisionId: revisionId } }));
    expect((await estimate("viewer")).status).toBe(403);
    const unknown = (await (await estimate()).json()).data;
    expect(unknown).toMatchObject({ mode: "live", provider: "claude", modelId: "test-model", isDemo: false, activeListings: 6, costKnown: false, blockers: [] });
    expect(unknown.estimate.eligible).toBe(6);
    expect(unknown.estimate.inputTokens).toBeGreaterThan(1000);
    expect(unknown.estimate.costUsd).toBeNull();

    await admin.query("update workspaces set input_price_per_mtok = 4, output_price_per_mtok = 20 where id = $1", [ws.id]);
    const priced = (await (await estimate()).json()).data;
    expect(priced.costKnown).toBe(true);
    expect(priced.estimate.costUsd).toBeCloseTo((priced.estimate.inputTokens * 4 + priced.estimate.outputTokens * 20) / 1e6, 6);
  });
  it("queues a job without processing anything, allows one active job per revision and enforces roles", async () => {
    expect((await start(revisionId, "viewer")).status).toBe(403);
    expect((await start(revisionId, "analyst")).status).toBe(403);
    const res = await start(revisionId);
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(data).toMatchObject({ status: "queued", isDemo: false, provider: "claude", progress: { total: 6, pending: 6, succeeded: 0 } });
    expect(await count("recommendations where job_id = $1", [data.id])).toBe(0);
    expect((await start(revisionId)).status).toBe(409);
    // Another workspace cannot see, cancel or retry the job.
    expect((await jobRoute(request(`/api/analysis-jobs/${data.id}`, { cookie: other.cookie.administrator }), ctx(data.id))).status).toBe(404);
    expect((await cancelRoute(request(`/api/analysis-jobs/${data.id}/cancel`, { method: "POST", cookie: other.cookie.administrator, body: {} }), ctx(data.id))).status).toBe(404);
    // Without a workspace context the application role sees no job rows at all.
    expect(await db().select().from(analysisJobs)).toHaveLength(0);
  });
  it("processes the job in the worker with per-item outcomes, actual usage and cost", async () => {
    const s = scripted((req) => good(req));
    const [done] = await drainJobs(s.options());
    expect(done.outcome).toBe("completed");
    const j = await job(done.jobId);
    expect(j).toMatchObject({ status: "completed", provider: "claude", modelId: "test-model", isDemo: false, progress: { total: 6, pending: 0, running: 0, succeeded: 6, failed: 0 }, usage: { inputTokens: 2400, outputTokens: 300 } });
    expect(j.usage.costUsd).toBeCloseTo((2400 * 4 + 300 * 20) / 1e6, 6);
    expect(s.calls).toHaveLength(6);
    const recs = (await admin.query("select distinct provider, is_demo, model_id, prompt_version from recommendations where job_id = $1", [done.jobId])).rows;
    expect(recs).toEqual([{ provider: "claude", is_demo: false, model_id: "test-model", prompt_version: "test-prompt" }]);
    expect(await count("ai_usage where job_id = $1 and input_tokens = 400 and cost_estimate_usd is not null", [done.jobId])).toBe(6);
    // A second job has nothing to do: every listing already has a current suggestion.
    const again = await start(revisionId);
    expect(again.status).toBe(422);
    expect((await again.json()).error.message).toMatch(/No listing needs analysis/);
  });
  it("records unknown cost as NULL when no pricing is configured", async () => {
    await admin.query("update workspaces set input_price_per_mtok = null, output_price_per_mtok = null where id = $1", [ws.id]);
    const { revisionId: r } = await freshCatalog(2, 6);
    const id = await startId(r);
    await drainJobs(scripted((req) => good(req)).options());
    const j = await job(id);
    expect(j.usage).toEqual({ inputTokens: 800, outputTokens: 100, costUsd: null });
    expect(await count("ai_usage where job_id = $1 and cost_estimate_usd is null", [id])).toBe(2);
    expect(await count("ai_usage where job_id = $1 and cost_estimate_usd = 0", [id])).toBe(0);
  });
});

describe("retries, invalid output and failures", () => {
  let jobId: string;
  let titles: string[];
  const sleeps: number[] = [];
  it("retries transient failures with backoff up to three attempts, repairs invalid output once, and never retries refusals or truncation", async () => {
    const { revisionId } = await freshCatalog(6, 8);
    titles = harbor.slice(8, 14).map((r) => r.title);
    jobId = await startId(revisionId);
    const s = scripted((req, call) => {
      const i = titles.indexOf(req.product.title);
      if (i === 0) return call < 3 ? transient("rate_limited") : good(req); // succeeds on the third attempt
      if (i === 1) return transient("timeout"); // never succeeds
      if (i === 2) return call === 1 ? { ok: true, payload: { not: "the contract" }, usage: { inputTokens: 300, outputTokens: 10, latencyMs: 1 } } : good(req); // repaired
      if (i === 3) return { ok: true, payload: { ...(good(req) as { payload: object }).payload, selectedConceptId: "99999999-9999-4999-8999-999999999999" }, usage: { inputTokens: 300, outputTokens: 10, latencyMs: 1 } }; // invalid twice
      if (i === 4) return { ok: false, failure: { kind: "refusal", code: "refusal" }, usage: { inputTokens: 200, outputTokens: 0, latencyMs: 1 } };
      return { ok: false, failure: { kind: "truncated", code: "max_tokens" }, usage: { inputTokens: 200, outputTokens: 16000, latencyMs: 1 } };
    });
    const [done] = await drainJobs(s.options({ sleep: async (ms) => void sleeps.push(ms), backoffMs: (attempt) => attempt * 100 }));
    expect(done.outcome).toBe("partially_completed");
    const callsFor = (i: number) => s.calls.filter((t) => t === titles[i]).length;
    expect([0, 1, 2, 3, 4, 5].map(callsFor)).toEqual([3, 3, 2, 2, 1, 1]);
    // Backoff only between transient attempts: two waits each for the two transient listings.
    expect(sleeps).toEqual([100, 200, 100, 200]);
    const j = await job(jobId);
    expect(j.progress).toMatchObject({ total: 6, succeeded: 2, failed: 4, pending: 0 });
    expect(j.failures.map((f: { title: string; errorCode: string }) => [titles.indexOf(f.title), f.errorCode]).sort()).toEqual([[1, "timeout"], [3, "unknown_concept"], [4, "refusal"], [5, "truncated"]]);
    // A failed analysis is not a rejected product: the listing stays reviewable and is flagged as failed analysis.
    expect(await count("review_states rs join analysis_job_items i on i.listing_revision_id = rs.listing_revision_id where i.job_id = $1 and rs.analysis_failed and rs.state = 'needs_analysis'", [jobId])).toBe(4);
    expect(await count("recommendations where job_id = $1", [jobId])).toBe(2);
    // Every provider call is recorded, including failed ones and their token usage.
    expect(await count("ai_usage where job_id = $1", [jobId])).toBe(12);
    expect(await count("ai_usage where job_id = $1 and status = 'truncated' and output_tokens = 16000", [jobId])).toBe(1);
  });
  it("retries only the failed items, on request from an authorized user", async () => {
    expect((await retry(jobId, "viewer")).status).toBe(403);
    const res = await retry(jobId);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: "queued", retriedItems: 4, progress: { pending: 4, succeeded: 2 } });
    const s = scripted((req) => good(req));
    const [done] = await drainJobs(s.options());
    expect(done).toEqual({ jobId, outcome: "completed" });
    expect(s.calls.sort()).toEqual([1, 3, 4, 5].map((i) => titles[i]).sort());
    expect((await job(jobId)).progress).toMatchObject({ succeeded: 6, failed: 0 });
    expect(await count("recommendations where job_id = $1", [jobId])).toBe(6);
    expect(await count("review_states rs join analysis_job_items i on i.listing_revision_id = rs.listing_revision_id where i.job_id = $1 and rs.analysis_failed", [jobId])).toBe(0);
    expect((await retry(jobId)).status).toBe(409);
  });
  it("stops immediately on an authentication failure, keeps the remaining items and resumes on retry", async () => {
    const { revisionId } = await freshCatalog(5, 14);
    const id = await startId(revisionId);
    let n = 0;
    const failing = scripted((req) => (++n <= 2 ? good(req) : { ok: false, failure: { kind: "fatal", code: "auth" }, usage: null }));
    const [done] = await drainJobs(failing.options());
    expect(done.outcome).toBe("partially_completed");
    expect(failing.calls).toHaveLength(3); // no further calls after the fatal one
    const j = await job(id);
    expect(j).toMatchObject({ status: "partially_completed", errorCode: "auth", progress: { succeeded: 2, pending: 3, failed: 0 } });
    expect(j.errorMessage).toMatch(/credentials/);
    expect((await retry(id)).status).toBe(200);
    await drainJobs(scripted((req) => good(req)).options());
    expect(await job(id)).toMatchObject({ status: "completed", errorCode: null, progress: { succeeded: 5, pending: 0 } });
  });
  it("retries a job the provider rejected for its configuration with the model the workspace has now", async () => {
    // Found on the hosted site: after an invalid model ID was corrected in Settings, Retry reused the rejected one.
    const { revisionId } = await freshCatalog(2, 40);
    const id = await startId(revisionId);
    const seen: (string | null)[] = [];
    const rejecting = scripted(() => ({ ok: false, failure: { kind: "fatal", code: "configuration" }, usage: null }));
    const [done] = await drainJobs(rejecting.options({ resolveProvider: (j) => (seen.push(j.modelId), { ok: true, provider: rejecting.provider }) }));
    expect(done.outcome).toBe("failed");
    expect(await job(id)).toMatchObject({ status: "failed", errorCode: "configuration", modelId: "test-model" });
    await admin.query("update workspaces set ai_model_id = 'corrected-model' where id = $1", [ws.id]);
    try {
      expect((await retry(id)).status).toBe(200);
      const fixed = scripted((req) => good(req));
      await drainJobs(fixed.options({ resolveProvider: (j) => (seen.push(j.modelId), { ok: true, provider: fixed.provider }) }));
      expect(seen).toEqual(["test-model", "corrected-model"]);
      expect(await job(id)).toMatchObject({ status: "completed", modelId: "corrected-model", progress: { succeeded: 2, pending: 0 } });
    } finally {
      await admin.query("update workspaces set ai_model_id = 'test-model' where id = $1", [ws.id]);
    }
  });
  it("fails the job, without demo fallback, when the provider is unavailable at processing time", async () => {
    const { revisionId } = await freshCatalog(3, 19);
    const id = await startId(revisionId);
    const [done] = await drainJobs({ ...FAST, resolveProvider: () => ({ ok: false, code: "provider_unavailable", message: "The server has no provider API key. Manual mapping is available." }) });
    expect(done.outcome).toBe("failed");
    expect(await job(id)).toMatchObject({ status: "failed", errorCode: "provider_unavailable", progress: { pending: 3, succeeded: 0 } });
    expect(await count("recommendations where job_id = $1", [id])).toBe(0);
    await cancelAnalysis(await actorFor(ws, "administrator"), id, "test").catch(() => undefined);
  });
});

describe("cancellation", () => {
  it("cancels a queued job at once and refuses to cancel a finished one", async () => {
    const { revisionId } = await freshCatalog(3, 22);
    const id = await startId(revisionId);
    // Started by the taxonomist: another member without ownership cannot cancel, an administrator can.
    await admin.query("update analysis_jobs set created_by = $2 where id = $1", [id, ws.userId.administrator]);
    expect((await cancel(id, "taxonomist")).status).toBe(403);
    expect((await cancel(id, "viewer")).status).toBe(403);
    const res = await cancel(id, "administrator");
    expect((await res.json()).data.status).toBe("canceled");
    expect(await itemStatuses(id)).toEqual({ canceled: 3 });
    expect(await claimNextJob("nobody", 60)).toBeNull();
    expect((await cancel(id, "administrator")).status).toBe(409);
  });
  it("stops a running job at the next item boundary and preserves completed work", async () => {
    const { revisionId } = await freshCatalog(25, 30);
    const id = await startId(revisionId);
    const owner = await actorFor(ws, "taxonomist");
    let n = 0;
    const s = scripted(async (req) => {
      if (++n === 13) expect((await cancelAnalysis(owner, id, "test")).status).toBe("cancel_requested");
      return good(req);
    });
    const [done] = await drainJobs(s.options());
    expect(done.outcome).toBe("canceled");
    // The batch in flight finishes (20 items = two batches of ten); the third batch never starts.
    expect(s.calls).toHaveLength(20);
    const j = await job(id);
    expect(j).toMatchObject({ status: "canceled", cancelRequested: true, progress: { succeeded: 20, canceled: 5, pending: 0, running: 0 } });
    expect(await count("recommendations where job_id = $1", [id])).toBe(20);
    expect(await count("review_states rs join analysis_job_items i on i.listing_revision_id = rs.listing_revision_id where i.job_id = $1 and rs.state = 'suggested'", [id])).toBe(20);
    expect(await count("audit_events where action = 'analysis.cancel' and entity_id = $1", [id])).toBe(1);
  });
});

describe("leases, restart recovery and idempotent processing", () => {
  it("resumes after a worker dies: another worker takes over when the lease expires and finished items are not redone", async () => {
    const { revisionId } = await freshCatalog(15, 56);
    const id = await startId(revisionId);
    let n = 0;
    const dying = scripted((req) => {
      if (++n === 13) throw new Error("worker process killed");
      return good(req);
    });
    const a = defaultWorkerOptions(dying.options({ workerId: "worker-a" }));
    const claim = (await claimNextJob("worker-a", 60))!;
    expect(claim.id).toBe(id);
    await expect(processJob(claim, a)).rejects.toThrow("worker process killed");
    // The dead worker left the job running with items in flight and a live lease.
    expect(await job(id)).toMatchObject({ status: "running", progress: { succeeded: 12, running: 3 } });
    expect(await claimNextJob("worker-b", 60)).toBeNull();

    await admin.query("update analysis_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [id]);
    const resumed = scripted((req) => good(req));
    const [done] = await drainJobs(resumed.options({ workerId: "worker-b" }));
    expect(done).toEqual({ jobId: id, outcome: "completed" });
    expect(resumed.calls).toHaveLength(3);
    expect(await job(id)).toMatchObject({ status: "completed", attempt: 2, progress: { succeeded: 15, running: 0, pending: 0 } });
    // Exactly one recommendation per listing: no duplicate effects from the two workers.
    const dup = await admin.query("select listing_revision_id from recommendations where job_id = $1 group by 1 having count(*) > 1", [id]);
    expect(dup.rowCount).toBe(0);
    expect(await count("recommendations where job_id = $1", [id])).toBe(15);
  });
  it("discards a late result from a worker that lost its lease", async () => {
    const { revisionId } = await freshCatalog(3, 72);
    const id = await startId(revisionId);
    let n = 0;
    const slow = scripted(async (req) => {
      // While worker A waits on the provider, its lease is taken over by worker B.
      if (++n === 2) await admin.query("update analysis_jobs set lease_owner = 'worker-b' where id = $1", [id]);
      return good(req);
    });
    const claim = (await claimNextJob("worker-a", 60))!;
    expect(await processJob(claim, defaultWorkerOptions(slow.options({ workerId: "worker-a" })))).toBe("lost_lease");
    // Only the result committed before the takeover exists; the late ones were not written.
    expect(await count("recommendations where job_id = $1", [id])).toBe(1);
    await admin.query("update analysis_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [id]);
    await drainJobs(scripted((req) => good(req)).options({ workerId: "worker-b" }));
    expect(await count("recommendations where job_id = $1", [id])).toBe(3);
    expect((await job(id)).status).toBe("completed");
  });
});

describe("human decisions always win over late AI results (AT09)", () => {
  it("stores a recommendation that arrives after a human approval as history only, and skips listings already settled", async () => {
    const { revisionId } = await freshCatalog(4, 76);
    const L = await listingIds(admin, revisionId);
    const C = await conceptIds(admin, ws.id);
    const skus = Object.keys(L).sort();
    const reviewer = await actorFor(ws, "taxonomist");
    const id = await startId(revisionId);
    // Settled before the worker reaches it: no provider call is spent on it.
    await recordDecision(reviewer, L[skus[3]], { action: "defer", reason: "Later.", expectedVersion: 0 }, "test");
    const firstTitle = harbor.find((r) => r.sku === skus[0])!.title;
    const s = scripted(async (req) => {
      // The reviewer approves a different concept while this listing's provider call is in flight.
      if (req.product.title === firstTitle) await recordDecision(reviewer, L[skus[0]], { action: "approve", selectedConceptId: C["GM-OFF-PAPER"], expectedVersion: 0 }, "test");
      return good(req);
    });
    await drainJobs(s.options());
    expect(s.calls).toHaveLength(3);
    expect(await itemStatuses(id)).toEqual({ succeeded: 3, already_reviewed: 1 });
    const state = (await admin.query("select rs.state, c.stable_key, d.origin from review_states rs join review_decisions d on d.id = rs.latest_decision_id join concepts c on c.id = d.selected_concept_id where rs.listing_revision_id = $1", [L[skus[0]]])).rows[0];
    expect(state).toEqual({ state: "approved", stable_key: "GM-OFF-PAPER", origin: "manual" });
    // The late recommendation is kept as inspectable history; it did not replace the decision.
    const { data } = await (await itemRoute(request(`/api/review-items/${L[skus[0]]}`, { cookie: ws.cookie.viewer }), ctx(L[skus[0]]))).json();
    expect(data.review.state).toBe("approved");
    expect(data.recommendationHistory).toHaveLength(1);
    expect(data.recommendationHistory[0]).toMatchObject({ provider: "claude", isDemo: false, current: true });
    expect(data.history).toHaveLength(1);
  });
});

describe("stale dependencies and budgets", () => {
  it("stops when the taxonomy version changes mid-run; stale results are not stored and the job cannot be retried", async () => {
    const { revisionId } = await freshCatalog(21, 80);
    const id = await startId(revisionId);
    let n = 0;
    const s = scripted(async (req) => {
      if (++n === 5) await publishTaxonomy(ws, `${FIXTURE_TAXONOMY}JOB-NEW,GM,Job Test Leaf,Added during a running job.,,active,true\n`);
      return good(req);
    });
    const [done] = await drainJobs(s.options());
    expect(done.outcome).toBe("partially_completed");
    expect(s.calls).toHaveLength(10); // the first batch finishes; later batches never start
    const j = await job(id);
    expect(j).toMatchObject({ status: "partially_completed", errorCode: "stale_dependency", progress: { total: 21, succeeded: 4, failed: 17, pending: 0 } });
    // Answers that returned after the publication were bound to the old version and were not stored.
    expect(await count("recommendations where job_id = $1", [id])).toBe(4);
    expect(await itemStatuses(id)).toEqual({ succeeded: 4, stale_dependency: 17 });
    const res = await retry(id);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/Start a new analysis/);
    await revalidateDependencies(await actorFor(ws, "administrator"), "test");
  });
  it("refuses to start beyond the configured caps and stops at a cap during the run", async () => {
    await admin.query("update workspaces set input_price_per_mtok = 4, output_price_per_mtok = 20, job_item_cap = 5 where id = $1", [ws.id]);
    const big = await freshCatalog(8, 0);
    const tooMany = await start(big.revisionId);
    expect(tooMany.status).toBe(429);
    expect((await tooMany.json()).error.message).toMatch(/exceed the per-job limit of 5/);
    await admin.query("update workspaces set job_item_cap = 5000, job_token_cap = 1000 where id = $1", [ws.id]);
    expect((await (await start(big.revisionId)).json()).error.message).toMatch(/exceed the per-job token cap of 1000/);
    await admin.query("update workspaces set job_token_cap = 400000, daily_spend_cap_usd = 0.0001 where id = $1", [ws.id]);
    expect((await (await start(big.revisionId)).json()).error.message).toMatch(/daily workspace cap/);
    expect(await count("analysis_jobs where catalog_revision_id = $1", [big.revisionId])).toBe(0);

    // Caps are enforced again at batch boundaries with actual usage.
    await admin.query("update workspaces set daily_spend_cap_usd = 20 where id = $1", [ws.id]);
    const { revisionId } = await freshCatalog(25, 30);
    const id = await startId(revisionId);
    await admin.query("update workspaces set job_token_cap = 5000 where id = $1", [ws.id]);
    const s = scripted((req) => good(req, { inputTokens: 500, outputTokens: 100 }));
    const [done] = await drainJobs(s.options());
    expect(done.outcome).toBe("partially_completed");
    expect(s.calls).toHaveLength(10); // 10 calls = 6,000 tokens, over the 5,000 cap at the next boundary
    expect(await job(id)).toMatchObject({ status: "partially_completed", errorCode: "budget_exceeded", progress: { succeeded: 10, failed: 15 }, usage: { inputTokens: 5000, outputTokens: 1000 } });
    await admin.query("update workspaces set job_token_cap = 400000 where id = $1", [ws.id]);
    expect((await retry(id)).status).toBe(200);
    await drainJobs(scripted((req) => good(req)).options());
    expect((await job(id)).status).toBe("completed");
  });
});

describe("history is kept across taxonomy versions and re-analysis", () => {
  it("keeps earlier recommendations inspectable, adds new ones and never overwrites a human decision", async () => {
    const demo = await createTestWorkspace(admin, "jobs-history");
    await publishTaxonomy(demo);
    const { revisionId } = await importCatalog(demo, { merchantName: "Pier Pantry", content: WALKTHROUGH_CSV, resolutions: { "PP-004": 5 } });
    const L = await listingIds(admin, revisionId);
    expect((await runAnalysis(demo, revisionId)).outcome).toBe("completed");
    const reviewer = await actorFor(demo, "taxonomist");
    await recordDecision(reviewer, L["PP-001"], { action: "approve", expectedVersion: 1 }, "test");
    const before = (await admin.query("select id from recommendations where workspace_id = $1 order by id", [demo.id])).rows.map((r) => r.id);
    expect(before).toHaveLength(9);

    await publishTaxonomy(demo, `${FIXTURE_TAXONOMY}HIST-NEW,GM,History Leaf,Added to create version 2.,,active,true\n`);
    await revalidateDependencies(await actorFor(demo, "administrator"), "test");
    // Nothing was deleted: the version 1 recommendations are all still stored.
    expect((await admin.query("select id from recommendations where workspace_id = $1 order by id", [demo.id])).rows.map((r) => r.id)).toEqual(before);
    const stale = (await (await itemRoute(request(`/api/review-items/${L["PP-002"]}`, { cookie: demo.cookie.viewer }), ctx(L["PP-002"]))).json()).data;
    expect(stale.review.state).toBe("needs_analysis");
    expect(stale.recommendation).toMatchObject({ stale: true });
    expect(stale.recommendation.evidence.length).toBeGreaterThan(0);

    const second = await runAnalysis(demo, revisionId);
    expect(second.outcome).toBe("completed");
    const jobRow = (await admin.query("select progress from analysis_jobs where id = $1", [second.jobId])).rows[0].progress;
    expect(jobRow).toMatchObject({ succeeded: 8, skippedReviewed: 1 });
    expect(await count("recommendations where workspace_id = $1", [demo.id])).toBe(17);
    const after = (await (await itemRoute(request(`/api/review-items/${L["PP-002"]}`, { cookie: demo.cookie.viewer }), ctx(L["PP-002"]))).json()).data;
    expect(after.review.state).toBe("suggested");
    expect(after.recommendation.stale).toBe(false);
    expect(after.recommendationHistory.map((r: { taxonomySequence: number; stale: boolean; current: boolean }) => [r.taxonomySequence, r.stale, r.current])).toEqual([[2, false, true], [1, true, false]]);
    // The human decision on PP-001 was revalidated, not replaced, and no new recommendation was made for it.
    const approved = (await (await itemRoute(request(`/api/review-items/${L["PP-001"]}`, { cookie: demo.cookie.viewer }), ctx(L["PP-001"]))).json()).data;
    expect(approved.review.state).toBe("approved");
    expect(approved.history.map((h: { origin: string }) => h.origin)).toEqual(["suggestion", "revalidated"]);
    expect(approved.recommendationHistory).toHaveLength(1);
    await withContext({ workspaceId: demo.id }, async () => undefined);
  });
});
