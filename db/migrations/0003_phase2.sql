ALTER TABLE "ai_usage" ADD COLUMN "listing_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "analysis_job_items" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "cost_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "reserved_cost_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "export_files" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_model_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "input_price_per_mtok" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "output_price_per_mtok" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "job_item_cap" integer DEFAULT 5000 NOT NULL;--> statement-breakpoint
-- Cross-workspace job discovery for the worker. SECURITY DEFINER so the restricted application
-- role can find the next job without being able to read any tenant's rows; it returns only the
-- job ID and its workspace, and the worker then sets that workspace as its row-security context.
CREATE FUNCTION claim_analysis_job(p_worker text, p_lease_seconds integer)
RETURNS TABLE (id uuid, workspace_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH candidate AS (
    SELECT j.id FROM analysis_jobs j
    WHERE (j.status IN ('queued', 'cancel_requested') AND (j.lease_expires_at IS NULL OR j.lease_expires_at < now()))
       OR (j.status = 'running' AND j.lease_expires_at < now())
    ORDER BY j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE analysis_jobs j
  SET status = CASE WHEN j.status = 'cancel_requested' THEN j.status ELSE 'running'::job_status END,
      lease_owner = p_worker,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      attempt = j.attempt + 1,
      started_at = coalesce(j.started_at, now())
  FROM candidate c
  WHERE j.id = c.id
  RETURNING j.id, j.workspace_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_analysis_job(text, integer) FROM PUBLIC;
--> statement-breakpoint
-- Storage objects past their retention: uncommitted staged imports after 24 hours and export
-- objects after 7 days (PRD 14.5). Returns keys only; deletion happens per workspace.
CREATE FUNCTION expired_storage_objects(p_now timestamptz)
RETURNS TABLE (kind text, id uuid, workspace_id uuid, storage_key text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT 'import', i.id, i.workspace_id, i.staged_file_key
  FROM import_jobs i
  WHERE i.staged_file_key IS NOT NULL AND i.status <> 'committed' AND i.created_at < p_now - interval '24 hours'
  UNION ALL
  SELECT 'export', e.id, e.workspace_id, e.storage_key
  FROM export_files e
  WHERE e.deleted_at IS NULL AND e.created_at < p_now - interval '7 days';
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION expired_storage_objects(timestamptz) FROM PUBLIC;
