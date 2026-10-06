CREATE TABLE "stored_objects" (
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"content" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_objects_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
ALTER TABLE "stored_objects" ADD CONSTRAINT "stored_objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
SELECT apply_workspace_rls();
