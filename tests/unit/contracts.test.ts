import { describe, expect, it } from "vitest";
import { resolveProviderStatus } from "@/lib/ai/provider";
import { METRIC_IDS, METRICS } from "@/lib/analytics/metric-registry";
import { analysisSpecSchema } from "@/lib/contracts/analysis-spec";
import { recommendationResponseSchema } from "@/lib/contracts/recommendation";

const prdSpec = {
  metricIds: ["published_mapping_coverage"],
  groupBy: ["merchant"],
  filters: [],
  timeRange: null,
  scope: { population: "current_catalogs", mappingState: "published" },
  sort: { field: "published_mapping_coverage", direction: "asc" },
  limit: 20,
  chartType: "bar",
  needsClarification: false,
  clarificationQuestion: null,
};
const A = "0b2f5c1e-6a57-4c8e-9d43-1f2a3b4c5d6e";
const B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const prdRecommendation = {
  listingRevisionId: A,
  taxonomyVersionId: B,
  selectedConceptId: A,
  alternatives: [{ conceptId: B, reason: "Observed field supports this alternative" }],
  evidence: [{ field: "title", excerpt: "Unsweetened almond milk", supportsConceptId: A }],
  explanation: "The title identifies a plant-based milk product.",
  ambiguityFlags: [],
  missingInformation: [],
  proposedConcept: null,
};

describe("AnalysisSpec contract", () => {
  it("accepts the PRD example", () => expect(analysisSpecSchema.safeParse(prdSpec).success).toBe(true));
  it("rejects unregistered metrics such as revenue", () => {
    expect(analysisSpecSchema.safeParse({ ...prdSpec, metricIds: ["revenue"] }).success).toBe(false);
  });
  it("rejects unknown keys, including smuggled SQL or workspace IDs", () => {
    expect(analysisSpecSchema.safeParse({ ...prdSpec, sql: "select * from user" }).success).toBe(false);
    expect(analysisSpecSchema.safeParse({ ...prdSpec, scope: { ...prdSpec.scope, workspaceId: A } }).success).toBe(false);
  });
  it("rejects a published metric under draft scope", () => {
    expect(analysisSpecSchema.safeParse({ ...prdSpec, scope: { population: "current_catalogs", mappingState: "draft" } }).success).toBe(false);
  });
  it("rejects grouping coverage by canonical branch (PRD section 9)", () => {
    expect(analysisSpecSchema.safeParse({ ...prdSpec, groupBy: ["canonical_branch"], sort: null }).success).toBe(false);
  });
  it("rejects a time range on an as-of metric", () => {
    const timeRange = { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" };
    expect(analysisSpecSchema.safeParse({ ...prdSpec, timeRange }).success).toBe(false);
  });
  it("requires a question exactly when clarification is needed", () => {
    expect(analysisSpecSchema.safeParse({ ...prdSpec, needsClarification: true }).success).toBe(false);
    expect(analysisSpecSchema.safeParse({ ...prdSpec, needsClarification: true, clarificationQuestion: "Published or draft coverage?" }).success).toBe(true);
  });
  it("registers the eight PRD metrics plus the two publication-trend metrics of ANA03, with definitions", () => {
    expect(METRIC_IDS.slice(0, 8)).toEqual(["listing_count", "published_mapping_coverage", "approved_draft_coverage", "pending_review_count", "ambiguous_count", "failed_analysis_count", "reviewed_listing_count", "median_review_seconds"]);
    expect(METRIC_IDS.slice(8)).toEqual(["releases_published_count", "mappings_published_count"]);
    for (const id of METRIC_IDS) expect(METRICS[id].definition.length).toBeGreaterThan(20);
    expect(METRICS.published_mapping_coverage.denominator).toMatch(/all valid active listings/i);
  });
});

describe("recommendation response contract", () => {
  it("accepts the PRD example with real UUIDs", () => expect(recommendationResponseSchema.safeParse(prdRecommendation).success).toBe(true));
  it("accepts JSON null for abstention but not the literal text", () => {
    expect(recommendationResponseSchema.safeParse({ ...prdRecommendation, selectedConceptId: null }).success).toBe(true);
    expect(recommendationResponseSchema.safeParse({ ...prdRecommendation, selectedConceptId: "uuid-or-null" }).success).toBe(false);
  });
  it("requires all keys and rejects additional keys", () => {
    const { explanation: _omitted, ...missing } = prdRecommendation;
    void _omitted;
    expect(recommendationResponseSchema.safeParse(missing).success).toBe(false);
    expect(recommendationResponseSchema.safeParse({ ...prdRecommendation, approve: true }).success).toBe(false);
  });
  it("limits alternatives to three", () => {
    const alternatives = Array.from({ length: 4 }, () => ({ conceptId: B, reason: "x" }));
    expect(recommendationResponseSchema.safeParse({ ...prdRecommendation, alternatives }).success).toBe(false);
  });
});

describe("provider status", () => {
  it("never substitutes demo output when live mode lacks credentials (AT18)", () => {
    const status = resolveProviderStatus("live", {}, true);
    expect(status.state).toBe("unavailable");
    expect(status.label).toBe("AI unavailable");
  });
  it("requires administrator opt-in before live mode is usable", () => {
    expect(resolveProviderStatus("live", { ANTHROPIC_API_KEY: "k", AI_MODEL_ID: "m" }, false).state).toBe("unavailable");
    expect(resolveProviderStatus("live", { ANTHROPIC_API_KEY: "k", AI_MODEL_ID: "m" }, true).state).toBe("live");
  });
  it("labels demo mode as demo", () => expect(resolveProviderStatus("demo", {}, false).label).toBe("Demo AI"));
});
