-- Phase 2 Step 11: Repository, RepositorySnapshot, and Commit data model.
-- Metadata only. No ingestion, GitHub fetch, object-storage upload, or workers.
-- Forward-only; applied by packages/db migrate runner.

DO $$
BEGIN
  CREATE TYPE repository_connection_status AS ENUM (
    'pending',
    'active',
    'needs_reauth',
    'error'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id uuid NOT NULL
    REFERENCES organizations (id)
    ON DELETE CASCADE,

  github_repo_id bigint NOT NULL,
  name text NOT NULL,
  default_branch text NOT NULL,
  connection_status repository_connection_status NOT NULL DEFAULT 'pending',
  last_indexed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT repositories_organization_github_repo_id_unique
    UNIQUE (organization_id, github_repo_id),

  CONSTRAINT repositories_github_repo_id_positive
    CHECK (github_repo_id > 0),

  CONSTRAINT repositories_name_not_empty
    CHECK (length(trim(name)) > 0),

  CONSTRAINT repositories_default_branch_not_empty
    CHECK (length(trim(default_branch)) > 0)
);

CREATE INDEX repositories_organization_id_idx
  ON repositories (organization_id);

CREATE INDEX repositories_organization_connection_status_idx
  ON repositories (organization_id, connection_status);

CREATE INDEX repositories_organization_created_at_idx
  ON repositories (organization_id, created_at DESC);

CREATE TABLE repository_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  repository_id uuid NOT NULL
    REFERENCES repositories (id)
    ON DELETE CASCADE,

  commit_sha text NOT NULL,
  ref text NOT NULL,
  storage_uri text NOT NULL,
  file_count integer NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT repository_snapshots_repository_commit_sha_unique
    UNIQUE (repository_id, commit_sha),

  CONSTRAINT repository_snapshots_commit_sha_format
    CHECK (commit_sha ~ '^[0-9a-f]{40}$'),

  CONSTRAINT repository_snapshots_ref_not_empty
    CHECK (length(trim(ref)) > 0),

  CONSTRAINT repository_snapshots_storage_uri_not_empty
    CHECK (length(trim(storage_uri)) > 0),

  CONSTRAINT repository_snapshots_file_count_non_negative
    CHECK (file_count >= 0),

  CONSTRAINT repository_snapshots_size_bytes_non_negative
    CHECK (size_bytes >= 0)
);

CREATE INDEX repository_snapshots_repository_id_idx
  ON repository_snapshots (repository_id);

CREATE INDEX repository_snapshots_repository_created_at_idx
  ON repository_snapshots (repository_id, created_at DESC);

CREATE TABLE commits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  repository_id uuid NOT NULL
    REFERENCES repositories (id)
    ON DELETE CASCADE,

  sha text NOT NULL,
  author text NOT NULL,
  message text NOT NULL,
  committed_at timestamptz NOT NULL,
  parent_shas text[] NOT NULL DEFAULT '{}'::text[],

  CONSTRAINT commits_repository_sha_unique
    UNIQUE (repository_id, sha),

  CONSTRAINT commits_sha_format
    CHECK (sha ~ '^[0-9a-f]{40}$'),

  CONSTRAINT commits_author_not_empty
    CHECK (length(trim(author)) > 0),

  CONSTRAINT commits_parent_shas_no_nulls
    CHECK (array_position(parent_shas, NULL) IS NULL)
);

CREATE INDEX commits_repository_id_idx
  ON commits (repository_id);

CREATE INDEX commits_repository_committed_at_idx
  ON commits (repository_id, committed_at DESC);

CREATE OR REPLACE FUNCTION fluxora_repository_in_current_tenant(p_repository_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM repositories AS r
    WHERE r.id = p_repository_id
      AND r.organization_id = fluxora_current_org_id()
  );
$$;

ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories FORCE ROW LEVEL SECURITY;

ALTER TABLE repository_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_snapshots FORCE ROW LEVEL SECURITY;

ALTER TABLE commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE commits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS repositories_tenant_select ON repositories;
CREATE POLICY repositories_tenant_select ON repositories
  FOR SELECT
  USING (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS repositories_tenant_insert ON repositories;
CREATE POLICY repositories_tenant_insert ON repositories
  FOR INSERT
  WITH CHECK (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS repositories_tenant_update ON repositories;
CREATE POLICY repositories_tenant_update ON repositories
  FOR UPDATE
  USING (organization_id = fluxora_current_org_id())
  WITH CHECK (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS repositories_tenant_delete ON repositories;
CREATE POLICY repositories_tenant_delete ON repositories
  FOR DELETE
  USING (organization_id = fluxora_current_org_id());

-- Snapshots: insert-only for application writes. No UPDATE policy, so FORCE
-- RLS denies in-place overwrite. DELETE exists so repository/org cascade works.
DROP POLICY IF EXISTS repository_snapshots_tenant_select ON repository_snapshots;
CREATE POLICY repository_snapshots_tenant_select ON repository_snapshots
  FOR SELECT
  USING (fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS repository_snapshots_tenant_insert ON repository_snapshots;
CREATE POLICY repository_snapshots_tenant_insert ON repository_snapshots
  FOR INSERT
  WITH CHECK (fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS repository_snapshots_tenant_delete ON repository_snapshots;
CREATE POLICY repository_snapshots_tenant_delete ON repository_snapshots
  FOR DELETE
  USING (fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS commits_tenant_select ON commits;
CREATE POLICY commits_tenant_select ON commits
  FOR SELECT
  USING (fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS commits_tenant_insert ON commits;
CREATE POLICY commits_tenant_insert ON commits
  FOR INSERT
  WITH CHECK (fluxora_repository_in_current_tenant(repository_id));

DROP POLICY IF EXISTS commits_tenant_delete ON commits;
CREATE POLICY commits_tenant_delete ON commits
  FOR DELETE
  USING (fluxora_repository_in_current_tenant(repository_id));
