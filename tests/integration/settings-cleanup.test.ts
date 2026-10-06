process.env.ANTHROPIC_API_KEY = "sk-test-placeholder-not-a-real-key";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as downloadRoute } from "@/app/api/exports/[id]/route";
import { POST as exportRoute } from "@/app/api/releases/[id]/exports/route";
import { GET as getSettingsRoute, PUT as putSettingsRoute } from "@/app/api/settings/route";
import { GET as meRoute } from "@/app/api/me/route";
import { closeDb } from "@/db/client";
import { WALKTHROUGH_CSV } from "@/fixtures/generate";
import { stageCatalogImport } from "@/lib/domain/catalog-import";
import { previewRelease, publishRelease } from "@/lib/domain/releases";
import { recordDecision } from "@/lib/domain/review";
import { cleanupExpiredObjects } from "@/lib/jobs/cleanup";
import { objectStore } from "@/lib/storage";
import { actorFor, adminClient, createTestWorkspace, ctx, request, type TestWorkspace } from "../setup/helpers";
import { conceptIds, importCatalog, listingIds, publishTaxonomy, runAnalysis } from "../setup/scenario";

let admin: pg.Client;
let ws: TestWorkspace;
let other: TestWorkspace;
type Role = keyof TestWorkspace["cookie"];
const get = (role: Role, w = ws) => getSettingsRoute(request("/api/settings", { cookie: w.cookie[role] }));
const put = (body: unknown, role: Role = "administrator") => putSettingsRoute(request("/api/settings", { method: "PUT", cookie: ws.cookie[role], body }));
const base = { providerMode: "demo", liveAiOptIn: false, aiModelId: null, inputPricePerMtok: null, outputPricePerMtok: null, jobTokenCap: 400000, jobSpendCapUsd: 5, dailySpendCapUsd: 20, jobItemCap: 5000 };

