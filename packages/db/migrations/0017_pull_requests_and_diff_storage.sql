-- Phase 6 Step 42: PullRequest and changed-file/diff storage.
-- Stores pull request metadata and changed-file diff snapshots with RLS and tenant isolation.
-- Forward-only; applied by packages/db migrate runner.

-- 1. PullRequest table
CREATE TABLE IF NOT EXISTS pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id uuid NOT NULL
    REFERENCES organizations (id)
    ON DELETE CASCADE,

  repository_id uuid NOT NULL
    REFERENCES repositories (id)
    ON DELETE CASCADE,

  github_pr_id bigint NOT NULL,
  number integer NOT NULL,
  title text NOT NULL DEFAULT '',
  url text NOT NULL,
  base_ref text NOT NULL,
  base_sha text NOT NULL,
  head_ref text NOT NULL,
  head_sha text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  author_login text,
  author_id text,
  last_delivery_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pull_requests_repo_number_unique
    UNIQUE (repository_id, number),

  CONSTRAINT pull_requests_repo_github_pr_id_unique
    UNIQUE (repository_id, github_pr_id),

  CONSTRAINT pull_requests_github_pr_id_positive
    CHECK (github_pr_id > 0),

  CONSTRAINT pull_requests_number_positive
    CHECK (number > 0),

  CONSTRAINT pull_requests_base_ref_not_empty
    CHECK (length(trim(base_ref)) > 0),

  CONSTRAINT pull_requests_base_sha_format
    CHECK (base_sha ~ '^[0-9a-f]{40}$'),

  CONSTRAINT pull_requests_head_ref_not_empty
    CHECK (length(trim(head_ref)) > 0),

  CONSTRAINT pull_requests_head_sha_format
    CHECK (head_sha ~ '^[0-9a-f]{40}$'),

  CONSTRAINT pull_requests_status_valid
    CHECK (status IN ('open', 'closed', 'merged'))
);

CREATE INDEX IF NOT EXISTS pull_requests_organization_id_idx
  ON pull_requests (organization_id);

CREATE INDEX IF NOT EXISTS pull_requests_repository_id_idx
  ON pull_requests (repository_id);

CREATE INDEX IF NOT EXISTS pull_requests_repository_number_idx
  ON pull_requests (repository_id, number);

CREATE INDEX IF NOT EXISTS pull_requests_repository_updated_at_idx
  ON pull_requests (repository_id, updated_at DESC);

-- 2. PullRequestFile table (changed files and patch diff data)
CREATE TABLE IF NOT EXISTS pull_request_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  pull_request_id uuid NOT NULL
    REFERENCES pull_requests (id)
    ON DELETE CASCADE,

  path text NOT NULL,
  previous_path text,
  status text NOT NULL,
  additions integer NOT NULL DEFAULT 0,
  deletions integer NOT NULL DEFAULT 0,
  changes integer NOT NULL DEFAULT 0,
  patch text,
  patch_truncated boolean NOT NULL DEFAULT false,
  base_sha text,
  head_sha text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pull_request_files_pr_path_unique
    UNIQUE (pull_request_id, path),

  CONSTRAINT pull_request_files_path_not_empty
    CHECK (length(trim(path)) > 0),

  CONSTRAINT pull_request_files_status_valid
    CHECK (status IN ('added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged')),

  CONSTRAINT pull_request_files_additions_non_negative
    CHECK (additions >= 0),

  CONSTRAINT pull_request_files_deletions_non_negative
    CHECK (deletions >= 0),

  CONSTRAINT pull_request_files_changes_non_negative
    CHECK (changes >= 0)
);

CREATE INDEX IF NOT EXISTS pull_request_files_pull_request_id_idx
  ON pull_request_files (pull_request_id);

CREATE INDEX IF NOT EXISTS pull_request_files_pull_request_path_idx
  ON pull_request_files (pull_request_id, path);

-- 3. Tenant helper functions and RLS policies
CREATE OR REPLACE FUNCTION fluxora_pull_request_in_current_tenant(p_pull_request_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pull_requests AS pr
    WHERE pr.id = p_pull_request_id
      AND pr.organization_id = fluxora_current_org_id()
  );
$$;

GRANT EXECUTE ON FUNCTION fluxora_pull_request_in_current_tenant(uuid) TO PUBLIC;

ALTER TABLE pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pull_requests FORCE ROW LEVEL SECURITY;

ALTER TABLE pull_request_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE pull_request_files FORCE ROW LEVEL SECURITY;

-- PullRequest policies
DROP POLICY IF EXISTS pull_requests_tenant_select ON pull_requests;
CREATE POLICY pull_requests_tenant_select ON pull_requests
  FOR SELECT
  USING (organization_id = fluxora_current_org_id());

DROP POLICY IF EXISTS pull_requests_tenant_insert ON pull_requests;
CREATE POLICY pull_requests_tenant_insert ON pull_requests
  FOR INSERT
  WITH CHECK (
    organization_id = fluxora_current_org_id()
    AND fluxora_repository_in_current_tenant(repository_id)
  );

DROP POLICY IF EXISTS pull_requests_tenant_update ON pull_requests;
CREATE POLICY pull_requests_tenant_update ON pull_requests
  FOR UPDATE
  USING (organization_id = fluxora_current_org_id())
  WITH CHECK (
    organization_id = fluxora_current_org_id()
    AND fluxora_repository_in_current_tenant(repository_id)
  );

DROP POLICY IF EXISTS pull_requests_tenant_delete ON pull_requests;
CREATE POLICY pull_requests_tenant_delete ON pull_requests
  FOR DELETE
  USING (organization_id = fluxora_current_org_id());

-- PullRequestFile policies
DROP POLICY IF EXISTS pull_request_files_tenant_select ON pull_request_files;
CREATE POLICY pull_request_files_tenant_select ON pull_request_files
  FOR SELECT
  USING (fluxora_pull_request_in_current_tenant(pull_request_id));

DROP POLICY IF EXISTS pull_request_files_tenant_insert ON pull_request_files;
CREATE POLICY pull_request_files_tenant_insert ON pull_request_files
  FOR INSERT
  WITH CHECK (fluxora_pull_request_in_current_tenant(pull_request_id));

DROP POLICY IF EXISTS pull_request_files_tenant_update ON pull_request_files;
CREATE POLICY pull_request_files_tenant_update ON pull_request_files
  FOR UPDATE
  USING (fluxora_pull_request_in_current_tenant(pull_request_id))
  WITH CHECK (fluxora_pull_request_in_current_tenant(pull_request_id));

DROP POLICY IF EXISTS pull_request_files_tenant_delete ON pull_request_files;
CREATE POLICY pull_request_files_tenant_delete ON pull_request_files
  FOR DELETE
  USING (fluxora_pull_request_in_current_tenant(pull_request_id));

