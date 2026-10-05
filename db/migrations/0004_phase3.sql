ALTER TABLE "analytics_runs" ADD COLUMN "planner" text;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD COLUMN "snapshot_run_id" uuid;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD COLUMN "lock_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_snapshot_fk" FOREIGN KEY ("workspace_id","snapshot_run_id") REFERENCES "public"."analytics_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A stored run is the evidence behind a saved report snapshot: it is never edited.
CREATE TRIGGER analytics_runs_append_only BEFORE UPDATE OR DELETE ON analytics_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
