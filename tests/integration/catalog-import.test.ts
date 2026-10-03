import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listingsRoute } from "@/app/api/catalogs/[id]/listings/route";
import { POST as commitRoute } from "@/app/api/imports/[id]/commit/route";
import { PUT as mappingRoute } from "@/app/api/imports/[id]/mapping/route";
import { GET as importRoute } from "@/app/api/imports/[id]/route";
import { POST as stageRoute } from "@/app/api/imports/route";
import { closeDb } from "@/db/client";
import { WALKTHROUGH_CSV } from "@/fixtures/generate";
import { adminClient, createTestWorkspace, ctx, idemKey, request, type TestWorkspace } from "../setup/helpers";

let admin: pg.Client;
let ws: TestWorkspace;
let other: TestWorkspace;
let merchantId: string;
let otherMerchantId: string;

type Role = keyof TestWorkspace["cookie"];
const stage = (role: Role, body: Record<string, unknown>, w = ws) => stageRoute(request("/api/imports", { method: "POST", cookie: w.cookie[role], body: { fileName: "catalog.csv", mode: "snapshot", merchantId, ...body } }));
const commit = (id: string, body: unknown = { acceptExcluded: true }, role: Role = "taxonomist") =>
  commitRoute(request(`/api/imports/${id}/commit`, { method: "POST", cookie: ws.cookie[role], body, headers: { "idempotency-key": idemKey("commit") } }), ctx(id));
const setMapping = (id: string, body: unknown) => mappingRoute(request(`/api/imports/${id}/mapping`, { method: "PUT", cookie: ws.cookie.taxonomist, body }), ctx(id));
const count = async (sql: string, params: unknown[]) => (await admin.query(`select count(*)::int as n from ${sql}`, params)).rows[0].n as number;
const simple = (rows: string[]) => `merchant_sku,title,price,currency\n${rows.join("\n")}\n`;

