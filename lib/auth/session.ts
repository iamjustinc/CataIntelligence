import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, listWorkspacesForUser, readCookie, resolveActor, WORKSPACE_COOKIE, type Actor, type WorkspaceSummary } from "./actor";

export interface PageSession {
  actor: Actor;
  workspaces: WorkspaceSummary[];
}

/** For server components: the signed-in actor, or a redirect to /login or /no-access. */
export const requirePageSession = cache(async (): Promise<PageSession> => {
  const h = await headers();
  const user = await getSessionUser(h);
  if (!user) redirect("/login");
  const actor = await resolveActor(user, readCookie(h, WORKSPACE_COOKIE));
  if (!actor) redirect("/no-access");
  return { actor, workspaces: await listWorkspacesForUser(user.id) };
});
