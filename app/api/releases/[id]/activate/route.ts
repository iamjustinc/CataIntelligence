import { route } from "@/lib/api/handler";
import { uuidParam } from "@/lib/api/params";
import { activateReleaseSchema } from "@/lib/contracts/release";
import { activateRelease } from "@/lib/domain/releases";

export const POST = route({ capability: "release.publish", body: activateReleaseSchema, idempotent: true }, async ({ actor, params, body, requestId }) => ({
  data: await activateRelease(actor, uuidParam(params.id, "Release"), body, requestId),
}));
