import { route } from "@/lib/api/handler";
import { listTaxonomyVersions } from "@/lib/domain/taxonomy";

export const GET = route({ capability: "catalog.read" }, async ({ actor }) => ({ data: await listTaxonomyVersions(actor) }));
