-- Migration: 0025_security_definer_hardening.sql
-- Fluxora Production Hardening: Fix 3 - PostgreSQL SECURITY DEFINER Security Hardening
--
-- Goals:
--   1. Function Ownership:
--      - Eliminate superuser / migration role ownership of SECURITY DEFINER functions.
--      - Establish dedicated least-privilege NOLOGIN roles:
--        * fluxora_auth: owns auth and session management functions.
--        * fluxora_tenant_guard: owns tenant RLS helper functions.
--      - Service roles are pre-provisioned by a trusted cluster administrator.
--      - The migration executor receives only temporary, non-inheriting membership
--        (WITH SET TRUE, INHERIT FALSE, ADMIN FALSE in PG16+) to transfer function ownership.
--      - Grant only required table privileges to each service role.
--      - Establish dedicated RLS policies for service roles under FORCE ROW LEVEL SECURITY.
--   2. search_path Security:
--      - Pin search_path = pg_catalog, public, pg_temp on every sensitive SECURITY DEFINER function.
--      - Put pg_catalog first and pg_temp last to eliminate search-path shadowing attacks.
--      - Schema-qualify all table, view, type, and function references.
--      - Revoke CREATE on schema public from PUBLIC (CVE-2018-1058 defense).
--   3. EXECUTE Permissions:
--      - Revoke default and explicit PUBLIC EXECUTE privileges from all sensitive functions.
--      - Grant EXECUTE only to intended application (fluxora_app) and worker (fluxora_worker) runtime roles.
--      - Do not leave persistent EXECUTE on auth functions for the migration identity.
--      - Do not grant privileges to test roles (fluxora_rls_test) in production migrations.
--   4. SQL Execution Safety:
--      - Audit all dynamic SQL (none used).
--      - Validate all inputs (regex, bounds, null checks).
--      - Ensure tenant boundaries cannot be bypassed.

-- 1. Ensure dedicated least-privilege service roles exist with strict non-login attributes.
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
  -- fluxora_auth role
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_auth'
  ) INTO v_exists;

  IF NOT v_exists THEN
    -- In production deployment, privileged service roles must be pre-provisioned by a trusted administrator.
    -- If executed directly by a superuser, provision the role with strict least-privilege attributes.
    -- Non-superuser migration executors must NOT create service roles dynamically because PostgreSQL 16+
    -- automatically grants permanent ADMIN OPTION on created roles to non-superuser creators.
    IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
      CREATE ROLE fluxora_auth
        NOLOGIN
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOINHERIT
        NOREPLICATION
        NOBYPASSRLS;
    ELSE
      RAISE EXCEPTION 'Privileged service role "fluxora_auth" does not exist. It must be pre-provisioned by a cluster administrator with NOLOGIN.';
    END IF;
  ELSE
    SELECT
      r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
      r.rolbypassrls, r.rolinherit, r.rolreplication
    INTO
      v_can_login, v_is_superuser, v_can_create_role, v_can_create_db,
      v_bypasses_rls, v_inherit, v_replication
    FROM pg_catalog.pg_roles AS r
    WHERE r.rolname = 'fluxora_auth';

    IF v_can_login OR v_is_superuser OR v_can_create_role OR v_can_create_db
       OR v_bypasses_rls OR v_inherit OR v_replication THEN
      RAISE EXCEPTION 'Existing fluxora_auth role has unsafe attributes; expected NOLOGIN and no elevated privileges';
    END IF;
  END IF;

  -- fluxora_tenant_guard role
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_tenant_guard'
  ) INTO v_exists;

  IF NOT v_exists THEN
    IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
      CREATE ROLE fluxora_tenant_guard
        NOLOGIN
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOINHERIT
        NOREPLICATION
        NOBYPASSRLS;
    ELSE
      RAISE EXCEPTION 'Privileged service role "fluxora_tenant_guard" does not exist. It must be pre-provisioned by a cluster administrator with NOLOGIN.';
    END IF;
  ELSE
    SELECT
      r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
      r.rolbypassrls, r.rolinherit, r.rolreplication
    INTO
      v_can_login, v_is_superuser, v_can_create_role, v_can_create_db,
      v_bypasses_rls, v_inherit, v_replication
    FROM pg_catalog.pg_roles AS r
    WHERE r.rolname = 'fluxora_tenant_guard';

    IF v_can_login OR v_is_superuser OR v_can_create_role OR v_can_create_db
       OR v_bypasses_rls OR v_inherit OR v_replication THEN
      RAISE EXCEPTION 'Existing fluxora_tenant_guard role has unsafe attributes; expected NOLOGIN and no elevated privileges';
    END IF;
  END IF;
