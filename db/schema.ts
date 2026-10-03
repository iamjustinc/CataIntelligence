/**
 * Catalog Intelligence database schema (PRD section 11).
 *
 * Conventions
 * - UUID primary keys, UTC timestamps (timestamptz), explicit workspace_id on every tenant table.
 * - Tenant parents expose UNIQUE (workspace_id, id) so children can use composite foreign keys that
 *   make cross-workspace references impossible at the database level.
 * - Row-level security, immutability triggers and grants live in hand-written SQL migrations.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const workspaceId = () => uuid("workspace_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------------------------
// Authentication (better-auth core tables; not workspace scoped)
// ---------------------------------------------------------------------------------------------

export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------

export const roleEnum = pgEnum("member_role", ["administrator", "taxonomist", "analyst", "viewer"]);
export const providerModeEnum = pgEnum("provider_mode", ["off", "demo", "live"]);
export const importKindEnum = pgEnum("import_kind", ["catalog", "taxonomy"]);
export const importStatusEnum = pgEnum("import_status", ["staged", "validated", "committed", "failed", "expired"]);
export const revisionModeEnum = pgEnum("revision_mode", ["snapshot", "delta"]);
export const taxonomyStateEnum = pgEnum("taxonomy_state", ["draft", "published", "discarded"]);
export const conceptStatusEnum = pgEnum("concept_status", ["active", "inactive"]);
export const signalBandEnum = pgEnum("signal_band", ["high", "medium", "low", "none"]);
export const reviewStateEnum = pgEnum("review_state", [
  "needs_analysis",
  "suggested",
  "needs_investigation",
  "needs_review",
  "approved",
  "deferred",
  "no_suitable_category",
  "stale",
]);
export const decisionActionEnum = pgEnum("decision_action", ["approve", "change", "reject", "defer", "no_suitable"]);
export const decisionOriginEnum = pgEnum("decision_origin", ["manual", "suggestion", "bulk", "carried_forward", "revalidated"]);
export const proposalTypeEnum = pgEnum("proposal_type", ["new_leaf", "synonym"]);
export const proposalStateEnum = pgEnum("proposal_state", ["submitted", "approved", "modified", "rejected"]);
export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "partially_completed",
  "completed",
  "cancel_requested",
  "canceled",
  "failed",
]);
export const jobItemStatusEnum = pgEnum("job_item_status", ["pending", "running", "succeeded", "failed", "skipped", "canceled"]);
export const reportVisibilityEnum = pgEnum("report_visibility", ["private", "workspace"]);

// ---------------------------------------------------------------------------------------------
// Workspace and membership
// ---------------------------------------------------------------------------------------------

export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    timezone: text("timezone").notNull().default("UTC"),
    activeTaxonomyVersionId: uuid("active_taxonomy_version_id"),
    providerMode: providerModeEnum("provider_mode").notNull().default("off"),
    liveAiOptIn: boolean("live_ai_opt_in").notNull().default(false),
    isDemo: boolean("is_demo").notNull().default(false),
    // The High signal band stays disabled until its precision gate is met (PRD TAX07).
    highSignalEnabled: boolean("high_signal_enabled").notNull().default(false),
    jobTokenCap: integer("job_token_cap").notNull().default(400000),
    jobSpendCapUsd: numeric("job_spend_cap_usd", { precision: 10, scale: 2 }).notNull().default("5"),
    dailySpendCapUsd: numeric("daily_spend_cap_usd", { precision: 10, scale: 2 }).notNull().default("20"),
    lockVersion: integer("lock_version").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "workspaces_active_taxonomy_fk",
      columns: [t.id, t.activeTaxonomyVersionId],
      foreignColumns: [taxonomyVersions.workspaceId, taxonomyVersions.id],
    }),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    role: roleEnum("role").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique("memberships_ws_user_uq").on(t.workspaceId, t.userId), index("memberships_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------------------------
// Merchants, imports, catalog revisions, listings
// ---------------------------------------------------------------------------------------------

export const merchants = pgTable(
  "merchants",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    name: text("name").notNull(),
    externalKey: text("external_key"),
    region: text("region"),
    active: boolean("active").notNull().default(true),
    activeCatalogRevisionId: uuid("active_catalog_revision_id"),
    lockVersion: integer("lock_version").notNull().default(0),
    createdBy: uuid("created_by").references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("merchants_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("merchants_ws_name_uq").on(t.workspaceId, sql`lower(${t.name})`),
    uniqueIndex("merchants_ws_external_key_uq").on(t.workspaceId, t.externalKey).where(sql`${t.externalKey} is not null`),
    // merchants_active_revision_fk (workspace_id, active_catalog_revision_id) -> catalog_revisions is
    // declared in 0001_security.sql: declaring it here creates a circular type reference.
  ],
);

export const importJobs = pgTable(
  "import_jobs",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    kind: importKindEnum("kind").notNull(),
    merchantId: uuid("merchant_id"),
    mode: revisionModeEnum("mode"),
    status: importStatusEnum("status").notNull().default("staged"),
    fileName: text("file_name").notNull(),
    stagedFileKey: text("staged_file_key"),
    fileHash: text("file_hash").notNull(),
    columnMap: jsonb("column_map"),
    validationSummary: jsonb("validation_summary"),
    idempotencyKey: text("idempotency_key"),
    resultRevisionId: uuid("result_revision_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
    committedAt: ts("committed_at"),
  },
  (t) => [
    unique("import_jobs_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      name: "import_jobs_merchant_fk",
      columns: [t.workspaceId, t.merchantId],
      foreignColumns: [merchants.workspaceId, merchants.id],
    }),
    check("import_jobs_catalog_requires_merchant", sql`${t.kind} <> 'catalog' or ${t.merchantId} is not null`),
  ],
);

export const catalogRevisions = pgTable(
  "catalog_revisions",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    merchantId: uuid("merchant_id").notNull(),
    sequence: integer("sequence").notNull(),
    mode: revisionModeEnum("mode").notNull(),
    priorRevisionId: uuid("prior_revision_id"),
    importJobId: uuid("import_job_id"),
    fileHash: text("file_hash").notNull(),
    populationHash: text("population_hash").notNull(),
    counts: jsonb("counts").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("catalog_revisions_ws_id_uq").on(t.workspaceId, t.id),
    unique("catalog_revisions_merchant_seq_uq").on(t.workspaceId, t.merchantId, t.sequence),
    foreignKey({
      name: "catalog_revisions_merchant_fk",
      columns: [t.workspaceId, t.merchantId],
      foreignColumns: [merchants.workspaceId, merchants.id],
    }),
    foreignKey({
      name: "catalog_revisions_prior_fk",
      columns: [t.workspaceId, t.priorRevisionId],
      foreignColumns: [t.workspaceId, t.id],
    }),
    foreignKey({
      name: "catalog_revisions_import_fk",
      columns: [t.workspaceId, t.importJobId],
      foreignColumns: [importJobs.workspaceId, importJobs.id],
    }),
  ],
);

export const merchantListings = pgTable(
  "merchant_listings",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    merchantId: uuid("merchant_id").notNull(),
    merchantSku: text("merchant_sku").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("merchant_listings_ws_id_uq").on(t.workspaceId, t.id),
    unique("merchant_listings_sku_uq").on(t.workspaceId, t.merchantId, t.merchantSku),
    foreignKey({
      name: "merchant_listings_merchant_fk",
      columns: [t.workspaceId, t.merchantId],
      foreignColumns: [merchants.workspaceId, merchants.id],
    }),
  ],
);

export const listingRevisions = pgTable(
  "listing_revisions",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    catalogRevisionId: uuid("catalog_revision_id").notNull(),
    listingId: uuid("listing_id").notNull(),
    title: text("title").notNull(),
    merchantCategoryPath: text("merchant_category_path"),
    price: numeric("price", { precision: 14, scale: 4 }),
    currency: text("currency"),
    rawJson: jsonb("raw_json").notNull(),
    normalizedJson: jsonb("normalized_json").notNull(),
    sourceRow: integer("source_row"),
    contentHash: text("content_hash").notNull(),
    carriedFromRevisionId: uuid("carried_from_revision_id"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("listing_revisions_ws_id_uq").on(t.workspaceId, t.id),
    unique("listing_revisions_rev_listing_uq").on(t.catalogRevisionId, t.listingId),
    index("listing_revisions_catalog_idx").on(t.workspaceId, t.catalogRevisionId, t.active),
    foreignKey({
      name: "listing_revisions_catalog_fk",
      columns: [t.workspaceId, t.catalogRevisionId],
      foreignColumns: [catalogRevisions.workspaceId, catalogRevisions.id],
    }),
    foreignKey({
      name: "listing_revisions_listing_fk",
      columns: [t.workspaceId, t.listingId],
      foreignColumns: [merchantListings.workspaceId, merchantListings.id],
    }),
    check(
      "listing_revisions_price_currency",
      sql`${t.price} is null or (${t.price} >= 0 and ${t.currency} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------------------------

export const taxonomyVersions = pgTable(
  "taxonomy_versions",
  {
    id: id(),
    workspaceId: workspaceId().references((): AnyPgColumn => workspaces.id),
    sequence: integer("sequence").notNull(),
    state: taxonomyStateEnum("state").notNull().default("draft"),
    baseVersionId: uuid("base_version_id"),
    note: text("note"),
    lockVersion: integer("lock_version").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
    publishedBy: uuid("published_by").references(() => user.id),
    publishedAt: ts("published_at"),
  },
  (t) => [
    unique("taxonomy_versions_ws_id_uq").on(t.workspaceId, t.id),
    unique("taxonomy_versions_ws_seq_uq").on(t.workspaceId, t.sequence),
    uniqueIndex("taxonomy_versions_one_draft_uq").on(t.workspaceId).where(sql`${t.state} = 'draft'`),
    foreignKey({
      name: "taxonomy_versions_base_fk",
      columns: [t.workspaceId, t.baseVersionId],
      foreignColumns: [t.workspaceId, t.id],
    }),
    check(
      "taxonomy_versions_published_fields",
      sql`${t.state} <> 'published' or (${t.publishedBy} is not null and ${t.publishedAt} is not null)`,
    ),
  ],
);

export const concepts = pgTable(
  "concepts",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    stableKey: text("stable_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("concepts_ws_id_uq").on(t.workspaceId, t.id), unique("concepts_ws_key_uq").on(t.workspaceId, t.stableKey)],
);

export const conceptRevisions = pgTable(
  "concept_revisions",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    taxonomyVersionId: uuid("taxonomy_version_id").notNull(),
    conceptId: uuid("concept_id").notNull(),
    parentConceptId: uuid("parent_concept_id"),
    name: text("name").notNull(),
    definition: text("definition").notNull().default(""),
    synonyms: jsonb("synonyms").$type<string[]>().notNull().default([]),
    status: conceptStatusEnum("status").notNull().default("active"),
    mappingAllowed: boolean("mapping_allowed").notNull().default(false),
    path: text("path").notNull(),
    depth: integer("depth").notNull(),
  },
  (t) => [
    unique("concept_revisions_version_concept_uq").on(t.workspaceId, t.taxonomyVersionId, t.conceptId),
    index("concept_revisions_parent_idx").on(t.taxonomyVersionId, t.parentConceptId),
    foreignKey({
      name: "concept_revisions_version_fk",
      columns: [t.workspaceId, t.taxonomyVersionId],
      foreignColumns: [taxonomyVersions.workspaceId, taxonomyVersions.id],
    }),
    foreignKey({
      name: "concept_revisions_concept_fk",
      columns: [t.workspaceId, t.conceptId],
      foreignColumns: [concepts.workspaceId, concepts.id],
    }),
    // Parent must exist in the same workspace AND the same taxonomy version. Deferred so a whole
    // tree can be written in one transaction. Cycles are validated in application code (PRD s11).
    foreignKey({
      name: "concept_revisions_parent_fk",
      columns: [t.workspaceId, t.taxonomyVersionId, t.parentConceptId],
      foreignColumns: [t.workspaceId, t.taxonomyVersionId, t.conceptId],
    }),
    check("concept_revisions_mapping_requires_active", sql`not ${t.mappingAllowed} or ${t.status} = 'active'`),
    check("concept_revisions_depth", sql`${t.depth} between 1 and 8`),
  ],
);

export const taxonomyProposals = pgTable(
  "taxonomy_proposals",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    type: proposalTypeEnum("type").notNull(),
    payload: jsonb("payload").notNull(),
    evidenceListingIds: jsonb("evidence_listing_ids").$type<string[]>().notNull().default([]),
    rationale: text("rationale").notNull(),
    state: proposalStateEnum("state").notNull().default("submitted"),
    baseVersionId: uuid("base_version_id"),
    appliedVersionId: uuid("applied_version_id"),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => user.id),
    decidedBy: uuid("decided_by").references(() => user.id),
    decisionReason: text("decision_reason"),
    lockVersion: integer("lock_version").notNull().default(0),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
  },
  (t) => [
    unique("taxonomy_proposals_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      name: "taxonomy_proposals_applied_fk",
      columns: [t.workspaceId, t.appliedVersionId],
      foreignColumns: [taxonomyVersions.workspaceId, taxonomyVersions.id],
    }),
  ],
);

// ---------------------------------------------------------------------------------------------
// Analysis jobs, recommendations, AI usage
// ---------------------------------------------------------------------------------------------

export const analysisJobs = pgTable(
  "analysis_jobs",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    catalogRevisionId: uuid("catalog_revision_id").notNull(),
    taxonomyVersionId: uuid("taxonomy_version_id").notNull(),
    providerMode: providerModeEnum("provider_mode").notNull(),
    dependencyVersions: jsonb("dependency_versions").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    progress: jsonb("progress").notNull().default({}),
    estimate: jsonb("estimate"),
    attempt: integer("attempt").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: ts("lease_expires_at"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    idempotencyKey: text("idempotency_key"),
    errorCode: text("error_code"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    unique("analysis_jobs_ws_id_uq").on(t.workspaceId, t.id),
    index("analysis_jobs_claim_idx").on(t.status, t.leaseExpiresAt),
    foreignKey({
      name: "analysis_jobs_catalog_fk",
      columns: [t.workspaceId, t.catalogRevisionId],
      foreignColumns: [catalogRevisions.workspaceId, catalogRevisions.id],
    }),
    foreignKey({
      name: "analysis_jobs_taxonomy_fk",
      columns: [t.workspaceId, t.taxonomyVersionId],
      foreignColumns: [taxonomyVersions.workspaceId, taxonomyVersions.id],
    }),
  ],
);

export const analysisJobItems = pgTable(
  "analysis_job_items",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    jobId: uuid("job_id").notNull(),
    listingRevisionId: uuid("listing_revision_id").notNull(),
    status: jobItemStatusEnum("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    errorCode: text("error_code"),
    recommendationId: uuid("recommendation_id"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("analysis_job_items_job_listing_uq").on(t.jobId, t.listingRevisionId),
    foreignKey({
      name: "analysis_job_items_job_fk",
      columns: [t.workspaceId, t.jobId],
      foreignColumns: [analysisJobs.workspaceId, analysisJobs.id],
    }),
    foreignKey({
      name: "analysis_job_items_listing_fk",
      columns: [t.workspaceId, t.listingRevisionId],
      foreignColumns: [listingRevisions.workspaceId, listingRevisions.id],
    }),
  ],
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    listingRevisionId: uuid("listing_revision_id").notNull(),
    taxonomyVersionId: uuid("taxonomy_version_id").notNull(),
    runId: uuid("run_id").notNull(),
    jobId: uuid("job_id"),
    provider: text("provider").notNull(),
    isDemo: boolean("is_demo").notNull(),
    modelId: text("model_id"),
    promptVersion: text("prompt_version"),
    retrievalPolicyVersion: text("retrieval_policy_version"),
    policyVersion: text("policy_version").notNull(),
    inputHash: text("input_hash").notNull(),
    candidates: jsonb("candidates").notNull(),
    selectedConceptId: uuid("selected_concept_id"),
    alternatives: jsonb("alternatives").notNull().default([]),
    evidence: jsonb("evidence").notNull().default([]),
    explanation: text("explanation").notNull().default(""),
    warnings: jsonb("warnings").notNull().default([]),
    ambiguityFlags: jsonb("ambiguity_flags").notNull().default([]),
    missingInformation: jsonb("missing_information").notNull().default([]),
    proposedConcept: jsonb("proposed_concept"),
    signalBand: signalBandEnum("signal_band").notNull(),
    signalBasis: text("signal_basis").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    unique("recommendations_ws_id_uq").on(t.workspaceId, t.id),
    // Duplicate job delivery cannot create duplicate effective recommendations (PRD 12.2).
    uniqueIndex("recommendations_job_listing_uq").on(t.jobId, t.listingRevisionId).where(sql`${t.jobId} is not null`),
    index("recommendations_listing_idx").on(t.listingRevisionId, t.createdAt),
    foreignKey({
      name: "recommendations_listing_fk",
      columns: [t.workspaceId, t.listingRevisionId],
      foreignColumns: [listingRevisions.workspaceId, listingRevisions.id],
    }),
    foreignKey({
      name: "recommendations_selected_fk",
      columns: [t.workspaceId, t.taxonomyVersionId, t.selectedConceptId],
      foreignColumns: [conceptRevisions.workspaceId, conceptRevisions.taxonomyVersionId, conceptRevisions.conceptId],
    }),
    foreignKey({
      name: "recommendations_version_fk",
      columns: [t.workspaceId, t.taxonomyVersionId],
      foreignColumns: [taxonomyVersions.workspaceId, taxonomyVersions.id],
    }),
  ],
);

export const aiUsage = pgTable("ai_usage", {
  id: id(),
  workspaceId: workspaceId().references(() => workspaces.id),
  runId: uuid("run_id").notNull(),
  jobId: uuid("job_id"),
  purpose: text("purpose").notNull(),
  provider: text("provider").notNull(),
  modelId: text("model_id"),
  promptVersion: text("prompt_version"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  // NULL means unknown, never zero (PRD section 16).
  costEstimateUsd: numeric("cost_estimate_usd", { precision: 12, scale: 6 }),
  status: text("status").notNull(),
  latencyMs: integer("latency_ms"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------------------------
// Review decisions and state
// ---------------------------------------------------------------------------------------------

export const reviewDecisions = pgTable(
  "review_decisions",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    listingRevisionId: uuid("listing_revision_id").notNull(),
    taxonomyVersionId: uuid("taxonomy_version_id").notNull(),
    recommendationId: uuid("recommendation_id"),
    action: decisionActionEnum("action").notNull(),
    origin: decisionOriginEnum("origin").notNull().default("manual"),
    selectedConceptId: uuid("selected_concept_id"),
    reason: text("reason"),
    batchId: uuid("batch_id"),
    durationSeconds: integer("duration_seconds"),
    previousDecisionId: uuid("previous_decision_id"),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("review_decisions_ws_id_uq").on(t.workspaceId, t.id),
    index("review_decisions_listing_idx").on(t.listingRevisionId, t.createdAt),
    foreignKey({
      name: "review_decisions_listing_fk",
      columns: [t.workspaceId, t.listingRevisionId],
      foreignColumns: [listingRevisions.workspaceId, listingRevisions.id],
    }),
    foreignKey({
      name: "review_decisions_target_fk",
      columns: [t.workspaceId, t.taxonomyVersionId, t.selectedConceptId],
      foreignColumns: [conceptRevisions.workspaceId, conceptRevisions.taxonomyVersionId, conceptRevisions.conceptId],
    }),
    foreignKey({
      name: "review_decisions_version_fk",
      columns: [t.workspaceId, t.taxonomyVersionId],
      foreignColumns: [taxonomyVersions.workspaceId, taxonomyVersions.id],
    }),
    foreignKey({
      name: "review_decisions_recommendation_fk",
      columns: [t.workspaceId, t.recommendationId],
      foreignColumns: [recommendations.workspaceId, recommendations.id],
    }),
    foreignKey({
      name: "review_decisions_previous_fk",
      columns: [t.workspaceId, t.previousDecisionId],
      foreignColumns: [t.workspaceId, t.id],
    }),
    check(
      "review_decisions_target_required",
      sql`(${t.action} in ('approve', 'change')) = (${t.selectedConceptId} is not null)`,
    ),
    check(
      "review_decisions_reason_required",
      sql`${t.action} not in ('change', 'reject') or length(trim(coalesce(${t.reason}, ''))) > 0`,
    ),
  ],
);

export const reviewStates = pgTable(
  "review_states",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    listingRevisionId: uuid("listing_revision_id").notNull(),
    taxonomyVersionId: uuid("taxonomy_version_id"),
    state: reviewStateEnum("state").notNull().default("needs_analysis"),
    latestDecisionId: uuid("latest_decision_id"),
    latestRecommendationId: uuid("latest_recommendation_id"),
    ambiguous: boolean("ambiguous").notNull().default(false),
    analysisFailed: boolean("analysis_failed").notNull().default(false),
    lockVersion: integer("lock_version").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("review_states_listing_uq").on(t.listingRevisionId),
    index("review_states_queue_idx").on(t.workspaceId, t.state, t.updatedAt, t.id),
    foreignKey({
      name: "review_states_listing_fk",
      columns: [t.workspaceId, t.listingRevisionId],
      foreignColumns: [listingRevisions.workspaceId, listingRevisions.id],
    }),
    foreignKey({
      name: "review_states_decision_fk",
      columns: [t.workspaceId, t.latestDecisionId],
      foreignColumns: [reviewDecisions.workspaceId, reviewDecisions.id],
    }),
    foreignKey({
      name: "review_states_recommendation_fk",
      columns: [t.workspaceId, t.latestRecommendationId],
      foreignColumns: [recommendations.workspaceId, recommendations.id],
    }),
    check("review_states_approved_has_decision", sql`${t.state} <> 'approved' or ${t.latestDecisionId} is not null`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------------------------

export const mappingReleases = pgTable(
  "mapping_releases",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    merchantId: uuid("merchant_id").notNull(),
    catalogRevisionId: uuid("catalog_revision_id").notNull(),
    taxonomyVersionId: uuid("taxonomy_version_id").notNull(),
    releaseNumber: integer("release_number").notNull(),
    partial: boolean("partial").notNull(),
    reason: text("reason").notNull(),
    counts: jsonb("counts").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    publishedBy: uuid("published_by")
      .notNull()
      .references(() => user.id),
    publishedAt: ts("published_at").notNull().defaultNow(),
  },
  (t) => [
    unique("mapping_releases_ws_id_uq").on(t.workspaceId, t.id),
    unique("mapping_releases_number_uq").on(t.workspaceId, t.releaseNumber),
    unique("mapping_releases_idem_uq").on(t.workspaceId, t.idempotencyKey),
    foreignKey({
      name: "mapping_releases_merchant_fk",
      columns: [t.workspaceId, t.merchantId],
      foreignColumns: [merchants.workspaceId, merchants.id],
    }),
    foreignKey({
      name: "mapping_releases_catalog_fk",
      columns: [t.workspaceId, t.catalogRevisionId],
      foreignColumns: [catalogRevisions.workspaceId, catalogRevisions.id],
    }),
    foreignKey({
      name: "mapping_releases_taxonomy_fk",
      columns: [t.workspaceId, t.taxonomyVersionId],
      foreignColumns: [taxonomyVersions.workspaceId, taxonomyVersions.id],
    }),
    check("mapping_releases_reason", sql`length(trim(${t.reason})) > 0`),
  ],
);

export const publishedMappings = pgTable(
  "published_mappings",
  {
    workspaceId: workspaceId().references(() => workspaces.id),
    releaseId: uuid("release_id").notNull(),
    listingRevisionId: uuid("listing_revision_id").notNull(),
    taxonomyVersionId: uuid("taxonomy_version_id").notNull(),
    conceptId: uuid("concept_id").notNull(),
    decisionId: uuid("decision_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "published_mappings_pk", columns: [t.releaseId, t.listingRevisionId] }),
    index("published_mappings_concept_idx").on(t.workspaceId, t.conceptId),
    foreignKey({
      name: "published_mappings_release_fk",
      columns: [t.workspaceId, t.releaseId],
      foreignColumns: [mappingReleases.workspaceId, mappingReleases.id],
    }),
    foreignKey({
      name: "published_mappings_listing_fk",
      columns: [t.workspaceId, t.listingRevisionId],
      foreignColumns: [listingRevisions.workspaceId, listingRevisions.id],
    }),
    foreignKey({
      name: "published_mappings_concept_fk",
      columns: [t.workspaceId, t.taxonomyVersionId, t.conceptId],
      foreignColumns: [conceptRevisions.workspaceId, conceptRevisions.taxonomyVersionId, conceptRevisions.conceptId],
    }),
    foreignKey({
      name: "published_mappings_decision_fk",
      columns: [t.workspaceId, t.decisionId],
      foreignColumns: [reviewDecisions.workspaceId, reviewDecisions.id],
    }),
  ],
);

/** Listings left out of a release, with the reason at publication time. Immutable. */
export const releaseUnresolved = pgTable(
  "release_unresolved",
  {
    workspaceId: workspaceId().references(() => workspaces.id),
    releaseId: uuid("release_id").notNull(),
    listingRevisionId: uuid("listing_revision_id").notNull(),
    state: reviewStateEnum("state").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [
    primaryKey({ name: "release_unresolved_pk", columns: [t.releaseId, t.listingRevisionId] }),
    foreignKey({
      name: "release_unresolved_release_fk",
      columns: [t.workspaceId, t.releaseId],
      foreignColumns: [mappingReleases.workspaceId, mappingReleases.id],
    }),
    foreignKey({
      name: "release_unresolved_listing_fk",
      columns: [t.workspaceId, t.listingRevisionId],
      foreignColumns: [listingRevisions.workspaceId, listingRevisions.id],
    }),
  ],
);

export const exportFiles = pgTable(
  "export_files",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    releaseId: uuid("release_id").notNull(),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    rowCounts: jsonb("row_counts").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "export_files_release_fk",
      columns: [t.workspaceId, t.releaseId],
      foreignColumns: [mappingReleases.workspaceId, mappingReleases.id],
    }),
  ],
);

