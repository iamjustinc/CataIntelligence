import { eq, sql } from "drizzle-orm";
import { withContext } from "@/db/client";
import { merchants } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { conflict, forbidden, notFound } from "@/lib/api/errors";
import type { CreateMerchantInput } from "@/lib/contracts/merchant";

export async function listMerchants(actor: Actor) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  return withContext(actor, (tx) => tx.select().from(merchants).orderBy(sql`lower(${merchants.name})`));
}

export async function getMerchant(actor: Actor, merchantId: string) {
  if (!can(actor.role, "catalog.read")) throw forbidden();
  const [row] = await withContext(actor, (tx) => tx.select().from(merchants).where(eq(merchants.id, merchantId)));
  if (!row) throw notFound("Merchant");
  return row;
}

export async function createMerchant(actor: Actor, input: CreateMerchantInput, requestId: string) {
  if (!can(actor.role, "catalog.import")) throw forbidden();
  return withContext(actor, async (tx) => {
    const [row] = await tx
      .insert(merchants)
      .values({
        workspaceId: actor.workspaceId,
        name: input.name,
        externalKey: input.externalKey ?? null,
        region: input.region ?? null,
        createdBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict("A merchant with this name or external key already exists in the workspace.");
    await recordAudit(tx, actor, requestId, {
      action: "merchant.create",
      entityType: "merchant",
      entityId: row.id,
      after: { name: row.name, externalKey: row.externalKey, region: row.region },
    });
    return row;
  });
}
