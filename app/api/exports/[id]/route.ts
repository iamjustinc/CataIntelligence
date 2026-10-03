import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { readExport } from "@/lib/domain/releases";

/** Authorized download of a private export object. */
export const GET = route({ capability: "catalog.read" }, async ({ actor, params }) => {
  const file = await readExport(actor, uuidParam(params.id, "Export"));
  return {
    data: null,
    raw: new Response(new Uint8Array(file.content), {
      headers: { "content-type": file.contentType, "content-disposition": `attachment; filename="${file.fileName}"`, "x-content-type-options": "nosniff" },
    }),
  };
});
