import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { REQUEST_TIMEOUT_MS } from "@/lib/ai/claude-adapter";
import { classifyOpenAIError, readOutput, type ResponsesClient } from "@/lib/ai/openai-adapter";
import { buildPlannerPayload, PLANNER_SYSTEM_PROMPT, responseShape, toOutcome } from "./claude-planner";
import type { PlanInput, Planner, PlannerUsage, PlanOutcome } from "./planner";

export const OPENAI_PLANNER_VERSION = "openai-analytics-plan-v1";
const MAX_OUTPUT_TOKENS = 4_000;

/**
 * Live planner backed by the OpenAI Responses API with strict structured output. It shares the
 * prompt, the response shape and the validation of the Claude planner: the model returns a
 * candidate analysis and nothing else. It has no tools and no database handle, never sees or
 * produces SQL, and its answer is executed only after the server has validated it against the
 * metric registry and the workspace's own merchant and branch names.
 */
export class OpenAIPlanner implements Planner {
  readonly id = "live" as const;
  readonly provider = "openai";
  readonly promptVersion = OPENAI_PLANNER_VERSION;
  private readonly client: ResponsesClient;
  constructor(
    readonly modelId: string,
    options: { apiKey?: string; client?: ResponsesClient } = {},
  ) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
  }

  async plan(input: PlanInput): Promise<{ outcome: PlanOutcome; usage: PlannerUsage }> {
    const started = Date.now();
    const notInterpreted = (message: string): PlanOutcome => ({ kind: "not_understood", unrecognized: [], message });
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create(
        { model: this.modelId, instructions: PLANNER_SYSTEM_PROMPT, input: JSON.stringify(buildPlannerPayload(input)), text: { format: zodTextFormat(responseShape, "analysis_plan") }, max_output_tokens: MAX_OUTPUT_TOKENS, store: false },
        { timeout: REQUEST_TIMEOUT_MS },
      );
    } catch (err) {
      const failure = classifyOpenAIError(err);
      return {
        outcome: notInterpreted("The AI provider could not be reached, so this question was not interpreted. Nothing was run. You can still build the analysis with the controls below."),
        usage: { inputTokens: null, outputTokens: null, latencyMs: Date.now() - started, status: "error", errorCode: failure.code },
      };
    }
    const usage = { inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null, latencyMs: Date.now() - started };
    const { text, refusal } = readOutput(response);
    if (refusal !== null || response.status !== "completed") {
      return { outcome: notInterpreted("The model did not return an interpretation for this question. Nothing was run."), usage: { ...usage, status: "error", errorCode: refusal !== null ? "refusal" : (response.incomplete_details?.reason ?? response.status ?? "incomplete") } };
    }
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      /* reported as invalid below */
    }
    const outcome = toOutcome(payload, input);
    const invalid = outcome.kind === "not_understood";
    return { outcome, usage: { ...usage, status: invalid ? "invalid" : "ok", errorCode: invalid ? "invalid_spec" : null } };
  }
}
