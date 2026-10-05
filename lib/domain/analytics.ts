/**
 * Analytics workflows (PRD ANA01 to ANA06): question interpretation, governed execution, private
 * conversations, saved reports, sharing, refresh and export, and the dashboard.
 *
 * Nothing here writes to listings, decisions, taxonomy or releases. The only tables written are
 * analytics_conversations, analytics_runs, saved_reports, ai_usage and audit_events.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { withContext, type Tx } from "@/db/client";
import { aiUsage, analyticsConversations, analyticsRuns, mappingReleases, merchants, savedReports, user, workspaces } from "@/db/schema";
import { resolveProviderStatus } from "@/lib/ai/provider";
import { ClaudePlanner } from "@/lib/analytics/claude-planner";
import { describeSpec, DIMENSION_LABELS, formatFraction, formatValue, summarize } from "@/lib/analytics/format";
import { METRICS, type MetricId } from "@/lib/analytics/metric-registry";
import { analyticsVocabulary, baseSpec, runSpecInTx, validateSpec, type MetricResult } from "@/lib/analytics/metric-service";
import { DemoPlanner, guard, type Planner, type PlanOutcome, type Vocabulary } from "@/lib/analytics/planner";
import { periodInterval } from "@/lib/analytics/time";
import { ApiError, conflict, forbidden, notFound } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { analysisSpecSchema, type AnalysisSpec } from "@/lib/contracts/analysis-spec";
import { env } from "@/lib/env";
import { toSafeCsv } from "@/lib/export/csv";
import { costOf, dailyCommittedUsd } from "./analysis";

export type PlannerMode = "demo" | "live" | "none";
export interface PlannerStatus {
  mode: PlannerMode;
  label: string;
  detail: string;
}

type WorkspaceRow = typeof workspaces.$inferSelect;

function plannerStatusOf(ws: WorkspaceRow): PlannerStatus & { modelId: string | null } {
  const modelId = ws.aiModelId ?? env().AI_MODEL_ID ?? null;
  const status = resolveProviderStatus(ws.providerMode, { ANTHROPIC_API_KEY: env().ANTHROPIC_API_KEY, AI_MODEL_ID: modelId ?? undefined }, ws.liveAiOptIn);
  if (status.state === "demo") return { mode: "demo", modelId: null, label: "Demo planner", detail: "Rule-based phrase matching for a fixed set of question forms. Not AI: questions it cannot fully match are refused, not guessed." };
  if (status.state === "live") return { mode: "live", modelId, label: "Live AI", detail: `Questions are interpreted by ${modelId}. The model proposes an analysis; the server validates it and computes every number.` };
  return { mode: "none", modelId: null, label: status.state === "off" ? "Question interpretation off" : "AI unavailable", detail: `${status.detail} The analysis builder works without a provider.` };
}

/** Test seam: lets tests supply a planner backed by a deterministic client. */
export interface AnalyticsDeps {
  planner?: Planner;
  now?: Date;
}

export async function getAnalyticsContext(actor: Actor) {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  const vocabulary = await analyticsVocabulary(actor);
  const status = await withContext(actor, async (tx) => {
    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    const { mode, label, detail } = plannerStatusOf(ws);
    return { mode, label, detail };
  });
  return { planner: status, vocabulary, canShare: can(actor.role, "report.share") };
}

async function ownConversation(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.select().from(analyticsConversations).where(and(eq(analyticsConversations.id, id), eq(analyticsConversations.ownerId, actor.userId)));
  // Another member's conversation is indistinguishable from one that does not exist.
  if (!row) throw notFound("Conversation");
  return row;
}

export interface Interpretation {
  planner: PlannerMode | "guard";
  plannerLabel: string;
  outcome: PlanOutcome | { kind: "unavailable"; message: string };
  /** The interpretation in words, for a spec outcome. */
  description: string[];
}

/**
 * Interprets a question. Never executes anything: the caller shows the interpretation and the
 * user runs it (or edits it first).
 */
