import type { Tx } from "@/db/client";
import { auditEvents } from "@/db/schema";
import type { Actor } from "@/lib/auth/actor";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Appends an audit event inside the caller's transaction so the event and the change it
 * describes commit or roll back together (PRD TAX13).
 */
export async function recordAudit(tx: Tx, actor: Actor, requestId: string, input: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    actorRole: actor.role,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    beforeRef: input.before ?? null,
    afterRef: input.after ?? null,
    reason: input.reason ?? null,
    requestId,
  });
}
