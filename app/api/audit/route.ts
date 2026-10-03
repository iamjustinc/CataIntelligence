import { route } from "@/lib/api/handler";
import { listAuditEvents } from "@/lib/domain/audit";

export const GET = route({ capability: "audit.read" }, async ({ actor, query }) => {
  const actorId = query.get("actor");
  return {
    data: await listAuditEvents(actor, {
      action: query.get("action")?.slice(0, 80),
      entityType: query.get("entityType")?.slice(0, 80),
      actorId: actorId && /^[0-9a-f-]{36}$/i.test(actorId) ? actorId : null,
      q: query.get("q")?.slice(0, 200),
      cursor: query.get("cursor"),
      limit: Number(query.get("limit") ?? 50) || 50,
    }),
  };
});
