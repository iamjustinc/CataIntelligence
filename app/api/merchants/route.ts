import { route } from "@/lib/api/handler";
import { createMerchantSchema } from "@/lib/contracts/merchant";
import { createMerchant, listMerchants } from "@/lib/domain/merchants";

export const GET = route({ capability: "catalog.read" }, async ({ actor }) => ({ data: await listMerchants(actor) }));

export const POST = route({ capability: "catalog.import", body: createMerchantSchema, idempotent: true }, async ({ actor, body, requestId }) => ({
  status: 201,
  data: await createMerchant(actor, body, requestId),
}));
