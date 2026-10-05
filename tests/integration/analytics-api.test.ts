import type Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as contextRoute } from "@/app/api/analytics/context/route";
import { GET as conversationRoute } from "@/app/api/analytics/conversations/[id]/route";
import { GET as conversationsRoute } from "@/app/api/analytics/conversations/route";
import { POST as executeRoute } from "@/app/api/analytics/execute/route";
import { POST as interpretRoute } from "@/app/api/analytics/interpret/route";
import { GET as exportRoute } from "@/app/api/analytics/runs/[id]/export/route";
import { GET as dashboardRoute } from "@/app/api/dashboard/route";
import { POST as refreshRoute } from "@/app/api/reports/[id]/refresh/route";
import { DELETE as deleteReportRoute, GET as reportRoute, PATCH as shareRoute } from "@/app/api/reports/[id]/route";
import { GET as reportsRoute, POST as saveReportRoute } from "@/app/api/reports/route";
import { closeDb } from "@/db/client";
import type { MessagesClient } from "@/lib/ai/claude-adapter";
import { ClaudePlanner } from "@/lib/analytics/claude-planner";
import { baseSpec } from "@/lib/analytics/metric-service";
import { interpretQuestion } from "@/lib/domain/analytics";
import { actorFor, adminClient, createTestWorkspace, ctx, idemKey, request, type TestWorkspace } from "../setup/helpers";
import { importCatalog, publishTaxonomy } from "../setup/scenario";

let admin: pg.Client;
let ws: TestWorkspace;
let other: TestWorkspace;
let merchantId: string;

const post = (route: (req: Request, c?: never) => Promise<Response>, path: string, cookie: string, body: unknown, headers: Record<string, string> = {}) => route(request(path, { method: "POST", cookie, body, headers }));
const json = async (res: Response) => (await res.json()) as { data?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const count = async (table: string, workspaceId = ws.id) => (await admin.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [workspaceId])).rows[0].n as number;

async function ask(cookie: string, question: string, conversationId?: string) {
  return json(await post(interpretRoute, "/api/analytics/interpret", cookie, { question, conversationId }));
}
async function execute(cookie: string, spec: unknown, extra: Record<string, unknown> = {}) {
  const res = await post(executeRoute, "/api/analytics/execute", cookie, { spec, source: "builder", ...extra });
  return { status: res.status, ...(await json(res)) };
}

