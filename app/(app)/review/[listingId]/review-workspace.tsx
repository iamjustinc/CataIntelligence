"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, buttonClass, inputClass, StatePanel } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { ACTION_LABELS, BAND_LABELS, BAND_TONES, ORIGIN_LABELS, STATE_LABELS, STATE_TONES, type ReviewState, type SignalBand } from "@/lib/review-labels";

interface CandidateView {
  conceptId: string;
  stableKey: string;
  path: string;
  name: string;
  definition: string;
  matchedTerms: string[];
}
interface ItemView {
  listing: { id: string; sku: string; title: string; sourceRow: number | null; raw: Record<string, string>; fields: Record<string, string | null> };
  merchant: { id: string; name: string };
  revision: { id: string; sequence: number; current: boolean };
  review: { state: ReviewState; lockVersion: number; ambiguous: boolean };
  activeTaxonomyVersionId: string | null;
  recommendation: {
    id: string;
    isDemo: boolean;
    provider: string;
    band: SignalBand;
    basis: string;
    stale: boolean;
    selectedConceptId: string | null;
    candidates: CandidateView[];
    alternatives: { conceptId: string; reason: string }[];
    evidence: { field: string; excerpt: string; supportsConceptId: string }[];
    explanation: string;
    warnings: string[];
    ambiguityFlags: string[];
    missingInformation: string[];
    proposedConcept: { name: string; parentConceptId: string | null; rationale: string } | null;
  } | null;
  textMatches: CandidateView[];
  history: { id: string; action: keyof typeof ACTION_LABELS; origin: keyof typeof ORIGIN_LABELS; reason: string | null; createdAt: string; actorName: string; conceptPath: string | null }[];
  canDecide: boolean;
}
interface Target {
  conceptId: string;
  path: string;
}
type Action = "approve" | "change" | "reject" | "defer" | "no_suitable";

const FIELD_LABELS: [string, string][] = [
  ["title", "Title"],
  ["description", "Description"],
  ["merchantCategoryPath", "Merchant category path"],
  ["brand", "Brand"],
  ["packageSize", "Package size"],
  ["gtin", "GTIN"],
  ["price", "Price"],
];
const short = (path: string) => path.replace(/^All Products > /, "");

/**
 * Seconds the item was actively visible: pauses while the tab is hidden and after 60 seconds
 * without input (PRD 2.3).
 */
