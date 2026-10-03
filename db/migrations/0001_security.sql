-- Hand-written migration: session context helpers, row-level security, deferred tree FK and
-- database-level immutability for published or append-only records.

-- 1. Session context -----------------------------------------------------------------------
-- The application sets these per transaction with set_config(..., true). They are never taken
-- from client input: the server derives them from the authenticated session and membership.
CREATE FUNCTION app_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- 2. Whole trees are written in one transaction, so the parent reference is checked at commit.
ALTER TABLE concept_revisions ALTER CONSTRAINT concept_revisions_parent_fk DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

ALTER TABLE merchants ADD CONSTRAINT merchants_active_revision_fk
  FOREIGN KEY (workspace_id, active_catalog_revision_id) REFERENCES catalog_revisions (workspace_id, id);
--> statement-breakpoint

-- 3. Row-level security ----------------------------------------------------------------------
-- Every table with a workspace_id column gets the same isolation policy. Later migrations that
-- add tenant tables must call apply_workspace_rls() again (tests/integration/rls.test.ts verifies
-- that no tenant table is left uncovered).
CREATE FUNCTION apply_workspace_rls() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %I', t.table_name);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      t.table_name);
  END LOOP;
END $$;
--> statement-breakpoint
SELECT apply_workspace_rls();
--> statement-breakpoint

-- A signed-in user may list their own memberships before a workspace context is chosen.
CREATE POLICY own_memberships ON memberships FOR SELECT USING (user_id = app_user_id());
--> statement-breakpoint

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_read ON workspaces FOR SELECT USING (
  id = app_workspace_id()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = workspaces.id AND m.user_id = app_user_id() AND m.active)
);
--> statement-breakpoint
CREATE POLICY workspace_insert ON workspaces FOR INSERT WITH CHECK (id = app_workspace_id());
--> statement-breakpoint
CREATE POLICY workspace_update ON workspaces FOR UPDATE USING (id = app_workspace_id()) WITH CHECK (id = app_workspace_id());
--> statement-breakpoint

-- 4. Immutability ----------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: records are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER mapping_releases_append_only BEFORE UPDATE OR DELETE ON mapping_releases FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER published_mappings_append_only BEFORE UPDATE OR DELETE ON published_mappings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER review_decisions_append_only BEFORE UPDATE OR DELETE ON review_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER recommendations_append_only BEFORE UPDATE OR DELETE ON recommendations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER catalog_revisions_append_only BEFORE UPDATE OR DELETE ON catalog_revisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER listing_revisions_append_only BEFORE UPDATE OR DELETE ON listing_revisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- A taxonomy version is frozen once it leaves the draft state.
CREATE FUNCTION guard_taxonomy_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'taxonomy version % is % and cannot be changed', OLD.id, OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER taxonomy_versions_frozen BEFORE UPDATE OR DELETE ON taxonomy_versions FOR EACH ROW EXECUTE FUNCTION guard_taxonomy_version();
--> statement-breakpoint

CREATE FUNCTION guard_concept_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_state taxonomy_state; version_id uuid;
BEGIN
  version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.taxonomy_version_id ELSE NEW.taxonomy_version_id END;
  SELECT state INTO version_state FROM taxonomy_versions WHERE id = version_id;
  IF version_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'concepts of taxonomy version % cannot be changed: version is %', version_id, coalesce(version_state::text, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.taxonomy_version_id <> NEW.taxonomy_version_id THEN
    RAISE EXCEPTION 'concept revisions cannot move between taxonomy versions' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER concept_revisions_frozen BEFORE INSERT OR UPDATE OR DELETE ON concept_revisions FOR EACH ROW EXECUTE FUNCTION guard_concept_revision();
