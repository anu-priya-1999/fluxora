-- Phase 8 / Fix 4: Scenario and Repository Referential Integrity.
-- Establishes composite foreign key from scenarios (repository_id, target_node_id)
-- to graph_nodes (repository_id, id), ensuring that PostgreSQL rejects any scenario
-- where target_node_id does not belong to repository_id.
-- Forward-only; applied by packages/db migrate runner.

-- 1. Temporarily relax FORCE ROW LEVEL SECURITY for the migration session.
-- Under FORCE ROW LEVEL SECURITY, even the table-owning migration role is subject
-- to tenant RLS policies that evaluate fluxora_analysis_run_in_current_tenant.
-- Under NO FORCE ROW LEVEL SECURITY, the table owner safely bypasses RLS policies
-- to perform schema-level validation and backfills without violating tenant isolation
-- for normal application sessions. FORCE RLS is reaffirmed at the end of this migration.
ALTER TABLE public.graph_nodes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.repository_snapshots NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.scenarios NO FORCE ROW LEVEL SECURITY;

-- 2. Pre-migration Data Audit (Fail-closed)
DO $$
DECLARE
  v_mismatch_count integer;
  v_orphan_node_count integer;
BEGIN
  -- Check for orphaned graph_nodes that cannot be linked to any repository
  SELECT count(*)
  INTO v_orphan_node_count
  FROM public.graph_nodes gn
  LEFT JOIN public.analysis_runs ar ON ar.id = gn.analysis_run_id
  LEFT JOIN public.repository_snapshots rs ON rs.id = ar.snapshot_id
  WHERE rs.repository_id IS NULL;

  IF v_orphan_node_count > 0 THEN
    RAISE EXCEPTION 'Migration 0026 aborted: Found % orphaned graph_node records without an associated repository.',
      v_orphan_node_count
      USING ERRCODE = 'check_violation';
  END IF;

  -- Check for existing scenario records whose target_node_id does not belong to repository_id
  SELECT count(*)
  INTO v_mismatch_count
  FROM public.scenarios s
  LEFT JOIN public.graph_nodes gn ON gn.id = s.target_node_id
  LEFT JOIN public.analysis_runs ar ON ar.id = gn.analysis_run_id
  LEFT JOIN public.repository_snapshots rs ON rs.id = ar.snapshot_id
  WHERE s.target_node_id IS NOT NULL
    AND (
      gn.id IS NULL
      OR rs.repository_id IS DISTINCT FROM s.repository_id
    );

  IF v_mismatch_count > 0 THEN
    RAISE EXCEPTION 'Migration 0026 aborted: Found % scenario records with target_node_id not belonging to scenario repository_id.',
      v_mismatch_count
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- 3. Add repository_id column to graph_nodes if not already present
ALTER TABLE public.graph_nodes
  ADD COLUMN IF NOT EXISTS repository_id uuid;

-- 4. Backfill repository_id for existing graph_nodes from analysis_runs -> repository_snapshots
UPDATE public.graph_nodes gn
SET repository_id = rs.repository_id
FROM public.analysis_runs ar
JOIN public.repository_snapshots rs ON rs.id = ar.snapshot_id
WHERE ar.id = gn.analysis_run_id
  AND gn.repository_id IS NULL;

-- 5. Enforce NOT NULL on graph_nodes.repository_id
ALTER TABLE public.graph_nodes
  ALTER COLUMN repository_id SET NOT NULL;

-- 6. Foreign Key from graph_nodes.repository_id to repositories(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'graph_nodes_repository_id_fkey'
  ) THEN
    ALTER TABLE public.graph_nodes
      ADD CONSTRAINT graph_nodes_repository_id_fkey
      FOREIGN KEY (repository_id)
      REFERENCES public.repositories (id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- 7. Composite UNIQUE constraint on graph_nodes (repository_id, id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'graph_nodes_repository_id_id_unique'
  ) THEN
    ALTER TABLE public.graph_nodes
      ADD CONSTRAINT graph_nodes_repository_id_id_unique
      UNIQUE (repository_id, id);
  END IF;
END
$$;

-- 8. Automated repository derivation and immutability triggers for graph_nodes
CREATE OR REPLACE FUNCTION public.fluxora_set_graph_node_repository_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.repository_id IS NULL THEN
    SELECT rs.repository_id INTO NEW.repository_id
    FROM public.analysis_runs ar
    JOIN public.repository_snapshots rs ON rs.id = ar.snapshot_id
    WHERE ar.id = NEW.analysis_run_id;
  END IF;

  IF NEW.repository_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve repository_id for graph_node with analysis_run_id %', NEW.analysis_run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_graph_nodes_set_repository_id ON public.graph_nodes;
CREATE TRIGGER trg_graph_nodes_set_repository_id
  BEFORE INSERT ON public.graph_nodes
  FOR EACH ROW
  EXECUTE FUNCTION public.fluxora_set_graph_node_repository_id();

CREATE OR REPLACE FUNCTION public.fluxora_prevent_graph_node_repository_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.repository_id IS DISTINCT FROM OLD.repository_id THEN
    RAISE EXCEPTION 'graph_nodes.repository_id is immutable and cannot be updated'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_graph_nodes_prevent_repository_mutation ON public.graph_nodes;
CREATE TRIGGER trg_graph_nodes_prevent_repository_mutation
  BEFORE UPDATE ON public.graph_nodes
  FOR EACH ROW
  EXECUTE FUNCTION public.fluxora_prevent_graph_node_repository_mutation();

-- 9. Replace scenarios.target_node_id foreign key with composite foreign key
ALTER TABLE public.scenarios
  DROP CONSTRAINT IF EXISTS scenarios_target_node_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scenarios_repository_target_node_fkey'
  ) THEN
    ALTER TABLE public.scenarios
      ADD CONSTRAINT scenarios_repository_target_node_fkey
      FOREIGN KEY (repository_id, target_node_id)
      REFERENCES public.graph_nodes (repository_id, id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- 10. Composite index on scenarios (repository_id, target_node_id)
CREATE INDEX IF NOT EXISTS scenarios_repository_target_node_idx
  ON public.scenarios (repository_id, target_node_id);

-- 11. Reaffirm FORCE ROW LEVEL SECURITY across all affected tables
ALTER TABLE public.graph_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graph_nodes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_runs FORCE ROW LEVEL SECURITY;

ALTER TABLE public.repository_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repository_snapshots FORCE ROW LEVEL SECURITY;

ALTER TABLE public.scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scenarios FORCE ROW LEVEL SECURITY;

-- 12. Service role execution grants on trigger functions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fluxora_app') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_set_graph_node_repository_id() TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_prevent_graph_node_repository_mutation() TO fluxora_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fluxora_worker') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_set_graph_node_repository_id() TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_prevent_graph_node_repository_mutation() TO fluxora_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fluxora_rls_test') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_set_graph_node_repository_id() TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION public.fluxora_prevent_graph_node_repository_mutation() TO fluxora_rls_test;
  END IF;
END
$$;
