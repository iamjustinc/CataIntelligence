/**
 * Loads the demo scenario (PRD section 17) through the same services the application uses:
 * taxonomy import and publication, catalog imports, demo analysis, review decisions, a pending
 * proposal and mapping releases. Nothing is inserted directly, so every count on screen derives
 * from records created the way a user would create them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFixtures, catalogCsv, MERCHANTS } from "@/fixtures/generate";
import type { Actor } from "@/lib/auth/actor";
import { startAnalysis } from "@/lib/domain/analysis";
import { commitCatalogImport, stageCatalogImport } from "@/lib/domain/catalog-import";
import { createMerchant, listMerchants } from "@/lib/domain/merchants";
import { submitProposal } from "@/lib/domain/proposals";
import { previewRelease, publishRelease } from "@/lib/domain/releases";
import { listReviewItems, recordDecision, type ReviewQueueItem } from "@/lib/domain/review";
import { commitTaxonomyImport, getTaxonomyVersion, listTaxonomyVersions, publishTaxonomyVersion, stageTaxonomyImport } from "@/lib/domain/taxonomy";

const REQ = "seed-scenario";
const TAXONOMY_CSV = () => readFileSync(fileURLToPath(new URL("../fixtures/generated/taxonomy.csv", import.meta.url)), "utf8");

async function allItems(actor: Actor, merchantId: string): Promise<ReviewQueueItem[]> {
  const out: ReviewQueueItem[] = [];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof listReviewItems>> = await listReviewItems(actor, { merchantId, sort: "age", cursor, limit: 100 });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** Approves suggested listings whose position passes `keep`, so the outcome is deterministic. */
async function approveSuggested(reviewer: Actor, merchantId: string, keep: (index: number) => boolean): Promise<number> {
  const suggested = (await allItems(reviewer, merchantId)).filter((i) => i.state === "suggested");
  let n = 0;
  for (const [index, item] of suggested.entries()) {
    if (!keep(index)) continue;
    await recordDecision(reviewer, item.id, { action: "approve", expectedVersion: item.lockVersion }, REQ);
    n++;
  }
  return n;
}

async function importCatalog(reviewer: Actor, merchantId: string, content: string, fileName: string): Promise<string> {
  const staged = await stageCatalogImport(reviewer, { merchantId, fileName, content, mode: "snapshot", createNewRevision: true }, REQ);
  return (await commitCatalogImport(reviewer, staged.id, { acceptExcluded: true }, REQ)).revisionId;
}

async function publish(admin: Actor, merchantId: string, reason: string, key: string) {
  const p = await previewRelease(admin, merchantId);
  return publishRelease(admin, { merchantId, catalogRevisionId: p.catalogRevision!.id, taxonomyVersionId: p.taxonomyVersion!.id, reason, acknowledgePartial: true, expectedMapped: p.mapped, expectedUnresolved: p.unresolved }, key, REQ);
}

export interface ScenarioResult {
  taxonomyVersionId: string;
  merchants: Record<string, string>;
  revisions: Record<string, string>;
}

/** Idempotent per workspace: does nothing when the workspace already has a taxonomy version. */
export async function seedScenario(admin: Actor, reviewer: Actor): Promise<ScenarioResult | null> {
  if ((await listTaxonomyVersions(admin)).versions.length > 0) return null;
  const fx = buildFixtures();

  const stagedTaxonomy = await stageTaxonomyImport(admin, { fileName: "taxonomy.csv", content: TAXONOMY_CSV() }, REQ);
  const { versionId } = await commitTaxonomyImport(admin, stagedTaxonomy.id, { replaceDraft: false }, REQ);
  await publishTaxonomyVersion(admin, versionId, 0, REQ);

  const existing = new Map((await listMerchants(admin)).map((m) => [m.name, m.id]));
  const merchants: Record<string, string> = {};
  for (const m of MERCHANTS) merchants[m.slug] = existing.get(m.name) ?? (await createMerchant(admin, { name: m.name, externalKey: m.externalKey, region: m.region }, REQ)).id;
  const revisions: Record<string, string> = {};
  const scope = admin.workspaceId;

  // Harbor Market: two catalog revisions and three releases. Releases 2 and 3 share revision 2.
  const harbor = merchants["harbor-market"];
  revisions["harbor-r1"] = await importCatalog(reviewer, harbor, catalogCsv(fx.catalogs["harbor-market"]), "harbor-market-r1.csv");
  await startAnalysis(reviewer, { catalogRevisionId: revisions["harbor-r1"] }, REQ);
  await approveSuggested(reviewer, harbor, (i) => i % 4 !== 3);
  await publish(admin, harbor, "Initial Harbor Market release.", `${scope}:harbor:1`);
  revisions["harbor-r2"] = await importCatalog(reviewer, harbor, catalogCsv(fx.catalogs["harbor-market-r2"]), "harbor-market-r2.csv");
  await startAnalysis(reviewer, { catalogRevisionId: revisions["harbor-r2"] }, REQ);
  await publish(admin, harbor, "Catalog revision 2: carried-forward decisions only.", `${scope}:harbor:2`);
  await approveSuggested(reviewer, harbor, (i) => i % 2 === 0);
  await publish(admin, harbor, "Revision 2 after further review.", `${scope}:harbor:3`);

  // Daily Basket: one release, a deferral, a missing concept and a pending proposal.
  const daily = merchants["daily-basket"];
  revisions["daily-r1"] = await importCatalog(reviewer, daily, catalogCsv(fx.catalogs["daily-basket"]), "daily-basket-r1.csv");
  await startAnalysis(reviewer, { catalogRevisionId: revisions["daily-r1"] }, REQ);
  await approveSuggested(reviewer, daily, (i) => i % 5 < 3);
  const dailyItems = await allItems(reviewer, daily);
  const bySku = (sku: string) => dailyItems.find((i) => i.sku === sku)!;
  await recordDecision(reviewer, bySku("DB-90002").id, { action: "defer", reason: "Enhanced water or a supplement? Ask the merchant for the label.", expectedVersion: bySku("DB-90002").lockVersion }, REQ);
  await recordDecision(reviewer, bySku("DB-90008").id, { action: "no_suitable", reason: "No kombucha or fermented drink concept.", expectedVersion: bySku("DB-90008").lockVersion }, REQ);
  const tree = await getTaxonomyVersion(admin, versionId);
  const beverages = tree.concepts.find((c) => c.stableKey === "BEV")!;
  await submitProposal(reviewer, { type: "new_leaf", name: "Kombucha & Fermented Drinks", definition: "Kombucha and other fermented ready-to-drink beverages.", parentConceptId: beverages.conceptId, rationale: "Kombucha listings have no fitting leaf under Beverages.", evidenceListingIds: [bySku("DB-90008").id] }, REQ);
  await publish(admin, daily, "Initial Daily Basket release.", `${scope}:daily:1`);

  // Corner Goods: imported and partly reviewed, never published (zero published coverage).
  const corner = merchants["corner-goods"];
  revisions["corner-r1"] = await importCatalog(reviewer, corner, catalogCsv(fx.catalogs["corner-goods"]), "corner-goods-r1.csv");
  await startAnalysis(reviewer, { catalogRevisionId: revisions["corner-r1"] }, REQ);
  await approveSuggested(reviewer, corner, (i) => i % 3 === 0);

  return { taxonomyVersionId: versionId, merchants, revisions };
}
