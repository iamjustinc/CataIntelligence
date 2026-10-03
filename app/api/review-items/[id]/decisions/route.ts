import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { decisionSchema } from "@/lib/contracts/review";
import { recordDecision } from "@/lib/domain/review";

export const POST = route({ capability: "review.decide", body: decisionSchema, idempotent: true }, async ({ actor, params, body, requestId }) => ({
  status: 201,
  data: await recordDecision(actor, uuidParam(params.id, "Listing"), body, requestId),
}));
