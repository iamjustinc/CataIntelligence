import { eq } from "drizzle-orm";
import { withContext } from "@/db/client";
import { workspaces } from "@/db/schema";
import { FIELDS_SENT_TO_PROVIDER } from "@/lib/ai/claude-adapter";
import { liveProvider } from "@/lib/ai/live";
import { resolveProviderStatus } from "@/lib/ai/provider";
import { conflict, forbidden } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { env } from "@/lib/env";
import { dailyCommittedUsd } from "./analysis";

type Workspace = typeof workspaces.$inferSelect;

function view(ws: Workspace, committedToday: number) {
  const config = env();
  const modelId = ws.aiModelId ?? config.AI_MODEL_ID ?? null;
  return {
    lockVersion: ws.lockVersion,
    name: ws.name,
    timezone: ws.timezone,
    isDemo: ws.isDemo,
    providerMode: ws.providerMode,
    liveAiOptIn: ws.liveAiOptIn,
    aiModelId: ws.aiModelId,
    /** Model the server would use when the workspace sets none. */
    serverDefaultModelId: config.AI_MODEL_ID ?? null,
    effectiveModelId: modelId,
    // Presence only. The key is read from the server environment and is never stored, returned or logged.
    providerKeyConfigured: Boolean(liveProvider().apiKey),
    /** Which live provider this server is configured for. Chosen by server environment, not stored per workspace. */
    liveProvider: { label: liveProvider().label, keyVariable: liveProvider().keyVariable },
    inputPricePerMtok: ws.inputPricePerMtok === null ? null : Number(ws.inputPricePerMtok),
    outputPricePerMtok: ws.outputPricePerMtok === null ? null : Number(ws.outputPricePerMtok),
    jobTokenCap: ws.jobTokenCap,
    jobSpendCapUsd: Number(ws.jobSpendCapUsd),
    dailySpendCapUsd: Number(ws.dailySpendCapUsd),
    jobItemCap: ws.jobItemCap,
    committedTodayUsd: committedToday,
    highSignalEnabled: ws.highSignalEnabled,
    fieldsSentToProvider: FIELDS_SENT_TO_PROVIDER,
    status: resolveProviderStatus(ws.providerMode, { apiKey: liveProvider().apiKey, modelId: modelId ?? undefined, providerLabel: liveProvider().label }, ws.liveAiOptIn),
  };
}

export async function getSettings(actor: Actor) {
  if (!can(actor.role, "workspace.manage")) throw forbidden("Only administrators can view workspace settings.");
  return withContext(actor, async (tx) => {
    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, actor.workspaceId));
    return view(ws, await dailyCommittedUsd(tx));
  });
}

export interface SettingsInput {
  providerMode: "off" | "demo" | "live";
  liveAiOptIn: boolean;
  aiModelId: string | null;
  inputPricePerMtok: number | null;
  outputPricePerMtok: number | null;
  jobTokenCap: number;
  jobSpendCapUsd: number;
  dailySpendCapUsd: number;
  jobItemCap: number;
  expectedVersion: number;
}

/**
 * Administrator change of provider mode, model and budgets. Switching mode affects future jobs
 * only: stored recommendations are never rewritten (PRD 13.1).
 */
export async function updateSettings(actor: Actor, input: SettingsInput, requestId: string) {
  if (!can(actor.role, "workspace.manage")) throw forbidden("Only administrators can change workspace settings.");
  return withContext(actor, async (tx) => {
    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, actor.workspaceId)).for("update");
    if (ws.lockVersion !== input.expectedVersion) throw conflict("Settings changed since you loaded this page. Reload to see the current values.", { lockVersion: ws.lockVersion });
    const next = {
      providerMode: input.providerMode,
      liveAiOptIn: input.liveAiOptIn,
      aiModelId: input.aiModelId,
      inputPricePerMtok: input.inputPricePerMtok === null ? null : input.inputPricePerMtok.toFixed(4),
      outputPricePerMtok: input.outputPricePerMtok === null ? null : input.outputPricePerMtok.toFixed(4),
      jobTokenCap: input.jobTokenCap,
      jobSpendCapUsd: input.jobSpendCapUsd.toFixed(2),
      dailySpendCapUsd: input.dailySpendCapUsd.toFixed(2),
      jobItemCap: input.jobItemCap,
    };
    const [updated] = await tx.update(workspaces).set({ ...next, lockVersion: ws.lockVersion + 1 }).where(eq(workspaces.id, ws.id)).returning();
    const before = Object.fromEntries(Object.keys(next).map((k) => [k, ws[k as keyof Workspace]]));
    await recordAudit(tx, actor, requestId, { action: "workspace.settings.update", entityType: "workspace", entityId: ws.id, before, after: next });
    return view(updated, await dailyCommittedUsd(tx));
  });
}
