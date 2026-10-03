import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { getTaxonomyImport } from "@/lib/domain/taxonomy";

export const GET = route({ capability: "taxonomy.manage" }, async ({ actor, params }) => ({ data: await getTaxonomyImport(actor, uuidParam(params.id, "Import")) }));
