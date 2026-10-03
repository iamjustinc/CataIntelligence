"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Badge, buttonClass, Card, StatePanel } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

interface Issue {
  row: number;
  conceptId: string | null;
  field: string | null;
  code: string;
  message: string;
}
interface ImportView {
  id: string;
  status: "validated" | "failed" | "committed" | "staged" | "expired";
  fileName: string;
  summary: {
    counts: { rows: number; concepts: number; leaves: number; mappable: number; maxDepth: number };
    errorCount: number;
    warningCount: number;
    errors: Issue[];
    warnings: Issue[];
    diff: { baseSequence: number | null; added: number; changed: number; removed: number; unchanged: number; removedKeys: string[] };
  };
}

const MAX_BYTES = 2 * 1024 * 1024;

function IssueTable({ caption, issues, total }: { caption: string; issues: Issue[]; total: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="px-5 py-2 text-left text-xs text-muted">
          {caption}
          {total > issues.length ? ` Showing the first ${issues.length} of ${total}.` : ""}
        </caption>
        <thead className="border-y border-rule bg-sunken/60">
          <tr className="eyebrow [&>th]:px-5 [&>th]:py-2 [&>th]:font-normal">
            <th scope="col">Row</th>
            <th scope="col">Concept ID</th>
            <th scope="col">Field</th>
            <th scope="col">Problem</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {issues.map((issue, i) => (
            <tr key={i} className="[&>td]:px-5 [&>td]:py-2 [&>td]:align-top">
              <td className="font-mono text-xs">{issue.row === 0 ? "File" : issue.row}</td>
              <td className="font-mono text-xs">{issue.conceptId ?? "—"}</td>
              <td className="font-mono text-xs">{issue.field ?? "—"}</td>
              <td className="text-ink-soft">{issue.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ImportWizard({ existingDraftSequence }: { existingDraftSequence: number | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"validating" | "committing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportView | null>(null);
  const [replaceDraft, setReplaceDraft] = useState(false);
  const [draftConflict, setDraftConflict] = useState(existingDraftSequence !== null);
  const commitKey = useRef(crypto.randomUUID());
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File | undefined) {
    if (!file || busy) return;
    setResult(null);
    setError(null);
    if (file.size === 0) return setError("The file is empty.");
    if (file.size > MAX_BYTES) return setError("The file is larger than the 2 MB taxonomy limit.");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      return setError("The file is not valid UTF-8. Re-export it as UTF-8 CSV and try again.");
    }
    setBusy("validating");
    try {
      setResult(await api<ImportView>("/api/taxonomy/imports", { method: "POST", body: { fileName: file.name, content } }));
      commitKey.current = crypto.randomUUID();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Validation failed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!result || busy) return;
    setBusy("committing");
    setError(null);
    try {
      const { versionId } = await api<{ versionId: string }>(`/api/taxonomy/imports/${result.id}/commit`, { method: "POST", idempotencyKey: commitKey.current, body: { replaceDraft } });
      router.push(`/taxonomy?version=${versionId}`);
      router.refresh();
    } catch (err) {
      commitKey.current = crypto.randomUUID();
      if (err instanceof ApiClientError && err.status === 409) setDraftConflict(true);
      setError(err instanceof ApiClientError ? err.message : "Could not create the draft. Try again.");
      setBusy(null);
    }
  }

  const s = result?.summary;
  const blocked = !!s && s.errorCount > 0;

  return (
    <div className="space-y-6">
      <Card className="rise rise-1 p-5">
        <h2 className="font-display text-lg font-medium">1. Choose a file</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Required columns: <code className="font-mono text-xs">concept_id, parent_id, name, definition, synonyms, status, mapping_allowed</code>. Synonyms are separated by <code className="font-mono text-xs">|</code>. Exactly one row has an empty parent_id.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label htmlFor="taxonomy-file" className="sr-only">
            Taxonomy CSV file
          </label>
          <input
            ref={fileRef}
            id="taxonomy-file"
            type="file"
            accept=".csv,text/csv"
            disabled={busy !== null}
            onChange={(e) => onFile(e.target.files?.[0])}
            className="block max-w-full text-sm file:mr-3 file:rounded-sm file:border file:border-rule-strong file:bg-surface file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink hover:file:bg-sunken"
          />
          <span role="status" aria-live="polite" className="text-sm text-muted">
            {busy === "validating" ? "Validating…" : ""}
          </span>
        </div>
        {error && !result ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Card>

      {result && s ? (
        <Card className="rise overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3">
            <h2 className="font-display text-lg font-medium">2. Validation summary</h2>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted">{result.fileName}</span>
              {blocked ? <Badge tone="danger">Blocked</Badge> : <Badge tone="ok">Valid</Badge>}
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-5">
            {[
              ["Rows read", s.counts.rows],
              ["Concepts", s.counts.concepts],
              ["Mappable leaves", s.counts.mappable],
              ["Blocking errors", s.errorCount],
              ["Warnings", s.warningCount],
            ].map(([label, value]) => (
              <div key={label} className="bg-surface px-5 py-3">
                <dt className="eyebrow">{label}</dt>
                <dd className="mt-1 font-display text-2xl">{value}</dd>
              </div>
            ))}
          </dl>
          {!blocked ? (
            <p className="border-t border-rule px-5 py-3 text-sm text-ink-soft">
              {s.diff.baseSequence === null
                ? `First version: all ${s.diff.added} concepts are new.`
                : `Compared with active version ${s.diff.baseSequence}: ${s.diff.added} added, ${s.diff.changed} changed, ${s.diff.removed} removed, ${s.diff.unchanged} unchanged.`}
              {s.diff.removedKeys.length ? <span className="mt-1 block font-mono text-xs text-warn">Removed: {s.diff.removedKeys.join(", ")}</span> : null}
            </p>
          ) : null}
          {s.errors.length ? <IssueTable caption="Blocking errors. Fix these in the file and upload it again." issues={s.errors} total={s.errorCount} /> : null}
          {s.warnings.length ? <IssueTable caption="Warnings. These do not block the import." issues={s.warnings} total={s.warningCount} /> : null}

          <div className="border-t border-rule px-5 py-4">
            {blocked ? (
              <StatePanel kind="error" title="This file cannot be committed">
                Nothing was saved to the taxonomy. Correct the rows listed above and choose the file again.
              </StatePanel>
            ) : (
              <div className="space-y-3">
                <h3 className="font-display text-lg font-medium">3. Create draft</h3>
                {draftConflict ? (
                  <label className="flex items-start gap-2 rounded-sm border border-warn/40 bg-warn-bg p-3 text-sm text-warn">
                    <input type="checkbox" checked={replaceDraft} onChange={(e) => setReplaceDraft(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-stamp)]" />
                    <span>
                      A draft version{existingDraftSequence ? ` (${existingDraftSequence})` : ""} already exists. Replace its contents with this file. The published version is not affected.
                    </span>
                  </label>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={commit} disabled={busy !== null || (draftConflict && !replaceDraft)} className={buttonClass.primary}>
                    {busy === "committing" ? "Creating draft…" : "Commit as draft version"}
                  </button>
                  <p className="text-sm text-muted">The draft is not live until an administrator publishes it.</p>
                </div>
                <p role="alert" className="min-h-5 text-sm text-danger">
                  {error}
                </p>
              </div>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
