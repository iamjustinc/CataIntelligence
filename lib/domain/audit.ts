import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { withContext } from "@/db/client";
import { auditEvents, user } from "@/db/schema";
import { ApiError, forbidden } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";

export interface AuditFilters {
  action?: string | null;
  entityType?: string | null;
  actorId?: string | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number;
}

/** Paginated, newest-first audit events of the workspace (PRD TAX13). */
export async function listAuditEvents(actor: Actor, f: AuditFilters) {
  if (!can(actor.role, "audit.read")) throw forbidden("The audit log is available to taxonomists and administrators.");
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  let cursor: [string, string] | null = null;
  if (f.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(f.cursor, "base64url").toString("utf8"));
      if (!Array.isArray(cursor) || Number.isNaN(Date.parse(cursor[0])) || !/^[0-9a-f-]{36}$/i.test(cursor[1])) throw new Error();
    } catch {
      throw new ApiError("bad_request", "Invalid cursor.");
    }
  }
  const esc = (v: string) => `%${v.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return withContext(actor, async (tx) => {
    const rows = await tx
      .select({
        id: auditEvents.id,
        createdAt: auditEvents.createdAt,
        // Full-precision timestamp for the keyset cursor.
        ts: sql<string>`to_char(${auditEvents.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        actorId: auditEvents.actorId,
        actorName: user.name,
        actorRole: auditEvents.actorRole,
        reason: auditEvents.reason,
        requestId: auditEvents.requestId,
        before: auditEvents.beforeRef,
        after: auditEvents.afterRef,
      })
      .from(auditEvents)
      .leftJoin(user, eq(user.id, auditEvents.actorId))
      .where(
        and(
          f.action ? ilike(auditEvents.action, `${f.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
          f.entityType ? eq(auditEvents.entityType, f.entityType) : undefined,
          f.actorId ? eq(auditEvents.actorId, f.actorId) : undefined,
          f.q?.trim() ? or(ilike(auditEvents.entityId, esc(f.q)), ilike(auditEvents.reason, esc(f.q)), ilike(auditEvents.requestId, esc(f.q)), ilike(auditEvents.action, esc(f.q))) : undefined,
          cursor ? sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const facets = await tx.selectDistinct({ entityType: auditEvents.entityType }).from(auditEvents).orderBy(auditEvents.entityType);
    return {
      items: page,
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.ts, last.id])).toString("base64url") : null,
      entityTypes: facets.map((f) => f.entityType),
    };
  });
}
