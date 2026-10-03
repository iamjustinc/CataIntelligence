import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { commitCatalogImportSchema } from "@/lib/contracts/catalog";
import { commitCatalogImport } from "@/lib/domain/catalog-import";

export const POST = route({ capability: "catalog.import", body: commitCatalogImportSchema, idempotent: true }, async ({ actor, params, body, requestId }) => ({
  data: await commitCatalogImport(actor, uuidParam(params.id, "Import"), body, requestId),
}));