beforeAll(async () => {
  admin = await adminClient();
  ws = await createTestWorkspace(admin, "catalog");
  other = await createTestWorkspace(admin, "catalog-other");
  merchantId = (await admin.query("insert into merchants (workspace_id, name) values ($1, 'Pier Pantry') returning id", [ws.id])).rows[0].id;
  otherMerchantId = (await admin.query("insert into merchants (workspace_id, name) values ($1, 'Elsewhere') returning id", [other.id])).rows[0].id;
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

describe("catalog import staging and validation (TAX03, TAX04, AT01)", () => {
  it("is limited to taxonomists and administrators", async () => {
    expect((await stage("viewer", { content: WALKTHROUGH_CSV })).status).toBe(403);
    expect((await stage("analyst", { content: WALKTHROUGH_CSV })).status).toBe(403);
  });
  it("rejects empty and malformed files with recoverable errors and creates nothing", async () => {
    expect((await stage("taxonomist", { content: "" })).status).toBe(422);
    const malformed = await stage("taxonomist", { content: 'merchant_sku,title\n"A,One' });
    expect(malformed.status).toBe(422);
    expect((await malformed.json()).error.message).toMatch(/never closed/);
    expect(await count("import_jobs where workspace_id = $1", [ws.id])).toBe(0);
  });
  it("refuses a merchant from another workspace", async () => {
    expect((await stage("taxonomist", { content: WALKTHROUGH_CSV, merchantId: otherMerchantId })).status).toBe(404);
  });
  it("needs a user mapping when headers are unknown, then validates", async () => {
    const res = await stage("taxonomist", { content: "code,label\nX-1,Thing One\nX-2,Thing Two\n", fileName: "odd-headers.csv" });
    const { data } = await res.json();
    expect(data.status).toBe("staged");
    expect(data.summary.mappingErrors).toHaveLength(2);
    expect((await commit(data.id)).status).toBe(422);
    const mapped = await (await setMapping(data.id, { columnMap: { merchant_sku: "code", title: "label" } })).json();
    expect(mapped.data.status).toBe("validated");
    expect(mapped.data.summary.counts).toEqual({ input: 2, accepted: 2, rejected: 0, collapsed: 0 });
  });

  let importId: string;
  it("stages mixed-validity rows with row-specific errors and commits nothing", async () => {
    const res = await stage("taxonomist", { content: WALKTHROUGH_CSV, fileName: "walkthrough.csv" });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    importId = data.id;
    expect(data.status).toBe("validated");
    expect(data.summary.counts).toEqual({ input: 14, accepted: 8, rejected: 5, collapsed: 1 });
    expect(data.summary.issues.map((i: { row: number; code: string }) => `${i.row}:${i.code}`)).toEqual(["5:conflicting_duplicate", "9:missing_title", "10:negative_price", "11:missing_currency", "13:conflicting_duplicate"]);
    expect(data.summary.preview.length).toBe(8);
    expect(await count("catalog_revisions where workspace_id = $1", [ws.id])).toBe(0);
    expect(await count("listing_revisions where workspace_id = $1", [ws.id])).toBe(0);
  });
  it("requires explicit acceptance of excluded rows", async () => {
    const res = await commit(importId, { acceptExcluded: false });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/5 rows will be excluded/);
    expect(await count("catalog_revisions where workspace_id = $1", [ws.id])).toBe(0);
  });
  it("lets the user select the row to keep for a conflicting SKU", async () => {
    const res = await setMapping(importId, {
      columnMap: { merchant_sku: "Item Code", title: "Product Name", description: "Details", merchant_category_path: "Dept", brand: "Maker", package_size: "Pack", price: "Retail", currency: "Cur" },
      resolutions: { "PP-004": 5 },
    });
    const { data } = await res.json();
    expect(data.summary.counts).toEqual({ input: 14, accepted: 9, rejected: 4, collapsed: 1 });
    expect((await (await importRoute(request(`/api/imports/${importId}`, { cookie: ws.cookie.viewer }), ctx(importId))).json()).data.resolutions).toEqual({ "PP-004": 5 });
    expect((await importRoute(request(`/api/imports/${importId}`, { cookie: other.cookie.administrator }), ctx(importId))).status).toBe(404);
  });

  let revision1: string;
  it("commits an immutable revision once, preserving source values (AT02)", async () => {
    const first = await (await commit(importId)).json();
    const again = await (await commit(importId)).json();
    revision1 = first.data.revisionId;
    expect(first.data.alreadyCommitted).toBe(false);
    expect(again.data).toEqual({ revisionId: revision1, alreadyCommitted: true });
    expect(await count("catalog_revisions where merchant_id = $1", [merchantId])).toBe(1);
    expect(await count("listing_revisions where catalog_revision_id = $1 and active", [revision1])).toBe(9);
    expect(await count("review_states rs join listing_revisions lr on lr.id = rs.listing_revision_id where lr.catalog_revision_id = $1 and rs.state = 'needs_analysis'", [revision1])).toBe(9);
    const rev = (await admin.query("select counts, mode, sequence, prior_revision_id from catalog_revisions where id = $1", [revision1])).rows[0];
    expect(rev).toMatchObject({ mode: "snapshot", sequence: 1, prior_revision_id: null });
    expect(rev.counts).toMatchObject({ input: 14, accepted: 9, rejected: 4, collapsed: 1, active: 9, new: 9 });
    const formula = (await admin.query("select raw_json, title, source_row, price::text, currency from listing_revisions where catalog_revision_id = $1 and title like '=SUM%'", [revision1])).rows[0];
    expect(formula.raw_json["Product Name"]).toBe("=SUM(A1:A9) Paper Towels");
    expect(formula).toMatchObject({ source_row: 14, price: "8.7900", currency: "USD" });
    const active = (await admin.query("select active_catalog_revision_id from merchants where id = $1", [merchantId])).rows[0];
    expect(active.active_catalog_revision_id).toBe(revision1);
    expect(await count("audit_events where action = 'catalog.revision.create' and entity_id = $1", [revision1])).toBe(1);
  });
  it("returns the existing import when the same file, merchant and mode are uploaded again", async () => {
    const res = await stage("taxonomist", { content: WALKTHROUGH_CSV });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ id: importId, existing: true, status: "committed", resultRevisionId: revision1 });
    const forced = await (await stage("taxonomist", { content: WALKTHROUGH_CSV, createNewRevision: true })).json();
    expect(forced.data.id).not.toBe(importId);
    expect(forced.data.existing).toBe(false);
    expect(await count("catalog_revisions where merchant_id = $1", [merchantId])).toBe(1);
  });
  it("pages the listing population with a stable cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/api/catalogs/${revision1}/listings?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { data } = await (await listingsRoute(request(url, { cookie: ws.cookie.viewer }), ctx(revision1))).json();
      seen.push(...data.items.map((i: { sku: string }) => i.sku));
      cursor = data.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["PP-001", "PP-002", "PP-003", "PP-004", "PP-005", "PP-006", "PP-007", "PP-011", "PP-012"]);
    expect((await listingsRoute(request(`/api/catalogs/${revision1}/listings`, { cookie: other.cookie.viewer }), ctx(revision1))).status).toBe(404);
  });
});

