import { route } from "@/lib/api/handler";
import { listMembers } from "@/lib/domain/workspace";

export const GET = route({ capability: "workspace.manage" }, async ({ actor }) => ({ data: await listMembers(actor) }));
