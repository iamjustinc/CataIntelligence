import { z } from "zod";

/** Field limits sent to a provider (PRD 13.2). Originals are always retained in the database. */
export const FIELD_LIMITS = { title: 500, description: 4000, merchantCategoryPath: 1000, candidateDefinition: 800 } as const;
export const MAX_CANDIDATES = 10;
export const EVIDENCE_FIELDS = ["title", "description", "merchant_category_path", "brand", "package_size", "gtin"] as const;

/**
 * Structured recommendation response (PRD 13.2). All keys are required and unknown keys are
 * rejected. Passing this schema is necessary but not sufficient: the server additionally checks
 * candidate membership, evidence excerpts and contradictions before anything is stored.
 */
export const recommendationResponseSchema = z.strictObject({
  listingRevisionId: z.uuid(),
  taxonomyVersionId: z.uuid(),
  selectedConceptId: z.uuid().nullable(),
  alternatives: z.array(z.strictObject({ conceptId: z.uuid(), reason: z.string().min(1).max(300) })).max(3),
  evidence: z
    .array(z.strictObject({ field: z.enum(EVIDENCE_FIELDS), excerpt: z.string().min(1).max(300), supportsConceptId: z.uuid() }))
    .max(8),
  explanation: z.string().min(1).max(600),
  ambiguityFlags: z.array(z.string().min(1).max(120)).max(6),
  missingInformation: z.array(z.string().min(1).max(120)).max(6),
  proposedConcept: z
    .strictObject({ name: z.string().min(1).max(120), parentConceptId: z.uuid().nullable(), rationale: z.string().min(1).max(400) })
    .nullable(),
});
export type RecommendationResponse = z.infer<typeof recommendationResponseSchema>;

export interface CandidateConcept {
  conceptId: string;
  path: string;
  name: string;
  definition: string;
  score: number;
  matchedTerms: string[];
  exactAlias: boolean;
}

export interface RecommendationRequest {
  workspaceId: string;
  listingRevisionId: string;
  taxonomyVersionId: string;
  contentHash: string;
  product: {
    title: string;
    description: string | null;
    merchantCategoryPath: string | null;
    brand: string | null;
    packageSize: string | null;
    gtin: string | null;
  };
  truncatedFields: string[];
  candidates: CandidateConcept[];
}
