import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { getTaxonomyVersion } from "@/lib/domain/taxonomy";

export const GET = route({ capability: "catalog.read" }, async ({ actor, params, query }) => ({
  data: await getTaxonomyVersion(actor, uuidParam(params.id, "Taxonomy version"), query.get("q")?.slice(0, 200)),
}));