beforeAll(async () => {
  admin = await adminClient();
  ws = await createTestWorkspace(admin, "settings");
  other = await createTestWorkspace(admin, "settings-other");
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

describe("workspace settings (provider mode, model and budgets)", () => {
  it("is available to administrators only and never returns the API key", async () => {
    for (const role of ["taxonomist", "analyst", "viewer"] as const) expect((await get(role)).status, role).toBe(403);
    const res = await get("administrator");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("sk-test-placeholder");
    const { data } = JSON.parse(text);
    expect(data).toMatchObject({ providerMode: "demo", providerKeyConfigured: true, highSignalEnabled: false, status: { state: "demo", label: "Demo AI" } });
    expect(data.fieldsSentToProvider).toContain("title");
    const me = await (await meRoute(request("/api/me", { cookie: ws.cookie.viewer }))).text();
    expect(me).not.toContain("sk-test-placeholder");
  });
  it("validates input, checks the version and audits the change without secrets", async () => {
    expect((await put({ ...base, expectedVersion: 0 }, "taxonomist")).status).toBe(403);
    expect((await put({ ...base, jobTokenCap: 5, expectedVersion: 0 })).status).toBe(400);
    expect((await put({ ...base, aiModelId: "bad model id!", expectedVersion: 0 })).status).toBe(400);
    expect((await put({ ...base, apiKey: "sk-should-not-be-accepted", expectedVersion: 0 })).status).toBe(400);
    expect((await put({ ...base, expectedVersion: 7 })).status).toBe(409);

    const res = await put({ ...base, providerMode: "live", aiModelId: "claude-opus-5-5", inputPricePerMtok: 4, outputPricePerMtok: 20, jobSpendCapUsd: 2.5, expectedVersion: 0 });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    // Live mode is selected but an administrator has not opted in to sending catalog fields.
    expect(data).toMatchObject({ lockVersion: 1, providerMode: "live", effectiveModelId: "claude-opus-5-5", inputPricePerMtok: 4, jobSpendCapUsd: 2.5, status: { state: "unavailable", label: "AI unavailable" } });
    const optedIn = (await (await put({ ...base, providerMode: "live", liveAiOptIn: true, aiModelId: "claude-opus-5-5", expectedVersion: 1 })).json()).data;
    expect(optedIn.status).toMatchObject({ state: "live", label: "Live AI", detail: "Model claude-opus-5-5" });
    // The stale page that still holds version 0 cannot overwrite the newer settings.
    expect((await put({ ...base, expectedVersion: 0 })).status).toBe(409);

    const audit = (await admin.query("select before_ref, after_ref from audit_events where workspace_id = $1 and action = 'workspace.settings.update' order by created_at", [ws.id])).rows;
    expect(audit).toHaveLength(2);
    expect(audit[0].before_ref.providerMode).toBe("demo");
    expect(audit[0].after_ref).toMatchObject({ providerMode: "live", aiModelId: "claude-opus-5-5" });
    expect(JSON.stringify(audit)).not.toMatch(/sk-|api[_-]?key/i);
    expect((await get("administrator", other)).status).toBe(200);
    expect((await (await get("administrator", other)).json()).data.providerMode).toBe("demo");
  });
  it("switching provider mode does not rewrite existing recommendations", async () => {
    await put({ ...base, providerMode: "demo", expectedVersion: 2 });
    await publishTaxonomy(ws);
    const { revisionId } = await importCatalog(ws, { merchantName: "Pier Pantry", content: WALKTHROUGH_CSV, resolutions: { "PP-004": 5 } });
    await runAnalysis(ws, revisionId);
    const before = (await admin.query("select id, provider, is_demo from recommendations where workspace_id = $1 order by id", [ws.id])).rows;
    expect(before).toHaveLength(9);
    await put({ ...base, providerMode: "off", expectedVersion: 3 });
    await put({ ...base, providerMode: "live", liveAiOptIn: true, aiModelId: "claude-opus-5-5", expectedVersion: 4 });
    expect((await admin.query("select id, provider, is_demo from recommendations where workspace_id = $1 order by id", [ws.id])).rows).toEqual(before);
    await put({ ...base, providerMode: "demo", expectedVersion: 5 });
  });
});

describe("cleanup of expired storage objects (PRD 14.5)", () => {
  it("deletes uncommitted staged files after 24 hours and export objects after 7 days, and nothing else", async () => {
    const reviewer = await actorFor(ws, "taxonomist");
    const adminActor = await actorFor(ws, "administrator");
    const merchant = (await admin.query("select id, active_catalog_revision_id as rev from merchants where workspace_id = $1", [ws.id])).rows[0];
    const staged = async (label: string) => stageCatalogImport(reviewer, { merchantId: merchant.id, fileName: `${label}.csv`, content: `merchant_sku,title\n${label},Thing ${label}\n`, mode: "delta", createNewRevision: true }, "test");
    const oldStaged = await staged("OLD-1");
    const freshStaged = await staged("NEW-1");
    const committed = (await admin.query("select id, staged_file_key from import_jobs where workspace_id = $1 and status = 'committed' and kind = 'catalog'", [ws.id])).rows[0];

    // A release to export.
    const L = await listingIds(admin, merchant.rev);
    const C = await conceptIds(admin, ws.id);
    await recordDecision(reviewer, L["PP-001"], { action: "change", selectedConceptId: C["GRO-DAI-MILK"] === undefined ? null : C["GRO-DAI-PLANT"], reason: "test", expectedVersion: 1 }, "test");
    const p = await previewRelease(adminActor, merchant.id);
    const release = await publishRelease(adminActor, { merchantId: merchant.id, catalogRevisionId: p.catalogRevision!.id, taxonomyVersionId: p.taxonomyVersion!.id, reason: "cleanup test", acknowledgePartial: true, expectedMapped: p.mapped, expectedUnresolved: p.unresolved }, "cleanup-test-key-1", "test");
    const makeExport = async () => (await (await exportRoute(request(`/api/releases/${release.releaseId}/exports`, { method: "POST", cookie: ws.cookie.viewer, body: { kind: "mapping" } }), ctx(release.releaseId))).json()).data;
    const oldExport = await makeExport();
    const freshExport = await makeExport();

    await admin.query("update import_jobs set created_at = now() - interval '25 hours' where id = any($1)", [[oldStaged.id, committed.id]]);
    await admin.query("update export_files set created_at = now() - interval '8 days' where id = $1", [oldExport.exportId]);
    const keys = (await admin.query("select id, staged_file_key as key from import_jobs where id = any($1) union all select id, storage_key from export_files where id = any($2)", [[oldStaged.id, freshStaged.id], [oldExport.exportId, freshExport.exportId]])).rows;
    const keyOf = (id: string) => keys.find((k) => k.id === id)!.key as string;
    const exists = (key: string) => objectStore().get(ws.id, key).then(() => true, () => false);

    const result = await cleanupExpiredObjects();
    expect(result).toMatchObject({ imports: 1, exports: 1, errors: 0 });
    expect(await exists(keyOf(oldStaged.id))).toBe(false);
    expect(await exists(keyOf(oldExport.exportId))).toBe(false);
    // Fresh objects and the committed import's source file are retained.
    expect(await exists(keyOf(freshStaged.id))).toBe(true);
    expect(await exists(keyOf(freshExport.exportId))).toBe(true);
    expect(await exists(committed.staged_file_key)).toBe(true);

    const rows = (await admin.query("select status, staged_file_key from import_jobs where id = $1", [oldStaged.id])).rows[0];
    expect(rows).toEqual({ status: "expired", staged_file_key: null });
    expect((await admin.query("select deleted_at is not null as deleted from export_files where id = $1", [oldExport.exportId])).rows[0].deleted).toBe(true);
    expect((await downloadRoute(request(oldExport.downloadUrl, { cookie: ws.cookie.viewer }), ctx(oldExport.exportId))).status).toBe(404);
    expect((await downloadRoute(request(freshExport.downloadUrl, { cookie: ws.cookie.viewer }), ctx(freshExport.exportId))).status).toBe(200);
    // The release itself and its records are untouched, and a new export can always be created.
    expect((await makeExport()).rowCounts).toEqual(freshExport.rowCounts);
    // Running it again finds nothing more to delete.
    expect(await cleanupExpiredObjects()).toEqual({ imports: 0, exports: 0, errors: 0 });
  });
});

describe("database object store (STORAGE_DRIVER=database, for hosts without a shared disk)", () => {
  it("stores, returns and removes bytes, and keeps workspaces apart", async () => {
    const { withContext } = await import("@/db/client");
    const { storedObjects } = await import("@/db/schema");
    const { DatabaseObjectStore } = await import("@/lib/storage");
    const { adminClient, createTestWorkspace } = await import("../setup/helpers");
    const owner = await adminClient();
    try {
      const a = await createTestWorkspace(owner, "store-a");
      const b = await createTestWorkspace(owner, "store-b");
      const store = new DatabaseObjectStore();
      const bytes = new Uint8Array([0, 255, 10, 13, 0, 80, 75, 3, 4]);
      const key = await store.put(a.id, "exports", "zip", bytes);
      expect(key).toMatch(new RegExp(`^${a.id}/exports/[0-9a-f-]{36}\\.zip$`));
      expect(new Uint8Array(await store.get(a.id, key))).toEqual(bytes);
      const csv = "merchant_sku,title\nA-1,Café “crème”\n";
      expect((await store.get(a.id, await store.put(a.id, "imports", "csv", csv))).toString("utf8")).toBe(csv);

      // Another workspace cannot address the object by key, and row-level security hides the rows.
      await expect(store.get(b.id, key)).rejects.toThrow(/does not belong to this workspace/);
      await expect(store.remove(b.id, key)).rejects.toThrow(/does not belong to this workspace/);
      expect(await withContext({ workspaceId: b.id }, (tx) => tx.select({ key: storedObjects.key }).from(storedObjects))).toEqual([]);
      expect(await withContext({}, (tx) => tx.select({ key: storedObjects.key }).from(storedObjects))).toEqual([]);
      expect((await owner.query("select count(*)::int as n from stored_objects where workspace_id = $1", [a.id])).rows[0].n).toBe(2);

      await store.remove(a.id, key);
      await expect(store.get(a.id, key)).rejects.toThrow(/not found/);
      await store.remove(a.id, key); // removing twice is not an error
    } finally {
      await owner.end();
    }
  });
});
