import { inflateRawSync } from "node:zlib";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as auditRoute } from "@/app/api/audit/route";
import { GET as downloadRoute } from "@/app/api/exports/[id]/route";
import { POST as activateRoute } from "@/app/api/releases/[id]/activate/route";
import { POST as exportRoute } from "@/app/api/releases/[id]/exports/route";
import { POST as previewRoute } from "@/app/api/releases/preview/route";
import { GET as releasesRoute, POST as publishRoute } from "@/app/api/releases/route";
import { POST as decisionRoute } from "@/app/api/review-items/[id]/decisions/route";
import { GET as itemRoute } from "@/app/api/review-items/[id]/route";
import { POST as proposalDecisionRoute } from "@/app/api/taxonomy/proposals/[id]/decision/route";
import { GET as proposalsRoute, POST as proposalRoute } from "@/app/api/taxonomy/proposals/route";
import { POST as revalidateRoute } from "@/app/api/taxonomy/revalidate/route";
import { POST as publishTaxonomyRoute } from "@/app/api/taxonomy/versions/[id]/publish/route";
import { closeDb } from "@/db/client";
import { WALKTHROUGH_CSV } from "@/fixtures/generate";
import { startAnalysis } from "@/lib/domain/analysis";
import { publishRelease } from "@/lib/domain/releases";
import { recordDecision } from "@/lib/domain/review";
import { actorFor, adminClient, createTestWorkspace, ctx, idemKey, request, type TestWorkspace } from "../setup/helpers";
import { conceptIds, importCatalog, listingIds, publishTaxonomy } from "../setup/scenario";

let admin: pg.Client;
let ws: TestWorkspace;
let other: TestWorkspace;
let v1: string;
let merchantId: string;
let revisionId: string;
let L: Record<string, string>;
let C: Record<string, string>;

type Role = keyof TestWorkspace["cookie"];
const post = (handler: (req: Request, c?: never) => Promise<Response>, path: string, body: unknown, role: Role = "administrator", w = ws, key = idemKey("rel")) =>
  handler(request(path, { method: "POST", cookie: w.cookie[role], body, headers: { "idempotency-key": key } }));
const postId = (handler: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>, path: string, id: string, body: unknown, role: Role = "administrator", w = ws) =>
  handler(request(path, { method: "POST", cookie: w.cookie[role], body, headers: { "idempotency-key": idemKey("rel") } }), ctx(id));
