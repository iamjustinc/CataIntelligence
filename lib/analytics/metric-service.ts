/**
 * The shared metric service (PRD sections 8 and 9).
 *
 * Dashboard cards, analytics answers, charts, exports and drilldown counts all call `runSpec`, so
 * they cannot disagree. A validated AnalysisSpec is compiled here into one parameterized query
 * assembled from fixed SQL fragments chosen by registry keys. Nothing a model wrote is ever
 * executed: the spec carries identifiers and values only, and every value is bound as a parameter.
 * The workspace comes from the caller's verified session through row-level security.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { withContext, type Tx } from "@/db/client";
import { catalogRevisions, conceptRevisions, concepts, currentReleases, mappingReleases, merchants, taxonomyVersions, workspaces } from "@/db/schema";
import { ApiError, forbidden } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { analysisSpecSchema, type AnalysisSpec } from "@/lib/contracts/analysis-spec";
import { BAND_LABELS, REVIEW_STATES, SIGNAL_BANDS, STATE_LABELS, type ReviewState, type SignalBand } from "@/lib/review-labels";
import { METRICS, type DimensionId, type MetricId } from "./metric-registry";

export const UNMAPPED = "Unmapped";
export const NO_RECOMMENDATION = "no_recommendation";
export const MAX_ROWS = 1000;

export interface MetricValue {
  /** null means Not applicable (for example a zero denominator or no sessions), never zero. */
  value: number | null;
  numerator?: number;
  denominator?: number;
}
export interface DimensionValue {
  /** Stable value used for filters and drilldowns (merchant ID, state, band, branch name, ISO date). */
  value: string;
  label: string;
}
export interface ResultRow {
  dims: Partial<Record<DimensionId, DimensionValue>>;
  values: Partial<Record<MetricId, MetricValue>>;
}
export interface MerchantScope {
  merchantId: string;
  merchantName: string;
  catalogRevisionId: string | null;
  revisionSequence: number | null;
  /** The merchant's current release, when it was made from the current catalog revision. */
  releaseId: string | null;
  releaseNumber: number | null;
  /** A current release exists but belongs to a superseded catalog revision. */
  releaseSuperseded: boolean;
}
export interface DataScope {
  population: "current_catalogs";
  mappingState: "published" | "draft";
  taxonomyVersionId: string | null;
  taxonomySequence: number | null;
  timezone: string;
  /** Half-open interval [start, end) in UTC, for activity metrics. */
  timeRange: { start: string; end: string } | null;
  merchants: MerchantScope[];
  observedAt: string;
}
export interface MetricResult {
  spec: AnalysisSpec;
  columns: { dimensions: DimensionId[]; metrics: MetricId[] };
  rows: ResultRow[];
  /** Computed over the whole filtered population by summing numerators and denominators. */
  totals: Partial<Record<MetricId, MetricValue>>;
  /** Rows before the limit was applied. */
  rowCount: number;
  truncated: boolean;
  scope: DataScope;
  warnings: string[];
  /** Median review time: sessions left out and why. */
  excluded?: { bulkDecisions: number; withoutDuration: number };
}

const ratio = (numerator: number, denominator: number): MetricValue => ({ value: denominator === 0 ? null : numerator / denominator, numerator, denominator });
const count = (n: number): MetricValue => ({ value: n });

