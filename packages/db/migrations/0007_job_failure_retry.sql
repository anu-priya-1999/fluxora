-- Phase 1 Step 6: job failure, retry, and dead-letter handling.
-- Forward-only; applied by packages/db migrate runner.

CREATE OR REPLACE FUNCTION fluxora_fail_job(
  p_job_id uuid,
  p_worker_id text,
  p_error text
)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  type text,
  payload jsonb,
  status text,
  idempotency_key text,
  attempt_count integer,
  max_attempts integer,
  available_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE jobs AS j
  SET
    status = CASE
      WHEN j.attempt_count >= j.max_attempts
        THEN 'dead_letter'
      ELSE 'failed'
    END,
    last_error = p_error,
    failed_at = now(),
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL
  WHERE
    j.id = p_job_id
    AND j.status = 'running'
    AND j.locked_by = p_worker_id
    AND j.lease_expires_at IS NOT NULL
    AND j.lease_expires_at > now()
  RETURNING
    j.id,
    j.organization_id,
    j.type,
    j.payload,
    j.status,
    j.idempotency_key,
    j.attempt_count,
    j.max_attempts,
    j.available_at,
    j.locked_at,
    j.locked_by,
    j.lease_expires_at,
    j.last_error,
    j.created_at,
    j.started_at,
    j.completed_at,
    j.failed_at;
$$;

REVOKE ALL ON FUNCTION fluxora_fail_job(uuid, text, text) FROM PUBLIC;


CREATE OR REPLACE FUNCTION fluxora_retry_failed_job(
  p_job_id uuid,
  p_retry_delay_seconds integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  type text,
  payload jsonb,
  status text,
  idempotency_key text,
  attempt_count integer,
  max_attempts integer,
  available_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE jobs AS j
  SET
    status = 'pending',
    available_at = now() + make_interval(secs => p_retry_delay_seconds),
    failed_at = NULL
  WHERE
    j.id = p_job_id
    AND j.status = 'failed'
    AND j.attempt_count < j.max_attempts
  RETURNING
    j.id,
    j.organization_id,
    j.type,
    j.payload,
    j.status,
    j.idempotency_key,
    j.attempt_count,
    j.max_attempts,
    j.available_at,
    j.locked_at,
    j.locked_by,
    j.lease_expires_at,
    j.last_error,
    j.created_at,
    j.started_at,
    j.completed_at,
    j.failed_at;
$$;

REVOKE ALL ON FUNCTION fluxora_retry_failed_job(uuid, integer) FROM PUBLIC;