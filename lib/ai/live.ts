import { env } from "@/lib/env";

/**
 * Which live provider this server uses. The choice is server configuration, not workspace data:
 * AI_PROVIDER when set, otherwise whichever provider has a key, otherwise OpenAI. Stored records
 * keep the provider that actually produced them ("openai", "claude" or "fixture"), so changing
 * this never rewrites history.
 */
export const LIVE_PROVIDERS = {
  openai: { id: "openai", label: "OpenAI", keyVariable: "OPENAI_API_KEY" },
  anthropic: { id: "claude", label: "Anthropic Claude", keyVariable: "ANTHROPIC_API_KEY" },
} as const;
export type LiveProviderName = keyof typeof LIVE_PROVIDERS;
/** Provider IDs that mean "a live model answered", as stored on recommendations and usage rows. */
export const LIVE_PROVIDER_IDS: readonly string[] = ["openai", "claude"];

export function liveProviderName(): LiveProviderName {
  const config = env();
  if (config.AI_PROVIDER) return config.AI_PROVIDER;
  if (config.OPENAI_API_KEY) return "openai";
  if (config.ANTHROPIC_API_KEY) return "anthropic";
  return "openai";
}

export function liveProvider(name: LiveProviderName = liveProviderName()) {
  const config = env();
  return { name, ...LIVE_PROVIDERS[name], apiKey: name === "openai" ? config.OPENAI_API_KEY : config.ANTHROPIC_API_KEY };
}

/** The live provider a stored job was created for, falling back to the server's current choice. */
export function liveProviderForId(id: string | null | undefined) {
  return id === "claude" ? liveProvider("anthropic") : id === "openai" ? liveProvider("openai") : liveProvider();
}
