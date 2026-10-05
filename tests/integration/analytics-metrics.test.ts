import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db/client";
import { seedScenario, type ScenarioResult } from "@/db/seed-scenario";
import { drilldownHref, formatValue, summarize } from "@/lib/analytics/format";
import { baseSpec, runSpec, UNMAPPED } from "@/lib/analytics/metric-service";
import type { Actor } from "@/lib/auth/actor";
import type { AnalysisSpec } from "@/lib/contracts/analysis-spec";
import { getDashboard } from "@/lib/domain/analytics";
import { listReviewItems, parseReviewFilters } from "@/lib/domain/review";
import { actorFor, adminClient, createTestWorkspace, type TestWorkspace } from "../setup/helpers";

let admin: pg.Client;
let ws: TestWorkspace;
let empty: TestWorkspace;
let viewer: Actor;
let scenario: ScenarioResult;

beforeAll(async () => {
  admin = await adminClient();
  ws = await createTestWorkspace(admin, "metrics");
  empty = await createTestWorkspace(admin, "metrics-empty");
  scenario = (await seedScenario(await actorFor(ws, "administrator"), await actorFor(ws, "taxonomist")))!;
  viewer = await actorFor(ws, "viewer");
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

/** Reference queries run as the database owner, written without reference to the service's SQL. */
const ref = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = [ws.id]) => (await admin.query(sql, params)).rows as T[];
const CURRENT = `from listing_revisions lr join merchants m on m.active_catalog_revision_id = lr.catalog_revision_id where lr.workspace_id = $1 and lr.active`;
const IN_CURRENT_RELEASE = `exists (select 1 from current_releases c join published_mappings pm on pm.release_id = c.release_id where c.merchant_id = m.id and c.catalog_revision_id = m.active_catalog_revision_id and pm.listing_revision_id = lr.id)`;
const STATE = `(select state from review_states rs where rs.listing_revision_id = lr.id)`;

const byMerchant = (spec: AnalysisSpec) => runSpec(viewer, { ...spec, groupBy: ["merchant"] });

describe("snapshot metrics reconcile with reference queries", () => {
  it("active listing count", async () => {
    const [{ n }] = await ref<{ n: number }>(`select count(distinct lr.listing_id)::int as n ${CURRENT}`);
    const result = await runSpec(viewer, baseSpec("listing_count"));
    expect(result.totals.listing_count).toEqual({ value: n });
    expect(n).toBe(300);
  });

  it("published coverage is the ratio of summed counts, never the average of merchant rates (AT19)", async () => {
    const rows = await ref<{ name: string; num: number; den: number }>(`select m.name, count(*) filter (where ${IN_CURRENT_RELEASE})::int as num, count(*)::int as den ${CURRENT} group by m.name order by m.name`);
    const result = await byMerchant(baseSpec("published_mapping_coverage"));
    expect(result.rows.map((r) => ({ name: r.dims.merchant!.label, num: r.values.published_mapping_coverage!.numerator, den: r.values.published_mapping_coverage!.denominator }))).toEqual(rows);
    expect(rows).toEqual([
      { name: "Corner Goods", num: 0, den: 99 },
      { name: "Daily Basket", num: 58, den: 100 },
      { name: "Harbor Market", num: 82, den: 101 },
    ]);
    const total = result.totals.published_mapping_coverage!;
    expect(total).toEqual({ value: 140 / 300, numerator: 140, denominator: 300 });
    const averageOfRates = rows.reduce((sum, r) => sum + r.num / r.den, 0) / rows.length;
    expect(Math.abs(total.value! - averageOfRates)).toBeGreaterThan(0.001);
    // A merchant that never published counts as zero and is called out.
    expect(result.warnings.join(" ")).toMatch(/Corner Goods has no release for the current catalog revision/);
    expect(result.scope.merchants.map((m) => [m.merchantName, m.revisionSequence, m.releaseNumber])).toEqual([["Corner Goods", 1, null], ["Daily Basket", 1, 4], ["Harbor Market", 2, 3]]);
  });

  it("approved draft coverage counts approvals whether or not they are published", async () => {
    const rows = await ref<{ name: string; num: number; den: number }>(`select m.name, count(*) filter (where ${STATE} = 'approved')::int as num, count(*)::int as den ${CURRENT} group by m.name order by m.name`);
    const result = await byMerchant(baseSpec("approved_draft_coverage"));
    expect(result.rows.map((r) => ({ name: r.dims.merchant!.label, num: r.values.approved_draft_coverage!.numerator, den: r.values.approved_draft_coverage!.denominator }))).toEqual(rows);
    expect(result.totals.approved_draft_coverage).toEqual({ value: 172 / 300, numerator: 172, denominator: 300 });
  });

  it("pending, ambiguous and failed counts are distinct measures", async () => {
    const [r] = await ref<{ pending: number; ambiguous: number; failed: number }>(
      `select count(*) filter (where ${STATE} <> 'approved')::int as pending,
              count(*) filter (where (select ambiguous from review_states rs where rs.listing_revision_id = lr.id))::int as ambiguous,
              count(*) filter (where (select analysis_failed from review_states rs where rs.listing_revision_id = lr.id))::int as failed ${CURRENT}`,
    );
    const result = await runSpec(viewer, { ...baseSpec("pending_review_count"), metricIds: ["pending_review_count", "ambiguous_count", "failed_analysis_count"] });
    expect(result.totals).toEqual({ pending_review_count: { value: r.pending }, ambiguous_count: { value: r.ambiguous }, failed_analysis_count: { value: r.failed } });
    expect(r.pending).toBe(128);
    expect(r.ambiguous).toBeGreaterThan(0);
  });

  it("listing count by decision status and by signal band, with unanalyzed listings in their own bucket", async () => {
    const states = await ref<{ k: string; n: number }>(`select ${STATE}::text as k, count(*)::int as n ${CURRENT} group by 1`);
    const byState = await runSpec(viewer, baseSpec("listing_count", { groupBy: ["decision_status"] }));
    expect(Object.fromEntries(byState.rows.map((r) => [r.dims.decision_status!.value, r.values.listing_count!.value]))).toEqual(Object.fromEntries(states.map((s) => [s.k, s.n])));
    expect(byState.rows.reduce((sum, r) => sum + r.values.listing_count!.value!, 0)).toBe(300);

    const bands = await ref<{ k: string; n: number }>(`select coalesce((select rec.signal_band::text from review_states rs join recommendations rec on rec.id = rs.latest_recommendation_id where rs.listing_revision_id = lr.id), 'no_recommendation') as k, count(*)::int as n ${CURRENT} group by 1`);
    const byBand = await runSpec(viewer, baseSpec("listing_count", { groupBy: ["signal_band"] }));
    expect(Object.fromEntries(byBand.rows.map((r) => [r.dims.signal_band!.value, r.values.listing_count!.value]))).toEqual(Object.fromEntries(bands.map((s) => [s.k, s.n])));
    expect(byBand.rows.some((r) => r.dims.signal_band!.value === "high")).toBe(false);
  });

  it("canonical branch breakdown keeps unmapped listings in an Unmapped bucket and differs by mapping scope", async () => {
    const published = await ref<{ k: string; n: number }>(
      `select coalesce((select split_part(c.path, ' > ', 2) from current_releases cur join published_mappings pm on pm.release_id = cur.release_id join concept_revisions c on c.concept_id = pm.concept_id and c.taxonomy_version_id = pm.taxonomy_version_id
                        where cur.merchant_id = m.id and cur.catalog_revision_id = m.active_catalog_revision_id and pm.listing_revision_id = lr.id), 'Unmapped') as k, count(*)::int as n ${CURRENT} group by 1`,
    );
    const result = await runSpec(viewer, baseSpec("listing_count", { groupBy: ["canonical_branch"] }));
    const got = Object.fromEntries(result.rows.map((r) => [r.dims.canonical_branch!.label, r.values.listing_count!.value]));
    expect(got).toEqual(Object.fromEntries(published.map((s) => [s.k, s.n])));
    expect(got[UNMAPPED]).toBe(160);
    expect(result.warnings.join(" ")).toMatch(/shown as "Unmapped"/);

    const draft = await runSpec(viewer, baseSpec("listing_count", { groupBy: ["canonical_branch"], scope: { population: "current_catalogs", mappingState: "draft" } }));
    expect(Object.fromEntries(draft.rows.map((r) => [r.dims.canonical_branch!.label, r.values.listing_count!.value]))[UNMAPPED]).toBe(128);
  });

  it("a branch filter changes the coverage denominator and says so (AT22)", async () => {
    const [{ n }] = await ref<{ n: number }>(
      `select count(*)::int as n ${CURRENT} and exists (select 1 from current_releases cur join published_mappings pm on pm.release_id = cur.release_id join concept_revisions c on c.concept_id = pm.concept_id and c.taxonomy_version_id = pm.taxonomy_version_id
         where cur.merchant_id = m.id and cur.catalog_revision_id = m.active_catalog_revision_id and pm.listing_revision_id = lr.id and c.path like 'All Products > Grocery%')`,
    );
    const result = await runSpec(viewer, baseSpec("published_mapping_coverage", { filters: [{ dimension: "canonical_branch", operator: "eq", values: ["GRO"] }] }));
    expect(n).toBeGreaterThan(0);
    expect(result.totals.published_mapping_coverage).toEqual({ value: 1, numerator: n, denominator: n });
    expect(result.warnings.join(" ")).toMatch(/not the branch's overall coverage/);
  });

  it("filters by merchant and rejects values that are not registered", async () => {
    const harbor = scenario.merchants["harbor-market"];
    const result = await runSpec(viewer, baseSpec("pending_review_count", { filters: [{ dimension: "merchant", operator: "eq", values: [harbor] }] }));
    expect(result.totals.pending_review_count).toEqual({ value: 19 });
    await expect(runSpec(viewer, baseSpec("listing_count", { filters: [{ dimension: "merchant", operator: "eq", values: ["x'; drop table merchants; --"] }] }))).rejects.toMatchObject({ status: 422 });
    await expect(runSpec(viewer, baseSpec("listing_count", { filters: [{ dimension: "canonical_branch", operator: "eq", values: ["NOPE"] }] }))).rejects.toMatchObject({ status: 422 });
    await expect(runSpec(viewer, baseSpec("listing_count", { filters: [{ dimension: "decision_status", operator: "eq", values: ["approved' or '1'='1"] }] }))).rejects.toMatchObject({ status: 422 });
    await expect(runSpec(viewer, { ...baseSpec("listing_count"), metricIds: ["revenue"] })).rejects.toMatchObject({ status: 422 });
    await expect(runSpec(viewer, { ...baseSpec("listing_count"), workspaceId: empty.id })).rejects.toMatchObject({ status: 422 });
    await expect(runSpec(viewer, { ...baseSpec("published_mapping_coverage"), groupBy: ["canonical_branch"] })).rejects.toMatchObject({ status: 422 });
    await expect(runSpec(viewer, { ...baseSpec("listing_count"), metricIds: ["listing_count", "reviewed_listing_count"] })).rejects.toMatchObject({ status: 422 });
  });

  it("sorts by the displayed values and truncates with a warning", async () => {
    const asc = await runSpec(viewer, baseSpec("published_mapping_coverage", { groupBy: ["merchant"], sort: { field: "published_mapping_coverage", direction: "asc" } }));
    expect(asc.rows.map((r) => r.dims.merchant!.label)).toEqual(["Corner Goods", "Daily Basket", "Harbor Market"]);
    const top = await runSpec(viewer, baseSpec("published_mapping_coverage", { groupBy: ["merchant"], sort: { field: "published_mapping_coverage", direction: "desc" }, limit: 1 }));
    expect(top.rows.map((r) => r.dims.merchant!.label)).toEqual(["Harbor Market"]);
    expect(top).toMatchObject({ rowCount: 3, truncated: true });
    expect(top.totals.published_mapping_coverage!.denominator).toBe(300);
  });
});

describe("review activity metrics", () => {
  it("counts distinct listing revisions with a human decision and excludes carry-forward", async () => {
    const [{ n, carried }] = await ref<{ n: number; carried: number }>(
      `select count(distinct listing_revision_id) filter (where origin in ('manual','suggestion','bulk'))::int as n, count(*) filter (where origin = 'carried_forward')::int as carried from review_decisions where workspace_id = $1`,
    );
    const result = await runSpec(viewer, baseSpec("reviewed_listing_count"));
    expect(result.totals.reviewed_listing_count).toEqual({ value: n });
    expect(carried).toBe(66);
    const byDay = await runSpec(viewer, baseSpec("reviewed_listing_count", { groupBy: ["utc_day"] }));
    const days = await ref<{ k: string; n: number }>(`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as k, count(distinct listing_revision_id)::int as n from review_decisions where workspace_id = $1 and origin <> 'carried_forward' and origin <> 'revalidated' group by 1 order by 1`);
    expect(byDay.rows.map((r) => ({ k: r.dims.utc_day!.value, n: r.values.reviewed_listing_count!.value }))).toEqual(days);
  });

  it("median review time excludes bulk approvals and decisions without a duration, and discloses them", async () => {
    const rows = await ref<{ origin: string; duration_seconds: number | null }>(`select origin::text, duration_seconds from review_decisions where workspace_id = $1 and origin in ('manual','suggestion','bulk')`);
    const durations = rows.filter((r) => r.origin !== "bulk" && r.duration_seconds !== null).map((r) => r.duration_seconds!).sort((a, b) => a - b);
    const median = durations.length === 0 ? null : durations.length % 2 ? durations[(durations.length - 1) / 2] : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2;
    const result = await runSpec(viewer, baseSpec("median_review_seconds"));
    expect(result.totals.median_review_seconds).toEqual({ value: median, denominator: durations.length });
    expect(result.excluded).toEqual({ bulkDecisions: rows.filter((r) => r.origin === "bulk").length, withoutDuration: rows.filter((r) => r.origin !== "bulk" && r.duration_seconds === null).length });
    expect(result.warnings.join(" ")).toMatch(/Excluded: \d+ bulk approvals and \d+ decisions without a recorded duration/);
  });

  it("a time range is half-open", async () => {
    const [first] = await ref<{ at: Date }>(`select min(created_at) as at from review_decisions where workspace_id = $1 and origin <> 'carried_forward'`);
    const at = first.at.toISOString();
    const before = await runSpec(viewer, baseSpec("reviewed_listing_count", { timeRange: { start: "2000-01-01T00:00:00.000Z", end: at } }));
    expect(before.totals.reviewed_listing_count).toEqual({ value: 0 });
    const from = await runSpec(viewer, baseSpec("reviewed_listing_count", { timeRange: { start: at, end: "2100-01-01T00:00:00.000Z" } }));
    expect(from.totals.reviewed_listing_count!.value).toBe((await runSpec(viewer, baseSpec("reviewed_listing_count"))).totals.reviewed_listing_count!.value);
    await expect(runSpec(viewer, baseSpec("listing_count", { timeRange: { start: at, end: "2100-01-01T00:00:00.000Z" } }))).rejects.toMatchObject({ status: 422 });
  });
});

describe("empty populations (AT23)", () => {
  it("a workspace with no listings reports Not applicable, not zero percent", async () => {
    const actor = await actorFor(empty, "analyst");
    const coverage = await runSpec(actor, baseSpec("published_mapping_coverage"));
    expect(coverage.totals.published_mapping_coverage).toEqual({ value: null, numerator: 0, denominator: 0 });
    expect(formatValue("published_mapping_coverage", coverage.totals.published_mapping_coverage)).toBe("Not applicable");
    expect(summarize(coverage)).toMatch(/Not applicable/);
    const grouped = await runSpec(actor, baseSpec("published_mapping_coverage", { groupBy: ["merchant"] }));
    expect(grouped.rows).toEqual([]);
    expect(summarize(grouped)).toBe("No matching records.");
    expect((await runSpec(actor, baseSpec("listing_count"))).totals.listing_count).toEqual({ value: 0 });
    expect((await runSpec(actor, baseSpec("median_review_seconds"))).totals.median_review_seconds).toEqual({ value: null, denominator: 0 });
    const dashboard = await getDashboard(actor);
    expect(dashboard.cards.map((c) => c.value)).toEqual(["0", "Not applicable", "Not applicable", "0", "0", "0"]);
    expect(dashboard).toMatchObject({ merchants: [], states: [], latestRelease: null });
  });

  it("never returns another workspace's rows", async () => {
    const other = await runSpec(await actorFor(empty, "viewer"), baseSpec("listing_count", { filters: [{ dimension: "merchant", operator: "eq", values: [scenario.merchants["harbor-market"]] }] }));
    expect(other.totals.listing_count).toEqual({ value: 0 });
    expect(other.scope.merchants).toEqual([]);
  });
});

describe("dashboard and drilldowns use the same numbers", () => {
  it("dashboard cards equal the metric service and the pinned scenario", async () => {
    const dashboard = await getDashboard(viewer);
    expect(Object.fromEntries(dashboard.cards.map((c) => [c.metricId, [c.value, c.fraction]]))).toMatchObject({
      listing_count: ["300", null],
      published_mapping_coverage: ["46.7%", "140 of 300"],
      approved_draft_coverage: ["57.3%", "172 of 300"],
      pending_review_count: ["128", null],
    });
    expect(dashboard.merchants.map((m) => [m.name, m.published.numerator, m.draft.numerator, m.pending.value, m.releaseNumber])).toEqual([["Corner Goods", 0, 32, 67, null], ["Daily Basket", 58, 58, 42, 4], ["Harbor Market", 82, 82, 19, 3]]);
    expect(dashboard.states.reduce((sum, s) => sum + s.count, 0)).toBe(300);
    expect(dashboard.latestRelease).toMatchObject({ releaseNumber: 4, merchantName: "Daily Basket", mapped: 58 });
    expect(dashboard.activity.days.reduce((sum, d) => sum + d.count, 0)).toBeGreaterThanOrEqual(dashboard.activity.total);
  });

  it("every drilldown link opens a review queue with exactly the metric's count", async () => {
    const queueCount = async (href: string) => {
      const query = new URLSearchParams(href.split("?")[1]);
      return (await listReviewItems(viewer, { ...parseReviewFilters((k) => query.get(k)), limit: 1 })).matching;
    };
    const check = async (spec: AnalysisSpec, expected: (v: { value: number | null; numerator?: number; denominator?: number }) => number) => {
      const result = await runSpec(viewer, spec);
      const metricId = spec.metricIds[0];
      const rows = spec.groupBy.length ? result.rows : [undefined];
      let checked = 0;
      for (const row of rows) {
        const link = drilldownHref(result.spec, metricId, row);
        if (!link) continue;
        expect(await queueCount(link.href), `${metricId} ${JSON.stringify(row?.dims ?? {})} → ${link.href}`).toBe(expected(row ? row.values[metricId]! : result.totals[metricId]!));
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    };
    const unmapped = (v: { numerator?: number; denominator?: number }) => v.denominator! - v.numerator!;
    await check(baseSpec("listing_count"), (v) => v.value!);
    await check(baseSpec("listing_count", { groupBy: ["decision_status"] }), (v) => v.value!);
    await check(baseSpec("listing_count", { groupBy: ["signal_band"] }), (v) => v.value!);
    await check(baseSpec("published_mapping_coverage"), unmapped);
    await check(baseSpec("published_mapping_coverage", { groupBy: ["merchant"] }), unmapped);
    await check(baseSpec("approved_draft_coverage", { groupBy: ["merchant"] }), unmapped);
    await check(baseSpec("pending_review_count", { groupBy: ["merchant"] }), (v) => v.value!);
    await check(baseSpec("ambiguous_count", { groupBy: ["merchant"] }), (v) => v.value!);
    await check(baseSpec("failed_analysis_count"), (v) => v.value!);
    // A branch has no exact queue filter, so no link is offered rather than an approximate one.
    const branches = await runSpec(viewer, baseSpec("listing_count", { groupBy: ["canonical_branch"] }));
    expect(drilldownHref(branches.spec, "listing_count", branches.rows[0])).toBeNull();
  });
});
