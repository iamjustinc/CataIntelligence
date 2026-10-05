"use client";

import Link from "next/link";
import { useState } from "react";
import { BarList, LineChart } from "@/components/charts";
import { Badge, buttonClass } from "@/components/ui";
import { DIMENSION_LABELS, drilldownHref, formatFraction, formatValue } from "@/lib/analytics/format";
import { METRICS } from "@/lib/analytics/metric-registry";
import type { ResultRow } from "@/lib/analytics/metric-service";
import type { RunView } from "@/lib/domain/analytics";

const PAGE = 20;
const CHART_LIMIT = 20;
const SOURCE: Record<string, { label: string; tone: "neutral" | "info" | "warn" }> = {
  demo: { label: "Demo planner · not AI", tone: "warn" },
  live: { label: "Live AI interpretation", tone: "info" },
  builder: { label: "Built with controls", tone: "neutral" },
  report: { label: "Report refresh", tone: "neutral" },
};

const rowLabel = (row: ResultRow, dims: readonly string[]) => dims.map((d) => row.dims[d as keyof ResultRow["dims"]]?.label ?? "").join(" · ");

/** One executed analysis: summary, chart, table, definition, scope, warnings and links. Read-only. */
export function ResultView({ run, heading, children }: { run: RunView; heading?: string; children?: React.ReactNode }) {
  const [page, setPage] = useState(0);
  const { result } = run;
  const { dimensions, metrics } = result.columns;
  const primary = metrics[0];
  const def = METRICS[primary];
  const grouped = dimensions.length > 0;
  const empty = grouped && result.rows.length === 0;
  const timeDim = dimensions.find((d) => d.startsWith("utc_"));
  const pages = Math.max(Math.ceil(result.rows.length / PAGE), 1);
  const visible = result.rows.slice(page * PAGE, page * PAGE + PAGE);
  // The whole filtered population, whatever the grouping.
  const overall = drilldownHref({ ...result.spec, groupBy: [] }, primary);
  const usesMapping = metrics.some((m) => METRICS[m].mappingState === "published" || METRICS[m].family === "publication") || ((dimensions.includes("canonical_branch") || result.spec.filters.some((f) => f.dimension === "canonical_branch")) && result.spec.scope.mappingState === "published");
  const source = SOURCE[run.planner ?? "builder"] ?? SOURCE.builder;

  let chart: React.ReactNode = null;
  if (!empty && grouped && result.spec.chartType === "line" && timeDim) {
    const points = [...result.rows].filter((r) => r.values[primary]?.value !== null && r.values[primary]?.value !== undefined).sort((a, b) => a.dims[timeDim]!.value.localeCompare(b.dims[timeDim]!.value));
    chart = <LineChart label={`${def.label} by ${DIMENSION_LABELS[timeDim].toLowerCase()}`} yLabel={def.label} points={points.map((r) => ({ key: rowLabel(r, dimensions), label: r.dims[timeDim]!.value, value: r.values[primary]!.value!, text: formatValue(primary, r.values[primary]) }))} />;
  } else if (!empty && grouped && result.spec.chartType !== "table") {
    const shown = result.rows.slice(0, CHART_LIMIT);
    chart = (
      <>
        <BarList
          label={`${def.label} by ${dimensions.map((d) => DIMENSION_LABELS[d].toLowerCase()).join(" and ")}`}
          max={def.kind === "ratio" ? 1 : undefined}
          tone={def.kind === "ratio" ? "ok" : "ink"}
          data={shown.map((r) => ({ key: rowLabel(r, dimensions), label: rowLabel(r, dimensions), value: r.values[primary]?.value ?? null, text: formatValue(primary, r.values[primary]), detail: def.kind === "ratio" ? formatFraction(r.values[primary]) : null }))}
        />
        {result.rows.length > CHART_LIMIT ? <p className="mt-2 text-xs text-muted">The chart shows the first {CHART_LIMIT} of {result.rows.length} rows in the selected order. The table below has all of them.</p> : null}
      </>
    );
  }

  return (
    <article className="rounded-md border border-rule bg-surface shadow-[0_1px_0_var(--color-rule)]" data-testid="analysis-result" data-run-id={run.id}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rule px-5 py-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg leading-snug font-medium">{heading ?? run.question ?? metrics.map((m) => METRICS[m].label).join(", ")}</h3>
          <p className="mt-0.5 font-mono text-[0.6875rem] text-muted">
            Run {run.id.slice(0, 8)} · computed {run.createdAt.slice(0, 16).replace("T", " ")} UTC
          </p>
        </div>
        <Badge tone={source.tone}>{source.label}</Badge>
      </header>

      <div className="space-y-5 px-5 py-4">
        <p className="text-[0.95rem] leading-relaxed text-ink" data-testid="result-summary">
          {run.summary}
        </p>

        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-soft" aria-label="Interpretation" data-testid="result-interpretation">
          {run.description.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        {result.warnings.length > 0 ? (
          <ul className="space-y-1.5 rounded-sm border border-warn/40 bg-warn-bg px-4 py-3 text-sm text-warn" aria-label="Notes about this result" data-testid="result-warnings">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}

        {chart}

        {empty ? (
          <p className="rounded-sm border border-dashed border-rule-strong px-4 py-6 text-center text-sm text-ink-soft">No matching records.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="result-table">
              <caption className="sr-only">{`${metrics.map((m) => METRICS[m].label).join(", ")}${grouped ? ` by ${dimensions.map((d) => DIMENSION_LABELS[d]).join(", ")}` : ""}`}</caption>
              <thead>
                <tr className="border-b border-rule-strong text-left">
                  {dimensions.map((d) => (
                    <th key={d} scope="col" className="eyebrow py-2 pr-4 font-normal">
                      {DIMENSION_LABELS[d]}
                    </th>
                  ))}
                  {metrics.map((m) => (
                    <th key={m} scope="col" className="eyebrow py-2 pr-4 text-right font-normal">
                      {METRICS[m].label}
                    </th>
                  ))}
                  {grouped ? (
                    <th scope="col" className="eyebrow py-2 font-normal">
                      Evidence
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {(grouped ? visible : []).map((row) => {
                  const link = drilldownHref(result.spec, primary, row);
                  return (
                    <tr key={rowLabel(row, dimensions)}>
                      {dimensions.map((d, i) =>
                        i === 0 ? (
                          <th key={d} scope="row" className="py-2 pr-4 text-left font-medium">
                            {row.dims[d]?.label}
                          </th>
                        ) : (
                          <td key={d} className="py-2 pr-4">
                            {row.dims[d]?.label}
                          </td>
                        ),
                      )}
                      {metrics.map((m) => (
                        <td key={m} className="py-2 pr-4 text-right font-mono whitespace-nowrap">
                          {formatValue(m, row.values[m])}
                          {METRICS[m].kind === "ratio" && row.values[m]?.value !== null ? <span className="ml-2 text-xs text-muted">{formatFraction(row.values[m])}</span> : null}
                        </td>
                      ))}
                      <td className="py-2">
                        {link ? (
                          <Link href={link.href} className="font-semibold text-stamp underline underline-offset-4">
                            {link.label}
                          </Link>
                        ) : (
                          <span className="text-xs text-muted">No exact listing filter</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className={`font-medium ${grouped ? "border-t border-rule-strong" : ""}`} data-testid="result-total">
                  {grouped ? (
                    <th scope="row" colSpan={dimensions.length} className="py-2 pr-4 text-left">
                      Total{dimensions.some((d) => d.startsWith("utc_")) && metrics.includes("reviewed_listing_count") ? " (distinct listings)" : ""}
                    </th>
                  ) : null}
                  {metrics.map((m) => (
                    <td key={m} className="py-2 pr-4 text-right font-mono whitespace-nowrap">
                      {formatValue(m, result.totals[m])}
                      {METRICS[m].kind === "ratio" && result.totals[m]?.value !== null ? <span className="ml-2 text-xs font-normal text-muted">{formatFraction(result.totals[m])}</span> : null}
                    </td>
                  ))}
                  {grouped ? <td /> : null}
                </tr>
              </tfoot>
            </table>
            {pages > 1 ? (
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted">
                  Rows {page * PAGE + 1} to {Math.min((page + 1) * PAGE, result.rows.length)} of {result.rows.length}
                </span>
                <span className="flex gap-2">
                  <button type="button" className={buttonClass.secondary} disabled={page === 0} onClick={() => setPage(page - 1)}>
                    Previous
                  </button>
                  <button type="button" className={buttonClass.secondary} disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                    Next
                  </button>
                </span>
              </div>
            ) : null}
          </div>
        )}

        <div className="grid gap-3 text-sm md:grid-cols-2">
          <details className="rounded-sm border border-rule px-4 py-2.5">
            <summary className="cursor-pointer font-medium">Metric definition</summary>
            <dl className="mt-2 space-y-2 text-ink-soft">
              {metrics.map((m) => (
                <div key={m}>
                  <dt className="font-medium text-ink">{METRICS[m].label}</dt>
                  <dd>{METRICS[m].definition}</dd>
                  {METRICS[m].numerator ? <dd>Numerator: {METRICS[m].numerator}.</dd> : null}
                  {METRICS[m].denominator ? <dd>Denominator: {METRICS[m].denominator}.</dd> : null}
                  <dd className="text-muted">{METRICS[m].scopeNote}</dd>
                </div>
              ))}
            </dl>
          </details>
          <details className="rounded-sm border border-rule px-4 py-2.5">
            <summary className="cursor-pointer font-medium">Data scope</summary>
            <ul className="mt-2 space-y-1 text-ink-soft" data-testid="result-scope">
              {result.scope.merchants.length === 0 ? <li>No merchants in this workspace.</li> : null}
              {result.scope.merchants.map((m) => (
                <li key={m.merchantId}>
                  {m.merchantName}: {m.revisionSequence ? `catalog revision ${m.revisionSequence}` : "no catalog revision"}; {m.releaseNumber ? `release ${m.releaseNumber}` : m.releaseSuperseded ? "no release for the current revision (an earlier one exists)" : "no release"}
                </li>
              ))}
              <li>Taxonomy version: {result.scope.taxonomySequence ?? "none published"}</li>
              <li>Workspace timezone: {result.scope.timezone}</li>
              <li className="font-mono text-xs">Run ID {run.id}</li>
            </ul>
          </details>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule pt-4 text-sm">
          {overall ? (
            <Link href={overall.href} className="font-semibold text-stamp underline underline-offset-4" data-testid="result-drilldown">
              {overall.label}
            </Link>
          ) : null}
          {usesMapping ? (
            <Link href="/releases" className="font-semibold underline underline-offset-4">
              View releases
            </Link>
          ) : null}
          {dimensions.includes("canonical_branch") || result.spec.filters.some((f) => f.dimension === "canonical_branch") ? (
            <Link href="/taxonomy" className="font-semibold underline underline-offset-4">
              View canonical concepts
            </Link>
          ) : null}
          <a href={`/api/analytics/runs/${run.id}/export`} className="font-semibold underline underline-offset-4" data-testid="result-export">
            Export CSV
          </a>
          {children}
        </div>
      </div>
    </article>
  );
}
