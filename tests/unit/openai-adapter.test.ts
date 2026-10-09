import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { buildFixtures } from "@/fixtures/generate";
import { SYSTEM_PROMPT } from "@/lib/ai/claude-adapter";
import { providerForJob } from "@/lib/ai/factory";
import { fieldsFromFixtureRow } from "@/lib/ai/fixture-adapter";
import { OpenAIProvider, OPENAI_PROMPT_VERSION, type ResponsesClient } from "@/lib/ai/openai-adapter";
import { validateRecommendation } from "@/lib/ai/validate-recommendation";
import { PLANNER_SYSTEM_PROMPT } from "@/lib/analytics/claude-planner";
import { OpenAIPlanner } from "@/lib/analytics/openai-planner";
import type { PlanInput } from "@/lib/analytics/planner";
import type { RecommendationRequest } from "@/lib/contracts/recommendation";
import { classificationHash } from "@/lib/domain/catalog-validation";
import { retrieveCandidates, type RetrievalConcept } from "@/lib/retrieval/candidates";

/** Every test here uses a deterministic stand-in for the SDK client. No provider call is made. */
const fx = buildFixtures();
const keys = fx.concepts.map((c) => c.key);
const uuidOf = (k: string) => `00000000-0000-4000-8000-${String(keys.indexOf(k)).padStart(12, "0")}`;
const pathOf = (k: string): string => {
  const c = fx.concepts.find((x) => x.key === k)!;
  return c.parentKey ? `${pathOf(c.parentKey)} > ${c.name}` : c.name;
};
const leaves: RetrievalConcept[] = fx.concepts.filter((c) => c.products.length).map((c) => ({ conceptId: uuidOf(c.key), stableKey: c.key, parentConceptId: uuidOf(c.parentKey!), name: c.name, definition: c.definition, synonyms: c.synonyms, path: pathOf(c.key) }));
const fields = fieldsFromFixtureRow(fx.catalogs["harbor-market"].find((r) => r.sku === "HM-10001")!);
const product = { title: fields.title, description: fields.description, merchantCategoryPath: fields.merchantCategoryPath, brand: fields.brand, packageSize: fields.packageSize, gtin: fields.gtin };
const req: RecommendationRequest = { workspaceId: "workspace-must-not-be-sent", listingRevisionId: "11111111-1111-4111-8111-111111111111", taxonomyVersionId: "22222222-2222-4222-8222-222222222222", contentHash: classificationHash(fields), product, truncatedFields: [], candidates: retrieveCandidates(leaves, product), branches: [{ conceptId: uuidOf("GRO"), stableKey: "GRO", path: "All Products > Grocery" }] };
const answer = { listingRevisionId: req.listingRevisionId, taxonomyVersionId: req.taxonomyVersionId, selectedConceptId: req.candidates[0].conceptId, alternatives: [], evidence: [{ field: "title", excerpt: req.product.title.split(" ")[0], supportsConceptId: req.candidates[0].conceptId }], explanation: "The title names the product type.", ambiguityFlags: [], missingInformation: [], proposedConcept: null };

type Create = OpenAI.Responses.ResponseCreateParamsNonStreaming;
function response(body: unknown, overrides: Record<string, unknown> = {}): OpenAI.Responses.Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { id: "resp_test", object: "response", status: "completed", incomplete_details: null, output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 850, output_tokens: 140, total_tokens: 990 }, ...overrides } as unknown as OpenAI.Responses.Response;
}
function fake(respond: (params: Create) => OpenAI.Responses.Response | Promise<OpenAI.Responses.Response>) {
  const calls: { params: Create; options?: { timeout?: number } }[] = [];
  const client: ResponsesClient = { responses: { create: async (params, options) => (calls.push({ params, options }), respond(params)) } };
  return { client, calls };
}
const apiError = (Cls: unknown, status: number) => new (Cls as new (s: number, e: unknown, m: string, h: Headers) => Error)(status, { type: "error" }, "test", new Headers());

