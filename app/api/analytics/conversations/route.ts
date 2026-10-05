import { route } from "@/lib/api/handler";
import { listConversations } from "@/lib/domain/analytics";

/** The caller's own conversations only. */
export const GET = route({ capability: "analytics.ask" }, async ({ actor }) => ({ data: await listConversations(actor) }));
