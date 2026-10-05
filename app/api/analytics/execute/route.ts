import { route } from "@/lib/api/handler";
import { executeSchema } from "@/lib/contracts/analytics";
import { executeAnalysis } from "@/lib/domain/analytics";

/** Validates a spec against the metric registry and runs it. The workspace comes from the session. */
export const POST = route({ capability: "analytics.ask", body: executeSchema }, async ({ actor, body }) => ({ status: 201, data: await executeAnalysis(actor, body) }));
