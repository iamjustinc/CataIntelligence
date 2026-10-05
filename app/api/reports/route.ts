import { route } from "@/lib/api/handler";
import { saveReportSchema } from "@/lib/contracts/analytics";
import { listReports, saveReport } from "@/lib/domain/analytics";

export const GET = route({ capability: "analytics.ask" }, async ({ actor }) => ({ data: await listReports(actor) }));

export const POST = route({ capability: "analytics.ask", body: saveReportSchema, idempotent: true }, async ({ actor, body, requestId }) => ({ status: 201, data: await saveReport(actor, body, requestId) }));
