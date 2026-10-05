import { route } from "@/lib/api/handler";
import { interpretSchema } from "@/lib/contracts/analytics";
import { interpretQuestion } from "@/lib/domain/analytics";

/** Proposes an interpretation. Nothing is executed here (PRD ANA03). */
export const POST = route({ capability: "analytics.ask", body: interpretSchema }, async ({ actor, body }) => ({ data: await interpretQuestion(actor, body) }));
