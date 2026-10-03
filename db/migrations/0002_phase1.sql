CREATE TABLE "export_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"row_counts" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_unresolved" (
	"workspace_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"listing_revision_id" uuid NOT NULL,
	"state" "review_state" NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "release_unresolved_pk" PRIMARY KEY("release_id","listing_revision_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "high_signal_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "export_files" ADD CONSTRAINT "export_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_files" ADD CONSTRAINT "export_files_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_files" ADD CONSTRAINT "export_files_release_fk" FOREIGN KEY ("workspace_id","release_id") REFERENCES "public"."mapping_releases"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_unresolved" ADD CONSTRAINT "release_unresolved_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_unresolved" ADD CONSTRAINT "release_unresolved_release_fk" FOREIGN KEY ("workspace_id","release_id") REFERENCES "public"."mapping_releases"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_unresolved" ADD CONSTRAINT "release_unresolved_listing_fk" FOREIGN KEY ("workspace_id","listing_revision_id") REFERENCES "public"."listing_revisions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
SELECT apply_workspace_rls();
--> statement-breakpoint
CREATE TRIGGER release_unresolved_append_only BEFORE UPDATE OR DELETE ON release_unresolved FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
