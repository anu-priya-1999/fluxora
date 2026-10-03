-- Restore EXECUTE on the bootstrap functions for the migration role.
-- Migration: 0010_grant_bootstrap_function_execute.sql
--
-- 0009 revoked PUBLIC execute, granted EXECUTE to CURRENT_USER, then
-- transferred ownership to fluxora_bootstrap. PostgreSQL rewrites function
-- ACL entries that name the old owner so they name the new owner
-- (aclnewowner). That grant therefore ended on fluxora_bootstrap.
-- fluxora_bootstrap is NOLOGIN. The API connects as the same role that runs
-- migrations, which is no longer the owner and has no remaining EXECUTE
-- entry, so calls fail with:
--   permission denied for function fluxora_provision_github_user
--
-- This migration grants EXECUTE only after fluxora_bootstrap already owns
-- the functions. The grantee is the migration role, not the owner, so the
-- ACL entry is stored and is not rewritten. Membership in fluxora_bootstrap
-- is required to grant on a function this role does not own. Membership is
-- revoked in this same migration. The migration runner applies the file in
-- one transaction, so a failed check rolls the membership back.
--
-- Assumptions, same as 0009:
--   * the migration role can grant role membership (CREATEROLE on Render)
--   * the migration role is the application role
--   * fluxora_bootstrap already owns these three functions

GRANT fluxora_bootstrap TO CURRENT_USER;

REVOKE ALL
  ON FUNCTION public.fluxora_create_organization(text, public.plan_tier, bigint)
  FROM PUBLIC;

REVOKE ALL
  ON FUNCTION public.fluxora_create_user(uuid, text, public.user_role, bigint)
  FROM PUBLIC;

REVOKE ALL
  ON FUNCTION public.fluxora_provision_github_user(bigint, text, text)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.fluxora_create_organization(text, public.plan_tier, bigint)
  TO CURRENT_USER;

GRANT EXECUTE
  ON FUNCTION public.fluxora_create_user(uuid, text, public.user_role, bigint)
  TO CURRENT_USER;

GRANT EXECUTE
  ON FUNCTION public.fluxora_provision_github_user(bigint, text, text)
  TO CURRENT_USER;

REVOKE fluxora_bootstrap FROM CURRENT_USER;

-- Fail the migration if the grant did not stick while the owner remains
-- fluxora_bootstrap. Superuser status must not hide a missing ACL entry.
DO $$
DECLARE
  v_signature text;
  v_owner name;
  v_role_execute boolean;
  v_public_execute boolean;
  v_inheriting_member boolean;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.fluxora_create_organization(text, public.plan_tier, bigint)',
    'public.fluxora_create_user(uuid, text, public.user_role, bigint)',
    'public.fluxora_provision_github_user(bigint, text, text)'
  ]
  LOOP
    SELECT r.rolname
    INTO v_owner
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
    WHERE p.oid = v_signature::regprocedure;

    IF v_owner IS DISTINCT FROM 'fluxora_bootstrap' THEN
      RAISE EXCEPTION
        'function % owner is %, expected fluxora_bootstrap',
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

  -- PostgreSQL 16+ records a non-inheriting ADMIN membership, granted by
  -- the bootstrap superuser, when a CREATEROLE user creates a role. That
  -- row cannot be revoked by the migration role and does not confer
  -- EXECUTE or RLS access. An inheriting or SET membership would.
  -- PostgreSQL 15 and earlier have no inherit_option column; any remaining
  -- membership inherits privileges and must be gone.
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE $membership$
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS m
        JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = m.member
        JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = m.roleid
        WHERE member_role.rolname = current_user
          AND granted_role.rolname = 'fluxora_bootstrap'
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
          AND granted_role.rolname = 'fluxora_bootstrap'
      )
    $membership$
    INTO v_inheriting_member;
  END IF;

  IF v_inheriting_member THEN
    RAISE EXCEPTION
      'migration role % must not inherit fluxora_bootstrap',
      current_user;
  END IF;
END
$$;
