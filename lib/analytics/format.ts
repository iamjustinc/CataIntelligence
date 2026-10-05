/**
 * Presentation helpers shared by the dashboard, analytics results, exports and tests. Safe to
 * import from client components: no database access. Every sentence here is a template filled
 * from result cells, so a summary can never state a number the query did not return (ANA04).
 */
import type { AnalysisSpec } from "@/lib/contracts/analysis-spec";
import { BAND_LABELS, STATE_LABELS, type ReviewState, type SignalBand } from "@/lib/review-labels";
import { METRICS, type DimensionId, type MetricId } from "./metric-registry";
import type { MetricResult, MetricValue, ResultRow } from "./metric-service";
import { formatInstant } from "./time";

export const DIMENSION_LABELS: Record<DimensionId, string> = { merchant: "Merchant", canonical_branch: "Canonical branch", decision_status: "Decision status", signal_band: "Signal band", utc_day: "Day (UTC)", utc_week: "Week starting (UTC)" };
export const NOT_APPLICABLE = "Not applicable";

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** Display rounding only; the stored value is exact. */
export function formatValue(metricId: MetricId, v: MetricValue | undefined): string {
  if (!v || v.value === null) return NOT_APPLICABLE;
  const kind = METRICS[metricId].kind;
  if (kind === "ratio") return `${(v.value * 100).toFixed(1)}%`;
  if (kind === "duration") return formatDuration(v.value);
  return v.value.toLocaleString("en-US");
}
/** "58 of 100" beside a rate. */
export function formatFraction(v: MetricValue | undefined): string | null {
  return v && v.numerator !== undefined && v.denominator !== undefined ? `${v.numerator.toLocaleString("en-US")} of ${v.denominator.toLocaleString("en-US")}` : null;
}

export function filterValueLabel(dimension: string, value: string, names: { merchants: { id: string; name: string }[]; branches: { key: string; name: string }[] }): string {
  if (dimension === "merchant") return names.merchants.find((m) => m.id === value)?.name ?? "Unknown merchant";
  if (dimension === "canonical_branch") return names.branches.find((b) => b.key === value)?.name ?? value;
  if (dimension === "decision_status") return STATE_LABELS[value as ReviewState] ?? value;
  if (dimension === "signal_band") return value === "no_recommendation" ? "No analysis yet" : (BAND_LABELS[value as SignalBand] ?? value);
  return value;
}

const rowName = (row: ResultRow, dims: DimensionId[]) => dims.map((d) => row.dims[d]?.label ?? "").join(" · ");

/** A deterministic sentence or two built only from returned cells. */
export function summarize(result: MetricResult): string {
  const metricId = result.columns.metrics[0];
  const metric = METRICS[metricId];
  const total = result.totals[metricId];
  const dims = result.columns.dimensions;
  const describe = (v: MetricValue | undefined) => {
    const fraction = metric.kind === "ratio" ? formatFraction(v) : null;
    return `${formatValue(metricId, v)}${fraction && v?.value !== null ? ` (${fraction} listings)` : ""}`;
  };
  const noData = metric.kind === "ratio" ? total?.denominator === 0 : metric.kind === "duration" ? total?.value === null : false;
  if (result.rowCount === 0 || (dims.length > 0 && result.rows.length === 0)) return "No matching records.";
  if (noData) return `${metric.label}: ${NOT_APPLICABLE}. ${metric.kind === "ratio" ? "There are no active listings in this scope, so there is no denominator." : "No individual review sessions with a recorded duration are in this scope."}`;
  const overall = `${metric.label} is ${describe(total)} overall.`;
  if (dims.length === 0) return overall;
  const ranked = result.rows.filter((r) => r.values[metricId]?.value !== null && r.values[metricId]?.value !== undefined);
  if (ranked.length === 0) return overall;
  if (dims[0].startsWith("utc_")) {
    const peak = ranked.reduce((a, b) => (b.values[metricId]!.value! > a.values[metricId]!.value! ? b : a));
    return `${overall} Across ${result.rowCount} ${dims[0] === "utc_day" ? "day" : "week"}${result.rowCount === 1 ? "" : "s"} with activity, the highest was ${formatValue(metricId, peak.values[metricId])} (${rowName(peak, dims)}).`;
  }
  const low = ranked.reduce((a, b) => (b.values[metricId]!.value! < a.values[metricId]!.value! ? b : a));
  const high = ranked.reduce((a, b) => (b.values[metricId]!.value! > a.values[metricId]!.value! ? b : a));
  if (ranked.length === 1 || low === high) return `${overall} ${rowName(high, dims)}: ${describe(high.values[metricId])}.`;
  return `${overall} Highest: ${rowName(high, dims)} at ${describe(high.values[metricId])}. Lowest: ${rowName(low, dims)} at ${describe(low.values[metricId])}.${result.truncated ? " Based on the rows shown." : ""}`;
}

