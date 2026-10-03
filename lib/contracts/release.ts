import { z } from "zod";

export const previewReleaseSchema = z.strictObject({ merchantId: z.uuid() });
export const publishReleaseSchema = z.strictObject({
  merchantId: z.uuid(),
  catalogRevisionId: z.uuid(),
  taxonomyVersionId: z.uuid(),
  reason: z.string().trim().min(1, "A release reason is required.").max(1000),
  acknowledgePartial: z.boolean().default(false),
  expectedMapped: z.number().int().min(0),
  expectedUnresolved: z.number().int().min(0),
});
export const activateReleaseSchema = z.strictObject({
  expectedVersion: z.number().int().min(0),
  activateCatalogRevision: z.boolean().default(false),
  reason: z.string().trim().min(1, "A reason is required.").max(1000),
});
export const exportSchema = z.strictObject({ kind: z.enum(["zip", "mapping", "unresolved", "metadata"]).default("zip") });
