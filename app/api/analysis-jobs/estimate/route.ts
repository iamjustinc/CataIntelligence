import { route } from "@/lib/api/handler";
import { startAnalysisSchema } from "@/lib/contracts/review";
import { estimateAnalysis } from "@/lib/domain/analysis";

export const POST = route({ capability: "analysis.run", body: startAnalysisSchema }, async ({ actor, body }) => ({ data: await estimateAnalysis(actor, body) }));
