import { route } from "@/lib/api/handler";
import { emptySchema } from "@/lib/contracts/taxonomy";
import { revalidateDependencies } from "@/lib/domain/proposals";

export const POST = route({ capability: "taxonomy.manage", body: emptySchema, idempotent: true }, async ({ actor, requestId }) => ({ data: await revalidateDependencies(actor, requestId) }));
