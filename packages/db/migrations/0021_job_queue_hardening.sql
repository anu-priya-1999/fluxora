-- Fluxora production hardening Fix 1B: job queue role hardening & retry authorization.
-- Migration: 0021_job_queue_hardening.sql
--
-- Background:
--   * Migration 0020 established fluxora_queue with initial privileges and functions.
--   * Production review required:
--     1. Strict validation of all role attributes for fluxora_queue.
--     2. Least-privilege table grant narrowing (column-specific UPDATE).
--     3. Atomic retry authorization requiring worker identity and unexpired lease.
--     4. Removal of unauthenticated 2-parameter retry function signature.
--     5. Strict validation of function ownership and execute ACL entries.

-- 1. Validate all promised attributes on fluxora_queue.
DO $$
DECLARE
  v_can_login boolean;
  v_is_superuser boolean;
  v_can_create_role boolean;
  v_can_create_db boolean;
  v_bypasses_rls boolean;
  v_inherit boolean;
  v_replication boolean;
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'fluxora_queue'
  )
  INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'Role fluxora_queue must exist before applying migration 0021';
  END IF;

  SELECT
    r.rolcanlogin,
    r.rolsuper,
    r.rolcreaterole,
    r.rolcreatedb,
    r.rolbypassrls,
    r.rolinherit,
    r.rolreplication
  INTO
    v_can_login,
    v_is_superuser,
    v_can_create_role,
    v_can_create_db,
    v_bypasses_rls,
    v_inherit,
    v_replication
  FROM pg_catalog.pg_roles AS r
  WHERE r.rolname = 'fluxora_queue';

  IF v_can_login
     OR v_is_superuser
     OR v_can_create_role
     OR v_can_create_db
     OR v_bypasses_rls
     OR v_inherit
     OR v_replication THEN
    RAISE EXCEPTION
      'Existing fluxora_queue role has unsafe attributes; expected NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOBYPASSRLS, NOINHERIT, NOREPLICATION';
  END IF;
END
$$;

-- 2. Narrow table privileges on public.jobs to column-specific UPDATE.
REVOKE ALL ON TABLE public.jobs FROM fluxora_queue;

GRANT SELECT ON TABLE public.jobs TO fluxora_queue;

GRANT UPDATE (
  status,
  attempt_count,
  locked_at,
  locked_by,
  lease_expires_at,
  started_at,
  completed_at,
  failed_at,
  last_error,
  available_at
) ON TABLE public.jobs TO fluxora_queue;

-- 3. Obtain temporary owner-role authority and schema privileges.
-- The old function public.fluxora_retry_failed_job(uuid, integer) is owned by
-- fluxora_queue. A non-superuser migration role must hold membership in
-- fluxora_queue before it can drop or replace that function.
GRANT fluxora_queue TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO fluxora_queue;

-- 4. Remove the unauthenticated 2-parameter retry function signature.
DROP FUNCTION IF EXISTS public.fluxora_retry_failed_job(uuid, integer);

-- 5. Re-create fluxora_retry_failed_job requiring worker identity and active lease.
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
SET search_path = pg_catalog, public, pg_temp
AS $$
  UPDATE public.jobs AS j
  SET
    status = CASE
      WHEN j.attempt_count >= j.max_attempts THEN 'dead_letter'
      ELSE 'pending'
    END,
    available_at = CASE
      WHEN j.attempt_count < j.max_attempts
        THEN pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_delay_seconds)
      ELSE j.available_at
    END,
    last_error = COALESCE(p_error, j.last_error),
    failed_at = CASE
      WHEN j.attempt_count >= j.max_attempts THEN pg_catalog.now()
      ELSE NULL
    END,
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL
  WHERE
    j.id = p_job_id
    AND j.status = 'running'
    AND j.locked_by = p_worker_id
    AND j.lease_expires_at IS NOT NULL
    AND j.lease_expires_at > pg_catalog.now()
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

-- Transfer ownership of the new function to fluxora_queue.
ALTER FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text)
  OWNER TO fluxora_queue;

-- Configure execution ACLs while holding owner role authority.
REVOKE ALL
  ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text)
  TO CURRENT_USER;

-- Support dedicated worker or test roles if present in runtime environment.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_rls_test') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text) TO fluxora_rls_test;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_worker') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_claim_next_job(text, integer) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_complete_job(uuid, text) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_fail_job(uuid, text, text) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text) TO fluxora_worker;
  END IF;
END
$$;

-- Revoke temporary schema privileges and membership immediately after ownership transfer and ACL configuration.
REVOKE CREATE ON SCHEMA public FROM fluxora_queue;
REVOKE fluxora_queue FROM CURRENT_USER;

-- 8. Maintain FORCE ROW LEVEL SECURITY.
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;

-- 7. Verification block.
DO $$
DECLARE
  v_signature text;
  v_owner name;
  v_role_execute boolean;
  v_public_execute boolean;
  v_inheriting_member boolean;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.fluxora_claim_next_job(text, integer)',
    'public.fluxora_complete_job(uuid, text)',
    'public.fluxora_fail_job(uuid, text, text)',
    'public.fluxora_retry_failed_job(uuid, text, integer, text)'
  ]
  LOOP
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
  END LOOP;

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