export async function interpretQuestion(actor: Actor, input: { question: string; conversationId?: string | null }, deps: AnalyticsDeps = {}): Promise<Interpretation> {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  const question = input.question.trim();
  if (!question) throw new ApiError("invalid", "Type a question.", { fieldErrors: [{ path: "question", message: "A question is required." }] });
  const vocabulary = await analyticsVocabulary(actor);
  const { ws, previousSpec, committed } = await withContext(actor, async (tx) => {
    const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    const conversation = input.conversationId ? await ownConversation(tx, actor, input.conversationId) : null;
    const last = conversation?.lastSpec ? analysisSpecSchema.safeParse(conversation.lastSpec) : null;
    return { ws: row, previousSpec: last?.success ? last.data : null, committed: await dailyCommittedUsd(tx) };
  });
  const describe = (outcome: Interpretation["outcome"]) => (outcome.kind === "spec" ? describeSpec(outcome.spec, vocabulary) : []);

  // Guards answer the same way whichever planner is configured, and before any provider call.
  const blocked = guard(question);
  if (blocked) return { planner: "guard", plannerLabel: "Fixed rule (no AI)", outcome: blocked, description: [] };

  const status = plannerStatusOf(ws);
  let planner = deps.planner ?? null;
  if (!planner) {
    if (status.mode === "none") return { planner: "none", plannerLabel: status.label, outcome: { kind: "unavailable", message: `${status.detail}` }, description: [] };
    planner = status.mode === "demo" ? new DemoPlanner() : new ClaudePlanner(status.modelId!, { apiKey: env().ANTHROPIC_API_KEY });
  }
  if (planner.id === "live" && committed >= Number(ws.dailySpendCapUsd)) {
    throw new ApiError("rate_limited", "Today's provider spending cap for this workspace is reached. The analysis builder still works.");
  }
  const { outcome, usage } = await planner.plan({ question, previousSpec, vocabulary, now: deps.now ?? new Date() });
  if (usage) {
    const cost = usage.inputTokens === null || usage.outputTokens === null ? null : costOf(usage.inputTokens, usage.outputTokens, { input: ws.inputPricePerMtok, output: ws.outputPricePerMtok });
    await withContext(actor, (tx) =>
      tx.insert(aiUsage).values({
        workspaceId: actor.workspaceId,
        runId: randomUUID(),
        purpose: "analytics_plan",
        provider: "claude",
        modelId: planner.modelId,
        promptVersion: planner.promptVersion,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        // Unknown stays NULL: it is never recorded as zero.
        costEstimateUsd: cost === null ? null : cost.toFixed(6),
        status: usage.status,
        errorCode: usage.errorCode,
        latencyMs: usage.latencyMs,
      }),
    );
  }
  return { planner: planner.id, plannerLabel: planner.id === "demo" ? "Demo planner (rule-based, not AI)" : `Live AI (${planner.modelId})`, outcome, description: describe(outcome) };
}

export interface RunView {
  id: string;
  conversationId: string | null;
  question: string | null;
  planner: string | null;
  createdAt: string;
  result: MetricResult;
  summary: string;
  description: string[];
}

export type RunSource = "demo" | "live" | "builder" | "report";

function runView(row: typeof analyticsRuns.$inferSelect, vocabulary: Vocabulary): RunView {
  const result = row.resultSnapshot as MetricResult;
  return { id: row.id, conversationId: row.conversationId, question: row.question, planner: row.planner, createdAt: row.createdAt.toISOString(), result, summary: summarize(result), description: describeSpec(result.spec, vocabulary) };
}

async function insertRun(tx: Tx, actor: Actor, values: { conversationId: string | null; question: string | null; planner: RunSource; spec: AnalysisSpec }) {
  const result = await runSpecInTx(tx, actor.workspaceId, values.spec);
  const [row] = await tx
    .insert(analyticsRuns)
    .values({ workspaceId: actor.workspaceId, conversationId: values.conversationId, actorId: actor.userId, question: values.question, validatedSpec: result.spec, dataScope: result.scope, resultSnapshot: result, planner: values.planner, status: "completed" })
    .returning();
  return row;
}

/**
 * Validates and runs a spec, stores the run with its scope and result, and records it as the
 * conversation's latest analysis so a follow-up can build on it.
 */
