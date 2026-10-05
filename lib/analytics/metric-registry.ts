/**
 * Governed metric registry (PRD sections 8 ANA02 and 9). The dashboard, analytics planner,
 * query compiler and exports all read these definitions; the model can only reference these IDs.
 */
export const DIMENSIONS = ["merchant", "canonical_branch", "decision_status", "signal_band", "utc_day", "utc_week"] as const;
export type DimensionId = (typeof DIMENSIONS)[number];

export const MAPPING_STATES = ["published", "draft"] as const;
export type MappingState = (typeof MAPPING_STATES)[number];

export const METRIC_IDS = [
  "listing_count",
  "published_mapping_coverage",
  "approved_draft_coverage",
  "pending_review_count",
  "ambiguous_count",
  "failed_analysis_count",
  "reviewed_listing_count",
  "median_review_seconds",
  "releases_published_count",
  "mappings_published_count",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export interface MetricDefinition {
  id: MetricId;
  label: string;
  kind: "count" | "ratio" | "duration";
  /** Exact definition shown beside every result. */
  definition: string;
  numerator?: string;
  denominator?: string;
  scopeNote: string;
  /** Mapping state implied by the metric; null when the metric does not depend on one. */
  mappingState: MappingState | null;
  dimensions: readonly DimensionId[];
  /** Timestamp column a time range filters on; null for as-of snapshot metrics. */
  timestamp: "decision_created_at" | "release_published_at" | null;
  /**
   * Which population the metric is computed over. "snapshot" metrics count active listings of
   * merchants' current catalog revisions as of now; "activity" metrics count human review
   * decisions by when they were recorded; "publication" metrics count immutable mapping releases
   * by when they were published. Metrics from different families cannot share a result.
   */
  family: "snapshot" | "activity" | "publication";
  /** Dimensions the metric can be filtered by. */
  filters: readonly FilterDimension[];
}

export const FILTER_DIMENSIONS = ["merchant", "canonical_branch", "decision_status", "signal_band"] as const;
export type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

const SNAPSHOT_DIMENSIONS = ["merchant", "decision_status", "signal_band"] as const;

export const METRICS: Record<MetricId, MetricDefinition> = {
  listing_count: {
    id: "listing_count",
    label: "Active listing count",
    kind: "count",
    definition: "Number of distinct merchant listing IDs in the selected active catalog revisions.",
    scopeNote: "Invalid import rows and superseded revisions are excluded. As-of count, not historical.",
    mappingState: null,
    dimensions: [...SNAPSHOT_DIMENSIONS, "canonical_branch"],
    timestamp: null,
    family: "snapshot",
    filters: ["merchant", "canonical_branch", "decision_status", "signal_band"],
  },
  published_mapping_coverage: {
    id: "published_mapping_coverage",
    label: "Published mapping coverage",
    kind: "ratio",
    definition:
      "Eligible active listings with a mapping in the selected compatible current release, divided by all valid active listings.",
    numerator: "Active listings mapped in the merchant's current compatible release",
    denominator: "All valid active listings in the merchant's current catalog revision",
    scopeNote:
      "Unresolved and no-suitable-category listings stay in the denominator. A merchant without a current release has numerator zero. Totals sum numerators and denominators; merchant rates are never averaged.",
    mappingState: "published",
    dimensions: ["merchant"],
    timestamp: null,
    family: "snapshot",
    filters: ["merchant", "canonical_branch", "decision_status", "signal_band"],
  },
  approved_draft_coverage: {
    id: "approved_draft_coverage",
    label: "Approved draft coverage",
    kind: "ratio",
    definition: "Valid active listings whose latest compatible draft decision is approved, divided by all valid active listings.",
    numerator: "Active listings with a latest compatible approved draft decision",
    denominator: "All valid active listings in the merchant's current catalog revision",
    scopeNote: "Draft, not published. Approvals made only against superseded revisions are excluded.",
    mappingState: "draft",
    dimensions: ["merchant"],
    timestamp: null,
    family: "snapshot",
    filters: ["merchant", "canonical_branch", "decision_status", "signal_band"],
  },
  pending_review_count: {
    id: "pending_review_count",
    label: "Pending review count",
    kind: "count",
    definition: "Active listings whose latest workflow state is not Approved.",
    scopeNote:
      "Includes deferred, investigation, no suitable concept, stale and unsuggested states. Provider errors can overlap with this count.",
    mappingState: "draft",
    dimensions: SNAPSHOT_DIMENSIONS,
    timestamp: null,
    family: "snapshot",
    filters: ["merchant", "canonical_branch", "decision_status", "signal_band"],
  },
  ambiguous_count: {
    id: "ambiguous_count",
    label: "Ambiguous count",
    kind: "count",
    definition: "Active listings with current ambiguity flags that are not resolved by a human decision.",
    scopeNote: "Distinct listing count, not warning count.",
    mappingState: "draft",
    dimensions: ["merchant", "signal_band"],
    timestamp: null,
    family: "snapshot",
    filters: ["merchant", "canonical_branch", "decision_status", "signal_band"],
  },
  failed_analysis_count: {
    id: "failed_analysis_count",
    label: "Failed analysis count",
    kind: "count",
    definition: "Listings whose latest requested analysis attempt failed and has no valid replacement.",
    scopeNote: "A successful retry clears the current failure; history remains. Not a measure of taxonomy ambiguity.",
    mappingState: "draft",
    dimensions: ["merchant"],
    timestamp: null,
    family: "snapshot",
    filters: ["merchant", "canonical_branch", "decision_status", "signal_band"],
  },
  reviewed_listing_count: {
    id: "reviewed_listing_count",
    label: "Reviewed listing count",
    kind: "count",
    definition: "Distinct listing revisions with a human review action in the interval.",
    scopeNote: "Multiple edits count once. Automatic carry-forward is excluded.",
    mappingState: null,
    dimensions: ["merchant", "utc_day", "utc_week"],
    timestamp: "decision_created_at",
    family: "activity",
    filters: ["merchant"],
  },
  median_review_seconds: {
    id: "median_review_seconds",
    label: "Median review seconds",
    kind: "duration",
    definition: "Median active duration of completed individual manual review sessions.",
    scopeNote: "Bulk actions are excluded; the number of excluded sessions is disclosed with each result.",
    mappingState: null,
    dimensions: ["merchant", "utc_day", "utc_week"],
    timestamp: "decision_created_at",
    family: "activity",
    filters: ["merchant"],
  },
  // Recorded history: every release is immutable and timestamped, so these need no reconstruction.
  releases_published_count: {
    id: "releases_published_count",
    label: "Releases published",
    kind: "count",
    definition: "Number of mapping releases published in the interval.",
    scopeNote: "Counts publication events from the immutable release records. Making an earlier release current again (rollback) is not a publication and is not counted.",
    mappingState: null,
    dimensions: ["merchant", "utc_day", "utc_week"],
    timestamp: "release_published_at",
    family: "publication",
    filters: ["merchant"],
  },
  mappings_published_count: {
    id: "mappings_published_count",
    label: "Mappings published",
    kind: "count",
    definition: "Number of listing mappings contained in the mapping releases published in the interval.",
    scopeNote: "A listing included in two releases is counted in each, because each release republishes its whole mapping set. This is publication volume, not coverage and not daily catalog history.",
    mappingState: null,
    dimensions: ["merchant", "utc_day", "utc_week"],
    timestamp: "release_published_at",
    family: "publication",
    filters: ["merchant"],
  },
};

/** Topics the catalog data cannot answer. The planner must explain rather than infer (ANA02). */
export const UNSUPPORTED_TOPICS = ["revenue", "gmv", "sales", "engagement", "demand", "earnings", "profit"] as const;

export function metricSupportsDimension(metric: MetricId, dimension: DimensionId): boolean {
  return METRICS[metric].dimensions.includes(dimension);
}