/** The interpretation in words, shown before and after execution. */
export function describeSpec(spec: AnalysisSpec, names: { timezone: string; merchants: { id: string; name: string }[]; branches: { key: string; name: string }[] }): string[] {
  const lines = [`Metric: ${spec.metricIds.map((id) => METRICS[id].label).join(", ")}`];
  if (spec.groupBy.length) lines.push(`Grouped by: ${spec.groupBy.map((d) => DIMENSION_LABELS[d]).join(", ")}`);
  for (const f of spec.filters) lines.push(`${DIMENSION_LABELS[f.dimension]}: ${f.values.map((v) => filterValueLabel(f.dimension, v, names)).join(", ")}`);
  const family = METRICS[spec.metricIds[0]].family;
  if (family === "snapshot") lines.push(`Population: active listings in each merchant's current catalog revision, as of now`);
  if (spec.metricIds.some((id) => METRICS[id].mappingState) || spec.groupBy.includes("canonical_branch") || spec.filters.some((f) => f.dimension === "canonical_branch")) {
    lines.push(spec.scope.mappingState === "published" ? "Mapping scope: published (each merchant's current release for its current catalog revision)" : "Mapping scope: draft (reviewer-approved decisions, published or not)");
  }
  if (family === "publication") lines.push("Population: mapping releases, by the time each was published");
  if (family !== "snapshot") lines.push(spec.timeRange ? `Period: ${formatInstant(spec.timeRange.start, names.timezone)} up to, not including, ${formatInstant(spec.timeRange.end, names.timezone)} (${names.timezone})` : `Period: all recorded ${family === "publication" ? "publications" : "review activity"}`);
  if (spec.sort && spec.groupBy.length) lines.push(`Sorted by: ${(spec.metricIds as string[]).includes(spec.sort.field) ? METRICS[spec.sort.field as MetricId].label : DIMENSION_LABELS[spec.sort.field as DimensionId]}, ${spec.sort.direction === "asc" ? "lowest" : "highest"} first`);
  return lines;
}

/** Review-queue link for a result row or card. Null when no queue filter expresses the cell exactly. */
export function drilldownHref(spec: AnalysisSpec, metricId: MetricId, row?: ResultRow): { href: string; label: string } | null {
  if (METRICS[metricId].family !== "snapshot") return null;
  const q = new URLSearchParams();
  const set = (dimension: string, value: string): boolean => {
    if (dimension === "merchant") q.set("merchant", value);
    else if (dimension === "decision_status") q.set("state", value);
    else if (dimension === "signal_band") q.set(value === "no_recommendation" ? "unanalyzed" : "band", value === "no_recommendation" ? "1" : value);
    else return false; // A branch has no exact queue filter.
    return true;
  };
  for (const f of spec.filters) {
    if (f.values.length !== 1 || !set(f.dimension, f.values[0])) return null;
  }
  for (const d of spec.groupBy) {
    const v = row?.dims[d];
    if (!v || !set(d, v.value)) return null;
  }
  let label = "Review these listings";
  switch (metricId) {
    case "published_mapping_coverage": q.set("published", "unmapped"); label = "Review unpublished listings"; break;
    case "approved_draft_coverage":
    case "pending_review_count":
      if (q.has("state") && q.get("state") === "approved") return null;
      if (!q.has("state")) q.set("state", "unresolved");
      label = "Review pending listings";
      break;
    case "ambiguous_count": q.set("flag", "ambiguous"); label = "Review ambiguous listings"; break;
    case "failed_analysis_count": q.set("flag", "failed"); label = "Review failed analyses"; break;
    default: break;
  }
  return { href: `/review?${q}`, label };
}
