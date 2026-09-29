-- Phase 1 Step 6: atomic job claiming.
-- Forward-only; applied by packages/db migrate runner.

CREATE OR REPLACE FUNCTION fluxora_claim_next_job(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 60
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
  WITH candidate AS (
    SELECT j.id
    FROM jobs AS j
    WHERE
      (
        j.status = 'pending'
        OR (
          j.status = 'running'
          AND j.lease_expires_at IS NOT NULL
          AND j.lease_expires_at <= now()
        )
      )
      AND j.available_at <= now()
    ORDER BY j.available_at ASC, j.id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE jobs AS j
  SET
    status = 'running',
    attempt_count = j.attempt_count + 1,
    locked_at = now(),
    locked_by = p_worker_id,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    started_at = COALESCE(j.started_at, now()),
    last_error = NULL
  FROM candidate
  WHERE j.id = candidate.id
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

REVOKE ALL ON FUNCTION fluxora_claim_next_job(text, integer) FROM PUBLIC;