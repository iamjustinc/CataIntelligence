import { route } from "@/lib/api/handler";
import { getAnalyticsContext } from "@/lib/domain/analytics";

export const GET = route({ capability: "analytics.ask" }, async ({ actor }) => ({ data: await getAnalyticsContext(actor) }));
