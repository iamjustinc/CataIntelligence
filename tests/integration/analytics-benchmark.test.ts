import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db/client";
import { seedScenario } from "@/db/seed-scenario";
import { DemoPlanner } from "@/lib/analytics/planner";
import type { Actor } from "@/lib/auth/actor";
import type { AnalysisSpec } from "@/lib/contracts/analysis-spec";
import { executeAnalysis, interpretQuestion } from "@/lib/domain/analytics";
import { BENCH_NOW, BENCH_TIMEZONE, comparable, QUESTIONS, scoreBenchmark, sortRows, type BenchContext, type BenchResult, type ReferenceRow } from "../../evals/analytics/benchmark";
import { actorFor, adminClient, createTestWorkspace, type TestWorkspace } from "../setup/helpers";

let admin: pg.Client;
let ws: TestWorkspace;
let empty: TestWorkspace;
let context: BenchContext;
const results: BenchResult[] = [];
let mutationsBefore: Record<string, number>;

const MUTABLE = ["review_decisions", "review_states", "mapping_releases", "published_mappings", "concepts", "concept_revisions", "taxonomy_versions", "taxonomy_proposals", "analysis_jobs", "merchants", "listing_revisions"];
async function rowCounts() {
  const out: Record<string, number> = {};
  for (const t of MUTABLE) out[t] = (await admin.query(`select count(*)::int as n from ${t} where workspace_id = any($1)`, [[ws.id, empty.id]])).rows[0].n;
  out.review_state_versions = (await admin.query("select coalesce(sum(lock_version), 0)::int as n from review_states where workspace_id = $1", [ws.id])).rows[0].n;
  return out;
}

beforeAll(async () => {
  admin = await adminClient();
  ws = await createTestWorkspace(admin, "bench");
  empty = await createTestWorkspace(admin, "bench-empty");
  const scenario = (await seedScenario(await actorFor(ws, "administrator"), await actorFor(ws, "taxonomist")))!;
  context = { merchant: { harbor: scenario.merchants["harbor-market"], daily: scenario.merchants["daily-basket"], corner: scenario.merchants["corner-goods"] } };
  await admin.query("update workspaces set timezone = $2 where id = any($1)", [[ws.id, empty.id], BENCH_TIMEZONE]);

  // Review decisions at exact instants around the interval boundaries the time questions use.
  // They are arranged directly because the application always records "now"; they do not change
  // any listing's state, so the snapshot metrics are unaffected.
  const listings = (await admin.query("select lr.id from listing_revisions lr join merchants m on m.active_catalog_revision_id = lr.catalog_revision_id where lr.workspace_id = $1 and lr.active order by lr.id limit 12", [ws.id])).rows.map((r) => r.id as string);
  const at: [string, string, number | null][] = [
    ["2026-09-01T06:59:59.999Z", "manual", 40], // 31 August in Los Angeles: before September
    ["2026-09-01T07:00:00.000Z", "manual", 50], // first instant of September
    ["2026-10-01T06:59:59.999Z", "suggestion", 70], // last instant of September
    ["2026-10-01T07:00:00.000Z", "manual", 90], // first instant of October
    ["2026-09-15T12:00:00.000Z", "carried_forward", null], // not a human review
    ["2026-10-05T06:59:59.999Z", "manual", 30], // Sunday night: before last week
    ["2026-10-05T07:00:00.000Z", "manual", 20], // first instant of last week
    ["2026-10-11T23:30:00.000Z", "bulk", null], // inside last week; bulk is excluded from the median only
    ["2026-10-12T06:59:59.999Z", "manual", null], // last instant of last week, on UTC day 12 October
    ["2026-10-12T07:00:00.000Z", "manual", 10], // this week
  ];
  for (const [i, [createdAt, origin, duration]] of at.entries()) {
    await admin.query(
      "insert into review_decisions (workspace_id, listing_revision_id, taxonomy_version_id, action, origin, duration_seconds, actor_id, created_at) values ($1, $2, $3, 'defer', $4, $5, $6, $7)",
      [ws.id, listings[i], scenario.taxonomyVersionId, origin, duration, ws.userId.taxonomist, createdAt],
    );
  }
  mutationsBefore = await rowCounts();

  const actors: Record<"scenario" | "empty", Actor> = { scenario: await actorFor(ws, "viewer"), empty: await actorFor(empty, "viewer") };
  const conversation = new Map<string, string>();
  const planner = new DemoPlanner();
  for (const q of QUESTIONS) {
    const actor = actors[q.workspace ?? "scenario"];
    const wsId = q.workspace === "empty" ? empty.id : ws.id;
    const result: BenchResult = { id: q.id, category: q.category, question: q.question, expected: q.expect.kind, got: "", specMatches: null, numbersMatch: null, pass: false };
    try {
      const { outcome } = await interpretQuestion(actor, { question: q.question, conversationId: q.after ? conversation.get(q.after) : null }, { planner, now: BENCH_NOW });
      result.got = outcome.kind;
      let toRun: AnalysisSpec | null = null;
      if (q.expect.kind === "spec") {
        const expected = q.expect.spec(context);
        result.specMatches = outcome.kind === "spec" && JSON.stringify(sorted(outcome.spec)) === JSON.stringify(sorted(expected));
        if (outcome.kind === "spec") toRun = outcome.spec;
        if (!result.specMatches) result.detail = outcome.kind === "spec" ? `spec differs: ${JSON.stringify(outcome.spec)}` : JSON.stringify(outcome).slice(0, 300);
      } else if (q.expect.kind === "clarify") {
        result.pass = outcome.kind === "clarify" && outcome.options.length >= q.expect.minOptions;
        if (outcome.kind === "clarify" && q.expect.accept !== undefined) toRun = outcome.options[q.expect.accept]?.spec ?? null;
      } else if (q.expect.kind === "unsupported") {
        result.pass = outcome.kind === "unsupported" && outcome.reason === q.expect.reason;
      } else {
        result.pass = outcome.kind === "not_understood";
      }
      if (!result.pass && q.expect.kind !== "spec") result.detail = JSON.stringify(outcome).slice(0, 300);
      if (toRun) {
        const run = await executeAnalysis(actor, { spec: toRun, question: q.question, conversationId: q.after ? conversation.get(q.after) : null, source: "demo" });
        conversation.set(q.id, run.conversationId!);
        if (q.expect.kind === "spec") {
          const reference = sortRows((await admin.query(q.expect.reference, [wsId])).rows as ReferenceRow[]);
          const got = comparable(run.result);
          result.numbersMatch = JSON.stringify(normal(got)) === JSON.stringify(normal(reference));
          if (!result.numbersMatch) result.detail = `numbers differ: got ${JSON.stringify(got)} reference ${JSON.stringify(reference)}`;
          result.pass = !!result.specMatches && result.numbersMatch;
        }
      }
    } catch (err) {
      result.got = "error";
      result.detail = err instanceof Error ? err.message : String(err);
    }
    results.push(result);
  }
}, 120_000);
afterAll(async () => {
  await admin.end();
  await closeDb();
});

