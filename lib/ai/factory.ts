import { env } from "@/lib/env";
import { ClaudeProvider } from "./claude-adapter";
import { FixtureProvider } from "./fixture-adapter";
import type { RecommendationProvider } from "./provider";

export type ProviderResolution = { ok: true; provider: RecommendationProvider } | { ok: false; code: "provider_unavailable"; message: string };

/**
 * Builds the provider a job was created for. A live job without server credentials is
 * unavailable; it never falls back to demo fixtures (PRD 10.4, AT18).
 */
export function providerForJob(job: { providerMode: "off" | "demo" | "live"; modelId: string | null }): ProviderResolution {
  if (job.providerMode === "demo") return { ok: true, provider: new FixtureProvider() };
  if (job.providerMode === "live") {
    const key = env().ANTHROPIC_API_KEY;
    if (!key) return { ok: false, code: "provider_unavailable", message: "The server has no provider API key. Manual mapping is available." };
    if (!job.modelId) return { ok: false, code: "provider_unavailable", message: "No model ID is configured for live analysis." };
    return { ok: true, provider: new ClaudeProvider(job.modelId, { apiKey: key }) };
  }
  return { ok: false, code: "provider_unavailable", message: "AI recommendations are turned off for this workspace." };
}
