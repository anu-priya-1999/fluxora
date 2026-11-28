-- Phase 10 Step 67: Runtime Telemetry Data Foundation.
-- Implements TelemetrySource and Observation tables with tenant RLS,
-- composite repository-node referential integrity, and query indexes.
-- Forward-only; applied by packages/db migrate runner.

-- 1. TelemetrySource table
CREATE TABLE IF NOT EXISTS public.telemetry_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  repository_id uuid NOT NULL
    REFERENCES public.repositories (id)
    ON DELETE CASCADE,

  provider text NOT NULL,
  connection_config text NOT NULL,
  status text NOT NULL DEFAULT 'pending',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT telemetry_sources_repository_id_id_unique
    UNIQUE (repository_id, id),

  CONSTRAINT telemetry_sources_provider_check
    CHECK (provider IN ('datadog', 'otel', 'newrelic')),

  CONSTRAINT telemetry_sources_status_check
    CHECK (status IN ('pending', 'active', 'error', 'disabled')),

  CONSTRAINT telemetry_sources_connection_config_not_empty
    CHECK (length(trim(connection_config)) > 0),

  -- Enforce opaque encrypted envelope format; reject plaintext JSON/arrays or raw tokens.
  CONSTRAINT telemetry_sources_connection_config_encrypted_envelope
    CHECK (connection_config ~ '^(enc|kms):v[0-9]+:[^\s]+$')
);

CREATE INDEX IF NOT EXISTS telemetry_sources_repository_id_idx
  ON public.telemetry_sources (repository_id);

CREATE INDEX IF NOT EXISTS telemetry_sources_repository_provider_idx
  ON public.telemetry_sources (repository_id, provider);

CREATE INDEX IF NOT EXISTS telemetry_sources_repository_status_idx
  ON public.telemetry_sources (repository_id, status);

-- 2. Observation table
CREATE TABLE IF NOT EXISTS public.observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  telemetry_source_id uuid NOT NULL,
  repository_id uuid NOT NULL
    REFERENCES public.repositories (id)
    ON DELETE CASCADE,

  node_id uuid,
  metric_name text NOT NULL,
  value numeric NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT observations_source_repository_fkey
    FOREIGN KEY (repository_id, telemetry_source_id)
    REFERENCES public.telemetry_sources (repository_id, id)
    ON DELETE CASCADE,

  -- When node_id is non-null, enforce that it belongs to the same repository as the source.
  -- ON DELETE SET NULL (node_id) unmaps the observation if a GraphNode is pruned without
  -- nullifying repository_id or deleting historical telemetry observations.
  CONSTRAINT observations_repository_node_fkey
    FOREIGN KEY (repository_id, node_id)
    REFERENCES public.graph_nodes (repository_id, id)
    ON DELETE SET NULL (node_id),

  CONSTRAINT observations_metric_name_check
    CHECK (
      length(trim(metric_name)) > 0
      AND char_length(metric_name) <= 255
      AND metric_name = trim(metric_name)
    ),

  CONSTRAINT observations_value_finite_check
    CHECK (
      value <> 'NaN'::numeric
      AND value <> 'Infinity'::numeric
      AND value <> '-Infinity'::numeric
    )
);

