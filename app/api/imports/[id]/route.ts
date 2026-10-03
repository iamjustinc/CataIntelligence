import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { getCatalogImport } from "@/lib/domain/catalog-import";

export const GET = route({ capability: "catalog.read" }, async ({ actor, params }) => ({ data: await getCatalogImport(actor, uuidParam(params.id, "Import")) }));
