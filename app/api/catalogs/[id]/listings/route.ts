import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { listCatalogListings } from "@/lib/domain/catalog-import";

export const GET = route({ capability: "catalog.read" }, async ({ actor, params, query }) => ({
  data: await listCatalogListings(actor, uuidParam(params.id, "Catalog revision"), {
    cursor: query.get("cursor"),
    limit: Number(query.get("limit") ?? 50) || 50,
    includeInactive: query.get("includeInactive") === "1",
  }),
}));
