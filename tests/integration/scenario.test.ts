import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db/client";
import { seedScenario, type ScenarioResult } from "@/db/seed-scenario";
import { listReleases, previewRelease } from "@/lib/domain/releases";
import { listReviewItems } from "@/lib/domain/review";
import { actorFor, adminClient, createTestWorkspace, type TestWorkspace } from "../setup/helpers";

let admin: pg.Client;
let ws: TestWorkspace;
let result: ScenarioResult;

beforeAll(async () => {
  admin = await adminClient();
  ws = await createTestWorkspace(admin, "scenario");
  result = (await seedScenario(await actorFor(ws, "administrator"), await actorFor(ws, "taxonomist")))!;
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

const rows = async (sql: string, params: unknown[] = [ws.id]) => (await admin.query(sql, params)).rows;

/** Exact totals of the seeded demo scenario (PRD section 17). A change here is a change to the demo. */
describe("demo scenario seed", () => {
  it("is idempotent", async () => {
    expect(await seedScenario(await actorFor(ws, "administrator"), await actorFor(ws, "taxonomist"))).toBeNull();
    expect((await rows("select count(*)::int as n from taxonomy_versions where workspace_id = $1"))[0].n).toBe(1);
  });
  it("creates the expected revision populations", async () => {
    const revisions = await rows(
      "select m.name, cr.sequence, (cr.counts->>'active')::int as active, (cr.counts->>'deactivated')::int as deactivated, (cr.counts->>'changed')::int as changed, (cr.counts->>'new')::int as new, (cr.counts->>'decisionsCarried')::int as carried from catalog_revisions cr join merchants m on m.id = cr.merchant_id where cr.workspace_id = $1 order by 1, 2",
    );
    expect(revisions).toEqual([
      { name: "Corner Goods", sequence: 1, active: 99, deactivated: 0, changed: 0, new: 99, carried: 0 },
      { name: "Daily Basket", sequence: 1, active: 100, deactivated: 0, changed: 0, new: 100, carried: 0 },
      { name: "Harbor Market", sequence: 1, active: 101, deactivated: 0, changed: 0, new: 101, carried: 0 },
      { name: "Harbor Market", sequence: 2, active: 101, deactivated: 5, changed: 3, new: 5, carried: 66 },
    ]);
    const current = await rows("select count(*)::int as n from listing_revisions lr join merchants m on m.active_catalog_revision_id = lr.catalog_revision_id where lr.workspace_id = $1 and lr.active");
    expect(current[0].n).toBe(300);
  });
  it("creates the expected review states on current catalogs", async () => {
    const states = await rows(
      "select m.name, rs.state, count(*)::int as n from review_states rs join listing_revisions lr on lr.id = rs.listing_revision_id and lr.active join merchants m on m.active_catalog_revision_id = lr.catalog_revision_id where rs.workspace_id = $1 group by 1, 2 order by 1, 2",
    );
    const by = (name: string) => Object.fromEntries(states.filter((s) => s.name === name).map((s) => [s.state, s.n]));
    expect(by("Harbor Market")).toEqual({ suggested: 15, needs_investigation: 4, approved: 82 });
    expect(by("Daily Basket")).toEqual({ suggested: 38, needs_investigation: 2, approved: 58, deferred: 1, no_suitable_category: 1 });
    expect(by("Corner Goods")).toEqual({ suggested: 62, needs_investigation: 5, approved: 32 });
    const queue = await listReviewItems(await actorFor(ws, "viewer"), { limit: 1 });
    expect(queue.progress).toMatchObject({ total: 300, approved: 172, remaining: 128 });
  });
  it("labels every suggestion as demo fixture output and never uses the disabled High band", async () => {
    const recs = await rows("select provider, is_demo, signal_band, count(*)::int as n from recommendations where workspace_id = $1 group by 1, 2, 3 order by 3");
    expect(recs).toEqual([
      { provider: "fixture", is_demo: true, signal_band: "medium", n: 284 },
      { provider: "fixture", is_demo: true, signal_band: "low", n: 33 },
      { provider: "fixture", is_demo: true, signal_band: "none", n: 18 },
    ]);
  });
  it("publishes four releases whose stored mappings reconcile with their counts", async () => {
    const releases = (await listReleases(await actorFor(ws, "viewer"))).map((r) => ({ n: r.releaseNumber, merchant: r.merchantName, revision: r.revisionSequence, mapped: r.counts.mapped, unresolved: r.counts.unresolved, current: r.isCurrent, compatible: r.compatible, partial: r.partial }));
    expect(releases).toEqual([
      { n: 4, merchant: "Daily Basket", revision: 1, mapped: 58, unresolved: 42, current: true, compatible: true, partial: true },
      { n: 3, merchant: "Harbor Market", revision: 2, mapped: 82, unresolved: 19, current: true, compatible: true, partial: true },
      { n: 2, merchant: "Harbor Market", revision: 2, mapped: 66, unresolved: 35, current: false, compatible: true, partial: true },
      { n: 1, merchant: "Harbor Market", revision: 1, mapped: 72, unresolved: 29, current: false, compatible: false, partial: true },
    ]);
    const stored = await rows(
      "select r.release_number as n, (select count(*)::int from published_mappings pm where pm.release_id = r.id) as mapped, (select count(*)::int from release_unresolved ru where ru.release_id = r.id) as unresolved, (r.counts->>'activeListings')::int as active from mapping_releases r where r.workspace_id = $1 order by 1",
    );
    for (const s of stored) expect(s.mapped + s.unresolved, `release ${s.n}`).toBe(s.active);
    expect(stored.map((s) => s.mapped)).toEqual([72, 66, 82, 58]);
    // Corner Goods was never published: nothing to roll back to and zero published mappings.
    const corner = await previewRelease(await actorFor(ws, "administrator"), result.merchants["corner-goods"]);
    expect(corner).toMatchObject({ currentRelease: null, activeListings: 99, mapped: 32, unresolved: 67 });
  });
  it("leaves one proposal awaiting an administrator and a complete audit trail", async () => {
    expect(await rows("select type, state from taxonomy_proposals where workspace_id = $1")).toEqual([{ type: "new_leaf", state: "submitted" }]);
    const audit = await rows("select action, count(*)::int as n from audit_events where workspace_id = $1 group by 1 order by 1");
    const count = Object.fromEntries(audit.map((a) => [a.action, a.n]));
    expect(count).toMatchObject({ "taxonomy.publish": 1, "catalog.revision.create": 4, "analysis.run": 4, "release.publish": 4, "review.approve": 178, "review.defer": 1, "review.no_suitable": 1, "taxonomy.proposal.submit": 1 });
  });
});
