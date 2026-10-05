import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { exportRunCsv } from "@/lib/domain/analytics";

/** Spreadsheet-safe CSV of a run the caller may read: their own, or one behind a shared report. */
export const GET = route({ capability: "analytics.ask" }, async ({ actor, params, requestId }) => {
  const file = await exportRunCsv(actor, uuidParam(params.id, "Analysis run"), requestId);
  return {
    data: null,
    raw: new Response(file.content, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file.fileName}"`, "x-content-type-options": "nosniff" } }),
  };
});
