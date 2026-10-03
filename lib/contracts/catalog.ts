import { z } from "zod";
import { CATALOG_FIELDS } from "@/lib/domain/catalog-validation";

export const stageCatalogImportSchema = z.strictObject({
  merchantId: z.uuid(),
  fileName: z.string().min(1).max(300),
  // 10 MB of UTF-8 text; the service enforces the byte limit precisely.
  content: z.string().max(10 * 1024 * 1024 + 1024),
  mode: z.enum(["snapshot", "delta"]).default("snapshot"),
  createNewRevision: z.boolean().default(false),
});

const columnMapSchema = z.strictObject(Object.fromEntries(CATALOG_FIELDS.map((f) => [f, z.string().min(1).max(200).optional()])) as Record<(typeof CATALOG_FIELDS)[number], z.ZodOptional<z.ZodString>>);

export const catalogMappingSchema = z.strictObject({
  columnMap: columnMapSchema,
  resolutions: z.record(z.string().min(1).max(200), z.number().int().min(2)).default({}),
});
export const commitCatalogImportSchema = z.strictObject({ acceptExcluded: z.boolean().default(false) });
