import { route } from "@/lib/api/handler";
import { stageCatalogImportSchema } from "@/lib/contracts/catalog";
import { stageCatalogImport } from "@/lib/domain/catalog-import";

export const POST = route({ capability: "catalog.import", body: stageCatalogImportSchema }, async ({ actor, body, requestId }) => {
  const data = await stageCatalogImport(actor, body, requestId);
  return { status: data.existing ? 200 : 201, data };
});
