import { z } from "zod";

export const stageTaxonomyImportSchema = z.strictObject({
  fileName: z.string().min(1).max(300),
  // 2 MB of UTF-8 text; the service enforces the byte limit precisely.
  content: z.string().max(2 * 1024 * 1024 + 1024),
});
export const commitTaxonomyImportSchema = z.strictObject({ replaceDraft: z.boolean().default(false) });
export const versionActionSchema = z.strictObject({ expectedVersion: z.number().int().min(0) });
