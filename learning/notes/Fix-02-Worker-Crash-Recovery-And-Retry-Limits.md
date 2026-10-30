# Fix 2: Worker Crash Recovery, Retry Limits & Migration Compatibility

## Technical Learning Notes

These notes explain the distributed systems principles, PostgreSQL concurrency patterns, relational constraint strategies, and migration compatibility techniques implemented in Fix 2.

---

## 1. Mental Model: The Distributed Worker Crash Problem

In an asynchronous processing pipeline, background workers pull jobs from a database queue.

```text
               +----------------------------------+
               |      Worker Process (Node.js)    |
               +-----------------+----------------+
                                 |
         +-----------------------+-----------------------+
         |                                               |
         v                                               v
[Handled Exception]                            [Process Hard Crash]
- Network timeout, 404, rate limit             - Linux OOM Killer (cgroups)
- Catch block executes                         - SIGKILL / unhandled native fault
- Calls fluxora_retry_failed_job()             - Zero catch blocks run!
- Job rescheduled with delay or dead-lettered  - Process vanishes from OS
                                               - Job stuck in 'running' in Postgres!
```

### Why Crash Recovery Must Live in PostgreSQL
When a process is killed by `SIGKILL` or an Out-Of-Memory condition:
1. No `try/catch` or `finally` block runs.
2. No `process.on('exit')` or `process.on('SIGTERM')` async handlers complete.
3. No database connection teardown executes.
4. **The database is the only entity that knows the truth:** it observes that `lease_expires_at <= now()`.
Therefore, crash recovery logic **must be implemented inside the database queue dispatcher**, not in application-level worker hooks.

---

## 2. The Attempt-Count Invariant & Semantic Definition

### 2.1 What is an "Attempt"?
> **Definition:** An execution attempt is a *lease successfully claimed by a worker*.

A common trap is defining an attempt as "a completed failure." If you define it this way, a job that crashes a worker 50 times has zero recorded "failures" because the worker never reported back!
By defining `attempt_count` as the number of claims:
- Claiming the job the first time sets `attempt_count = 1`.
- If the worker crashes, attempt 1 was consumed.
- If `max_attempts = 1`, the job cannot be claimed again; it is immediately dead-lettered upon the next claim cycle.

### 2.2 The Invariant Equation
$$\forall j \in \text{public.jobs}: \quad 0 \le j.\text{attempt\_count} \le j.\text{max\_attempts} \quad \land \quad j.\text{max\_attempts} > 0$$

### 2.3 The Four Inviolable Axioms
1. **Atomic Increment:** `attempt_count = attempt_count + 1` at the exact instant the job is claimed.
2. **Eligibility Pre-Condition:** A row is claimable if and only if `attempt_count < max_attempts`.
3. **Execution Ceiling:** The system must never return a job to a worker if doing so violates `attempt_count <= max_attempts`.
4. **Physical Storage Enforcement:** A table-level `CHECK (attempt_count <= max_attempts)` constraint prevents bugs from violating this invariant.

---

## 3. Concurrency & Bounded Sweeping Mechanics

### 3.1 Why Bounded Batch Recovery (`LIMIT 25`)?
If a cluster outage or poison-pill task causes 5,000 jobs to expire at the same time:
- Running `UPDATE jobs SET status = 'dead_letter' WHERE status = 'running' AND lease_expires_at <= now()` without a limit locks thousands of rows in a single transaction.
- This creates massive lock contention, inflates database transaction duration, spikes WAL volume, and blocks concurrent worker claims.
- By capping the sweeper to `LIMIT 25` inside `fluxora_claim_next_job`, every worker polling for work cleans up a small slice of exhausted jobs. The backlog drains continuously with zero latency spikes.

### 3.2 Concurrency with `FOR UPDATE SKIP LOCKED`
When multiple workers execute `claimNextJob()` simultaneously:
- Worker 1 executes the subquery and locks rows #1–#25.
- Worker 2 executes the subquery concurrently. Rather than waiting for Worker 1 to commit (which would happen with `FOR UPDATE`), `SKIP LOCKED` instructs PostgreSQL to immediately skip rows #1–#25 and lock rows #26–#50.
- Result: **Zero lock contention, zero deadlocks, and zero blocking** between distributed workers.

---

## 4. Multi-Tenant Non-Superuser Migrations Under Forced RLS

### 4.1 The Dilemma
When applying migration `0023` to backfill legacy rows:
1. `public.jobs` enforces `FORCE ROW LEVEL SECURITY`.
2. The migration tool connects as a constrained user (`fluxora_migrator_test` or `fluxora_app`) with `NOSUPERUSER, NOBYPASSRLS`.
3. In migration mode, no HTTP request exists, so `app.current_org_id` is `NULL`.
4. `fluxora_current_org_id()` evaluates to `NULL`.
5. Running `UPDATE public.jobs` updates **0 rows** because the tenant policy hides all rows!
6. Subsequent `ALTER TABLE public.jobs VALIDATE CONSTRAINT jobs_attempt_count_le_max_attempts` checks the physical disk storage and fails immediately because over-limit rows still exist.