export const currentReleases = pgTable(
  "current_releases",
  {
    workspaceId: workspaceId().references(() => workspaces.id),
    merchantId: uuid("merchant_id").notNull(),
    catalogRevisionId: uuid("catalog_revision_id").notNull(),
    releaseId: uuid("release_id").notNull(),
    lockVersion: integer("lock_version").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One current pointer per merchant.
    primaryKey({ name: "current_releases_pk", columns: [t.workspaceId, t.merchantId] }),
    foreignKey({
      name: "current_releases_merchant_fk",
      columns: [t.workspaceId, t.merchantId],
      foreignColumns: [merchants.workspaceId, merchants.id],
    }),
    foreignKey({
      name: "current_releases_release_fk",
      columns: [t.workspaceId, t.releaseId],
      foreignColumns: [mappingReleases.workspaceId, mappingReleases.id],
    }),
    foreignKey({
      name: "current_releases_catalog_fk",
      columns: [t.workspaceId, t.catalogRevisionId],
      foreignColumns: [catalogRevisions.workspaceId, catalogRevisions.id],
    }),
  ],
);

// ---------------------------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------------------------

export const analyticsConversations = pgTable(
  "analytics_conversations",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id),
    title: text("title").notNull(),
    lastSpec: jsonb("last_spec"),
    createdAt: createdAt(),
  },
  (t) => [unique("analytics_conversations_ws_id_uq").on(t.workspaceId, t.id)],
);

