-- Fluxora production-safe bootstrap provisioning under forced RLS.
-- Migration: 0009_secure_bootstrap_rls.sql
--
-- Assumptions verified on Render:
--   * migration role has CREATEROLE
--   * migration role does NOT have BYPASSRLS
--   * public schema grants USAGE + CREATE to the migration role
--   * organizations/users have FORCE ROW LEVEL SECURITY
--
-- Design:
--   * Keep FORCE ROW LEVEL SECURITY enabled.
--   * Create a dedicated NOLOGIN bootstrap role.
--   * Give it only the table/type/schema privileges needed by the
--     SECURITY DEFINER bootstrap functions.
--   * Add RLS policies scoped only to this NOLOGIN role.
--   * Make the bootstrap functions owned by this role.
--   * Temporarily grant CREATE on public only because PostgreSQL requires
--     the new function owner to have CREATE on its schema during ownership
--     transfer; revoke it immediately afterward.
--   * Do NOT attempt ALTER ROLE ... BYPASSRLS.
--   * Keep normal tenant RLS policies unchanged.

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
    WHERE rolname = 'fluxora_bootstrap'
  )
  INTO v_exists;

  IF NOT v_exists THEN
    CREATE ROLE fluxora_bootstrap
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
    WHERE r.rolname = 'fluxora_bootstrap';

    -- Do not try to repair an existing unsafe role. Render's managed
    -- migration role cannot change BYPASSRLS without SUPERUSER.
    IF v_can_login
       OR v_is_superuser
       OR v_can_create_role
       OR v_can_create_db
       OR v_bypasses_rls THEN
      RAISE EXCEPTION
        'Existing fluxora_bootstrap role has unsafe attributes; expected NOLOGIN and no elevated privileges';
    END IF;
  END IF;
END
$$;

-- Temporarily make the migration role a member so it can transfer function
-- ownership to fluxora_bootstrap.
GRANT fluxora_bootstrap TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO fluxora_bootstrap;

GRANT USAGE ON TYPE public.plan_tier TO fluxora_bootstrap;
GRANT USAGE ON TYPE public.user_role TO fluxora_bootstrap;

GRANT SELECT, INSERT
  ON TABLE public.organizations
  TO fluxora_bootstrap;

GRANT SELECT, INSERT
  ON TABLE public.users
  TO fluxora_bootstrap;

-- Bootstrap-only RLS policies.
-- This role is NOLOGIN and will be used only as the owner of the
-- SECURITY DEFINER bootstrap functions.

DROP POLICY IF EXISTS organizations_bootstrap_select
  ON public.organizations;

CREATE POLICY organizations_bootstrap_select
  ON public.organizations
  FOR SELECT
  TO fluxora_bootstrap
  USING (true);

DROP POLICY IF EXISTS organizations_bootstrap_insert
  ON public.organizations;

CREATE POLICY organizations_bootstrap_insert
  ON public.organizations
  FOR INSERT
  TO fluxora_bootstrap
  WITH CHECK (true);

DROP POLICY IF EXISTS users_bootstrap_select
  ON public.users;

CREATE POLICY users_bootstrap_select
  ON public.users
  FOR SELECT
  TO fluxora_bootstrap
  USING (true);

DROP POLICY IF EXISTS users_bootstrap_insert
  ON public.users;

CREATE POLICY users_bootstrap_insert
  ON public.users
  FOR INSERT
  TO fluxora_bootstrap
  WITH CHECK (true);

-- Re-create bootstrap functions using fully qualified objects and a fixed
-- SECURITY DEFINER search_path.

