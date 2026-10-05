import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { refreshReport } from "@/lib/domain/analytics";

/** Recomputes with current data. The saved snapshot is kept separately. */
export const POST = route({ capability: "analytics.ask" }, async ({ actor, params, requestId }) => ({ status: 201, data: await refreshReport(actor, uuidParam(params.id, "Report"), requestId) }));
