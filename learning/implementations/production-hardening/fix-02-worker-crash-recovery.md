# Fluxora Production Hardening — Fix 2: Worker Crash Recovery, Retry Limits & Migration Compatibility

## 1. Executive Summary & Root Cause Analysis

In Fluxora's asynchronous execution architecture, background worker processes execute computationally heavy tasks: repository git cloning, AST parsing, symbol extraction, dependency graph generation, PR diff impact analysis, and scenario simulation.

### 1.1 The Silent Death: Worker Process Crash vs. Reported Runtime Failure
A critical distinction in distributed systems is how failures manifest:
- **Reported Runtime Failure**: The worker process remains alive and healthy. When an error occurs (e.g. GitHub API rate limit, invalid file syntax), the worker catches the exception and explicitly calls `fluxora_fail_job(p_job_id, p_worker_id, p_error)` or `fluxora_retry_failed_job(p_job_id, p_worker_id, p_retry_delay_seconds, p_error)`. The database verifies active lease ownership and transitions the job to `failed`, `pending` (with exponential backoff delay), or `dead_letter` atomically.
- **Worker Process Crash**: The worker process terminates abruptly due to out-of-memory (OOM) kills by the OS kernel, Kubernetes/cgroup pod evictions, unhandled native crashes, power loss, or host hardware failure. In this scenario, **no application error handling or cleanup logic can execute**. The worker cannot make any database calls. The job row remains in status `'running'` with `locked_by` set and an unexpired `lease_expires_at` until wall-clock time passes (`lease_expires_at <= now()`).

```
+-----------------------------------+-----------------------------------+-----------------------------------+
| DIMENSION                         | REPORTED RUNTIME FAILURE          | WORKER PROCESS CRASH              |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Process State                     | Process remains alive and healthy | Process ceases execution instantly|
| Notification Mechanism            | Worker executes fail/retry RPC    | Zero database calls possible      |
| Database Status                   | Transitioned immediately          | Stagnates in 'running' until lease|
| Lease Expiration Timestamp        | Cleared to NULL                   | Retains past timestamp in DB      |
| Recovery Locus                    | Handled by worker catch block     | Must be handled by DB dispatcher  |
+-----------------------------------+-----------------------------------+-----------------------------------+
```

### 1.2 Historical Vulnerability: Unbounded Crash Loops
Under historical implementations, `fluxora_claim_next_job` allowed expired `running` jobs to be reclaimed without verifying whether `attempt_count` had already reached `max_attempts`. Consequently:
1. When a job caused a worker process to crash (e.g. a pathological AST payload causing Node.js heap exhaustion), its lease eventually expired.
2. The next available worker claimed the expired job and incremented `attempt_count`.
3. The new worker immediately crashed on the same payload.
4. This cycle repeated indefinitely, bypassing the configured retry limit (`max_attempts`) and causing infinite crash loops across worker pools (e.g. `attempt_count = 87` on a job configured for `max_attempts = 3`).
5. Stagnant `pending` rows with `attempt_count >= max_attempts` could also be erroneously claimed.

Fix 2 (spanning migrations `0022`, `0023`, `0024`, and review iterations Fix 2A through Fix 2F.1) establishes database-level crash recovery, table-level upper-bound constraints, dual-limit audit preservation, and forward-only migration safety.

---

## 2. The Core Invariant & Mathematical Contract

### 2.1 Semantic Definition of `attempt_count`
> **Invariant Definition:** `attempt_count` is defined strictly as the total number of execution attempts *successfully claimed and leased* by workers.

### 2.2 Mathematical Equation
$$\forall j \in \text{public.jobs}: \quad 0 \le j.\text{attempt\_count} \le j.\text{max\_attempts} \quad \land \quad j.\text{max\_attempts} > 0$$

### 2.3 The Four Inviolable Axioms
1. **Atomic Increment on Claim**: Every successful claim operation (`fluxora_claim_next_job`) increments `attempt_count` by exactly 1.
2. **Eligibility Pre-Condition**: A job is eligible for claim if and only if $\text{attempt\_count} < \text{max\_attempts}$.
3. **Execution Ceiling**: A job must never be leased to a worker if doing so would cause $\text{attempt\_count} > \text{max\_attempts}$.
4. **First Claim is Attempt 1**: When a job is claimed from `pending`, its `attempt_count` transitions from `0` to `1`. A job configured with `max_attempts = 1` can be claimed at most once.

