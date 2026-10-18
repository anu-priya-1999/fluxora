-- Phase 6 Step 44: ImpactAnalysis Persistence + Evidence.
-- Stores deterministic pull request impact analysis results with tenant isolation and RLS.
-- Forward-only; applied by packages/db migrate runner.

-- 1. ImpactAnalysis table
CREATE TABLE IF NOT EXISTS impact_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  pull_request_id uuid NOT NULL
    REFERENCES pull_requests (id)
    ON DELETE CASCADE,

  analysis_run_id uuid NOT NULL
    REFERENCES analysis_runs (id)
    ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'completed',
  direct_impact jsonb NOT NULL DEFAULT '[]'::jsonb,
  downstream_impact jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_apis jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_events jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_services jsonb NOT NULL DEFAULT '[]'::jsonb,
  workflow_impact_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  unresolved_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  truncated boolean NOT NULL DEFAULT false,
  truncation_reason text,
  max_depth_reached integer NOT NULL DEFAULT 0,
  execution_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT impact_analyses_status_valid
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),

  CONSTRAINT impact_analyses_max_depth_non_negative
    CHECK (max_depth_reached >= 0)
);

CREATE INDEX IF NOT EXISTS impact_analyses_pull_request_id_idx
  ON impact_analyses (pull_request_id);

CREATE INDEX IF NOT EXISTS impact_analyses_analysis_run_id_idx
  ON impact_analyses (analysis_run_id);

CREATE INDEX IF NOT EXISTS impact_analyses_pull_request_created_at_idx
  ON impact_analyses (pull_request_id, created_at DESC);

-- Partial index on evidence for fast retrieval of impact finding evidence
CREATE INDEX IF NOT EXISTS evidence_impact_analysis_id_idx
  ON evidence ((metadata->>'impactAnalysisId'))
  WHERE subject_type = 'impact_finding';

-- 2. Tenant helper function for impact_analyses
CREATE OR REPLACE FUNCTION fluxora_impact_analysis_in_current_tenant(p_impact_analysis_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM impact_analyses AS ia
    JOIN pull_requests AS pr ON pr.id = ia.pull_request_id
    WHERE ia.id = p_impact_analysis_id
      AND pr.organization_id = fluxora_current_org_id()
  );
$$;

GRANT EXECUTE ON FUNCTION fluxora_impact_analysis_in_current_tenant(uuid) TO PUBLIC;

-- 3. Row-Level Security
ALTER TABLE impact_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE impact_analyses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS impact_analyses_tenant_select ON impact_analyses;
CREATE POLICY impact_analyses_tenant_select ON impact_analyses
  FOR SELECT
  USING (fluxora_pull_request_in_current_tenant(pull_request_id));

DROP POLICY IF EXISTS impact_analyses_tenant_insert ON impact_analyses;
CREATE POLICY impact_analyses_tenant_insert ON impact_analyses
  FOR INSERT
  WITH CHECK (
    fluxora_pull_request_in_current_tenant(pull_request_id)
    AND fluxora_analysis_run_in_current_tenant(analysis_run_id)
  );

DROP POLICY IF EXISTS impact_analyses_tenant_update ON impact_analyses;
CREATE POLICY impact_analyses_tenant_update ON impact_analyses
  FOR UPDATE
  USING (fluxora_pull_request_in_current_tenant(pull_request_id))
  WITH CHECK (
    fluxora_pull_request_in_current_tenant(pull_request_id)
    AND fluxora_analysis_run_in_current_tenant(analysis_run_id)
  );

DROP POLICY IF EXISTS impact_analyses_tenant_delete ON impact_analyses;
CREATE POLICY impact_analyses_tenant_delete ON impact_analyses
  FOR DELETE
  USING (fluxora_pull_request_in_current_tenant(pull_request_id));

-- Grant permissions to fluxora_rls_test if role exists (for test runner environments)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fluxora_rls_test') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE impact_analyses TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION fluxora_impact_analysis_in_current_tenant(uuid) TO fluxora_rls_test;
  END IF;
END
$$;

