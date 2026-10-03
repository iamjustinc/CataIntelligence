import { route } from "@/lib/api/handler";
import { listWorkspacesForUser } from "@/lib/auth/actor";
import { CAPABILITIES, can } from "@/lib/auth/permissions";
import { getProviderStatus } from "@/lib/domain/workspace";

export const GET = route({ capability: "catalog.read" }, async ({ actor }) => ({
  data: {
    user: { id: actor.userId, name: actor.name, email: actor.email },
    workspace: actor.workspace,
    role: actor.role,
    capabilities: CAPABILITIES.filter((c) => can(actor.role, c)),
    workspaces: await listWorkspacesForUser(actor.userId),
    provider: await getProviderStatus(actor),
  },
}));