describe("OpenAI recommendation adapter", () => {
  it("sends one bounded request: configured model, shared prompt, strict schema, no tools, nothing stored", async () => {
    const { client, calls } = fake(() => response(answer));
    const provider = new OpenAIProvider("configured-model-id", { client });
    const result = await provider.recommend(req);
    expect(result).toMatchObject({ ok: true, usage: { inputTokens: 850, outputTokens: 140 } });
    expect(provider).toMatchObject({ id: "openai", isDemo: false, promptVersion: OPENAI_PROMPT_VERSION });
    const { params, options } = calls[0];
    expect(params.model).toBe("configured-model-id");
    expect(params.instructions).toBe(SYSTEM_PROMPT);
    expect(params.store).toBe(false);
    expect(params.tools).toBeUndefined();
    expect(options?.timeout).toBe(45_000);
    const format = params.text!.format as { type: string; strict?: boolean; name: string; schema: Record<string, unknown> };
    expect(format).toMatchObject({ type: "json_schema", strict: true, name: "recommendation" });
    // The model can only name a candidate that was retrieved for this listing.
    const schema = JSON.stringify(format.schema);
    for (const c of req.candidates) expect(schema).toContain(c.conceptId);
    expect(schema).not.toContain(uuidOf(leaves.find((l) => !req.candidates.some((c) => c.conceptId === l.conceptId))!.stableKey));
    const sent = JSON.parse(params.input as string);
    expect(Object.keys(sent).sort()).toEqual(["branches", "candidates", "listingRevisionId", "product", "taxonomyVersionId", "truncatedFields"]);
    expect(params.input as string).not.toContain("workspace-must-not-be-sent");
  });

  it("returns a payload the server validation accepts, and one it rejects when the model names another concept", async () => {
    const ok = await new OpenAIProvider("m", { client: fake(() => response(answer)).client }).recommend(req);
    expect(ok.ok && validateRecommendation(req, ok.payload).ok).toBe(true);
    const foreign = await new OpenAIProvider("m", { client: fake(() => response({ ...answer, selectedConceptId: "99999999-9999-4999-8999-999999999999" })).client }).recommend(req);
    expect(foreign.ok && validateRecommendation(req, foreign.payload).ok).toBe(false);
  });

  it("makes no call when there is nothing to choose from", async () => {
    const { client, calls } = fake(() => response(answer));
    const result = await new OpenAIProvider("m", { client }).recommend({ ...req, candidates: [] });
    expect(result).toMatchObject({ ok: true, payload: { selectedConceptId: null }, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(calls).toHaveLength(0);
  });

  it("reports refusals, truncation and unparseable output as failures, never as a decision", async () => {
    const run = (r: OpenAI.Responses.Response) => new OpenAIProvider("m", { client: fake(() => r).client }).recommend(req);
    const refusal = response("", { output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I can't help with that." }] }] });
    expect(await run(refusal)).toMatchObject({ ok: false, failure: { kind: "refusal" }, usage: { inputTokens: 850 } });
    expect(await run(response('{"listingRev', { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))).toMatchObject({ ok: false, failure: { kind: "truncated", code: "max_output_tokens" } });
    const garbage = await run(response("not json"));
    expect(garbage).toMatchObject({ ok: true, payload: { unparseable: true } });
    expect(garbage.ok && validateRecommendation(req, garbage.payload).ok).toBe(false);
  });

  it.each([
    [OpenAI.AuthenticationError, 401, "fatal", "auth"],
    [OpenAI.PermissionDeniedError, 403, "fatal", "auth"],
    [OpenAI.NotFoundError, 404, "fatal", "configuration"],
    [OpenAI.BadRequestError, 400, "fatal", "configuration"],
    [OpenAI.RateLimitError, 429, "transient", "rate_limited"],
    [OpenAI.InternalServerError, 500, "transient", "overloaded"],
  ])("classifies %o (%i) as %s/%s", async (Cls, status, kind, code) => {
    const result = await new OpenAIProvider("m", { client: fake(() => Promise.reject(apiError(Cls, status))).client }).recommend(req);
    expect(result).toEqual({ ok: false, failure: { kind, code }, usage: null });
  });
  it("classifies connection problems as transient", async () => {
    const timeout = await new OpenAIProvider("m", { client: fake(() => Promise.reject(new OpenAI.APIConnectionTimeoutError())).client }).recommend(req);
    expect(timeout).toMatchObject({ ok: false, failure: { kind: "transient", code: "timeout" } });
    const network = await new OpenAIProvider("m", { client: fake(() => Promise.reject(new OpenAI.APIConnectionError({ message: "reset" }))).client }).recommend(req);
    expect(network).toMatchObject({ ok: false, failure: { kind: "transient", code: "network" } });
  });
});

describe("provider selection", () => {
  const withEnv = async (vars: Record<string, string>, fn: () => void | Promise<void>) => {
    const { vi } = await import("vitest");
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
    vi.resetModules();
    try {
      await fn();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  };
  it("uses OpenAI when its key is set, keeps a job on the provider it was created for, and never substitutes the other", async () => {
    await withEnv({ OPENAI_API_KEY: "sk-test-placeholder", ANTHROPIC_API_KEY: "" }, async () => {
      const { providerForJob: resolve } = await import("@/lib/ai/factory");
      const { liveProvider } = await import("@/lib/ai/live");
      expect(liveProvider()).toMatchObject({ id: "openai", label: "OpenAI", keyVariable: "OPENAI_API_KEY" });
      const openai = resolve({ providerMode: "live", modelId: "some-model" });
      expect(openai.ok && openai.provider.id).toBe("openai");
      // A job queued for Claude is not quietly answered by OpenAI.
      const claudeJob = resolve({ providerMode: "live", modelId: "some-model", provider: "claude" });
      expect(claudeJob).toMatchObject({ ok: false, code: "provider_unavailable" });
      expect(!claudeJob.ok && claudeJob.message).toMatch(/ANTHROPIC_API_KEY/);
      expect(resolve({ providerMode: "live", modelId: null })).toMatchObject({ ok: false, code: "provider_unavailable" });
    });
  });
  it("with no key, live mode is unavailable and names the missing variable; demo mode is unaffected", () => {
    const live = providerForJob({ providerMode: "live", modelId: "some-model" });
    expect(live).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect(!live.ok && live.message).toMatch(/OPENAI_API_KEY/);
    const demo = providerForJob({ providerMode: "demo", modelId: null });
    expect(demo.ok && demo.provider.isDemo).toBe(true);
  });
});

describe("OpenAI analytics planner", () => {
  const vocabulary = { timezone: "UTC", merchants: [{ id: "11111111-1111-4111-8111-111111111111", name: "Harbor Market" }], branches: [{ key: "GRO", name: "Grocery" }] };
  const input: PlanInput = { question: "Which merchant is furthest behind on published mappings?", previousSpec: null, vocabulary, now: new Date("2026-10-14T12:00:00.000Z") };
  const spec = { metricIds: ["published_mapping_coverage"], groupBy: ["merchant"], filters: [], timeRange: null, mappingState: "published", sortField: "published_mapping_coverage", sortDirection: "asc", limit: 20, chartType: "bar" };

  it("sends the question as data with the registry prompt and a strict schema, and returns a validated spec", async () => {
    const { client, calls } = fake(() => response({ outcome: "spec", message: "", clarificationOptions: [], spec }));
    const planner = new OpenAIPlanner("configured-model", { client });
    const { outcome, usage } = await planner.plan(input);
    expect(planner).toMatchObject({ id: "live", provider: "openai" });
    expect(outcome).toMatchObject({ kind: "spec", spec: { metricIds: ["published_mapping_coverage"], groupBy: ["merchant"] } });
    expect(usage).toMatchObject({ inputTokens: 850, outputTokens: 140, status: "ok", errorCode: null });
    const { params } = calls[0];
    expect(params).toMatchObject({ model: "configured-model", instructions: PLANNER_SYSTEM_PROMPT, store: false });
    expect(params.tools).toBeUndefined();
    expect(params.text!.format).toMatchObject({ type: "json_schema", strict: true, name: "analysis_plan" });
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/never write SQL/);
    expect(params.input as string).not.toMatch(/workspaceId|workspace_id/);
  });

  it("does not turn an unregistered metric, an unknown merchant or SQL into a spec", async () => {
    for (const bad of [{ ...spec, metricIds: ["revenue"] }, { ...spec, filters: [{ dimension: "merchant", values: ["99999999-9999-4999-8999-999999999999"] }] }, { ...spec, filters: [{ dimension: "decision_status", values: ["approved'; drop table merchants; --"] }] }]) {
      const { outcome, usage } = await new OpenAIPlanner("m", { client: fake(() => response({ outcome: "spec", message: "", clarificationOptions: [], spec: bad })).client }).plan(input);
      expect(outcome.kind).toBe("not_understood");
      expect(usage).toMatchObject({ status: "invalid", errorCode: "invalid_spec" });
    }
  });

  it("reports provider failures, refusals and truncation as not interpreted", async () => {
    const failed = await new OpenAIPlanner("m", { client: fake(() => Promise.reject(apiError(OpenAI.RateLimitError, 429))).client }).plan(input);
    expect(failed).toMatchObject({ outcome: { kind: "not_understood" }, usage: { status: "error", errorCode: "rate_limited", inputTokens: null } });
    const cut = await new OpenAIPlanner("m", { client: fake(() => response("{", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).client }).plan(input);
    expect(cut).toMatchObject({ outcome: { kind: "not_understood" }, usage: { status: "error", errorCode: "max_output_tokens" } });
  });
});
