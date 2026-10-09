import { ClaudeProvider } from "./claude-adapter";
import { liveProviderForId } from "./live";
import { OpenAIProvider } from "./openai-adapter";
import { FixtureProvider } from "./fixture-adapter";
import type { RecommendationProvider } from "./provider";

export type ProviderResolution = { ok: true; provider: RecommendationProvider } | { ok: false; code: "provider_unavailable"; message: string };

/**
 * Builds the provider a job was created for. A live job without server credentials is
 * unavailable; it never falls back to demo fixtures (PRD 10.4, AT18).
 */
export function providerForJob(job: { providerMode: "off" | "demo" | "live"; modelId: string | null; provider?: string | null }): ProviderResolution {
  if (job.providerMode === "demo") return { ok: true, provider: new FixtureProvider() };
  if (job.providerMode === "live") {
    // A job keeps the provider it was created for, so a queued job is never silently answered by another one.
    const live = liveProviderForId(job.provider);
    if (!live.apiKey) return { ok: false, code: "provider_unavailable", message: `The server has no ${live.label} API key (${live.keyVariable}). Manual mapping is available.` };
    if (!job.modelId) return { ok: false, code: "provider_unavailable", message: "No model ID is configured for live analysis." };
    return { ok: true, provider: live.name === "openai" ? new OpenAIProvider(job.modelId, { apiKey: live.apiKey }) : new ClaudeProvider(job.modelId, { apiKey: live.apiKey }) };
  }
  return { ok: false, code: "provider_unavailable", message: "AI recommendations are turned off for this workspace." };
}