CREATE OR REPLACE FUNCTION public.fluxora_create_organization(
  p_name text,
  p_plan_tier public.plan_tier DEFAULT 'free',
  p_github_org_id bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'organization name must not be empty';
  END IF;

  INSERT INTO public.organizations (name, plan_tier, github_org_id)
  VALUES (trim(p_name), p_plan_tier, p_github_org_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fluxora_create_user(
  p_organization_id uuid,
  p_email text,
  p_role public.user_role,
  p_github_user_id bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF length(trim(p_email)) = 0 THEN
    RAISE EXCEPTION 'email must not be empty';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organizations
    WHERE id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'organization % does not exist', p_organization_id;
  END IF;

  INSERT INTO public.users (
    organization_id,
    email,
    role,
    github_user_id
  )
  VALUES (
    p_organization_id,
    lower(trim(p_email)),
    p_role,
    p_github_user_id
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fluxora_provision_github_user(
  p_github_user_id bigint,
  p_email text,
  p_organization_name text
)
RETURNS TABLE (
  user_id uuid,
  organization_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_organization_id uuid;
BEGIN
  IF p_github_user_id IS NULL THEN
    RAISE EXCEPTION 'github user id must not be null';
  END IF;

  IF length(trim(p_email)) = 0 THEN
    RAISE EXCEPTION 'email must not be empty';
  END IF;

  IF length(trim(p_organization_name)) = 0 THEN
    RAISE EXCEPTION 'organization name must not be empty';
  END IF;

  -- Serialize first login for the same GitHub identity.
  PERFORM pg_catalog.pg_advisory_xact_lock(p_github_user_id);

  -- Repeat login must find an existing GitHub identity before any tenant
  -- context exists.
  SELECT u.id, u.organization_id
  INTO v_user_id, v_organization_id
  FROM public.users AS u
  WHERE u.github_user_id = p_github_user_id;

  IF v_user_id IS NOT NULL THEN
    RETURN QUERY
    SELECT v_user_id, v_organization_id;
    RETURN;
  END IF;

  INSERT INTO public.organizations (name, plan_tier)
  VALUES (trim(p_organization_name), 'free')
  RETURNING id INTO v_organization_id;

  INSERT INTO public.users (
    organization_id,
    email,
    github_user_id,
    role
  )
  VALUES (
    v_organization_id,
    lower(trim(p_email)),
    p_github_user_id,
    'owner'
  )
  RETURNING id INTO v_user_id;

  RETURN QUERY
  SELECT v_user_id, v_organization_id;
END;
$$;

-- Functions must not remain executable by PUBLIC.
REVOKE ALL
  ON FUNCTION public.fluxora_create_organization(text, public.plan_tier, bigint)
  FROM PUBLIC;

REVOKE ALL
  ON FUNCTION public.fluxora_create_user(uuid, text, public.user_role, bigint)
  FROM PUBLIC;

REVOKE ALL
  ON FUNCTION public.fluxora_provision_github_user(bigint, text, text)
  FROM PUBLIC;

-- Preserve execution for the API/migration database role.
GRANT EXECUTE
  ON FUNCTION public.fluxora_create_organization(text, public.plan_tier, bigint)
  TO CURRENT_USER;

GRANT EXECUTE
  ON FUNCTION public.fluxora_create_user(uuid, text, public.user_role, bigint)
  TO CURRENT_USER;

GRANT EXECUTE
  ON FUNCTION public.fluxora_provision_github_user(bigint, text, text)
  TO CURRENT_USER;

-- PostgreSQL requires the new function owner to have CREATE on the schema
-- during ownership transfer. Grant it only temporarily.
GRANT CREATE ON SCHEMA public TO fluxora_bootstrap;

ALTER FUNCTION public.fluxora_create_organization(text, public.plan_tier, bigint)
  OWNER TO fluxora_bootstrap;

ALTER FUNCTION public.fluxora_create_user(uuid, text, public.user_role, bigint)
  OWNER TO fluxora_bootstrap;

ALTER FUNCTION public.fluxora_provision_github_user(bigint, text, text)
  OWNER TO fluxora_bootstrap;

-- Remove CREATE again after ownership transfer.
REVOKE CREATE ON SCHEMA public FROM fluxora_bootstrap;

-- The migration/API role no longer needs membership in the bootstrap role.
REVOKE fluxora_bootstrap FROM CURRENT_USER;

-- Preserve forced RLS.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;