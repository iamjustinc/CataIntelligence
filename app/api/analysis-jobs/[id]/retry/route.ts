import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { emptySchema } from "@/lib/contracts/taxonomy";
import { retryAnalysis } from "@/lib/domain/analysis";

export const POST = route({ capability: "analysis.run", body: emptySchema, idempotent: true }, async ({ actor, params, requestId }) => ({ data: await retryAnalysis(actor, uuidParam(params.id, "Analysis job"), requestId) }));