END
$$;

-- 2. Revoke CREATE on schema public from PUBLIC to prevent untrusted schema pollution.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 3. Grant schema usage and least-privilege table permissions to service roles.
GRANT USAGE ON SCHEMA public TO fluxora_auth;
GRANT SELECT, INSERT, DELETE ON TABLE public.oauth_login_states TO fluxora_auth;
GRANT SELECT, INSERT, UPDATE ON TABLE public.refresh_sessions TO fluxora_auth;
GRANT SELECT ON TABLE public.users TO fluxora_auth;

GRANT USAGE ON SCHEMA public TO fluxora_tenant_guard;
GRANT EXECUTE ON FUNCTION public.fluxora_current_org_id() TO fluxora_tenant_guard;
GRANT SELECT ON TABLE
  public.repositories,
  public.repository_snapshots,
  public.analysis_runs,
  public.pull_requests,
  public.impact_analyses,
  public.scenarios,
  public.simulations
TO fluxora_tenant_guard;

-- 4. Dedicated RLS policies for service roles under FORCE ROW LEVEL SECURITY.
DROP POLICY IF EXISTS oauth_login_states_auth_all ON public.oauth_login_states;
CREATE POLICY oauth_login_states_auth_all
  ON public.oauth_login_states
  FOR ALL
  TO fluxora_auth
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS refresh_sessions_auth_all ON public.refresh_sessions;
CREATE POLICY refresh_sessions_auth_all
  ON public.refresh_sessions
  FOR ALL
  TO fluxora_auth
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS users_auth_select ON public.users;
CREATE POLICY users_auth_select
  ON public.users
  FOR SELECT
  TO fluxora_auth
  USING (true);

DROP POLICY IF EXISTS repositories_tenant_guard_select ON public.repositories;
CREATE POLICY repositories_tenant_guard_select
  ON public.repositories
  FOR SELECT
  TO fluxora_tenant_guard
  USING (true);

DROP POLICY IF EXISTS repository_snapshots_tenant_guard_select ON public.repository_snapshots;
CREATE POLICY repository_snapshots_tenant_guard_select
  ON public.repository_snapshots
  FOR SELECT
  TO fluxora_tenant_guard
  USING (true);

DROP POLICY IF EXISTS analysis_runs_tenant_guard_select ON public.analysis_runs;
CREATE POLICY analysis_runs_tenant_guard_select
  ON public.analysis_runs
  FOR SELECT
  TO fluxora_tenant_guard
  USING (true);

DROP POLICY IF EXISTS pull_requests_tenant_guard_select ON public.pull_requests;
CREATE POLICY pull_requests_tenant_guard_select
  ON public.pull_requests
  FOR SELECT
  TO fluxora_tenant_guard
  USING (true);

DROP POLICY IF EXISTS impact_analyses_tenant_guard_select ON public.impact_analyses;
CREATE POLICY impact_analyses_tenant_guard_select
  ON public.impact_analyses
  FOR SELECT
  TO fluxora_tenant_guard
  USING (true);

DROP POLICY IF EXISTS scenarios_tenant_guard_select ON public.scenarios;
CREATE POLICY scenarios_tenant_guard_select
  ON public.scenarios
  FOR SELECT
  TO fluxora_tenant_guard
  USING (true);

DROP POLICY IF EXISTS simulations_tenant_guard_select ON public.simulations;
CREATE POLICY simulations_tenant_guard_select
  ON public.simulations
  FOR SELECT
  TO fluxora_tenant_guard
  USING (true);

