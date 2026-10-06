import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { getAnalysisJob } from "@/lib/domain/analysis";
import { kickJobs } from "@/lib/jobs/inline";

export const maxDuration = 60;

export const GET = route({ capability: "catalog.read" }, async ({ actor, params }) => {
  const data = await getAnalysisJob(actor, uuidParam(params.id, "Analysis job"));
  // Without a worker, each status poll of an unfinished job resumes it if its previous run was cut off.
  if (["queued", "running", "cancel_requested"].includes(data.status)) kickJobs("poll");
  return { data };
});
