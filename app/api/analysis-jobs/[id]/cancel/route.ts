import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { emptySchema } from "@/lib/contracts/taxonomy";
import { cancelAnalysis } from "@/lib/domain/analysis";

export const POST = route({ capability: "analysis.run", body: emptySchema }, async ({ actor, params, requestId }) => ({ data: await cancelAnalysis(actor, uuidParam(params.id, "Analysis job"), requestId) }));
