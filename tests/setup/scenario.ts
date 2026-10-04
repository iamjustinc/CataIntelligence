import { readFileSync } from "node:fs";
import type pg from "pg";
import { commitCatalogImport, stageCatalogImport, updateCatalogImportMapping } from "@/lib/domain/catalog-import";
import { suggestColumnMap } from "@/lib/domain/catalog-validation";
import { parseCsv } from "@/lib/csv";
import { createMerchant } from "@/lib/domain/merchants";
import { commitTaxonomyImport, publishTaxonomyVersion, stageTaxonomyImport } from "@/lib/domain/taxonomy";
import { startAnalysis } from "@/lib/domain/analysis";
import { drainJobs, type WorkerOptions } from "@/lib/jobs/analysis-worker";
import { actorFor, type TestWorkspace } from "./helpers";

/** Worker options for tests: no real waiting between retries. */
export const FAST: Partial<WorkerOptions> = { sleep: async () => undefined, backoffMs: () => 0 };

/** Queues an analysis job and processes it with the worker engine, as the worker process would. */
export async function runAnalysis(ws: TestWorkspace, catalogRevisionId: string, overrides: Partial<WorkerOptions> = {}) {
  const job = await startAnalysis(await actorFor(ws, "taxonomist"), { catalogRevisionId }, "test");
  const outcomes = await drainJobs({ ...FAST, ...overrides });
  return { jobId: job.id, outcome: outcomes.find((o) => o.jobId === job.id)?.outcome };
}

export const FIXTURE_TAXONOMY = readFileSync(new URL("../../fixtures/generated/taxonomy.csv", import.meta.url), "utf8");

/** Imports and publishes a taxonomy CSV through the real services. Returns the version ID. */
export async function publishTaxonomy(ws: TestWorkspace, content = FIXTURE_TAXONOMY, replaceDraft = false): Promise<string> {
  const admin = await actorFor(ws, "administrator");
  const staged = await stageTaxonomyImport(admin, { fileName: "taxonomy.csv", content }, "test");
  const { versionId } = await commitTaxonomyImport(admin, staged.id, { replaceDraft }, "test");
  await publishTaxonomyVersion(admin, versionId, replaceDraft ? 1 : 0, "test");
  return versionId;
}

/** Creates a merchant and commits a catalog through the real import services. */
export async function importCatalog(
  ws: TestWorkspace,
  options: { merchantName?: string; merchantId?: string; content: string; mode?: "snapshot" | "delta"; resolutions?: Record<string, number> },
): Promise<{ merchantId: string; revisionId: string }> {
  const actor = await actorFor(ws, "taxonomist");
  const merchantId = options.merchantId ?? (await createMerchant(actor, { name: options.merchantName ?? "Test Merchant" }, "test")).id;
  const staged = await stageCatalogImport(actor, { merchantId, fileName: "catalog.csv", content: options.content, mode: options.mode ?? "snapshot", createNewRevision: true }, "test");
  if (options.resolutions) await updateCatalogImportMapping(actor, staged.id, { columnMap: suggestColumnMap(parseCsv(options.content).header), resolutions: options.resolutions });
  const { revisionId } = await commitCatalogImport(actor, staged.id, { acceptExcluded: true }, "test");
  return { merchantId, revisionId };
}

/** Listing revision IDs of a catalog revision keyed by SKU. */
export async function listingIds(admin: pg.Client, revisionId: string): Promise<Record<string, string>> {
  const { rows } = await admin.query("select l.merchant_sku as sku, lr.id from listing_revisions lr join merchant_listings l on l.id = lr.listing_id where lr.catalog_revision_id = $1", [revisionId]);
  return Object.fromEntries(rows.map((r) => [r.sku, r.id]));
}

/** Concept IDs of a workspace keyed by stable key. */
export async function conceptIds(admin: pg.Client, workspaceId: string): Promise<Record<string, string>> {
  const { rows } = await admin.query("select stable_key, id from concepts where workspace_id = $1", [workspaceId]);
  return Object.fromEntries(rows.map((r) => [r.stable_key, r.id]));
}
