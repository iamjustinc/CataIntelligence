import type { RecommendationRequest, RecommendationResponse } from "@/lib/contracts/recommendation";

/**
 * Runtime AI provider boundary (PRD 13.1). Adapters are server-only, receive bounded fields for
 * one listing plus its retrieved candidates, and return an unvalidated payload. They hold no
 * database handle and no publishing capability: the caller validates and persists.
 */
export type ProviderFailure =
  | { kind: "transient"; code: "timeout" | "rate_limited" | "overloaded" | "network" }
  | { kind: "fatal"; code: "auth" | "configuration" }
  | { kind: "refusal" | "truncated" | "no_fixture"; code: string };

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export type ProviderResult =
  | { ok: true; payload: unknown; usage: ProviderUsage }
  | { ok: false; failure: ProviderFailure; usage: ProviderUsage | null };

export interface RecommendationProvider {
  /** Stored with every recommendation, e.g. "fixture" or "claude". */
  readonly id: string;
  /** True for deterministic fixture output. Demo results are labeled everywhere they appear. */
  readonly isDemo: boolean;
  readonly modelId: string | null;
  readonly promptVersion: string;
  recommend(request: RecommendationRequest, signal?: AbortSignal): Promise<ProviderResult>;
}

export type { RecommendationRequest, RecommendationResponse };

export type ProviderMode = "off" | "demo" | "live";

export interface ProviderStatus {
  mode: ProviderMode;
  /** What the workspace can actually do right now. */
  state: "off" | "demo" | "live" | "unavailable";
  label: string;
  detail: string;
}

/**
 * Resolves the visible provider status. Live mode without credentials is reported as unavailable;
 * it never falls back to demo fixtures (PRD 10.4, AT18).
 */
export function resolveProviderStatus(
  mode: ProviderMode,
  config: { apiKey?: string; modelId?: string; providerLabel?: string },
  liveAiOptIn: boolean,
): ProviderStatus {
  if (mode === "off") {
    return { mode, state: "off", label: "AI off", detail: "Recommendations are disabled. Manual mapping is available." };
  }
  if (mode === "demo") {
    return {
      mode,
      state: "demo",
      label: "Demo AI",
      detail: "Deterministic fixture suggestions for seeded fixture data only. Not live model output.",
    };
  }
  if (!config.apiKey || !config.modelId) {
    return {
      mode,
      state: "unavailable",
      label: "AI unavailable",
      detail: `Live mode is selected but the server has no ${config.providerLabel ? `${config.providerLabel} ` : "provider "}key or model ID. Manual mapping is available.`,
    };
  }
  if (!liveAiOptIn) {
    return {
      mode,
      state: "unavailable",
      label: "AI unavailable",
      detail: "An administrator has not opted this workspace into sending catalog fields to the live provider.",
    };
  }
  return { mode, state: "live", label: "Live AI", detail: `${config.providerLabel ? `${config.providerLabel}, model` : "Model"} ${config.modelId}` };
}
