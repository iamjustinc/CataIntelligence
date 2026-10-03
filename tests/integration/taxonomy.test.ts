import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as commitRoute } from "@/app/api/taxonomy/imports/[id]/commit/route";
import { POST as stageRoute } from "@/app/api/taxonomy/imports/route";
import { POST as discardRoute } from "@/app/api/taxonomy/versions/[id]/discard/route";
import { POST as publishRoute } from "@/app/api/taxonomy/versions/[id]/publish/route";
import { GET as versionRoute } from "@/app/api/taxonomy/versions/[id]/route";
import { GET as versionsRoute } from "@/app/api/taxonomy/versions/route";
import { closeDb } from "@/db/client";
import { seed, SEED_USERS } from "@/db/seed";
import { WORKSPACE_COOKIE } from "@/lib/auth/actor";
import { adminClient, PASSWORD, request, signIn } from "../setup/helpers";

const FIXTURE = readFileSync(new URL("../../fixtures/generated/taxonomy.csv", import.meta.url), "utf8");
const HEADER = "concept_id,parent_id,name,definition,synonyms,status,mapping_allowed";

let admin: pg.Client;
let demoId: string;
const cookie: Record<string, string> = {};
let keySeq = 0;
const key = () => `taxonomy-test-${++keySeq}`.padEnd(20, "0");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const stage = (who: string, content: string, fileName = "taxonomy.csv") =>
  stageRoute(request("/api/taxonomy/imports", { method: "POST", cookie: cookie[who], body: { fileName, content } }));
const commit = (who: string, id: string, body: unknown = {}, k = key()) =>
  commitRoute(request(`/api/taxonomy/imports/${id}/commit`, { method: "POST", cookie: cookie[who], body, headers: { "idempotency-key": k } }), ctx(id));
const publish = (who: string, id: string, expectedVersion: number, k = key()) =>
  publishRoute(request(`/api/taxonomy/versions/${id}/publish`, { method: "POST", cookie: cookie[who], body: { expectedVersion }, headers: { "idempotency-key": k } }), ctx(id));
const getVersion = (who: string, id: string, q = "") => versionRoute(request(`/api/taxonomy/versions/${id}${q}`, { cookie: cookie[who] }), ctx(id));
const versionCount = async () => (await admin.query("select count(*)::int as n from taxonomy_versions where workspace_id = $1", [demoId])).rows[0].n;

beforeAll(async () => {
  admin = await adminClient();
  ({ demoWorkspaceId: demoId } = await seed(PASSWORD));
  cookie.admin = `${await signIn(SEED_USERS[0].email)}; ${WORKSPACE_COOKIE}=${demoId}`;
  cookie.taxonomist = await signIn(SEED_USERS[1].email);
  cookie.viewer = await signIn(SEED_USERS[3].email);
  cookie.outsider = await signIn(SEED_USERS[4].email);
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

let v1: string;
let v1Lock: number;

describe("taxonomy import (TAX01)", () => {
  it("is restricted to administrators", async () => {
    expect((await stage("taxonomist", FIXTURE)).status).toBe(403);
    expect((await stage("viewer", FIXTURE)).status).toBe(403);
    expect(await versionCount()).toBe(0);
  });

  it("stages an invalid file with row-specific errors and refuses to commit it (AT04)", async () => {
    const bad = `${HEADER}\nR,,Root,,,active,true\nA,B,Alpha,,,active,false\nB,A,Beta,,,active,false\nC,MISSING,Gamma,,,active,true\nC,R,Dup,,,active,true\nD,R,Delta,,,active,true`;
    const res = await stage("admin", bad);
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.status).toBe("failed");
    const found = data.summary.errors.map((e: { row: number; code: string }) => `${e.row}:${e.code}`).sort();
    expect(found).toEqual(["2:mapping_on_non_leaf", "3:cycle", "4:cycle", "5:missing_parent", "6:duplicate_id"]);
    const committed = await commit("admin", data.id);
    expect(committed.status).toBe(422);
    expect(await versionCount()).toBe(0);
  });

  it("rejects malformed and empty files with a recoverable 422", async () => {
    expect((await stage("admin", `${HEADER}\n"R,,Root`)).status).toBe(422);
    expect((await stage("admin", "")).status).toBe(422);
    const missing = await (await stage("admin", "concept_id,name\nA,Alpha")).json();
    expect(missing.data.summary.errors[0].code).toBe("missing_columns");
  });

  it("validates the fixture taxonomy and commits it as a draft exactly once", async () => {
    const staged = await (await stage("admin", FIXTURE, "../../etc/taxonomy.csv")).json();
    expect(staged.data.status).toBe("validated");
    expect(staged.data.fileName).toBe("taxonomy.csv");
    expect(staged.data.summary.counts).toMatchObject({ concepts: 153, mappable: 106 });
    expect(staged.data.summary.diff).toMatchObject({ baseVersionId: null, added: 153, changed: 0, removed: 0 });
    // Staging alone writes nothing to the taxonomy.
    expect(await versionCount()).toBe(0);

    const first = await (await commit("admin", staged.data.id)).json();
    const again = await (await commit("admin", staged.data.id)).json();
    expect(first.data.alreadyCommitted).toBe(false);
    expect(again.data).toEqual({ versionId: first.data.versionId, alreadyCommitted: true });
    expect(await versionCount()).toBe(1);
    v1 = first.data.versionId;
    const rows = await admin.query("select count(*)::int as n from concept_revisions where taxonomy_version_id = $1", [v1]);
    expect(rows.rows[0].n).toBe(153);
    const audit = await admin.query("select action from audit_events where entity_id = $1", [v1]);
    expect(audit.rows.map((r) => r.action)).toEqual(["taxonomy.draft.create"]);
  });

  it("hides the draft from viewers and from other workspaces", async () => {
    const viewerList = await (await versionsRoute(request("/api/taxonomy/versions", { cookie: cookie.viewer }))).json();
    expect(viewerList.data).toEqual({ activeVersionId: null, versions: [] });
    expect((await getVersion("viewer", v1)).status).toBe(404);
    expect((await getVersion("outsider", v1)).status).toBe(404);
    expect((await publish("outsider", v1, 0)).status).toBe(404);
    expect((await getVersion("taxonomist", v1)).status).toBe(200);
    expect((await getVersion("admin", "not-a-uuid")).status).toBe(404);
  });

  it("requires an explicit choice to replace an existing draft", async () => {
    const staged = await (await stage("admin", FIXTURE)).json();
    const blocked = await commit("admin", staged.data.id);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.current.draftVersionId).toBe(v1);
    const replaced = await (await commit("admin", staged.data.id, { replaceDraft: true })).json();
    expect(replaced.data.versionId).toBe(v1);
    expect(await versionCount()).toBe(1);
    const lock = await admin.query("select lock_version from taxonomy_versions where id = $1", [v1]);
    v1Lock = lock.rows[0].lock_version;
    expect(v1Lock).toBe(1);
  });
});

