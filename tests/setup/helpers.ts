import pg from "pg";
import { auth } from "@/lib/auth/auth";

export const BASE = "http://localhost:3000";
export const PASSWORD = process.env.SEED_USER_PASSWORD!;

/** Owner connection for assertions about constraints and policies. */
export async function adminClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  return client;
}

/** Signs in through the real auth handler and returns the Cookie header value. */
export async function signIn(email: string): Promise<string> {
  const res = await auth().handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  if (res.status !== 200) throw new Error(`sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export function request(path: string, init: { method?: string; cookie?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}): Request {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (method !== "GET" && headers.origin === undefined) headers.origin = BASE;
  if (init.body !== undefined || init.rawBody !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, { method, headers, body: init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined) });
}

export interface TestWorkspace {
  id: string;
  /** Cookie header per role, pinned to this workspace. */
  cookie: Record<"administrator" | "taxonomist" | "analyst" | "viewer", string>;
  userId: Record<"administrator" | "taxonomist" | "analyst" | "viewer", string>;
}

/**
 * Creates a separate workspace with one user per role, so a test file owns its data and does
 * not depend on the order other files run in.
 */
export async function createTestWorkspace(admin: pg.Client, slug: string): Promise<TestWorkspace> {
  const { hashPassword } = await import("better-auth/crypto");
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  await admin.query("insert into workspaces (id, name, slug, provider_mode, is_demo) values ($1, $2, $3, 'demo', true)", [id, `Test ${slug}`, `${slug}-${id.slice(0, 8)}`]);
  const hash = await hashPassword(PASSWORD);
  const ws: TestWorkspace = { id, cookie: {} as TestWorkspace["cookie"], userId: {} as TestWorkspace["userId"] };
  for (const role of ["administrator", "taxonomist", "analyst", "viewer"] as const) {
    const userId = randomUUID();
    const email = `${role}.${id.slice(0, 8)}@${slug}.test`;
    await admin.query('insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)', [userId, `${slug} ${role}`, email]);
    await admin.query("insert into account (user_id, account_id, provider_id, password) values ($1, $2, 'credential', $3)", [userId, userId, hash]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [id, userId, role]);
    ws.cookie[role] = await signIn(email);
    ws.userId[role] = userId;
  }
  return ws;
}

/** Builds an Actor for direct service calls in tests. */
export async function actorFor(ws: TestWorkspace, role: keyof TestWorkspace["cookie"]) {
  const { resolveActor } = await import("@/lib/auth/actor");
  const actor = await resolveActor({ id: ws.userId[role], email: `${role}@test`, name: role }, ws.id);
  if (!actor) throw new Error("no actor");
  return actor;
}

let keyCounter = 0;
export const idemKey = (label = "test") => `${label}-${Date.now()}-${++keyCounter}`.padEnd(16, "0");
export const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
