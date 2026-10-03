import { route } from "@/lib/api/handler";
import { startAnalysisSchema } from "@/lib/contracts/review";
import { startAnalysis } from "@/lib/domain/analysis";

export const POST = route({ capability: "analysis.run", body: startAnalysisSchema, idempotent: true }, async ({ actor, body, requestId }) => ({
  status: 202,
  data: await startAnalysis(actor, body, requestId),
}));
