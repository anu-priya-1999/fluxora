# Fluxora — Phase 1 — Step 6
# PostgreSQL Job Queue + Minimal Worker Harness

## Status: COMPLETE ✅

Step 6 implementation and runtime verification are complete.

The implemented system provides:

```text
✅ durable PostgreSQL-backed jobs
✅ tenant-aware jobs
✅ RLS protection
✅ idempotency enforcement
✅ atomic claiming
✅ SKIP LOCKED concurrency
✅ lease-based crash recovery
✅ worker ownership checks
✅ successful completion
✅ failure handling
✅ retry
✅ dead-lettering
✅ generic worker harness
✅ handler registry
✅ worker success execution
✅ worker failure execution
✅ runtime integration verification
```

---

# 1. Canonical objective

Step 6 was defined as:

```text
PostgreSQL-backed job queue
+
minimal worker harness
+
idempotency enforcement
```

The queue lifecycle is:

```text
enqueue
claim
complete
fail
retry
dead-letter
```

The worker must be:

```text
retryable
idempotent
tenant-aware
crash-recoverable
```

OpenTelemetry remains Step 7.

---

# 2. Database changes

Implemented migrations:

```text
0004_jobs.sql
0005_job_claim_function.sql
0006_job_completion_function.sql
0007_job_failure_retry.sql
```

---

# 3. `jobs` table

Important fields:

```text
id                  UUID
organization_id     UUID
type                TEXT
payload             JSONB
status              TEXT
idempotency_key     TEXT
attempt_count       INTEGER
max_attempts        INTEGER
available_at        TIMESTAMPTZ
locked_at           TIMESTAMPTZ
locked_by           TEXT
lease_expires_at    TIMESTAMPTZ
last_error          TEXT
created_at          TIMESTAMPTZ
started_at          TIMESTAMPTZ
completed_at        TIMESTAMPTZ
failed_at           TIMESTAMPTZ
```

Allowed status values:

```text
pending
running
completed
failed
dead_letter
```

Important indexes support:

```text
claim ordering
organization/status lookup
lease expiry lookup
```

RLS is enabled and forced.

Tenant policies use:

```text
organization_id = fluxora_current_org_id()
```

---

# 4. Idempotency

Constraint:

```sql
UNIQUE (organization_id, idempotency_key)
```

Enqueue uses PostgreSQL conflict handling.

The critical property:

```text
Tenant A + same key
→ same logical job

Tenant B + same key
→ independent job
```

This is tenant-scoped idempotency.

Runtime verification:

```text
FIRST
id = 61aa64a1-b1e9-4ba1-86fe-b9a30b49d1bb

DUPLICATE
same id

OTHER_TENANT
different id

SAME_JOB_FOR_DUPLICATE = true
DIFFERENT_JOB_FOR_OTHER_TENANT = true
```

---

# 5. Atomic claim

Migration:

```text
0005_job_claim_function.sql
```

Uses:

```sql
FOR UPDATE SKIP LOCKED
```

Claim behavior:

```text
find eligible job
       ↓
row lock
       ↓
status = running
       ↓
attempt_count += 1
       ↓
locked_by = worker
       ↓
locked_at = now
       ↓
lease_expires_at = now + lease
```

Two workers therefore coordinate safely:

```text
Worker A → Job 1
Worker B → skips locked Job 1
```

---

# 6. Lease-based crash recovery

The lease fields are:

```text
locked_by
lease_expires_at
```

If a worker crashes:

```text
running
   ↓
lease expires
   ↓
job becomes eligible again
   ↓
another worker reclaims
```

Runtime verification:

```text
FIRST_CLAIM
attemptCount = 1
lockedBy = worker-test-1

SECOND_CLAIM_AFTER_EXPIRY
attemptCount = 2
lockedBy = worker-test-2
```

This proves crash recovery.

---

# 7. Completion

Migration:

```text
0006_job_completion_function.sql
```

Completion is allowed only if:

```text
status = running
locked_by = current worker
lease_expires_at > now()
```

