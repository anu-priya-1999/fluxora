-- Phase 1 Step 2: tenancy foundation (Organization, User, RLS).
-- Forward-only; applied by packages/db migrate runner.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE user_role AS ENUM ('owner', 'admin', 'member', 'viewer');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE plan_tier AS ENUM ('free', 'pro', 'enterprise');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  github_org_id bigint UNIQUE,
  plan_tier plan_tier NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email text NOT NULL,
  github_user_id bigint UNIQUE,
  role user_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_organization_email_unique UNIQUE (organization_id, email)
);

CREATE INDEX users_organization_id_idx ON users (organization_id);

CREATE OR REPLACE FUNCTION fluxora_current_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid;
$$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organizations_tenant_select ON organizations;
CREATE POLICY organizations_tenant_select ON organizations
  FOR SELECT
  USING (id = fluxora_current_org_id());

DROP POLICY IF EXISTS users_tenant_select ON users;
CREATE POLICY users_tenant_select ON users
  FOR SELECT
  USING (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS users_tenant_insert ON users;
CREATE POLICY users_tenant_insert ON users
  FOR INSERT
  WITH CHECK (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS users_tenant_update ON users;
CREATE POLICY users_tenant_update ON users
  FOR UPDATE
  USING (organization_id = fluxora_current_org_id())
  WITH CHECK (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS users_tenant_delete ON users;
CREATE POLICY users_tenant_delete ON users
  FOR DELETE
  USING (organization_id = fluxora_current_org_id());

-- Bootstrap writes bypass RLS via SECURITY DEFINER (explicit validation inside).
CREATE OR REPLACE FUNCTION fluxora_create_organization(
  p_name text,
  p_plan_tier plan_tier DEFAULT 'free',
  p_github_org_id bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'organization name must not be empty';
  END IF;

  INSERT INTO organizations (name, plan_tier, github_org_id)
  VALUES (trim(p_name), p_plan_tier, p_github_org_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION fluxora_create_user(
  p_organization_id uuid,
  p_email text,
  p_role user_role,
  p_github_user_id bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF length(trim(p_email)) = 0 THEN
    RAISE EXCEPTION 'email must not be empty';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_organization_id) THEN
    RAISE EXCEPTION 'organization % does not exist', p_organization_id;
  END IF;

  INSERT INTO users (organization_id, email, role, github_user_id)
  VALUES (p_organization_id, lower(trim(p_email)), p_role, p_github_user_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION fluxora_create_organization(text, plan_tier, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION fluxora_create_user(uuid, text, user_role, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_create_organization(text, plan_tier, bigint) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_create_user(uuid, text, user_role, bigint) TO PUBLIC;
