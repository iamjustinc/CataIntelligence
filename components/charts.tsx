import type { ReactNode } from "react";

/**
 * Small accessible charts with no client code. Every value drawn is also present as text, and each
 * chart sits beside (or contains) a table with the same cells, so nothing depends on colour or on
 * reading a mark's length.
 */
export interface BarDatum {
  key: string;
  label: string;
  /** Position on the axis; null draws no bar and shows the text only. */
  value: number | null;
  /** Exact text shown beside the bar. */
  text: string;
  detail?: string | null;
  href?: string | null;
}

export function BarList({ data, max, label, tone = "ink", emptyText = "No matching records." }: { data: BarDatum[]; /** Axis maximum; defaults to the largest value. Use 1 for rates. */ max?: number; label: string; tone?: "ink" | "stamp" | "ok"; emptyText?: string }) {
  if (data.length === 0) return <p className="text-sm text-muted">{emptyText}</p>;
  const top = max ?? Math.max(...data.map((d) => d.value ?? 0), 0);
  const fill = { ink: "bg-ink-soft", stamp: "bg-stamp", ok: "bg-ok" }[tone];
  return (
    <ul aria-label={label} className="space-y-2.5">
      {data.map((d) => {
        const width = d.value === null || top === 0 ? 0 : Math.max((d.value / top) * 100, d.value > 0 ? 0.75 : 0);
        const name = d.href ? (
          <a href={d.href} className="underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
            {d.label}
          </a>
        ) : (
          d.label
        );
        return (
          <li key={d.key} className="grid grid-cols-[minmax(6rem,11rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate text-ink" title={d.label}>
              {name}
            </span>
            <span aria-hidden className="h-3.5 rounded-[1px] bg-sunken">
              <span className={`block h-full rounded-[1px] ${fill}`} style={{ width: `${width}%` }} />
            </span>
            <span className="text-right font-mono text-[0.8125rem] whitespace-nowrap text-ink">
              {d.text}
              {d.detail ? <span className="ml-2 text-muted">{d.detail}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface LinePoint {
  key: string;
  label: string;
  value: number;
  text: string;
}

/** A single series over ordered periods. Periods with no row are not invented: only returned points are drawn. */
export function LineChart({ points, label, yLabel }: { points: LinePoint[]; label: string; yLabel: string }) {
  if (points.length === 0) return <p className="text-sm text-muted">No matching records.</p>;
  const [w, h, left, right, topPad, bottom] = [640, 200, 44, 12, 14, 30];
  const max = Math.max(...points.map((p) => p.value), 1);
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1];
  const x = (i: number) => (points.length === 1 ? left + (w - left - right) / 2 : left + (i * (w - left - right)) / (points.length - 1));
  const y = (v: number) => topPad + (1 - v / yMax) * (h - topPad - bottom);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const every = Math.ceil(points.length / 8);
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}. ${points.length} points, from ${points[0].label} to ${points[points.length - 1].label}. Highest ${Math.max(...points.map((p) => p.value))}.`} className="w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={w - right} y1={y(t)} y2={y(t)} stroke="var(--color-rule)" strokeWidth={1} />
            <text x={left - 8} y={y(t) + 4} textAnchor="end" className="fill-muted font-mono text-[11px]">
              {t}
            </text>
          </g>
        ))}
        {points.length > 1 ? <path d={path} fill="none" stroke="var(--color-ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {points.map((p, i) => (
          <g key={p.key}>
            <circle cx={x(i)} cy={y(p.value)} r={points.length > 40 ? 2 : 3.5} fill="var(--color-surface)" stroke="var(--color-stamp)" strokeWidth={2}>
              <title>{`${p.label}: ${p.text}`}</title>
            </circle>
            {i % every === 0 || i === points.length - 1 ? (
              <text x={x(i)} y={h - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className="fill-muted font-mono text-[11px]">
                {p.label.slice(5)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <figcaption className="mt-1 text-xs text-muted">{yLabel}. Only periods with recorded activity are plotted; a missing period means none was recorded.</figcaption>
    </figure>
  );
}

function niceTicks(max: number): number[] {
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000].find((s) => max / s <= 4) ?? Math.ceil(max / 4);
  const out: number[] = [];
  for (let v = 0; v < max + step; v += step) out.push(v);
  return out;
}

export interface Segment {
  key: string;
  label: string;
  value: number;
  href?: string;
  tone: "neutral" | "ok" | "warn" | "danger" | "info";
}

const SEGMENT_FILL: Record<Segment["tone"], string> = { neutral: "bg-rule-strong", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", info: "bg-info" };

/** Parts of one whole, with a legend that carries every count as text. */
export function Distribution({ segments, label, unit }: { segments: Segment[]; label: string; unit: string }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return <p className="text-sm text-muted">No matching records.</p>;
  return (
    <div>
      <div aria-hidden className="flex h-4 gap-px overflow-hidden rounded-[2px] bg-surface">
        {segments.filter((s) => s.value > 0).map((s) => <span key={s.key} className={SEGMENT_FILL[s.tone]} style={{ width: `${(s.value / total) * 100}%` }} title={`${s.label}: ${s.value}`} />)}
      </div>
      <ul aria-label={label} className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {segments.map((s) => (
          <li key={s.key} className="flex items-baseline justify-between gap-3 border-b border-rule/70 pb-1">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden className={`size-2.5 shrink-0 rounded-[1px] ${SEGMENT_FILL[s.tone]}`} />
              {s.href ? (
                <a href={s.href} className="truncate underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
                  {s.label}
                </a>
              ) : (
                <span className="truncate">{s.label}</span>
              )}
            </span>
            <span className="font-mono text-[0.8125rem] whitespace-nowrap">
              {s.value.toLocaleString("en-US")} <span className="text-muted">{((s.value / total) * 100).toFixed(1)}%</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">
        {total.toLocaleString("en-US")} {unit}
      </p>
    </div>
  );
}

export function ChartFrame({ title, scope, children, action }: { title: string; scope: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-md border border-rule bg-surface shadow-[0_1px_0_var(--color-rule)]">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-5 py-3">
        <h2 className="font-display text-lg font-medium">{title}</h2>
        {action}
      </header>
      <div className="px-5 py-4">{children}</div>
      <footer className="border-t border-rule px-5 py-2.5 text-xs leading-relaxed text-muted">{scope}</footer>
    </section>
  );
}
