-- Fluxora production hardening Fix 2: worker crash recovery and retry limits.
-- Migration: 0022_job_queue_crash_recovery_retry_limit.sql
--
-- Background:
--   * When a worker process crashes unexpectedly, it does not invoke
--     public.fluxora_fail_job or public.fluxora_retry_failed_job.
--   * Under historical claim behavior, an expired running job was reclaimed
--     without verifying attempt_count < max_attempts, allowing attempt_count
--     to exceed max_attempts indefinitely on crashes and bypassing the retry limit.
--   * Attempt-count invariant: 0 <= attempt_count <= max_attempts.
--   * attempt_count represents the number of execution attempts successfully claimed.
--   * A job must never be returned to a worker if claiming it would cause attempt_count
--     to exceed max_attempts.
--
-- Implementation:
--   1. Obtain temporary membership in fluxora_queue and schema CREATE privilege.
--   2. Update public.fluxora_claim_next_job:
--      a. Clean up expired running jobs that reached or exceeded max_attempts,
--         and pending jobs already at or above max_attempts (bounded batch with FOR UPDATE SKIP LOCKED).
--      b. Clear locked_at, locked_by, lease_expires_at, record terminal timestamp failed_at,
--         and store a sanitized error message indicating lease expiration after retry limit reached.
--      c. Only claim candidates where attempt_count < max_attempts, atomically incrementing
--         attempt_count exactly once and setting lease metadata.
--   3. Transfer function ownership to fluxora_queue.
--   4. Revoke ALL on function from PUBLIC.
--   5. Grant EXECUTE to CURRENT_USER (and optional runtime worker/test roles).
--   6. Revoke temporary schema privileges and membership immediately.
--   7. Maintain FORCE ROW LEVEL SECURITY on public.jobs.
--   8. Validation block: verify function ownership, search_path, prosecdef, and execute grants.

-- 1. Obtain temporary owner-role authority and schema privileges.
GRANT fluxora_queue TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO fluxora_queue;

-- 2. Update fluxora_claim_next_job to enforce crash recovery and attempt limits.
CREATE OR REPLACE FUNCTION public.fluxora_claim_next_job(
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- A. Clean up expired running jobs that reached or exceeded max_attempts,
  --    and pending jobs already at or above max_attempts.
  --    Use FOR UPDATE SKIP LOCKED to prevent blocking concurrent claim operations.
  --    Limit to a bounded batch of 25 rows per claim call.
  UPDATE public.jobs AS j
  SET
    status = 'dead_letter',
    failed_at = pg_catalog.now(),
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL,
    last_error = CASE
      WHEN j.status = 'running'
        THEN 'Job lease expired after retry limit reached'
      ELSE COALESCE(j.last_error, 'Job exceeded retry limit while pending')
    END
  WHERE j.id IN (
    SELECT e.id
    FROM public.jobs AS e
    WHERE
      (
        (
          e.status = 'running'
          AND e.lease_expires_at IS NOT NULL
          AND e.lease_expires_at <= pg_catalog.now()
          AND e.attempt_count >= e.max_attempts
        )
        OR (
          e.status = 'pending'
          AND e.attempt_count >= e.max_attempts
        )
      )
    ORDER BY e.available_at ASC, e.id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 25
  );

  -- B. Atomically claim next eligible pending or expired running job where attempt_count < max_attempts.
  --    Atomically increments attempt_count once, setting status = 'running'.
  --    If no eligible job exists, returns 0 rows.
  RETURN QUERY
  WITH candidate AS (
    SELECT j.id
    FROM public.jobs AS j
    WHERE
      (
        (
          j.status = 'pending'
          AND j.attempt_count < j.max_attempts
        )
        OR (
          j.status = 'running'
          AND j.lease_expires_at IS NOT NULL
          AND j.lease_expires_at <= pg_catalog.now()
          AND j.attempt_count < j.max_attempts
        )
      )
      AND j.available_at <= pg_catalog.now()
    ORDER BY j.available_at ASC, j.id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.jobs AS j
  SET
    status = 'running',
    attempt_count = j.attempt_count + 1,
    locked_at = pg_catalog.now(),
    locked_by = p_worker_id,
    lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
    started_at = COALESCE(j.started_at, pg_catalog.now()),
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
END;
$$;

-- 3. Transfer ownership of the updated function to fluxora_queue.
ALTER FUNCTION public.fluxora_claim_next_job(text, integer)
  OWNER TO fluxora_queue;

-- 4. Configure execution ACLs while holding owner role authority.
REVOKE ALL
  ON FUNCTION public.fluxora_claim_next_job(text, integer)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.fluxora_claim_next_job(text, integer)
  TO CURRENT_USER;

-- Support dedicated worker or test roles if present in runtime environment.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_rls_test') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_claim_next_job(text, integer) TO fluxora_rls_test;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_worker') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_claim_next_job(text, integer) TO fluxora_worker;
  END IF;
END
$$;

-- 5. Revoke temporary schema privileges and membership immediately.
REVOKE CREATE ON SCHEMA public FROM fluxora_queue;
REVOKE fluxora_queue FROM CURRENT_USER;

-- 6. Maintain FORCE ROW LEVEL SECURITY.
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;

-- 7. Verification block: verify function ownership, search_path, grants, and lack of privilege escalation.
DO $$
DECLARE
  v_signature text := 'public.fluxora_claim_next_job(text, integer)';
  v_owner name;
  v_role_execute boolean;
  v_public_execute boolean;
  v_inheriting_member boolean;
BEGIN
  SELECT r.rolname
  INTO v_owner
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
  WHERE p.oid = v_signature::regprocedure;

  IF v_owner IS DISTINCT FROM 'fluxora_queue' THEN
    RAISE EXCEPTION
      'function % owner is %, expected fluxora_queue',
      v_signature, v_owner;
  END IF;

  SELECT
    COALESCE((
      SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = member_role.oid)
      FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS acl
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.rolname = current_user
      WHERE p.oid = v_signature::regprocedure
    ), false),
    COALESCE((
      SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
      FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS acl
      WHERE p.oid = v_signature::regprocedure
    ), false)
  INTO v_role_execute, v_public_execute;

  IF v_public_execute THEN
    RAISE EXCEPTION 'PUBLIC retains EXECUTE on %', v_signature;
  END IF;

  IF NOT v_role_execute THEN
    RAISE EXCEPTION
      'role % has no EXECUTE grant on %',
      current_user, v_signature;
  END IF;

  -- Ensure migration/app role does not retain inheriting membership in fluxora_queue.
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE $membership$
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS m
        JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = m.member
        JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = m.roleid
        WHERE member_role.rolname = current_user
          AND granted_role.rolname = 'fluxora_queue'
          AND (m.inherit_option OR m.set_option)
      )
    $membership$
    INTO v_inheriting_member;
  ELSE
    EXECUTE $membership$
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS m
        JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = m.member
        JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = m.roleid
        WHERE member_role.rolname = current_user
          AND granted_role.rolname = 'fluxora_queue'
      )
    $membership$
    INTO v_inheriting_member;
  END IF;

  IF v_inheriting_member THEN
    RAISE EXCEPTION
      'migration role % must not inherit fluxora_queue',
      current_user;
  END IF;
END
$$;
