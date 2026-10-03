import { z } from "zod";

const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const createMerchantSchema = z.strictObject({
  name: trimmed(120),
  externalKey: trimmed(120).nullish(),
  region: trimmed(60).nullish(),
});
export type CreateMerchantInput = z.infer<typeof createMerchantSchema>;

export const selectWorkspaceSchema = z.strictObject({ workspaceId: z.uuid() });
