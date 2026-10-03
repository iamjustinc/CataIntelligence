import { route } from "@/lib/api/handler";
import { notFound } from "@/lib/api/errors";
import { listWorkspacesForUser, WORKSPACE_COOKIE } from "@/lib/auth/actor";
import { selectWorkspaceSchema } from "@/lib/contracts/merchant";

/** Switches the active workspace. Only workspaces where the user holds an active membership. */
export const POST = route({ capability: "catalog.read", body: selectWorkspaceSchema }, async ({ actor, body }) => {
  const target = (await listWorkspacesForUser(actor.userId)).find((w) => w.id === body.workspaceId);
  // 404 for both unknown and non-member workspaces: existence is not disclosed.
  if (!target) throw notFound("Workspace");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return {
    data: { workspace: target },
    headers: { "set-cookie": `${WORKSPACE_COOKIE}=${target.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}` },
  };
});
