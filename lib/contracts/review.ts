import { z } from "zod";

export const decisionSchema = z.strictObject({
  action: z.enum(["approve", "change", "reject", "defer", "no_suitable"]),
  selectedConceptId: z.uuid().nullish(),
  reason: z.string().trim().max(1000).nullish(),
  expectedVersion: z.number().int().min(0),
  durationSeconds: z.number().min(0).max(86400).nullish(),
});
export const bulkApproveSchema = z.strictObject({
  items: z.array(z.strictObject({ listingRevisionId: z.uuid(), expectedVersion: z.number().int().min(0) })).min(1).max(100),
});
export const startAnalysisSchema = z.strictObject({ catalogRevisionId: z.uuid() });
