import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as jobRoute } from "@/app/api/analysis-jobs/[id]/route";
import { POST as analysisRoute } from "@/app/api/analysis-jobs/route";
import { POST as bulkRoute } from "@/app/api/review/bulk-approve/route";
import { POST as decisionRoute } from "@/app/api/review-items/[id]/decisions/route";
import { GET as itemRoute } from "@/app/api/review-items/[id]/route";
import { GET as queueRoute } from "@/app/api/review-items/route";
import { GET as conceptSearchRoute } from "@/app/api/taxonomy/concepts/route";
import { closeDb, withContext } from "@/db/client";
import { buildFixtures, catalogCsv, WALKTHROUGH_CSV } from "@/fixtures/generate";
import { FixtureProvider } from "@/lib/ai/fixture-adapter";
import { buildRequest, loadVersionIndex, storeRecommendation } from "@/lib/domain/analysis";
import { drainJobs } from "@/lib/jobs/analysis-worker";
import { adminClient, createTestWorkspace, ctx, idemKey, request, type TestWorkspace } from "../setup/helpers";
import { conceptIds, FAST, importCatalog, listingIds, publishTaxonomy } from "../setup/scenario";

let admin: pg.Client;
let ws: TestWorkspace;
let other: TestWorkspace;
let versionId: string;
let merchantId: string;
let revisionId: string;
let L: Record<string, string>;
let C: Record<string, string>;

type Role = keyof TestWorkspace["cookie"];
const decide = (listing: string, body: Record<string, unknown>, role: Role = "taxonomist", w = ws) =>
  decisionRoute(request(`/api/review-items/${listing}/decisions`, { method: "POST", cookie: w.cookie[role], body, headers: { "idempotency-key": idemKey("decide") } }), ctx(listing));
const startJob = (revision: string, w = ws, role: Role = "taxonomist") =>
  analysisRoute(request("/api/analysis-jobs", { method: "POST", cookie: w.cookie[role], body: { catalogRevisionId: revision }, headers: { "idempotency-key": idemKey("analyze") } }));
/** Queues a job through the API, lets the worker engine process it, and returns the finished job. */
const analyze = async (revision: string, w = ws) => {
  const started = await startJob(revision, w);
  if (started.status !== 202) throw new Error(`start failed: ${started.status} ${await started.text()}`);
  const { data } = await started.json();
  await drainJobs(FAST);
  return (await (await jobRoute(request(`/api/analysis-jobs/${data.id}`, { cookie: w.cookie.taxonomist }), ctx(data.id))).json()).data;
};
const queue = async (qs = "", role: Role = "viewer", w = ws) => (await (await queueRoute(request(`/api/review-items${qs}`, { cookie: w.cookie[role] }))).json()).data;
const stateOf = async (listing: string) => (await admin.query("select state, lock_version, latest_decision_id, latest_recommendation_id, ambiguous from review_states where listing_revision_id = $1", [listing])).rows[0];
const count = async (sql: string, params: unknown[]) => (await admin.query(`select count(*)::int as n from ${sql}`, params)).rows[0].n as number;

