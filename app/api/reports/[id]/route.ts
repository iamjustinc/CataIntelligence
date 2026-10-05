import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { reportVisibilitySchema } from "@/lib/contracts/analytics";
import { deleteReport, getReport, setReportVisibility } from "@/lib/domain/analytics";

export const GET = route({ capability: "analytics.ask" }, async ({ actor, params }) => ({ data: await getReport(actor, uuidParam(params.id, "Report")) }));

/** Sharing is explicit and limited to roles with report.share. */
export const PATCH = route({ capability: "report.share", body: reportVisibilitySchema }, async ({ actor, params, body, requestId }) => ({
  data: await setReportVisibility(actor, uuidParam(params.id, "Report"), body, requestId),
}));

export const DELETE = route({ capability: "analytics.ask" }, async ({ actor, params, requestId }) => ({ data: await deleteReport(actor, uuidParam(params.id, "Report"), requestId) }));
