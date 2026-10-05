import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { getConversation } from "@/lib/domain/analytics";

export const GET = route({ capability: "analytics.ask" }, async ({ actor, params }) => ({ data: await getConversation(actor, uuidParam(params.id, "Conversation")) }));
