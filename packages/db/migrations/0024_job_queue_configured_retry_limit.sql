-- Fluxora production hardening Fix 2E: Forward-only migration for configured retry limit,
-- trigger guard, and safe queue function signatures.
-- Migration: 0024_job_queue_configured_retry_limit.sql
--
-- Background & Historical Schema Reconciliation:
--   * Migration 0022 established worker crash recovery and dead-letter cleanup.
--   * Migration 0023 (Fix 2B) established the database attempt-count invariant (CHECK (attempt_count <= max_attempts))
--     and parameter validation. During 0023, legacy rows where attempt_count > max_attempts had their
--     operational max_attempts elevated to match attempt_count so the physical CHECK invariant held
--     without decrementing attempt_count metrics.
--   * Because 0023 was already applied to production/dev environments without the configured_max_attempts column,
--     the original configured retry limits for those specific legacy rows whose max_attempts was overwritten
--     were permanently lost and cannot be recovered from the database.
--   * This forward-only migration (0024):
--       1. Creates a temporary migration-scoped RLS policy (jobs_migration_reconcile_0024) to allow
--          schema-wide reconciliation across all tenants under FORCE ROW LEVEL SECURITY without superuser
--          or BYPASSRLS privileges.
--       2. Adds the configured_max_attempts column and backfills it honestly:
--          - For legacy rows where attempt_count < max_attempts, preserve the available
--            limit as the configured value, subject to the documented migration history.
--          - For legacy rows where attempt_count >= max_attempts, represent the original
--            configured value as unknown (NULL) because migration 0023 may have elevated
--            max_attempts to attempt_count or the row reached its limit, and reliable
--            evidence does not establish the original configured limit.
--          - Does not invent or infer an original value from the normalized value alone.
--          - NULL honestly represents that the original limit cannot be established reliably.
--          - For all future jobs, new jobs must always receive a valid, non-null configured limit.
--       3. Enforces CHECK (configured_max_attempts IS NULL OR configured_max_attempts > 0).
--       4. Drops static defaults on max_attempts and configured_max_attempts so the database trigger guard
--          coordinates defaults, synchronization, and immutability.
--       5. Installs the retry-limits trigger guard (fluxora_jobs_retry_limits_guard) to prevent parameter divergence
--          and enforce immutability of configured_max_attempts on update, including preventing normal updates
--          from replacing an unknown historical value (NULL).
--       6. Drops and recreates all four queue functions with migration-safe signatures returning configured_max_attempts:
--          - fluxora_claim_next_job(text, integer)
--          - fluxora_complete_job(uuid, text)
--          - fluxora_fail_job(uuid, text, text)
--          - fluxora_retry_failed_job(uuid, text, integer, text)
--       7. Transfers function ownership to fluxora_queue, sets SECURITY DEFINER and pinned search_path,
--          revokes PUBLIC execution, and configures least-privilege execution grants.
--       8. Removes the temporary migration policy and validates all constraints, triggers, and permissions.

-- 1. Create temporary migration-scoped RLS policy for schema-wide backfill and reconciliation.
--    Scoped strictly to CURRENT_USER (the non-superuser table owner) for the transaction duration.
DROP POLICY IF EXISTS jobs_migration_reconcile_0024 ON public.jobs;
CREATE POLICY jobs_migration_reconcile_0024
  ON public.jobs
  FOR ALL
  TO CURRENT_USER
  USING (true)
  WITH CHECK (true);

-- 2. Add configured_max_attempts column if it does not already exist.
--    Column is nullable to honestly represent historical uncertainty:
--    NULL indicates legacy rows where the original configured limit cannot be established reliably.
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS configured_max_attempts integer;

COMMENT ON COLUMN public.jobs.configured_max_attempts IS
  'Original retry limit configured when the job was created. NULL indicates a legacy historical job where the original limit cannot be established reliably.';

-- Drop static column defaults so the trigger guard coordinates defaults, immutability, and synchronization.
ALTER TABLE public.jobs
  ALTER COLUMN max_attempts DROP DEFAULT;

ALTER TABLE public.jobs
  ALTER COLUMN configured_max_attempts DROP DEFAULT;

-- Enforce CHECK (configured_max_attempts IS NULL OR configured_max_attempts > 0)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.jobs'::regclass
      AND conname = 'jobs_configured_max_attempts_check'
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_configured_max_attempts_check
      CHECK (configured_max_attempts IS NULL OR configured_max_attempts > 0);
  END IF;
