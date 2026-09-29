-- Phase 1 Step 3: Clerk identity -> Fluxora tenant provisioning.
-- Forward-only migration.

DROP FUNCTION IF EXISTS fluxora_provision_github_user(bigint, text, text);

CREATE OR REPLACE FUNCTION fluxora_provision_github_user(
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
SET search_path = pg_catalog, public
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

  -- Prevent two simultaneous first logins for the same identity
  -- from creating duplicate organizations.
  PERFORM pg_advisory_xact_lock(p_github_user_id);

  SELECT u.id, u.organization_id
  INTO v_user_id, v_organization_id
  FROM users AS u
  WHERE u.github_user_id = p_github_user_id;

  IF v_user_id IS NOT NULL THEN
    RETURN QUERY SELECT v_user_id, v_organization_id;
    RETURN;
  END IF;

  INSERT INTO organizations (name, plan_tier)
  VALUES (trim(p_organization_name), 'free')
  RETURNING id INTO v_organization_id;

  INSERT INTO users (
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

  RETURN QUERY SELECT v_user_id, v_organization_id;
END;
$$;

REVOKE ALL ON FUNCTION fluxora_provision_github_user(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_provision_github_user(bigint, text, text) TO PUBLIC;