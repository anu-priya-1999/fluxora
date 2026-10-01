-- Phase 2 Step 10: tenant-scoped GitHub App installations.
-- Stores the installation id only. Installation access tokens are minted later
-- and are never written by this migration.
-- Forward-only; applied by packages/db migrate runner.

CREATE TABLE github_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id uuid NOT NULL
    REFERENCES organizations (id)
    ON DELETE CASCADE,

  github_installation_id bigint NOT NULL,
  github_account_id bigint NOT NULL,
  github_account_login text NOT NULL,
  github_account_type text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT github_installations_installation_id_unique
    UNIQUE (github_installation_id),

  CONSTRAINT github_installations_organization_unique
    UNIQUE (organization_id),

  CONSTRAINT github_installations_installation_id_positive
    CHECK (github_installation_id > 0),

  CONSTRAINT github_installations_account_id_positive
    CHECK (github_account_id > 0),

  CONSTRAINT github_installations_login_not_empty
    CHECK (length(trim(github_account_login)) > 0),

  CONSTRAINT github_installations_account_type_user
    CHECK (github_account_type = 'User')
);

ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS github_installations_tenant_select ON github_installations;
CREATE POLICY github_installations_tenant_select ON github_installations
  FOR SELECT
  USING (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS github_installations_tenant_insert ON github_installations;
CREATE POLICY github_installations_tenant_insert ON github_installations
  FOR INSERT
  WITH CHECK (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS github_installations_tenant_update ON github_installations;
CREATE POLICY github_installations_tenant_update ON github_installations
  FOR UPDATE
  USING (organization_id = fluxora_current_org_id())
  WITH CHECK (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS github_installations_tenant_delete ON github_installations;
CREATE POLICY github_installations_tenant_delete ON github_installations
  FOR DELETE
  USING (organization_id = fluxora_current_org_id());
