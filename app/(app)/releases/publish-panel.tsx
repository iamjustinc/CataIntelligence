"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge, buttonClass, inputClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { STATE_LABELS, type ReviewState } from "@/lib/review-labels";

interface Preview {
  catalogRevision: { id: string; sequence: number } | null;
  taxonomyVersion: { id: string; sequence: number } | null;
  activeListings: number;
  mapped: number;
  unresolved: number;
  unresolvedByState: Partial<Record<ReviewState, number>>;
  blockers: string[];
  partial: boolean;
  changes: { added: number; changed: number; removed: number; unchanged: number };
  currentRelease: { releaseNumber: number } | null;
}

export function PublishPanel({ merchant, currentRelease }: { merchant: { id: string; name: string; revisionSequence: number; activeListings: number }; currentRelease: { releaseNumber: number; compatible: boolean } | null }) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState("");
  const key = useRef(crypto.randomUUID());

  async function load() {
    setLoading(true);
    setError(null);
    setDone("");
    try {
      setPreview(await api<Preview>("/api/releases/preview", { method: "POST", body: { merchantId: merchant.id } }));
      setAck(false);
      key.current = crypto.randomUUID();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The preview could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function publish() {
    if (!preview?.catalogRevision || !preview.taxonomyVersion) return;
    setPending(true);
    setError(null);
    try {
      const r = await api<{ releaseNumber: number }>("/api/releases", {
        method: "POST",
        idempotencyKey: key.current,
        body: { merchantId: merchant.id, catalogRevisionId: preview.catalogRevision.id, taxonomyVersionId: preview.taxonomyVersion.id, reason: reason.trim(), acknowledgePartial: ack, expectedMapped: preview.mapped, expectedUnresolved: preview.unresolved },
      });
      setOpen(false);
      setPreview(null);
      setReason("");
      setDone(`Published release ${r.releaseNumber} for ${merchant.name}.`);
      router.refresh();
    } catch (err) {
      const e = err instanceof ApiClientError ? err : null;
      // A conflict means the data moved since the preview: a new attempt needs a new preview and key.
      if (e?.status === 409) key.current = crypto.randomUUID();
      setError(e ? [e.message, ...e.fieldErrors.map((f) => f.message)].join(" ") + (e.status === 409 ? " Refresh the preview." : "") : "Publication failed. The previous release is still current.");
    } finally {
      setPending(false);
    }
  }

  const blocked = !!preview && preview.blockers.length > 0;
  const ready = !!preview && !blocked && reason.trim().length > 0 && (!preview.partial || ack);

  return (
    <section aria-label={`Publish ${merchant.name}`} className="rounded-md border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-display text-lg font-medium">{merchant.name}</h3>
        {currentRelease ? <Badge tone={currentRelease.compatible ? "ok" : "danger"}>{currentRelease.compatible ? `Current: release ${currentRelease.releaseNumber}` : `Release ${currentRelease.releaseNumber} is for an older catalog`}</Badge> : <Badge>No release yet</Badge>}
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        Catalog revision {merchant.revisionSequence} · <span className="font-mono">{merchant.activeListings}</span> active listings
      </p>
      <p role="status" aria-live="polite" className={done ? "mt-2 rounded-sm bg-ok-bg px-3 py-2 text-sm text-ok" : "sr-only"}>
        {done}
      </p>

      {!preview ? (
        <button type="button" onClick={load} disabled={loading} className={`${buttonClass.secondary} mt-3`}>
          {loading ? "Checking…" : "Preview release"}
        </button>
      ) : (
        <div className="mt-3 space-y-3 text-sm">
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-sm border border-rule bg-rule">
            {(
              [
                ["Mapped", preview.mapped],
                ["Unresolved", preview.unresolved],
                ["Active listings", preview.activeListings],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="bg-surface px-3 py-2">
                <dt className="eyebrow">{label}</dt>
                <dd className="font-display text-2xl">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-ink-soft">
            Bound to catalog revision {preview.catalogRevision?.sequence ?? "—"} and taxonomy v{preview.taxonomyVersion?.sequence ?? "—"}.{" "}
            {preview.currentRelease
              ? `Compared with release ${preview.currentRelease.releaseNumber}: ${preview.changes.added} added, ${preview.changes.changed} changed, ${preview.changes.removed} removed, ${preview.changes.unchanged} unchanged.`
              : `First release: ${preview.changes.added} mappings.`}
          </p>
          {preview.unresolved > 0 ? (
            <div>
              <h4 className="eyebrow">Unresolved, by reason</h4>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {(Object.entries(preview.unresolvedByState) as [ReviewState, number][]).map(([state, n]) => (
                  <li key={state}>
                    <Link href={`/review?merchant=${merchant.id}&state=${state}`} className="underline decoration-rule-strong underline-offset-4">
                      {STATE_LABELS[state]}
                    </Link>{" "}
                    <span className="font-mono">{n}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted">Unresolved listings stay in the coverage denominator. They are listed in the release&apos;s unresolved export.</p>
            </div>
          ) : null}
          {blocked ? (
            <div role="alert" className="rounded-sm border border-danger/40 bg-danger-bg p-3 text-danger">
              <p className="font-semibold">This release cannot be published yet</p>
              <ul className="mt-1 list-inside list-disc">
                {preview.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor={`reason-${merchant.id}`} className="mb-1 block font-medium">
                  Release reason <span className="text-stamp">required</span>
                </label>
                <input id={`reason-${merchant.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className={inputClass} />
              </div>
              {preview.partial ? (
                <label className="flex items-start gap-2 rounded-sm border border-warn/40 bg-warn-bg p-3 text-warn">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-stamp)]" />
                  <span>
                    I understand this is a partial release: {preview.unresolved} of {preview.activeListings} active listings are not mapped, so published coverage will be below 100%.
                  </span>
                </label>
              ) : null}
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!ready} onClick={() => { setError(null); setOpen(true); }} className={buttonClass.primary}>
              Publish {preview.partial ? "partial " : ""}release
            </button>
            <button type="button" onClick={load} disabled={loading} className={buttonClass.secondary}>
              {loading ? "Checking…" : "Refresh preview"}
            </button>
          </div>
        </div>
      )}
      {error && !open ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <ConfirmDialog open={open} title={`Publish release for ${merchant.name}?`} confirmLabel="Publish release" pending={pending} error={error} onConfirm={publish} onClose={() => setOpen(false)}>
        <p>
          {preview?.mapped} mapping{preview?.mapped === 1 ? "" : "s"} become the current published release. {preview?.partial ? `${preview.unresolved} listings stay unresolved. ` : ""}The release is immutable; later changes need a new release.
        </p>
      </ConfirmDialog>
    </section>
  );
}