export async function executeAnalysis(actor: Actor, input: { spec: unknown; question?: string | null; conversationId?: string | null; source: RunSource }): Promise<RunView> {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  const spec = validateSpec(input.spec);
  const vocabulary = await analyticsVocabulary(actor);
  return withContext(actor, async (tx) => {
    let conversationId = input.conversationId ?? null;
    if (conversationId) {
      await ownConversation(tx, actor, conversationId);
      await tx.update(analyticsConversations).set({ lastSpec: spec }).where(eq(analyticsConversations.id, conversationId));
    } else {
      const title = (input.question?.trim() || spec.metricIds.map((id) => METRICS[id].label).join(", ")).slice(0, 120);
      const [created] = await tx.insert(analyticsConversations).values({ workspaceId: actor.workspaceId, ownerId: actor.userId, title, lastSpec: spec }).returning({ id: analyticsConversations.id });
      conversationId = created.id;
    }
    const row = await insertRun(tx, actor, { conversationId, question: input.question?.trim().slice(0, 1000) || null, planner: input.source, spec });
    return runView(row, vocabulary);
  });
}

export async function listConversations(actor: Actor) {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  return withContext(actor, async (tx) => {
    const rows = await tx
      .select({ id: analyticsConversations.id, title: analyticsConversations.title, createdAt: analyticsConversations.createdAt, runs: sql<number>`(select count(*)::int from analytics_runs r where r.conversation_id = analytics_conversations.id)` })
      .from(analyticsConversations)
      .where(eq(analyticsConversations.ownerId, actor.userId))
      .orderBy(desc(analyticsConversations.createdAt))
      .limit(30);
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  });
}

export async function getConversation(actor: Actor, id: string) {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  const vocabulary = await analyticsVocabulary(actor);
  return withContext(actor, async (tx) => {
    const conversation = await ownConversation(tx, actor, id);
    const runs = await tx.select().from(analyticsRuns).where(eq(analyticsRuns.conversationId, id)).orderBy(asc(analyticsRuns.createdAt), asc(analyticsRuns.id));
    return { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt.toISOString(), runs: runs.map((r) => runView(r, vocabulary)) };
  });
}

// ---------------------------------------------------------------------------------------------
// Saved reports
// ---------------------------------------------------------------------------------------------

/** A run is readable by its author, or by any member when a workspace-shared report points at it. */
async function readableRun(tx: Tx, actor: Actor, runId: string) {
  const [row] = await tx.select().from(analyticsRuns).where(eq(analyticsRuns.id, runId));
  if (!row) throw notFound("Analysis run");
  if (row.actorId !== actor.userId) {
    const [shared] = await tx
      .select({ id: savedReports.id })
      .from(savedReports)
      .where(and(eq(savedReports.visibility, "workspace"), or(eq(savedReports.snapshotRunId, runId), eq(savedReports.lastRunId, runId))))
      .limit(1);
    if (!shared) throw notFound("Analysis run");
  }
  return row;
}

async function readableReport(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.select().from(savedReports).where(eq(savedReports.id, id));
  if (!row || (row.ownerId !== actor.userId && row.visibility !== "workspace")) throw notFound("Report");
  return row;
}

export async function saveReport(actor: Actor, input: { runId: string; name: string }, requestId: string) {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  const name = input.name.trim();
  if (!name) throw new ApiError("invalid", "Give the report a name.", { fieldErrors: [{ path: "name", message: "A name is required." }] });
  return withContext(actor, async (tx) => {
    const [run] = await tx.select().from(analyticsRuns).where(and(eq(analyticsRuns.id, input.runId), eq(analyticsRuns.actorId, actor.userId)));
    if (!run) throw notFound("Analysis run");
    const spec = run.validatedSpec as AnalysisSpec;
    const [report] = await tx
      .insert(savedReports)
      .values({ workspaceId: actor.workspaceId, ownerId: actor.userId, name: name.slice(0, 120), spec, chartConfig: { chartType: spec.chartType }, visibility: "private", snapshotRunId: run.id, lastRunId: run.id })
      .returning();
    await recordAudit(tx, actor, requestId, { action: "analytics.report.save", entityType: "saved_report", entityId: report.id, after: { name: report.name, visibility: "private", runId: run.id } });
    return { id: report.id };
  });
}

