import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { catalogMappingSchema } from "@/lib/contracts/catalog";
import { updateCatalogImportMapping } from "@/lib/domain/catalog-import";

export const PUT = route({ capability: "catalog.import", body: catalogMappingSchema }, async ({ actor, params, body }) => ({
  data: await updateCatalogImportMapping(actor, uuidParam(params.id, "Import"), body),
}));