describe("snapshot and delta revisions (AT03)", () => {
  let m: string;
  const skusOf = async (revisionId: string, active: boolean) =>
    (await admin.query("select l.merchant_sku from listing_revisions lr join merchant_listings l on l.id = lr.listing_id where lr.catalog_revision_id = $1 and lr.active = $2 order by 1", [revisionId, active])).rows.map((r) => r.merchant_sku);
  const run = async (mode: string, rows: string[]) => {
    const staged = await (await stage("administrator", { merchantId: m, mode, content: simple(rows) })).json();
    return (await (await commit(staged.data.id, { acceptExcluded: true }, "administrator")).json()).data.revisionId as string;
  };

  it("snapshot deactivates missing SKUs; delta keeps them and upserts the provided rows", async () => {
    m = (await admin.query("insert into merchants (workspace_id, name) values ($1, 'Revision Merchant') returning id", [ws.id])).rows[0].id;
    const r1 = await run("snapshot", ["A,Alpha,1.00,USD", "B,Beta,2.00,USD", "C,Gamma,3.00,USD"]);
    expect(await skusOf(r1, true)).toEqual(["A", "B", "C"]);

    // Snapshot without C: C is inactive in the new revision; B changed; D is new.
    const r2 = await run("snapshot", ["A,Alpha,1.00,USD", "B,Beta Deluxe,2.00,USD", "D,Delta,4.00,USD"]);
    expect(await skusOf(r2, true)).toEqual(["A", "B", "D"]);
    expect(await skusOf(r2, false)).toEqual(["C"]);
    const c2 = (await admin.query("select counts, prior_revision_id from catalog_revisions where id = $1", [r2])).rows[0];
    expect(c2.prior_revision_id).toBe(r1);
    expect(c2.counts).toMatchObject({ active: 3, new: 1, changed: 1, unchanged: 1, deactivated: 1, carriedForward: 0 });

    // Delta with only E and a price-only update of A: B and D are carried forward.
    const r3 = await run("delta", ["A,Alpha,1.50,USD", "E,Epsilon,5.00,USD"]);
    expect(await skusOf(r3, true)).toEqual(["A", "B", "D", "E"]);
    expect(await skusOf(r3, false)).toEqual([]);
    const c3 = (await admin.query("select counts from catalog_revisions where id = $1", [r3])).rows[0].counts;
    expect(c3).toMatchObject({ active: 4, new: 1, changed: 0, unchanged: 1, carriedForward: 2, deactivated: 0 });
    const a = (await admin.query("select lr.price::text from listing_revisions lr join merchant_listings l on l.id = lr.listing_id where lr.catalog_revision_id = $1 and l.merchant_sku = 'A'", [r3])).rows[0];
    expect(a.price).toBe("1.5000");

    // Earlier revisions are untouched and the listing identity is stable across revisions.
    expect(await skusOf(r1, true)).toEqual(["A", "B", "C"]);
    expect(await count("merchant_listings where merchant_id = $1", [m])).toBe(5);
    expect((await admin.query("select active_catalog_revision_id as id from merchants where id = $1", [m])).rows[0].id).toBe(r3);
    const hashes = (await admin.query("select population_hash from catalog_revisions where merchant_id = $1 order by sequence", [m])).rows.map((r) => r.population_hash);
    expect(new Set(hashes).size).toBe(3);
  });
  it("gives every active listing of the new revision exactly one review state", async () => {
    const rows = await admin.query(
      "select count(*)::int as listings, count(rs.id)::int as states from listing_revisions lr left join review_states rs on rs.listing_revision_id = lr.id where lr.active and lr.catalog_revision_id = (select active_catalog_revision_id from merchants where id = $1)",
      [m],
    );
    expect(rows.rows[0]).toEqual({ listings: 4, states: 4 });
  });
});

describe("upload rate limit", () => {
  it("returns 429 after the per-minute limit and does not stage the file", async () => {
    const before = await count("import_jobs where workspace_id = $1", [ws.id]);
    const mine = await count("import_jobs where created_by = $1", [ws.userId.analyst]);
    expect(mine).toBe(0);
    process.env.UPLOAD_RATE_LIMIT_PER_MINUTE = "0";
    try {
      const res = await stage("taxonomist", { content: simple(["Z,Zeta,1.00,USD"]) });
      expect(res.status).toBe(429);
      expect((await res.json()).error.retryable).toBe(true);
    } finally {
      delete process.env.UPLOAD_RATE_LIMIT_PER_MINUTE;
    }
    expect(await count("import_jobs where workspace_id = $1", [ws.id])).toBe(before);
  });
});