-- 5. Recreate functions with pinned search_path and schema-qualified references.

-- Auth Function 1: fluxora_store_oauth_login_state
CREATE OR REPLACE FUNCTION public.fluxora_store_oauth_login_state(
  p_state_hash text,
  p_code_verifier text,
  p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'oauth state hash is invalid';
  END IF;

  IF p_expires_at IS NULL OR p_expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'oauth state expiry must be in the future';
  END IF;

  IF p_code_verifier IS NULL
     OR pg_catalog.char_length(p_code_verifier) < 43
     OR pg_catalog.char_length(p_code_verifier) > 128 THEN
    RAISE EXCEPTION 'oauth code verifier length is invalid';
  END IF;

  DELETE FROM public.oauth_login_states
  WHERE expires_at <= pg_catalog.now();

  INSERT INTO public.oauth_login_states (state_hash, code_verifier, expires_at)
  VALUES (p_state_hash, p_code_verifier, p_expires_at);
END;
$$;

-- Auth Function 2: fluxora_consume_oauth_login_state
CREATE OR REPLACE FUNCTION public.fluxora_consume_oauth_login_state(p_state_hash text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_verifier text;
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'oauth state hash is invalid';
  END IF;

  DELETE FROM public.oauth_login_states
  WHERE expires_at <= pg_catalog.now();

  DELETE FROM public.oauth_login_states
  WHERE state_hash = p_state_hash
  RETURNING code_verifier INTO v_verifier;

  RETURN v_verifier;
END;
$$;

-- Auth Function 3: fluxora_insert_refresh_session
CREATE OR REPLACE FUNCTION public.fluxora_insert_refresh_session(
  p_family_id uuid,
  p_user_id uuid,
  p_organization_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_family_id IS NULL THEN
    RAISE EXCEPTION 'family id must not be null';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id must not be null';
  END IF;

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization id must not be null';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'refresh token hash is invalid';
  END IF;

  IF p_expires_at IS NULL OR p_expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'refresh session expiry must be in the future';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.users AS u
    WHERE u.id = p_user_id
      AND u.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'user does not belong to organization';
  END IF;

  INSERT INTO public.refresh_sessions (
    family_id,
    user_id,
    organization_id,
    token_hash,
    expires_at
  )
  VALUES (
    p_family_id,
    p_user_id,
    p_organization_id,
    p_token_hash,
    p_expires_at
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Auth Function 4: fluxora_rotate_refresh_session
CREATE OR REPLACE FUNCTION public.fluxora_rotate_refresh_session(
  p_presented_token_hash text,
  p_new_token_hash text,
  p_new_expires_at timestamptz
)
RETURNS TABLE (
  result_status text,
  result_user_id uuid,
  result_organization_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_row public.refresh_sessions%ROWTYPE;
  v_new_id uuid;
BEGIN
  IF p_presented_token_hash IS NULL OR p_presented_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'presented refresh token hash is invalid';
  END IF;

  IF p_new_token_hash IS NULL OR p_new_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'refresh token hash is invalid';
  END IF;

  IF p_new_expires_at IS NULL OR p_new_expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'refresh session expiry must be in the future';
  END IF;

  SELECT *
  INTO v_row
  FROM public.refresh_sessions
  WHERE token_hash = p_presented_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    result_status := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.revoked_at IS NOT NULL OR v_row.replaced_by IS NOT NULL THEN
    IF v_row.replaced_by IS NOT NULL
      AND v_row.revoked_at IS NOT NULL
      AND v_row.revoked_at > pg_catalog.now() - interval '10 seconds' THEN
      result_status := 'invalid';
      RETURN NEXT;
      RETURN;
    END IF;

    IF v_row.replaced_by IS NOT NULL THEN
      UPDATE public.refresh_sessions
      SET revoked_at = COALESCE(revoked_at, pg_catalog.now())
      WHERE family_id = v_row.family_id
        AND revoked_at IS NULL;

      result_status := 'reused';
      result_user_id := v_row.user_id;
      result_organization_id := v_row.organization_id;
      RETURN NEXT;
      RETURN;
    END IF;

    result_status := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.expires_at <= pg_catalog.now() OR NOT EXISTS (
    SELECT 1
    FROM public.users AS u
    WHERE u.id = v_row.user_id
      AND u.organization_id = v_row.organization_id
  ) THEN
    UPDATE public.refresh_sessions
    SET revoked_at = COALESCE(revoked_at, pg_catalog.now())
    WHERE id = v_row.id;

    result_status := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.refresh_sessions (
    family_id,
    user_id,
    organization_id,
    token_hash,
    expires_at
  )
  VALUES (
    v_row.family_id,
    v_row.user_id,
    v_row.organization_id,
    p_new_token_hash,
    p_new_expires_at
  )
  RETURNING id INTO v_new_id;

  UPDATE public.refresh_sessions
  SET revoked_at = pg_catalog.now(),
      replaced_by = v_new_id
  WHERE id = v_row.id;

  result_status := 'rotated';
  result_user_id := v_row.user_id;
  result_organization_id := v_row.organization_id;
  RETURN NEXT;
END;
$$;

-- Auth Function 5: fluxora_revoke_refresh_family
CREATE OR REPLACE FUNCTION public.fluxora_revoke_refresh_family(p_token_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_family_id uuid;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  SELECT family_id
  INTO v_family_id
  FROM public.refresh_sessions
  WHERE token_hash = p_token_hash;

  IF v_family_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.refresh_sessions
  SET revoked_at = COALESCE(revoked_at, pg_catalog.now())
  WHERE family_id = v_family_id
    AND revoked_at IS NULL;
END;
$$;

-- Auth Function 6: fluxora_revoke_user_refresh_sessions
CREATE OR REPLACE FUNCTION public.fluxora_revoke_user_refresh_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.refresh_sessions
  SET revoked_at = COALESCE(revoked_at, pg_catalog.now())
  WHERE user_id = p_user_id
    AND revoked_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Tenant Helper 1: fluxora_snapshot_in_current_tenant
CREATE OR REPLACE FUNCTION public.fluxora_snapshot_in_current_tenant(p_snapshot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_snapshot_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.repository_snapshots AS rs
      JOIN public.repositories AS r ON r.id = rs.repository_id
      WHERE rs.id = p_snapshot_id
        AND r.organization_id = public.fluxora_current_org_id()
    )
  END;
$$;

-- Tenant Helper 2: fluxora_analysis_run_in_current_tenant
CREATE OR REPLACE FUNCTION public.fluxora_analysis_run_in_current_tenant(p_analysis_run_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_analysis_run_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.analysis_runs AS ar
      JOIN public.repository_snapshots AS rs ON rs.id = ar.snapshot_id
      JOIN public.repositories AS r ON r.id = rs.repository_id
      WHERE ar.id = p_analysis_run_id
        AND r.organization_id = public.fluxora_current_org_id()
    )
  END;
$$;

-- Tenant Helper 3: fluxora_pull_request_in_current_tenant
CREATE OR REPLACE FUNCTION public.fluxora_pull_request_in_current_tenant(p_pull_request_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_pull_request_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.pull_requests AS pr
      WHERE pr.id = p_pull_request_id
        AND pr.organization_id = public.fluxora_current_org_id()
    )
  END;
$$;

-- Tenant Helper 4: fluxora_impact_analysis_in_current_tenant
CREATE OR REPLACE FUNCTION public.fluxora_impact_analysis_in_current_tenant(p_impact_analysis_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_impact_analysis_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.impact_analyses AS ia
      JOIN public.pull_requests AS pr ON pr.id = ia.pull_request_id
      WHERE ia.id = p_impact_analysis_id
        AND pr.organization_id = public.fluxora_current_org_id()
    )
  END;
$$;

-- Tenant Helper 5: fluxora_scenario_in_current_tenant
CREATE OR REPLACE FUNCTION public.fluxora_scenario_in_current_tenant(p_scenario_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_scenario_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.scenarios AS s
      WHERE s.id = p_scenario_id
        AND s.organization_id = public.fluxora_current_org_id()
    )
  END;
$$;

-- Tenant Helper 6: fluxora_simulation_in_current_tenant
CREATE OR REPLACE FUNCTION public.fluxora_simulation_in_current_tenant(p_simulation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_simulation_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.simulations AS sim
      JOIN public.scenarios AS s ON s.id = sim.scenario_id
      WHERE sim.id = p_simulation_id
        AND s.organization_id = public.fluxora_current_org_id()
    )
  END;
$$;

-- 6. Configure least-privilege execution ACLs and transfer ownership to dedicated service roles.
-- Note: Temporary membership in fluxora_auth and fluxora_tenant_guard (with SET TRUE, INHERIT FALSE, ADMIN FALSE)
-- is pre-granted to the migration executor by an administrator to allow ownership transfer.
-- We revoke PUBLIC execute and grant execute to runtime roles while the migration runner owns each function,
-- and then transfer ownership to the dedicated service roles.

-- 6a. Grant temporary CREATE on schema public to allow ownership transfer
GRANT CREATE ON SCHEMA public TO fluxora_auth;
GRANT CREATE ON SCHEMA public TO fluxora_tenant_guard;

-- 6b. Revoke PUBLIC execution on all 12 sensitive functions
REVOKE ALL ON FUNCTION public.fluxora_store_oauth_login_state(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fluxora_consume_oauth_login_state(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fluxora_insert_refresh_session(uuid, uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fluxora_rotate_refresh_session(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fluxora_revoke_refresh_family(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fluxora_revoke_user_refresh_sessions(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.fluxora_snapshot_in_current_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fluxora_analysis_run_in_current_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fluxora_pull_request_in_current_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fluxora_impact_analysis_in_current_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fluxora_scenario_in_current_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fluxora_simulation_in_current_tenant(uuid) FROM PUBLIC;

-- 6c. Conditional grants to runtime roles if they exist in the cluster
DO $$
BEGIN
  -- Intended application runtime role (fluxora_app): receives all auth and tenant helper execution privileges
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_app') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_snapshot_in_current_tenant(uuid) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_analysis_run_in_current_tenant(uuid) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_pull_request_in_current_tenant(uuid) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_impact_analysis_in_current_tenant(uuid) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_scenario_in_current_tenant(uuid) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_simulation_in_current_tenant(uuid) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_store_oauth_login_state(text, text, timestamptz) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_consume_oauth_login_state(text) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_insert_refresh_session(uuid, uuid, uuid, text, timestamptz) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_rotate_refresh_session(text, text, timestamptz) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_revoke_refresh_family(text) TO fluxora_app;
    GRANT EXECUTE ON FUNCTION public.fluxora_revoke_user_refresh_sessions(uuid) TO fluxora_app;
  END IF;

  -- Intended worker runtime role (fluxora_worker): receives only tenant helper execution privileges, NO auth privileges
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_worker') THEN
    GRANT EXECUTE ON FUNCTION public.fluxora_snapshot_in_current_tenant(uuid) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_analysis_run_in_current_tenant(uuid) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_pull_request_in_current_tenant(uuid) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_impact_analysis_in_current_tenant(uuid) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_scenario_in_current_tenant(uuid) TO fluxora_worker;
    GRANT EXECUTE ON FUNCTION public.fluxora_simulation_in_current_tenant(uuid) TO fluxora_worker;
  END IF;
END
$$;

-- 6d. Transfer ownership of functions to dedicated service roles
ALTER FUNCTION public.fluxora_store_oauth_login_state(text, text, timestamptz) OWNER TO fluxora_auth;
ALTER FUNCTION public.fluxora_consume_oauth_login_state(text) OWNER TO fluxora_auth;
ALTER FUNCTION public.fluxora_insert_refresh_session(uuid, uuid, uuid, text, timestamptz) OWNER TO fluxora_auth;
ALTER FUNCTION public.fluxora_rotate_refresh_session(text, text, timestamptz) OWNER TO fluxora_auth;
ALTER FUNCTION public.fluxora_revoke_refresh_family(text) OWNER TO fluxora_auth;
ALTER FUNCTION public.fluxora_revoke_user_refresh_sessions(uuid) OWNER TO fluxora_auth;

ALTER FUNCTION public.fluxora_snapshot_in_current_tenant(uuid) OWNER TO fluxora_tenant_guard;
ALTER FUNCTION public.fluxora_analysis_run_in_current_tenant(uuid) OWNER TO fluxora_tenant_guard;
ALTER FUNCTION public.fluxora_pull_request_in_current_tenant(uuid) OWNER TO fluxora_tenant_guard;
ALTER FUNCTION public.fluxora_impact_analysis_in_current_tenant(uuid) OWNER TO fluxora_tenant_guard;
ALTER FUNCTION public.fluxora_scenario_in_current_tenant(uuid) OWNER TO fluxora_tenant_guard;
ALTER FUNCTION public.fluxora_simulation_in_current_tenant(uuid) OWNER TO fluxora_tenant_guard;

-- 6e. Revoke temporary CREATE on schema public from service roles
REVOKE CREATE ON SCHEMA public FROM fluxora_auth;
REVOKE CREATE ON SCHEMA public FROM fluxora_tenant_guard;

-- 7. Reaffirm FORCE ROW LEVEL SECURITY across all sensitive tables.
ALTER TABLE public.oauth_login_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_login_states FORCE ROW LEVEL SECURITY;

ALTER TABLE public.refresh_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refresh_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

ALTER TABLE public.repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repositories FORCE ROW LEVEL SECURITY;

ALTER TABLE public.repository_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repository_snapshots FORCE ROW LEVEL SECURITY;

ALTER TABLE public.analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_runs FORCE ROW LEVEL SECURITY;

ALTER TABLE public.pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pull_requests FORCE ROW LEVEL SECURITY;

ALTER TABLE public.impact_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.impact_analyses FORCE ROW LEVEL SECURITY;

ALTER TABLE public.scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scenarios FORCE ROW LEVEL SECURITY;

ALTER TABLE public.simulations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.simulations FORCE ROW LEVEL SECURITY;

-- 8. Comprehensive post-migration verification block.
DO $$
DECLARE
  v_auth_sigs text[] := ARRAY[
    'public.fluxora_store_oauth_login_state(text, text, timestamptz)',
    'public.fluxora_consume_oauth_login_state(text)',
    'public.fluxora_insert_refresh_session(uuid, uuid, uuid, text, timestamptz)',
    'public.fluxora_rotate_refresh_session(text, text, timestamptz)',
    'public.fluxora_revoke_refresh_family(text)',
    'public.fluxora_revoke_user_refresh_sessions(uuid)'
  ];
  v_tenant_sigs text[] := ARRAY[
    'public.fluxora_snapshot_in_current_tenant(uuid)',
    'public.fluxora_analysis_run_in_current_tenant(uuid)',
    'public.fluxora_pull_request_in_current_tenant(uuid)',
    'public.fluxora_impact_analysis_in_current_tenant(uuid)',
    'public.fluxora_scenario_in_current_tenant(uuid)',
    'public.fluxora_simulation_in_current_tenant(uuid)'
  ];
  v_sig text;
  v_owner name;
  v_secdef boolean;
  v_config text[];
  v_public_exec boolean;
  v_app_exec boolean;
  v_worker_exec boolean;
  v_has_app boolean;
  v_has_worker boolean;
  v_is_unauthorized_member boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_app') INTO v_has_app;
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_worker') INTO v_has_worker;

  -- Verify auth functions
  FOREACH v_sig IN ARRAY v_auth_sigs LOOP
    SELECT r.rolname, p.prosecdef, p.proconfig
    INTO v_owner, v_secdef, v_config
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_sig::regprocedure;

    IF v_owner IS DISTINCT FROM 'fluxora_auth' THEN
      RAISE EXCEPTION 'Function % owner is %, expected fluxora_auth', v_sig, v_owner;
    END IF;
    IF NOT v_secdef THEN
      RAISE EXCEPTION 'Function % is not SECURITY DEFINER', v_sig;
    END IF;
    IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
      RAISE EXCEPTION 'Function % search_path is %, expected pg_catalog, public, pg_temp', v_sig, v_config;
    END IF;

    SELECT
      COALESCE((
        SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
        FROM pg_catalog.aclexplode(p.proacl) acl
      ), p.proacl IS NULL),
      COALESCE((
        SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_app'))
        FROM pg_catalog.aclexplode(p.proacl) acl
      ), false),
      COALESCE((
        SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_worker'))
        FROM pg_catalog.aclexplode(p.proacl) acl
      ), false)
    INTO v_public_exec, v_app_exec, v_worker_exec
    FROM pg_catalog.pg_proc p
    WHERE p.oid = v_sig::regprocedure;

    IF v_public_exec THEN
      RAISE EXCEPTION 'PUBLIC retains EXECUTE on %', v_sig;
    END IF;
    IF v_has_app AND NOT v_app_exec THEN
      RAISE EXCEPTION 'Role fluxora_app does not have EXECUTE on %', v_sig;
    END IF;
    IF v_worker_exec THEN
      RAISE EXCEPTION 'Role fluxora_worker must not have EXECUTE on auth function %', v_sig;
    END IF;
  END LOOP;

  -- Verify tenant guard functions
  FOREACH v_sig IN ARRAY v_tenant_sigs LOOP
    SELECT r.rolname, p.prosecdef, p.proconfig
    INTO v_owner, v_secdef, v_config
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_sig::regprocedure;

    IF v_owner IS DISTINCT FROM 'fluxora_tenant_guard' THEN
      RAISE EXCEPTION 'Function % owner is %, expected fluxora_tenant_guard', v_sig, v_owner;
    END IF;
    IF NOT v_secdef THEN
      RAISE EXCEPTION 'Function % is not SECURITY DEFINER', v_sig;
    END IF;
    IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
      RAISE EXCEPTION 'Function % search_path is %, expected pg_catalog, public, pg_temp', v_sig, v_config;
    END IF;

    SELECT
      COALESCE((
        SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
        FROM pg_catalog.aclexplode(p.proacl) acl
      ), p.proacl IS NULL),
      COALESCE((
        SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_app'))
        FROM pg_catalog.aclexplode(p.proacl) acl
      ), false),
      COALESCE((
        SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_worker'))
        FROM pg_catalog.aclexplode(p.proacl) acl
      ), false)
    INTO v_public_exec, v_app_exec, v_worker_exec
    FROM pg_catalog.pg_proc p
    WHERE p.oid = v_sig::regprocedure;

    IF v_public_exec THEN
      RAISE EXCEPTION 'PUBLIC retains EXECUTE on %', v_sig;
    END IF;
    IF v_has_app AND NOT v_app_exec THEN
      RAISE EXCEPTION 'Role fluxora_app does not have EXECUTE on %', v_sig;
    END IF;
    IF v_has_worker AND NOT v_worker_exec THEN
      RAISE EXCEPTION 'Role fluxora_worker does not have EXECUTE on %', v_sig;
    END IF;
  END LOOP;

  -- Verify that CURRENT_USER holds NO unauthorized administrative (ADMIN OPTION) or inheriting membership in service roles.
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
    JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
    WHERE gr.rolname IN ('fluxora_auth', 'fluxora_tenant_guard')
      AND mr.rolname = current_user
      AND (
        CASE
          WHEN pg_catalog.current_setting('server_version_num')::int >= 160000
            THEN (m.admin_option OR m.inherit_option)
          ELSE m.admin_option
        END
      )
  ) INTO v_is_unauthorized_member;

  IF v_is_unauthorized_member THEN
    RAISE EXCEPTION 'Migration role % retains unauthorized administrative (ADMIN OPTION) or inheriting membership in service roles', current_user;
  END IF;
END $$;
