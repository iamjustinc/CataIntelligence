CREATE TYPE "public"."concept_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."decision_action" AS ENUM('approve', 'change', 'reject', 'defer', 'no_suitable');--> statement-breakpoint
CREATE TYPE "public"."decision_origin" AS ENUM('manual', 'suggestion', 'bulk', 'carried_forward', 'revalidated');--> statement-breakpoint
CREATE TYPE "public"."import_kind" AS ENUM('catalog', 'taxonomy');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('staged', 'validated', 'committed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."job_item_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'partially_completed', 'completed', 'cancel_requested', 'canceled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."proposal_state" AS ENUM('submitted', 'approved', 'modified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."proposal_type" AS ENUM('new_leaf', 'synonym');--> statement-breakpoint
CREATE TYPE "public"."provider_mode" AS ENUM('off', 'demo', 'live');--> statement-breakpoint
CREATE TYPE "public"."report_visibility" AS ENUM('private', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('needs_analysis', 'suggested', 'needs_investigation', 'needs_review', 'approved', 'deferred', 'no_suitable_category', 'stale');--> statement-breakpoint
CREATE TYPE "public"."revision_mode" AS ENUM('snapshot', 'delta');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('administrator', 'taxonomist', 'analyst', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."signal_band" AS ENUM('high', 'medium', 'low', 'none');--> statement-breakpoint
CREATE TYPE "public"."taxonomy_state" AS ENUM('draft', 'published', 'discarded');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"job_id" uuid,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text,
	"prompt_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_estimate_usd" numeric(12, 6),
	"status" text NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_job_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"listing_revision_id" uuid NOT NULL,
	"status" "job_item_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"recommendation_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_job_items_job_listing_uq" UNIQUE("job_id","listing_revision_id")
);
--> statement-breakpoint
CREATE TABLE "analysis_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"catalog_revision_id" uuid NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"provider_mode" "provider_mode" NOT NULL,
	"dependency_versions" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"estimate" jsonb,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"idempotency_key" text,
	"error_code" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "analysis_jobs_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "analytics_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"last_spec" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_conversations_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "analytics_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid,
	"actor_id" uuid NOT NULL,
	"question" text,
	"validated_spec" jsonb NOT NULL,
	"data_scope" jsonb NOT NULL,
	"result_snapshot" jsonb,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_runs_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before_ref" jsonb,
	"after_ref" jsonb,
	"reason" text,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"mode" "revision_mode" NOT NULL,
	"prior_revision_id" uuid,
	"import_job_id" uuid,
	"file_hash" text NOT NULL,
	"population_hash" text NOT NULL,
	"counts" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_revisions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "catalog_revisions_merchant_seq_uq" UNIQUE("workspace_id","merchant_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "concept_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"parent_concept_id" uuid,
	"name" text NOT NULL,
	"definition" text DEFAULT '' NOT NULL,
	"synonyms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "concept_status" DEFAULT 'active' NOT NULL,
	"mapping_allowed" boolean DEFAULT false NOT NULL,
	"path" text NOT NULL,
	"depth" integer NOT NULL,
	CONSTRAINT "concept_revisions_version_concept_uq" UNIQUE("workspace_id","taxonomy_version_id","concept_id"),
	CONSTRAINT "concept_revisions_mapping_requires_active" CHECK (not "concept_revisions"."mapping_allowed" or "concept_revisions"."status" = 'active'),
	CONSTRAINT "concept_revisions_depth" CHECK ("concept_revisions"."depth" between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"stable_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concepts_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "concepts_ws_key_uq" UNIQUE("workspace_id","stable_key")
);
--> statement-breakpoint
CREATE TABLE "current_releases" (
	"workspace_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"catalog_revision_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"lock_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "current_releases_pk" PRIMARY KEY("workspace_id","merchant_id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"workspace_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pk" PRIMARY KEY("workspace_id","scope","key")
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "import_kind" NOT NULL,
	"merchant_id" uuid,
	"mode" "revision_mode",
	"status" "import_status" DEFAULT 'staged' NOT NULL,
	"file_name" text NOT NULL,
	"staged_file_key" text,
	"file_hash" text NOT NULL,
	"column_map" jsonb,
	"validation_summary" jsonb,
	"idempotency_key" text,
	"result_revision_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	CONSTRAINT "import_jobs_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "import_jobs_catalog_requires_merchant" CHECK ("import_jobs"."kind" <> 'catalog' or "import_jobs"."merchant_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "listing_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"catalog_revision_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"title" text NOT NULL,
	"merchant_category_path" text,
	"price" numeric(14, 4),
	"currency" text,
	"raw_json" jsonb NOT NULL,
	"normalized_json" jsonb NOT NULL,
	"source_row" integer,
	"content_hash" text NOT NULL,
	"carried_from_revision_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_revisions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "listing_revisions_rev_listing_uq" UNIQUE("catalog_revision_id","listing_id"),
	CONSTRAINT "listing_revisions_price_currency" CHECK ("listing_revisions"."price" is null or ("listing_revisions"."price" >= 0 and "listing_revisions"."currency" is not null))
);
--> statement-breakpoint
CREATE TABLE "mapping_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"catalog_revision_id" uuid NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"release_number" integer NOT NULL,
	"partial" boolean NOT NULL,
	"reason" text NOT NULL,
	"counts" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"published_by" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mapping_releases_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "mapping_releases_number_uq" UNIQUE("workspace_id","release_number"),
	CONSTRAINT "mapping_releases_idem_uq" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mapping_releases_reason" CHECK (length(trim("mapping_releases"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_ws_user_uq" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "merchant_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"merchant_sku" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_listings_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "merchant_listings_sku_uq" UNIQUE("workspace_id","merchant_id","merchant_sku")
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"external_key" text,
	"region" text,
	"active" boolean DEFAULT true NOT NULL,
	"active_catalog_revision_id" uuid,
	"lock_version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "published_mappings" (
	"workspace_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"listing_revision_id" uuid NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	CONSTRAINT "published_mappings_pk" PRIMARY KEY("release_id","listing_revision_id")
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"listing_revision_id" uuid NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"job_id" uuid,
	"provider" text NOT NULL,
	"is_demo" boolean NOT NULL,
	"model_id" text,
	"prompt_version" text,
	"retrieval_policy_version" text,
	"policy_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"selected_concept_id" uuid,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ambiguity_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_information" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_concept" jsonb,
	"signal_band" "signal_band" NOT NULL,
	"signal_basis" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendations_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"listing_revision_id" uuid NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"recommendation_id" uuid,
	"action" "decision_action" NOT NULL,
	"origin" "decision_origin" DEFAULT 'manual' NOT NULL,
	"selected_concept_id" uuid,
	"reason" text,
	"batch_id" uuid,
	"duration_seconds" integer,
	"previous_decision_id" uuid,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_decisions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "review_decisions_target_required" CHECK (("review_decisions"."action" in ('approve', 'change')) = ("review_decisions"."selected_concept_id" is not null)),
	CONSTRAINT "review_decisions_reason_required" CHECK ("review_decisions"."action" not in ('change', 'reject') or length(trim(coalesce("review_decisions"."reason", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "review_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"listing_revision_id" uuid NOT NULL,
	"taxonomy_version_id" uuid,
	"state" "review_state" DEFAULT 'needs_analysis' NOT NULL,
	"latest_decision_id" uuid,
	"latest_recommendation_id" uuid,
	"ambiguous" boolean DEFAULT false NOT NULL,
	"analysis_failed" boolean DEFAULT false NOT NULL,
	"lock_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_states_listing_uq" UNIQUE("listing_revision_id"),
	CONSTRAINT "review_states_approved_has_decision" CHECK ("review_states"."state" <> 'approved' or "review_states"."latest_decision_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "saved_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"chart_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" "report_visibility" DEFAULT 'private' NOT NULL,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "taxonomy_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "proposal_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"evidence_listing_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text NOT NULL,
	"state" "proposal_state" DEFAULT 'submitted' NOT NULL,
	"base_version_id" uuid,
	"applied_version_id" uuid,
	"submitted_by" uuid NOT NULL,
	"decided_by" uuid,
	"decision_reason" text,
	"lock_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "taxonomy_proposals_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "taxonomy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"state" "taxonomy_state" DEFAULT 'draft' NOT NULL,
	"base_version_id" uuid,
	"note" text,
	"lock_version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	CONSTRAINT "taxonomy_versions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "taxonomy_versions_ws_seq_uq" UNIQUE("workspace_id","sequence"),
	CONSTRAINT "taxonomy_versions_published_fields" CHECK ("taxonomy_versions"."state" <> 'published' or ("taxonomy_versions"."published_by" is not null and "taxonomy_versions"."published_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"active_taxonomy_version_id" uuid,
	"provider_mode" "provider_mode" DEFAULT 'off' NOT NULL,
	"live_ai_opt_in" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"job_token_cap" integer DEFAULT 400000 NOT NULL,
	"job_spend_cap_usd" numeric(10, 2) DEFAULT '5' NOT NULL,
	"daily_spend_cap_usd" numeric(10, 2) DEFAULT '20' NOT NULL,
	"lock_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_job_items" ADD CONSTRAINT "analysis_job_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_job_items" ADD CONSTRAINT "analysis_job_items_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."analysis_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_job_items" ADD CONSTRAINT "analysis_job_items_listing_fk" FOREIGN KEY ("workspace_id","listing_revision_id") REFERENCES "public"."listing_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_catalog_fk" FOREIGN KEY ("workspace_id","catalog_revision_id") REFERENCES "public"."catalog_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_taxonomy_fk" FOREIGN KEY ("workspace_id","taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_conversations" ADD CONSTRAINT "analytics_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_conversations" ADD CONSTRAINT "analytics_conversations_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_runs" ADD CONSTRAINT "analytics_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_runs" ADD CONSTRAINT "analytics_runs_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_runs" ADD CONSTRAINT "analytics_runs_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."analytics_conversations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_merchant_fk" FOREIGN KEY ("workspace_id","merchant_id") REFERENCES "public"."merchants"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_prior_fk" FOREIGN KEY ("workspace_id","prior_revision_id") REFERENCES "public"."catalog_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_import_fk" FOREIGN KEY ("workspace_id","import_job_id") REFERENCES "public"."import_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_revisions" ADD CONSTRAINT "concept_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_revisions" ADD CONSTRAINT "concept_revisions_version_fk" FOREIGN KEY ("workspace_id","taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_revisions" ADD CONSTRAINT "concept_revisions_concept_fk" FOREIGN KEY ("workspace_id","concept_id") REFERENCES "public"."concepts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_revisions" ADD CONSTRAINT "concept_revisions_parent_fk" FOREIGN KEY ("workspace_id","taxonomy_version_id","parent_concept_id") REFERENCES "public"."concept_revisions"("workspace_id","taxonomy_version_id","concept_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "current_releases" ADD CONSTRAINT "current_releases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "current_releases" ADD CONSTRAINT "current_releases_merchant_fk" FOREIGN KEY ("workspace_id","merchant_id") REFERENCES "public"."merchants"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "current_releases" ADD CONSTRAINT "current_releases_release_fk" FOREIGN KEY ("workspace_id","release_id") REFERENCES "public"."mapping_releases"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "current_releases" ADD CONSTRAINT "current_releases_catalog_fk" FOREIGN KEY ("workspace_id","catalog_revision_id") REFERENCES "public"."catalog_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_merchant_fk" FOREIGN KEY ("workspace_id","merchant_id") REFERENCES "public"."merchants"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_revisions" ADD CONSTRAINT "listing_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_revisions" ADD CONSTRAINT "listing_revisions_catalog_fk" FOREIGN KEY ("workspace_id","catalog_revision_id") REFERENCES "public"."catalog_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_revisions" ADD CONSTRAINT "listing_revisions_listing_fk" FOREIGN KEY ("workspace_id","listing_id") REFERENCES "public"."merchant_listings"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_releases" ADD CONSTRAINT "mapping_releases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_releases" ADD CONSTRAINT "mapping_releases_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_releases" ADD CONSTRAINT "mapping_releases_merchant_fk" FOREIGN KEY ("workspace_id","merchant_id") REFERENCES "public"."merchants"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_releases" ADD CONSTRAINT "mapping_releases_catalog_fk" FOREIGN KEY ("workspace_id","catalog_revision_id") REFERENCES "public"."catalog_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_releases" ADD CONSTRAINT "mapping_releases_taxonomy_fk" FOREIGN KEY ("workspace_id","taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_listings" ADD CONSTRAINT "merchant_listings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_listings" ADD CONSTRAINT "merchant_listings_merchant_fk" FOREIGN KEY ("workspace_id","merchant_id") REFERENCES "public"."merchants"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_mappings" ADD CONSTRAINT "published_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_mappings" ADD CONSTRAINT "published_mappings_release_fk" FOREIGN KEY ("workspace_id","release_id") REFERENCES "public"."mapping_releases"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_mappings" ADD CONSTRAINT "published_mappings_listing_fk" FOREIGN KEY ("workspace_id","listing_revision_id") REFERENCES "public"."listing_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_mappings" ADD CONSTRAINT "published_mappings_concept_fk" FOREIGN KEY ("workspace_id","taxonomy_version_id","concept_id") REFERENCES "public"."concept_revisions"("workspace_id","taxonomy_version_id","concept_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_mappings" ADD CONSTRAINT "published_mappings_decision_fk" FOREIGN KEY ("workspace_id","decision_id") REFERENCES "public"."review_decisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_listing_fk" FOREIGN KEY ("workspace_id","listing_revision_id") REFERENCES "public"."listing_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_selected_fk" FOREIGN KEY ("workspace_id","taxonomy_version_id","selected_concept_id") REFERENCES "public"."concept_revisions"("workspace_id","taxonomy_version_id","concept_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_version_fk" FOREIGN KEY ("workspace_id","taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_listing_fk" FOREIGN KEY ("workspace_id","listing_revision_id") REFERENCES "public"."listing_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_target_fk" FOREIGN KEY ("workspace_id","taxonomy_version_id","selected_concept_id") REFERENCES "public"."concept_revisions"("workspace_id","taxonomy_version_id","concept_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_version_fk" FOREIGN KEY ("workspace_id","taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_recommendation_fk" FOREIGN KEY ("workspace_id","recommendation_id") REFERENCES "public"."recommendations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_previous_fk" FOREIGN KEY ("workspace_id","previous_decision_id") REFERENCES "public"."review_decisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_states" ADD CONSTRAINT "review_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_states" ADD CONSTRAINT "review_states_listing_fk" FOREIGN KEY ("workspace_id","listing_revision_id") REFERENCES "public"."listing_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_states" ADD CONSTRAINT "review_states_decision_fk" FOREIGN KEY ("workspace_id","latest_decision_id") REFERENCES "public"."review_decisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_states" ADD CONSTRAINT "review_states_recommendation_fk" FOREIGN KEY ("workspace_id","latest_recommendation_id") REFERENCES "public"."recommendations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_run_fk" FOREIGN KEY ("workspace_id","last_run_id") REFERENCES "public"."analytics_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_proposals" ADD CONSTRAINT "taxonomy_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_proposals" ADD CONSTRAINT "taxonomy_proposals_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_proposals" ADD CONSTRAINT "taxonomy_proposals_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_proposals" ADD CONSTRAINT "taxonomy_proposals_applied_fk" FOREIGN KEY ("workspace_id","applied_version_id") REFERENCES "public"."taxonomy_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_versions" ADD CONSTRAINT "taxonomy_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_versions" ADD CONSTRAINT "taxonomy_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_versions" ADD CONSTRAINT "taxonomy_versions_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_versions" ADD CONSTRAINT "taxonomy_versions_base_fk" FOREIGN KEY ("workspace_id","base_version_id") REFERENCES "public"."taxonomy_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_active_taxonomy_fk" FOREIGN KEY ("id","active_taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "analysis_jobs_claim_idx" ON "analysis_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "audit_events_ws_time_idx" ON "audit_events" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "concept_revisions_parent_idx" ON "concept_revisions" USING btree ("taxonomy_version_id","parent_concept_id");--> statement-breakpoint
CREATE INDEX "listing_revisions_catalog_idx" ON "listing_revisions" USING btree ("workspace_id","catalog_revision_id","active");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_ws_name_uq" ON "merchants" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_ws_external_key_uq" ON "merchants" USING btree ("workspace_id","external_key") WHERE "merchants"."external_key" is not null;--> statement-breakpoint
CREATE INDEX "published_mappings_concept_idx" ON "published_mappings" USING btree ("workspace_id","concept_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_job_listing_uq" ON "recommendations" USING btree ("job_id","listing_revision_id") WHERE "recommendations"."job_id" is not null;--> statement-breakpoint
CREATE INDEX "recommendations_listing_idx" ON "recommendations" USING btree ("listing_revision_id","created_at");--> statement-breakpoint
CREATE INDEX "review_decisions_listing_idx" ON "review_decisions" USING btree ("listing_revision_id","created_at");--> statement-breakpoint
CREATE INDEX "review_states_queue_idx" ON "review_states" USING btree ("workspace_id","state","updated_at","id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_versions_one_draft_uq" ON "taxonomy_versions" USING btree ("workspace_id") WHERE "taxonomy_versions"."state" = 'draft';