function useActiveSeconds() {
  const total = useRef(0);
  const last = useRef<number | null>(null);
  const lastInput = useRef(0);
  useEffect(() => {
    last.current = Date.now();
    lastInput.current = Date.now();
    const tick = () => {
      const now = Date.now();
      if (last.current !== null && !document.hidden && now - lastInput.current < 60_000) total.current += (now - last.current) / 1000;
      last.current = now;
    };
    const onInput = () => {
      tick();
      lastInput.current = Date.now();
    };
    const timer = setInterval(tick, 1000);
    for (const e of ["keydown", "pointerdown", "pointermove", "scroll"]) window.addEventListener(e, onInput, { passive: true });
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      for (const e of ["keydown", "pointerdown", "pointermove", "scroll"]) window.removeEventListener(e, onInput);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return () => Math.round(total.current);
}

export function ReviewWorkspace({
  item,
  queue,
  progress,
  prevHref,
  nextHref,
  queueHref,
}: {
  item: ItemView;
  queue: { id: string; title: string; sku: string; state: ReviewState; href: string }[];
  progress: { total: number; approved: number; remaining: number };
  prevHref: string | null;
  nextHref: string | null;
  queueHref: string;
}) {
  const router = useRouter();
  const rec = item.recommendation;
  const pathOf = useCallback((id: string | null) => (id ? ([...(rec?.candidates ?? []), ...item.textMatches].find((c) => c.conceptId === id)?.path ?? null) : null), [rec, item.textMatches]);
  const suggestion = useMemo<Target | null>(() => (rec && rec.selectedConceptId && !rec.stale ? { conceptId: rec.selectedConceptId, path: pathOf(rec.selectedConceptId) ?? "" } : null), [rec, pathOf]);

  const [target, setTarget] = useState<Target | null>(null);
  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CandidateView[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<{ text: string; conflict: boolean; field?: string } | null>(null);
  const [saved, setSaved] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const key = useRef(crypto.randomUUID());
  const seconds = useActiveSeconds();
  const editable = item.canDecide && item.revision.current && !!item.activeTaxonomyVersionId;

  // Debounced concept search against the active taxonomy version.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await api<CandidateView[]>(`/api/taxonomy/concepts?q=${encodeURIComponent(q)}`);
        if (!cancelled) setResults(found);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const submit = useCallback(
    async (action: Action) => {
      if (pending || !editable) return;
      const differs = !!target && target.conceptId !== suggestion?.conceptId;
      if ((action === "change" || action === "reject") && !reason.trim()) {
        setError({ text: action === "change" ? "Give a reason for changing the mapping." : "Give a reason for rejecting the suggestion.", conflict: false, field: "reason" });
        reasonRef.current?.focus();
        return;
      }
      setPending(action);
      setError(null);
      try {
        const body = {
          action,
          expectedVersion: item.review.lockVersion,
          durationSeconds: seconds(),
          reason: reason.trim() || null,
          selectedConceptId: action === "change" || (action === "approve" && differs) || (action === "approve" && !suggestion) ? (target?.conceptId ?? null) : null,
        };
        const result = await api<{ state: ReviewState; conceptPath: string | null }>(`/api/review-items/${item.listing.id}/decisions`, { method: "POST", idempotencyKey: key.current, body });
        setSaved(`Saved: ${STATE_LABELS[result.state]}${result.conceptPath ? `, ${short(result.conceptPath)}` : ""}.`);
        if (nextHref) router.push(nextHref);
        router.refresh();
      } catch (err) {
        key.current = crypto.randomUUID();
        const e = err instanceof ApiClientError ? err : null;
        setError({ text: e?.message ?? "Could not save the decision. Try again.", conflict: e?.status === 409, field: e?.fieldErrors[0]?.path });
        setPending(null);
      }
    },
    [pending, editable, target, suggestion, reason, item, seconds, nextHref, router],
  );

  const canApprove = editable && (target ? !suggestion || target.conceptId === suggestion.conceptId : !!suggestion);
  const canChange = editable && !!target && (!suggestion || target.conceptId !== suggestion.conceptId) && !!suggestion;

  // Keyboard: J next, K previous, A approve, C concept search, Escape leaves the field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
      if (e.key === "Escape" && typing) return el.blur();
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
      const k = e.key.toLowerCase();
      if (k === "j" && nextHref) router.push(nextHref);
      else if (k === "k" && prevHref) router.push(prevHref);
      else if (k === "a" && canApprove) submit("approve");
      else if (k === "c" && editable) searchRef.current?.focus();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextHref, prevHref, canApprove, editable, router, submit]);

  const choose = (c: { conceptId: string; path: string }) => {
    setTarget({ conceptId: c.conceptId, path: c.path });
    setQuery("");
    setResults(null);
    setError(null);
  };
  const proposalHref = (extra: Record<string, string>) => `/taxonomy/proposals/new?${new URLSearchParams({ listing: item.listing.id, ...extra })}`;
  const picker = query.trim() ? results : null;
  const shownMatches = !rec ? item.textMatches : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={queueHref} className="text-sm font-semibold text-stamp underline underline-offset-4">
          Back to queue
        </Link>
        <nav aria-label="Queue navigation" className="flex items-center gap-2 text-sm">
          {prevHref ? (
            <Link href={prevHref} className={buttonClass.secondary}>
              <kbd className="font-mono text-xs text-muted">K</kbd> Previous
            </Link>
          ) : null}
          {nextHref ? (
            <Link href={nextHref} className={buttonClass.secondary}>
              Next <kbd className="font-mono text-xs text-muted">J</kbd>
            </Link>
          ) : null}
        </nav>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[15rem_minmax(0,1fr)_minmax(0,26rem)]">
        {/* Queue */}
        <details className="rounded-md border border-rule bg-surface xl:hidden">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Queue ({queue.length} on this page)</summary>
          <QueueList queue={queue} currentId={item.listing.id} />
        </details>
        <aside aria-label="Queue" className="hidden rounded-md border border-rule bg-surface xl:sticky xl:top-4 xl:block">
          <p className="eyebrow border-b border-rule px-4 py-2.5">Queue</p>
          <QueueList queue={queue} currentId={item.listing.id} />
        </aside>

        {/* Source listing */}
        <section aria-labelledby="listing-title" className="rounded-md border border-rule bg-surface">
          <div className="border-b border-rule px-5 py-4">
            <p className="eyebrow">
              {item.merchant.name} · Revision {item.revision.sequence} · <span className="normal-case">{item.listing.sku}</span>
            </p>
            <h1 id="listing-title" className="mt-1 font-display text-2xl leading-snug font-medium break-words">
              {item.listing.title}
            </h1>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone={STATE_TONES[item.review.state]}>{STATE_LABELS[item.review.state]}</Badge>
              {item.review.ambiguous ? <Badge tone="warn">Ambiguous</Badge> : null}
              {!item.revision.current ? <Badge tone="warn">Superseded revision</Badge> : null}
            </div>
          </div>
          <dl className="divide-y divide-rule text-sm">
            {FIELD_LABELS.map(([field, label]) => {
              const value = field === "price" ? (item.listing.fields.price ? `${item.listing.fields.price} ${item.listing.fields.currency ?? ""}` : null) : item.listing.fields[field];
              const cited = rec?.evidence.filter((e) => e.field.replaceAll("_", "") === field.toLowerCase()) ?? [];
              return (
                <div key={field} className="grid gap-1 px-5 py-2.5 sm:grid-cols-[11rem_1fr]">
                  <dt className="text-muted">{label}</dt>
                  <dd className="break-words">
                    {value ?? <span className="text-muted">Not provided</span>}
                    {cited.length ? <span className="ml-2 font-mono text-[0.65rem] tracking-wide text-info uppercase">cited as evidence</span> : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          <details className="border-t border-rule px-5 py-3 text-sm">
            <summary className="cursor-pointer font-medium">Original values from the file{item.listing.sourceRow ? ` (row ${item.listing.sourceRow})` : ""}</summary>
            <dl className="mt-2 grid gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-[minmax(0,10rem)_1fr]">
              {Object.entries(item.listing.raw).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="break-words whitespace-pre-wrap">{v === "" ? "—" : v}</dd>
                </div>
              ))}
            </dl>
          </details>
          <div className="border-t border-rule px-5 py-3">
            <h2 className="eyebrow">Decision history</h2>
            {item.history.length === 0 ? (
              <p className="mt-1 text-sm text-muted">No decisions yet.</p>
            ) : (
              <ol className="mt-2 space-y-2 text-sm">
                {item.history.map((h) => (
                  <li key={h.id} className="border-l-2 border-rule-strong pl-3">
                    <span className="font-medium">{ACTION_LABELS[h.action]}</span>
                    {h.conceptPath ? <span> → {short(h.conceptPath)}</span> : null}
                    <span className="block text-xs text-muted">
                      {h.actorName} · {ORIGIN_LABELS[h.origin]} · {h.createdAt.slice(0, 16).replace("T", " ")} UTC
                    </span>
                    {h.reason ? <span className="block text-xs text-ink-soft">“{h.reason}”</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        {/* Suggestion, evidence and actions */}
        <section aria-label="Suggestion and actions" className="space-y-4">
          <div className="rounded-md border border-rule bg-surface">
            <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-5 py-3">
              <h2 className="mr-auto font-display text-lg font-medium">{rec ? "Suggested concept" : "No recommendation"}</h2>
              {rec?.isDemo ? (
                <Badge tone="warn" title="Deterministic fixture output for seeded fixture data. Not live model output.">
                  Demo fixture
                </Badge>
              ) : null}
              {rec ? (
                <Badge tone={BAND_TONES[rec.band]} title="Review priority, not a probability.">
                  {BAND_LABELS[rec.band]}
                </Badge>
              ) : null}
            </div>
            {!rec ? (
              <div className="space-y-3 px-5 py-4 text-sm">
                <p className="text-ink-soft">This listing has not been analyzed, or has no fixture suggestion. Map it manually with the concept search below.</p>
                {shownMatches.length ? (
                  <div>
                    <h3 className="eyebrow">Text matches · not a recommendation</h3>
                    <ul className="mt-1 divide-y divide-rule rounded-sm border border-rule">
                      {shownMatches.slice(0, 5).map((c) => (
                        <CandidateRow key={c.conceptId} c={c} note={c.matchedTerms.length ? `Matches ${c.matchedTerms.slice(0, 3).join(", ")}` : ""} onPick={editable ? choose : undefined} />
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3 px-5 py-4 text-sm">
                {rec.stale ? (
                  <StatePanel kind="stale" title="Stale suggestion">
                    This suggestion was made against an earlier taxonomy version and cannot be approved. Map manually or run analysis again.
                  </StatePanel>
                ) : null}
                {rec.selectedConceptId ? (
                  <p className="font-display text-xl leading-snug">{short(pathOf(rec.selectedConceptId) ?? "Unknown concept")}</p>
                ) : (
                  <p className="font-medium text-ink-soft">No supported target among the candidates.</p>
                )}
                <p className="leading-relaxed text-ink-soft">{rec.explanation}</p>
                <p className="font-mono text-xs text-muted">{rec.basis}</p>
                {rec.evidence.length ? (
                  <div>
                    <h3 className="eyebrow">Evidence from the listing</h3>
                    <ul className="mt-1 space-y-1">
                      {rec.evidence.map((e, i) => (
                        <li key={i}>
                          <span className="font-mono text-xs text-muted">{e.field}</span> <q className="bg-info-bg px-1">{e.excerpt}</q>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {[...rec.ambiguityFlags, ...rec.missingInformation, ...rec.warnings].length ? (
                  <div className="rounded-sm border border-warn/40 bg-warn-bg p-3 text-warn">
                    <h3 className="font-semibold">Needs investigation</h3>
                    <ul className="mt-1 list-inside list-disc">
                      {[...rec.ambiguityFlags, ...rec.missingInformation, ...rec.warnings].map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {rec.alternatives.length ? (
                  <div>
                    <h3 className="eyebrow">Alternatives</h3>
                    <ul className="mt-1 divide-y divide-rule rounded-sm border border-rule">
                      {rec.alternatives.map((a) => {
                        const c = rec.candidates.find((x) => x.conceptId === a.conceptId);
                        return c ? <CandidateRow key={a.conceptId} c={c} note={a.reason} onPick={editable ? choose : undefined} /> : null;
                      })}
                    </ul>
                  </div>
                ) : null}
                {rec.proposedConcept ? (
                  <div className="rounded-sm border border-rule p-3">
                    <h3 className="eyebrow">Possible missing concept</h3>
                    <p className="mt-1">
                      <span className="font-medium">{rec.proposedConcept.name}</span>. {rec.proposedConcept.rationale}
                    </p>
                    {item.canDecide ? (
                      <Link href={proposalHref({ type: "new_leaf", name: rec.proposedConcept.name, ...(rec.proposedConcept.parentConceptId ? { parent: rec.proposedConcept.parentConceptId } : {}) })} className="mt-1 inline-block font-semibold text-stamp underline underline-offset-4">
                        Propose this leaf for administrator review
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="rounded-md border border-rule bg-surface px-5 py-4">
            <h2 className="font-display text-lg font-medium">Decision</h2>
            {!editable ? (
              <p className="mt-2 text-sm text-ink-soft">
                {!item.canDecide ? "Your role can view this listing. Reviewing requires a taxonomist or administrator." : !item.revision.current ? "This listing belongs to a superseded catalog revision and is read-only." : "Publish a taxonomy version before reviewing listings."}
              </p>
            ) : (
              <div className="mt-3 space-y-3 text-sm">
                <div>
                  <label htmlFor="concept-picker" className="mb-1 block font-medium">
                    Map to a different concept <kbd className="ml-1 font-mono text-xs text-muted">C</kbd>
                  </label>
                  <input ref={searchRef} id="concept-picker" type="search" role="combobox" aria-expanded={!!picker} aria-controls="concept-results" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search leaf concepts by name, synonym or ID" className={inputClass} />
                  <div id="concept-results" role="listbox" aria-label="Matching concepts">
                    {picker ? (
                      picker.length ? (
                        <ul className="mt-1 max-h-56 divide-y divide-rule overflow-y-auto rounded-sm border border-rule">
                          {picker.map((c) => (
                            <CandidateRow key={c.conceptId} c={c} note={c.definition} onPick={choose} />
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-1 text-muted">{searching ? "Searching…" : "No leaf concept matches. If none fits, use No suitable category."}</p>
                      )
                    ) : null}
                  </div>
                </div>
                {target ? (
                  <p className="flex flex-wrap items-center gap-2 rounded-sm border border-ink bg-sunken/50 px-3 py-2">
                    <span className="eyebrow">Selected target</span>
                    <span className="font-medium">{short(target.path)}</span>
                    <button type="button" onClick={() => setTarget(null)} className="ml-auto text-xs underline underline-offset-4">
                      Clear
                    </button>
                  </p>
                ) : null}
                <div>
                  <label htmlFor="decision-reason" className="mb-1 block font-medium">
                    Reason or note <span className="font-normal text-muted">(required to change a mapping or reject a suggestion)</span>
                  </label>
                  <textarea ref={reasonRef} id="decision-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={error?.field === "reason" ? true : undefined} className={inputClass} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={!canApprove || pending !== null} onClick={() => submit("approve")} className={buttonClass.primary}>
                    {pending === "approve" ? "Saving…" : target && !suggestion ? "Approve mapping" : "Approve"} <kbd className="font-mono text-xs opacity-80">A</kbd>
                  </button>
                  <button type="button" disabled={!canChange || pending !== null} onClick={() => submit("change")} className={buttonClass.secondary}>
                    {pending === "change" ? "Saving…" : "Change mapping"}
                  </button>
                  <button type="button" disabled={!rec?.selectedConceptId || pending !== null} onClick={() => submit("reject")} className={buttonClass.secondary}>
                    {pending === "reject" ? "Saving…" : "Reject suggestion"}
                  </button>
                  <button type="button" disabled={pending !== null} onClick={() => submit("defer")} className={buttonClass.secondary}>
                    {pending === "defer" ? "Saving…" : "Defer"}
                  </button>
                  <button type="button" disabled={pending !== null} onClick={() => submit("no_suitable")} className={buttonClass.secondary}>
                    {pending === "no_suitable" ? "Saving…" : "No suitable category"}
                  </button>
                </div>
                {!canApprove && !target ? <p className="text-xs text-muted">Approve is available once there is a valid current target: a current suggestion, or a concept you select.</p> : null}
                {item.review.state === "no_suitable_category" && !rec?.proposedConcept ? (
                  <Link href={proposalHref({ type: "new_leaf" })} className="inline-block font-semibold text-stamp underline underline-offset-4">
                    Propose a new leaf concept for this listing
                  </Link>
                ) : null}
              </div>
            )}
            {error ? (
              <div role="alert" className="mt-3 rounded-sm border border-danger/40 bg-danger-bg p-3 text-sm text-danger">
                {error.text}
                {error.conflict ? (
                  <button type="button" onClick={() => router.refresh()} className="ml-2 font-semibold underline underline-offset-4">
                    Reload this listing
                  </button>
                ) : null}
              </div>
            ) : null}
            <p role="status" aria-live="polite" className="mt-2 min-h-5 text-sm text-ok">
              {saved}
            </p>
          </div>
        </section>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rule bg-surface px-5 py-2.5 text-sm">
        <span>
          <span className="font-mono">{progress.approved}</span> approved, <span className="font-mono">{progress.remaining}</span> remaining
          <span className="text-muted"> of {progress.total} active listings in this queue</span>
        </span>
        <span className="text-xs text-muted">
          <kbd className="font-mono">J</kbd> next · <kbd className="font-mono">K</kbd> previous · <kbd className="font-mono">A</kbd> approve · <kbd className="font-mono">C</kbd> concept search · <kbd className="font-mono">Esc</kbd> leave field
        </span>
      </footer>
    </div>
  );
}

function QueueList({ queue, currentId }: { queue: { id: string; title: string; sku: string; state: ReviewState; href: string }[]; currentId: string }) {
  return (
    <ol className="max-h-[70vh] overflow-y-auto">
      {queue.map((q) => (
        <li key={q.id} className="border-b border-rule last:border-0">
          <Link href={q.href} aria-current={q.id === currentId ? "true" : undefined} className={`block px-4 py-2 text-sm ${q.id === currentId ? "bg-ink text-white" : "hover:bg-sunken/60"}`}>
            <span className="line-clamp-2 leading-snug">{q.title}</span>
            <span className={`mt-0.5 block font-mono text-[0.65rem] tracking-wide uppercase ${q.id === currentId ? "text-white/70" : "text-muted"}`}>{STATE_LABELS[q.state]}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

function CandidateRow({ c, note, onPick }: { c: CandidateView; note: string; onPick?: (c: CandidateView) => void }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{short(c.path)}</span>
        {note ? <span className="block text-xs text-ink-soft">{note}</span> : null}
      </span>
      {onPick ? (
        <button type="button" onClick={() => onPick(c)} className="shrink-0 rounded-sm border border-rule-strong px-2 py-1 text-xs font-medium hover:bg-sunken">
          Map to this
        </button>
      ) : null}
    </li>
  );
}
