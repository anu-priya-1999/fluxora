-- Phase 8 Step 52: Simulation Persistence Foundation (Scenario, Simulation, SimulationResult).
-- Forward-only; applied by packages/db migrate runner.

-- 1. Scenarios Table
CREATE TABLE IF NOT EXISTS scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id uuid NOT NULL
    REFERENCES organizations (id)
    ON DELETE CASCADE,

  repository_id uuid NOT NULL
    REFERENCES repositories (id)
    ON DELETE CASCADE,

  name text NOT NULL,

  target_node_id uuid NOT NULL
    REFERENCES graph_nodes (id)
    ON DELETE CASCADE,

  failure_type text NOT NULL,

  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by uuid
    REFERENCES users (id)
    ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scenarios_name_not_empty
    CHECK (length(trim(name)) > 0),

  CONSTRAINT scenarios_failure_type_check
    CHECK (failure_type IN ('unavailable', 'latency', 'capacity', 'removal'))
);

CREATE INDEX IF NOT EXISTS scenarios_organization_id_idx
  ON scenarios (organization_id);

CREATE INDEX IF NOT EXISTS scenarios_repository_id_idx
  ON scenarios (repository_id);

CREATE INDEX IF NOT EXISTS scenarios_target_node_id_idx
  ON scenarios (target_node_id);

CREATE INDEX IF NOT EXISTS scenarios_repository_created_at_idx
  ON scenarios (repository_id, created_at DESC);

-- 2. Simulations Table
CREATE TABLE IF NOT EXISTS simulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  scenario_id uuid NOT NULL
    REFERENCES scenarios (id)
    ON DELETE CASCADE,

  analysis_run_id uuid NOT NULL
    REFERENCES analysis_runs (id)
    ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'pending',

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT simulations_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS simulations_scenario_id_idx
  ON simulations (scenario_id);

CREATE INDEX IF NOT EXISTS simulations_analysis_run_id_idx
  ON simulations (analysis_run_id);

CREATE INDEX IF NOT EXISTS simulations_scenario_created_at_idx
  ON simulations (scenario_id, created_at DESC);

-- 3. Simulation Results Table
CREATE TABLE IF NOT EXISTS simulation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  simulation_id uuid NOT NULL
    REFERENCES simulations (id)
    ON DELETE CASCADE,

  node_id uuid NOT NULL
    REFERENCES graph_nodes (id)
    ON DELETE CASCADE,

  resulting_state text NOT NULL,

  propagation_path jsonb NOT NULL DEFAULT '[]'::jsonb,

  rule_applied text NOT NULL,

  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,

  confidence double precision NOT NULL DEFAULT 1.0,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT simulation_results_simulation_node_unique
    UNIQUE (simulation_id, node_id),

  CONSTRAINT simulation_results_resulting_state_check
    CHECK (resulting_state IN ('healthy', 'degraded', 'at_risk', 'failed')),

  CONSTRAINT simulation_results_rule_applied_not_empty
    CHECK (length(trim(rule_applied)) > 0),

  CONSTRAINT simulation_results_confidence_range
    CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS simulation_results_simulation_id_idx
  ON simulation_results (simulation_id);

CREATE INDEX IF NOT EXISTS simulation_results_node_id_idx
  ON simulation_results (node_id);

-- 4. RLS Helper Functions
CREATE OR REPLACE FUNCTION fluxora_scenario_in_current_tenant(p_scenario_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM scenarios AS s
    WHERE s.id = p_scenario_id
      AND s.organization_id = fluxora_current_org_id()
  );
$$;

CREATE OR REPLACE FUNCTION fluxora_simulation_in_current_tenant(p_simulation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM simulations AS sim
    JOIN scenarios AS s ON s.id = sim.scenario_id
    WHERE sim.id = p_simulation_id
      AND s.organization_id = fluxora_current_org_id()
  );
$$;

