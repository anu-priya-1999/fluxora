-- Phase 9 Step 62: AIAnalysis Persistence Storage.
-- Stores grounded AI explanations and reasoning outputs with tenant isolation and RLS.
-- Forward-only; applied by packages/db migrate runner.

-- 1. AIAnalysis table
CREATE TABLE IF NOT EXISTS ai_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id uuid NOT NULL
    REFERENCES organizations (id)
    ON DELETE CASCADE,

  subject_type text NOT NULL,
  subject_id uuid NOT NULL,

  status text NOT NULL DEFAULT 'pending',
  model_used text,
  prompt_version text,
  input_evidence_ids text[] NOT NULL DEFAULT '{}',
  output_text text,
  output_structured jsonb,
  validation_status text,
  token_count integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_analyses_subject_type_check
    CHECK (subject_type IN ('impact_analysis', 'simulation', 'chat_query')),

  CONSTRAINT ai_analyses_status_check
    CHECK (status IN ('pending', 'completed', 'rejected', 'failed')),

  CONSTRAINT ai_analyses_validation_status_check
    CHECK (validation_status IS NULL OR validation_status IN ('pending', 'passed', 'rejected', 'fallback')),

  CONSTRAINT ai_analyses_token_count_check
    CHECK (token_count >= 0),

  CONSTRAINT ai_analyses_cost_usd_check
    CHECK (cost_usd >= 0),

  CONSTRAINT ai_analyses_latency_ms_check
    CHECK (latency_ms >= 0)
);

-- Unique index ensuring idempotent 1:1 relationship per subject within a tenant
CREATE UNIQUE INDEX IF NOT EXISTS ai_analyses_org_subject_unique
  ON ai_analyses (organization_id, subject_type, subject_id);

CREATE INDEX IF NOT EXISTS ai_analyses_org_id_idx
  ON ai_analyses (organization_id, id);

CREATE INDEX IF NOT EXISTS ai_analyses_subject_idx
  ON ai_analyses (subject_type, subject_id);

-- 2. Row-Level Security
ALTER TABLE ai_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_analyses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_analyses_tenant_select ON ai_analyses;
CREATE POLICY ai_analyses_tenant_select ON ai_analyses
  FOR SELECT
  USING (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS ai_analyses_tenant_insert ON ai_analyses;
CREATE POLICY ai_analyses_tenant_insert ON ai_analyses
  FOR INSERT
  WITH CHECK (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS ai_analyses_tenant_update ON ai_analyses;
CREATE POLICY ai_analyses_tenant_update ON ai_analyses
  FOR UPDATE
  USING (organization_id = fluxora_current_org_id())
  WITH CHECK (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS ai_analyses_tenant_delete ON ai_analyses;
CREATE POLICY ai_analyses_tenant_delete ON ai_analyses
  FOR DELETE
  USING (organization_id = fluxora_current_org_id());
