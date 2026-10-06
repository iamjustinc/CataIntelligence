import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { emptySchema } from "@/lib/contracts/taxonomy";
import { retryAnalysis } from "@/lib/domain/analysis";
import { kickJobs } from "@/lib/jobs/inline";

export const maxDuration = 60;

export const POST = route({ capability: "analysis.run", body: emptySchema, idempotent: true }, async ({ actor, params, requestId }) => {
  const data = await retryAnalysis(actor, uuidParam(params.id, "Analysis job"), requestId);
  kickJobs("retry");
  return { data };
});
