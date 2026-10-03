import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { versionActionSchema } from "@/lib/contracts/taxonomy";
import { discardTaxonomyDraft } from "@/lib/domain/taxonomy";

export const POST = route({ capability: "taxonomy.manage", body: versionActionSchema, idempotent: true }, async ({ actor, params, body, requestId }) => ({
  data: await discardTaxonomyDraft(actor, uuidParam(params.id, "Taxonomy version"), body.expectedVersion, requestId),
}));