beforeAll(async () => {
  admin = await adminClient();
  ws = await createTestWorkspace(admin, "review");
  other = await createTestWorkspace(admin, "review-other");
  versionId = await publishTaxonomy(ws);
  ({ merchantId, revisionId } = await importCatalog(ws, { merchantName: "Pier Pantry", content: WALKTHROUGH_CSV, resolutions: { "PP-004": 5 } }));
  L = await listingIds(admin, revisionId);
  C = await conceptIds(admin, ws.id);
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

describe("manual mapping without AI (TAX08)", () => {
  it("lets a reviewer search mappable leaves only", async () => {
    const { data } = await (await conceptSearchRoute(request("/api/taxonomy/concepts?q=milk", { cookie: ws.cookie.taxonomist }))).json();
    expect(data.map((c: { stableKey: string }) => c.stableKey)).toEqual(expect.arrayContaining(["GRO-DAI-MILK", "GRO-DAI-PLANT", "GRO-PAN-COOKMILK"]));
    expect(data.every((c: { conceptId: string }) => c.conceptId !== C["GRO-DAI"])).toBe(true);
    const dairy = await (await conceptSearchRoute(request("/api/taxonomy/concepts?q=Dairy%20%26%20Eggs", { cookie: ws.cookie.taxonomist }))).json();
    expect(dairy.data.every((c: { path: string }) => c.path.split(" > ").length === 4)).toBe(true);
  });
  it("shows text matches for an unanalyzed listing without calling them a recommendation", async () => {
    const { data } = await (await itemRoute(request(`/api/review-items/${L["PP-001"]}`, { cookie: ws.cookie.viewer }), ctx(L["PP-001"]))).json();
    expect(data.recommendation).toBeNull();
    expect(data.review.state).toBe("needs_analysis");
    expect(data.textMatches[0].stableKey).toBe("GRO-DAI-MILK");
    expect(data.listing.raw["Product Name"]).toBe("Whole Milk Gallon");
    expect(data.canDecide).toBe(false);
  });
  it("enforces role, target and version rules", async () => {
    const body = { action: "approve", selectedConceptId: C["GRO-DAI-MILK"], expectedVersion: 0 };
    expect((await decide(L["PP-001"], body, "viewer")).status).toBe(403);
    expect((await decide(L["PP-001"], body, "analyst")).status).toBe(403);
    expect((await decide(L["PP-001"], { action: "approve", expectedVersion: 0 })).status).toBe(422);
    expect((await decide(L["PP-001"], { ...body, selectedConceptId: C["GRO-DAI"] })).status).toBe(422);
    expect((await decide(L["PP-001"], { ...body, selectedConceptId: (await conceptIds(admin, other.id))["x"] ?? "7c9e6679-7425-40de-944b-e07fc1f90ae7" })).status).toBe(422);
    expect((await decide(L["PP-001"], { action: "reject", reason: "no", expectedVersion: 0 })).status).toBe(422);
    expect((await decide(L["PP-001"], body, "administrator", other)).status).toBe(404);
    expect(await count("review_decisions where workspace_id = $1", [ws.id])).toBe(0);
  });
  it("lets exactly one of two concurrent reviewers win; the other gets 409 with the current record (AT08)", async () => {
    const body = { action: "approve", selectedConceptId: C["GRO-DAI-MILK"], expectedVersion: 0, durationSeconds: 12 };
    const results = await Promise.all([decide(L["PP-001"], body, "taxonomist"), decide(L["PP-001"], body, "administrator")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = await results.find((r) => r.status === 409)!.json();
    expect(loser.error.current).toEqual({ state: "approved", lockVersion: 1 });
    expect(await count("review_decisions where listing_revision_id = $1", [L["PP-001"]])).toBe(1);
    const d = (await admin.query("select action, origin, duration_seconds, recommendation_id, taxonomy_version_id from review_decisions where listing_revision_id = $1", [L["PP-001"]])).rows[0];
    expect(d).toEqual({ action: "approve", origin: "manual", duration_seconds: 12, recommendation_id: null, taxonomy_version_id: versionId });
    expect(await count("audit_events where action = 'review.approve' and entity_id = $1", [L["PP-001"]])).toBe(1);
  });
});

describe("demo analysis (TAX05 to TAX07, AT09, AT18)", () => {
  it("is refused for viewers and for workspaces without a usable provider, leaving manual work intact", async () => {
    expect((await startJob(revisionId, ws, "viewer")).status).toBe(403);
    await publishTaxonomy(other);
    const elsewhere = await importCatalog(other, { merchantName: "Elsewhere", content: WALKTHROUGH_CSV, resolutions: { "PP-004": 5 } });
    for (const mode of ["off", "live"]) {
      await admin.query("update workspaces set provider_mode = $2 where id = $1", [other.id, mode]);
      const res = await startJob(elsewhere.revisionId, other);
      expect(res.status, mode).toBe(503);
      expect((await res.json()).error.message).toMatch(mode === "live" ? /AI unavailable/ : /AI off/);
    }
    // Missing key in live mode never falls back to fixture output.
    expect(await count("recommendations where workspace_id = $1", [other.id])).toBe(0);
    const otherListings = await listingIds(admin, elsewhere.revisionId);
    const otherConcepts = await conceptIds(admin, other.id);
    expect((await decide(otherListings["PP-001"], { action: "approve", selectedConceptId: otherConcepts["GRO-DAI-MILK"], expectedVersion: 0 }, "taxonomist", other)).status).toBe(201);
  });
  it("creates labeled demo suggestions for fixture listings and skips reviewed ones", async () => {
    // The request only queues the job: nothing is analyzed until a worker picks it up.
    const queued = await startJob(revisionId);
    expect(queued.status).toBe(202);
    const started = (await queued.json()).data;
    expect(started).toMatchObject({ status: "queued", isDemo: true, provider: "fixture", progress: { total: 9, pending: 8, succeeded: 0, skippedReviewed: 1 } });
    expect(await count("recommendations where workspace_id = $1", [ws.id])).toBe(0);
    expect((await startJob(revisionId)).status).toBe(409);
    await drainJobs(FAST);
    const data = (await (await jobRoute(request(`/api/analysis-jobs/${started.id}`, { cookie: ws.cookie.viewer }), ctx(started.id))).json()).data;
    expect(data).toMatchObject({ status: "completed", isDemo: true, provider: "fixture", progress: { total: 9, pending: 0, succeeded: 8, failed: 0, skippedReviewed: 1, skippedNoFixture: 0 }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
    expect((await jobRoute(request(`/api/analysis-jobs/${started.id}`, { cookie: other.cookie.administrator }), ctx(started.id))).status).toBe(404);
    const recs = (await admin.query("select distinct provider, is_demo, taxonomy_version_id from recommendations where workspace_id = $1", [ws.id])).rows;
    expect(recs).toEqual([{ provider: "fixture", is_demo: true, taxonomy_version_id: versionId }]);
    // The High band is disabled until its precision gate is met.
    expect(await count("recommendations where workspace_id = $1 and signal_band = 'high'", [ws.id])).toBe(0);
    expect(await stateOf(L["PP-002"])).toMatchObject({ state: "suggested", ambiguous: false });
    expect(await stateOf(L["PP-005"])).toMatchObject({ state: "needs_investigation", ambiguous: true });
    expect(await stateOf(L["PP-006"])).toMatchObject({ state: "needs_investigation", ambiguous: true });
    expect(await stateOf(L["PP-007"])).toMatchObject({ state: "needs_investigation", ambiguous: false });
    const misled = (await admin.query("select r.signal_band, c.stable_key from recommendations r join concepts c on c.id = r.selected_concept_id where r.listing_revision_id = $1", [L["PP-005"]])).rows[0];
    expect(misled).toEqual({ signal_band: "low", stable_key: "GRO-PAN-COOKMILK" });
  });
  it("never replaces a human decision when a recommendation arrives later (AT09)", async () => {
    const before = await stateOf(L["PP-001"]);
    await withContext({ workspaceId: ws.id }, async (tx) => {
      const index = await loadVersionIndex(tx, versionId);
      const fields = (await admin.query("select normalized_json, content_hash from listing_revisions where id = $1", [L["PP-001"]])).rows[0];
      const req = buildRequest(ws.id, { id: L["PP-001"], contentHash: fields.content_hash, fields: fields.normalized_json }, index);
      const provider = new FixtureProvider();
      const result = await provider.recommend(req);
      if (!result.ok) throw new Error("fixture missing");
      const stored = await storeRecommendation(tx, { workspaceId: ws.id, request: req, response: result.payload as never, provider, runId: "5c9e6679-7425-40de-944b-e07fc1f90ae7", jobId: null, highEnabled: true });
      expect(stored.appliedToState).toBe(false);
    });
    const after = await stateOf(L["PP-001"]);
    expect(after).toMatchObject({ state: "approved", lock_version: before.lock_version, latest_decision_id: before.latest_decision_id });
    expect(after.latest_recommendation_id).not.toBeNull();
    expect(await count("recommendations where listing_revision_id = $1", [L["PP-001"]])).toBe(1);
  });
  it("fabricates nothing for uploaded products that are not fixtures; they stay manually reviewable", async () => {
    const custom = await importCatalog(ws, { merchantName: "Own Upload", content: "merchant_sku,title\nX-1,Oat Milk Barista Blend 1L\nX-2,Mystery Item\n" });
    const data = await analyze(custom.revisionId);
    expect(data).toMatchObject({ status: "completed", progress: { total: 2, succeeded: 0, skippedNoFixture: 2 } });
    expect(await count("recommendations r join listing_revisions lr on lr.id = r.listing_revision_id where lr.catalog_revision_id = $1", [custom.revisionId])).toBe(0);
    const ids = await listingIds(admin, custom.revisionId);
    expect((await stateOf(ids["X-1"])).state).toBe("needs_analysis");
    expect((await decide(ids["X-1"], { action: "approve", selectedConceptId: C["GRO-DAI-PLANT"], expectedVersion: 0 })).status).toBe(201);
  });
});

describe("decisions on suggestions (TAX08, AT07)", () => {
  const version = async (listing: string) => (await stateOf(listing)).lock_version as number;
  it("approves a suggestion with suggestion origin", async () => {
    const res = await decide(L["PP-002"], { action: "approve", expectedVersion: await version(L["PP-002"]) });
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ state: "approved", conceptPath: "All Products > Grocery > Produce > Fresh Fruit" });
    const d = (await admin.query("select origin, recommendation_id from review_decisions where listing_revision_id = $1", [L["PP-002"]])).rows[0];
    expect(d.origin).toBe("suggestion");
    expect(d.recommendation_id).not.toBeNull();
  });
  it("requires Change mapping with a reason to pick a different concept, and keeps the AI history", async () => {
    const v = await version(L["PP-005"]);
    expect((await decide(L["PP-005"], { action: "approve", selectedConceptId: C["PC-HAIR-SHAMPOO"], expectedVersion: v })).status).toBe(422);
    const noReason = await decide(L["PP-005"], { action: "change", selectedConceptId: C["PC-HAIR-SHAMPOO"], expectedVersion: v });
    expect(noReason.status).toBe(422);
    expect((await noReason.json()).error.fieldErrors[0].path).toBe("reason");
    const ok = await decide(L["PP-005"], { action: "change", selectedConceptId: C["PC-HAIR-SHAMPOO"], reason: "Title says shampoo; the merchant category is misleading.", expectedVersion: v });
    expect(ok.status).toBe(201);
    expect(await stateOf(L["PP-005"])).toMatchObject({ state: "approved", ambiguous: false });
    const rec = (await admin.query("select c.stable_key from recommendations r join concepts c on c.id = r.selected_concept_id where r.listing_revision_id = $1", [L["PP-005"]])).rows;
    expect(rec).toEqual([{ stable_key: "GRO-PAN-COOKMILK" }]);
  });
  it("rejects with a reason, defers, and records no suitable category without inventing a target", async () => {
    expect((await decide(L["PP-003"], { action: "reject", expectedVersion: await version(L["PP-003"]) })).status).toBe(422);
    expect((await decide(L["PP-003"], { action: "reject", reason: "Checking whether this is dishwasher detergent.", expectedVersion: await version(L["PP-003"]) })).status).toBe(201);
    expect((await decide(L["PP-006"], { action: "defer", reason: "Ask merchant what this is.", expectedVersion: await version(L["PP-006"]) })).status).toBe(201);
    expect((await decide(L["PP-007"], { action: "no_suitable", expectedVersion: await version(L["PP-007"]) })).status).toBe(201);
    expect((await stateOf(L["PP-003"])).state).toBe("needs_investigation");
    expect((await stateOf(L["PP-006"])).state).toBe("deferred");
    expect((await stateOf(L["PP-007"])).state).toBe("no_suitable_category");
    const targets = (await admin.query("select selected_concept_id from review_decisions where listing_revision_id = any($1)", [[L["PP-003"], L["PP-006"], L["PP-007"]]])).rows;
    expect(targets.every((t) => t.selected_concept_id === null)).toBe(true);
  });
  it("keeps the full decision history with previous-decision links", async () => {
    expect((await decide(L["PP-003"], { action: "approve", expectedVersion: await version(L["PP-003"]) })).status).toBe(201);
    const { data } = await (await itemRoute(request(`/api/review-items/${L["PP-003"]}`, { cookie: ws.cookie.taxonomist }), ctx(L["PP-003"]))).json();
    expect(data.history.map((h: { action: string }) => h.action)).toEqual(["reject", "approve"]);
    expect(data.history[1].conceptPath).toBe("All Products > Household > Cleaning Supplies > Dish Soap & Dishwasher Detergent");
    expect(data.recommendation).toMatchObject({ isDemo: true, provider: "fixture", stale: false });
    expect(data.canDecide).toBe(true);
    const chain = (await admin.query("select previous_decision_id is not null as linked from review_decisions where listing_revision_id = $1 order by created_at", [L["PP-003"]])).rows;
    expect(chain.map((c) => c.linked)).toEqual([false, true]);
    await expect(admin.query("update review_decisions set reason = 'edited' where listing_revision_id = $1", [L["PP-003"]])).rejects.toThrow(/append-only/);
  });
});

describe("review queue (TAX08)", () => {
  it("reports live progress and filters by state, band, warning, search and merchant", async () => {
    const all = await queue(`?merchant=${merchantId}`);
    expect(all.items).toHaveLength(9);
    expect(all.progress).toMatchObject({ total: 9, approved: 4, remaining: 5 });
    expect(all.progress.byState).toMatchObject({ approved: 4, suggested: 3, deferred: 1, no_suitable_category: 1 });
    expect((await queue(`?merchant=${merchantId}&state=approved`)).items).toHaveLength(4);
    expect((await queue(`?merchant=${merchantId}&state=unresolved`)).items).toHaveLength(5);
    expect((await queue(`?merchant=${merchantId}&band=low`)).items.map((i: { sku: string }) => i.sku)).toEqual(["PP-005"]);
    expect((await queue(`?merchant=${merchantId}&warning=1`)).items.map((i: { sku: string }) => i.sku).sort()).toEqual(["PP-005", "PP-006", "PP-007"]);
    expect((await queue(`?merchant=${merchantId}&q=shampoo`)).items.map((i: { sku: string }) => i.sku).sort()).toEqual(["PP-004", "PP-005"]);
    expect((await queue(`?merchant=${merchantId}&q=PP-012`)).items).toHaveLength(1);
    const grocery = await queue(`?merchant=${merchantId}&concept=${C["GRO"]}`);
    expect(grocery.items.map((i: { sku: string }) => i.sku).sort()).toEqual(["PP-001", "PP-002"]);
    expect((await queue("", "viewer", other)).items.every((i: { merchantName: string }) => i.merchantName === "Elsewhere")).toBe(true);
  });
  it("paginates every sort with a stable cursor and no duplicates", async () => {
    for (const sort of ["age", "merchant", "signal"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: { id: string }[]; nextCursor: string | null } = await queue(`?merchant=${merchantId}&sort=${sort}&limit=4${cursor ? `&cursor=${cursor}` : ""}`);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen, sort).toHaveLength(9);
      expect(new Set(seen).size, sort).toBe(9);
    }
    expect((await queueRoute(request("/api/review-items?cursor=garbage", { cookie: ws.cookie.viewer }))).status).toBe(400);
  });
});

describe("bulk approval (TAX09, AT10)", () => {
  let ids: Record<string, string>;
  let high: { id: string; lockVersion: number }[];
  const bulk = (items: unknown[], role: Role = "taxonomist") => bulkRoute(request("/api/review/bulk-approve", { method: "POST", cookie: ws.cookie[role], body: { items }, headers: { "idempotency-key": idemKey("bulk") } }));

  it("offers High suggestions only once the workspace gate is enabled", async () => {
    await admin.query("update workspaces set high_signal_enabled = true where id = $1", [ws.id]);
    const rows = buildFixtures().catalogs["harbor-market"].slice(0, 30);
    const imported = await importCatalog(ws, { merchantName: "Harbor Sample", content: catalogCsv(rows) });
    await analyze(imported.revisionId);
    ids = await listingIds(admin, imported.revisionId);
    const q = await queue(`?merchant=${imported.merchantId}&band=high&limit=100`);
    high = q.items.map((i: { id: string; lockVersion: number }) => ({ id: i.id, lockVersion: i.lockVersion }));
    expect(high.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(ids)).toHaveLength(30);
  });
  it("rejects the whole batch when one row is stale or ineligible, saving nothing", async () => {
    const [a, b, c] = high;
    // Another reviewer acts on row c after it was selected.
    expect((await decide(c.id, { action: "defer", expectedVersion: c.lockVersion })).status).toBe(201);
    const before = await count("review_decisions where workspace_id = $1 and origin = 'bulk'", [ws.id]);
    const res = await bulk([a, b, c].map((x) => ({ listingRevisionId: x.id, expectedVersion: x.lockVersion })));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.current.conflicts).toEqual([expect.objectContaining({ listingRevisionId: c.id, reason: "Changed since it was selected.", state: "deferred" })]);
    expect(await count("review_decisions where workspace_id = $1 and origin = 'bulk'", [ws.id])).toBe(before);
    expect((await stateOf(a.id)).state).toBe("suggested");

    const low = await bulk([{ listingRevisionId: L["PP-004"], expectedVersion: (await stateOf(L["PP-004"])).lock_version }]);
    expect(low.status).toBe(409);
    expect((await low.json()).error.current.conflicts[0].reason).toBe("Not a High signal suggestion.");
    expect((await bulk([{ listingRevisionId: a.id, expectedVersion: a.lockVersion }], "viewer")).status).toBe(403);
  });
  it("approves an eligible selection atomically with one batch ID and per-item decisions", async () => {
    const selection = high.slice(0, 2).concat(high.slice(3, 5));
    const res = await bulk(selection.map((x) => ({ listingRevisionId: x.id, expectedVersion: x.lockVersion })));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.approved).toBe(4);
    const rows = (await admin.query("select listing_revision_id, origin, action, selected_concept_id from review_decisions where batch_id = $1", [data.batchId])).rows;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.origin === "bulk" && r.action === "approve" && r.selected_concept_id)).toBe(true);
    for (const s of selection) expect(await stateOf(s.id)).toMatchObject({ state: "approved", lock_version: s.lockVersion + 1 });
    expect(await count("audit_events where action = 'review.bulk_approve' and entity_id = $1", [data.batchId])).toBe(1);
    // The same rows cannot be bulk approved twice.
    expect((await bulk(selection.map((x) => ({ listingRevisionId: x.id, expectedVersion: x.lockVersion + 1 })))).status).toBe(409);
  });
});

