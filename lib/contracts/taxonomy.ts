import { z } from "zod";

export const stageTaxonomyImportSchema = z.strictObject({
  fileName: z.string().min(1).max(300),
  // 2 MB of UTF-8 text; the service enforces the byte limit precisely.
  content: z.string().max(2 * 1024 * 1024 + 1024),
});
export const commitTaxonomyImportSchema = z.strictObject({ replaceDraft: z.boolean().default(false) });
export const versionActionSchema = z.strictObject({ expectedVersion: z.number().int().min(0) });

const text = (max: number) => z.string().trim().min(1).max(max);
const evidence = z.array(z.uuid()).max(50).default([]);
export const proposalSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("new_leaf"), name: text(120), definition: text(800), parentConceptId: z.uuid(), rationale: text(1000), evidenceListingIds: evidence }),
  z.strictObject({ type: z.literal("synonym"), conceptId: z.uuid(), synonym: text(120), locale: z.string().trim().min(2).max(12).optional(), rationale: text(1000), evidenceListingIds: evidence }),
]);
export const proposalDecisionSchema = z.strictObject({
  decision: z.enum(["approve", "modify", "reject"]),
  reason: z.string().trim().max(1000).nullish(),
  expectedVersion: z.number().int().min(0),
  modifications: z.strictObject({ name: text(120).optional(), definition: text(800).optional(), parentConceptId: z.uuid().optional(), synonym: text(120).optional() }).optional(),
});
export const emptySchema = z.strictObject({});
