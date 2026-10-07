# Step 16 — Ingestion Failure-Path Hardening

## Objective

Implement Fluxora Global Step 16:
1. Handle permanent ingestion failures correctly:
   - GitHub 401/403 or revoked installation (`code = github_auth`, `status = needs_reauth`, no retry)
   - Inaccessible repository (`status = needs_reauth`, no retry)
   - Invalid ref (`code = invalid_ref`, `status = error`, no retry)
   - Oversized repository/archive (`code = repository_too_large`, `status = error`, no retry)
   - Unsafe archive / snapshot conflict (`code = unsafe_archive` / `snapshot_conflict`, `status = error`, no retry)
2. Handle retryable failures correctly:
   - GitHub rate limiting (`code = github_rate_limit`)
   - Temporary GitHub outages / network errors (`code = github_unavailable`)
   - Request and archive extraction timeouts (`code = timeout`)
   - Temporary object-storage failures (`code = object_storage`)
   - Maintain repository status unchanged (remain `pending`/`active` without marking `error` or `needs_reauth`)
3. Deterministic bounded exponential backoff on retries:
   $$\text{delay} = \min(\text{baseDelay} \times 2^{\text{attemptCount} - 1}, 300\text{s})$$
   - Default base of 5s yields: $5\text{s} \to 10\text{s} \to 20\text{s} \to 40\text{s} \to 80\text{s} \to 160\text{s} \to 300\text{s}$.
   - Respects `maxAttempts` and PostgreSQL failure transition to `dead_letter`.
4. Preserve existing invariants:
   - Tenant isolation & RLS intact.
   - Clean up temporary working directories on success and failure.
   - Preserve Step 15 `repository.indexed` events and WebSocket push.

---

## Architecture Alignment

Following `docs/architecture/05-component-responsibilities.md`, `docs/architecture/11-security-architecture.md`, and `docs/DESIGN.md`:

```text
Worker Job Loop:
  claimNextJob()
    ↓
  executeJob()
    ↓ (Throws error)
  handleFailure()
    ↓
  failJob(job.id, workerId, errorMessage)
    ↓
  isRetryableJobError(error)?
    ├── YES: computeRetryDelay(baseDelay, failed.attemptCount)
    │        retryFailedJob(failed.id, delay)
    │        (Repository status left unchanged)
    └── NO:  (Skip retryFailedJob; job remains failed / dead_letter)
             (Repository status set to needs_reauth or error)
```

---

## 1. Failure Classification Details

| Failure Condition | Error Code | Retryable | Repository Status | Retry Behavior |
| :--- | :--- | :--- | :--- | :--- |
| GitHub 401/403 or revoked installation | `github_auth` | `false` | `needs_reauth` | No retry (`failJob` only) |
| Repository inaccessible / 404 repo | `github_auth` | `false` | `needs_reauth` | No retry (`failJob` only) |
| Invalid Git ref / commit mismatch | `invalid_ref` | `false` | `error` | No retry (`failJob` only) |
| Oversized repository or archive | `repository_too_large` | `false` | `error` | No retry (`failJob` only) |
| Unsafe archive / traversal / symlink | `unsafe_archive` | `false` | `error` | No retry (`failJob` only) |
| Snapshot metadata conflict | `snapshot_conflict` | `false` | `error` | No retry (`failJob` only) |
| GitHub rate limit (429 or 403 quota) | `github_rate_limit` | `true` | Unchanged | Retried with exponential backoff |
| Temporary GitHub 5xx / outage | `github_unavailable` | `true` | Unchanged | Retried with exponential backoff |
| Download / extraction timeout | `timeout` | `true` | Unchanged | Retried with exponential backoff |
| Object storage upload failure | `object_storage` | `true` | Unchanged | Retried with exponential backoff |

---

## 2. Deterministic Exponential Backoff Implementation

In `apps/workers/src/worker.ts`:
```typescript
export const MAX_RETRY_DELAY_SECONDS = 300;

export function computeRetryDelay(
  baseDelaySeconds: number,
  attemptCount: number,
  maxDelaySeconds = MAX_RETRY_DELAY_SECONDS,
): number {
  const exponent = Math.max(0, attemptCount - 1);
  const factor = Math.pow(2, exponent);
  const calculated = Math.floor(baseDelaySeconds * factor);
  return Math.min(calculated, maxDelaySeconds);
}
```

When handling job failure:
```typescript
if (failed.status === "failed" && isRetryableJobError(error)) {
  const delaySeconds = computeRetryDelay(
    this.retryDelaySeconds,
    failed.attemptCount,
  );
  await this.jobStore.retryFailedJob(failed.id, delaySeconds);
}
```

---

## 3. Test Coverage

- `apps/workers/src/worker.test.ts`:
  - `computeRetryDelay produces bounded exponential backoff sequence`: verifies $5\text{s} \to 10\text{s} \to 20\text{s} \to 40\text{s} \to 80\text{s} \to 160\text{s} \to 300\text{s} \to 300\text{s}$.
  - `JobWorker retries retryable failures with exponential retry delays across attempts`: verifies `retryFailedJob` is invoked with calculated delays.
  - `JobWorker retries retryable failures and leaves permanent failures failed`: verifies permanent failures do not invoke `retryFailedJob`.
- `apps/workers/src/github/client.test.ts`:
  - `GitHub 401 is classified as needs_reauth and is permanent`.
  - `GitHub 404 for inaccessible repository is classified as needs_reauth and is permanent`.
  - `temporary GitHub 503 outage is classified as retryable without changing repository status`.
  - `temporary GitHub timeout is classified as retryable timeout without changing repository status`.
  - `GitHub 403 with remaining=0 is classified as retryable rate limiting`.
- `apps/workers/src/ingest/ingest.test.ts`:
  - `GitHub 401/403 style auth failures mark needs_reauth and are not retryable`.
  - `inaccessible repository is classified as needs_reauth, marks repository, and is not retryable`.
  - `rate-limit errors stay retryable and do not change repository status`.
  - `temporary GitHub outage stays retryable and does not change repository status`.
  - `temporary object-storage failure stays retryable and does not change repository status`.
  - `invalid GitHub ref is a permanent repository error and marks repository error`.
  - `oversized repository/archive is a permanent failure, marks error, and is not retryable`.
  - `unsafe archive is a permanent failure and marks error`.
  - `snapshot conflict is a permanent failure and marks error`.
  - `temporary working directories are removed after handler success and failure`.