Successful completion:

```text
status = completed
locked_at = null
locked_by = null
lease_expires_at = null
completed_at = now
```

This prevents stale workers from completing jobs after another worker has reclaimed them.

Runtime verification:

```text
wrong worker
→ rejected

current worker
→ completed
```

---

# 8. Failure / retry / dead-letter

Migration:

```text
0007_job_failure_retry.sql
```

`failJob()` verifies current worker ownership and lease validity.

If attempts remain:

```text
running
→ failed
→ retry
→ pending
```

If attempts are exhausted:

```text
running
→ dead_letter
```

`last_error` records the latest execution failure.

Runtime verification with `maxAttempts = 2`:

```text
attempt 1
→ failed

retry
→ pending

attempt 2
→ dead_letter
```

Retrying a dead-lettered job is rejected.

---

# 9. Shared job contracts

Implemented:

```text
packages/shared-types/src/jobs.ts
```

Key types:

```text
JobStatus
JobPayload
Job
EnqueueJobInput
```

This gives the worker and DB repository shared domain contracts.

---

# 10. Job repository

Implemented:

```text
packages/db/src/repositories/job.ts
```

Functions:

```text
enqueueJob()
getJobById()
claimNextJob()
completeJob()
failJob()
retryFailedJob()
```

The repository maps PostgreSQL rows into application-level `Job` objects.

---

# 11. Worker harness

Implemented:

```text
apps/workers/src/handlers.ts
apps/workers/src/handlers/test-echo.ts
apps/workers/src/worker.ts
apps/workers/src/index.ts
```

Worker lifecycle:

```text
claimNextJob()
       ↓
lookup handler
       ↓
handler(job)
   ┌───────┴───────┐
   ↓               ↓
success           error
   ↓               ↓
complete          fail
                   ↓
                retry / DLQ
```

---

# 12. Handler registry

Contract:

```ts
type JobHandler = (job: Job) => Promise<void>;

type JobHandlerRegistry =
  Readonly<Record<string, JobHandler>>;
```

This keeps the worker engine generic.

Future handlers can include:

```text
repository.ingest
analysis.run
impact.analyze
simulation.run
ai.explain
```

The current:

```text
test.echo
```

handler is only a deterministic infrastructure test.

---

# 13. Runtime test inventory

## Claim

Verified:

```text
pending
→ running
attempt 0 → 1
lease assigned
worker assigned
```

## Duplicate claim

Verified:

```text
Worker 1 → job
Worker 2 → null
```

## Lease expiry

Verified:

```text
Worker 1 → attempt 1
lease expires
Worker 2 → attempt 2
```

## Completion ownership

Verified:

```text
wrong worker → rejected
correct worker → completed
```

## Failure/retry/dead-letter

Verified:

```text
running
→ failed
→ pending
→ running
→ dead_letter
```

## Worker success path

Verified:

```text
enqueue
→ JobWorker.runOnce()
→ test.echo
→ completed
```

## Worker failure path

Verified:

```text
handler throws
→ failJob()
→ retry
→ handler throws
→ dead_letter
```

## Tenant-scoped idempotency

Verified:

```text
same tenant + same key
→ same job

different tenant + same key
→ different job
```

---

# 14. Full worker integration result

The successful worker test produced:

```text
ENQUEUED
status = pending
attemptCount = 0
```

Worker execution:

```text
[test.echo] worker processed job ...
```

Then:

```text
WORKER_RUN_ONCE true
```

Persisted state:

```text
status = completed
attemptCount = 1
lockedBy = null
leaseExpiresAt = null
completedAt = <timestamp>
```

Second run:

```text
SECOND_RUN false
```

Therefore the completed job was not processed again.

---

# 15. Worker failure integration result

The real worker was given a handler that intentionally threw.

Result:

```text
FIRST_RUN true

AFTER_FIRST_FAILURE
status = pending
attemptCount = 1

SECOND_RUN true

AFTER_SECOND_FAILURE
status = dead_letter
attemptCount = 2
```

