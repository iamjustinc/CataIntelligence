import { route } from "@/lib/api/handler";
import { stageTaxonomyImportSchema } from "@/lib/contracts/taxonomy";
import { stageTaxonomyImport } from "@/lib/domain/taxonomy";

export const POST = route({ capability: "taxonomy.manage", body: stageTaxonomyImportSchema }, async ({ actor, body, requestId }) => ({
  status: 201,
  data: await stageTaxonomyImport(actor, body, requestId),
}));
