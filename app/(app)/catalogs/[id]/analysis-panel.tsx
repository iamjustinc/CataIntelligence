"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge, buttonClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

interface Progress {
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
export interface JobView {
  id: string;
  status: "queued" | "running" | "partially_completed" | "completed" | "cancel_requested" | "canceled" | "failed";
  isDemo: boolean;
  provider: string | null;
  modelId: string | null;
  progress: Progress;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  failures: { listingRevisionId: string; title: string; errorCode: string | null; errorMessage: string | null }[];
  canManage: boolean;
  canRetry: boolean;
}
interface Estimate {
  mode: "demo" | "live";
  modelId: string | null;
  isDemo: boolean;
  activeListings: number;
  skippedReviewed: number;
  skippedUpToDate: number;
  estimate: { eligible: number; inputTokens: number; outputTokens: number; costUsd: number | null; basis: string };
  caps: { jobTokenCap: number; jobSpendCapUsd: number; dailySpendCapUsd: number; jobItemCap: number; dailyCommittedUsd: number };
  costKnown: boolean;
  blockers: string[];
}

const STATUS: Record<JobView["status"], string> = { queued: "Queued", running: "Running", partially_completed: "Partially completed", completed: "Completed", cancel_requested: "Cancel requested", canceled: "Canceled", failed: "Failed" };
const TONE: Record<JobView["status"], "neutral" | "ok" | "warn" | "danger" | "info"> = { queued: "info", running: "info", partially_completed: "warn", completed: "ok", cancel_requested: "warn", canceled: "neutral", failed: "danger" };
const ACTIVE = new Set(["queued", "running", "cancel_requested"]);
const usd = (n: number) => `USD ${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString("en-US");

export function AnalysisPanel({ revisionId, provider, canRun, job: initialJob, hasTaxonomy }: { revisionId: string; provider: { state: string; label: string; detail: string }; canRun: boolean; job: JobView | null; hasTaxonomy: boolean }) {
  const router = useRouter();
  const [job, setJob] = useState<JobView | null>(initialJob);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queuedFor, setQueuedFor] = useState(0);
  const key = useRef(crypto.randomUUID());
  const usable = provider.state === "demo" || provider.state === "live";
  const active = !!job && ACTIVE.has(job.status);
  const jobId = job?.id;

  // Poll real job state while it is queued or running; progress comes from the item rows.
  const refresh = useCallback(async () => {
    if (!jobId) return;
    try {
      const next = await api<JobView>(`/api/analysis-jobs/${jobId}`);
      setJob(next);
      if (!ACTIVE.has(next.status)) router.refresh();
    } catch {
      /* keep the last known state; the next poll retries */
    }
  }, [jobId, router]);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => {
      setQueuedFor(Math.round((Date.now() - started) / 1000));
      void refresh();
    }, 1500);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiClientError ? [err.message, ...err.fieldErrors.slice(1).map((f) => f.message)].join(" ") : fallback);

  async function prepare() {
    setError(null);
    setPending("estimate");
    try {
      setEstimate(await api<Estimate>("/api/analysis-jobs/estimate", { method: "POST", body: { catalogRevisionId: revisionId } }));
      key.current = crypto.randomUUID();
      setOpen(true);
    } catch (err) {
      fail(err, "The estimate could not be prepared.");
    } finally {
      setPending(null);
    }
  }
  async function start() {
    setPending("start");
    setError(null);
    try {
      const started = await api<{ id: string }>("/api/analysis-jobs", { method: "POST", idempotencyKey: key.current, body: { catalogRevisionId: revisionId } });
      setOpen(false);
      setQueuedFor(0);
      setJob(await api<JobView>(`/api/analysis-jobs/${started.id}`));
    } catch (err) {
      key.current = crypto.randomUUID();
      fail(err, "Analysis could not be started.");
    } finally {
      setPending(null);
    }
  }
  async function act(kind: "cancel" | "retry") {
    if (!job) return;
    setPending(kind);
    setError(null);
    try {
      await api(`/api/analysis-jobs/${job.id}/${kind}`, { method: "POST", body: {}, ...(kind === "retry" ? { idempotencyKey: crypto.randomUUID() } : {}) });
      setQueuedFor(0);
      setJob(await api<JobView>(`/api/analysis-jobs/${job.id}`));
    } catch (err) {
      fail(err, kind === "cancel" ? "The job could not be canceled." : "The job could not be retried.");
    } finally {
      setPending(null);
    }
  }

  const p = job?.progress;
  const processed = p ? p.total - p.pending - p.running : 0;
  const skipped = p ? p.skippedReviewed + p.skippedNoFixture + p.skippedUpToDate : 0;
  const e = estimate;
  return (
    <section aria-labelledby="analysis-heading" className="rounded-md border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="analysis-heading" className="mr-auto font-display text-lg font-medium">
          Suggestions
        </h2>
        <Badge tone={provider.state === "demo" ? "warn" : provider.state === "live" ? "ok" : provider.state === "unavailable" ? "danger" : "neutral"}>{provider.label}</Badge>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">
        {provider.state === "demo"
          ? "Demo mode produces deterministic, curated suggestions for seeded fixture listings only, and labels them as demo. Other uploaded products get no suggestion and stay available for manual mapping."
          : provider.state === "live"
            ? `Live mode sends bounded listing fields and candidate concepts to the configured model (${provider.detail.replace("Model ", "")}). Suggestions are proposals; a reviewer decides.`
            : `${provider.detail} Every listing can be mapped manually from the review queue.`}
      </p>

      {job && p ? (
        <div className="mt-4 rounded-sm border border-rule p-4" data-testid="analysis-job">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="eyebrow">Latest job</span>
            <Badge tone={TONE[job.status]}>{STATUS[job.status]}</Badge>
            {job.isDemo ? <Badge tone="warn">Demo fixtures</Badge> : <Badge tone="ok">Live · {job.modelId}</Badge>}
            <span className="ml-auto font-mono text-xs text-muted">{job.createdAt.slice(0, 16).replace("T", " ")} UTC</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label="Listings processed" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={processed}>
            <div className="h-full bg-ink transition-[width] duration-500" style={{ width: `${p.total ? (processed / p.total) * 100 : 0}%` }} />
          </div>
          <p role="status" aria-live="polite" className="mt-2 text-sm">
            <span className="font-mono">{processed}</span> of <span className="font-mono">{p.total}</span> listings processed
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ["Suggested", p.succeeded],
                ["Failed", p.failed],
                ["Skipped", skipped],
                ["Remaining", p.pending + p.running],
                ["Canceled", p.canceled],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="eyebrow">{label}</dt>
                <dd className="font-mono">{value}</dd>
              </div>
            ))}
            <div>
              <dt className="eyebrow">Provider usage</dt>
              <dd className="font-mono text-xs">
                {job.isDemo ? "None (demo)" : `${num(job.usage.inputTokens + job.usage.outputTokens)} tokens · ${job.usage.costUsd === null ? "cost unknown" : usd(job.usage.costUsd)}`}
              </dd>
            </div>
          </dl>
          {skipped > 0 ? (
            <p className="mt-2 text-xs text-muted">
              Skipped: {p.skippedReviewed} already reviewed, {p.skippedUpToDate} with a current suggestion, {p.skippedNoFixture} not fixture content (no demo suggestion exists for them).
            </p>
          ) : null}
          {job.status === "queued" && queuedFor >= 8 ? <p className="mt-2 text-sm text-warn">Still waiting for the worker process. Jobs run in the worker, which is started separately from the web server.</p> : null}
          {job.errorMessage ? (
            <p role="alert" className="mt-2 rounded-sm border border-danger/40 bg-danger-bg p-2 text-sm text-danger">
              {job.errorMessage} <span className="font-mono text-xs">({job.errorCode})</span>
            </p>
          ) : null}
          {job.failures.length > 0 ? (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer font-medium">
                {p.failed} listing{p.failed === 1 ? "" : "s"} failed analysis. They are not rejected: map them manually or retry.
              </summary>
              <ul className="mt-1 divide-y divide-rule rounded-sm border border-rule">
                {job.failures.map((f) => (
                  <li key={f.listingRevisionId} className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5">
                    <Link href={`/review/${f.listingRevisionId}`} className="underline decoration-rule-strong underline-offset-4">
                      {f.title}
                    </Link>
                    <span className="font-mono text-xs text-muted">{f.errorCode}</span>
                    <span className="text-xs text-ink-soft">{f.errorMessage}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {active && job.canManage ? (
              <button type="button" disabled={pending !== null || job.status === "cancel_requested"} onClick={() => act("cancel")} className={buttonClass.secondary}>
                {job.status === "cancel_requested" ? "Canceling…" : pending === "cancel" ? "Canceling…" : "Cancel job"}
              </button>
            ) : null}
            {job.canRetry && (job.status === "partially_completed" || job.status === "failed") && p.failed + p.pending > 0 && job.errorCode !== "stale_dependency" ? (
              <button type="button" disabled={pending !== null} onClick={() => act("retry")} className={buttonClass.secondary}>
                {pending === "retry" ? "Queueing…" : `Retry ${p.failed + p.pending} unfinished`}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {canRun && usable && !active ? (
        <button type="button" disabled={!hasTaxonomy || pending !== null} onClick={prepare} className={`${buttonClass.secondary} mt-4`}>
          {pending === "estimate" ? "Estimating…" : provider.state === "demo" ? (job ? "Run demo analysis again" : "Run demo analysis") : job ? "Run live analysis again" : "Run live analysis"}
        </button>
      ) : null}
      {canRun && usable && !hasTaxonomy ? <p className="mt-2 text-xs text-muted">Publish a taxonomy version first.</p> : null}
      {error && !open ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <ConfirmDialog open={open} title={e?.isDemo ? "Run demo analysis?" : "Run live analysis?"} confirmLabel={e?.isDemo ? "Run demo analysis" : "Run live analysis"} pending={pending === "start"} error={error} confirmDisabled={!e || e.blockers.length > 0} onConfirm={start} onClose={() => setOpen(false)}>
        {e ? (
          <div className="space-y-2">
            <p>
              <span className="font-mono">{e.estimate.eligible}</span> of {e.activeListings} active listings will be analyzed. Skipped: {e.skippedReviewed} already reviewed, {e.skippedUpToDate} with a current suggestion.
            </p>
            {e.isDemo ? (
              <p>Provider cost: none. Demo mode makes no model calls, so no token or spending cap applies.</p>
            ) : (
              <dl className="grid grid-cols-[11rem_1fr] gap-y-1 rounded-sm border border-rule p-3 text-ink">
                <dt className="text-muted">Model</dt>
                <dd className="font-mono text-xs">{e.modelId}</dd>
                <dt className="text-muted">Estimated tokens</dt>
                <dd className="font-mono text-xs">
                  {num(e.estimate.inputTokens)} in + {num(e.estimate.outputTokens)} out (cap {num(e.caps.jobTokenCap)})
                </dd>
                <dt className="text-muted">Estimated cost</dt>
                <dd className="font-mono text-xs">{e.estimate.costUsd === null ? "Unknown: no provider pricing is configured" : `${usd(e.estimate.costUsd)} (job cap ${usd(e.caps.jobSpendCapUsd)})`}</dd>
                <dt className="text-muted">Committed today</dt>
                <dd className="font-mono text-xs">
                  {usd(e.caps.dailyCommittedUsd)} of {usd(e.caps.dailySpendCapUsd)} daily cap
                </dd>
              </dl>
            )}
            <p className="text-xs text-muted">{e.estimate.basis}</p>
            {!e.isDemo ? <p className="text-xs text-muted">Caps are checked between batches of ten, so calls already in flight can exceed a cap by a small amount; actual usage is shown on the job.</p> : null}
            {e.blockers.length > 0 ? (
              <ul className="list-inside list-disc rounded-sm border border-danger/40 bg-danger-bg p-2 text-danger">
                {e.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