const preview = async () => (await (await post(previewRoute, "/api/releases/preview", { merchantId })).json()).data;
const stateOf = async (listing: string) => (await admin.query("select state, lock_version, taxonomy_version_id from review_states where listing_revision_id = $1", [listing])).rows[0];
const count = async (sql: string, params: unknown[]) => (await admin.query(`select count(*)::int as n from ${sql}`, params)).rows[0].n as number;
const download = async (releaseId: string, kind: string, role: Role = "viewer") => {
  const created = await (await postId(exportRoute, `/api/releases/${releaseId}/exports`, releaseId, { kind }, role)).json();
  const res = await downloadRoute(request(created.data.downloadUrl, { cookie: ws.cookie[role] }), ctx(created.data.exportId));
  return { created: created.data, res, bytes: Buffer.from(await res.arrayBuffer()) };
};
/** Reads the stored entries of a ZIP produced by lib/export/zip.ts. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString("utf8");
    out[name] = inflateRawSync(buf.subarray(o + 30 + nameLen, o + 30 + nameLen + size)).toString("utf8");
    o += 30 + nameLen + size;
  }
  return out;
}

beforeAll(async () => {
  admin = await adminClient();
  ws = await createTestWorkspace(admin, "release");
  other = await createTestWorkspace(admin, "release-other");
  v1 = await publishTaxonomy(ws);
  ({ merchantId, revisionId } = await importCatalog(ws, { merchantName: "Pier Pantry", content: WALKTHROUGH_CSV, resolutions: { "PP-004": 5 } }));
  L = await listingIds(admin, revisionId);
  C = await conceptIds(admin, ws.id);
  const reviewer = await actorFor(ws, "taxonomist");
  await startAnalysis(reviewer, { catalogRevisionId: revisionId }, "test");
  for (const sku of ["PP-001", "PP-002", "PP-003", "PP-004", "PP-011"]) await recordDecision(reviewer, L[sku], { action: "approve", expectedVersion: 1 }, "test");
  await recordDecision(reviewer, L["PP-005"], { action: "change", selectedConceptId: C["PC-HAIR-SHAMPOO"], reason: "Title says shampoo.", expectedVersion: 1 }, "test");
  await recordDecision(reviewer, L["PP-006"], { action: "defer", reason: "Ask the merchant.", expectedVersion: 1 }, "test");
  await recordDecision(reviewer, L["PP-007"], { action: "no_suitable", expectedVersion: 1 }, "test");
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

let kombuchaProposal: string;
let fetaProposal: string;
let draftId: string;

describe("taxonomy proposals (TAX10, AT11)", () => {
  const propose = (body: unknown, role: Role = "taxonomist") => post(proposalRoute, "/api/taxonomy/proposals", body, role);
  it("accepts new-leaf and synonym proposals from taxonomists with duplicate and structural checks", async () => {
    const leaf = { type: "new_leaf", name: "Kombucha & Fermented Drinks", definition: "Fermented tea beverages.", parentConceptId: C["BEV"], rationale: "Listings have no fitting leaf.", evidenceListingIds: [L["PP-007"]] };
    expect((await propose(leaf, "viewer")).status).toBe(403);
    const created = await (await propose(leaf)).json();
    kombuchaProposal = created.data.id;
    expect(created.data).toMatchObject({ state: "submitted", payload: { parentPath: "All Products > Beverages", overlaps: [] } });
    const underLeaf = await propose({ ...leaf, parentConceptId: C["BEV-HOT-TEA"] });
    expect(underLeaf.status).toBe(422);
    expect((await underLeaf.json()).error.message).toMatch(/accepts product mappings/);
    expect((await propose({ ...leaf, name: "Water", parentConceptId: C["BEV"] })).status).toBe(422);
    expect((await propose({ ...leaf, evidenceListingIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"] })).status).toBe(422);

    const feta = await (await propose({ type: "synonym", conceptId: C["GRO-DAI-CHEESE"], synonym: "Feta", rationale: "Feta listings find no candidate.", evidenceListingIds: [] })).json();
    fetaProposal = feta.data.id;
    expect(feta.data.payload).toMatchObject({ synonym: "Feta", locale: "en", ambiguousWith: [] });
    expect((await propose({ type: "synonym", conceptId: C["GRO-DAI-CHEESE"], synonym: "CHEDDAR", rationale: "dup", evidenceListingIds: [] })).status).toBe(422);
    const ambiguous = await (await propose({ type: "synonym", conceptId: C["GRO-DAI-PLANT"], synonym: "almonds", rationale: "test", evidenceListingIds: [] })).json();
    expect(ambiguous.data.payload.ambiguousWith).toEqual(["All Products > Grocery > Pantry > Nuts & Dried Fruit"]);
  });
  it("lets only administrators decide, requires explanations, and changes only the draft", async () => {
    const decide = (id: string, body: unknown, role: Role = "administrator") => postId(proposalDecisionRoute, `/api/taxonomy/proposals/${id}/decision`, id, body, role);
    expect((await decide(kombuchaProposal, { decision: "approve", expectedVersion: 0 }, "taxonomist")).status).toBe(403);
    expect((await decide(kombuchaProposal, { decision: "reject", expectedVersion: 0 })).status).toBe(422);
    expect((await decide(kombuchaProposal, { decision: "approve", expectedVersion: 5 })).status).toBe(409);

    const approved = await (await decide(kombuchaProposal, { decision: "modify", reason: "Shorter name.", modifications: { name: "Kombucha" }, expectedVersion: 0 })).json();
    expect(approved.data).toMatchObject({ state: "modified", draftSequence: 2 });
    draftId = approved.data.draftVersionId;
    const synonym = await (await decide(fetaProposal, { decision: "approve", expectedVersion: 0 })).json();
    expect(synonym.data.draftVersionId).toBe(draftId);
    expect((await decide(fetaProposal, { decision: "approve", expectedVersion: 1 })).status).toBe(409);

    // The live tree is untouched until the draft is published.
    const active = (await admin.query("select active_taxonomy_version_id as id from workspaces where id = $1", [ws.id])).rows[0].id;
    expect(active).toBe(v1);
    expect(await count("concept_revisions where taxonomy_version_id = $1", [v1])).toBe(153);
    expect(await count("concept_revisions where taxonomy_version_id = $1", [draftId])).toBe(154);
    const live = (await admin.query("select synonyms from concept_revisions where taxonomy_version_id = $1 and concept_id = $2", [v1, C["GRO-DAI-CHEESE"]])).rows[0].synonyms;
    const drafted = (await admin.query("select synonyms from concept_revisions where taxonomy_version_id = $1 and concept_id = $2", [draftId, C["GRO-DAI-CHEESE"]])).rows[0].synonyms;
    expect(live).not.toContain("Feta");
    expect(drafted).toContain("Feta");
    const leaf = (await admin.query("select path, mapping_allowed, depth from concept_revisions where taxonomy_version_id = $1 and name = 'Kombucha'", [draftId])).rows[0];
    expect(leaf).toEqual({ path: "All Products > Beverages > Kombucha", mapping_allowed: true, depth: 3 });
    const list = await (await proposalsRoute(request("/api/taxonomy/proposals", { cookie: ws.cookie.taxonomist }))).json();
    expect(list.data.map((p: { state: string }) => p.state).sort()).toEqual(["approved", "modified", "submitted"]);
    expect((await proposalsRoute(request("/api/taxonomy/proposals", { cookie: ws.cookie.viewer }))).status).toBe(403);
    expect((await (await proposalsRoute(request("/api/taxonomy/proposals", { cookie: other.cookie.administrator }))).json()).data).toEqual([]);
  });
});

let release1: string;
let firstExport: Buffer;

describe("mapping release publication (TAX12, AT13, AT14)", () => {
  it("previews exactly what would be published, for administrators only", async () => {
    expect((await post(previewRoute, "/api/releases/preview", { merchantId }, "taxonomist")).status).toBe(403);
    expect((await post(previewRoute, "/api/releases/preview", { merchantId }, "administrator", other)).status).toBe(404);
    const p = await preview();
    expect(p).toMatchObject({ activeListings: 9, mapped: 6, unresolved: 3, partial: true, blockers: [], currentRelease: null, changes: { added: 6, changed: 0, removed: 0 } });
    expect(p.unresolvedByState).toEqual({ deferred: 1, no_suitable_category: 1, suggested: 1 });
  });
  const body = (extra: Record<string, unknown> = {}) => ({ merchantId, catalogRevisionId: revisionId, taxonomyVersionId: v1, reason: "First release for Pier Pantry.", acknowledgePartial: true, expectedMapped: 6, expectedUnresolved: 3, ...extra });
  it("blocks a missing reason, an unacknowledged partial release and counts that changed since the preview", async () => {
    expect((await post(publishRoute, "/api/releases", body({ reason: "  " }))).status).toBe(400);
    const partial = await post(publishRoute, "/api/releases", body({ acknowledgePartial: false }));
    expect(partial.status).toBe(422);
    expect((await partial.json()).error.message).toMatch(/3 listings are unresolved/);
    const drift = await post(publishRoute, "/api/releases", body({ expectedMapped: 7, expectedUnresolved: 2 }));
    expect(drift.status).toBe(409);
    expect((await drift.json()).error.current).toEqual({ mapped: 6, unresolved: 3 });
    expect((await post(publishRoute, "/api/releases", body(), "taxonomist")).status).toBe(403);
    expect(await count("mapping_releases where workspace_id = $1", [ws.id])).toBe(0);
  });
  it("leaves no partial release and no pointer when the transaction fails mid-write", async () => {
    const actor = await actorFor(ws, "administrator");
    await expect(
      publishRelease(actor, body() as never, "failpoint-key-0001", "test", {
        beforePointer: () => {
          throw new Error("simulated failure after mappings were written");
        },
      }),
    ).rejects.toThrow(/simulated failure/);
    expect(await count("mapping_releases where workspace_id = $1", [ws.id])).toBe(0);
    expect(await count("published_mappings where workspace_id = $1", [ws.id])).toBe(0);
    expect(await count("release_unresolved where workspace_id = $1", [ws.id])).toBe(0);
    expect(await count("current_releases where workspace_id = $1", [ws.id])).toBe(0);
    expect(await count("audit_events where workspace_id = $1 and action = 'release.publish'", [ws.id])).toBe(0);
  });
  it("publishes atomically, returns the same release for a repeated key, and keeps unresolved rows in the denominator", async () => {
    const key = idemKey("publish");
    const first = await post(publishRoute, "/api/releases", body(), "administrator", ws, key);
    const again = await post(publishRoute, "/api/releases", body(), "administrator", ws, key);
    expect(first.status).toBe(201);
    const a = (await first.json()).data;
    const b = (await again.json()).data;
    release1 = a.releaseId;
    expect(a).toMatchObject({ releaseNumber: 1, partial: true, counts: { activeListings: 9, mapped: 6, unresolved: 3 } });
    expect(b.releaseId).toBe(release1);
    // The key is stored on the release itself, so even a direct service retry returns it.
    const direct = await publishRelease(await actorFor(ws, "administrator"), body() as never, key, "test");
    expect(direct).toMatchObject({ releaseId: release1, replayed: true });
    expect(await count("mapping_releases where workspace_id = $1", [ws.id])).toBe(1);
    expect(await count("published_mappings where release_id = $1", [release1])).toBe(6);
    expect(await count("release_unresolved where release_id = $1", [release1])).toBe(3);
    const pointer = (await admin.query("select release_id, catalog_revision_id from current_releases where merchant_id = $1", [merchantId])).rows[0];
    expect(pointer).toEqual({ release_id: release1, catalog_revision_id: revisionId });
    expect(await count("audit_events where action = 'release.publish' and entity_id = $1", [release1])).toBe(1);
    await expect(admin.query("delete from published_mappings where release_id = $1", [release1])).rejects.toThrow(/append-only/);
    await expect(admin.query("update mapping_releases set reason = 'x' where id = $1", [release1])).rejects.toThrow(/append-only/);
    // Nothing unresolved was silently published.
    const leaked = await count("published_mappings pm join review_states rs on rs.listing_revision_id = pm.listing_revision_id where pm.release_id = $1 and rs.state <> 'approved'", [release1]);
    expect(leaked).toBe(0);
  });
});

describe("exports (TAX13, AT25)", () => {
  it("exports one release as CSVs, metadata and a ZIP whose counts reconcile with the release", async () => {
    const { created, res, bytes } = await download(release1, "zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="release-1.zip"');
    expect(created.rowCounts).toEqual({ mappings: 6, unresolved: 3 });
    const files = unzip(bytes);
    expect(Object.keys(files)).toEqual(["mappings.csv", "unresolved.csv", "release.json"]);
    const mappingLines = files["mappings.csv"].trim().split("\r\n");
    expect(mappingLines[0]).toBe("merchant,catalog_revision,merchant_sku,title,canonical_id,canonical_path,taxonomy_version,mapping_release,decision_origin,reviewer,decision_timestamp");
    expect(mappingLines).toHaveLength(7);
    expect(files["unresolved.csv"].trim().split("\r\n")).toHaveLength(4);
    expect(files["unresolved.csv"]).toContain("PP-006,Apple,Deferred,Deferred: Ask the merchant.");
    const meta = JSON.parse(files["release.json"]);
    expect(meta).toMatchObject({ release: { number: 1, partial: true }, counts: { activeListings: 9, mapped: 6, unresolved: 3 }, files: { "mappings.csv": { rows: 6 }, "unresolved.csv": { rows: 3 } } });
    expect(meta.catalogRevision.id).toBe(revisionId);
    expect(meta.taxonomyVersion.id).toBe(v1);
    const shampoo = mappingLines.find((l) => l.includes("PP-005"))!;
    expect(shampoo).toContain("PC-HAIR-SHAMPOO");
    expect(shampoo).toContain(",manual,");
    firstExport = (await download(release1, "mapping")).bytes;
    expect(firstExport.toString("utf8")).toBe(files["mappings.csv"]);
  });
  it("neutralizes formula-leading cells in the download while the database keeps the raw value", async () => {
    const csv = firstExport.toString("utf8");
    expect(csv).toContain(",'=SUM(A1:A9) Paper Towels,");
    expect(csv).not.toMatch(/,=SUM/);
    const raw = (await admin.query("select title from listing_revisions where id = $1", [L["PP-011"]])).rows[0].title;
    expect(raw).toBe("=SUM(A1:A9) Paper Towels");
  });
  it("audits every export and denies other workspaces", async () => {
    expect(await count("audit_events where action = 'release.export' and entity_id = $1", [release1])).toBe(2);
    expect((await postId(exportRoute, `/api/releases/${release1}/exports`, release1, { kind: "zip" }, "viewer", other)).status).toBe(404);
    const created = await (await postId(exportRoute, `/api/releases/${release1}/exports`, release1, { kind: "metadata" })).json();
    expect((await downloadRoute(request(created.data.downloadUrl, { cookie: other.cookie.administrator }), ctx(created.data.exportId))).status).toBe(404);
    expect((await downloadRoute(request(created.data.downloadUrl), ctx(created.data.exportId))).status).toBe(401);
  });
});

let v2: string;
let kombuchaId: string;

describe("taxonomy change, stale dependencies and revalidation (TAX11, AT12)", () => {
  it("marks suggestions and approvals stale when a new taxonomy version is published, and blocks publication", async () => {
    // Also change the definition of a concept that an approved mapping targets.
    await admin.query("update concept_revisions set definition = 'Paper towels only.' where taxonomy_version_id = $1 and concept_id = $2", [draftId, C["HOU-PAPER-TOWEL"]]);
    const lock = (await admin.query("select lock_version from taxonomy_versions where id = $1", [draftId])).rows[0].lock_version;
    const res = await postId(publishTaxonomyRoute, `/api/taxonomy/versions/${draftId}/publish`, draftId, { expectedVersion: lock });
    expect(res.status).toBe(200);
    v2 = draftId;
    expect((await res.json()).data.staleMarked).toBe(7);
    for (const sku of ["PP-001", "PP-005", "PP-011", "PP-012"]) expect((await stateOf(L[sku])).state, sku).toBe("stale");
    expect((await stateOf(L["PP-006"])).state).toBe("deferred");
    expect((await stateOf(L["PP-007"])).state).toBe("no_suitable_category");

    const p = await preview();
    expect(p.mapped).toBe(0);
    expect(p.blockers[0]).toMatch(/7 listings have a mapping bound to an earlier taxonomy version/);
    const blocked = await post(publishRoute, "/api/releases", { merchantId, catalogRevisionId: revisionId, taxonomyVersionId: v2, reason: "Should not publish.", acknowledgePartial: true, expectedMapped: 0, expectedUnresolved: 9 });
    expect(blocked.status).toBe(422);
    expect(await count("mapping_releases where workspace_id = $1", [ws.id])).toBe(1);
  });
  it("keeps the original evidence inspectable and refuses to approve a stale suggestion", async () => {
    const { data } = await (await itemRoute(request(`/api/review-items/${L["PP-012"]}`, { cookie: ws.cookie.taxonomist }), ctx(L["PP-012"]))).json();
    expect(data.recommendation).toMatchObject({ stale: true, isDemo: true });
    expect(data.recommendation.candidates.length).toBeGreaterThan(0);
    const res = await decisionRoute(request(`/api/review-items/${L["PP-012"]}/decisions`, { method: "POST", cookie: ws.cookie.taxonomist, body: { action: "approve", expectedVersion: data.review.lockVersion }, headers: { "idempotency-key": idemKey("stale") } }), ctx(L["PP-012"]));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/no valid current target/);
  });
  it("revalidates unchanged human decisions explicitly and returns affected ones to review", async () => {
    expect((await post(revalidateRoute, "/api/taxonomy/revalidate", {}, "taxonomist")).status).toBe(403);
    const { data } = await (await post(revalidateRoute, "/api/taxonomy/revalidate", {})).json();
    expect(data).toMatchObject({ sequence: 2, revalidated: 5, needsReview: 1, needsAnalysis: 1, reopened: 1 });
    expect(await stateOf(L["PP-001"])).toMatchObject({ state: "approved", taxonomy_version_id: v2 });
    expect((await stateOf(L["PP-011"])).state).toBe("needs_review"); // target definition changed
    expect((await stateOf(L["PP-012"])).state).toBe("needs_analysis"); // stale suggestion, never decided
    expect((await stateOf(L["PP-007"])).state).toBe("needs_review"); // its proposal was applied
    const d = (await admin.query("select origin, action, taxonomy_version_id, previous_decision_id is not null as linked, reason from review_decisions where listing_revision_id = $1 order by created_at desc limit 1", [L["PP-005"]])).rows[0];
    expect(d).toMatchObject({ origin: "revalidated", action: "approve", taxonomy_version_id: v2, linked: true });
    expect(d.reason).toMatch(/taxonomy version 2/);
    // Earlier decisions and the release bound to version 1 are unchanged.
    expect(await count("published_mappings where release_id = $1 and taxonomy_version_id = $2", [release1, v1])).toBe(6);
    expect((await (await post(revalidateRoute, "/api/taxonomy/revalidate", {})).json()).data).toMatchObject({ revalidated: 0, needsReview: 0, needsAnalysis: 0 });
  });
  it("lets a reviewer map the listing to the newly published leaf", async () => {
    kombuchaId = (await admin.query("select concept_id from concept_revisions where taxonomy_version_id = $1 and name = 'Kombucha'", [v2])).rows[0].concept_id;
    const lock = (await stateOf(L["PP-007"])).lock_version;
    const res = await decisionRoute(request(`/api/review-items/${L["PP-007"]}/decisions`, { method: "POST", cookie: ws.cookie.taxonomist, body: { action: "approve", selectedConceptId: kombuchaId, expectedVersion: lock }, headers: { "idempotency-key": idemKey("kombucha") } }), ctx(L["PP-007"]));
    expect(res.status).toBe(201);
    expect((await res.json()).data.conceptPath).toBe("All Products > Beverages > Kombucha");
  });
});

let release2: string;

describe("release history, rollback and reproducible exports (AT15, AT16)", () => {
  it("publishes a second release against the new taxonomy version and reports the change from the first", async () => {
    const p = await preview();
    expect(p).toMatchObject({ mapped: 6, unresolved: 3, blockers: [], changes: { added: 1, removed: 1, changed: 0, unchanged: 5 } });
    const res = await post(publishRoute, "/api/releases", { merchantId, catalogRevisionId: revisionId, taxonomyVersionId: v2, reason: "After taxonomy version 2.", acknowledgePartial: true, expectedMapped: 6, expectedUnresolved: 3 });
    expect(res.status).toBe(201);
    release2 = (await res.json()).data.releaseId;
    const list = (await (await releasesRoute(request("/api/releases", { cookie: ws.cookie.viewer }))).json()).data;
    expect(list.map((r: { releaseNumber: number; isCurrent: boolean; taxonomySequence: number }) => [r.releaseNumber, r.isCurrent, r.taxonomySequence])).toEqual([[2, true, 2], [1, false, 1]]);
  });
  it("reproduces the first release's export byte for byte after later decisions, taxonomy and release changes", async () => {
    const again = (await download(release1, "mapping")).bytes;
    expect(again.equals(firstExport)).toBe(true);
    const zipA = (await download(release1, "zip")).bytes;
    const zipB = (await download(release1, "zip")).bytes;
    expect(zipA.equals(zipB)).toBe(true);
    const second = unzip((await download(release2, "zip")).bytes);
    expect(second["mappings.csv"]).toContain("Kombucha");
    expect(second["mappings.csv"]).not.toContain("PP-011");
    expect(second["unresolved.csv"]).toContain("PP-011");
  });
  it("rolls back to a compatible release with a version check and keeps all history", async () => {
    const activate = (id: string, body: unknown, role: Role = "administrator") => postId(activateRoute, `/api/releases/${id}/activate`, id, body, role);
    expect((await activate(release1, { expectedVersion: 1, reason: "Rollback" }, "taxonomist")).status).toBe(403);
    expect((await activate(release1, { expectedVersion: 0, reason: "Rollback" })).status).toBe(409);
    expect((await activate(release2, { expectedVersion: 1, reason: "Already current" })).status).toBe(409);
    const res = await activate(release1, { expectedVersion: 1, reason: "Release 2 needs another look." });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ releaseNumber: 1, catalogRevisionActivated: false });
    expect((await admin.query("select release_id from current_releases where merchant_id = $1", [merchantId])).rows[0].release_id).toBe(release1);
    expect(await count("mapping_releases where workspace_id = $1", [ws.id])).toBe(2);
    expect(await count("published_mappings where workspace_id = $1", [ws.id])).toBe(12);
    const audit = (await admin.query("select before_ref, after_ref, reason from audit_events where action = 'release.activate' and entity_id = $1", [release1])).rows[0];
    expect(audit.before_ref.currentReleaseId).toBe(release2);
    expect(audit.reason).toBe("Release 2 needs another look.");
  });
  it("blocks activating a release from a different catalog revision unless that revision is explicitly activated too", async () => {
    const next = await importCatalog(ws, { merchantId, mode: "delta", content: "Item Code,Product Name,Details,Dept,Maker,Pack,Retail,Cur\nPP-030,Sparkling Water Lime,,Drinks,Nimbus,1 L,0.99,USD\n" });
    expect((await admin.query("select active_catalog_revision_id as id from merchants where id = $1", [merchantId])).rows[0].id).toBe(next.revisionId);
    const lock = (await admin.query("select lock_version from current_releases where merchant_id = $1", [merchantId])).rows[0].lock_version;
    const blocked = await postId(activateRoute, `/api/releases/${release2}/activate`, release2, { expectedVersion: lock, reason: "Back to release 2." });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.current.requiresCatalogActivation).toBe(true);
    expect((await admin.query("select release_id from current_releases where merchant_id = $1", [merchantId])).rows[0].release_id).toBe(release1);

    const ok = await postId(activateRoute, `/api/releases/${release2}/activate`, release2, { expectedVersion: lock, reason: "Back to release 2 and its catalog.", activateCatalogRevision: true });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.catalogRevisionActivated).toBe(true);
    expect((await admin.query("select active_catalog_revision_id as id from merchants where id = $1", [merchantId])).rows[0].id).toBe(revisionId);
    expect(await count("catalog_revisions where merchant_id = $1", [merchantId])).toBe(2);
  });
});

describe("audit log (TAX13)", () => {
  const audit = (qs = "", role: Role = "taxonomist", w = ws) => auditRoute(request(`/api/audit${qs}`, { cookie: w.cookie[role] }));
  it("is readable by taxonomists and administrators only, scoped to the workspace", async () => {
    expect((await audit("", "viewer")).status).toBe(403);
    expect((await audit("", "analyst")).status).toBe(403);
    const { data } = await (await audit("?limit=200", "administrator")).json();
    const actions = new Set(data.items.map((i: { action: string }) => i.action));
    for (const a of ["catalog.revision.create", "analysis.run", "review.approve", "review.change", "taxonomy.proposal.submit", "taxonomy.proposal.modify", "taxonomy.publish", "taxonomy.revalidate", "release.publish", "release.export", "release.activate"]) expect(actions.has(a), a).toBe(true);
    const foreign = await (await audit("?limit=200", "administrator", other)).json();
    expect(foreign.data.items.some((i: { entityId: string }) => i.entityId === release1)).toBe(false);
  });
  it("filters by action prefix and entity, and pages newest-first without duplicates", async () => {
    const releases = (await (await audit("?action=release&limit=200")).json()).data.items;
    expect(releases.length).toBeGreaterThan(3);
    expect(releases.every((i: { action: string }) => i.action.startsWith("release."))).toBe(true);
    const byEntity = (await (await audit(`?q=${release1}`)).json()).data.items;
    expect(byEntity.every((i: { entityId: string }) => i.entityId === release1)).toBe(true);
    const seen: string[] = [];
    let cursor: string | null = null;
    let lastTime = Infinity;
    do {
      const page: { items: { id: string; createdAt: string }[]; nextCursor: string | null } = (await (await audit(`?limit=7${cursor ? `&cursor=${cursor}` : ""}`)).json()).data;
      for (const i of page.items) {
        expect(Date.parse(i.createdAt)).toBeLessThanOrEqual(lastTime);
        lastTime = Date.parse(i.createdAt);
        seen.push(i.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(await count("audit_events where workspace_id = $1", [ws.id]));
  });
});