END
$$;

-- 3. Reconcile any existing rows where attempt_count > max_attempts before validating constraint.
UPDATE public.jobs AS j
SET
  status = CASE
    WHEN j.status = 'pending' THEN 'dead_letter'
    WHEN j.status = 'running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.now()) THEN 'dead_letter'
    WHEN j.status = 'failed' THEN 'dead_letter'
    ELSE j.status
  END,
  failed_at = CASE
    WHEN j.status = 'pending' THEN COALESCE(j.failed_at, pg_catalog.now())
    WHEN j.status = 'running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.now()) THEN COALESCE(j.failed_at, pg_catalog.now())
    WHEN j.status = 'failed' THEN COALESCE(j.failed_at, pg_catalog.now())
    ELSE j.failed_at
  END,
  locked_at = CASE
    WHEN j.status = 'pending' THEN NULL
    WHEN j.status = 'running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.now()) THEN NULL
    ELSE j.locked_at
  END,
  locked_by = CASE
    WHEN j.status = 'pending' THEN NULL
    WHEN j.status = 'running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.now()) THEN NULL
    ELSE j.locked_by
  END,
  lease_expires_at = CASE
    WHEN j.status = 'pending' THEN NULL
    WHEN j.status = 'running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.now()) THEN NULL
    ELSE j.lease_expires_at
  END,
  last_error = CASE
    WHEN j.status = 'pending' THEN COALESCE(j.last_error, 'Job exceeded retry limit while pending')
    WHEN j.status = 'running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.now()) THEN COALESCE(j.last_error, 'Job lease expired after retry limit reached')
    WHEN j.status = 'failed' THEN COALESCE(j.last_error, 'Job exceeded retry limit')
    ELSE j.last_error
  END,
  max_attempts = j.attempt_count
WHERE j.attempt_count > j.max_attempts;

-- Honest historical retry-limit backfill:
-- For legacy rows where attempt_count < max_attempts, preserve the available limit as the configured value,
-- subject to the documented migration history.
-- For legacy rows where attempt_count >= max_attempts, represent the original configured value as unknown (NULL)
-- because migration 0023 may have elevated max_attempts to attempt_count or the row reached its limit, and
-- reliable evidence does not establish the original configured limit.
UPDATE public.jobs
SET configured_max_attempts = CASE
  WHEN attempt_count < max_attempts THEN max_attempts
  ELSE NULL
END
WHERE configured_max_attempts IS NULL;

-- Ensure all existing rows now satisfy the attempt-count invariant and backfill semantics.
DO $$
DECLARE
  v_over_limit_count integer;
  v_invalid_configured_count integer;
BEGIN
  SELECT count(*)
  INTO v_over_limit_count
  FROM public.jobs
  WHERE attempt_count > max_attempts;

  IF v_over_limit_count > 0 THEN
    RAISE EXCEPTION
      'Failed to reconcile legacy jobs with attempt_count > max_attempts: % rows remain over-limit',
      v_over_limit_count;
  END IF;

  SELECT count(*)
  INTO v_invalid_configured_count
  FROM public.jobs
  WHERE (attempt_count < max_attempts AND (configured_max_attempts IS NULL OR configured_max_attempts <> max_attempts))
     OR (attempt_count >= max_attempts AND configured_max_attempts IS NOT NULL);

  IF v_invalid_configured_count > 0 THEN
    RAISE EXCEPTION
      'Failed to backfill configured_max_attempts with honest historical semantics: % invalid rows found',
      v_invalid_configured_count;
  END IF;
END
$$;

-- 4. Add or validate attempt_count <= max_attempts constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.jobs'::regclass
      AND conname = 'jobs_attempt_count_le_max_attempts'
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_attempt_count_le_max_attempts
      CHECK (attempt_count <= max_attempts)
      NOT VALID;
    ALTER TABLE public.jobs
      VALIDATE CONSTRAINT jobs_attempt_count_le_max_attempts;
  END IF;
END
$$;

-- Drop temporary migration reconciliation policy immediately after backfill verification.
DROP POLICY jobs_migration_reconcile_0024 ON public.jobs;

-- 5. Obtain temporary owner-role authority and schema privileges for function ownership.
GRANT fluxora_queue TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO fluxora_queue;

