import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { commitTaxonomyImportSchema } from "@/lib/contracts/taxonomy";
import { commitTaxonomyImport } from "@/lib/domain/taxonomy";

export const POST = route({ capability: "taxonomy.manage", body: commitTaxonomyImportSchema, idempotent: true }, async ({ actor, params, body, requestId }) => ({
  data: await commitTaxonomyImport(actor, uuidParam(params.id, "Import"), body, requestId),
}));