describe("decisions across catalog revisions (TAX04)", () => {
  it("carries an unchanged listing's decision forward with provenance and sends changed listings back to review", async () => {
    const delta = "Item Code,Product Name,Details,Dept,Maker,Pack,Retail,Cur\nPP-001,Whole Milk Gallon,Grade A whole milk,Fridge > Milk,Meadow Lane,1 gal,4.49,USD\nPP-002,Organic Bananas,,Produce,,per lb,0.69,USD\nPP-020,Spring Water 24 Pack,,Drinks,Nimbus,24 x 16.9 fl oz,4.99,USD\n";
    const next = await importCatalog(ws, { merchantId, content: delta, mode: "delta" });
    const N = await listingIds(admin, next.revisionId);
    // PP-001: price-only change, same classification content.
    expect(await stateOf(N["PP-001"])).toMatchObject({ state: "approved" });
    const carried = (await admin.query("select origin, action, previous_decision_id is not null as linked, c.stable_key, actor_id from review_decisions d join concepts c on c.id = d.selected_concept_id where d.listing_revision_id = $1", [N["PP-001"]])).rows[0];
    expect(carried).toMatchObject({ origin: "carried_forward", action: "approve", linked: true, stable_key: "GRO-DAI-MILK" });
    // PP-002: title changed, so the earlier approval cannot silently stay current.
    expect(await stateOf(N["PP-002"])).toMatchObject({ state: "needs_review", latest_decision_id: null });
    expect((await stateOf(N["PP-020"])).state).toBe("needs_analysis");
    // Unprovided listings are carried forward in delta mode with their state.
    expect((await stateOf(N["PP-006"])).state).toBe("deferred");
    expect((await stateOf(N["PP-005"])).state).toBe("approved");
    const counts = (await admin.query("select counts from catalog_revisions where id = $1", [next.revisionId])).rows[0].counts;
    expect(counts).toMatchObject({ active: 10, new: 1, changed: 1, unchanged: 1, carriedForward: 7 });
    // The superseded revision is read-only.
    const old = await decide(L["PP-004"], { action: "approve", expectedVersion: (await stateOf(L["PP-004"])).lock_version });
    expect(old.status).toBe(409);
    expect((await old.json()).error.message).toMatch(/superseded/);
    expect((await queue(`?merchant=${merchantId}`)).progress.total).toBe(10);
  });
});