export const analyticsRuns = pgTable(
  "analytics_runs",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    conversationId: uuid("conversation_id"),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => user.id),
    question: text("question"),
    validatedSpec: jsonb("validated_spec").notNull(),
    dataScope: jsonb("data_scope").notNull(),
    resultSnapshot: jsonb("result_snapshot"),
    status: text("status").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("analytics_runs_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      name: "analytics_runs_conversation_fk",
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [analyticsConversations.workspaceId, analyticsConversations.id],
    }),
  ],
);

export const savedReports = pgTable(
  "saved_reports",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id),
    name: text("name").notNull(),
    spec: jsonb("spec").notNull(),
    chartConfig: jsonb("chart_config").notNull().default({}),
    visibility: reportVisibilityEnum("visibility").notNull().default("private"),
    lastRunId: uuid("last_run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "saved_reports_run_fk",
      columns: [t.workspaceId, t.lastRunId],
      foreignColumns: [analyticsRuns.workspaceId, analyticsRuns.id],
    }),
  ],
);

// ---------------------------------------------------------------------------------------------
// Audit and idempotency
// ---------------------------------------------------------------------------------------------

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    actorId: uuid("actor_id").references(() => user.id),
    actorRole: text("actor_role").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    beforeRef: jsonb("before_ref"),
    afterRef: jsonb("after_ref"),
    reason: text("reason"),
    requestId: text("request_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_ws_time_idx").on(t.workspaceId, t.createdAt, t.id)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    workspaceId: workspaceId().references(() => workspaces.id),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    actorId: uuid("actor_id").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code").notNull(),
    response: jsonb("response").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ name: "idempotency_keys_pk", columns: [t.workspaceId, t.scope, t.key] })],
);
