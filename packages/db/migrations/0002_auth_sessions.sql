-- Phase 1 Step 3: GitHub OAuth login state and revocable refresh sessions.
-- These rows are authentication records, not tenant business data.
-- Login runs before a tenant is known, so access is only through SECURITY DEFINER
-- functions. RLS is forced and no policies are granted: a role subject to RLS
-- cannot read token hashes or PKCE verifiers by setting app.current_org_id.

CREATE TABLE oauth_login_states (
  state_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_login_states_hash_hex CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oauth_login_states_verifier_length CHECK (
    char_length(code_verifier) BETWEEN 43 AND 128
  )
);

CREATE TABLE refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_sessions_hash_hex CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX refresh_sessions_family_id_idx ON refresh_sessions (family_id);
CREATE INDEX refresh_sessions_user_id_idx ON refresh_sessions (user_id);

ALTER TABLE oauth_login_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_login_states FORCE ROW LEVEL SECURITY;

ALTER TABLE refresh_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_sessions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE oauth_login_states FROM PUBLIC;
REVOKE ALL ON TABLE refresh_sessions FROM PUBLIC;

CREATE OR REPLACE FUNCTION fluxora_store_oauth_login_state(
  p_state_hash text,
  p_code_verifier text,
  p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_state_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'oauth state hash is invalid';
  END IF;

  IF p_expires_at <= now() THEN
    RAISE EXCEPTION 'oauth state expiry must be in the future';
  END IF;

  IF char_length(p_code_verifier) < 43 OR char_length(p_code_verifier) > 128 THEN
    RAISE EXCEPTION 'oauth code verifier length is invalid';
  END IF;

  DELETE FROM oauth_login_states
  WHERE expires_at <= now();

  INSERT INTO oauth_login_states (state_hash, code_verifier, expires_at)
  VALUES (p_state_hash, p_code_verifier, p_expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION fluxora_consume_oauth_login_state(p_state_hash text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_verifier text;
BEGIN
  DELETE FROM oauth_login_states
  WHERE expires_at <= now();

  DELETE FROM oauth_login_states
  WHERE state_hash = p_state_hash
  RETURNING code_verifier INTO v_verifier;

  RETURN v_verifier;
END;
$$;

-- First login creates a personal organization and an owner user.
-- Later logins return the existing row and do not change role.
-- Identity is github_user_id, not email.
CREATE OR REPLACE FUNCTION fluxora_provision_github_user(
  p_github_user_id bigint,
  p_email text,
  p_organization_name text
)
RETURNS TABLE (
  user_id uuid,
  user_organization_id uuid,
  user_email text,
  user_github_user_id bigint,
  user_role user_role,
  user_created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id uuid;
  v_organization_id uuid;
  v_email text;
  v_name text;
BEGIN
  IF p_github_user_id IS NULL OR p_github_user_id <= 0 THEN
    RAISE EXCEPTION 'github user id is required';
  END IF;

  v_email := lower(trim(p_email));
  v_name := trim(p_organization_name);

  IF char_length(v_email) = 0 OR char_length(v_email) > 320 OR position('@' in v_email) = 0 THEN
    RAISE EXCEPTION 'email is invalid';
  END IF;

  IF char_length(v_name) = 0 OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'organization name is invalid';
  END IF;

  SELECT u.id
  INTO v_user_id
  FROM users AS u
  WHERE u.github_user_id = p_github_user_id;

  IF v_user_id IS NOT NULL THEN
    RETURN QUERY
    SELECT
      u.id,
      u.organization_id,
      u.email,
      u.github_user_id,
      u.role,
      u.created_at
    FROM users AS u
    WHERE u.id = v_user_id;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO organizations (name, plan_tier)
    VALUES (v_name, 'free')
    RETURNING organizations.id INTO v_organization_id;

    INSERT INTO users (organization_id, email, role, github_user_id)
    VALUES (v_organization_id, v_email, 'owner', p_github_user_id)
    RETURNING users.id INTO v_user_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT u.id
      INTO v_user_id
      FROM users AS u
      WHERE u.github_user_id = p_github_user_id;

      IF v_user_id IS NULL THEN
        RAISE;
      END IF;
  END;

  RETURN QUERY
  SELECT u.id, u.organization_id, u.email, u.github_user_id, u.role, u.created_at
  FROM users AS u
  WHERE u.id = v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION fluxora_insert_refresh_session(
  p_family_id uuid,
  p_user_id uuid,
  p_organization_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'refresh token hash is invalid';
  END IF;

  IF p_expires_at <= now() THEN
    RAISE EXCEPTION 'refresh session expiry must be in the future';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM users AS u
    WHERE u.id = p_user_id
      AND u.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'user does not belong to organization';
  END IF;

  INSERT INTO refresh_sessions (
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
  RETURNING refresh_sessions.id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION fluxora_rotate_refresh_session(
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row refresh_sessions%ROWTYPE;
  v_new_id uuid;
BEGIN
  IF p_new_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'refresh token hash is invalid';
  END IF;

  IF p_new_expires_at <= now() THEN
    RAISE EXCEPTION 'refresh session expiry must be in the future';
  END IF;

  SELECT *
  INTO v_row
  FROM refresh_sessions
  WHERE token_hash = p_presented_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    result_status := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.revoked_at IS NOT NULL OR v_row.replaced_by IS NOT NULL THEN
    -- A refresh that just rotated can be presented twice by overlapping clients.
    -- Treat that short window as an invalid token, not theft.
    IF v_row.replaced_by IS NOT NULL
      AND v_row.revoked_at IS NOT NULL
      AND v_row.revoked_at > now() - interval '10 seconds' THEN
      result_status := 'invalid';
      RETURN NEXT;
      RETURN;
    END IF;

    -- Presenting a replaced token after the grace window revokes the family.
    IF v_row.replaced_by IS NOT NULL THEN
      UPDATE refresh_sessions
      SET revoked_at = COALESCE(revoked_at, now())
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

  IF v_row.expires_at <= now() OR NOT EXISTS (
    SELECT 1
    FROM users AS u
    WHERE u.id = v_row.user_id
      AND u.organization_id = v_row.organization_id
  ) THEN
    UPDATE refresh_sessions
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = v_row.id;

    result_status := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO refresh_sessions (
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
  RETURNING refresh_sessions.id INTO v_new_id;

  UPDATE refresh_sessions
  SET revoked_at = now(),
      replaced_by = v_new_id
  WHERE id = v_row.id;

  result_status := 'rotated';
  result_user_id := v_row.user_id;
  result_organization_id := v_row.organization_id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION fluxora_revoke_refresh_family(p_token_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_family_id uuid;
BEGIN
  SELECT family_id
  INTO v_family_id
  FROM refresh_sessions
  WHERE token_hash = p_token_hash;

  IF v_family_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE refresh_sessions
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE family_id = v_family_id
    AND revoked_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION fluxora_revoke_user_refresh_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE refresh_sessions
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE user_id = p_user_id
    AND revoked_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION fluxora_store_oauth_login_state(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION fluxora_consume_oauth_login_state(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fluxora_provision_github_user(bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fluxora_insert_refresh_session(uuid, uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION fluxora_rotate_refresh_session(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION fluxora_revoke_refresh_family(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fluxora_revoke_user_refresh_sessions(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION fluxora_store_oauth_login_state(text, text, timestamptz) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_consume_oauth_login_state(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_provision_github_user(bigint, text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_insert_refresh_session(uuid, uuid, uuid, text, timestamptz) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_rotate_refresh_session(text, text, timestamptz) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_revoke_refresh_family(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fluxora_revoke_user_refresh_sessions(uuid) TO PUBLIC;
