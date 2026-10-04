import { z } from "zod";

const price = z.number().min(0).max(10_000).nullable();

export const settingsSchema = z.strictObject({
  providerMode: z.enum(["off", "demo", "live"]),
  liveAiOptIn: z.boolean(),
  // Model IDs are configuration, not secrets. No default is assumed by the application.
  aiModelId: z.string().trim().regex(/^[A-Za-z0-9._:@/-]{1,100}$/, "Use the provider's model ID, for example claude-opus-5-5.").nullable(),
  inputPricePerMtok: price,
  outputPricePerMtok: price,
  jobTokenCap: z.number().int().min(1_000).max(100_000_000),
  jobSpendCapUsd: z.number().min(0).max(100_000),
  dailySpendCapUsd: z.number().min(0).max(1_000_000),
  jobItemCap: z.number().int().min(1).max(5_000),
  expectedVersion: z.number().int().min(0),
});