CREATE INDEX IF NOT EXISTS observations_source_observed_at_idx
  ON public.observations (telemetry_source_id, observed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS observations_source_metric_observed_at_idx
  ON public.observations (telemetry_source_id, metric_name, observed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS observations_node_observed_at_idx
  ON public.observations (node_id, observed_at DESC, id DESC)
  WHERE node_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS observations_repository_node_idx
  ON public.observations (repository_id, node_id)
  WHERE node_id IS NOT NULL;

-- 3. Authoritative repository_id derivation and immutability triggers for observations
CREATE OR REPLACE FUNCTION public.fluxora_set_observation_repository_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_derived_repo_id uuid;
BEGIN
  SELECT ts.repository_id INTO v_derived_repo_id
  FROM public.telemetry_sources AS ts
  WHERE ts.id = NEW.telemetry_source_id;

  IF v_derived_repo_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve repository_id for observation with telemetry_source_id %',
      NEW.telemetry_source_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.repository_id IS NOT NULL AND NEW.repository_id IS DISTINCT FROM v_derived_repo_id THEN
    RAISE EXCEPTION 'Explicit repository_id % does not match telemetry_source repository_id %',
      NEW.repository_id, v_derived_repo_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  NEW.repository_id := v_derived_repo_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_observations_set_repository_id ON public.observations;
CREATE TRIGGER trg_observations_set_repository_id
  BEFORE INSERT ON public.observations
  FOR EACH ROW
  EXECUTE FUNCTION public.fluxora_set_observation_repository_id();

CREATE OR REPLACE FUNCTION public.fluxora_prevent_observation_lineage_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.repository_id IS DISTINCT FROM OLD.repository_id THEN
    RAISE EXCEPTION 'observations.repository_id is immutable and cannot be updated'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.telemetry_source_id IS DISTINCT FROM OLD.telemetry_source_id THEN
    RAISE EXCEPTION 'observations.telemetry_source_id is immutable and cannot be updated'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_observations_prevent_lineage_mutation ON public.observations;
CREATE TRIGGER trg_observations_prevent_lineage_mutation
  BEFORE UPDATE ON public.observations
  FOR EACH ROW
  EXECUTE FUNCTION public.fluxora_prevent_observation_lineage_mutation();

-- Also prevent telemetry_sources.repository_id mutation so child observations remain consistent
CREATE OR REPLACE FUNCTION public.fluxora_prevent_telemetry_source_repository_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.repository_id IS DISTINCT FROM OLD.repository_id THEN
    RAISE EXCEPTION 'telemetry_sources.repository_id is immutable and cannot be updated'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_telemetry_sources_prevent_repository_mutation ON public.telemetry_sources;
CREATE TRIGGER trg_telemetry_sources_prevent_repository_mutation
  BEFORE UPDATE ON public.telemetry_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.fluxora_prevent_telemetry_source_repository_mutation();

-- 4. Row-Level Security
ALTER TABLE public.telemetry_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telemetry_sources FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telemetry_sources_tenant_select ON public.telemetry_sources;
CREATE POLICY telemetry_sources_tenant_select ON public.telemetry_sources
  FOR SELECT
  USING (public.fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS telemetry_sources_tenant_insert ON public.telemetry_sources;
CREATE POLICY telemetry_sources_tenant_insert ON public.telemetry_sources
  FOR INSERT
  WITH CHECK (public.fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS telemetry_sources_tenant_update ON public.telemetry_sources;
CREATE POLICY telemetry_sources_tenant_update ON public.telemetry_sources
  FOR UPDATE
  USING (public.fluxora_repository_in_current_tenant(repository_id))
  WITH CHECK (public.fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS telemetry_sources_tenant_delete ON public.telemetry_sources;
CREATE POLICY telemetry_sources_tenant_delete ON public.telemetry_sources
  FOR DELETE
  USING (public.fluxora_repository_in_current_tenant(repository_id));

ALTER TABLE public.observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS observations_tenant_select ON public.observations;
CREATE POLICY observations_tenant_select ON public.observations
  FOR SELECT
  USING (public.fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS observations_tenant_insert ON public.observations;
CREATE POLICY observations_tenant_insert ON public.observations
  FOR INSERT
  WITH CHECK (public.fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS observations_tenant_update ON public.observations;
CREATE POLICY observations_tenant_update ON public.observations
  FOR UPDATE
  USING (public.fluxora_repository_in_current_tenant(repository_id))
  WITH CHECK (public.fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS observations_tenant_delete ON public.observations;
CREATE POLICY observations_tenant_delete ON public.observations
  FOR DELETE
  USING (public.fluxora_repository_in_current_tenant(repository_id));

-- 5. Least-privilege runtime service role grants (if provisioned)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.telemetry_sources TO fluxora_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.observations TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_set_observation_repository_id() TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_prevent_observation_lineage_mutation() TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_prevent_telemetry_source_repository_mutation() TO fluxora_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_worker') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.telemetry_sources TO fluxora_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.observations TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_set_observation_repository_id() TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_prevent_observation_lineage_mutation() TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_prevent_telemetry_source_repository_mutation() TO fluxora_worker;
  END IF;
END
$$;
