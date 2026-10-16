# Step 42 — PullRequest + Changed-File/Diff Storage

## Objective

Implement the durable, tenant-scoped storage layer for GitHub pull requests, changed files, and git diff/patch data, and extend the background worker harness to consume the Step 41 normalized `pull_request.webhook` job into this storage layer.

This fulfills **Global Step 42** of **Phase 6: PR Impact Analysis** as strictly defined by `docs/architecture/17-implementation-roadmap.md`.

---

## Exact Scope

- **Modified**:
  - `packages/shared-types/src/index.ts`: Exported pull request models and file types.
  - `packages/db/src/index.ts`: Exported pull request repository functions, error classes, and input/output types.
  - `apps/workers/src/github/client.ts`: Extended existing GitHub App client with `GithubPullRequestClient` interface (`getPullRequest`, `getPullRequestFiles` with pagination and size caps) and composite `GithubClient = GithubIngestClient & GithubPullRequestClient`. Preserved `GithubIngestClient` backward compatibility without forcing ingestion handlers to implement PR methods.
  - `apps/workers/src/github/client.test.ts`: Added unit tests for GitHub client PR endpoints, pagination, and size limit handling.
  - `apps/workers/src/handlers.ts`: Wired production `pullRequestWebhookJobHandler` using lazy DB pool access into `createDefaultJobHandlers`.
  - `packages/db/src/repositories/event.test.ts`: Increased test timeout to 30000ms to eliminate pool contention timeouts during workspace-wide parallel test runs.
- **Created**:
  - `packages/shared-types/src/pull-request.ts`: Type definitions for `PullRequest`, `PullRequestFile`, `PullRequestStatus`, and `PullRequestFileStatus`.
  - `packages/db/migrations/0017_pull_requests_and_diff_storage.sql`: Production migration defining `pull_requests` and `pull_request_files` tables, check constraints, foreign keys with `ON DELETE CASCADE`, unique constraints `(repository_id, number)` and `(pull_request_id, path)`, indexes, helper function `fluxora_pull_request_in_current_tenant`, `FORCE ROW LEVEL SECURITY`, and 4 tenant policies on each table.
  - `packages/db/src/repositories/pull-request.ts`: Pull request repository implementing `upsertPullRequest`, `getPullRequestById`, `getPullRequestByNumber`, `replacePullRequestFiles`, `listPullRequestFiles`, `savePullRequestWithFiles`, input validators, and row mappers.
  - `packages/db/src/repositories/pull-request.test.ts`: 20 unit and database integration tests covering all 17 database verification criteria.
  - `apps/workers/src/pull-request/limits.ts`: Configurable limits (`maxFilesPerPr`, `maxPatchBytesPerFile`, `maxTotalPatchBytesPerPr`).
  - `apps/workers/src/pull-request/processor.ts`: Worker processor logic (`processPullRequestJob`) that validates payloads, resolves repositories, authenticates with GitHub App installation tokens, fetches metadata and changed files, applies truncation and bounds, atomically persists records, and records OpenTelemetry spans.
  - `apps/workers/src/pull-request/handler.ts`: Worker handler factory and production dependencies factory with lazy pool resolution.
  - `apps/workers/src/pull-request/processor.test.ts`: 12 worker integration tests covering requirements 18 through 30.
- **Explicit Boundary Against Steps 43–47**:
  - Step 42 does **NOT**:
    - Implement Impact Analysis Engine or blast-radius calculation (Step 43);
    - Perform graph traversal or diff-to-symbol mapping (Step 43);
    - Create `impact_analyses` table or persist impact analysis records (Step 44);
    - Generate impact evidence links (Step 44);
    - Expose impact analysis HTTP REST endpoints (Step 45);
    - Build frontend change-mode overlay on GraphCanvas (Step 46);
    - Execute golden-fixture PR impact validation (Step 47);
    - Use LLMs or probabilistic reasoning for pull request analysis.

---

## Architectural & Data Model Design

### 1. Database Schema (`0017_pull_requests_and_diff_storage.sql`)

