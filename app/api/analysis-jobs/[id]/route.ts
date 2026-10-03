import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { getAnalysisJob } from "@/lib/domain/analysis";

export const GET = route({ capability: "catalog.read" }, async ({ actor, params }) => ({ data: await getAnalysisJob(actor, uuidParam(params.id, "Analysis job")) }));
