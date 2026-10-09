import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { RecommendationRequest } from "@/lib/contracts/recommendation";
import { buildUserPayload, REQUEST_TIMEOUT_MS, responseSchema, SYSTEM_PROMPT } from "./claude-adapter";
import type { ProviderFailure, ProviderResult, ProviderUsage, RecommendationProvider } from "./provider";

export const OPENAI_PROMPT_VERSION = "openai-recommend-v1";
/** Room for reasoning plus a short JSON answer; a response that hits it is a truncation failure. */
const MAX_OUTPUT_TOKENS = 8_000;

/** The part of the SDK client this adapter uses; tests supply a deterministic stand-in. */
export interface ResponsesClient {
  responses: { create(params: OpenAI.Responses.ResponseCreateParamsNonStreaming, options?: { timeout?: number; signal?: AbortSignal }): Promise<OpenAI.Responses.Response> };
}

export function classifyOpenAIError(err: unknown): ProviderFailure {
  // Most specific first. Connection errors are subclasses of APIError in the SDK.
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) return { kind: "fatal", code: "auth" };
  if (err instanceof OpenAI.NotFoundError || err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError) return { kind: "fatal", code: "configuration" };
  if (err instanceof OpenAI.RateLimitError) return { kind: "transient", code: "rate_limited" };
  if (err instanceof OpenAI.APIConnectionTimeoutError) return { kind: "transient", code: "timeout" };
  if (err instanceof OpenAI.APIConnectionError) return { kind: "transient", code: "network" };
  if (err instanceof OpenAI.APIError) return typeof err.status === "number" && err.status >= 500 ? { kind: "transient", code: "overloaded" } : { kind: "fatal", code: "configuration" };
  if (err instanceof Error && err.name === "AbortError") return { kind: "transient", code: "timeout" };
  return { kind: "transient", code: "network" };
}

/** Text and refusal from a Responses API result, without relying on SDK convenience getters. */
export function readOutput(response: OpenAI.Responses.Response): { text: string; refusal: string | null } {
  let text = "";
  let refusal: string | null = null;
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "output_text") text += part.text;
      else if (part.type === "refusal") refusal = part.refusal;
    }
  }
  return { text, refusal };
}

/**
 * Live recommendation provider backed by the OpenAI Responses API with strict structured output.
 *
 * Same boundary as the Claude adapter, and the same prompt and schema: no tools, no database
 * handle, one bounded request in, one unvalidated payload out. Concept IDs are restricted to the
 * enumerated candidates by the schema, and the caller still validates candidate membership,
 * evidence and version binding before anything is stored. The SDK's own retries are disabled so
 * the worker's bounded retry policy is the only one in effect, and responses are not stored by the
 * provider (`store: false`).
 */
export class OpenAIProvider implements RecommendationProvider {
  readonly id = "openai";
  readonly isDemo = false;
  readonly promptVersion = OPENAI_PROMPT_VERSION;
  private readonly client: ResponsesClient;

  constructor(
    readonly modelId: string,
    options: { apiKey?: string; client?: ResponsesClient } = {},
  ) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
  }

  async recommend(request: RecommendationRequest, signal?: AbortSignal): Promise<ProviderResult> {
    const started = Date.now();
    if (request.candidates.length === 0) {
      // Nothing to choose from: abstain without spending a provider call.
      return {
        ok: true,
        usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
        payload: { listingRevisionId: request.listingRevisionId, taxonomyVersionId: request.taxonomyVersionId, selectedConceptId: null, alternatives: [], evidence: [], explanation: "No candidate concept matched the listing text, so no recommendation was made.", ambiguityFlags: [], missingInformation: ["No candidate concepts were retrieved for this listing."], proposedConcept: null },
      };
    }
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create(
        {
          model: this.modelId,
          instructions: SYSTEM_PROMPT,
          input: JSON.stringify(buildUserPayload(request)),
          text: { format: zodTextFormat(responseSchema(request), "recommendation") },
          max_output_tokens: MAX_OUTPUT_TOKENS,
          store: false,
        },
        { timeout: REQUEST_TIMEOUT_MS, signal },
      );
    } catch (err) {
      return { ok: false, failure: classifyOpenAIError(err), usage: null };
    }
    const usage: ProviderUsage = { inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null, latencyMs: Date.now() - started };
    const { text, refusal } = readOutput(response);
    // A refusal or a truncated answer is a processing failure, never a rejected product (PRD TAX06).
    if (refusal !== null) return { ok: false, failure: { kind: "refusal", code: "refusal" }, usage };
    if (response.status === "incomplete") return { ok: false, failure: { kind: "truncated", code: response.incomplete_details?.reason ?? "incomplete" }, usage };
    if (response.status === "failed") return { ok: false, failure: { kind: "transient", code: "overloaded" }, usage };
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      // Left as an invalid payload so the caller's schema validation reports and counts it.
      payload = { unparseable: true };
    }
    return { ok: true, payload, usage };
  }
}