GRANT EXECUTE ON FUNCTION fluxora_scenario_in_current_tenant(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_simulation_in_current_tenant(uuid) TO PUBLIC;

-- 5. Row-Level Security for Scenarios
ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenarios FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scenarios_tenant_select ON scenarios;
CREATE POLICY scenarios_tenant_select ON scenarios
  FOR SELECT
  USING (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS scenarios_tenant_insert ON scenarios;
CREATE POLICY scenarios_tenant_insert ON scenarios
  FOR INSERT
  WITH CHECK (
    organization_id = fluxora_current_org_id()
    AND fluxora_repository_in_current_tenant(repository_id)
  );

DROP POLICY IF EXISTS scenarios_tenant_update ON scenarios;
CREATE POLICY scenarios_tenant_update ON scenarios
  FOR UPDATE
  USING (organization_id = fluxora_current_org_id())
  WITH CHECK (
    organization_id = fluxora_current_org_id()
    AND fluxora_repository_in_current_tenant(repository_id)
  );

DROP POLICY IF EXISTS scenarios_tenant_delete ON scenarios;
CREATE POLICY scenarios_tenant_delete ON scenarios
  FOR DELETE
  USING (organization_id = fluxora_current_org_id());

-- 6. Row-Level Security for Simulations
ALTER TABLE simulations ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS simulations_tenant_select ON simulations;
CREATE POLICY simulations_tenant_select ON simulations
  FOR SELECT
  USING (fluxora_scenario_in_current_tenant(scenario_id));

DROP POLICY IF EXISTS simulations_tenant_insert ON simulations;
CREATE POLICY simulations_tenant_insert ON simulations
  FOR INSERT
  WITH CHECK (
    fluxora_scenario_in_current_tenant(scenario_id)
    AND fluxora_analysis_run_in_current_tenant(analysis_run_id)
  );

DROP POLICY IF EXISTS simulations_tenant_update ON simulations;
CREATE POLICY simulations_tenant_update ON simulations
  FOR UPDATE
  USING (fluxora_scenario_in_current_tenant(scenario_id))
  WITH CHECK (
    fluxora_scenario_in_current_tenant(scenario_id)
    AND fluxora_analysis_run_in_current_tenant(analysis_run_id)
  );

DROP POLICY IF EXISTS simulations_tenant_delete ON simulations;
CREATE POLICY simulations_tenant_delete ON simulations
  FOR DELETE
  USING (fluxora_scenario_in_current_tenant(scenario_id));

-- 7. Row-Level Security for Simulation Results
ALTER TABLE simulation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_results FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS simulation_results_tenant_select ON simulation_results;
CREATE POLICY simulation_results_tenant_select ON simulation_results
  FOR SELECT
  USING (fluxora_simulation_in_current_tenant(simulation_id));

DROP POLICY IF EXISTS simulation_results_tenant_insert ON simulation_results;
CREATE POLICY simulation_results_tenant_insert ON simulation_results
  FOR INSERT
  WITH CHECK (fluxora_simulation_in_current_tenant(simulation_id));

DROP POLICY IF EXISTS simulation_results_tenant_update ON simulation_results;
CREATE POLICY simulation_results_tenant_update ON simulation_results
  FOR UPDATE
  USING (fluxora_simulation_in_current_tenant(simulation_id))
  WITH CHECK (fluxora_simulation_in_current_tenant(simulation_id));

DROP POLICY IF EXISTS simulation_results_tenant_delete ON simulation_results;
CREATE POLICY simulation_results_tenant_delete ON simulation_results
  FOR DELETE
  USING (fluxora_simulation_in_current_tenant(simulation_id));

-- 8. Test Role Grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fluxora_rls_test') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scenarios, simulations, simulation_results TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION fluxora_scenario_in_current_tenant(uuid) TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION fluxora_simulation_in_current_tenant(uuid) TO fluxora_rls_test;
  END IF;
END
$$;