beforeAll(async () => {
  admin = await adminClient();
  ws = await createTestWorkspace(admin, "analytics-api");
  other = await createTestWorkspace(admin, "analytics-other");
  await publishTaxonomy(ws);
  ({ merchantId } = await importCatalog(ws, { merchantName: "=SUM(A1) Market", content: "merchant_sku,title\nA-1,Oat Milk Barista Blend 1L\nA-2,Mystery Item\nA-3,Whole Milk 1 Gallon\n" }));
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

describe("interpretation and execution", () => {
  it("requires a session", async () => {
    expect((await interpretRoute(request("/api/analytics/interpret", { method: "POST", body: { question: "How many active listings are there?" } }))).status).toBe(401);
    expect((await dashboardRoute(request("/api/dashboard"))).status).toBe(401);
  });

  it("labels the demo planner as rule-based and never as AI", async () => {
    const { data } = await json(await contextRoute(request("/api/analytics/context", { cookie: ws.cookie.viewer })));
    expect(data.planner).toMatchObject({ mode: "demo", label: "Demo planner" });
    expect(data.planner.detail).toMatch(/Not AI/);
    expect(data.vocabulary.merchants).toEqual([{ id: merchantId, name: "=SUM(A1) Market" }]);
    expect(data.canShare).toBe(false);
  });

  it("interpreting a question runs nothing; executing stores the run with its scope", async () => {
    const before = await count("analytics_runs");
    const interpreted = await ask(ws.cookie.analyst, "How many active listings are there?");
    expect(interpreted.data).toMatchObject({ planner: "demo", plannerLabel: "Demo planner (rule-based, not AI)", outcome: { kind: "spec", spec: { metricIds: ["listing_count"] } } });
    expect(interpreted.data.description[0]).toBe("Metric: Active listing count");
    expect(await count("analytics_runs")).toBe(before);

    const run = await execute(ws.cookie.analyst, interpreted.data.outcome.spec, { question: "How many active listings are there?", source: "demo" });
    expect(run.status).toBe(201);
    expect(run.data).toMatchObject({ planner: "demo", summary: "Active listing count is 3 overall.", result: { totals: { listing_count: { value: 3 } }, scope: { population: "current_catalogs" } } });
    expect(await count("analytics_runs")).toBe(before + 1);
    const stored = (await admin.query("select validated_spec, data_scope, planner, status, actor_id from analytics_runs where id = $1", [run.data.id])).rows[0];
    expect(stored).toMatchObject({ planner: "demo", status: "completed", actor_id: ws.userId.analyst, validated_spec: { metricIds: ["listing_count"] } });
    expect(stored.data_scope.merchants).toHaveLength(1);
  });

  it("a clarification or refusal creates no run", async () => {
    const before = await count("analytics_runs");
    expect((await ask(ws.cookie.analyst, "What is the coverage?")).data.outcome).toMatchObject({ kind: "clarify" });
    expect((await ask(ws.cookie.analyst, "Which category earns the most?")).data).toMatchObject({ planner: "guard", plannerLabel: "Fixed rule (no AI)", outcome: { kind: "unsupported", reason: "no_data" } });
    expect((await ask(ws.cookie.analyst, "What is the weather like?")).data.outcome).toMatchObject({ kind: "not_understood" });
    expect(await count("analytics_runs")).toBe(before);
  });

  it("a request to approve or publish is explained and changes nothing (AT26)", async () => {
    const tables = ["review_decisions", "mapping_releases", "published_mappings", "concepts", "taxonomy_proposals"];
    const before = await Promise.all(tables.map((t) => count(t)));
    const states = (await admin.query("select state, lock_version from review_states where workspace_id = $1 order by id", [ws.id])).rows;
    for (const cookie of [ws.cookie.viewer, ws.cookie.administrator]) {
      const { data } = await ask(cookie, "Approve everything below 80% coverage");
      expect(data.outcome).toMatchObject({ kind: "unsupported", reason: "mutation", links: [{ href: "/review?state=unresolved" }, { href: "/releases" }] });
    }
    expect(await Promise.all(tables.map((t) => count(t)))).toEqual(before);
    expect((await admin.query("select state, lock_version from review_states where workspace_id = $1 order by id", [ws.id])).rows).toEqual(states);
  });

  it("rejects specs that are not registered, need clarification or try to choose a workspace", async () => {
    const before = await count("analytics_runs");
    for (const bad of [
      { ...baseSpec("listing_count"), metricIds: ["revenue"] },
      { ...baseSpec("listing_count"), workspaceId: other.id },
      { ...baseSpec("listing_count"), sql: "select * from merchants" },
      { ...baseSpec("published_mapping_coverage"), needsClarification: true, clarificationQuestion: "Published or draft?" },
      { ...baseSpec("listing_count"), filters: [{ dimension: "merchant", operator: "eq", values: ["1 or 1=1"] }] },
      { ...baseSpec("listing_count"), limit: 5000 },
    ]) {
      const res = await execute(ws.cookie.analyst, bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await count("analytics_runs")).toBe(before);
  });

  it("a follow-up builds on the conversation's last executed analysis", async () => {
    const first = await ask(ws.cookie.analyst, "How many listings are pending review?");
    const run = await execute(ws.cookie.analyst, first.data.outcome.spec, { question: "How many listings are pending review?", source: "demo" });
    const followUp = await ask(ws.cookie.analyst, "by merchant", run.data.conversationId);
    expect(followUp.data.outcome).toMatchObject({ kind: "spec", spec: { metricIds: ["pending_review_count"], groupBy: ["merchant"] }, changes: ["Grouping changed to merchant"] });
    const second = await execute(ws.cookie.analyst, followUp.data.outcome.spec, { question: "by merchant", conversationId: run.data.conversationId, source: "demo" });
    expect(second.data.conversationId).toBe(run.data.conversationId);
    const conversation = await json(await conversationRoute(request(`/api/analytics/conversations/${run.data.conversationId}`, { cookie: ws.cookie.analyst }), ctx(run.data.conversationId)));
    expect(conversation.data.runs.map((r: { question: string }) => r.question)).toEqual(["How many listings are pending review?", "by merchant"]);
  });

  it("conversations are private to their owner, including from an administrator", async () => {
    const mine = await json(await conversationsRoute(request("/api/analytics/conversations", { cookie: ws.cookie.analyst })));
    expect(mine.data.length).toBeGreaterThan(0);
    const id = mine.data[0].id;
    for (const cookie of [ws.cookie.administrator, ws.cookie.viewer, other.cookie.administrator]) {
      expect((await json(await conversationsRoute(request("/api/analytics/conversations", { cookie })))).data).toEqual([]);
      expect((await conversationRoute(request(`/api/analytics/conversations/${id}`, { cookie }), ctx(id))).status).toBe(404);
      expect((await post(interpretRoute, "/api/analytics/interpret", cookie, { question: "by merchant", conversationId: id })).status).toBe(404);
      expect((await execute(cookie, baseSpec("listing_count"), { conversationId: id })).status).toBe(404);
    }
  });
});

describe("planner availability", () => {
  it("with AI off, interpretation is unavailable but the builder and dashboard work", async () => {
    await admin.query("update workspaces set provider_mode = 'off' where id = $1", [other.id]);
    const { data } = await ask(other.cookie.analyst, "How many active listings are there?");
    expect(data).toMatchObject({ planner: "none", outcome: { kind: "unavailable" } });
    expect((await execute(other.cookie.analyst, baseSpec("listing_count"))).data.result.totals.listing_count).toEqual({ value: 0 });
    expect((await dashboardRoute(request("/api/dashboard", { cookie: other.cookie.analyst }))).status).toBe(200);
    // Guards still answer, because they involve no provider.
    expect((await ask(other.cookie.analyst, "show revenue")).data.outcome).toMatchObject({ kind: "unsupported" });
  });

  it("live mode without a server key is unavailable and never falls back to the demo planner", async () => {
    await admin.query("update workspaces set provider_mode = 'live', live_ai_opt_in = true, ai_model_id = 'some-model' where id = $1", [other.id]);
    expect(process.env.ANTHROPIC_API_KEY ?? "").toBe("");
    const { data } = await ask(other.cookie.analyst, "How many active listings are there?");
    expect(data).toMatchObject({ planner: "none", plannerLabel: "AI unavailable", outcome: { kind: "unavailable" } });
    expect(await count("ai_usage", other.id)).toBe(0);
  });

  it("a live interpretation is validated, accounted for with unknown cost left unknown, and stopped by the daily cap", async () => {
    const actor = await actorFor(other, "analyst");
    const reply = { outcome: "spec", message: "", clarificationOptions: [], spec: { metricIds: ["listing_count"], groupBy: [], filters: [], timeRange: null, mappingState: "published", sortField: null, sortDirection: "asc", limit: 100, chartType: "table" } };
    const client: MessagesClient = { messages: { create: async () => ({ id: "m", type: "message", role: "assistant", model: "some-model", content: [{ type: "text", text: JSON.stringify(reply), citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as Anthropic.Message } };
    const planner = new ClaudePlanner("some-model", { client });
    const first = await interpretQuestion(actor, { question: "How big is the catalog?" }, { planner });
    expect(first).toMatchObject({ planner: "live", plannerLabel: "Live AI (some-model)", outcome: { kind: "spec" } });
    let usage = (await admin.query("select purpose, provider, model_id, input_tokens, output_tokens, cost_estimate_usd, status from ai_usage where workspace_id = $1 order by created_at", [other.id])).rows;
    expect(usage).toEqual([{ purpose: "analytics_plan", provider: "claude", model_id: "some-model", input_tokens: 1000, output_tokens: 100, cost_estimate_usd: null, status: "ok" }]);

    await admin.query("update workspaces set input_price_per_mtok = 1000, output_price_per_mtok = 5000, daily_spend_cap_usd = 1 where id = $1", [other.id]);
    await interpretQuestion(actor, { question: "How big is the catalog?" }, { planner });
    usage = (await admin.query("select cost_estimate_usd from ai_usage where workspace_id = $1 order by created_at", [other.id])).rows;
    expect(Number(usage[1].cost_estimate_usd)).toBeCloseTo(1.5, 6);
    await expect(interpretQuestion(actor, { question: "How big is the catalog?" }, { planner })).rejects.toMatchObject({ status: 429 });
    // A guard is answered before any provider call, even over the cap.
    expect((await interpretQuestion(actor, { question: "run sql: select 1 from merchants" }, { planner })).planner).toBe("guard");
    expect(await count("ai_usage", other.id)).toBe(2);
  });
});

describe("saved reports", () => {
  let runId: string;
  let reportId: string;

  it("saves a report from the caller's own run, private by default", async () => {
    const run = await execute(ws.cookie.analyst, baseSpec("listing_count", { groupBy: ["merchant"], chartType: "bar" }), { question: "Listings by merchant" });
    runId = run.data.id;
    const key = idemKey("report");
    const saved = await post(saveReportRoute, "/api/reports", ws.cookie.analyst, { runId, name: "Listings by merchant" }, { "idempotency-key": key });
    expect(saved.status).toBe(201);
    reportId = (await json(saved)).data.id;
    // The same key replays the same report instead of creating a second one.
    expect((await json(await post(saveReportRoute, "/api/reports", ws.cookie.analyst, { runId, name: "Listings by merchant" }, { "idempotency-key": key }))).data.id).toBe(reportId);
    expect(await count("saved_reports")).toBe(1);
    // Someone else's run cannot be saved.
    expect((await post(saveReportRoute, "/api/reports", ws.cookie.administrator, { runId, name: "Not mine" }, { "idempotency-key": idemKey("report") })).status).toBe(404);
  });

  it("a private report and its run are invisible to other members and other workspaces", async () => {
    for (const cookie of [ws.cookie.administrator, ws.cookie.viewer, other.cookie.administrator]) {
      expect((await json(await reportsRoute(request("/api/reports", { cookie })))).data).toEqual([]);
      expect((await reportRoute(request(`/api/reports/${reportId}`, { cookie }), ctx(reportId))).status).toBe(404);
      expect((await refreshRoute(request(`/api/reports/${reportId}/refresh`, { method: "POST", cookie }), ctx(reportId))).status).toBe(404);
      expect((await exportRoute(request(`/api/analytics/runs/${runId}/export`, { cookie }), ctx(runId))).status).toBe(404);
    }
  });

  it("sharing is explicit, limited to roles that may share, and audited", async () => {
    const viewerRun = await execute(ws.cookie.viewer, baseSpec("listing_count"));
    const viewerReport = (await json(await post(saveReportRoute, "/api/reports", ws.cookie.viewer, { runId: viewerRun.data.id, name: "Viewer's own" }, { "idempotency-key": idemKey("report") }))).data.id;
    const denied = await shareRoute(request(`/api/reports/${viewerReport}`, { method: "PATCH", cookie: ws.cookie.viewer, body: { visibility: "workspace", expectedVersion: 0 } }), ctx(viewerReport));
    expect(denied.status).toBe(403);
    // Not the owner: an administrator cannot share someone else's private report either.
    expect((await shareRoute(request(`/api/reports/${reportId}`, { method: "PATCH", cookie: ws.cookie.administrator, body: { visibility: "workspace", expectedVersion: 0 } }), ctx(reportId))).status).toBe(404);
    expect((await shareRoute(request(`/api/reports/${reportId}`, { method: "PATCH", cookie: ws.cookie.analyst, body: { visibility: "workspace", expectedVersion: 7 } }), ctx(reportId))).status).toBe(409);
    const shared = await shareRoute(request(`/api/reports/${reportId}`, { method: "PATCH", cookie: ws.cookie.analyst, body: { visibility: "workspace", expectedVersion: 0 } }), ctx(reportId));
    expect((await json(shared)).data).toMatchObject({ visibility: "workspace", lockVersion: 1 });

    const list = (await json(await reportsRoute(request("/api/reports", { cookie: ws.cookie.viewer })))).data;
    expect(list.map((r: { name: string; mine: boolean }) => [r.name, r.mine]).sort()).toEqual([["Listings by merchant", false], ["Viewer's own", true]]);
    // Still nothing for another workspace, and the owner's conversation stays private.
    expect((await reportRoute(request(`/api/reports/${reportId}`, { cookie: other.cookie.administrator }), ctx(reportId))).status).toBe(404);
    const report = (await json(await reportRoute(request(`/api/reports/${reportId}`, { cookie: ws.cookie.viewer }), ctx(reportId)))).data;
    expect(report).toMatchObject({ mine: false, canShare: false, refreshed: null, snapshot: { id: runId } });
    expect((await conversationRoute(request(`/api/analytics/conversations/${report.snapshot.conversationId}`, { cookie: ws.cookie.viewer }), ctx(report.snapshot.conversationId))).status).toBe(404);
    const audit = (await admin.query("select action from audit_events where workspace_id = $1 and entity_id = $2 order by created_at", [ws.id, reportId])).rows.map((r) => r.action);
    expect(audit).toEqual(["analytics.report.save", "analytics.report.share"]);
  });

  it("refresh recomputes with current data and keeps the saved snapshot", async () => {
    await importCatalog(ws, { merchantName: "Second Merchant", content: "merchant_sku,title\nB-1,Sparkling Water 12 Pack\nB-2,Dish Soap 500ml\n" });
    const refreshed = await json(await refreshRoute(request(`/api/reports/${reportId}/refresh`, { method: "POST", cookie: ws.cookie.analyst }), ctx(reportId)));
    expect(refreshed.data.result.totals.listing_count).toEqual({ value: 5 });
    expect(refreshed.data.planner).toBe("report");
    const report = (await json(await reportRoute(request(`/api/reports/${reportId}`, { cookie: ws.cookie.analyst }), ctx(reportId)))).data;
    expect(report.snapshot.id).toBe(runId);
    expect(report.snapshot.result.totals.listing_count).toEqual({ value: 3 });
    expect(report.refreshed.id).toBe(refreshed.data.id);
    expect(report.refreshed.result.rows).toHaveLength(2);
    // A viewer of the shared report may refresh it for themselves; the owner's stored refresh is unchanged.
    const viewerRefresh = await json(await refreshRoute(request(`/api/reports/${reportId}/refresh`, { method: "POST", cookie: ws.cookie.viewer }), ctx(reportId)));
    expect(viewerRefresh.data.result.totals.listing_count).toEqual({ value: 5 });
    expect((await json(await reportRoute(request(`/api/reports/${reportId}`, { cookie: ws.cookie.analyst }), ctx(reportId)))).data.refreshed.id).toBe(refreshed.data.id);
    // A stored run cannot be edited, even by the database owner's ordinary statements.
    await expect(admin.query("update analytics_runs set result_snapshot = '{}' where id = $1", [runId])).rejects.toThrow();
  });

  it("exports a spreadsheet-safe CSV with the interpreted scope and run time, and audits it (AT25)", async () => {
    const res = await exportRoute(request(`/api/analytics/runs/${runId}/export`, { cookie: ws.cookie.viewer }), ctx(runId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="analytics-[0-9a-f]{8}\.csv"/);
    const csv = await res.text();
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Catalog Intelligence analytics export,");
    expect(csv).toContain(`Run ID,${runId}`);
    expect(csv).toMatch(/Computed at \(UTC\),\d{4}-\d{2}-\d{2}T/);
    expect(csv).toContain("Question,Listings by merchant");
    expect(csv).toContain("Interpretation,Metric: Active listing count");
    expect(csv).toContain("Interpretation,Grouped by: Merchant");
    expect(csv).toMatch(/Scope,"?'=SUM\(A1\) Market: catalog revision 1; no release for the current revision/);
    expect(lines).toContain("Merchant,Active listing count");
    // The merchant name starts with "=": neutralised in the file, unchanged in the database.
    expect(lines).toContain("'=SUM(A1) Market,3");
    expect(lines).toContain("Total,3");
    expect((await admin.query("select name from merchants where id = $1", [merchantId])).rows[0].name).toBe("=SUM(A1) Market");
    const audit = (await admin.query("select actor_id from audit_events where workspace_id = $1 and action = 'analytics.export' and entity_id = $2", [ws.id, runId])).rows;
    expect(audit).toEqual([{ actor_id: ws.userId.viewer }]);
    expect((await exportRoute(request(`/api/analytics/runs/${runId}/export`, { cookie: other.cookie.administrator }), ctx(runId))).status).toBe(404);
    expect((await exportRoute(request(`/api/analytics/runs/${runId}/export`), ctx(runId))).status).toBe(401);
  });

  it("unsharing hides the report and its export again; a removed member can neither refresh nor export", async () => {
    await shareRoute(request(`/api/reports/${reportId}`, { method: "PATCH", cookie: ws.cookie.analyst, body: { visibility: "private", expectedVersion: 2 } }), ctx(reportId));
    expect((await reportRoute(request(`/api/reports/${reportId}`, { cookie: ws.cookie.viewer }), ctx(reportId))).status).toBe(404);
    expect((await exportRoute(request(`/api/analytics/runs/${runId}/export`, { cookie: ws.cookie.viewer }), ctx(runId))).status).toBe(404);

    await admin.query("delete from memberships where workspace_id = $1 and user_id = $2", [ws.id, ws.userId.analyst]);
    expect((await refreshRoute(request(`/api/reports/${reportId}/refresh`, { method: "POST", cookie: ws.cookie.analyst }), ctx(reportId))).status).toBe(403);
    expect((await exportRoute(request(`/api/analytics/runs/${runId}/export`, { cookie: ws.cookie.analyst }), ctx(runId))).status).toBe(403);
    expect((await dashboardRoute(request("/api/dashboard", { cookie: ws.cookie.analyst }))).status).toBe(403);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'analyst')", [ws.id, ws.userId.analyst]);
    expect((await deleteReportRoute(request(`/api/reports/${reportId}`, { method: "DELETE", cookie: ws.cookie.viewer }), ctx(reportId))).status).toBe(404);
    expect((await deleteReportRoute(request(`/api/reports/${reportId}`, { method: "DELETE", cookie: ws.cookie.analyst }), ctx(reportId))).status).toBe(200);
  });
});