---

## 3. Database-Level Crash Recovery Policy (Migration 0022)

To ensure queue safety even if all worker instances crash simultaneously, crash recovery logic is enforced inside PostgreSQL within `public.fluxora_claim_next_job`.

### Step A: Bounded Batch Dead-Letter Sweeper
Before attempting to claim new work, `fluxora_claim_next_job` executes a bounded batch update (up to 25 rows):
```sql
UPDATE public.jobs AS j
SET
  status = 'dead_letter',
  failed_at = pg_catalog.now(),
  locked_at = NULL,
  locked_by = NULL,
  lease_expires_at = NULL,
  last_error = CASE
    WHEN j.status = 'running'
      THEN 'Job lease expired after retry limit reached'
    ELSE COALESCE(j.last_error, 'Job exceeded retry limit while pending')
  END
WHERE j.id IN (
  SELECT e.id
  FROM public.jobs AS e
  WHERE
    (
      (
        e.status = 'running'
        AND e.lease_expires_at IS NOT NULL
        AND e.lease_expires_at <= pg_catalog.now()
        AND e.attempt_count >= e.max_attempts
      )
      OR (
        e.status = 'pending'
        AND e.attempt_count >= e.max_attempts
      )
    )
  ORDER BY e.available_at ASC, e.id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 25
);
```

**Architectural Decisions in Step A:**
- **Why Bounded (`LIMIT 25`)?** If a cluster outage causes 10,000 jobs to expire simultaneously, sweeping without a limit would trigger an unbounded full-table lock update, causing transaction timeouts and CPU starvation. Sweeping up to 25 rows amortizes recovery debt across normal claim polling.
- **Why `FOR UPDATE SKIP LOCKED`?** Concurrent workers polling for work skip rows locked by peer workers, preventing lock contention and deadlocks.
- **Active Leases Untouched**: Running jobs whose leases have not yet expired (`lease_expires_at > now()`) are strictly preserved.
- **Metadata Scrubbing**: Clears `locked_by`, `locked_at`, and `lease_expires_at` to `NULL`, stamps `failed_at = now()`, and records diagnostic error explanations.

### Step B: Atomic Eligible Claim
Only jobs strictly under their limit and available in wall-clock time are selected:
```sql
WITH candidate AS (
  SELECT j.id
  FROM public.jobs AS j
  WHERE
    (
      (
        j.status = 'pending'
        AND j.attempt_count < j.max_attempts
      )
      OR (
        j.status = 'running'
        AND j.lease_expires_at IS NOT NULL
        AND j.lease_expires_at <= pg_catalog.now()
        AND j.attempt_count < j.max_attempts
      )
    )
    AND j.available_at <= pg_catalog.now()
  ORDER BY j.available_at ASC, j.id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE public.jobs AS j
SET
  status = 'running',
  attempt_count = j.attempt_count + 1,
  locked_at = pg_catalog.now(),
  locked_by = p_worker_id,
  lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
  started_at = COALESCE(j.started_at, pg_catalog.now()),
  last_error = NULL
FROM candidate
WHERE j.id = candidate.id
RETURNING ...;
```

---

## 4. Constraint Enforcement & Parameter Validation (Migration 0023)

### 4.1 SQL Parameter Validation in PostgreSQL
Fix 2A introduced strict input parameter validation inside `public.fluxora_claim_next_job` before executing any table queries:
- `p_worker_id`: Must be a non-empty, non-whitespace string (`pg_catalog.length(pg_catalog.btrim(p_worker_id, E' \t\n\r')) > 0`).
- `p_lease_seconds`: Must be a positive integer (`p_lease_seconds > 0`).
If invalid, the function raises an explicit exception, mutating zero rows and incrementing zero counters.

### 4.2 Table-Level CHECK Constraint
To make invariant violations physically impossible at the storage level:
```sql
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_attempt_count_le_max_attempts
  CHECK (attempt_count <= max_attempts);
```
Together with pre-existing constraints `jobs_attempt_count_check` (`attempt_count >= 0`) and `jobs_max_attempts_check` (`max_attempts > 0`), the database enforces complete bounds.