-- 6. Install retry-limits trigger guard for defaults, propagation, and immutability.
CREATE OR REPLACE FUNCTION public.fluxora_jobs_retry_limits_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- If both are omitted or NULL, apply canonical default of 3 to both
    IF NEW.max_attempts IS NULL AND NEW.configured_max_attempts IS NULL THEN
      NEW.max_attempts := 3;
      NEW.configured_max_attempts := 3;
    -- If only max_attempts is supplied, propagate to configured_max_attempts
    ELSIF NEW.max_attempts IS NOT NULL AND NEW.configured_max_attempts IS NULL THEN
      IF NEW.max_attempts > 0 THEN
        NEW.configured_max_attempts := NEW.max_attempts;
      ELSE
        NEW.configured_max_attempts := 3;
      END IF;
    -- If only configured_max_attempts is supplied, propagate to max_attempts
    ELSIF NEW.max_attempts IS NULL AND NEW.configured_max_attempts IS NOT NULL THEN
      IF NEW.configured_max_attempts > 0 THEN
        NEW.max_attempts := NEW.configured_max_attempts;
      ELSE
        NEW.max_attempts := 3;
      END IF;
    -- If both are supplied and positive, enforce that they match
    ELSE
      IF NEW.max_attempts > 0 AND NEW.configured_max_attempts > 0 AND NEW.max_attempts <> NEW.configured_max_attempts THEN
        RAISE EXCEPTION 'job max_attempts and configured_max_attempts must match on new jobs when both are provided';
      END IF;
    END IF;

    -- New jobs must always receive a valid, non-null configured limit.
    IF NEW.configured_max_attempts IS NULL THEN
      RAISE EXCEPTION 'new jobs must receive a valid, non-null configured limit';
    END IF;

    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- configured_max_attempts is immutable after migration, including
    -- preventing normal updates from replacing an unknown historical value (NULL).
    IF NEW.configured_max_attempts IS DISTINCT FROM OLD.configured_max_attempts THEN
      RAISE EXCEPTION 'configured_max_attempts is immutable and cannot be updated';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.fluxora_jobs_retry_limits_guard()
  OWNER TO fluxora_queue;

REVOKE ALL
  ON FUNCTION public.fluxora_jobs_retry_limits_guard()
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.fluxora_jobs_retry_limits_guard()
  TO CURRENT_USER;

DROP TRIGGER IF EXISTS jobs_retry_limits_guard_trigger ON public.jobs;
CREATE TRIGGER jobs_retry_limits_guard_trigger
  BEFORE INSERT OR UPDATE ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.fluxora_jobs_retry_limits_guard();

-- 7. Migration-safe queue function recreation returning configured_max_attempts.
--    Drop existing functions before creating new return-table signatures.
DROP FUNCTION IF EXISTS public.fluxora_claim_next_job(text, integer);
DROP FUNCTION IF EXISTS public.fluxora_complete_job(uuid, text);
DROP FUNCTION IF EXISTS public.fluxora_fail_job(uuid, text, text);
DROP FUNCTION IF EXISTS public.fluxora_retry_failed_job(uuid, text, integer, text);
DROP FUNCTION IF EXISTS public.fluxora_retry_failed_job(uuid, integer);

-- Function 1: fluxora_claim_next_job
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
  configured_max_attempts integer,
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
  IF p_worker_id IS NULL OR pg_catalog.length(pg_catalog.btrim(p_worker_id, E' \t\n\r')) = 0 THEN
    RAISE EXCEPTION 'p_worker_id must be a non-empty, non-whitespace string';
  END IF;

  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 THEN
    RAISE EXCEPTION 'p_lease_seconds must be a positive integer';
  END IF;

  -- Dead-letter cleanup for exhausted expired running jobs and exhausted pending jobs
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

  -- Atomic claim candidate
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
    j.configured_max_attempts,
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

