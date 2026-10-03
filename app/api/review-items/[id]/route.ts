import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { getReviewItem } from "@/lib/domain/review";

export const GET = route({ capability: "catalog.read" }, async ({ actor, params }) => ({ data: await getReviewItem(actor, uuidParam(params.id, "Listing")) }));