### 4.3 Multi-Tenant Legacy Reconciliation Under Forced RLS (Fix 2B)
Before applying `VALIDATE CONSTRAINT jobs_attempt_count_le_max_attempts`, existing legacy rows where `attempt_count > max_attempts` required reconciliation.

#### The Problem: Non-Superuser Migrations without Tenant Context
- Table `public.jobs` enforces `FORCE ROW LEVEL SECURITY`.
- The migration runner connects as a non-superuser (`fluxora_migrator`) where `app.current_org_id` is `NULL`.
- Direct `UPDATE public.jobs` without tenant context matched 0 rows! Subsequent constraint validation (which operates at physical table storage) would fail if any historical rows were over-limit.

#### The Solution: Transaction-Scoped Migration Policy
Migration `0023` creates a temporary migration policy scoped strictly to `CURRENT_USER`:
```sql
DROP POLICY IF EXISTS jobs_migration_reconcile_0023 ON public.jobs;
CREATE POLICY jobs_migration_reconcile_0023
  ON public.jobs
  FOR ALL
  TO CURRENT_USER
  USING (true)
  WITH CHECK (true);
```
Because permissive policies combine with `OR`, `(tenant_policy OR jobs_migration_reconcile_0023)` evaluates to `true` for the migration runner across all organizations without granting `BYPASSRLS` or superuser privileges.
The policy is dropped before the transaction commits:
```sql
DROP POLICY jobs_migration_reconcile_0023 ON public.jobs;
```

#### Legacy Data Reconciliation Invariant
Real metrics must **never be decremented or fabricated**. For historical rows where `attempt_count > max_attempts`:
1. `max_attempts` was elevated to equal `attempt_count` so the CHECK constraint holds.
2. Pending and expired running rows transitioned to `dead_letter`.
3. Completed rows retained `status = 'completed'` and historical timestamps.
4. Active running rows preserved their unexpired leases.

---

## 5. Configured vs. Operational Limits & Trigger Guards (Migration 0024)

### 5.1 The Problem: Overwritten User Intent
Elevating `max_attempts` during legacy reconciliation resolved the constraint, but permanently destroyed the original configured limit (e.g. knowing a job was originally configured for 3 retries).

Fix 2E establishes a dual-column model via forward-only migration `0024_job_queue_configured_retry_limit.sql`:
1. `max_attempts`: The operational threshold evaluated by runtime schedulers.
2. `configured_max_attempts`: The immutable original intent configured when the job was enqueued.

### 5.2 Honest Representation of Historical Uncertainty
During migration `0024`:
- For historical rows where `attempt_count < max_attempts`: `configured_max_attempts = max_attempts`.
- For historical rows where `attempt_count >= max_attempts` (which may have been elevated during earlier reconciliation): the original configured limit cannot be proven without external audit logs. The database sets `configured_max_attempts = NULL`.
> **Core Principle:** In production engineering, `NULL` is superior to fabricating a number. It honestly signals that original audit evidence was destroyed prior to migration.

### 5.3 Database Trigger Guard: `fluxora_jobs_retry_limits_guard`
Static column defaults can be bypassed. Migration `0024` installs a `BEFORE INSERT OR UPDATE` trigger:
- **On Insert**:
  - If both `max_attempts` and `configured_max_attempts` are supplied, they must match exactly; otherwise raises `"job max_attempts and configured_max_attempts must match on new jobs when both are provided"`.
  - If only one is supplied, it propagates to the other.
  - If both are omitted, both default to `3`.
  - Rejects `NULL` or non-positive values on new jobs (`"new jobs must receive a valid, non-null configured limit"`).
- **On Update**:
  - `configured_max_attempts` is **completely immutable**. Any attempt to alter it—even updating an unknown historical `NULL` to a value—raises:
    `"configured_max_attempts is immutable and cannot be updated"`.

### 5.4 Migration-Safe Function Upgrades
In PostgreSQL, `CREATE OR REPLACE FUNCTION` cannot change `RETURNS TABLE` output column definitions on existing functions. Migration `0024` executes explicit `DROP FUNCTION IF EXISTS` before recreating all 4 queue functions with `configured_max_attempts integer`, preserving `SECURITY DEFINER`, search paths, and execution grants.

---

## 6. Historical Migration Compatibility Verification (Fix 2F.1)

### 6.1 Context & Provenance Caveat
During development, candidate SQL migrations were archived in review archives (e.g. `fluxora-fix2a-review-20261026-162346.zip`, session `8f7d1140-dc1c-4e6c-9f9c-0903dc947d11`).