-- Function 2: fluxora_complete_job
CREATE OR REPLACE FUNCTION public.fluxora_complete_job(
  p_job_id uuid,
  p_worker_id text
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
  configured_max_attempts integer,
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
  RETURN QUERY
  UPDATE public.jobs AS j
  SET
    status = 'completed',
    completed_at = pg_catalog.now(),
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL
  WHERE j.id = p_job_id
    AND j.locked_by = p_worker_id
    AND j.lease_expires_at > pg_catalog.now()
    AND j.status = 'running'
  RETURNING
    j.id,
    j.organization_id,
    j.type,
    j.payload,
    j.status,
    j.idempotency_key,
    j.attempt_count,
    j.max_attempts,
    j.configured_max_attempts,
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

-- Function 3: fluxora_fail_job
CREATE OR REPLACE FUNCTION public.fluxora_fail_job(
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
  configured_max_attempts integer,
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
  RETURN QUERY
  UPDATE public.jobs AS j
  SET
    status = CASE
      WHEN j.attempt_count >= j.max_attempts THEN 'dead_letter'
      ELSE 'failed'
    END,
    failed_at = pg_catalog.now(),
    last_error = p_error,
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL
  WHERE j.id = p_job_id
    AND j.locked_by = p_worker_id
    AND j.lease_expires_at > pg_catalog.now()
    AND j.status = 'running'
  RETURNING
    j.id,
    j.organization_id,
    j.type,
    j.payload,
    j.status,
    j.idempotency_key,
    j.attempt_count,
    j.max_attempts,
    j.configured_max_attempts,
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

-- Function 4: fluxora_retry_failed_job
CREATE OR REPLACE FUNCTION public.fluxora_retry_failed_job(
  p_job_id uuid,
  p_worker_id text,
  p_retry_delay_seconds integer DEFAULT 0,
  p_error text DEFAULT NULL
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
  configured_max_attempts integer,
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
  RETURN QUERY
  UPDATE public.jobs AS j
  SET
    status = CASE
      WHEN j.attempt_count >= j.max_attempts THEN 'dead_letter'
      ELSE 'pending'
    END,
    available_at = CASE
      WHEN j.attempt_count >= j.max_attempts THEN j.available_at
      ELSE pg_catalog.now() + pg_catalog.make_interval(secs => GREATEST(0, COALESCE(p_retry_delay_seconds, 0)))
    END,
    failed_at = CASE
      WHEN j.attempt_count >= j.max_attempts THEN pg_catalog.now()
      ELSE j.failed_at
    END,
    last_error = COALESCE(p_error, j.last_error),
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL
  WHERE j.id = p_job_id
    AND j.locked_by = p_worker_id
    AND j.lease_expires_at > pg_catalog.now()
    AND j.status = 'running'
  RETURNING
    j.id,
    j.organization_id,
    j.type,
    j.payload,
    j.status,
    j.idempotency_key,
    j.attempt_count,
    j.max_attempts,
    j.configured_max_attempts,
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

-- 8. Transfer ownership and configure least-privilege execution grants on all 4 functions.
ALTER FUNCTION public.fluxora_claim_next_job(text, integer)
  OWNER TO fluxora_queue;

REVOKE ALL
  ON FUNCTION public.fluxora_claim_next_job(text, integer)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.fluxora_claim_next_job(text, integer)
  TO CURRENT_USER;

ALTER FUNCTION public.fluxora_complete_job(uuid, text)
  OWNER TO fluxora_queue;

REVOKE ALL
  ON FUNCTION public.fluxora_complete_job(uuid, text)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.fluxora_complete_job(uuid, text)
  TO CURRENT_USER;

ALTER FUNCTION public.fluxora_fail_job(uuid, text, text)
  OWNER TO fluxora_queue;

REVOKE ALL
  ON FUNCTION public.fluxora_fail_job(uuid, text, text)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.fluxora_fail_job(uuid, text, text)
  TO CURRENT_USER;

ALTER FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text)
  OWNER TO fluxora_queue;

REVOKE ALL
  ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text)
  TO CURRENT_USER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_rls_test') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_claim_next_job(text, integer) TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION public.fluxora_complete_job(uuid, text) TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION public.fluxora_fail_job(uuid, text, text) TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text) TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION public.fluxora_jobs_retry_limits_guard() TO fluxora_rls_test;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_worker') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_claim_next_job(text, integer) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_complete_job(uuid, text) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_fail_job(uuid, text, text) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_jobs_retry_limits_guard() TO fluxora_worker;
  END IF;
END
$$;

-- 9. Revoke temporary schema privileges and membership immediately.
REVOKE CREATE ON SCHEMA public FROM fluxora_queue;
REVOKE fluxora_queue FROM CURRENT_USER;