This proves retry/dead-letter logic exists inside the worker execution path, not only inside isolated DB tests.

---

# 16. Security model

Normal tenant-scoped DB access uses:

```text
withTenant()
```

and PostgreSQL RLS.

Worker claiming is cross-tenant, so it uses a controlled PostgreSQL privileged function boundary.

The current implementation uses:

```text
SECURITY DEFINER
```

for queue operations.

Do not casually solve this by disabling RLS globally.

Local verification ran as:

```text
postgres
rolsuper = true
rolbypassrls = true
```

This is a local testing condition, not a production worker credential recommendation.

At deployment time, the worker database capability should be deliberately restricted.

---

# 17. Why at-least-once?

Fluxora does not claim exactly-once execution.

A crash can happen:

```text
after side effect
before complete()
```

Then the lease expires and the job may run again.

Therefore:

```text
at-least-once delivery
+
idempotent handlers
```

is the intended design.

---

# 18. Scaling story

MVP:

```text
PostgreSQL
   ↓
jobs table
   ↓
workers
```

At larger scale:

```text
API
 ↓
managed queue
 ↓
worker fleet
```

Potential queue technologies:

```text
SQS
Kafka
```

The semantic contract remains:

```text
claim
execute
complete
fail
retry
dead-letter
```

The queue implementation can change without changing the overall worker model.

---

# 19. What remains outside Step 6

Not part of this step:

```text
Step 7  OpenTelemetry
Step 8  CI/CD
Step 9  local-dev compose/seed
Step 10 GitHub App
Step 11 repository tables
Step 12 ingestion worker
...
```

Step 6 deliberately establishes the background execution foundation that later product workers depend on.

---

# 20. Definition of done for Step 6

Step 6 can be considered complete because:

```text
✅ durable jobs exist
✅ jobs are tenant-aware
✅ duplicate submission is controlled
✅ workers claim atomically
✅ multiple workers do not double-claim
✅ worker crashes can be recovered
✅ completion is ownership-aware
✅ failures are persisted
✅ retries work
✅ retries eventually stop
✅ dead-lettering works
✅ a real worker process executes a handler
✅ success path works
✅ failure path works
✅ runtime integration tests passed
✅ workspace typecheck passed
```

---

# 21. Interview cheat sheet

### Why PostgreSQL?

> Already the system of record; fewer moving parts for MVP.

### Why `SKIP LOCKED`?

> Concurrent workers can claim different rows without waiting on locked rows.

### Why lease?

> Crashed workers must not hold work forever.

### What delivery guarantee?

> At-least-once.

### How prevent duplicate jobs?

> Unique `(organization_id, idempotency_key)` plus conflict handling.

### How prevent duplicate effects?

> Handlers must be idempotent.

### How stop infinite retries?

> `max_attempts` → `dead_letter`.

### How protect against stale workers?

> Completion/failure require matching worker ownership and a valid lease.

### Why handler registry?

> Keeps generic worker mechanics separate from product-specific jobs.

### Why not claim exactly-once?

> Crash windows make exactly-once end-to-end execution much harder; the system instead guarantees safe re-execution.

---

# 22. Final diagram

```text
                         API
                          │
                       enqueue
                          │
                          ▼
                 ┌────────────────┐
                 │   PostgreSQL   │
                 │     jobs       │
                 └───────┬────────┘
                         │
                  SKIP LOCKED
                         │
                         ▼
                 ┌────────────────┐
                 │     Worker     │
                 └───────┬────────┘
                         │
                  Handler Registry
                         │
                ┌────────┴────────┐
                │                 │
             success           failure
                │                 │
                ▼                 ▼
            complete            fail
                                  │
                           ┌──────┴──────┐
                           │             │
                         retry      max attempts
                           │             │
                           ▼             ▼
                        pending     dead_letter

        Worker crash
             ↓
       lease expires
             ↓
      another worker
         reclaims
```

## Final sentence

> **"Fluxora's queue is durable, at-least-once, idempotent, leased, tenant-aware, retryable, and dead-lettered."**
