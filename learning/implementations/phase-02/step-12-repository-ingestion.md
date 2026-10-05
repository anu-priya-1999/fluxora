# Step 12 — Repository Ingestion Worker

## Objective

Handle `repository.ingest` on the existing PostgreSQL job harness: tenant-check the repository, mint a short-lived GitHub App installation token, fetch the ref, extract safely into an isolated working directory, classify failures, and leave an in-memory/filesystem result for Step 13.

## Exact files changed

### Created

- `apps/workers/src/errors.ts`
- `apps/workers/src/env.ts`
- `apps/workers/src/run.ts`
- `apps/workers/src/github/jwt.ts`
- `apps/workers/src/github/config.ts`
- `apps/workers/src/github/redact.ts`
- `apps/workers/src/github/client.ts`
- `apps/workers/src/github/client.test.ts`
- `apps/workers/src/ingest/errors.ts`
- `apps/workers/src/ingest/limits.ts`
- `apps/workers/src/ingest/workdir.ts`
- `apps/workers/src/ingest/archive.ts`
- `apps/workers/src/ingest/archive.test.ts`
- `apps/workers/src/ingest/tar-fixture.ts`
- `apps/workers/src/ingest/ingest.ts`
- `apps/workers/src/ingest/ingest.test.ts`
- `apps/workers/src/ingest/handler.ts`
- `apps/workers/src/worker.test.ts`
- `learning/notes/11. Repository Ingestion Worker.md`
- `learning/implementations/phase-02/step-12-repository-ingestion.md`
- `learning/interviews/5. Step 12 Repository Ingestion Worker Interview CheatSheet.md`

### Modified

- `packages/shared-types/src/jobs.ts` — `repository.ingest` payload, parser, idempotency key
- `packages/db/src/repositories/github-installation.ts` — `getGithubInstallationByOrganizationId`
- `packages/db/src/index.ts` — export the getter
- `apps/workers/src/worker.ts` — skip retry on non-retryable errors; optional `jobStore` test seam
- `apps/workers/src/handlers.ts` — register `repository.ingest`
- `apps/workers/src/index.ts` — exports
- `apps/workers/package.json` / `tsconfig.json` — `start`, `test`, Node types
- `docs/DESIGN.md` — Phase 2 Step 12 documentation only

## File-by-file responsibility map

| File | Responsibility |
|---|---|
| `jobs.ts` | Typed job contract shared with a future connect API |
| `github-installation.ts` | Read installation id for the tenant (no token) |
| `errors.ts` (worker) | `PermanentJobError` / `RetryableJobError` / `isRetryableJobError` |
| `worker.ts` | Lease, complete, fail; retry only if retryable |
| `github/client.ts` | JWT → installation token → repo/commit/tarball |
| `ingest/archive.ts` | Bounded tar.gz extract, traversal/symlink rejection |
| `ingest/ingest.ts` | Orchestration, status updates, tracing |
| `ingest/handler.ts` | Job handler + temp dir cleanup |
| `run.ts` | Minimum worker process |

## Recommended code-reading order

1. `packages/shared-types/src/jobs.ts`
2. `apps/workers/src/ingest/errors.ts`
3. `apps/workers/src/github/client.ts`
4. `apps/workers/src/ingest/archive.ts`
5. `apps/workers/src/ingest/ingest.ts`
6. `apps/workers/src/ingest/handler.ts`
7. `apps/workers/src/worker.ts`
8. `apps/workers/src/handlers.ts`

## Data flow

```text
claimNextJob
  → parse payload { repositoryId, ref, commitSha? }
  → getRepositoryById(job.organizationId, repositoryId)
  → getGithubInstallationByOrganizationId
  → mint installation token (App JWT, not stored)
  → GET /repositories/{githubRepoId}
  → GET /repos/{full_name}/commits/{ref}  → sha
  → GET tarball at sha (redirect to codeload without Authorization)
  → extract tar.gz into fluxora-ingest-* dir
  → connection_status = active
  → log metadata (no file contents, no token)
  → completeJob
  → finally: rm workDir
```

## Failure-state matrix

| Condition | Job | Repository `connection_status` | Retry |
|---|---|---|---|
| Tenant / unknown repository | permanent fail | unchanged | no |
| Missing installation / GitHub 401/403 (not rate limit) / repo 404 | permanent fail | `needs_reauth` | no |
| Rate limit, 5xx, network, timeout | fail then retry | unchanged | yes (existing delay) |
| Invalid ref / SHA mismatch | permanent fail | `error` | no |
| Too large (files/bytes) | permanent fail | `error` (limits recorded on error) | no |
| Path traversal / symlink / bad tar | permanent fail | `error` | no |
| Unexpected throw | fail then retry | unchanged | yes |
| Attempts exhausted | `dead_letter` | last status written | no |

## Security controls

- Tenant check before GitHub I/O
- Installation token scoped to the job, never persisted or logged
- Archive host allow-list; no auth header on redirect
- Isolated temp dir + prefix-checked delete
- Caps: `FLUXORA_INGEST_MAX_FILE_COUNT`, `FLUXORA_INGEST_MAX_TOTAL_BYTES`, `FLUXORA_INGEST_MAX_ARCHIVE_BYTES`, `FLUXORA_INGEST_TIMEOUT_MS`
- No eval/import/execution of repository files
- Redaction helper for logs

## Test strategy

Node test runner, mocked `fetch` / injected GitHub client. No live GitHub.

Covers success, ref/SHA, token use, tenant mismatch, `needs_reauth`, rate-limit retry flag, invalid ref, size limits, traversal/symlinks, temp cleanup, handler registration, worker retry vs permanent.

## Verification results

Ran:

- `pnpm typecheck` — pass
- `pnpm lint` — pass
- `pnpm test` — 66 passed, 0 failed (20 worker ingestion tests)
- `pnpm build` — pass

## Step 12 acceptance criteria

- [x] `repository.ingest` typed payload and handler
- [x] Tenant validation using job `organization_id`
- [x] Short-lived installation token from Step 10 row
- [x] Fetch + isolated extract with security limits
- [x] Failure classification including `needs_reauth`
- [x] Result shape for Step 13; temp dir cleaned up
- [x] Existing queue/idempotency only
- [x] Focused mocked tests

## Not implemented because it belongs to Step 13+

- S3 / object-storage upload
- Inserting final `RepositorySnapshot` or `Commit` rows
- `POST /api/v1/repositories/connect`
- WebSocket / `repository.indexed` progress UI
- Language/framework detection, AST, graph extraction
- New queue (Redis/Kafka) or Docker sandbox
- Truncated-analysis clone (limits fail the job; error details preserve counts for that later design)
