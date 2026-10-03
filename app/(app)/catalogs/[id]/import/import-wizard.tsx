"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Badge, buttonClass, Card, inputClass, StatePanel } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

const FIELDS = [
  ["merchant_sku", "Merchant SKU", true],
  ["title", "Title", true],
  ["description", "Description", false],
  ["merchant_category_path", "Merchant category path", false],
  ["brand", "Brand", false],
  ["gtin", "GTIN", false],
  ["package_size", "Package size", false],
  ["price", "Price", false],
  ["currency", "Currency", false],
] as const;
type Field = (typeof FIELDS)[number][0];
type ColumnMap = Partial<Record<Field, string>>;

interface ImportView {
  id: string;
  status: "staged" | "validated" | "failed" | "committed" | "expired";
  mode: "snapshot" | "delta";
  fileName: string;
  existing: boolean;
  resultRevisionId: string | null;
  columnMap: ColumnMap;
  resolutions: Record<string, number>;
  summary: {
    header: string[];
    mappingErrors: string[];
    counts: { input: number; accepted: number; rejected: number; collapsed: number };
    issueCount: number;
    issues: { row: number; sku: string | null; field: string | null; code: string; message: string }[];
    conflicts: { sku: string; selectedRow: number | null; rows: { row: number; title: string; description: string | null; price: string | null }[] }[];
    preview: { row: number; fields: { sku: string; title: string; merchantCategoryPath: string | null; brand: string | null; packageSize: string | null; price: string | null; currency: string | null } }[];
  };
}

const MAX_BYTES = 10 * 1024 * 1024;

