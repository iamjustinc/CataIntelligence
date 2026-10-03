import { route } from "@/lib/api/handler";
import { listReviewItems, parseReviewFilters } from "@/lib/domain/review";

export const GET = route({ capability: "catalog.read" }, async ({ actor, query }) => ({
  data: await listReviewItems(actor, { ...parseReviewFilters((k) => query.get(k)), limit: Number(query.get("limit") ?? 50) || 50 }),
}));
