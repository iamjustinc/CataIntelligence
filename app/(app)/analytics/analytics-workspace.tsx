"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Badge, buttonClass, Card, inputClass } from "@/components/ui";
import { describeSpec } from "@/lib/analytics/format";
import { DEMO_EXAMPLES, spec as defaultSpec, type Vocabulary } from "@/lib/analytics/planner";
import { api, ApiClientError } from "@/lib/client/api";
import type { AnalysisSpec } from "@/lib/contracts/analysis-spec";
import type { Interpretation, PlannerStatus, RunView } from "@/lib/domain/analytics";
import { ResultView } from "./result-view";
import { SpecEditor } from "./spec-editor";

interface Draft {
  question: string | null;
  source: "demo" | "live" | "builder";
  sourceLabel: string;
  spec: AnalysisSpec;
  /** The planner's spec before any edit, to tell the user when they have changed it. */
  proposed: string | null;
  notes: string[];
  changes: string[];
}
type Notice = { kind: "clarify"; question: string; original: string; options: { label: string; spec: AnalysisSpec | null }[]; label: string } | { kind: "message"; tone: "unsupported" | "not_understood" | "unavailable"; text: string; links: { label: string; href: string }[]; label: string; unrecognized: string[] };

const errorText = (err: unknown) => (err instanceof ApiClientError ? `${err.message}${err.fieldErrors.length ? ` ${err.fieldErrors.map((f) => f.message).join(" ")}` : ""}` : "Something went wrong. Try again.");

