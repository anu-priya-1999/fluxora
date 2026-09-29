-- Phase 1 Step 6: PostgreSQL-backed job queue.
-- Forward-only; applied by packages/db migrate runner.

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id uuid NOT NULL
    REFERENCES organizations (id)
    ON DELETE CASCADE,

  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  status text NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'running',
        'completed',
        'failed',
        'dead_letter'
      )
    ),

  idempotency_key text NOT NULL,

  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),

  max_attempts integer NOT NULL DEFAULT 3
    CHECK (max_attempts > 0),

  available_at timestamptz NOT NULL DEFAULT now(),

  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,

  last_error text,

  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,

  CONSTRAINT jobs_organization_idempotency_key_unique
    UNIQUE (organization_id, idempotency_key),

  CONSTRAINT jobs_type_not_empty
    CHECK (length(trim(type)) > 0),

  CONSTRAINT jobs_idempotency_key_not_empty
    CHECK (length(trim(idempotency_key)) > 0)
);

CREATE INDEX jobs_claim_idx
  ON jobs (status, available_at, id);

CREATE INDEX jobs_organization_status_idx
  ON jobs (organization_id, status, created_at DESC);

CREATE INDEX jobs_lease_expiry_idx
  ON jobs (status, lease_expires_at);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS jobs_tenant_select ON jobs;
CREATE POLICY jobs_tenant_select ON jobs
  FOR SELECT
  USING (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS jobs_tenant_insert ON jobs;
CREATE POLICY jobs_tenant_insert ON jobs
  FOR INSERT
  WITH CHECK (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS jobs_tenant_update ON jobs;
CREATE POLICY jobs_tenant_update ON jobs
  FOR UPDATE
  USING (organization_id = fluxora_current_org_id())
  WITH CHECK (organization_id = fluxora_current_org_id());