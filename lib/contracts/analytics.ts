import { z } from "zod";

/** The spec itself is validated by the metric service against the registry; here it only has to be an object. */
const specInput = z.record(z.string(), z.unknown());

export const interpretSchema = z.strictObject({ question: z.string().trim().min(1).max(1000), conversationId: z.uuid().nullable().optional() });
export const executeSchema = z.strictObject({
  spec: specInput,
  question: z.string().max(1000).nullable().optional(),
  conversationId: z.uuid().nullable().optional(),
  /** How the spec was produced, shown with the result. Never grants anything. */
  source: z.enum(["demo", "live", "builder"]),
});
export const saveReportSchema = z.strictObject({ runId: z.uuid(), name: z.string().trim().min(1).max(120) });
export const reportVisibilitySchema = z.strictObject({ visibility: z.enum(["private", "workspace"]), expectedVersion: z.number().int().min(0) });