export function AnalyticsWorkspace({ planner, vocabulary, initialRuns, initialConversationId, hasData }: { planner: PlannerStatus; vocabulary: Vocabulary; initialRuns: RunView[]; initialConversationId: string | null; hasData: boolean }) {
  const router = useRouter();
  const [runs, setRuns] = useState(initialRuns);
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [question, setQuestion] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<"interpret" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ runId: string; name: string; pending: boolean; error: string | null; savedId: string | null } | null>(null);
  const [now] = useState(() => new Date());
  const draftRef = useRef<HTMLDivElement>(null);
  const saveKey = useRef<string>("");
  const canAsk = planner.mode !== "none";
  const last = runs[runs.length - 1] ?? null;

  const propose = (next: Draft) => {
    setDraft(next);
    setNotice(null);
    requestAnimationFrame(() => draftRef.current?.focus());
  };

  async function interpret(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy("interpret");
    setError(null);
    setDraft(null);
    setNotice(null);
    try {
      const result = await api<Interpretation>("/api/analytics/interpret", { method: "POST", body: { question: q, conversationId } });
      const o = result.outcome;
      if (o.kind === "spec") propose({ question: q, source: result.planner === "live" ? "live" : "demo", sourceLabel: result.plannerLabel, spec: o.spec, proposed: JSON.stringify(o.spec), notes: o.notes, changes: o.changes });
      else if (o.kind === "clarify") setNotice({ kind: "clarify", question: o.question, original: q, options: o.options, label: result.plannerLabel });
      else setNotice({ kind: "message", tone: o.kind, text: o.message, links: o.kind === "unsupported" ? o.links : [], label: result.plannerLabel, unrecognized: o.kind === "not_understood" ? o.unrecognized : [] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    if (!draft || busy) return;
    setBusy("run");
    setError(null);
    try {
      const edited = draft.proposed !== null && draft.proposed !== JSON.stringify(draft.spec);
      const result = await api<RunView>("/api/analytics/execute", { method: "POST", body: { spec: draft.spec, question: draft.question, conversationId, source: edited ? "builder" : draft.source } });
      setRuns((r) => [...r, result]);
      setConversationId(result.conversationId);
      setDraft(null);
      setQuestion("");
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  function startOver() {
    setRuns([]);
    setConversationId(null);
    setDraft(null);
    setNotice(null);
    setError(null);
    setQuestion("");
    router.replace("/analytics");
  }

  async function saveReport() {
    if (!saving || saving.pending) return;
    setSaving({ ...saving, pending: true, error: null });
    try {
      const { id } = await api<{ id: string }>("/api/reports", { method: "POST", body: { runId: saving.runId, name: saving.name }, idempotencyKey: saveKey.current });
      setSaving({ ...saving, pending: false, savedId: id });
      router.refresh();
    } catch (err) {
      setSaving({ ...saving, pending: false, error: errorText(err) });
    }
  }

  const edited = !!draft && draft.proposed !== null && draft.proposed !== JSON.stringify(draft.spec);

  return (
    <div className="space-y-6">
      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-medium">{last ? "Ask a follow-up or a new question" : "Ask a question"}</h2>
          <span className="flex items-center gap-2" data-testid="planner-status">
            <Badge tone={planner.mode === "live" ? "info" : planner.mode === "demo" ? "warn" : "neutral"}>{planner.label}</Badge>
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-soft">{planner.detail}</p>
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void interpret(question);
          }}
        >
          <label htmlFor="analytics-question" className="sr-only">
            Question
          </label>
          <input id="analytics-question" value={question} onChange={(e) => setQuestion(e.target.value)} disabled={!canAsk} maxLength={1000} autoComplete="off" placeholder={canAsk ? (last ? "For example: only Harbor Market, or a new question" : "For example: which merchant has the lowest published coverage?") : "Question interpretation is not available. Use the builder below."} className={`${inputClass} flex-1 disabled:bg-sunken`} />
          <button type="submit" disabled={!canAsk || !question.trim() || busy !== null} className={buttonClass.primary}>
            {busy === "interpret" ? "Interpreting…" : "Interpret"}
          </button>
          {last ? (
            <button type="button" onClick={startOver} className={buttonClass.secondary}>
              New conversation
            </button>
          ) : null}
        </form>
        {planner.mode === "demo" && !last ? (
          <div className="mt-3">
            <p className="eyebrow">Question forms the demo planner matches</p>
            <ul className="mt-1.5 flex flex-wrap gap-2">
              {DEMO_EXAMPLES.map((ex) => (
                <li key={ex}>
                  <button type="button" disabled={busy !== null} onClick={() => (setQuestion(ex), void interpret(ex))} className="rounded-sm border border-rule-strong bg-surface px-2.5 py-1 text-left text-[0.8125rem] text-ink-soft hover:bg-sunken">
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mt-3 text-xs text-muted">
          An interpretation is shown before anything runs. Analytics reads data only: it cannot approve mappings, change the taxonomy or publish a release.{" "}
          {!draft ? (
            <button type="button" className="font-semibold text-ink underline underline-offset-4" onClick={() => propose({ question: null, source: "builder", sourceLabel: "Built with controls", spec: last?.result.spec ?? defaultSpec("listing_count"), proposed: null, notes: [], changes: [] })}>
              Build an analysis with controls
            </button>
          ) : null}
        </p>
        {!hasData ? <p className="mt-2 text-sm text-warn">This workspace has no active listings yet, so results will be empty or Not applicable.</p> : null}
      </Card>

      <p role="alert" className={error ? "rounded-sm border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger" : "sr-only"}>
        {error}
      </p>

      {runs.map((r, i) => (
        <ResultView key={r.id} run={r} heading={r.question ?? undefined}>
          {i === runs.length - 1 || saving?.runId === r.id ? (
            saving?.runId === r.id ? (
              saving.savedId ? (
                <Link href={`/analytics/reports/${saving.savedId}`} className="font-semibold text-ok underline underline-offset-4">
                  Saved. Open report
                </Link>
              ) : (
                <form
                  className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveReport();
                  }}
                >
                  <label htmlFor={`report-name-${r.id}`} className="sr-only">
                    Report name
                  </label>
                  <input id={`report-name-${r.id}`} value={saving.name} onChange={(e) => setSaving({ ...saving, name: e.target.value })} maxLength={120} className={`${inputClass} w-64`} autoFocus />
                  <button type="submit" disabled={saving.pending || !saving.name.trim()} className={buttonClass.primary}>
                    {saving.pending ? "Saving…" : "Save"}
                  </button>
                  <button type="button" onClick={() => setSaving(null)} className={buttonClass.secondary}>
                    Cancel
                  </button>
                  {saving.error ? <span className="text-danger">{saving.error}</span> : null}
                </form>
              )
            ) : (
              <button type="button" className="font-semibold underline underline-offset-4" onClick={() => ((saveKey.current = `report-${r.id}-${Date.now()}`), setSaving({ runId: r.id, name: (r.question ?? r.description[0]?.replace("Metric: ", "") ?? "Report").slice(0, 120), pending: false, error: null, savedId: null }))}>
                Save as report
              </button>
            )
          ) : null}
        </ResultView>
      ))}

      {notice?.kind === "clarify" ? (
        <Card className="border-info/40 px-5 py-4" data-testid="clarification">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-medium">One thing to settle first</h2>
            <Badge>{notice.label}</Badge>
          </div>
          <p className="mt-2 text-sm leading-relaxed">{notice.question}</p>
          <p className="mt-1 text-xs text-muted">Nothing has been run.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {notice.options.map((o) => (
              <button
                key={o.label}
                type="button"
                className={buttonClass.secondary}
                disabled={busy !== null}
                onClick={() => (o.spec ? propose({ question: notice.original, source: planner.mode === "live" ? "live" : "demo", sourceLabel: `${notice.label}, your choice: ${o.label}`, spec: o.spec, proposed: JSON.stringify(o.spec), notes: [], changes: [] }) : (setQuestion(`${notice.original} (${o.label})`), void interpret(`${notice.original} (${o.label})`)))}
              >
                {o.label}
              </button>
            ))}
            {notice.options.length === 0 ? <span className="text-sm text-ink-soft">Rephrase with exact dates (for example “between 2026-06-01 and 2026-08-31”), or set the period with the controls.</span> : null}
          </div>
        </Card>
      ) : null}

      {notice?.kind === "message" ? (
        <Card className={`px-5 py-4 ${notice.tone === "unsupported" ? "border-warn/50" : ""}`} data-testid="planner-message" data-kind={notice.tone}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-medium">{notice.tone === "unsupported" ? "This cannot be answered here" : notice.tone === "unavailable" ? "Question interpretation is not available" : "Not interpreted"}</h2>
            <Badge>{notice.label}</Badge>
          </div>
          <p className="mt-2 text-sm leading-relaxed">{notice.text}</p>
          <p className="mt-1 text-xs text-muted">Nothing has been run and no data was changed.</p>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            {notice.links.map((l) => (
              <Link key={l.href} href={l.href} className="font-semibold text-stamp underline underline-offset-4">
                {l.label}
              </Link>
            ))}
            {notice.tone !== "unsupported" ? (
              <button type="button" className="font-semibold underline underline-offset-4" onClick={() => propose({ question: null, source: "builder", sourceLabel: "Built with controls", spec: last?.result.spec ?? defaultSpec("listing_count"), proposed: null, notes: [], changes: [] })}>
                Build it with controls
              </button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {draft ? (
        <Card className="border-rule-strong px-5 py-4" data-testid="interpretation">
          <div ref={draftRef} tabIndex={-1} className="outline-none">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-lg font-medium">{draft.source === "builder" ? "Build an analysis" : "Interpretation"}</h2>
              <Badge tone={draft.source === "live" ? "info" : draft.source === "demo" ? "warn" : "neutral"}>{edited ? "Edited by you" : draft.sourceLabel}</Badge>
            </div>
            {draft.question ? <p className="mt-1 text-sm text-ink-soft">“{draft.question}”</p> : null}
            <p className="mt-1 text-xs text-muted">Not run yet. Check or change the settings, then run.</p>
          </div>
          {draft.changes.length > 0 ? (
            <ul className="mt-3 space-y-1 rounded-sm border border-info/30 bg-info-bg px-4 py-2.5 text-sm text-info" aria-label="Changes from the previous analysis" data-testid="interpretation-changes">
              {draft.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
          <ul className="mt-3 space-y-0.5 text-sm" aria-label="Interpretation in words" data-testid="interpretation-description">
            {describeSpec(draft.spec, vocabulary).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {draft.notes.map((n) => (
            <p key={n} className="mt-2 text-xs text-ink-soft">
              {n}
            </p>
          ))}
          <div className="mt-4 border-t border-rule pt-4">
            <SpecEditor spec={draft.spec} vocabulary={vocabulary} now={now} onChange={(spec) => setDraft({ ...draft, spec })} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => void run()} disabled={busy !== null} className={buttonClass.primary}>
              {busy === "run" ? "Running…" : "Run analysis"}
            </button>
            <button type="button" onClick={() => setDraft(null)} disabled={busy !== null} className={buttonClass.secondary}>
              Discard
            </button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