> **Explicit Provenance Caveat & Non-Claim:**<br>
> The precise SQL text originally executed in `fluxora_dev` on October 26, 2026 has not been conclusively established. The 386-line candidate fixture (`packages/db/src/migrate/fixtures/historical-0023-candidate.sql`) is treated strictly as a **historical candidate**, not proven provenance. We do not claim that the historical 386-line candidate is proven to be the exact migration originally applied to `fluxora_dev`.

### 6.2 Backward-Compatibility Test Architecture
In `packages/db/src/migrate/job-queue-rls-migration.test.ts`:
1. Dedicated disposable database: `fluxora_historical_migration_test`.
2. Applies migrations `0001` through `0022`.
3. Seeds multi-tenant legacy over-limit fixtures across two organizations.
4. Clears tenant context and applies the archived 386-line candidate as migration 0023 under a non-superuser role (`fluxora_migrator_test`).
5. Applies forward-only migration 0024.
6. Asserts that migration 0024 cleanly upgrades the database:
   - Configured limits backfilled honestly (`NULL` for exhausted rows, preserved for under-limit rows).
   - CHECK constraints validated.
   - Trigger guards active and enforcing immutability.
   - All 5 functions owned by `fluxora_queue` with revoked `PUBLIC` execute.
   - Developer database `fluxora_dev` remained strictly untouched.

---

## 7. State Machine Diagram

```
                 [ Enqueue Job ]
                        |
                        v
         +------------------------------+
         |           PENDING            |
         |    (available_at <= now)     |
         +--------------+---------------+
                        |
                        | Atomic Claim (fluxora_claim_next_job)
                        | attempt_count incremented (+1)
                        v
 +---------------+      +---------------+      Worker Handled Failure
 |               |      |               |      (fluxora_retry_failed_job)
 |               |<-----|    RUNNING    |-----------------------------+
 |               |      | (Active Lease)|                             |
 |               |      +-------+-------+                             v
 |               |              |                        +--------------------------+
 |               |              | Worker Complete        |  PENDING (with backoff)  |
 |               |              | (fluxora_complete_job) |  available_at = now() + d|
 |               |              v                        +--------------------------+
 |  Worker Crash |      +---------------+
 |  & Lease Past |      |   COMPLETED   |
 | (attempt < max)      | (Terminal OK) |
 |               |      +---------------+
 |               |
 |               | Worker Crash & Lease Past (attempt >= max)
 |               | OR Handled Terminal Failure (fluxora_fail_job)
 |               v
 |       +---------------+
 +------>|  DEAD_LETTER  |
         | (Terminal Bad)|
         +---------------+
```

---

## 8. Verification Results

All Fix 2 implementations, migrations, and compatibility fixtures have been verified:

- **Migration Suite** (`packages/db/src/migrate/job-queue-rls-migration.test.ts`):
  12 passed, 0 failed.
  - Approves disposable local/CI hosts and rejects unapproved remote hosts.
  - Applies migrations 0021 through 0024 under constrained non-superuser role `fluxora_migrator_test`.
  - Clean installation test on fresh database (`fluxora_clean_install_test`): 0001 through 0024 clean.
  - Historical 386-line candidate backward compatibility test: clean upgrade to 0024.
- **Queue & RLS Repository Suite** (`packages/db/src/repositories/job-queue-rls.test.ts`):
  36 passed, 0 failed.
  - Crash recovery tests: single allowed attempt dead-lettering, multiple crash reclaiming, remaining attempts, stagnant pending rows, active lease protection, metadata scrubbing, concurrency non-blocking.
  - Parameter validation: worker ID and lease duration rejection in SQL.
  - CHECK constraint enforcement: rejects `attempt_count > max_attempts`.
  - Configured limits: enqueue storage, input validation, direct SQL insert trigger, update immutability, reconciled legacy fixtures across complete, fail, and retry.
- **Combined Test Count**: 48 passed tests across 2 dedicated queue suites.
- **Full Workspace Gates**:
  - `pnpm typecheck`: 0 errors across 7 workspace projects.
  - `pnpm lint`: 0 errors.
  - `pnpm lint:evidence`: 0 errors across 5 conclusion targets.
  - `pnpm build`: Next.js 16 build clean.
