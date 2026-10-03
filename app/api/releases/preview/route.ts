import { route } from "@/lib/api/handler";
import { previewReleaseSchema } from "@/lib/contracts/release";
import { previewRelease } from "@/lib/domain/releases";

export const POST = route({ capability: "release.publish", body: previewReleaseSchema }, async ({ actor, body }) => ({ data: await previewRelease(actor, body.merchantId) }));