export function CatalogImportWizard({ merchantId, hasCatalog }: { merchantId: string; hasCatalog: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"snapshot" | "delta">("snapshot");
  const [busy, setBusy] = useState<"uploading" | "validating" | "committing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportView | null>(null);
  const [map, setMap] = useState<ColumnMap>({});
  const [acceptExcluded, setAcceptExcluded] = useState(false);
  const fileRef = useRef<{ name: string; content: string } | null>(null);
  const commitKey = useRef(crypto.randomUUID());

  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiClientError ? [err.message, ...err.fieldErrors.map((f) => f.message)].join(" ") : fallback);

  async function upload(createNewRevision = false) {
    const file = fileRef.current;
    if (!file || busy) return;
    setBusy("uploading");
    setError(null);
    try {
      const staged = await api<ImportView>("/api/imports", { method: "POST", body: { merchantId, fileName: file.name, content: file.content, mode, createNewRevision } });
      setJob(staged);
      setMap(staged.columnMap);
      setAcceptExcluded(false);
      commitKey.current = crypto.randomUUID();
    } catch (err) {
      fail(err, "Upload failed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function onFile(file: File | undefined) {
    setJob(null);
    setError(null);
    fileRef.current = null;
    if (!file) return;
    if (file.size === 0) return setError("The file is empty.");
    if (file.size > MAX_BYTES) return setError("The file is larger than the 10 MB catalog limit.");
    try {
      fileRef.current = { name: file.name, content: new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()) };
    } catch {
      return setError("The file is not valid UTF-8. Re-export it as UTF-8 CSV and try again.");
    }
    await upload();
  }

  async function validate(nextMap: ColumnMap, resolutions: Record<string, number>) {
    if (!job || busy) return;
    setBusy("validating");
    setError(null);
    try {
      const updated = await api<ImportView>(`/api/imports/${job.id}/mapping`, { method: "PUT", body: { columnMap: nextMap, resolutions } });
      setJob(updated);
      setMap(updated.columnMap);
      setAcceptExcluded(false);
    } catch (err) {
      fail(err, "Validation failed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!job || busy) return;
    setBusy("committing");
    setError(null);
    try {
      await api(`/api/imports/${job.id}/commit`, { method: "POST", idempotencyKey: commitKey.current, body: { acceptExcluded } });
      router.push(`/catalogs/${merchantId}`);
      router.refresh();
    } catch (err) {
      commitKey.current = crypto.randomUUID();
      fail(err, "Commit failed. Try again.");
      setBusy(null);
    }
  }

  const s = job?.summary;
  const mapDirty = !!job && JSON.stringify(map) !== JSON.stringify(job.columnMap);
  const unresolvedConflicts = s?.conflicts.filter((c) => c.selectedRow === null).length ?? 0;
  const canCommit = !!job && job.status === "validated" && !mapDirty && (s!.counts.rejected === 0 || acceptExcluded);

  return (
    <div className="space-y-6">
      <Card className="rise rise-1 p-5">
        <h2 className="font-display text-lg font-medium">1. File and revision mode</h2>
        <fieldset className="mt-3 grid gap-3 sm:grid-cols-2" disabled={busy !== null || !!job}>
          <legend className="sr-only">Revision mode</legend>
          {(
            [
              ["snapshot", "Snapshot", "The file is the merchant's whole catalog. Earlier SKUs missing from it become inactive in the new revision."],
              ["delta", "Delta", "The file adds or updates the SKUs it contains. Earlier listings are carried forward; nothing is removed."],
            ] as const
          ).map(([value, label, help]) => (
            <label key={value} className={`flex cursor-pointer gap-3 rounded-sm border p-3 text-sm ${mode === value ? "border-ink bg-sunken/50" : "border-rule-strong"} ${value === "delta" && !hasCatalog ? "opacity-60" : ""}`}>
              <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setMode(value)} disabled={value === "delta" && !hasCatalog} className="mt-1 accent-[var(--color-stamp)]" />
              <span>
                <span className="font-medium">{label}</span>
                {value === "snapshot" ? <span className="text-muted"> (default)</span> : null}
                <span className="mt-0.5 block text-ink-soft">{help}</span>
                {value === "delta" && !hasCatalog ? <span className="mt-0.5 block text-xs text-muted">Available after the first catalog revision.</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label htmlFor="catalog-file" className="sr-only">
            Catalog CSV file
          </label>
          <input
            id="catalog-file"
            type="file"
            accept=".csv,text/csv"
            disabled={busy !== null}
            onChange={(e) => onFile(e.target.files?.[0])}
            className="block max-w-full text-sm file:mr-3 file:rounded-sm file:border file:border-rule-strong file:bg-surface file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink hover:file:bg-sunken"
          />
          <span role="status" aria-live="polite" className="text-sm text-muted">
            {busy === "uploading" ? "Uploading and validating…" : busy === "validating" ? "Validating…" : ""}
          </span>
        </div>
        {error && !job ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Card>

      {job?.existing && job.status === "committed" ? (
        <StatePanel
          kind="stale"
          title="This file was already imported"
          action={
            <div className="flex flex-wrap gap-2">
              <Link href={`/catalogs/${merchantId}`} className={buttonClass.secondary}>
                View catalog
              </Link>
              <button type="button" className={buttonClass.secondary} onClick={() => upload(true)} disabled={busy !== null}>
                Create a new revision anyway
              </button>
            </div>
          }
        >
          The same file was committed for this merchant in {job.mode} mode. No new revision was created.
        </StatePanel>
      ) : null}

      {job && s && job.status !== "committed" ? (
        <>
          <Card className="rise p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-display text-lg font-medium">2. Map columns</h2>
              <span className="font-mono text-xs text-muted">
                {job.fileName} · {job.mode}
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-soft">Match your file&apos;s columns to catalog fields. SKU and title are required. Original values are always kept alongside the normalized ones.</p>
            <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {FIELDS.map(([field, label, required]) => (
                <div key={field}>
                  <label htmlFor={`map-${field}`} className="mb-1 block text-sm font-medium">
                    {label} {required ? <span className="text-stamp">required</span> : null}
                  </label>
                  <select id={`map-${field}`} value={map[field] ?? ""} onChange={(e) => setMap((m) => ({ ...m, [field]: e.target.value || undefined }))} className={inputClass}>
                    <option value="">Not provided</option>
                    {s.header.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            {s.mappingErrors.length > 0 && !mapDirty ? (
              <ul role="alert" className="mt-4 list-inside list-disc text-sm text-danger">
                {s.mappingErrors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-4 flex items-center gap-3">
              <button type="button" onClick={() => validate(map, job.resolutions)} disabled={busy !== null || !mapDirty} className={buttonClass.secondary}>
                Apply mapping and validate
              </button>
              {mapDirty ? <span className="text-sm text-warn">Mapping changed. Validate again before committing.</span> : null}
            </div>
          </Card>

          {s.mappingErrors.length === 0 ? (
            <Card className="rise overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3">
                <h2 className="font-display text-lg font-medium">3. Validation summary</h2>
                {s.counts.accepted === 0 ? <Badge tone="danger">No valid rows</Badge> : s.counts.rejected > 0 ? <Badge tone="warn">Rows excluded</Badge> : <Badge tone="ok">All rows valid</Badge>}
              </div>
              <dl className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
                {(
                  [
                    ["Input rows", s.counts.input],
                    ["Accepted", s.counts.accepted],
                    ["Rejected", s.counts.rejected],
                    ["Collapsed duplicates", s.counts.collapsed],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="bg-surface px-5 py-3">
                    <dt className="eyebrow">{label}</dt>
                    <dd className="mt-1 font-display text-2xl">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="border-t border-rule px-5 py-2 font-mono text-xs text-muted">
                {s.counts.input} input = {s.counts.accepted} accepted + {s.counts.rejected} rejected + {s.counts.collapsed} collapsed
              </p>

              {s.conflicts.length > 0 ? (
                <div className="border-t border-rule px-5 py-4">
                  <h3 className="font-medium">Conflicting rows that share a SKU</h3>
                  <p className="mt-1 text-sm text-ink-soft">Choose the row to keep for each SKU, or correct the file. Unselected rows are excluded.</p>
                  {s.conflicts.map((c) => (
                    <fieldset key={c.sku} className="mt-3 rounded-sm border border-rule p-3">
                      <legend className="px-1 font-mono text-xs">{c.sku}</legend>
                      {c.rows.map((r) => (
                        <label key={r.row} className="flex cursor-pointer items-start gap-2 py-1 text-sm">
                          <input type="radio" name={`conflict-${c.sku}`} checked={c.selectedRow === r.row} disabled={busy !== null} onChange={() => validate(job.columnMap, { ...job.resolutions, [c.sku]: r.row })} className="mt-1 accent-[var(--color-stamp)]" />
                          <span>
                            <span className="font-mono text-xs text-muted">Row {r.row}</span> {r.title}
                            {r.description ? <span className="text-muted"> · {r.description}</span> : null}
                            {r.price ? <span className="text-muted"> · {r.price}</span> : null}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ))}
                </div>
              ) : null}

              {s.issues.length > 0 ? (
                <div className="overflow-x-auto border-t border-rule">
                  <table className="w-full text-left text-sm">
                    <caption className="px-5 py-2 text-left text-xs text-muted">
                      Rejected rows.{s.issueCount > s.issues.length ? ` Showing the first ${s.issues.length} of ${s.issueCount} problems.` : ""}
                    </caption>
                    <thead className="border-y border-rule bg-sunken/60">
                      <tr className="eyebrow [&>th]:px-5 [&>th]:py-2 [&>th]:font-normal">
                        <th scope="col">Row</th>
                        <th scope="col">SKU</th>
                        <th scope="col">Field</th>
                        <th scope="col">Problem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
                      {s.issues.map((issue, i) => (
                        <tr key={i} className="[&>td]:px-5 [&>td]:py-2 [&>td]:align-top">
                          <td className="font-mono text-xs">{issue.row}</td>
                          <td className="font-mono text-xs">{issue.sku ?? "—"}</td>
                          <td className="font-mono text-xs">{issue.field ?? "—"}</td>
                          <td className="text-ink-soft">{issue.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {s.preview.length > 0 ? (
                <div className="overflow-x-auto border-t border-rule">
                  <table className="w-full text-left text-sm">
                    <caption className="px-5 py-2 text-left text-xs text-muted">Preview of the first {s.preview.length} accepted rows, after normalization.</caption>
                    <thead className="border-y border-rule bg-sunken/60">
                      <tr className="eyebrow [&>th]:px-5 [&>th]:py-2 [&>th]:font-normal">
                        <th scope="col">Row</th>
                        <th scope="col">SKU</th>
                        <th scope="col">Title</th>
                        <th scope="col">Category path</th>
                        <th scope="col">Brand</th>
                        <th scope="col">Size</th>
                        <th scope="col">Price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
                      {s.preview.map((p) => (
                        <tr key={p.row} className="[&>td]:px-5 [&>td]:py-2">
                          <td className="font-mono text-xs">{p.row}</td>
                          <td className="font-mono text-xs">{p.fields.sku}</td>
                          <td>{p.fields.title}</td>
                          <td className="text-ink-soft">{p.fields.merchantCategoryPath ?? "—"}</td>
                          <td className="text-ink-soft">{p.fields.brand ?? "—"}</td>
                          <td className="text-ink-soft">{p.fields.packageSize ?? "—"}</td>
                          <td className="font-mono text-xs">{p.fields.price ? `${p.fields.price} ${p.fields.currency}` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <div className="space-y-3 border-t border-rule px-5 py-4">
                <h3 className="font-display text-lg font-medium">4. Commit</h3>
                {s.counts.accepted === 0 ? (
                  <StatePanel kind="error" title="There are no valid rows to commit">
                    Fix the problems listed above and upload the file again. Nothing was saved.
                  </StatePanel>
                ) : (
                  <>
                    {s.counts.rejected > 0 ? (
                      <label className="flex items-start gap-2 rounded-sm border border-warn/40 bg-warn-bg p-3 text-sm text-warn">
                        <input type="checkbox" checked={acceptExcluded} onChange={(e) => setAcceptExcluded(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-stamp)]" />
                        <span>
                          Exclude {s.counts.rejected} rejected row{s.counts.rejected === 1 ? "" : "s"} and commit the {s.counts.accepted} valid row{s.counts.accepted === 1 ? "" : "s"}.
                          {unresolvedConflicts > 0 ? ` ${unresolvedConflicts} conflicting SKU${unresolvedConflicts === 1 ? " has" : "s have"} no selected row and will be left out entirely.` : ""}
                        </span>
                      </label>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-3">
                      <button type="button" onClick={commit} disabled={!canCommit || busy !== null} className={buttonClass.primary}>
                        {busy === "committing" ? "Committing…" : `Commit ${s.counts.accepted} row${s.counts.accepted === 1 ? "" : "s"} as a new ${job.mode} revision`}
                      </button>
                      <p className="text-sm text-muted">Creates an immutable catalog revision and a review batch.</p>
                    </div>
                  </>
                )}
                <p role="alert" className="min-h-5 text-sm text-danger">
                  {error}
                </p>
              </div>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
