"use client";

import { useId } from "react";
import { inputClass } from "@/components/ui";
import { DIMENSION_LABELS } from "@/lib/analytics/format";
import { METRIC_IDS, METRICS, type DimensionId, type MetricId } from "@/lib/analytics/metric-registry";
import type { Vocabulary } from "@/lib/analytics/planner";
import { dateRangeInterval, PERIOD_LABELS, periodInterval, PERIODS, type Period } from "@/lib/analytics/time";
import type { AnalysisSpec } from "@/lib/contracts/analysis-spec";
import { BAND_LABELS, REVIEW_STATES, SIGNAL_BANDS, STATE_LABELS } from "@/lib/review-labels";

type FilterDim = AnalysisSpec["filters"][number]["dimension"];

/** Keeps a spec inside what the registry allows after the metric changes. The server validates again. */
export function conform(spec: AnalysisSpec, metricId: MetricId): AnalysisSpec {
  const def = METRICS[metricId];
  const groupBy = spec.groupBy.filter((d) => def.dimensions.includes(d));
  return {
    ...spec,
    metricIds: [metricId],
    groupBy,
    filters: spec.filters.filter((f) => def.filters.includes(f.dimension)),
    timeRange: def.timestamp ? spec.timeRange : null,
    scope: { population: "current_catalogs", mappingState: def.mappingState ?? spec.scope.mappingState },
    sort: spec.sort?.field === spec.metricIds[0] && groupBy.length ? { field: metricId, direction: spec.sort.direction } : null,
    chartType: groupBy.some((d) => d.startsWith("utc_")) ? "line" : groupBy.length ? (spec.chartType === "line" ? "bar" : spec.chartType) : "table",
  };
}

const dateIn = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/**
 * Fixed controls for every part of an AnalysisSpec. Works without any AI provider, and is the way
 * to correct an interpretation before running it (PRD ANA03).
 */
