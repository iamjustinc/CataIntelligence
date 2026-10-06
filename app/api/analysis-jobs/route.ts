import { route } from "@/lib/api/handler";
import { startAnalysisSchema } from "@/lib/contracts/review";
import { startAnalysis } from "@/lib/domain/analysis";
import { kickJobs } from "@/lib/jobs/inline";

/** Time allowed for jobs processed after the response when JOB_RUNNER=inline. */
export const maxDuration = 60;

/**
 * Queues the job and returns at once. The worker process does the analysis; where there is no
 * worker (JOB_RUNNER=inline), this function processes the queue after responding.
 */
export const POST = route({ capability: "analysis.run", body: startAnalysisSchema, idempotent: true }, async ({ actor, body, requestId }) => {
  const data = await startAnalysis(actor, body, requestId);
  kickJobs("start");
  return { status: 202, data };
});
