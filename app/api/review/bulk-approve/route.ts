import { route } from "@/lib/api/handler";
import { bulkApproveSchema } from "@/lib/contracts/review";
import { bulkApprove } from "@/lib/domain/review";

export const POST = route({ capability: "review.decide", body: bulkApproveSchema, idempotent: true }, async ({ actor, body, requestId }) => ({
  data: await bulkApprove(actor, body.items, requestId),
}));
