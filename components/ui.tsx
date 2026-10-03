import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: ReactNode; title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="rise flex flex-wrap items-end justify-between gap-4 border-b border-rule-strong pb-5">
      <div className="min-w-0">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-1 font-display text-[2rem] leading-tight font-medium tracking-tight text-ink sm:text-[2.4rem]">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-[0.95rem] leading-relaxed text-ink-soft">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

const TONES = {
  neutral: "border-rule-strong bg-sunken text-ink-soft",
  ok: "border-ok/30 bg-ok-bg text-ok",
  warn: "border-warn/30 bg-warn-bg text-warn",
  danger: "border-danger/30 bg-danger-bg text-danger",
  info: "border-info/30 bg-info-bg text-info",
} as const;
export type Tone = keyof typeof TONES;

/** Status is always conveyed by text; colour only reinforces it. */
export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[0.6875rem] tracking-wide uppercase ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-md border border-rule bg-surface shadow-[0_1px_0_var(--color-rule)] ${className}`}>{children}</section>;
}

export function StatePanel({ kind, title, children, action }: { kind: "empty" | "denied" | "error" | "pending" | "stale"; title: string; children?: ReactNode; action?: ReactNode }) {
  const mark = { empty: "∅", denied: "⊘", error: "!", pending: "…", stale: "↻" }[kind];
  const tone = kind === "error" || kind === "denied" ? "text-danger border-danger/40" : kind === "stale" ? "text-warn border-warn/40" : "text-muted border-rule-strong";
  return (
    <div role={kind === "error" ? "alert" : "status"} className="flex flex-col items-start gap-3 rounded-md border border-dashed border-rule-strong bg-surface/70 p-6 sm:flex-row sm:items-center">
      <span aria-hidden className={`grid size-10 shrink-0 place-items-center rounded-full border font-display text-lg ${tone}`}>{mark}</span>
      <div className="min-w-0 flex-1">
        <h2 className="font-display text-lg font-medium text-ink">{title}</h2>
        {children ? <div className="mt-1 text-sm leading-relaxed text-ink-soft">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export const buttonClass = {
  primary:
    "inline-flex items-center justify-center gap-2 rounded-sm bg-stamp px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-stamp-dark disabled:cursor-not-allowed disabled:opacity-60",
  secondary:
    "inline-flex items-center justify-center gap-2 rounded-sm border border-rule-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-60",
};

export const inputClass =
  "w-full rounded-sm border border-rule-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/70 aria-[invalid=true]:border-danger";

export function NotBuiltYet({ eyebrow, title, phase, requirements, summary }: { eyebrow: string; title: string; phase: string; requirements: string; summary: string }) {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={eyebrow} title={title} />
      <StatePanel kind="pending" title={`Not built yet: scheduled for ${phase}`}>
        <p>{summary}</p>
        <p className="mt-2 font-mono text-xs text-muted">Requirements: {requirements}. Progress is tracked in BUILD_STATUS.md. Nothing on this page is simulated.</p>
      </StatePanel>
    </div>
  );
}
