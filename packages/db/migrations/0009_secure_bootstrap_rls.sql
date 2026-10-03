-- Fluxora production RLS fix
-- Migration: 0009_secure_bootstrap_rls.sql
--
-- Purpose:
--   Keep FORCE ROW LEVEL SECURITY enabled while allowing the controlled
--   first-login/bootstrap functions to operate before a tenant context
--   exists.
--
-- Do NOT remove FORCE ROW LEVEL SECURITY.
-- Do NOT grant BYPASSRLS to the application role.
--
-- This migration creates a NOLOGIN/NOBYPASSRLS role whose only purpose is
-- to own the SECURITY DEFINER bootstrap functions.

DO $$
DECLARE
  v_can_create_role boolean;
  v_role_can_login boolean;
  v_role_is_superuser boolean;
  v_role_can_create_role boolean;
  v_role_bypasses_rls boolean;
  v_owner_role text;
BEGIN
  SELECT
    r.rolcreaterole
  INTO v_can_create_role
  FROM pg_catalog.pg_roles AS r
  WHERE r.rolname = current_user;

  IF NOT COALESCE(v_can_create_role, false) THEN
    RAISE EXCEPTION
      'Fluxora migration 0009 requires the database migration role (%) to have CREATEROLE',
      current_user;
  END IF;

  SELECT
    r.rolcanlogin,
    r.rolsuper,
    r.rolcreaterole,
    r.rolbypassrls
  INTO
    v_role_can_login,
    v_role_is_superuser,
    v_role_can_create_role,
    v_role_bypasses_rls
  FROM pg_catalog.pg_roles AS r
  WHERE r.rolname = 'fluxora_bootstrap';

  IF v_role_can_login IS NULL THEN
    CREATE ROLE fluxora_bootstrap
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  ELSE
    IF v_role_can_login
       OR v_role_is_superuser
       OR v_role_can_create_role
       OR v_role_bypasses_rls THEN
      RAISE EXCEPTION
        'Existing role fluxora_bootstrap has unsafe attributes; it must be NOLOGIN, NOSUPERUSER, NOCREATEROLE and NOBYPASSRLS';
    END IF;
  END IF;
END
$$;

-- The migration runner must temporarily be able to SET ROLE to the
-- bootstrap owner so function ownership can be transferred safely.
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

-- These policies apply only to the NOLOGIN bootstrap role.
-- Normal application roles continue to use tenant-scoped policies.

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

-- Re-create the bootstrap functions with a safe search_path.
-- The old migrations are intentionally not edited because they may already
-- be recorded as applied in production.

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

  -- This SELECT is intentionally allowed to search all users, but only
  -- inside this SECURITY DEFINER function owned by the NOLOGIN bootstrap
  -- role.
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

-- These functions must not remain PUBLIC-executable.
REVOKE ALL
  ON FUNCTION public.fluxora_create_organization(text, public.plan_tier, bigint)
  FROM PUBLIC;

REVOKE ALL
  ON FUNCTION public.fluxora_create_user(uuid, text, public.user_role, bigint)
  FROM PUBLIC;

REVOKE ALL
  ON FUNCTION public.fluxora_provision_github_user(bigint, text, text)
  FROM PUBLIC;

-- Preserve execution for the application/migration DB role.
GRANT EXECUTE
  ON FUNCTION public.fluxora_create_organization(text, public.plan_tier, bigint)
  TO CURRENT_USER;

GRANT EXECUTE
  ON FUNCTION public.fluxora_create_user(uuid, text, public.user_role, bigint)
  TO CURRENT_USER;

GRANT EXECUTE
  ON FUNCTION public.fluxora_provision_github_user(bigint, text, text)
  TO CURRENT_USER;

-- PostgreSQL requires the new function owner to have CREATE
-- privilege on the function's schema during ownership transfer.
-- Grant it only temporarily.
GRANT CREATE ON SCHEMA public TO fluxora_bootstrap;

-- Transfer ownership of the bootstrap functions to the NOLOGIN/NOBYPASSRLS role.
ALTER FUNCTION public.fluxora_create_organization(text, public.plan_tier, bigint)
  OWNER TO fluxora_bootstrap;

ALTER FUNCTION public.fluxora_create_user(uuid, text, public.user_role, bigint)
  OWNER TO fluxora_bootstrap;

ALTER FUNCTION public.fluxora_provision_github_user(bigint, text, text)
  OWNER TO fluxora_bootstrap;

-- The bootstrap role does not need CREATE on public after ownership transfer.
REVOKE CREATE ON SCHEMA public FROM fluxora_bootstrap;

REVOKE fluxora_bootstrap FROM CURRENT_USER;

-- Keep the owner role itself non-login, non-superuser and non-BYPASSRLS.
ALTER ROLE fluxora_bootstrap
  NOLOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS;

-- Explicitly keep the relevant tables under forced tenant RLS.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
