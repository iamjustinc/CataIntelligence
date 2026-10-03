import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getMe } from "@/app/api/me/route";
import { GET as getMembers } from "@/app/api/members/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/merchants/route";
import { POST as switchWorkspace } from "@/app/api/workspaces/active/route";
import { closeDb } from "@/db/client";
import { seed, SEED_USERS } from "@/db/seed";
import { WORKSPACE_COOKIE } from "@/lib/auth/actor";
import { adminClient, PASSWORD, request, signIn } from "../setup/helpers";

let admin: pg.Client;
let demoId: string;
let sandboxId: string;
const cookie: Record<string, string> = {};

beforeAll(async () => {
  admin = await adminClient();
  ({ demoWorkspaceId: demoId, sandboxWorkspaceId: sandboxId } = await seed(PASSWORD));
  // Avery belongs to two workspaces; pin the demo workspace explicitly.
  cookie.admin = `${await signIn(SEED_USERS[0].email)}; ${WORKSPACE_COOKIE}=${demoId}`;
  cookie.taxonomist = await signIn(SEED_USERS[1].email);
  cookie.analyst = await signIn(SEED_USERS[2].email);
  cookie.viewer = await signIn(SEED_USERS[3].email);
  cookie.outsider = await signIn(SEED_USERS[4].email);
  averyInSandbox = cookie.admin.replace(demoId, sandboxId);
});
afterAll(async () => {
  await admin.end();
  await closeDb();
});

const withWorkspace = (c: string, id: string) => `${c}; ${WORKSPACE_COOKIE}=${id}`;
let averyInSandbox: string;