-- 10. Maintain FORCE ROW LEVEL SECURITY.
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;

-- 11. Verification block: verify function ownership, search_path, grants, triggers, and constraints.
DO $$
DECLARE
  v_signatures text[] := ARRAY[
    'public.fluxora_claim_next_job(text, integer)',
    'public.fluxora_complete_job(uuid, text)',
    'public.fluxora_fail_job(uuid, text, text)',
    'public.fluxora_retry_failed_job(uuid, text, integer, text)',
    'public.fluxora_jobs_retry_limits_guard()'
  ];
  v_sig text;
  v_owner name;
  v_role_execute boolean;
  v_public_execute boolean;
  v_inheriting_member boolean;
  v_constraint_validated boolean;
BEGIN
  FOREACH v_sig IN ARRAY v_signatures LOOP
    SELECT r.rolname
    INTO v_owner
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
    WHERE p.oid = v_sig::regprocedure;

    IF v_owner IS DISTINCT FROM 'fluxora_queue' THEN
      RAISE EXCEPTION
        'function % owner is %, expected fluxora_queue',
        v_sig, v_owner;
    END IF;

    SELECT
      COALESCE((
        SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = member_role.oid)
        FROM pg_catalog.pg_proc AS p
        CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS acl
        JOIN pg_catalog.pg_roles AS member_role ON member_role.rolname = current_user
        WHERE p.oid = v_sig::regprocedure
      ), false)
    INTO v_role_execute;

    IF NOT v_role_execute THEN
      RAISE EXCEPTION
        'migration role % has no EXECUTE grant on function %',
        current_user, v_sig;
    END IF;

    SELECT
      COALESCE((
        SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
        FROM pg_catalog.pg_proc AS p
        CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS acl
        WHERE p.oid = v_sig::regprocedure
      ), false)
    INTO v_public_execute;

    IF v_public_execute THEN
      RAISE EXCEPTION
        'PUBLIC retains EXECUTE on function %',
        v_sig;
    END IF;
  END LOOP;

  -- Ensure migration/app role does not retain inheriting membership in fluxora_queue.
  IF pg_catalog.current_setting('server_version_num')::int >= 160000 THEN
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

  -- Verify temporary migration reconciliation policy was dropped before completion.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'jobs'
      AND policyname = 'jobs_migration_reconcile_0024'
  ) THEN
    RAISE EXCEPTION 'Temporary migration policy jobs_migration_reconcile_0024 was not removed';
  END IF;

  -- Verify constraints exist, are CHECK constraints, and are validated.
  SELECT convalidated
  INTO v_constraint_validated
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.jobs'::regclass
    AND conname = 'jobs_attempt_count_le_max_attempts'
    AND contype = 'c';

  IF v_constraint_validated IS NULL THEN
    RAISE EXCEPTION 'Constraint jobs_attempt_count_le_max_attempts does not exist on public.jobs';
  END IF;

  IF NOT v_constraint_validated THEN
    RAISE EXCEPTION 'Constraint jobs_attempt_count_le_max_attempts is not validated';
  END IF;

  SELECT convalidated
  INTO v_constraint_validated
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.jobs'::regclass
    AND conname = 'jobs_configured_max_attempts_check'
    AND contype = 'c';

  IF v_constraint_validated IS NULL THEN
    RAISE EXCEPTION 'Constraint jobs_configured_max_attempts_check does not exist on public.jobs';
  END IF;

  IF NOT v_constraint_validated THEN
    RAISE EXCEPTION 'Constraint jobs_configured_max_attempts_check is not validated';
  END IF;

  -- Verify pre-existing non-negative and positive limit constraints remain intact.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.jobs'::regclass
      AND conname = 'jobs_attempt_count_check'
  ) THEN
    RAISE EXCEPTION 'Pre-existing constraint jobs_attempt_count_check was removed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.jobs'::regclass
      AND conname = 'jobs_max_attempts_check'
  ) THEN
    RAISE EXCEPTION 'Pre-existing constraint jobs_max_attempts_check was removed';
  END IF;

  -- Verify retry limits guard trigger exists and is enabled
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.jobs'::regclass
      AND tgname = 'jobs_retry_limits_guard_trigger'
      AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'Trigger jobs_retry_limits_guard_trigger does not exist or is disabled';
  END IF;
END
$$;