export async function listReports(actor: Actor) {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  return withContext(actor, async (tx) => {
    const rows = await tx
      .select({ id: savedReports.id, name: savedReports.name, visibility: savedReports.visibility, ownerId: savedReports.ownerId, ownerName: user.name, createdAt: savedReports.createdAt, spec: savedReports.spec })
      .from(savedReports)
      .innerJoin(user, eq(user.id, savedReports.ownerId))
      .where(or(eq(savedReports.ownerId, actor.userId), eq(savedReports.visibility, "workspace")))
      .orderBy(desc(savedReports.createdAt));
    return rows.map(({ spec, ...r }) => ({ ...r, createdAt: r.createdAt.toISOString(), mine: r.ownerId === actor.userId, metrics: (spec as AnalysisSpec).metricIds.map((id) => METRICS[id].label) }));
  });
}

export async function getReport(actor: Actor, id: string) {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  const vocabulary = await analyticsVocabulary(actor);
  return withContext(actor, async (tx) => {
    const report = await readableReport(tx, actor, id);
    const [owner] = await tx.select({ name: user.name }).from(user).where(eq(user.id, report.ownerId));
    const load = async (runId: string | null) => {
      if (!runId) return null;
      const [run] = await tx.select().from(analyticsRuns).where(eq(analyticsRuns.id, runId));
      return run ? runView(run, vocabulary) : null;
    };
    const snapshot = await load(report.snapshotRunId);
    return {
      id: report.id,
      name: report.name,
      visibility: report.visibility,
      mine: report.ownerId === actor.userId,
      ownerName: owner?.name ?? "Unknown",
      lockVersion: report.lockVersion,
      createdAt: report.createdAt.toISOString(),
      /** The result as it was when the report was saved. Never recomputed. */
      snapshot,
      /** The most recent refresh, when one exists and differs from the saved snapshot. */
      refreshed: report.lastRunId && report.lastRunId !== report.snapshotRunId ? await load(report.lastRunId) : null,
      canShare: report.ownerId === actor.userId && can(actor.role, "report.share"),
    };
  });
}

/** Recomputes a report with current data. The saved snapshot is kept; the refresh is a new run. */
export async function refreshReport(actor: Actor, id: string, requestId: string): Promise<RunView> {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  const vocabulary = await analyticsVocabulary(actor);
  return withContext(actor, async (tx) => {
    const report = await readableReport(tx, actor, id);
    const row = await insertRun(tx, actor, { conversationId: null, question: null, planner: "report", spec: validateSpec(report.spec) });
    // A shared report shows each viewer their own refresh result; only the owner's refresh is stored on the report.
    if (report.ownerId === actor.userId) await tx.update(savedReports).set({ lastRunId: row.id, lockVersion: report.lockVersion + 1 }).where(eq(savedReports.id, id));
    await recordAudit(tx, actor, requestId, { action: "analytics.report.refresh", entityType: "saved_report", entityId: id, after: { runId: row.id } });
    return runView(row, vocabulary);
  });
}

export async function setReportVisibility(actor: Actor, id: string, input: { visibility: "private" | "workspace"; expectedVersion: number }, requestId: string) {
  if (!can(actor.role, "report.share")) throw forbidden("Your role cannot share reports.");
  return withContext(actor, async (tx) => {
    const [report] = await tx.select().from(savedReports).where(and(eq(savedReports.id, id), eq(savedReports.ownerId, actor.userId))).for("update");
    if (!report) throw notFound("Report");
    if (report.lockVersion !== input.expectedVersion) throw conflict("This report changed since you opened it. Reload and try again.", { lockVersion: report.lockVersion });
    if (report.visibility !== input.visibility) {
      await tx.update(savedReports).set({ visibility: input.visibility, lockVersion: report.lockVersion + 1 }).where(eq(savedReports.id, id));
      await recordAudit(tx, actor, requestId, { action: input.visibility === "workspace" ? "analytics.report.share" : "analytics.report.unshare", entityType: "saved_report", entityId: id, before: { visibility: report.visibility }, after: { visibility: input.visibility } });
    }
    return { id, visibility: input.visibility, lockVersion: report.visibility !== input.visibility ? report.lockVersion + 1 : report.lockVersion };
  });
}