describe("authentication", () => {
  it("rejects requests without a session with 401 and a request ID", async () => {
    const res = await listRoute(request("/api/merchants"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
  });
  it("rejects a forged session cookie", async () => {
    const res = await listRoute(request("/api/merchants", { cookie: "ci.session_token=forged.signature" }));
    expect(res.status).toBe(401);
  });
  it("rejects a wrong password and has no public sign-up", async () => {
    const { auth } = await import("@/lib/auth/auth");
    const bad = await auth().handler(
      request("/api/auth/sign-in/email", { method: "POST", body: { email: SEED_USERS[0].email, password: "definitely-wrong-password" } }),
    );
    expect(bad.status).toBe(401);
    const signUp = await auth().handler(
      request("/api/auth/sign-up/email", { method: "POST", body: { email: "new@example.test", password: "a-long-enough-password", name: "New" } }),
    );
    expect(signUp.status).toBeGreaterThanOrEqual(400);
    const users = await admin.query('select count(*)::int as n from "user" where email = $1', ["new@example.test"]);
    expect(users.rows[0].n).toBe(0);
  });
});

describe("workspace isolation through the API", () => {
  it("returns only the member's workspace data", async () => {
    const res = await listRoute(request("/api/merchants", { cookie: cookie.viewer }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(3);
    expect(data.every((m: { workspaceId: string }) => m.workspaceId === demoId)).toBe(true);
  });
  it("ignores a forged workspace cookie for a non-member workspace", async () => {
    const res = await getMe(request("/api/me", { cookie: withWorkspace(cookie.taxonomist, sandboxId) }));
    const { data } = await res.json();
    expect(data.workspace.id).toBe(demoId);
    expect(data.workspaces).toHaveLength(1);
    const outsider = await listRoute(request("/api/merchants", { cookie: withWorkspace(cookie.outsider, demoId) }));
    expect((await outsider.json()).data).toEqual([]);
  });
  it("refuses to switch to a workspace without membership, with 404", async () => {
    const res = await switchWorkspace(request("/api/workspaces/active", { method: "POST", cookie: cookie.taxonomist, body: { workspaceId: sandboxId } }));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("switches workspace for a real member and applies that workspace's role", async () => {
    const res = await switchWorkspace(request("/api/workspaces/active", { method: "POST", cookie: cookie.admin, body: { workspaceId: sandboxId } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${WORKSPACE_COOKIE}=${sandboxId}`);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
    const me = await (await getMe(request("/api/me", { cookie: averyInSandbox }))).json();
    expect(me.data.role).toBe("viewer");
    expect(me.data.capabilities).not.toContain("catalog.import");
    // Administrator in the demo workspace, but only a viewer here: creation must be refused.
    const create = await createRoute(
      request("/api/merchants", { method: "POST", cookie: averyInSandbox, body: { name: "Should Not Exist" }, headers: { "idempotency-key": "switch-role-0001" } }),
    );
    expect(create.status).toBe(403);
  });
});

describe("authorization, validation and idempotency", () => {
  it("denies role-restricted actions with 403 and performs no write", async () => {
    for (const who of ["viewer", "analyst"]) {
      const res = await createRoute(request("/api/merchants", { method: "POST", cookie: cookie[who], body: { name: `Denied ${who}` }, headers: { "idempotency-key": `denied-${who}-0001` } }));
      expect(res.status, who).toBe(403);
    }
    const rows = await admin.query("select count(*)::int as n from merchants where name like 'Denied %'");
    expect(rows.rows[0].n).toBe(0);
    expect((await getMembers(request("/api/members", { cookie: cookie.taxonomist }))).status).toBe(403);
    expect((await getMembers(request("/api/members", { cookie: cookie.admin }))).status).toBe(200);
  });
  it("rejects cross-origin and origin-less mutations", async () => {
    const cross = await createRoute(request("/api/merchants", { method: "POST", cookie: cookie.admin, body: { name: "CSRF" }, headers: { origin: "https://evil.example", "idempotency-key": "csrf-000001" } }));
    expect(cross.status).toBe(403);
    const none = await createRoute(request("/api/merchants", { method: "POST", cookie: cookie.admin, body: { name: "CSRF" }, headers: { origin: "", "idempotency-key": "csrf-000002" } }));
    expect(none.status).toBe(403);
  });
  it("returns 400 with field errors for malformed or unexpected input", async () => {
    const headers = { "idempotency-key": "validation-0001" };
    const malformed = await createRoute(request("/api/merchants", { method: "POST", cookie: cookie.admin, rawBody: "{not json", headers }));
    expect(malformed.status).toBe(400);
    const extra = await createRoute(request("/api/merchants", { method: "POST", cookie: cookie.admin, body: { name: "Ok", workspaceId: sandboxId }, headers }));
    expect(extra.status).toBe(400);
    const empty = await createRoute(request("/api/merchants", { method: "POST", cookie: cookie.admin, body: { name: "   " }, headers }));
    const body = await empty.json();
    expect(empty.status).toBe(400);
    expect(body.error.fieldErrors[0].path).toBe("name");
    expect(JSON.stringify(body)).not.toMatch(/stack|at .*\.ts/);
  });
  it("requires an idempotency key and replays the stored response for a repeat", async () => {
    const missing = await createRoute(request("/api/merchants", { method: "POST", cookie: cookie.taxonomist, body: { name: "Pier Pantry" } }));
    expect(missing.status).toBe(400);

    const send = (body: unknown) => createRoute(request("/api/merchants", { method: "POST", cookie: cookie.taxonomist, body, headers: { "idempotency-key": "merchant-pier-0001" } }));
    const first = await send({ name: "Pier Pantry", region: "US-West" });
    const second = await send({ name: "Pier Pantry", region: "US-West" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = await first.json();
    const b = await second.json();
    expect(b.data.id).toBe(a.data.id);
    expect(b.replayed).toBe(true);
    const rows = await admin.query("select count(*)::int as n from merchants where name = 'Pier Pantry' and workspace_id = $1", [demoId]);
    const audits = await admin.query("select count(*)::int as n from audit_events where entity_id = $1", [a.data.id]);
    expect(rows.rows[0].n).toBe(1);
    expect(audits.rows[0].n).toBe(1);

    const reused = await send({ name: "Something Else" });
    expect(reused.status).toBe(409);
  });
  it("reports a duplicate merchant name as 409", async () => {
    const res = await createRoute(request("/api/merchants", { method: "POST", cookie: cookie.admin, body: { name: "harbor market" }, headers: { "idempotency-key": "dup-harbor-0001" } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("conflict");
  });
  it("reports the provider as labeled demo for the demo workspace and off elsewhere", async () => {
    const demo = await (await getMe(request("/api/me", { cookie: cookie.admin }))).json();
    expect(demo.data.provider).toMatchObject({ state: "demo", label: "Demo AI" });
    const sandbox = await (await getMe(request("/api/me", { cookie: cookie.outsider }))).json();
    expect(sandbox.data.provider.state).toBe("off");
  });
});
