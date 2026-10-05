"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { buttonClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import type { getReport, RunView } from "@/lib/domain/analytics";
import { ResultView } from "../../result-view";

type Report = Awaited<ReturnType<typeof getReport>>;
const message = (err: unknown) => (err instanceof ApiClientError ? (err.status === 403 ? "Your role does not allow this." : err.status === 404 ? "This report is no longer available to you." : err.message) : "Something went wrong. Try again.");

export function ReportView({ report }: { report: Report }) {
  const router = useRouter();
  const [refreshed, setRefreshed] = useState<RunView | null>(report.refreshed);
  const [pending, setPending] = useState<"refresh" | "share" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"share" | "delete" | null>(null);
  const [status, setStatus] = useState("");

  async function act(kind: "refresh" | "share" | "delete") {
    setPending(kind);
    setError(null);
    try {
      if (kind === "refresh") {
        setRefreshed(await api<RunView>(`/api/reports/${report.id}/refresh`, { method: "POST" }));
        setStatus("Refreshed with current data.");
      } else if (kind === "share") {
        await api(`/api/reports/${report.id}`, { method: "PATCH", body: { visibility: report.visibility === "workspace" ? "private" : "workspace", expectedVersion: report.lockVersion } });
        setConfirm(null);
        router.refresh();
      } else {
        await api(`/api/reports/${report.id}`, { method: "DELETE" });
        router.push("/analytics");
        router.refresh();
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(null);
    }
  }
  const snapshot = report.snapshot!;
  const sharing = report.visibility !== "workspace";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass.primary} disabled={pending !== null} onClick={() => void act("refresh")}>
          {pending === "refresh" ? "Refreshing…" : "Refresh with current data"}
        </button>
        {report.canShare ? (
          <button type="button" className={buttonClass.secondary} disabled={pending !== null} onClick={() => (setError(null), setConfirm("share"))}>
            {sharing ? "Share with workspace" : "Make private"}
          </button>
        ) : null}
        {report.mine ? (
          <button type="button" className={buttonClass.secondary} disabled={pending !== null} onClick={() => (setError(null), setConfirm("delete"))}>
            Delete report
          </button>
        ) : null}
        <span role="status" className="text-sm text-ok">
          {status}
        </span>
      </div>
      {report.mine && !report.canShare ? <p className="text-xs text-muted">Your role can save and refresh reports but cannot share them with the workspace.</p> : null}
      {error && !confirm ? (
        <p role="alert" className="rounded-sm border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {refreshed ? (
        <section aria-labelledby="refreshed-heading" className="space-y-2" data-testid="report-refreshed">
          <h2 id="refreshed-heading" className="eyebrow">
            Refreshed with current data · {refreshed.createdAt.slice(0, 16).replace("T", " ")} UTC
          </h2>
          <ResultView run={refreshed} heading={report.name} />
        </section>
      ) : null}

      <section aria-labelledby="snapshot-heading" className="space-y-2" data-testid="report-snapshot">
        <h2 id="snapshot-heading" className="eyebrow">
          Saved snapshot · as it was on {snapshot.createdAt.slice(0, 16).replace("T", " ")} UTC · not recomputed
        </h2>
        <ResultView run={snapshot} heading={report.name} />
      </section>

      <ConfirmDialog open={confirm === "share"} title={sharing ? "Share this report with the workspace?" : "Make this report private?"} confirmLabel={sharing ? "Share report" : "Make private"} pending={pending === "share"} error={error} onConfirm={() => void act("share")} onClose={() => setConfirm(null)}>
        {sharing
          ? "Every member of this workspace will be able to open, refresh and export this report, including its saved snapshot. Your conversation and other analyses stay private."
          : "Other members will no longer be able to open, refresh or export this report."}
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "delete"} title="Delete this report?" confirmLabel="Delete report" pending={pending === "delete"} error={error} onConfirm={() => void act("delete")} onClose={() => setConfirm(null)}>
        The report is removed for everyone it was shared with. The underlying analysis runs stay in your conversation history.
      </ConfirmDialog>
    </div>
  );
}