export async function deleteReport(actor: Actor, id: string, requestId: string) {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  return withContext(actor, async (tx) => {
    const [report] = await tx.select().from(savedReports).where(and(eq(savedReports.id, id), eq(savedReports.ownerId, actor.userId)));
    if (!report) throw notFound("Report");
    await tx.delete(savedReports).where(eq(savedReports.id, id));
    await recordAudit(tx, actor, requestId, { action: "analytics.report.delete", entityType: "saved_report", entityId: id, before: { name: report.name, visibility: report.visibility } });
    return { id };
  });
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

/** CSV of a stored run: the interpreted scope and run timestamp first, then the exact result cells. */
export async function exportRunCsv(actor: Actor, runId: string, requestId: string): Promise<{ fileName: string; content: string }> {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  const vocabulary = await analyticsVocabulary(actor);
  return withContext(actor, async (tx) => {
    const run = await readableRun(tx, actor, runId);
    const result = run.resultSnapshot as MetricResult;
    const { dimensions, metrics } = result.columns;
    const header = [...dimensions.map((d) => DIMENSION_LABELS[d]), ...metrics.flatMap((m) => (METRICS[m].kind === "ratio" ? [METRICS[m].label, `${METRICS[m].label}: numerator`, `${METRICS[m].label}: denominator`] : [METRICS[m].label]))];
    // Exact values, not display rounding. A zero denominator is exported as "Not applicable".
    const cells = (values: MetricResult["totals"]) => metrics.flatMap((m) => (METRICS[m].kind === "ratio" ? [values[m]?.value ?? "Not applicable", values[m]?.numerator ?? "", values[m]?.denominator ?? ""] : [values[m]?.value ?? "Not applicable"]));
    const body = result.rows.map((r) => [...dimensions.map((d) => r.dims[d]?.label ?? ""), ...cells(r.values)]);
    if (dimensions.length > 0) body.push([...dimensions.map((_, i) => (i === 0 ? "Total" : "")), ...cells(result.totals)]);
    const width = header.length;
    const pad = (row: (string | number)[]) => [...row, ...Array(Math.max(width - row.length, 0)).fill("")];
    const meta: (string | number)[][] = [
      ["Catalog Intelligence analytics export"],
      ["Workspace", actor.workspace.name],
      ["Run ID", run.id],
      ["Computed at (UTC)", result.scope.observedAt],
      ...(run.question ? [["Question", run.question]] : []),
      ...describeSpec(result.spec, vocabulary).map((line) => ["Interpretation", line]),
      ...result.scope.merchants.map((m) => ["Scope", `${m.merchantName}: catalog revision ${m.revisionSequence ?? "none"}; ${m.releaseNumber ? `release ${m.releaseNumber}` : "no release for the current revision"}`]),
      ["Taxonomy version", result.scope.taxonomySequence ?? "none"],
      ...result.warnings.map((w) => ["Note", w]),
      [],
    ];
    const content = toSafeCsv(pad(meta[0]) as string[], [...meta.slice(1).map(pad), pad(header), ...body.map(pad)]);
    await recordAudit(tx, actor, requestId, { action: "analytics.export", entityType: "analytics_run", entityId: run.id, after: { rows: result.rows.length } });
    return { fileName: `analytics-${run.id.slice(0, 8)}.csv`, content };
  });
}

// ---------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------

export interface DashboardCard {
  metricId: MetricId;
  label: string;
  value: string;
  fraction: string | null;
  raw: number | null;
  scope: string;
  spec: AnalysisSpec;
}

/**
 * Everything the dashboard shows, computed by the same metric service in one transaction so the
 * cards, the merchant comparison and the distribution describe the same instant.
 */
export async function getDashboard(actor: Actor, now = new Date()) {
  if (!can(actor.role, "analytics.ask")) throw forbidden();
  return withContext(actor, async (tx) => {
    const run = (spec: AnalysisSpec) => runSpecInTx(tx, actor.workspaceId, spec);
    const draft = { population: "current_catalogs", mappingState: "draft" } as const;
    const totalsDraft = await run(baseSpec("listing_count", { metricIds: ["listing_count", "approved_draft_coverage", "pending_review_count", "ambiguous_count"], scope: draft }));
    const failed = await run(baseSpec("failed_analysis_count"));
    const published = await run(baseSpec("published_mapping_coverage"));
    const byMerchantDraft = await run(baseSpec("listing_count", { metricIds: ["listing_count", "approved_draft_coverage", "pending_review_count", "failed_analysis_count"], groupBy: ["merchant"], scope: draft, limit: 1000 }));
    const byMerchantPublished = await run(baseSpec("published_mapping_coverage", { groupBy: ["merchant"], limit: 1000 }));
    const byState = await run(baseSpec("listing_count", { groupBy: ["decision_status"], limit: 1000 }));
    const window = { start: periodInterval("last_30_days", now, "UTC").start, end: periodInterval("today", now, "UTC").end };
    const activity = await run(baseSpec("reviewed_listing_count", { groupBy: ["utc_day"], timeRange: window, limit: 1000, chartType: "line" }));
    // Publication history comes from the immutable release records, so it is complete from the first release.
    const publications = await run(baseSpec("releases_published_count", { metricIds: ["releases_published_count", "mappings_published_count"], groupBy: ["utc_day"], limit: 1000, chartType: "line" }));
    const [latest] = await tx
      .select({ id: mappingReleases.id, releaseNumber: mappingReleases.releaseNumber, publishedAt: mappingReleases.publishedAt, merchantName: merchants.name, partial: mappingReleases.partial, counts: mappingReleases.counts })
      .from(mappingReleases)
      .innerJoin(merchants, eq(merchants.id, mappingReleases.merchantId))
      .orderBy(desc(mappingReleases.publishedAt), desc(mappingReleases.releaseNumber))
      .limit(1);

    const card = (result: MetricResult, metricId: MetricId, scope: string): DashboardCard => ({ metricId, label: METRICS[metricId].label, value: formatValue(metricId, result.totals[metricId]), fraction: METRICS[metricId].kind === "ratio" ? formatFraction(result.totals[metricId]) : null, raw: result.totals[metricId]?.value ?? null, scope, spec: baseSpec(metricId) });
    const current = "Active listings in each merchant's current catalog revision";
    return {
      observedAt: totalsDraft.scope.observedAt,
      scope: totalsDraft.scope,
      cards: [
        card(totalsDraft, "listing_count", `${current}. Superseded revisions and invalid rows are excluded.`),
        card(published, "published_mapping_coverage", "Mapped in the merchant's current release ÷ all active listings. Unresolved listings stay in the denominator."),
        card(totalsDraft, "approved_draft_coverage", "Approved by a reviewer, published or not ÷ all active listings. Draft, not published."),
        card(totalsDraft, "pending_review_count", "Active listings whose state is not Approved. Can overlap with failed analyses."),
        card(totalsDraft, "ambiguous_count", "Listings with an unresolved ambiguity flag. A taxonomy question, not a provider error."),
        card(failed, "failed_analysis_count", "Listings whose latest analysis attempt failed. A provider or processing error, not ambiguity."),
      ],
      publishedWarnings: published.warnings,
      merchants: byMerchantDraft.rows.map((row) => {
        const id = row.dims.merchant!.value;
        const pub = byMerchantPublished.rows.find((r) => r.dims.merchant?.value === id);
        const scope = totalsDraft.scope.merchants.find((m) => m.merchantId === id);
        return { id, name: row.dims.merchant!.label, listings: row.values.listing_count!, draft: row.values.approved_draft_coverage!, published: pub?.values.published_mapping_coverage ?? { value: null, numerator: 0, denominator: 0 }, pending: row.values.pending_review_count!, failed: row.values.failed_analysis_count!, releaseNumber: scope?.releaseNumber ?? null, releaseSuperseded: scope?.releaseSuperseded ?? false, revisionSequence: scope?.revisionSequence ?? null };
      }),
      states: byState.rows.map((r) => ({ state: r.dims.decision_status!.value, label: r.dims.decision_status!.label, count: r.values.listing_count!.value ?? 0 })),
      activity: { window, days: activity.rows.map((r) => ({ day: r.dims.utc_day!.value, count: r.values.reviewed_listing_count!.value ?? 0 })), total: activity.totals.reviewed_listing_count?.value ?? 0, spec: activity.spec },
      publications: {
        days: publications.rows.map((r) => ({ day: r.dims.utc_day!.value, releases: r.values.releases_published_count!.value ?? 0, mappings: r.values.mappings_published_count!.value ?? 0 })),
        releases: publications.totals.releases_published_count?.value ?? 0,
        mappings: publications.totals.mappings_published_count?.value ?? 0,
      },
      latestRelease: latest ? { id: latest.id, releaseNumber: latest.releaseNumber, merchantName: latest.merchantName, publishedAt: latest.publishedAt.toISOString(), partial: latest.partial, mapped: Number((latest.counts as { mapped?: number }).mapped ?? 0) } : null,
    };
  });
}
