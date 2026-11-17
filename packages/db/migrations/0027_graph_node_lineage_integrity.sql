-- Fix 4 Follow-up: Graph Node Lineage Integrity & Immutability Hardening.
-- Enforces:
-- 1. Fail-closed authoritative repository derivation from analysis_runs -> repository_snapshots
--    and explicit rejection of caller-supplied mismatched repository_id values on INSERT.
-- 2. Strict immutability of both repository_id and analysis_run_id on graph_nodes UPDATE.
-- Forward-only migration; applied after 0026 by packages/db migrate runner.

-- 1. Authoritative repository derivation & spoofing rejection trigger function
CREATE OR REPLACE FUNCTION public.fluxora_set_graph_node_repository_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_derived_repo_id uuid;
BEGIN
  -- Resolve authoritative repository identity from analysis_runs -> repository_snapshots
  SELECT rs.repository_id INTO v_derived_repo_id
  FROM public.analysis_runs ar
  JOIN public.repository_snapshots rs ON rs.id = ar.snapshot_id
  WHERE ar.id = NEW.analysis_run_id;

  -- Fail closed if the analysis run or associated repository cannot be resolved
  IF v_derived_repo_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve repository_id for graph_node with analysis_run_id %', NEW.analysis_run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- If caller explicitly supplied a non-null repository_id, reject any mismatch against derived authority
  IF NEW.repository_id IS NOT NULL AND NEW.repository_id IS DISTINCT FROM v_derived_repo_id THEN
    RAISE EXCEPTION 'Explicit repository_id % does not match authoritative repository_id % derived from analysis_run_id %',
      NEW.repository_id, v_derived_repo_id, NEW.analysis_run_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Assign authoritative derived repository ID to NEW.repository_id
  NEW.repository_id := v_derived_repo_id;

  RETURN NEW;
END;
$$;

-- Ensure trigger is attached BEFORE INSERT on public.graph_nodes
DROP TRIGGER IF EXISTS trg_graph_nodes_set_repository_id ON public.graph_nodes;
CREATE TRIGGER trg_graph_nodes_set_repository_id
  BEFORE INSERT ON public.graph_nodes
  FOR EACH ROW
  EXECUTE FUNCTION public.fluxora_set_graph_node_repository_id();

-- 2. Graph node lineage immutability trigger function (repository_id AND analysis_run_id)
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

  IF NEW.analysis_run_id IS DISTINCT FROM OLD.analysis_run_id THEN
    RAISE EXCEPTION 'graph_nodes.analysis_run_id is immutable and cannot be updated'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Ensure trigger is attached BEFORE UPDATE on public.graph_nodes
DROP TRIGGER IF EXISTS trg_graph_nodes_prevent_repository_mutation ON public.graph_nodes;
CREATE TRIGGER trg_graph_nodes_prevent_repository_mutation
  BEFORE UPDATE ON public.graph_nodes
  FOR EACH ROW
  EXECUTE FUNCTION public.fluxora_prevent_graph_node_repository_mutation();

-- 3. Reaffirm execution privileges for runtime and test service roles
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