describe("taxonomy publication", () => {
  it("rejects non-administrators and stale versions without changing state (409)", async () => {
    expect((await publish("taxonomist", v1, v1Lock)).status).toBe(403);
    const stale = await publish("admin", v1, v1Lock - 1);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.current).toEqual({ state: "draft", lockVersion: v1Lock });
    const ws = await admin.query("select active_taxonomy_version_id from workspaces where id = $1", [demoId]);
    expect(ws.rows[0].active_taxonomy_version_id).toBeNull();
  });

  it("publishes atomically, activates the version, audits it and replays a repeated request", async () => {
    const k = key();
    const first = await publish("admin", v1, v1Lock, k);
    const repeat = await publish("admin", v1, v1Lock, k);
    expect(first.status).toBe(200);
    const a = await first.json();
    const b = await repeat.json();
    expect(a.data).toMatchObject({ versionId: v1, sequence: 1, state: "published" });
    expect(b.data).toEqual(a.data);
    expect(b.replayed).toBe(true);
    const ws = await admin.query("select active_taxonomy_version_id from workspaces where id = $1", [demoId]);
    expect(ws.rows[0].active_taxonomy_version_id).toBe(v1);
    const audit = await admin.query("select actor_role, after_ref from audit_events where action = 'taxonomy.publish' and entity_id = $1", [v1]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after_ref).toMatchObject({ sequence: 1, concepts: 153, mappable: 106 });
    // A fresh request against an already published version is a conflict, not a second publish.
    expect((await publish("admin", v1, v1Lock + 1)).status).toBe(409);
  });

  it("lets every member read the published version and search it by synonym, definition and ID (TAX02)", async () => {
    const list = await (await versionsRoute(request("/api/taxonomy/versions", { cookie: cookie.viewer }))).json();
    expect(list.data.activeVersionId).toBe(v1);
    const tree = await (await getVersion("viewer", v1)).json();
    expect(tree.data.concepts).toHaveLength(153);
    const byKey = new Map<string, { conceptId: string; mappingAllowed: boolean; path: string }>(tree.data.concepts.map((c: { stableKey: string }) => [c.stableKey, c]));

    const almond = await (await getVersion("viewer", v1, "?q=almond")).json();
    const keys = almond.data.concepts.map((c: { stableKey: string }) => c.stableKey);
    expect(keys).toEqual(expect.arrayContaining(["GRO-DAI-PLANT", "GRO-PAN-NUTS"]));
    for (const c of almond.data.concepts) expect(c.conceptId).toBe(byKey.get(c.stableKey)!.conceptId);
    const byId = await (await getVersion("viewer", v1, "?q=HOU-CLEAN-DISH")).json();
    expect(byId.data.concepts.map((c: { path: string }) => c.path)).toEqual(["All Products > Household > Cleaning Supplies > Dish Soap & Dishwasher Detergent"]);
    expect(byKey.get("GRO-DAI")!.mappingAllowed).toBe(false);
    // LIKE wildcards in user input are literals, not patterns.
    const percent = await (await getVersion("viewer", v1, "?q=%25")).json();
    expect(percent.data.concepts.length).toBeGreaterThan(0);
    for (const c of percent.data.concepts) expect(`${c.path} ${c.definition} ${c.synonyms.join(" ")}`).toContain("%");
    expect((await (await getVersion("viewer", v1, "?q=_")).json()).data.concepts).toHaveLength(0);
  });
});