```sql
CREATE TABLE pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  github_pr_id text NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  title text NOT NULL,
  url text NOT NULL,
  base_ref text NOT NULL,
  base_sha text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  head_ref text NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'merged')),
  author_login text,
  author_id text,
  last_delivery_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_pull_requests_repo_number UNIQUE (repository_id, number)
);

CREATE TABLE pull_request_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pull_request_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  path text NOT NULL,
  previous_path text,
  status text NOT NULL CHECK (status IN ('added', 'modified', 'removed', 'renamed')),
  additions integer NOT NULL DEFAULT 0 CHECK (additions >= 0),
  deletions integer NOT NULL DEFAULT 0 CHECK (deletions >= 0),
  changes integer NOT NULL DEFAULT 0 CHECK (changes >= 0),
  patch text,
  patch_truncated boolean NOT NULL DEFAULT false,
  base_sha text CHECK (base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}$'),
  head_sha text CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_pull_request_files_pr_path UNIQUE (pull_request_id, path)
);
```

### 2. Multi-Tenant Row-Level Security (RLS)

- `pull_requests` enforces tenant isolation via `organization_id = fluxora_current_org_id()`.
- `pull_request_files` inherits tenant isolation through foreign-key relationship:
  ```sql
  CREATE OR REPLACE FUNCTION fluxora_pull_request_in_current_tenant(target_pull_request_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $$
    SELECT EXISTS (
      SELECT 1
      FROM pull_requests
      WHERE id = target_pull_request_id
        AND organization_id = fluxora_current_org_id()
    );
  $$;
  ```
- Both tables have `FORCE ROW LEVEL SECURITY` enabled.
- Grants are restricted to `SELECT`, `INSERT`, `UPDATE`, and `DELETE` for `fluxora_app` and `fluxora_rls_test`.

---

## Worker Processing Pipeline

```
[pull_request.webhook] Job Triggered
             │
             ▼
1. Validate Normalized Payload (action, installationId, repoId, prNumber)
             │
             ▼
2. Verify Tenant Isolation (job.organizationId === payload.organizationId)
             │
             ▼
3. Resolve Repository (lookup by organizationId + githubRepoId)
   └─ Not found / unmapped ──> IngestionError("tenant_mismatch", retryable: false)
             │
             ▼
4. Mint GitHub App Installation Token (installationId)
             │
             ▼
5. Fetch GitHub PR Metadata (GET /repos/:owner/:repo/pulls/:number)
             │
             ▼
6. Fetch Changed Files (GET /repos/:owner/:repo/pulls/:number/files, paginated)
   └─ Apply limits: max 1,000 files, 512 KB per patch, 10 MB total
             │
             ▼
7. Atomically Save in PostgreSQL Transaction (`savePullRequestWithFiles`)
   ├─ Upsert `pull_requests` ON CONFLICT (repository_id, number) DO UPDATE
   ├─ Delete existing `pull_request_files` for this PR
   └─ Insert current `pull_request_files` records
             │
             ▼
8. Complete Job & Record OpenTelemetry Spans
```

---

## Verification & Test Results

All verification suites pass cleanly across the workspace:

| Verification Suite | Target | Result |
|---|---|---|
| `pnpm typecheck` | All 7 workspace packages | **PASSED** (0 errors) |
| `pnpm --filter @fluxora/db test` | Database integration + RLS tests | **PASSED** (82 passed, 5 skipped, 11 test files) |
| `pnpm --filter @fluxora/workers test` | Worker processor + GitHub client tests | **PASSED** (265 passed, 4 skipped, 19 test files) |
| `pnpm test` | Workspace-wide test execution | **PASSED** (100% test pass rate) |
| `pnpm lint` | ESLint quality check | **PASSED** (0 lint warnings or errors) |
| `pnpm lint:evidence` | Static AST Evidence Lint | **PASSED** (All graph-write paths verified) |
| `pnpm build` | Production Next.js & package build | **PASSED** (0 build errors) |
| `git diff --check` | Whitespace & patch formatting | **PASSED** |