export function SpecEditor({ spec, onChange, vocabulary, now }: { spec: AnalysisSpec; onChange: (spec: AnalysisSpec) => void; vocabulary: Vocabulary; now: Date }) {
  const uid = useId();
  const metricId = spec.metricIds[0];
  const def = METRICS[metricId];
  const filterValue = (dimension: FilterDim) => spec.filters.find((f) => f.dimension === dimension)?.values[0] ?? "";
  const setFilter = (dimension: FilterDim, value: string) => onChange({ ...spec, filters: [...spec.filters.filter((f) => f.dimension !== dimension), ...(value ? [{ dimension, operator: "eq" as const, values: [value] }] : [])] });
  const usesBranch = spec.groupBy.includes("canonical_branch") || spec.filters.some((f) => f.dimension === "canonical_branch");
  const scopeMatters = !!def.mappingState || usesBranch;

  const presets = Object.fromEntries(PERIODS.map((p) => [p, periodInterval(p, now, vocabulary.timezone)])) as Record<Period, { start: string; end: string }>;
  const period = spec.timeRange === null ? "all" : (PERIODS.find((p) => presets[p].start === spec.timeRange!.start && presets[p].end === spec.timeRange!.end) ?? "custom");
  const from = spec.timeRange ? dateIn(spec.timeRange.start, vocabulary.timezone) : "";
  // The stored end is exclusive; the control shows the last included day.
  const to = spec.timeRange ? dateIn(new Date(new Date(spec.timeRange.end).getTime() - 1).toISOString(), vocabulary.timezone) : "";
  const setDates = (a: string, b: string) => {
    const interval = dateRangeInterval(a, b, vocabulary.timezone);
    if (interval) onChange({ ...spec, timeRange: interval });
  };

  const field = (label: string, name: string, control: React.ReactNode, hint?: string) => (
    <div>
      <label htmlFor={`${uid}-${name}`} className="eyebrow mb-1 block">
        {label}
      </label>
      {control}
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
  const select = (name: string, value: string, onValue: (v: string) => void, options: [string, string][], disabled = false) => (
    <select id={`${uid}-${name}`} value={value} disabled={disabled} onChange={(e) => onValue(e.target.value)} className={`${inputClass} disabled:bg-sunken disabled:text-muted`}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );

  return (
    <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="spec-editor">
      <legend className="sr-only">Analysis settings</legend>
      {field("Metric", "metric", select("metric", metricId, (v) => onChange(conform(spec, v as MetricId)), METRIC_IDS.map((id) => [id, METRICS[id].label])))}
      {field(
        "Group by",
        "group",
        select("group", spec.groupBy[0] ?? "", (v) => onChange(conform({ ...spec, groupBy: v ? [v as DimensionId] : [], sort: spec.sort?.field === metricId ? spec.sort : null }, metricId)), [["", "No grouping (total only)"], ...def.dimensions.map((d): [string, string] => [d, DIMENSION_LABELS[d]])]),
        def.kind === "ratio" ? "Coverage cannot be grouped by category: unmapped listings have none." : undefined,
      )}
      {field("Merchant", "merchant", select("merchant", filterValue("merchant"), (v) => setFilter("merchant", v), [["", "All merchants"], ...vocabulary.merchants.map((m): [string, string] => [m.id, m.name])]))}
      {def.filters.includes("canonical_branch")
        ? field("Canonical branch", "branch", select("branch", filterValue("canonical_branch"), (v) => setFilter("canonical_branch", v), [["", "Any branch"], ...vocabulary.branches.map((b): [string, string] => [b.key, b.name]), ["Unmapped", "Unmapped"]]))
        : null}
      {def.filters.includes("decision_status")
        ? field("Decision status", "status", select("status", filterValue("decision_status"), (v) => setFilter("decision_status", v), [["", "Any status"], ...REVIEW_STATES.map((s): [string, string] => [s, STATE_LABELS[s]])]))
        : null}
      {def.filters.includes("signal_band")
        ? field("Signal band", "band", select("band", filterValue("signal_band"), (v) => setFilter("signal_band", v), [["", "Any signal"], ...SIGNAL_BANDS.map((b): [string, string] => [b, BAND_LABELS[b]]), ["no_recommendation", "No analysis yet"]]))
        : null}
      {def.family === "snapshot"
        ? field(
            "Mapping scope",
            "scope",
            select("scope", spec.scope.mappingState, (v) => onChange({ ...spec, scope: { population: "current_catalogs", mappingState: v as "published" | "draft" } }), [["published", "Published (current releases)"], ["draft", "Draft (reviewer-approved)"]], !!def.mappingState || !scopeMatters),
            def.mappingState ? "Fixed by the metric." : scopeMatters ? "Decides which mapping a branch comes from." : "Not used by this analysis.",
          )
        : null}
      {def.family !== "snapshot" ? (
        <>
          {field(
            "Period",
            "period",
            select(
              "period",
              period,
              (v) => onChange({ ...spec, timeRange: v === "all" ? null : v === "custom" ? (spec.timeRange ?? presets.last_30_days) : presets[v as Period] }),
              [["all", "All recorded activity"], ...PERIODS.map((p): [string, string] => [p, PERIOD_LABELS[p]]), ["custom", "Custom dates"]],
            ),
            `Read in ${vocabulary.timezone}.`,
          )}
          {spec.timeRange
            ? field(
                "From (first day)",
                "from",
                <input id={`${uid}-from`} type="date" value={from} max={to} onChange={(e) => setDates(e.target.value, to)} className={inputClass} />,
              )
            : null}
          {spec.timeRange ? field("To (last day, included)", "to", <input id={`${uid}-to`} type="date" value={to} min={from} onChange={(e) => setDates(from, e.target.value)} className={inputClass} />) : null}
        </>
      ) : null}
      {field(
        "Sort",
        "sort",
        select("sort", spec.sort?.field === metricId ? spec.sort.direction : "", (v) => onChange({ ...spec, sort: v ? { field: metricId, direction: v as "asc" | "desc" } : null }), [["", spec.groupBy[0]?.startsWith("utc_") ? "Oldest first" : "By name"], ["asc", "Lowest value first"], ["desc", "Highest value first"]], spec.groupBy.length === 0),
      )}
      {field(
        "Display",
        "chart",
        select(
          "chart",
          spec.chartType,
          (v) => onChange({ ...spec, chartType: v as AnalysisSpec["chartType"] }),
          [["table", "Table"], ...(spec.groupBy.length ? ([spec.groupBy[0].startsWith("utc_") ? ["line", "Line chart and table"] : ["bar", "Bar chart and table"]] as [string, string][]) : [])],
          spec.groupBy.length === 0,
        ),
      )}
    </fieldset>
  );
}
