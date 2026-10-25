-- Fluxora production hardening: job queue least-privilege RLS and worker access.
-- Migration: 0020_job_queue_least_privilege_rls.sql
--
-- Background:
--   * The jobs table uses FORCE ROW LEVEL SECURITY.
--   * Existing tenant policies on jobs rely on fluxora_current_org_id().
--   * Queue dispatch is global across organizations: workers call
--     fluxora_claim_next_job without establishing a tenant context.
--   * The queue functions are SECURITY DEFINER, but in PostgreSQL SECURITY DEFINER
--     alone does not bypass RLS when the function owner is a non-superuser
--     subject to FORCE ROW LEVEL SECURITY.
--
-- Design:
--   * Maintain FORCE ROW LEVEL SECURITY on jobs.
--   * Create a dedicated NOLOGIN function-owner role: fluxora_queue.
--   * Keep fluxora_queue NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT,
--     NOREPLICATION, and NOBYPASSRLS.
--   * Grant fluxora_queue only the minimum required privileges:
--     USAGE on schema public and SELECT, UPDATE on public.jobs.
--   * Add role-specific RLS policies on public.jobs scoped TO fluxora_queue
--     allowing SELECT and UPDATE across organizations for queue processing.
--   * Preserve existing tenant RLS policies for application and tenant queries.
--   * Re-create queue functions with pinned search_path (pg_catalog, public, pg_temp),
--     fully schema-qualified database object references, and transfer ownership
--     to fluxora_queue.
--   * Revoke PUBLIC execute on all queue functions and grant EXECUTE to the
--     migration/application database role (CURRENT_USER).

DO $$
DECLARE
  v_can_login boolean;
  v_is_superuser boolean;
  v_can_create_role boolean;
  v_can_create_db boolean;
  v_bypasses_rls boolean;
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'fluxora_queue'
  )
  INTO v_exists;

  IF NOT v_exists THEN
    CREATE ROLE fluxora_queue
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  ELSE
    SELECT
      r.rolcanlogin,
      r.rolsuper,
      r.rolcreaterole,
      r.rolcreatedb,
      r.rolbypassrls
    INTO
      v_can_login,
      v_is_superuser,
      v_can_create_role,
      v_can_create_db,
      v_bypasses_rls
    FROM pg_catalog.pg_roles AS r
    WHERE r.rolname = 'fluxora_queue';

    IF v_can_login
       OR v_is_superuser
       OR v_can_create_role
       OR v_can_create_db
       OR v_bypasses_rls THEN
      RAISE EXCEPTION
        'Existing fluxora_queue role has unsafe attributes; expected NOLOGIN and no elevated privileges';
    END IF;
  END IF;
END
$$;

-- Temporarily grant role membership to CURRENT_USER so function ownership
-- can be transferred to fluxora_queue.
GRANT fluxora_queue TO CURRENT_USER;

-- Schema and table permissions for the queue role.
GRANT USAGE ON SCHEMA public TO fluxora_queue;

GRANT SELECT, UPDATE
  ON TABLE public.jobs
  TO fluxora_queue;

-- Queue-specific RLS policies scoped strictly to fluxora_queue.
-- Permissive policies are combined with OR in PostgreSQL.
-- For fluxora_queue: (tenant_policy OR queue_policy) evaluates to true.
-- For ordinary application/tenant roles: queue_policy does not apply.
DROP POLICY IF EXISTS jobs_queue_select ON public.jobs;
CREATE POLICY jobs_queue_select
  ON public.jobs
  FOR SELECT
  TO fluxora_queue
  USING (true);

DROP POLICY IF EXISTS jobs_queue_update ON public.jobs;
CREATE POLICY jobs_queue_update
  ON public.jobs
  FOR UPDATE
  TO fluxora_queue
  USING (true)
  WITH CHECK (true);

-- Re-create queue functions with pinned search_path and schema-qualified references.

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
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH candidate AS (
    SELECT j.id
    FROM public.jobs AS j
    WHERE
      (
        j.status = 'pending'
        OR (
          j.status = 'running'
          AND j.lease_expires_at IS NOT NULL
          AND j.lease_expires_at <= pg_catalog.now()
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
$$;

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
    status = 'completed',
    completed_at = pg_catalog.now(),
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL,
    last_error = NULL
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
      WHEN j.attempt_count >= j.max_attempts
        THEN 'dead_letter'
      ELSE 'failed'
    END,
    last_error = p_error,
    failed_at = pg_catalog.now(),
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

CREATE OR REPLACE FUNCTION public.fluxora_retry_failed_job(
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
SET search_path = pg_catalog, public, pg_temp
AS $$
  UPDATE public.jobs AS j
  SET
    status = 'pending',
    available_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_delay_seconds),
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

-- PostgreSQL requires the new function owner to have CREATE on the schema
-- during ownership transfer. Grant it temporarily and revoke immediately after.
GRANT CREATE ON SCHEMA public TO fluxora_queue;

ALTER FUNCTION public.fluxora_claim_next_job(text, integer)
  OWNER TO fluxora_queue;

ALTER FUNCTION public.fluxora_complete_job(uuid, text)
  OWNER TO fluxora_queue;

ALTER FUNCTION public.fluxora_fail_job(uuid, text, text)
  OWNER TO fluxora_queue;

ALTER FUNCTION public.fluxora_retry_failed_job(uuid, integer)
  OWNER TO fluxora_queue;

REVOKE CREATE ON SCHEMA public FROM fluxora_queue;

-- Revoke all permissions from PUBLIC.
REVOKE ALL
  ON FUNCTION public.fluxora_claim_next_job(text, integer)
  FROM PUBLIC;

REVOKE ALL
  ON FUNCTION public.fluxora_complete_job(uuid, text)
  FROM PUBLIC;

REVOKE ALL
  ON FUNCTION public.fluxora_fail_job(uuid, text, text)
  FROM PUBLIC;

REVOKE ALL
  ON FUNCTION public.fluxora_retry_failed_job(uuid, integer)
  FROM PUBLIC;

-- Grant EXECUTE to CURRENT_USER (application/worker role) after ownership
-- transfer to ensure ACL entry is stored correctly and not rewritten by aclnewowner.
GRANT EXECUTE
  ON FUNCTION public.fluxora_claim_next_job(text, integer)
  TO CURRENT_USER;

GRANT EXECUTE
  ON FUNCTION public.fluxora_complete_job(uuid, text)
  TO CURRENT_USER;

GRANT EXECUTE
  ON FUNCTION public.fluxora_fail_job(uuid, text, text)
  TO CURRENT_USER;

GRANT EXECUTE
  ON FUNCTION public.fluxora_retry_failed_job(uuid, integer)
  TO CURRENT_USER;

-- If fluxora_rls_test role exists (e.g. from local test suites), grant EXECUTE to it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_rls_test') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_claim_next_job(text, integer) TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION public.fluxora_complete_job(uuid, text) TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION public.fluxora_fail_job(uuid, text, text) TO fluxora_rls_test;
    GRANT EXECUTE ON FUNCTION public.fluxora_retry_failed_job(uuid, integer) TO fluxora_rls_test;
  END IF;
END
$$;

-- Revoke temporary membership from CURRENT_USER.
REVOKE fluxora_queue FROM CURRENT_USER;

-- Ensure FORCE ROW LEVEL SECURITY remains enabled on jobs.
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;

-- Static validation block: verify ownership, grants, and lack of privilege escalation.
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
    'public.fluxora_retry_failed_job(uuid, integer)'
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