describe("published versions are immutable; changes go to a new draft", () => {
  let v2: string;
  it("stages a changed file as a diff against the active version and never mutates version 1", async () => {
    const before = await admin.query("select md5(string_agg(name || definition || synonyms::text, '|' order by path)) as h from concept_revisions where taxonomy_version_id = $1", [v1]);
    const changed =
      FIXTURE.replace("Fluid milk from cows, including whole, reduced fat, skim and lactose-free.", "Fluid cow's milk of any fat level.")
        .split("\n")
        .filter((line) => !line.startsWith("GM-SEAS-CARDS,"))
        .join("\n") + "BEV-KOMBUCHA,BEV,Kombucha,Fermented tea beverages.,kombucha,active,true\n";
    const staged = await (await stage("admin", changed)).json();
    expect(staged.data.summary.diff).toMatchObject({ baseVersionId: v1, baseSequence: 1, added: 1, changed: 1, removed: 1, removedKeys: ["GM-SEAS-CARDS"] });
    const committed = await (await commit("admin", staged.data.id)).json();
    v2 = committed.data.versionId;
    expect(v2).not.toBe(v1);

    const after = await admin.query("select md5(string_agg(name || definition || synonyms::text, '|' order by path)) as h from concept_revisions where taxonomy_version_id = $1", [v1]);
    expect(after.rows[0].h).toBe(before.rows[0].h);
    const versions = await admin.query("select sequence, state, base_version_id from taxonomy_versions where workspace_id = $1 order by sequence", [demoId]);
    expect(versions.rows).toEqual([
      { sequence: 1, state: "published", base_version_id: null },
      { sequence: 2, state: "draft", base_version_id: v1 },
    ]);
    // The same stable key keeps the same concept identity across versions.
    const ids = await admin.query(
      "select count(distinct cr.concept_id)::int as n from concept_revisions cr join concepts c on c.id = cr.concept_id where c.stable_key = 'GRO-DAI-MILK' and cr.taxonomy_version_id in ($1, $2)",
      [v1, v2],
    );
    expect(ids.rows[0].n).toBe(1);
    const active = await admin.query("select active_taxonomy_version_id from workspaces where id = $1", [demoId]);
    expect(active.rows[0].active_taxonomy_version_id).toBe(v1);
  });

  it("re-validates the stored tree at publish time and blocks an invalid draft (AT04)", async () => {
    await admin.query(
      "update concept_revisions set mapping_allowed = true where taxonomy_version_id = $1 and concept_id = (select id from concepts where workspace_id = $2 and stable_key = 'GRO-DAI')",
      [v2, demoId],
    );
    const res = await publish("admin", v2, 0);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.fieldErrors[0].path).toBe("GRO-DAI");
    const state = await admin.query("select state from taxonomy_versions where id = $1", [v2]);
    expect(state.rows[0].state).toBe("draft");
  });

  it("discards a draft and allows a new one with the next sequence number", async () => {
    const res = await discardRoute(request(`/api/taxonomy/versions/${v2}/discard`, { method: "POST", cookie: cookie.admin, body: { expectedVersion: 0 }, headers: { "idempotency-key": key() } }), ctx(v2));
    expect(res.status).toBe(200);
    const list = await (await versionsRoute(request("/api/taxonomy/versions", { cookie: cookie.admin }))).json();
    expect(list.data.versions.map((v: { sequence: number }) => v.sequence)).toEqual([1]);
    const staged = await (await stage("admin", FIXTURE)).json();
    expect(staged.data.summary.diff).toMatchObject({ added: 0, changed: 0, removed: 0, unchanged: 153 });
    const committed = await (await commit("admin", staged.data.id)).json();
    const seq = await admin.query("select sequence from taxonomy_versions where id = $1", [committed.data.versionId]);
    expect(seq.rows[0].sequence).toBe(3);
  });
});
