import { route } from "@/lib/api/handler";
import { getDashboard } from "@/lib/domain/analytics";

export const GET = route({ capability: "analytics.ask" }, async ({ actor }) => ({ data: await getDashboard(actor) }));
