import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { withContext } from "@/db/client";
import { idempotencyKeys } from "@/db/schema";
import { getSessionUser, readCookie, resolveActor, WORKSPACE_COOKIE, type Actor } from "@/lib/auth/actor";
import { can, type Capability } from "@/lib/auth/permissions";
import { env } from "@/lib/env";
import { ApiError, forbidden, type FieldError } from "./errors";

export interface HandlerContext<B> {
  req: Request;
  actor: Actor;
  body: B;
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
}

export interface HandlerResult {
  status?: number;
  data: unknown;
  /** Extra response headers, e.g. Set-Cookie. */
  headers?: Record<string, string>;
}

interface RouteOptions<S extends z.ZodType | undefined> {
  /** Capability required by the role matrix. Every route must declare one. */
  capability: Capability;
  /** Schema for the JSON body. Unknown or malformed input is rejected with 400. */
  body?: S;
  /** Require an Idempotency-Key header and replay the stored response for repeats. */
  idempotent?: boolean;
}

type Body<S> = S extends z.ZodType ? z.infer<S> : undefined;

function json(status: number, payload: unknown, requestId: string, extra: Record<string, string> = {}): Response {
  return Response.json(payload, { status, headers: { ...extra, "x-request-id": requestId, "cache-control": "no-store" } });
}

export function errorResponse(err: unknown, requestId: string): Response {
  if (err instanceof ApiError) {
    return json(
      err.status,
      {
        error: {
          code: err.code,
          message: err.message,
          retryable: err.options.retryable ?? false,
          fieldErrors: err.options.fieldErrors ?? [],
          ...(err.options.current !== undefined ? { current: err.options.current } : {}),
        },
        requestId,
      },
      requestId,
    );
  }
  // Never leak stack traces, SQL or provider details (PRD section 15).
  console.error(JSON.stringify({ level: "error", requestId, message: err instanceof Error ? err.message : String(err) }));
  return json(
    500,
    { error: { code: "internal", message: "Something went wrong. Try again.", retryable: true, fieldErrors: [] }, requestId },
    requestId,
  );
}

/** Cookie-authenticated mutations must originate from this application (CSRF defence in depth). */
function assertSameOrigin(req: Request): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (!origin) throw new ApiError("forbidden", "Missing Origin header on a state-changing request.");
  const allowed = new Set([new URL(env().APP_BASE_URL).origin, new URL(req.url).origin]);
  if (!allowed.has(origin)) throw new ApiError("forbidden", "Cross-origin request rejected.");
}

async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError("bad_request", "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: FieldError[] = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new ApiError("bad_request", "Request body failed validation.", { fieldErrors });
  }
  return parsed.data;
}

/**
 * Wraps an API route with the cross-cutting rules from PRD section 15: session identity,
 * server-derived workspace and role, capability check, schema validation, request IDs,
 * safe errors and optional idempotent replay.
 */
export function route<S extends z.ZodType | undefined = undefined>(
  options: RouteOptions<S>,
  handler: (ctx: HandlerContext<Body<S>>) => Promise<HandlerResult>,
) {
  return async (req: Request, routeCtx?: { params?: Promise<Record<string, string | string[] | undefined>> }): Promise<Response> => {
    const requestId = randomUUID();
    try {
      assertSameOrigin(req);
      const user = await getSessionUser(req.headers);
      if (!user) throw new ApiError("unauthenticated", "Sign in to continue.");
      const actor = await resolveActor(user, readCookie(req.headers, WORKSPACE_COOKIE));
      if (!actor) throw forbidden("You are not a member of any workspace.");
      if (!can(actor.role, options.capability)) throw forbidden();

      const rawParams = (await routeCtx?.params) ?? {};
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawParams)) if (typeof v === "string") params[k] = v;

      const body = (options.body ? await parseBody(req, options.body) : undefined) as Body<S>;
      const ctx: HandlerContext<Body<S>> = { req, actor, body, params, query: new URL(req.url).searchParams, requestId };

      if (!options.idempotent) {
        const result = await handler(ctx);
        return json(result.status ?? 200, { data: result.data, requestId }, requestId, result.headers);
      }
      return await runIdempotent(ctx, handler);
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

async function runIdempotent<B>(ctx: HandlerContext<B>, handler: (ctx: HandlerContext<B>) => Promise<HandlerResult>): Promise<Response> {
  const { req, actor, requestId } = ctx;
  const key = req.headers.get("idempotency-key");
  if (!key || key.length < 8 || key.length > 200) {
    throw new ApiError("bad_request", "An Idempotency-Key header (8 to 200 characters) is required.");
  }
  const scope = `${req.method} ${new URL(req.url).pathname}`;
  const requestHash = createHash("sha256").update(JSON.stringify(ctx.body ?? null)).digest("hex");
  const where = and(eq(idempotencyKeys.workspaceId, actor.workspaceId), eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key));

  const replay = async (): Promise<Response | null> => {
    const [stored] = await withContext(actor, (tx) => tx.select().from(idempotencyKeys).where(where));
    if (!stored) return null;
    if (stored.requestHash !== requestHash || stored.actorId !== actor.userId) {
      throw new ApiError("conflict", "This Idempotency-Key was already used with a different request.");
    }
    return json(stored.statusCode, { data: stored.response, requestId, replayed: true }, requestId);
  };

  const existing = await replay();
  if (existing) return existing;

  const result = await handler(ctx);
  const status = result.status ?? 200;
  const inserted = await withContext(actor, (tx) =>
    tx
      .insert(idempotencyKeys)
      .values({ workspaceId: actor.workspaceId, scope, key, actorId: actor.userId, requestHash, statusCode: status, response: result.data ?? null })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key }),
  );
  // A concurrent duplicate stored its response first: return that one so both callers agree.
  if (inserted.length === 0) return (await replay()) ?? json(status, { data: result.data, requestId }, requestId);
  return json(status, { data: result.data, requestId }, requestId);
}