### 4.2 The Solution: Transaction-Scoped Migration Policy
Rather than granting dangerous `BYPASSRLS` privileges, the migration creates a temporary policy:
```sql
BEGIN;

DROP POLICY IF EXISTS jobs_migration_reconcile_0023 ON public.jobs;
CREATE POLICY jobs_migration_reconcile_0023
  ON public.jobs
  FOR ALL
  TO CURRENT_USER
  USING (true)
  WITH CHECK (true);

-- Execute backfill across all tenants
UPDATE public.jobs ...;

-- Drop policy immediately
DROP POLICY jobs_migration_reconcile_0023 ON public.jobs;

COMMIT;
```
**Why this is the 2026 security benchmark:**
- In PostgreSQL, permissive policies combine with `OR`. For `CURRENT_USER`, `(tenant_policy OR true)` evaluates to `true`.
- The policy is strictly scoped `TO CURRENT_USER`—no application or runtime roles gain access.
- It is dropped inside the same transaction before commit. If anything fails, the entire transaction rolls back cleanly.

---

## 5. Dual-Limit Architecture: Operational vs. Configured Limits

### 5.1 Operational `max_attempts` vs Configured `configured_max_attempts`
When reconciling legacy rows whose `attempt_count > max_attempts`:
- **The Rule of Metric Truth:** Real counter metrics must **never be decremented or fabricated**. Decrementing `attempt_count = 3` to satisfy a constraint conceals real execution failures from monitoring and SRE teams.
- To satisfy `CHECK (attempt_count <= max_attempts)`, the operational limit `max_attempts` was elevated to equal `attempt_count`.
- However, elevating `max_attempts` erased the original user-configured intent (e.g. knowing the job was supposed to retry 3 times).

Fix 2E resolves this by separating:
1. `configured_max_attempts`: The original intent (auditable, immutable).
2. `max_attempts`: The operational threshold enforced by the queue dispatcher.

### 5.2 Honest Representation of Historical Uncertainty
During migration `0024`:
- For rows where `attempt_count < max_attempts`, we know the limit was never normalized: `configured_max_attempts = max_attempts`.
- For legacy rows where `attempt_count >= max_attempts`, the original limit cannot be proven without external audit logs.
- The migration sets `configured_max_attempts = NULL`.
> **Engineering Lesson:** Setting `NULL` is honest engineering. Fabricating an assumed limit (e.g. guessing `3`) invents unverified data. In Fluxora, `NULL` explicitly documents that historical configuration was lost prior to migration.

### 5.3 Database Trigger Guard vs. Column Defaults
Column defaults (`DEFAULT 3`) can be bypassed whenever an `INSERT` statement explicitly supplies `NULL` or conflicting values.
Migration `0024` installs `fluxora_jobs_retry_limits_guard`:
- `BEFORE INSERT`:
  - Enforces defaults if both limits are omitted.
  - Synchronizes single-sided inputs (`max_attempts` $\to$ `configured_max_attempts`).
  - Verifies both limits match when both are provided.
  - Rejects `NULL` or $\le 0$ on new jobs.
- `BEFORE UPDATE`:
  - Enforces that `configured_max_attempts` is **strictly immutable**. Any update that attempts to modify `configured_max_attempts`—even attempting to replace a historical `NULL` with a number—raises an exception:
    `"configured_max_attempts is immutable and cannot be updated"`.

---

## 6. PostgreSQL Function Upgrade Restrictions

In PostgreSQL:
```sql
CREATE OR REPLACE FUNCTION public.fluxora_claim_next_job(...)
RETURNS TABLE (..., configured_max_attempts integer) ...
```
**This fails with an error** if the existing function signature defined a different `RETURNS TABLE` column list (`cannot change return type of existing function`).

**Rule:** When adding columns to a function's `RETURNS TABLE` clause in PostgreSQL:
1. Execute `DROP FUNCTION IF EXISTS public.fluxora_claim_next_job(...)`.
2. Execute `CREATE FUNCTION public.fluxora_claim_next_job(...)`.
3. Re-apply ownership (`ALTER FUNCTION ... OWNER TO fluxora_queue`).
4. Re-apply security grants (`REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO CURRENT_USER`).

---

## 7. Historical Migration Compatibility Testing

### 7.1 Provenance Caveat & Backward Compatibility
During Fix 2 development, a 386-line candidate SQL migration was formulated in Fix 2A and archived in review archives.
- **Caveat:** The exact SQL applied to `fluxora_dev` on October 26, 2026 has not been conclusively established. The 386-line candidate is strictly a **historical candidate**, not proven provenance.
- **Testing Invariant:** Migration `0024` must cleanly upgrade databases that applied this candidate version without modifying migrations `0001`–`0023` or touching `fluxora_dev`.
- This is verified in dedicated integration test `upgrades historical 386-line migration 0023 candidate to migration 0024 under constrained non-superuser role` against disposable database `fluxora_historical_migration_test`.
