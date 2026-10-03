import { route } from "@/lib/api/handler";
import { publishReleaseSchema } from "@/lib/contracts/release";
import { listReleases, publishRelease } from "@/lib/domain/releases";

export const GET = route({ capability: "catalog.read" }, async ({ actor }) => ({ data: await listReleases(actor) }));

export const POST = route({ capability: "release.publish", body: publishReleaseSchema, idempotent: true }, async ({ actor, body, req, requestId }) => ({
  status: 201,
  // The key is also stored on the release row, so a repeat returns the same release even if two requests race.
  data: await publishRelease(actor, body, req.headers.get("idempotency-key")!, requestId),
}));
