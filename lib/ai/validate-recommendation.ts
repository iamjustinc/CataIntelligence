import { recommendationResponseSchema, type RecommendationRequest, type RecommendationResponse } from "@/lib/contracts/recommendation";
import { fold } from "@/lib/domain/catalog-validation";

export const SIGNAL_POLICY_VERSION = "signal-v1";

export type ValidationOutcome = { ok: true; response: RecommendationResponse } | { ok: false; code: string; message: string };

const FIELD_OF: Record<string, keyof RecommendationRequest["product"]> = {
  title: "title",
  description: "description",
  merchant_category_path: "merchantCategoryPath",
  brand: "brand",
  package_size: "packageSize",
  gtin: "gtin",
};

/**
 * Server validation of a provider response (PRD TAX06, 13.2). Schema validity is necessary but
 * not sufficient: IDs must match the request, every concept must be an enumerated candidate,
 * and every evidence excerpt must literally occur in the field it cites.
 */
export function validateRecommendation(request: RecommendationRequest, payload: unknown): ValidationOutcome {
  const parsed = recommendationResponseSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, code: "schema_invalid", message: parsed.error.issues[0]?.message ?? "Response does not match the contract." };
  const r = parsed.data;
  const candidates = new Set(request.candidates.map((c) => c.conceptId));
  if (r.listingRevisionId !== request.listingRevisionId || r.taxonomyVersionId !== request.taxonomyVersionId) return { ok: false, code: "wrong_binding", message: "Response is bound to a different listing or taxonomy version." };
  if (r.selectedConceptId && !candidates.has(r.selectedConceptId)) return { ok: false, code: "unknown_concept", message: "Selected concept is not one of the supplied candidates." };
  for (const alt of r.alternatives) {
    if (!candidates.has(alt.conceptId)) return { ok: false, code: "unknown_alternative", message: "An alternative is not one of the supplied candidates." };
    if (alt.conceptId === r.selectedConceptId) return { ok: false, code: "contradictory", message: "The selected concept is also listed as an alternative." };
  }
  for (const e of r.evidence) {
    if (!candidates.has(e.supportsConceptId)) return { ok: false, code: "unknown_evidence_concept", message: "Evidence supports a concept that was not supplied." };
    const value = request.product[FIELD_OF[e.field]];
    if (!value || !fold(value).includes(fold(e.excerpt))) return { ok: false, code: "unsupported_evidence", message: `Evidence excerpt does not occur in ${e.field}.` };
  }
  if (r.proposedConcept?.parentConceptId && !request.branches.some((b) => b.conceptId === r.proposedConcept!.parentConceptId)) {
    return { ok: false, code: "unknown_parent", message: "Proposed concept names a parent that was not supplied." };
  }
  if (r.selectedConceptId && r.proposedConcept) return { ok: false, code: "contradictory", message: "A response cannot both select a concept and propose a missing one." };
  return { ok: true, response: r };
}

export interface SignalDecision {
  band: "high" | "medium" | "low" | "none";
  basis: string;
}

/**
 * Deterministic review-priority policy (PRD TAX07). Bands are not probabilities. The provider can
 * only lower a band: High additionally requires a unique exact alias that agrees with the
 * selection, no flags, no truncation, and the workspace's precision gate to be met.
 */
export function signalBand(request: RecommendationRequest, r: RecommendationResponse, highEnabled: boolean): SignalDecision {
  if (!r.selectedConceptId) return { band: "none", basis: "No supported target among the candidates." };
  const reasons: string[] = [];
  if (r.ambiguityFlags.length) reasons.push("ambiguity flagged");
  if (r.missingInformation.length) reasons.push("material information missing");
  if (request.truncatedFields.length) reasons.push(`truncated ${request.truncatedFields.join(", ")}`);
  const exact = request.candidates.filter((c) => c.exactAlias);
  const conflicting = exact.filter((c) => c.conceptId !== r.selectedConceptId);
  if (conflicting.length) reasons.push(`title also names ${conflicting.map((c) => c.name).join(", ")}`);
  if (reasons.length) return { band: "low", basis: `Low: ${reasons.join("; ")}.` };
  const uniqueExact = exact.length === 1 && exact[0].conceptId === r.selectedConceptId;
  if (!uniqueExact) return { band: "medium", basis: "Medium: supported selection without a unique exact name or synonym match." };
  if (!highEnabled) return { band: "medium", basis: "Medium: a unique exact match agrees with the selection, but the High band is disabled until its precision gate is met." };
  return { band: "high", basis: "High: exactly one name or synonym matches the title, the selection agrees, and nothing is flagged." };
}
