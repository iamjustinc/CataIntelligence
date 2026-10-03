"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { inputClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

const KINDS = [
  ["zip", "ZIP (all files)"],
  ["mapping", "Mappings CSV"],
  ["unresolved", "Unresolved CSV"],
  ["metadata", "Metadata JSON"],
] as const;
const linkButton = "text-left text-sm font-semibold text-stamp underline underline-offset-4 disabled:opacity-60";

export function ReleaseRowActions({ release, canActivate }: { release: { id: string; releaseNumber: number; isCurrent: boolean; compatible: boolean; pointerLock: number; revisionSequence: number }; canActivate: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [alsoCatalog, setAlsoCatalog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef(crypto.randomUUID());

  async function exportFile(kind: string) {
    setBusy(kind);
    setMessage(null);
    try {
      const created = await api<{ downloadUrl: string; fileName: string; rowCounts: { mappings: number; unresolved: number } }>(`/api/releases/${release.id}/exports`, { method: "POST", body: { kind } });
      setMessage({ ok: true, text: `${created.fileName}: ${created.rowCounts.mappings} mappings, ${created.rowCounts.unresolved} unresolved.` });
      // Navigating to the authorized URL starts the download; the page stays where it is.
      window.location.assign(created.downloadUrl);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiClientError ? err.message : "The export failed." });
    } finally {
      setBusy(null);
    }
  }

  async function activate() {
    if (!reason.trim()) return setError("Give a reason for changing the current release.");
    setPending(true);
    setError(null);
    try {
      await api(`/api/releases/${release.id}/activate`, { method: "POST", idempotencyKey: key.current, body: { expectedVersion: release.pointerLock, activateCatalogRevision: alsoCatalog, reason: reason.trim() } });
      setOpen(false);
      router.refresh();
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(err instanceof ApiClientError ? `${err.message}${err.status === 409 && release.compatible ? " Reload the page." : ""}` : "The current release could not be changed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <span className="eyebrow">Export</span>
      {KINDS.map(([kind, label]) => (
        <button key={kind} type="button" disabled={busy !== null} onClick={() => exportFile(kind)} className={linkButton} aria-label={`Export release ${release.releaseNumber}: ${label}`}>
          {busy === kind ? "Preparing…" : label}
        </button>
      ))}
      {canActivate && !release.isCurrent ? (
        <button
          type="button"
          onClick={() => {
            key.current = crypto.randomUUID();
            setError(null);
            setOpen(true);
          }}
          className={`${linkButton} mt-2`}
        >
          Make current (rollback)
        </button>
      ) : null}
      <p role="status" aria-live="polite" className={`max-w-[14rem] text-xs ${message?.ok === false ? "text-danger" : "text-ok"}`}>
        {message?.text}
      </p>
      <ConfirmDialog open={open} title={`Make release ${release.releaseNumber} current?`} confirmLabel="Make current" pending={pending} error={error} onConfirm={activate} onClose={() => setOpen(false)}>
        <p>The current-release pointer moves to release {release.releaseNumber}. No release is deleted, and the change is recorded in the audit log.</p>
        {!release.compatible ? (
          <label className="mt-3 flex items-start gap-2 rounded-sm border border-warn/40 bg-warn-bg p-3 text-warn">
            <input type="checkbox" checked={alsoCatalog} onChange={(e) => setAlsoCatalog(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-stamp)]" />
            <span>
              This release was made from catalog revision {release.revisionSequence}, not the merchant&apos;s current revision. Also make catalog revision {release.revisionSequence} current. Without this the rollback is blocked.
            </span>
          </label>
        ) : null}
        <label htmlFor={`activate-reason-${release.id}`} className="mt-3 mb-1 block font-medium text-ink">
          Reason
        </label>
        <input id={`activate-reason-${release.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className={inputClass} />
      </ConfirmDialog>
    </div>
  );
}
