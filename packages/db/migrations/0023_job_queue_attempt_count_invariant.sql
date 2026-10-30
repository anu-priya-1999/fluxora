-- Fluxora production hardening Fix 2A & 2B: enforce attempt-count invariant and validate claim parameters.
-- Migration: 0023_job_queue_attempt_count_invariant.sql
--
-- Background:
--   * Invariant: 0 <= attempt_count <= max_attempts.
--   * Existing constraints enforce attempt_count >= 0 and max_attempts > 0,
--     but the upper bound (attempt_count <= max_attempts) was previously not enforced
--     by a table CHECK constraint.
--   * Historical records may have attempt_count > max_attempts due to previous
--     crash recovery behavior.
--   * Legacy reconciliation policy:
--       1. Pending rows with attempt_count > max_attempts: transitioned to 'dead_letter',
--          failed_at set, locks cleared, and max_attempts aligned to attempt_count.
--       2. Expired running rows with attempt_count > max_attempts: transitioned to 'dead_letter',
--          failed_at set, locks cleared, and max_attempts aligned to attempt_count.
--       3. Active running rows (unexpired lease) with attempt_count > max_attempts:
--          active lease is preserved (status, locks, lease remain intact);
--          max_attempts aligned to attempt_count so invariant holds and post-completion
--          records do not remain over-limit.
--       4. Completed rows with attempt_count > max_attempts: terminal status preserved,
--          completed_at preserved, max_attempts aligned to attempt_count.
--       5. Failed / dead_letter rows with attempt_count > max_attempts: transitioned to
--          or preserved as 'dead_letter', max_attempts aligned to attempt_count.
--       6. In all cases, actual attempt_count metrics are NEVER decremented or corrupted.
--   * RLS-safe reconciliation (Fix 2B):
--       Table public.jobs enforces FORCE ROW LEVEL SECURITY. Ordinary tenant policies
--       rely on fluxora_current_org_id(), which evaluates to NULL in production migration
--       context where no tenant GUC is configured.
--       To enable the migration runner (the non-superuser table owner) to reconcile all rows
--       across every organization without disabling FORCE ROW LEVEL SECURITY, granting
--       BYPASSRLS, or granting superuser privileges, a temporary migration-scoped RLS policy
--       (jobs_migration_reconcile_0023) is created FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true).
--       This policy is dropped immediately following the reconciliation backfill and verification,
--       before transaction commit. If any step fails, the entire transaction rolls back together.
--   * Table CHECK constraint jobs_attempt_count_le_max_attempts is added NOT VALID
--     and validated once existing data is reconciled.
--   * public.fluxora_claim_next_job is updated to reject NULL / whitespace-only p_worker_id
--     and NULL / zero / negative p_lease_seconds inside PostgreSQL before modifying job rows.
--   * Ownership of the updated function remains fluxora_queue with SECURITY DEFINER
--     and pinned search_path.

-- 1. Create temporary migration-scoped RLS policy for schema-wide legacy reconciliation.
--    Scoped strictly to CURRENT_USER (the non-superuser table owner) for the backfill operation.
DROP POLICY IF EXISTS jobs_migration_reconcile_0023 ON public.jobs;
CREATE POLICY jobs_migration_reconcile_0023
  ON public.jobs
  FOR ALL
  TO CURRENT_USER
  USING (true)
  WITH CHECK (true);

-- 2. Legacy data reconciliation for existing rows where attempt_count > max_attempts.
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

-- Ensure all existing rows now satisfy the invariant before adding constraint.
DO $$
DECLARE
  v_over_limit_count integer;
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
END
$$;

-- Drop temporary migration reconciliation policy immediately after backfill verification.
DROP POLICY jobs_migration_reconcile_0023 ON public.jobs;

-- 3. Obtain temporary owner-role authority and schema privileges for function ownership.
GRANT fluxora_queue TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO fluxora_queue;

-- 3. Add CHECK constraint enforcing attempt_count <= max_attempts and validate it.
ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_attempt_count_le_max_attempts;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_attempt_count_le_max_attempts
  CHECK (attempt_count <= max_attempts)
  NOT VALID;

ALTER TABLE public.jobs
  VALIDATE CONSTRAINT jobs_attempt_count_le_max_attempts;

-- 4. Update fluxora_claim_next_job to validate input parameters before modifying job rows.
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
  -- Parameter validation: reject invalid parameters before modifying any job rows.
  IF p_worker_id IS NULL OR pg_catalog.length(pg_catalog.btrim(p_worker_id, E' \t\n\r')) = 0 THEN
    RAISE EXCEPTION 'p_worker_id must be a non-empty, non-whitespace string';
  END IF;

  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 THEN
    RAISE EXCEPTION 'p_lease_seconds must be a positive integer';
  END IF;

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

-- 5. Transfer ownership of the updated function to fluxora_queue.
ALTER FUNCTION public.fluxora_claim_next_job(text, integer)
  OWNER TO fluxora_queue;

-- 6. Configure execution ACLs while holding owner role authority.
REVOKE ALL
  ON FUNCTION public.fluxora_claim_next_job(text, integer)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.fluxora_claim_next_job(text, integer)
  TO CURRENT_USER;

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

-- 7. Revoke temporary schema privileges and membership immediately.
REVOKE CREATE ON SCHEMA public FROM fluxora_queue;
REVOKE fluxora_queue FROM CURRENT_USER;

-- 8. Maintain FORCE ROW LEVEL SECURITY.
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;

-- 9. Verification block: verify function ownership, search_path, grants, and constraints.
DO $$
DECLARE
  v_signature text := 'public.fluxora_claim_next_job(text, integer)';
  v_owner name;
  v_role_execute boolean;
  v_public_execute boolean;
  v_inheriting_member boolean;
  v_constraint_validated boolean;
BEGIN
  SELECT r.rolname
  INTO v_owner
  FROM pg_catalog.pg_proc AS p
  JOIN pg_roles AS r ON r.oid = p.proowner
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
      JOIN pg_catalog.pg_roles AS member_role ON member_role.rolname = current_user
      WHERE p.oid = v_signature::regprocedure
    ), false)
  INTO v_role_execute;

  IF NOT v_role_execute THEN
    RAISE EXCEPTION
      'migration role % has no EXECUTE grant on function %',
      current_user, v_signature;
  END IF;

  SELECT
    COALESCE((
      SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
      FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS acl
      WHERE p.oid = v_signature::regprocedure
    ), false)
  INTO v_public_execute;

  IF v_public_execute THEN
    RAISE EXCEPTION
      'PUBLIC retains EXECUTE on function %',
      v_signature;
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

  -- Verify temporary migration reconciliation policy was dropped before completion.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'jobs'
      AND policyname = 'jobs_migration_reconcile_0023'
  ) THEN
    RAISE EXCEPTION 'Temporary migration policy jobs_migration_reconcile_0023 was not removed';
  END IF;

  -- Verify constraint exists, is a CHECK constraint, and is validated.
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
END
$$;
