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
