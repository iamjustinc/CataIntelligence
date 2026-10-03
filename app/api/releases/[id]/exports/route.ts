import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { exportSchema } from "@/lib/contracts/release";
import { createExport } from "@/lib/domain/releases";

export const POST = route({ capability: "catalog.read", body: exportSchema }, async ({ actor, params, body, requestId }) => ({
  status: 201,
  data: await createExport(actor, uuidParam(params.id, "Release"), body.kind, requestId),
}));
