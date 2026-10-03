import { route } from "@/lib/api/handler";
import { searchMappableConcepts } from "@/lib/domain/review";

/** Mappable leaves of the active taxonomy version, for manual mapping. */
export const GET = route({ capability: "catalog.read" }, async ({ actor, query }) => ({ data: await searchMappableConcepts(actor, (query.get("q") ?? "").slice(0, 200)) }));
