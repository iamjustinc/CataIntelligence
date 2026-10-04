import { route } from "@/lib/api/handler";
import { settingsSchema } from "@/lib/contracts/settings";
import { getSettings, updateSettings } from "@/lib/domain/settings";

export const GET = route({ capability: "workspace.manage" }, async ({ actor }) => ({ data: await getSettings(actor) }));

export const PUT = route({ capability: "workspace.manage", body: settingsSchema }, async ({ actor, body, requestId }) => ({ data: await updateSettings(actor, body, requestId) }));
