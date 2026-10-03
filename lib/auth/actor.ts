import { and, eq } from "drizzle-orm";
import { withContext } from "@/db/client";
import { memberships, workspaces } from "@/db/schema";
import { auth } from "./auth";
import type { Role } from "./permissions";

export const WORKSPACE_COOKIE = "ci_workspace";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
  isDemo: boolean;
}

/** The verified identity every domain service receives. Built only on the server. */
export interface Actor {
  userId: string;
  email: string;
  name: string;
  role: Role;
  workspaceId: string;
  workspace: WorkspaceSummary;
}

export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const session = await auth().api.getSession({ headers });
  if (!session) return null;
  return { id: session.user.id, email: session.user.email, name: session.user.name };
}

export async function listWorkspacesForUser(userId: string): Promise<WorkspaceSummary[]> {
  return withContext({ userId }, async (tx) =>
    tx
      .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, role: memberships.role, isDemo: workspaces.isDemo })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(and(eq(memberships.userId, userId), eq(memberships.active, true)))
      .orderBy(memberships.createdAt, workspaces.name),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolves the active workspace for a user. A requested workspace is honoured only when the user
 * holds an active membership in it; otherwise the first membership is used. Returns null when the
 * user has no active membership anywhere.
 */
export async function resolveActor(user: SessionUser, requestedWorkspaceId?: string | null): Promise<Actor | null> {
  const available = await listWorkspacesForUser(user.id);
  if (available.length === 0) return null;
  const requested = requestedWorkspaceId && UUID.test(requestedWorkspaceId) ? requestedWorkspaceId : null;
  const workspace = available.find((w) => w.id === requested) ?? available[0];
  return { userId: user.id, email: user.email, name: user.name, role: workspace.role, workspaceId: workspace.id, workspace };
}

export function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
