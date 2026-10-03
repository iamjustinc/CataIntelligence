"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, inputClass } from "@/components/ui";

export interface ConceptView {
  conceptId: string;
  stableKey: string;
  parentConceptId: string | null;
  name: string;
  definition: string;
  synonyms: string[];
  status: "active" | "inactive";
  mappingAllowed: boolean;
  path: string;
  depth: number;
  publishedListings: number;
  pendingProposals: number;
}

interface Persisted {
  expanded: string[];
  selected: string | null;
  scrollTop: number;
}

/** Expansion, selection and scroll position survive navigation away and back (PRD TAX02). */
function usePersistedTreeState(versionId: string, rootIds: string[]) {
  const storageKey = `ci.taxonomy.${versionId}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(rootIds));
  const [selected, setSelected] = useState<string | null>(null);
  const scrollTopRef = useRef(0);
  // Set by user actions only, so mounting (twice under React strict mode) never overwrites saved state.
  const dirtyRef = useRef(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as Persisted;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from sessionStorage after hydration
        setExpanded(new Set(saved.expanded));
        setSelected(saved.selected);
        scrollTopRef.current = saved.scrollTop ?? 0;
      }
    } catch {
      /* unreadable state is ignored */
    }
  }, [storageKey]);

  useEffect(() => {
    if (!dirtyRef.current) return;
    try {
      const state: Persisted = { expanded: [...expanded], selected, scrollTop: scrollTopRef.current };
      sessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      /* storage unavailable */
    }
  }, [expanded, selected, storageKey]);

  const saveScroll = useCallback(
    (top: number) => {
      scrollTopRef.current = top;
      try {
        const raw = sessionStorage.getItem(storageKey);
        const state: Persisted = raw ? JSON.parse(raw) : { expanded: [...expanded], selected, scrollTop: 0 };
        sessionStorage.setItem(storageKey, JSON.stringify({ ...state, scrollTop: top }));
      } catch {
        /* storage unavailable */
      }
    },
    [expanded, selected, storageKey],
  );

  return { expanded, setExpanded, selected, setSelected, scrollTopRef, dirtyRef, saveScroll };
}

export function TaxonomyBrowser({ versionId, concepts, canPropose = false }: { versionId: string; concepts: ConceptView[]; canPropose?: boolean }) {
  const byId = useMemo(() => new Map(concepts.map((c) => [c.conceptId, c])), [concepts]);
  const children = useMemo(() => {
    const map = new Map<string | null, ConceptView[]>();
    for (const c of concepts) map.set(c.parentConceptId, [...(map.get(c.parentConceptId) ?? []), c]);
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [concepts]);
  const roots = useMemo(() => children.get(null) ?? [], [children]);

  const { expanded, setExpanded, selected, setSelected, scrollTopRef, dirtyRef, saveScroll } = usePersistedTreeState(versionId, roots.map((r) => r.conceptId));
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const treeRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const visible = useMemo(() => {
    const out: ConceptView[] = [];
    const walk = (node: ConceptView) => {
      out.push(node);
      if (expanded.has(node.conceptId)) for (const child of children.get(node.conceptId) ?? []) walk(child);
    };
    roots.forEach(walk);
    return out;
  }, [children, expanded, roots]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return [];
    return concepts.filter((c) => [c.path, c.definition, c.stableKey, ...c.synonyms].some((t) => t.toLowerCase().includes(q))).slice(0, 100);
  }, [concepts, q]);
  const totalMatches = useMemo(() => (q ? concepts.filter((c) => [c.path, c.definition, c.stableKey, ...c.synonyms].some((t) => t.toLowerCase().includes(q))).length : 0), [concepts, q]);

  // Restore the scroll position once the restored expansion has rendered.
  useEffect(() => {
    if (treeRef.current && !q && scrollTopRef.current) treeRef.current.scrollTop = scrollTopRef.current;
  }, [q, scrollTopRef, versionId, visible.length]);

  const toggle = (id: string, open?: boolean) => {
    dirtyRef.current = true;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const select = (c: ConceptView) => {
    dirtyRef.current = true;
    setSelected(c.conceptId);
    setAnnouncement(`Selected ${c.name}`);
  };

  /** Selects a concept from search and opens its ancestors so it is visible in the tree. */
  const reveal = (c: ConceptView) => {
    dirtyRef.current = true;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let cur = c.parentConceptId; cur; cur = byId.get(cur)?.parentConceptId ?? null) next.add(cur);
      return next;
    });
    select(c);
    setQuery("");
    setFocused(c.conceptId);
    requestAnimationFrame(() => document.getElementById(`node-${c.conceptId}`)?.focus());
  };

  const onTreeKey = (e: React.KeyboardEvent, node: ConceptView) => {
    const i = visible.findIndex((v) => v.conceptId === node.conceptId);
    const kids = children.get(node.conceptId) ?? [];
    const go = (target?: ConceptView) => {
      if (!target) return;
      setFocused(target.conceptId);
      document.getElementById(`node-${target.conceptId}`)?.focus();
    };
    switch (e.key) {
      case "ArrowDown": go(visible[i + 1]); break;
      case "ArrowUp": go(visible[i - 1]); break;
      case "Home": go(visible[0]); break;
      case "End": go(visible[visible.length - 1]); break;
      case "ArrowRight":
        if (kids.length && !expanded.has(node.conceptId)) toggle(node.conceptId, true);
        else go(kids[0]);
        break;
      case "ArrowLeft":
        if (kids.length && expanded.has(node.conceptId)) toggle(node.conceptId, false);
        else go(node.parentConceptId ? byId.get(node.parentConceptId) : undefined);
        break;
      case "Enter":
      case " ": select(node); break;
      default: return;
    }
    e.preventDefault();
  };

  const current = selected ? byId.get(selected) : undefined;
  const tabStop = focused && visible.some((v) => v.conceptId === focused) ? focused : visible[0]?.conceptId;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <section aria-label="Concept tree" className="rounded-md border border-rule bg-surface">
        <div className="border-b border-rule p-3">
          <label htmlFor="concept-search" className="sr-only">
            Search concepts
          </label>
          <input
            id="concept-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search names, paths, definitions, synonyms or IDs"
            className={inputClass}
            autoComplete="off"
          />
        </div>

        {q ? (
          <div className="max-h-[32rem] overflow-y-auto">
            <p role="status" aria-live="polite" className="eyebrow border-b border-rule px-4 py-2">
              {totalMatches === 0 ? "No matching concepts" : `${totalMatches} match${totalMatches === 1 ? "" : "es"}${totalMatches > results.length ? `, showing ${results.length}` : ""}`}
            </p>
            <ul>
              {results.map((c) => (
                <li key={c.conceptId} className="border-b border-rule last:border-0">
                  <button type="button" onClick={() => reveal(c)} className="block w-full px-4 py-2.5 text-left hover:bg-sunken/60">
                    <span className="flex items-center gap-2 text-sm font-medium text-ink">
                      {c.name}
                      {c.mappingAllowed ? <Badge tone="ok">Mappable</Badge> : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">{c.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div
            ref={treeRef}
            role="tree"
            aria-label="Canonical taxonomy"
            onScroll={(e) => saveScroll(e.currentTarget.scrollTop)}
            className="max-h-[32rem] overflow-y-auto py-1"
          >
            {visible.map((node) => {
              const kids = children.get(node.conceptId) ?? [];
              const isOpen = expanded.has(node.conceptId);
              const isSelected = selected === node.conceptId;
              return (
                <div
                  key={node.conceptId}
                  id={`node-${node.conceptId}`}
                  role="treeitem"
                  aria-level={node.depth}
                  aria-expanded={kids.length ? isOpen : undefined}
                  aria-selected={isSelected}
                  tabIndex={tabStop === node.conceptId ? 0 : -1}
                  onKeyDown={(e) => onTreeKey(e, node)}
                  onFocus={() => setFocused(node.conceptId)}
                  onClick={() => select(node)}
                  style={{ paddingLeft: `${(node.depth - 1) * 1.1 + 0.5}rem` }}
                  className={`flex cursor-pointer items-center gap-1.5 py-1.5 pr-3 text-sm outline-offset-[-2px] ${
                    isSelected ? "bg-ink text-white" : "hover:bg-sunken/70"
                  } ${node.status === "inactive" ? "opacity-60" : ""}`}
                >
                  {kids.length ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(node.conceptId);
                      }}
                      className={`grid size-5 shrink-0 place-items-center rounded-sm font-mono text-xs ${isSelected ? "text-white/80" : "text-muted hover:bg-rule"}`}
                    >
                      {isOpen ? "−" : "+"}
                    </button>
                  ) : (
                    <span aria-hidden className={`grid size-5 shrink-0 place-items-center text-[0.5rem] ${isSelected ? "text-white/60" : "text-rule-strong"}`}>
                      ●
                    </span>
                  )}
                  <span className={`truncate ${kids.length ? "font-medium" : ""}`}>{node.name}</span>
                  {kids.length ? <span className={`ml-auto font-mono text-[0.65rem] ${isSelected ? "text-white/60" : "text-muted"}`}>{kids.length}</span> : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section aria-label="Concept detail" className="rounded-md border border-rule bg-surface lg:sticky lg:top-6">
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
        {current ? (
          <div className="p-5">
            <nav aria-label="Concept path">
              <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
                {current.path.split(" > ").map((part, i, all) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <span className={i === all.length - 1 ? "font-medium text-ink" : ""}>{part}</span>
                    {i < all.length - 1 ? <span aria-hidden>›</span> : null}
                  </li>
                ))}
              </ol>
            </nav>
            <h2 className="mt-2 font-display text-2xl font-medium">{current.name}</h2>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone={current.status === "active" ? "ok" : "neutral"}>{current.status}</Badge>
              {current.mappingAllowed ? <Badge tone="info">Accepts product mappings</Badge> : <Badge>{(children.get(current.conceptId) ?? []).length ? "Organizing node" : "Not mappable"}</Badge>}
            </div>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="eyebrow">Definition</dt>
                <dd className="mt-1 leading-relaxed text-ink-soft">{current.definition || <span className="text-muted">No definition recorded.</span>}</dd>
              </div>
              <div>
                <dt className="eyebrow">Synonyms</dt>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {current.synonyms.length ? current.synonyms.map((s) => <span key={s} className="rounded-sm border border-rule bg-sunken/60 px-1.5 py-0.5 text-xs">{s}</span>) : <span className="text-muted">None</span>}
                </dd>
              </div>
              <div className="grid grid-cols-2 gap-3 border-t border-rule pt-3">
                <div>
                  <dt className="eyebrow">Stable ID</dt>
                  <dd className="mt-1 font-mono text-xs break-all">{current.stableKey}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Child concepts</dt>
                  <dd className="mt-1 font-mono text-xs">{(children.get(current.conceptId) ?? []).length}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Published listings</dt>
                  <dd className="mt-1 font-mono text-xs" title="Listings mapped to this concept in merchants' current releases">
                    {current.publishedListings}
                  </dd>
                </div>
                <div>
                  <dt className="eyebrow">Pending proposals</dt>
                  <dd className="mt-1 font-mono text-xs">{current.pendingProposals}</dd>
                </div>
              </div>
            </dl>
            {canPropose ? (
              <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-rule pt-3 text-sm">
                <Link href={`/taxonomy/proposals/new?type=synonym&concept=${current.conceptId}`} className="font-semibold text-stamp underline underline-offset-4">
                  Propose a synonym
                </Link>
                {!current.mappingAllowed && current.status === "active" ? (
                  <Link href={`/taxonomy/proposals/new?type=new_leaf&parent=${current.conceptId}`} className="font-semibold text-stamp underline underline-offset-4">
                    Propose a new leaf here
                  </Link>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="p-6 text-sm text-muted">
            <p className="font-display text-lg text-ink">Select a concept</p>
            <p className="mt-1 leading-relaxed">Use the arrow keys to move through the tree, Right and Left to expand or collapse, and Enter to open a concept.</p>
          </div>
        )}
      </section>
    </div>
  );
}
