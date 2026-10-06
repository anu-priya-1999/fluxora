# Fluxora Step 14 — Implementation Notes

**Repository:** `anu-priya-1999/fluxora`  
**Completed commit:** `8bc047f` — `feat: add repository connect API`

## 1. Scope

Step 14 implements the repository-connect API and orchestration layer.

### Added

```text
POST /api/v1/repositories/connect
```

### Primary implementation files

```text
apps/api/src/github/repository-client.ts
apps/api/src/github/repository-client.test.ts

apps/api/src/http/repositories.ts
apps/api/src/http/repositories.test.ts
apps/api/src/http/repository-request.ts

apps/api/src/repositories/connect.ts

apps/api/src/http/server.ts
```

## 2. Runtime Flow

```text
HTTP POST
  ↓
http/server.ts
  ↓
repositories.ts
  ↓
Clerk authentication
  ↓
GitHub identity resolution
  ↓
tenant resolution
  ↓
parse repository connect request
  ↓
repositories/connect.ts
  ↓
verify stored GitHub installation
  ↓
github/repository-client.ts
  ↓
GitHub App JWT
  ↓
installation access token
  ↓
repository metadata
  ↓
ref → commit SHA
  ↓
find/create Repository
  ↓
set pending
  ↓
enqueue repository.ingest
  ↓
HTTP 202
```

## 3. HTTP Routing

`apps/api/src/http/server.ts` recognizes:

```text
/api/v1/repositories/connect
```

The endpoint participates in the existing scoped CORS/preflight logic.

`POST` is forwarded to:

```ts
handleConnectRepository(...)
```

The request-routing helpers are intentionally separate from the handler implementation.

## 4. Request Contract

The request is JSON and uses:

```json
{
  "github_installation_id": "12345678",
  "repo_full_name": "acme-corp/checkout-service",
  "branch": "main"
}
```

Validation includes:

- JSON object requirement
- installation ID must be a positive decimal string
- repository name must use `owner/name`
- branch/ref must be non-empty
- branch/ref is bounded to 255 characters
- control characters are rejected

## 5. `repository-request.ts`

This module provides the pure request boundary:

```text
REPOSITORY_CONNECT_PATH
isRepositoryConnectPath()
parseConnectBody()
RequestValidationError
```

It has no Clerk import.

This prevents a pure request-parser test from pulling in the complete HTTP handler dependency graph.

## 6. `github/repository-client.ts`

The repository client accepts injected dependencies:

```ts
{
  config,
  fetchImpl?,
  now?
}
```

Its responsibilities are:

### Installation token

```text
GitHub App JWT
   ↓
POST /app/installations/{installationId}/access_tokens
   ↓
short-lived installation token
```

### Repository lookup

```text
GET /repos/{owner}/{repo}
```

The client validates:

- GitHub repository ID
- full repository name
- default branch

### Ref resolution

```text
GET /repos/{owner}/{repo}/commits/{ref}
```

The response must contain a complete 40-character SHA.

### Failure classification

`GithubRepositoryRequestError.failure` is one of:

```text
misconfigured
not_found
github_auth
invalid_ref
rate_limited
unavailable
```

## 7. Large Integer Preservation

GitHub repository IDs are preserved as strings before persistence.

The response JSON is processed so integer values that would exceed JavaScript's safe integer range are not rounded.

Repository IDs are validated against PostgreSQL's `bigint` range.

This is particularly important because Fluxora stores the GitHub repository ID in PostgreSQL.

## 8. Repository Connection Orchestration

`apps/api/src/repositories/connect.ts` is intentionally independent of HTTP.

It accepts:

```ts
{
  organizationId,
  githubInstallationId,
  repoFullName,
  ref,
  config,
  github?,
  store?
}
```

The optional `github` and `store` dependencies allow deterministic tests.

## 9. Tenant Installation Check

Before contacting GitHub:

```text
organizationId
  ↓
getInstallation()
  ↓
stored githubInstallationId
```

Then:

```text
stored ID === requested ID
```

If not, the operation fails with:

```text
GithubInstallationMismatchError
```

## 10. Repository Persistence

The repository is looked up by:

```text
organizationId + githubRepoId
```

If absent, it is created as:

```text
connectionStatus = pending
```

A `RepositoryConflictError` triggers a re-read to handle a concurrent create race.

Existing repositories are updated to pending when their current metadata/status needs reconciliation.

## 11. Job Enqueue

The existing queue is reused.

```ts
type = REPOSITORY_INGEST_JOB_TYPE
```

which resolves to:

```text
repository.ingest
```

Payload:

```json
{
  "repositoryId": "...",
  "ref": "main",
  "commitSha": "..."
}
```

Idempotency:

```text
repository.ingest:{repositoryId}:{commitSha}
```

No new queue or queue subsystem was introduced.

## 12. Response Contract

On accepted work:

```text
HTTP 202
```

with:

```json
{
  "repository_id": "...",
  "status": "pending",
  "job_id": "...",
  "ref": "main",
  "commit_sha": "..."
}
```

## 13. Failure Mapping

The API translates internal failures into stable externally visible codes.

The mapping intentionally does not expose raw GitHub response bodies or credentials.

## 14. Step Boundary

Step 14 stops at job enqueue.

```text
Step 14
connect API
    ↓
repository.ingest job
```

The existing worker then continues:

```text
Step 12
download/extract
    ↓
Step 13
package/store snapshot
```

This preserves the asynchronous architecture.

## 15. Verification

The Step 14 implementation was pushed as:

```text
8bc047f feat: add repository connect API
```

During implementation, the API suite reached 28 test cases; the two repository-client mock failures were corrected by making repository URL mocks exact (`endsWith`) so commit URLs were not mistaken for repository metadata requests.

The final repository state should be re-verified with:

```powershell
pnpm --filter @fluxora/api test
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git status
```

The final git state should remain clean after the pushed commit.