/** Key order and filter order do not change what a spec means. */
function sorted(spec: AnalysisSpec) {
  return { ...Object.fromEntries(Object.entries(spec).sort(([a], [b]) => a.localeCompare(b))), filters: [...spec.filters].sort((a, b) => a.dimension.localeCompare(b.dimension)) };
}
const normal = (rows: ReferenceRow[]) => rows.map((r) => ({ k: r.k, n: r.n === null ? null : Number(r.n), d: r.d === undefined || r.d === null ? null : Number(r.d) }));

describe("analytics benchmark with the demo planner (deterministic)", () => {
  it("has 40 questions across the required categories", () => {
    expect(QUESTIONS).toHaveLength(40);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(40);
    expect(new Set(QUESTIONS.map((q) => q.category))).toEqual(new Set(["totals", "rates", "merchants", "publication_scope", "follow_ups", "time", "unsupported", "zero_denominator", "permission"]));
  });

  it("every supported question produces the reference spec and reconciles with its reference query", () => {
    const failed = results.filter((r) => r.expected === "spec" && !r.pass);
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
  });

  it("every question that needs clarification or cannot be answered is declined, and nothing runs for it", () => {
    const failed = results.filter((r) => r.expected !== "spec" && !r.pass);
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
    expect(scoreBenchmark(results).unauthorizedExecutions).toBe(0);
  });

  it("interval boundaries are half-open in the workspace timezone", async () => {
    const value = async (id: string) => (await admin.query(QUESTIONS.find((q) => q.id === id)!.expect.kind === "spec" ? (QUESTIONS.find((q) => q.id === id)!.expect as { reference: string }).reference : "select 1", [ws.id])).rows;
    // September holds exactly the two human decisions placed at its first and last instants.
    expect(await value("D1")).toEqual([{ k: null, n: 2 }]);
    expect(results.find((r) => r.id === "D1")).toMatchObject({ pass: true });
    expect(results.find((r) => r.id === "D2")).toMatchObject({ pass: true });
    const lastWeek = await value("D2");
    expect(lastWeek).toEqual(expect.arrayContaining([{ k: "2026-10-05", n: 1 }, { k: "2026-10-11", n: 1 }, { k: "2026-10-12", n: 1 }]));
  });

  it("asking questions changed no listing, decision, taxonomy or release record", async () => {
    expect(await rowCounts()).toEqual(mutationsBefore);
  });

  it("writes the report", () => {
    const score = scoreBenchmark(results);
    const dir = resolve(process.cwd(), "evals/reports");
    mkdirSync(dir, { recursive: true });
    const report = {
      benchmark: "analytics-40",
      planner: "demo (rule-based phrase matcher, not a model)",
      liveModel: "not run: no provider credentials",
      fixedInputs: { now: BENCH_NOW.toISOString(), timezone: BENCH_TIMEZONE, data: "pinned demo scenario plus ten arranged review decisions at interval boundaries" },
      score,
      results: results.map((r) => ({ id: r.id, category: r.category, question: r.question, expected: r.expected, got: r.got, specMatches: r.specMatches, numbersMatch: r.numbersMatch, pass: r.pass })),
    };
    writeFileSync(resolve(dir, "analytics-benchmark-demo.json"), JSON.stringify(report, null, 2) + "\n");
    expect(score.supported.correct).toBe(score.supported.total);
    expect(score.clarificationOrRefusal.correct).toBe(score.clarificationOrRefusal.total);
  });
});