/** Validates a spec against the contract and the registry. Throws 422 with field errors. */
export function validateSpec(input: unknown): AnalysisSpec {
  const parsed = analysisSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError("invalid", "This analysis is not supported.", { fieldErrors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  if (parsed.data.needsClarification) throw new ApiError("invalid", "This question needs clarification before it can run.", { fieldErrors: [{ path: "clarificationQuestion", message: parsed.data.clarificationQuestion ?? "" }] });
  return parsed.data;
}

async function loadScope(tx: Tx, spec: AnalysisSpec, workspaceId: string): Promise<{ scope: DataScope; branchNames: Map<string, string> }> {
  const [ws] = await tx.select({ timezone: workspaces.timezone, version: workspaces.activeTaxonomyVersionId }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const [version] = ws.version ? await tx.select({ sequence: taxonomyVersions.sequence }).from(taxonomyVersions).where(eq(taxonomyVersions.id, ws.version)) : [];
  const rows = await tx
    .select({
      merchantId: merchants.id,
      merchantName: merchants.name,
      catalogRevisionId: merchants.activeCatalogRevisionId,
      revisionSequence: catalogRevisions.sequence,
      pointerRevision: currentReleases.catalogRevisionId,
      releaseId: currentReleases.releaseId,
      releaseNumber: mappingReleases.releaseNumber,
    })
    .from(merchants)
    .leftJoin(catalogRevisions, eq(catalogRevisions.id, merchants.activeCatalogRevisionId))
    .leftJoin(currentReleases, eq(currentReleases.merchantId, merchants.id))
    .leftJoin(mappingReleases, eq(mappingReleases.id, currentReleases.releaseId))
    .orderBy(merchants.name);
  // Top-level domains of the active version: the values a canonical branch filter may name.
  const branches = ws.version
    ? await tx
        .select({ key: concepts.stableKey, name: conceptRevisions.name })
        .from(conceptRevisions)
        .innerJoin(concepts, eq(concepts.id, conceptRevisions.conceptId))
        .where(and(eq(conceptRevisions.taxonomyVersionId, ws.version), eq(conceptRevisions.depth, 2)))
    : [];
  return {
    branchNames: new Map(branches.map((b) => [b.key, b.name])),
    scope: {
      population: "current_catalogs",
      mappingState: spec.scope.mappingState,
      taxonomyVersionId: ws.version,
      taxonomySequence: version?.sequence ?? null,
      timezone: ws.timezone,
      timeRange: spec.timeRange,
      merchants: rows.map((r) => {
        const compatible = !!r.releaseId && r.pointerRevision === r.catalogRevisionId;
        return { merchantId: r.merchantId, merchantName: r.merchantName, catalogRevisionId: r.catalogRevisionId, revisionSequence: r.revisionSequence, releaseId: compatible ? r.releaseId : null, releaseNumber: compatible ? r.releaseNumber : null, releaseSuperseded: !!r.releaseId && !compatible };
      }),
      observedAt: new Date().toISOString(),
    },
  };
}

/**
 * One row per active listing of each merchant's current catalog revision, with its draft and
 * published classification. A published mapping counts only when the merchant's current release
 * was made from that same catalog revision.
 */
const SNAPSHOT_FACTS = sql`
  select lr.id as listing_revision_id, m.id as merchant_id, m.name as merchant_name,
         rs.state::text as state, rs.ambiguous, rs.analysis_failed,
         coalesce(rec.signal_band::text, ${NO_RECOMMENDATION}) as band,
         (rs.state = 'approved' and rs.taxonomy_version_id = w.active_taxonomy_version_id) as draft_approved,
         case when rs.state = 'approved' and rs.taxonomy_version_id = w.active_taxonomy_version_id then nullif(split_part(dcr.path, ' > ', 2), '') end as draft_branch,
         (pm.listing_revision_id is not null) as published,
         nullif(split_part(pcr.path, ' > ', 2), '') as published_branch
  from merchants m
  join workspaces w on w.id = m.workspace_id
  join listing_revisions lr on lr.catalog_revision_id = m.active_catalog_revision_id and lr.active
  join review_states rs on rs.listing_revision_id = lr.id
  left join recommendations rec on rec.id = rs.latest_recommendation_id
  left join review_decisions d on d.id = rs.latest_decision_id
  left join concept_revisions dcr on dcr.taxonomy_version_id = d.taxonomy_version_id and dcr.concept_id = d.selected_concept_id
  left join current_releases cur on cur.merchant_id = m.id and cur.catalog_revision_id = m.active_catalog_revision_id
  left join published_mappings pm on pm.release_id = cur.release_id and pm.listing_revision_id = lr.id
  left join concept_revisions pcr on pcr.taxonomy_version_id = pm.taxonomy_version_id and pcr.concept_id = pm.concept_id`;

/** One row per human review decision. Carry-forward and revalidation records are not reviews. */
const ACTIVITY_FACTS = sql`
  select d.listing_revision_id, d.created_at, d.origin::text as origin, d.duration_seconds, m.id as merchant_id, m.name as merchant_name
  from review_decisions d
  join listing_revisions lr on lr.id = d.listing_revision_id
  join catalog_revisions cr on cr.id = lr.catalog_revision_id
  join merchants m on m.id = cr.merchant_id
  where d.origin in ('manual', 'suggestion', 'bulk')`;

interface Compiled {
  groupExprs: { dim: DimensionId; value: SQL; label: SQL }[];
  where: SQL[];
}

function compile(spec: AnalysisSpec, family: "snapshot" | "activity", branchNames: Map<string, string>): Compiled {
  const branch = spec.scope.mappingState === "published" ? sql`f.published_branch` : sql`f.draft_branch`;
  // Fixed fragments keyed by registry dimension. No spec text is ever placed into SQL.
  const exprs: Record<DimensionId, { value: SQL; label: SQL }> = {
    merchant: { value: sql`f.merchant_id::text`, label: sql`f.merchant_name` },
    canonical_branch: { value: sql`coalesce(${branch}, ${UNMAPPED})`, label: sql`coalesce(${branch}, ${UNMAPPED})` },
    decision_status: { value: sql`f.state`, label: sql`f.state` },
    signal_band: { value: sql`f.band`, label: sql`f.band` },
    utc_day: { value: sql`to_char(date_trunc('day', f.created_at at time zone 'UTC'), 'YYYY-MM-DD')`, label: sql`to_char(date_trunc('day', f.created_at at time zone 'UTC'), 'YYYY-MM-DD')` },
    utc_week: { value: sql`to_char(date_trunc('week', f.created_at at time zone 'UTC'), 'YYYY-MM-DD')`, label: sql`to_char(date_trunc('week', f.created_at at time zone 'UTC'), 'YYYY-MM-DD')` },
  };
  const where: SQL[] = [];
  for (const filter of spec.filters) {
    if (filter.dimension === "merchant") {
      for (const v of filter.values) if (!/^[0-9a-f-]{36}$/i.test(v)) throw new ApiError("invalid", "A merchant filter must name merchants of this workspace.", { fieldErrors: [{ path: "filters", message: "Unknown merchant." }] });
      where.push(sql`f.merchant_id in (${sql.join(filter.values.map((v) => sql`${v}::uuid`), sql`, `)})`);
    } else if (family === "activity") {
      throw new ApiError("invalid", "Review activity can only be filtered by merchant.", { fieldErrors: [{ path: "filters", message: `${filter.dimension} is not available for this metric.` }] });
    } else if (filter.dimension === "decision_status") {
      for (const v of filter.values) if (!(REVIEW_STATES as readonly string[]).includes(v)) throw new ApiError("invalid", `"${v}" is not a decision status.`);
      where.push(sql`f.state in (${sql.join(filter.values.map((v) => sql`${v}`), sql`, `)})`);
    } else if (filter.dimension === "signal_band") {
      for (const v of filter.values) if (![...SIGNAL_BANDS, NO_RECOMMENDATION].includes(v as SignalBand)) throw new ApiError("invalid", `"${v}" is not a signal band.`);
      where.push(sql`f.band in (${sql.join(filter.values.map((v) => sql`${v}`), sql`, `)})`);
    } else {
      // Branch values are stable keys of top-level concepts, resolved against the active version.
      const names = filter.values.map((v) => (v === UNMAPPED ? null : branchNames.get(v)));
      if (names.some((n, i) => n === undefined && filter.values[i] !== UNMAPPED)) throw new ApiError("invalid", "A canonical branch filter must name a top-level concept of the active taxonomy version.", { fieldErrors: [{ path: "filters", message: "Unknown canonical branch." }] });
      const named = names.filter((n): n is string => !!n);
      const parts: SQL[] = [];
      if (named.length) parts.push(sql`${branch} in (${sql.join(named.map((n) => sql`${n}`), sql`, `)})`);
      if (filter.values.includes(UNMAPPED)) parts.push(sql`${branch} is null`);
      where.push(sql`(${sql.join(parts, sql` or `)})`);
    }
  }
  if (family === "activity" && spec.timeRange) where.push(sql`f.created_at >= ${spec.timeRange.start}::timestamptz and f.created_at < ${spec.timeRange.end}::timestamptz`);
  return { groupExprs: spec.groupBy.map((dim) => ({ dim, ...exprs[dim] })), where };
}

const DIM_LABEL: Partial<Record<DimensionId, (v: string) => string>> = {
  decision_status: (v) => STATE_LABELS[v as ReviewState] ?? v,
  signal_band: (v) => (v === NO_RECOMMENDATION ? "No analysis yet" : (BAND_LABELS[v as SignalBand] ?? v)),
};

type Raw = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

function valuesFrom(raw: Raw, metricIds: readonly MetricId[]): Partial<Record<MetricId, MetricValue>> {
  const out: Partial<Record<MetricId, MetricValue>> = {};
  for (const id of metricIds) {
    switch (id) {
      case "listing_count": out[id] = count(n(raw.total)); break;
      case "published_mapping_coverage": out[id] = ratio(n(raw.published), n(raw.total)); break;
      case "approved_draft_coverage": out[id] = ratio(n(raw.draft), n(raw.total)); break;
      case "pending_review_count": out[id] = count(n(raw.pending)); break;
      case "ambiguous_count": out[id] = count(n(raw.ambiguous)); break;
      case "failed_analysis_count": out[id] = count(n(raw.failed)); break;
      case "reviewed_listing_count": out[id] = count(n(raw.reviewed)); break;
      case "median_review_seconds": out[id] = { value: raw.median === null || raw.median === undefined ? null : Number(raw.median), denominator: n(raw.sessions) }; break;
    }
  }
  return out;
}

/** Executes a validated spec inside an existing workspace-scoped transaction. */
export async function runSpecInTx(tx: Tx, workspaceId: string, input: AnalysisSpec): Promise<MetricResult> {
  const spec = validateSpec(input);
  const families = new Set(spec.metricIds.map((id) => METRICS[id].family));
  if (families.size > 1) throw new ApiError("invalid", "Snapshot counts and review activity cannot be combined in one result. Ask for them separately.");
  const family = METRICS[spec.metricIds[0]].family;
  for (const id of spec.metricIds) {
    for (const f of spec.filters) if (!METRICS[id].filters.includes(f.dimension)) throw new ApiError("invalid", `${METRICS[id].label} cannot be filtered by ${f.dimension.replaceAll("_", " ")}.`);
  }
  const { scope, branchNames } = await loadScope(tx, spec, workspaceId);
  const { groupExprs, where } = compile(spec, family, branchNames);

  const facts = family === "snapshot" ? SNAPSHOT_FACTS : ACTIVITY_FACTS;
  const aggregates =
    family === "snapshot"
      ? sql`count(*)::int as total, count(*) filter (where f.published)::int as published, count(*) filter (where f.draft_approved)::int as draft,
            count(*) filter (where f.state <> 'approved')::int as pending, count(*) filter (where f.ambiguous)::int as ambiguous, count(*) filter (where f.analysis_failed)::int as failed`
      : sql`count(distinct f.listing_revision_id)::int as reviewed,
            percentile_cont(0.5) within group (order by f.duration_seconds) filter (where f.origin <> 'bulk' and f.duration_seconds is not null) as median,
            count(*) filter (where f.origin <> 'bulk' and f.duration_seconds is not null)::int as sessions,
            count(*) filter (where f.origin = 'bulk')::int as bulk, count(*) filter (where f.origin <> 'bulk' and f.duration_seconds is null)::int as no_duration`;
  const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``;
  const selectDims = groupExprs.map((g, i) => sql`${g.value} as ${sql.raw(`d${i}`)}, max(${g.label}) as ${sql.raw(`l${i}`)}`);
  // Grouped by output position: a repeated expression with bound parameters would not be recognised as the same expression.
  const groupSql = groupExprs.length ? sql.raw(`group by ${groupExprs.map((_, i) => 2 * i + 1).join(", ")}`) : sql``;

  const totalRow = (await tx.execute<Raw>(sql`with f as (${facts}) select ${aggregates} from f ${whereSql}`)).rows[0] ?? {};
  let rows: ResultRow[] = [];
  if (groupExprs.length > 0) {
    const grouped = await tx.execute<Raw>(sql`with f as (${facts}) select ${sql.join(selectDims, sql`, `)}, ${aggregates} from f ${whereSql} ${groupSql}`);
    rows = grouped.rows.map((raw) => ({
      dims: Object.fromEntries(groupExprs.map((g, i) => [g.dim, { value: String(raw[`d${i}`]), label: DIM_LABEL[g.dim]?.(String(raw[`l${i}`])) ?? String(raw[`l${i}`]) }])),
      values: valuesFrom(raw, spec.metricIds),
    }));
  } else {
    rows = [{ dims: {}, values: valuesFrom(totalRow, spec.metricIds) }];
  }

  // Sort in application code on the same values that are displayed; "Not applicable" always sorts last.
  const sort = spec.sort ?? (spec.groupBy[0]?.startsWith("utc_") ? { field: spec.groupBy[0], direction: "asc" as const } : { field: spec.groupBy[0] ?? spec.metricIds[0], direction: "asc" as const });
  const key = (row: ResultRow): string | number | null => ((spec.metricIds as string[]).includes(sort.field) ? (row.values[sort.field as MetricId]?.value ?? null) : (row.dims[sort.field as DimensionId]?.label.toLowerCase() ?? null));
  rows.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    // Ties are broken by the displayed labels, so the order is stable and readable.
    const name = (row: ResultRow) => spec.groupBy.map((d) => row.dims[d]?.label ?? "").join("\u0001");
    return (sort.direction === "desc" ? -cmp : cmp) || name(a).localeCompare(name(b));
  });
  const rowCount = rows.length;
  const limit = Math.min(spec.limit, MAX_ROWS);
  const truncated = rowCount > limit;
  rows = rows.slice(0, limit);

  const warnings: string[] = [];
  const merchantFilter = spec.filters.find((f) => f.dimension === "merchant")?.values;
  const inScope = scope.merchants.filter((m) => !merchantFilter || merchantFilter.includes(m.merchantId));
  if (family === "snapshot" && spec.scope.mappingState === "published" && spec.metricIds.some((id) => id === "published_mapping_coverage" || spec.groupBy.includes("canonical_branch") || spec.filters.some((f) => f.dimension === "canonical_branch"))) {
    const none = inScope.filter((m) => m.catalogRevisionId && !m.releaseId);
    if (none.length) warnings.push(`${none.map((m) => m.merchantName).join(", ")} ${none.length === 1 ? "has" : "have"} no release for the current catalog revision${none.some((m) => m.releaseSuperseded) ? " (an earlier release exists for a superseded revision)" : ""}, so ${none.length === 1 ? "its" : "their"} published mappings count as zero.`);
  }
  const branchFilter = spec.filters.find((f) => f.dimension === "canonical_branch");
  if (branchFilter && spec.metricIds.some((id) => METRICS[id].kind === "ratio")) {
    warnings.push(`Unmapped listings have no canonical category, so they cannot be assigned to a branch. With a branch filter the denominator is only the listings already classified there in the ${spec.scope.mappingState} mappings, which is not the branch's overall coverage. True branch coverage would need a verified source-domain classification.`);
  }
  if (spec.groupBy.includes("canonical_branch")) warnings.push(`Listings without a ${spec.scope.mappingState} mapping have no canonical category and are shown as "${UNMAPPED}".`);
  if (family === "activity") {
    warnings.push(spec.timeRange ? `Counts human review decisions recorded from ${spec.timeRange.start} up to, but not including, ${spec.timeRange.end} (UTC).` : "Counts every human review decision recorded so far; no time range was applied.");
    if (spec.groupBy.some((g) => g.startsWith("utc_")) && spec.metricIds.includes("reviewed_listing_count")) warnings.push("A listing reviewed in more than one period is counted once in each; the total counts it once.");
  }
  if (truncated) warnings.push(`Showing the first ${limit} of ${rowCount} rows.`);
  const result: MetricResult = { spec, columns: { dimensions: spec.groupBy, metrics: spec.metricIds }, rows, totals: valuesFrom(totalRow, spec.metricIds), rowCount, truncated, scope, warnings };
  if (spec.metricIds.includes("median_review_seconds")) {
    result.excluded = { bulkDecisions: n(totalRow.bulk), withoutDuration: n(totalRow.no_duration) };
    warnings.push(`Median of ${n(totalRow.sessions)} individual review sessions. Excluded: ${n(totalRow.bulk)} bulk approvals and ${n(totalRow.no_duration)} decisions without a recorded duration.`);
  }
  return result;
}

/** Executes a spec for a signed-in member. The workspace is taken from the actor, never the spec. */
export async function runSpec(actor: Actor, input: unknown): Promise<MetricResult> {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  const spec = validateSpec(input);
  return withContext(actor, (tx) => runSpecInTx(tx, actor.workspaceId, spec));
}

/** Names of the merchants and top-level branches a spec may reference, for planners and the builder. */
export async function analyticsVocabulary(actor: Actor) {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  return withContext(actor, async (tx) => {
    const [ws] = await tx.select({ timezone: workspaces.timezone, version: workspaces.activeTaxonomyVersionId }).from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    const merchantRows = await tx.select({ id: merchants.id, name: merchants.name }).from(merchants).orderBy(merchants.name);
    const branches = ws.version
      ? await tx
          .select({ key: concepts.stableKey, name: conceptRevisions.name })
          .from(conceptRevisions)
          .innerJoin(concepts, eq(concepts.id, conceptRevisions.conceptId))
          .where(and(eq(conceptRevisions.taxonomyVersionId, ws.version), eq(conceptRevisions.depth, 2), inArray(conceptRevisions.status, ["active"])))
          .orderBy(conceptRevisions.name)
      : [];
    return { timezone: ws.timezone, merchants: merchantRows, branches };
  });
}

/** A spec with every optional part defaulted, for fixed dashboard controls and the builder. */
export function baseSpec(metricId: MetricId, overrides: Partial<AnalysisSpec> = {}): AnalysisSpec {
  const mappingState = METRICS[metricId].mappingState ?? "published";
  return { metricIds: [metricId], groupBy: [], filters: [], timeRange: null, scope: { population: "current_catalogs", mappingState }, sort: null, limit: 20, chartType: "table", needsClarification: false, clarificationQuestion: null, ...overrides };
}
