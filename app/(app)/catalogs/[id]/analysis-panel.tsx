"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge, buttonClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

interface Progress {
  total: number;
  succeeded: number;
  failed: number;
  skippedReviewed: number;
  skippedNoFixture: number;
}
export interface JobView {
  id: string;
  status: string;
  progress: Progress;
  createdAt: string;
}

const STATUS: Record<string, string> = { queued: "Queued", running: "Running", partially_completed: "Partially completed", completed: "Completed", cancel_requested: "Cancel requested", canceled: "Canceled", failed: "Failed" };

export function AnalysisPanel({ revisionId, activeListings, provider, canRun, job, hasTaxonomy }: { revisionId: string; activeListings: number; provider: { state: string; label: string; detail: string }; canRun: boolean; job: JobView | null; hasTaxonomy: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const demo = provider.state === "demo";

  async function run() {
    setPending(true);
    setError(null);
    try {
      await api("/api/analysis-jobs", { method: "POST", idempotencyKey: key.current, body: { catalogRevisionId: revisionId } });
      setOpen(false);
      router.refresh();
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(err instanceof ApiClientError ? err.message : "Analysis could not be started.");
    } finally {
      setPending(false);
    }
  }

  const p = job?.progress;
  return (
    <section aria-labelledby="analysis-heading" className="rounded-md border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="analysis-heading" className="mr-auto font-display text-lg font-medium">
          Suggestions
        </h2>
        <Badge tone={demo ? "warn" : provider.state === "live" ? "ok" : provider.state === "unavailable" ? "danger" : "neutral"}>{provider.label}</Badge>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">
        {demo
          ? "Demo mode produces deterministic, curated suggestions for seeded fixture listings only, and labels them as demo. Other uploaded products get no suggestion and stay available for manual mapping."
          : `${provider.detail} Every listing can be mapped manually from the review queue.`}
      </p>
      {job && p ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
          <div>
            <dt className="eyebrow">Last run</dt>
            <dd>{STATUS[job.status] ?? job.status}</dd>
          </div>
          <div>
            <dt className="eyebrow">Suggested</dt>
            <dd className="font-mono">{p.succeeded}</dd>
          </div>
          <div>
            <dt className="eyebrow">Failed</dt>
            <dd className="font-mono">{p.failed}</dd>
          </div>
          <div>
            <dt className="eyebrow">Skipped: reviewed</dt>
            <dd className="font-mono">{p.skippedReviewed}</dd>
          </div>
          <div>
            <dt className="eyebrow">Skipped: not fixture</dt>
            <dd className="font-mono">{p.skippedNoFixture}</dd>
          </div>
        </dl>
      ) : null}
      {canRun && demo ? (
        <button
          type="button"
          disabled={!hasTaxonomy}
          onClick={() => {
            key.current = crypto.randomUUID();
            setError(null);
            setOpen(true);
          }}
          className={`${buttonClass.secondary} mt-4`}
        >
          {job ? "Run demo analysis again" : "Run demo analysis"}
        </button>
      ) : null}
      {canRun && demo && !hasTaxonomy ? <p className="mt-2 text-xs text-muted">Publish a taxonomy version first.</p> : null}
      <ConfirmDialog open={open} title="Run demo analysis?" confirmLabel="Run demo analysis" pending={pending} error={error} onConfirm={run} onClose={() => setOpen(false)}>
        <p>
          {activeListings} active listing{activeListings === 1 ? "" : "s"} in the current revision will be checked against the curated fixtures. Listings that already have a reviewer decision are skipped.
        </p>
        <p className="mt-2">Provider cost: none. Demo mode makes no model calls, so no spending cap applies.</p>
      </ConfirmDialog>
    </section>
  );
}
