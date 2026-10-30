# Fluxora Fix 2 — Worker Crash Recovery & Retry Limits Masterclass & Interview Guide

> **Target Audience:** Senior / Staff / Principal Engineers & System Architects (with layman analogies for cross-functional clarity).<br>
> **Status:** Production Hardened (Migrations `0022`, `0023`, `0024`).<br>
> **Applicability:** Distributed Job Queues, PostgreSQL Concurrency, RLS Multi-Tenancy, 2026 Production Resiliency.

---

## 1. Executive Layman Analogy & 30-Second Elevator Pitch

### The Layman Analogy: The "Rental Car & Tow Truck"
Imagine a car rental desk. A customer leases a car for 2 hours (a worker takes a job).
* **Normal Return (Success/Failure):** The customer returns the keys and says "I finished the trip" (job completed) or "The car broke down at mile 4" (job failed, try again later).
* **Worker Crash (Silent Death):** The driver abruptly vanishes into thin air mid-highway (OOM killer or SIGKILL). The car sits idling on the roadside. The rental agency doesn't get a phone call.
* **The Historical Vulnerability:** After 2 hours, the agency assumes the rental expired. Without checking how many times this specific car has vanished with previous drivers, the desk blindly leases it to someone else. If the car has a faulty engine that causes crashes (a poison pill), driver after driver takes it, crashes, and disappears. The rental counter hits 50 leases on a car that was only ever supposed to be rented 3 times!
* **The Fix 2 Solution:** Before leasing *any* car, the system dispatches a tow truck (the dead-letter batch cleaner). It inspects abandoned cars on the shoulder. If an abandoned car already had 3 attempts, it is immediately towed to the salvage yard (`dead_letter`), its keys are revoked, and an incident ticket is filed. Only cars with *fewer* than 3 attempts can ever be leased again.

### 30-Second Senior Architectural Summary
> *"When a background worker process crashes (e.g., node eviction, OOM kill, unhandled native fault), it cannot report its own demise. Historically, expired leases were blindly reclaimed, allowing crashing jobs to exceed their retry limits indefinitely. Fix 2 moves crash recovery into the PostgreSQL queue dispatcher (`fluxora_claim_next_job`). Prior to claiming work, a bounded batch sweeper atomically dead-letters expired running jobs that reached `max_attempts` using `FOR UPDATE SKIP LOCKED`. Only jobs strictly below `max_attempts` are claimable, enforcing the invariant `0 <= attempt_count <= max_attempts` under zero-blocking concurrency, non-superuser RLS migrations, and immutable configured audit limits."*

---

## 2. The Core Problem & Root Cause Analysis

### 2.1 The Silent Death: Runtime Failure vs. Process Crash
In a distributed asynchronous pipeline (e.g., AST parsing, git clone, symbol extraction, PR diffing):

```
+-----------------------------------+-----------------------------------+-----------------------------------+
| Feature                           | Normal Runtime Failure            | Sudden Worker Process Crash       |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Root Cause                        | Handled Exception (e.g., 404, DB) | OOM (cgroups), SIGKILL, Node Death|
| Process Status                    | Worker process remains alive      | Worker process abruptly ceases    |
| Error Reporting                   | Worker invokes fail/retry RPC     | Zero RPCs or DB calls possible    |
| Database Row State                | Status transitioned immediately   | Status remains stuck in 'running' |
| Lease Expiration Timestamp        | Cleared or reset to backoff delay | Sits unexpired until lease expires|
+-----------------------------------+-----------------------------------+-----------------------------------+
```

### 2.2 Historical Flaw: The Infinite Poison Loop
Prior to Fix 2, `fluxora_claim_next_job` queried for candidates:
```sql
-- Historical Flawed Query:
SELECT id FROM jobs
WHERE (status = 'pending' OR (status = 'running' AND lease_expires_at <= now()))
ORDER BY available_at ASC
FOR UPDATE SKIP LOCKED LIMIT 1;
```
**Why this failed:** It checked `status` and `lease_expires_at`, but completely omitted `attempt_count < max_attempts`.
Every time a crashing job's lease lapsed, the next idle worker picked it up, incremented `attempt_count`, crashed, and repeated the cycle. In real environments, poisoned payloads crashed hundreds of worker containers and generated `attempt_count = 87` on a job configured for `max_attempts = 3`.

```
HISTORICAL VULNERABILITY (UNBOUNDED CRASH LOOP):

  Worker 1              PostgreSQL Queue Table                Worker 2
     |                            |                              |
     |--- Claim Job (attempt=1) ->| (status='running', lease=60s)|
     |                            |                              |
  [CRASH: OOM Kill]               |                              |
     X                            |                              |
                           [60 seconds pass]                     |
                                  |                              |
                                  |<-- Claim Job (attempt=2) ----| (Checks lease, ignores max!)
                                  |    (status='running', lease) |
                                  |                              |
                                  |                       [CRASH: OOM Kill]
                                  |                              X
                           [60 seconds pass]
                                  |
                                  |--> Reclaimed by Worker 3... attempt = 3, 4, 5... INFINITE LOOP!
```

---

## 3. The Core Invariant & Mathematical Contract

### 3.1 Definition of `attempt_count`
> **Semantic Definition:** The total number of execution attempts *successfully claimed and leased* by workers.

### 3.2 The Invariant Equation
$$\forall j \in \text{Jobs}: \quad 0 \le \text{attempt\_count} \le \text{max\_attempts}$$

### 3.3 Four Inviolable Axioms:
1. **Atomic Increment:** Every successful claim operation increments `attempt_count` by exactly 1.
2. **Eligibility Pre-Condition:** A job is claimable if and only if $\text{attempt\_count} < \text{max\_attempts}$.
3. **Execution Ceiling:** A job must never be handed to a worker if doing so would cause $\text{attempt\_count} > \text{max\_attempts}$.
4. **First Claim is Attempt 1:** When a job is first claimed from `pending`, its `attempt_count` moves from `0` to `1`. A job configured with `max_attempts = 1` can be claimed at most once.

### 3.4 Table-Level CHECK Constraint
To make this invariant physically impossible to violate at the relational storage level:
```sql
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_attempt_count_le_max_attempts
  CHECK (attempt_count <= max_attempts);
```

---

## 4. Database-Level Crash Recovery Architecture (`fluxora_claim_next_job`)

To guarantee safety even if every worker process in the cluster is killed, recovery logic lives inside the database queue dispatcher.

```
+---------------------------------------------------------------------------------------------------+
| STEP A: BOUNDED DEAD-LETTER SWEEPER (Cleans exhausted crashed jobs first)                          |
|                                                                                                   |
|  SELECT id FROM public.jobs AS e                                                                  |
|  WHERE (                                                                                          |
|    (e.status = 'running' AND e.lease_expires_at <= now() AND e.attempt_count >= e.max_attempts)   |
|    OR                                                                                             |
|    (e.status = 'pending' AND e.attempt_count >= e.max_attempts)                                   |
|  )                                                                                                |
|  ORDER BY e.available_at ASC, e.id ASC                                                            |
|  FOR UPDATE SKIP LOCKED LIMIT 25;                                                                 |
|                                                                                                   |
|  --> UPDATE status = 'dead_letter', locked_by = NULL, lease_expires_at = NULL,                    |
|             failed_at = now(), last_error = 'Job lease expired after retry limit reached'        |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| STEP B: ATOMIC CANDIDATE CLAIM (Selects eligible work under retry limit)                         |
|                                                                                                   |
|  SELECT j.id FROM public.jobs AS j                                                                |
|  WHERE (                                                                                          |
|    (j.status = 'pending' AND j.attempt_count < j.max_attempts)                                    |
|    OR                                                                                             |
|    (j.status = 'running' AND j.lease_expires_at <= now() AND j.attempt_count < j.max_attempts)    |
|  )                                                                                                |
|  AND j.available_at <= now()                                                                      |
|  ORDER BY j.available_at ASC, j.id ASC                                                            |
|  FOR UPDATE SKIP LOCKED LIMIT 1;                                                                  |
|                                                                                                   |
|  --> UPDATE status = 'running', attempt_count = attempt_count + 1,                                |
|             locked_by = p_worker_id, lease_expires_at = now() + interval(p_lease_seconds)         |
+---------------------------------------------------------------------------------------------------+
```

### 4.1 Step A: Bounded Batch Dead-Letter Sweeper
* **Why Bounded (`LIMIT 25`)?** If a cluster incident causes 10,000 jobs to expire simultaneously, a worker polling for work should not execute an unbounded full-table lock update that starves CPU and blocks other transactions. Bounding the sweep to 25 rows cleans up debt incrementally during normal polling traffic.
* **Why `FOR UPDATE SKIP LOCKED`?** Concurrent workers executing `claimNextJob()` concurrently will skip rows already locked by peer workers, preventing lock contention and deadlocks.
* **Target Criteria:**
  1. Expired running jobs (`status = 'running' AND lease_expires_at <= now() AND attempt_count >= max_attempts`).
  2. Stagnant pending jobs (`status = 'pending' AND attempt_count >= max_attempts`).
* **Active Leases Untouched:** Running jobs with active leases (`lease_expires_at > now()`) are strictly preserved.
* **Sanitized Metadata:** Clears `locked_by`, `locked_at`, and `lease_expires_at` to `NULL`, sets `failed_at = now()`, and records `'Job lease expired after retry limit reached'`.

### 4.2 Step B: Atomic Eligible Claim
* **Eligible Criteria:**
  1. Pending jobs under limit: `status = 'pending' AND attempt_count < max_attempts`.
  2. Expired crashed jobs under limit: `status = 'running' AND lease_expires_at <= now() AND attempt_count < max_attempts`.
  3. Timing gate: `available_at <= now()` (respects retry delay backoff).
* **Atomic Claim Update:** Leases the job to `p_worker_id`, increments `attempt_count = attempt_count + 1`, and extends `lease_expires_at = now() + interval`.

---

## 5. Complete Job State Machine Diagram

```
                 [ Enqueue Job ]
                        |
                        v
        +-------------------------------+
        |            PENDING            |
        |     (available_at <= now)     |
        +---------------+---------------+
                        |
                        | Atomic Claim (fluxora_claim_next_job)
                        | attempt_count incremented (+1)
                        v
+---------------+       +---------------+       Worker Normal Failure
|               |       |               |       (retryFailedJob)
|               |<------|    RUNNING    |-----------------------------+
|               |       | (Active Lease)|                             |
|               |       +-------+-------+                             v
|               |               |                        +--------------------------+
|               |               | Worker Complete        |  PENDING (with backoff)  |
|               |               | (completeJob)          |  available_at = now() + d|
|               |               v                        +--------------------------+
|  Worker Crash |       +---------------+
|  & Lease Past |       |   COMPLETED   |
| (attempt < max)       | (Terminal OK) |
|               |       +---------------+
|               |
|               | Worker Crash & Lease Past (attempt >= max)
|               | OR Normal Failure with exhausted retries (failJob)
|               v
|       +---------------+
+------>|  DEAD_LETTER  |
        | (Terminal Bad)|
        +---------------+
```

---

## 6. Configured vs. Operational Limits & Database Trigger Guard (Fix 2E)

### 6.1 The Historical Divergence Problem
During migration `0023` (Fix 2B), historical over-limit jobs (e.g. `attempt_count = 5`, `max_attempts = 3`) needed reconciliation to prevent CHECK constraint failures.
* **Rule of Truth:** Real metric counters must **never** be decremented or fabricated.
* **Reconciliation:** The database elevated `max_attempts` to match `attempt_count` for legacy rows.
* **The New Problem:** The original user-configured retry limit (e.g., 3) was overwritten by the operational limit (e.g., 5).

### 6.2 The Dual Column Architecture (`0024`)
Fluxora explicitly separates intent from operational bounds:
1. `max_attempts`: The operational threshold evaluated by runtime queries.
2. `configured_max_attempts`: The immutable historical intent configured by the user/system.

### 6.3 The Honest Backfill Rule
During migration `0024`:
* For rows where `attempt_count < max_attempts`: We know the limit was not altered during reconciliation, so `configured_max_attempts = max_attempts`.
* For legacy rows where `attempt_count >= max_attempts`: We cannot honestly know what the original configuration was without external logs. The database sets `configured_max_attempts = NULL`!
  > **Note:** In production engineering, `NULL` is superior to fabricating a number. It honestly signals that original audit evidence was destroyed prior to migration.

### 6.4 The Database Trigger Guard (`fluxora_jobs_retry_limits_guard`)
Column defaults can be bypassed. Fluxora installs a `BEFORE INSERT OR UPDATE` trigger:
* **On Insert:**
  - If both `max_attempts` and `configured_max_attempts` are supplied, they **must match** exactly.
  - If either is omitted, it mirrors the other or defaults to `3`.
  - Rejects limits $\le 0$ or `NULL`.
* **On Update:**
  - `configured_max_attempts` is **completely immutable**. Any attempt to alter it—even replacing an unknown `NULL` with a number—raises an exception:
    `"configured_max_attempts is immutable and cannot be updated"`

---

## 7. Multi-Tenant Non-Superuser RLS Migrations

### 7.1 The Problem: `FORCE ROW LEVEL SECURITY`
Fluxora's `jobs` table enforces `FORCE ROW LEVEL SECURITY`. Normal tenant policies filter rows via:
```sql
USING (organization_id = fluxora_current_org_id())
```
During a production migration, the migration runner (`fluxora_migrator`) connects as a **non-superuser** with `NOSUPERUSER, NOBYPASSRLS`. In migration context:
* No tenant is signed in.
* `fluxora_current_org_id()` evaluates to `NULL`.
* Without special handling, the migration runner cannot see or update legacy rows across organizations!

### 7.2 The Secure Solution: Transaction-Scoped Migration Policy
Rather than granting dangerous `SUPERUSER` or `BYPASSRLS` privileges, the migration creates a temporary policy scoped exclusively to `CURRENT_USER`:

```sql
BEGIN;

-- 1. Create temporary migration policy for the migrator role
DROP POLICY IF EXISTS jobs_migration_reconcile_0024 ON public.jobs;
CREATE POLICY jobs_migration_reconcile_0024
  ON public.jobs
  FOR ALL
  TO CURRENT_USER
  USING (true)
  WITH CHECK (true);

-- 2. Execute global reconciliation and schema updates
UPDATE public.jobs ...;

-- 3. Drop temporary policy before commit
DROP POLICY IF EXISTS jobs_migration_reconcile_0024 ON public.jobs;

COMMIT;
```

**Why this is gold standard in 2026:**
1. Zero superuser privileges required.
2. If any step fails, the entire transaction rolls back—the policy cannot leak into runtime.
3. RLS is never disabled on the table (`FORCE ROW LEVEL SECURITY` stays intact).

---

## 8. Production Worker Implementation (JavaScript / Node.js)

Here is a resilient, production-grade worker loop in JavaScript demonstrating heartbeat leases, structured error classification, backoff calculation, and clean signal handling.

```javascript
/**
 * Production Job Worker Harness (Node.js / JavaScript)
 * Demonstrates safe claiming, lease management, error classification, and graceful exit.
 */

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const LEASE_SECONDS = 60;
let isShuttingDown = false;

// 1. Graceful Shutdown Handlers
function setupSignalHandlers() {
  const shutdown = async (signal) => {
    console.warn(`[${WORKER_ID}] Received ${signal}. Draining current work...`);
    isShuttingDown = true;
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// 2. Exponential Backoff Calculation
function calculateBackoffDelay(attemptCount, baseSeconds = 5, maxSeconds = 300) {
  const expDelay = baseSeconds * Math.pow(2, Math.max(0, attemptCount - 1));
  const jitter = Math.random() * 2; // Anti-thundering herd jitter
  return Math.min(Math.floor(expDelay + jitter), maxSeconds);
}

// 3. Error Classification
function isTransientError(error) {
  // Network timeouts, rate limits, or transient connection resets are retryable
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return true;
  if (error.status === 429 || error.status === 503) return true;
  return false;
}

// 4. Job Execution Router
async function executeTask(job) {
  switch (job.type) {
    case 'repo.ingest':
      console.log(`[${WORKER_ID}] Ingesting repo: ${job.payload.repoUrl}`);
      // Simulate task work...
      break;
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

// 5. Main Polling Loop
export async function startWorker() {
  setupSignalHandlers();
  console.log(`[${WORKER_ID}] Worker started. Listening for jobs...`);

  while (!isShuttingDown) {
    let client;
    try {
      client = await pool.connect();

      // Step A: Atomic Claim via Database Function
      const claimResult = await client.query(
        `SELECT * FROM public.fluxora_claim_next_job($1, $2)`,
        [WORKER_ID, LEASE_SECONDS]
      );

      const job = claimResult.rows[0];

      if (!job) {
        // No work available: sleep before polling again
        client.release();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      console.log(`[${WORKER_ID}] Claimed job ${job.id} (Attempt ${job.attempt_count}/${job.max_attempts})`);

      // Step B: Set up Lease Heartbeat Timer
      const heartbeatInterval = setInterval(async () => {
        try {
          // Heartbeat extends lease if task runs longer than expected
          await pool.query(
            `UPDATE public.jobs
             SET lease_expires_at = now() + interval '60 seconds'
             WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
            [job.id, WORKER_ID]
          );
        } catch (hbErr) {
          console.error(`[${WORKER_ID}] Heartbeat failed:`, hbErr.message);
        }
      }, (LEASE_SECONDS / 2) * 1000);

      // Step C: Execute Job Work with Handled Failure Routing
      try {
        await executeTask(job);

        // Success: Mark Complete
        await client.query(`SELECT * FROM public.fluxora_complete_job($1, $2)`, [job.id, WORKER_ID]);
        console.log(`[${WORKER_ID}] Successfully completed job ${job.id}`);
      } catch (execError) {
        console.error(`[${WORKER_ID}] Task failed for job ${job.id}:`, execError.message);

        if (isTransientError(execError) && job.attempt_count < job.max_attempts) {
          const delaySec = calculateBackoffDelay(job.attempt_count);
          console.warn(`[${WORKER_ID}] Retrying job ${job.id} in ${delaySec}s...`);
          await client.query(
            `SELECT * FROM public.fluxora_retry_failed_job($1, $2, $3, $4)`,
            [job.id, WORKER_ID, delaySec, execError.message]
          );
        } else {
          // Terminal failure: exceeds retry limit or is non-recoverable error
          console.error(`[${WORKER_ID}] Marking job ${job.id} as terminal failure / dead_letter`);
          await client.query(
            `SELECT * FROM public.fluxora_fail_job($1, $2, $3)`,
            [job.id, WORKER_ID, execError.message]
          );
        }
      } finally {
        clearInterval(heartbeatInterval);
      }

      client.release();
    } catch (loopError) {
      if (client) client.release();
      console.error(`[${WORKER_ID}] Unexpected worker harness error:`, loopError.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  await pool.end();
  console.log(`[${WORKER_ID}] Worker cleanly drained and stopped.`);
}
```

---

## 9. Senior / Staff Engineer Interview Questions & Model Answers

### Q1: Why do we perform dead-letter sweeping inside `fluxora_claim_next_job` instead of a separate cron job?
**Senior Answer:**
> *"Separating cleanup into an external cron introduces a dangerous race window and additional operational dependencies. If the cron scheduler dies or lags, workers could claim expired exhausted jobs before the cron marks them dead. By performing a bounded sweep (`LIMIT 25`) inside `fluxora_claim_next_job`, every worker actively helps maintain queue hygiene at the exact instant of claim. The `FOR UPDATE SKIP LOCKED` clause ensures zero lock contention between workers, turning recovery into an atomic, self-healing closed loop without needing external orchestrators."*

### Q2: What happens if two workers poll concurrently while an expired job exists? Can both claim it?
**Senior Answer:**
> *"No. PostgreSQL evaluates candidate rows with `FOR UPDATE SKIP LOCKED`. Worker A and Worker B initiate concurrent transactions. When Worker A locks row #123, row #123 is immediately locked in the row lock table. Worker B's query encounters row #123, sees the exclusive row lock, and skips it instantly to examine the next candidate. Exactly one worker acquires the row and transitions `attempt_count`."*

### Q3: How do we handle clock drift (NTP skew) between worker machines and the database server?
**Senior Answer:**
> *"We completely eliminate client-side timestamps. All queue scheduling, lease calculations, and backoff evaluations use PostgreSQL server time (`pg_catalog.now()`). Leases are set as `pg_catalog.now() + make_interval(secs => p_lease_seconds)`. Even if a worker node's clock drifts by 10 minutes, the database evaluates expiration strictly against its own monotonic transaction timestamp."*

### Q4: Why use PostgreSQL for queues in 2026 instead of Redis/BullMQ, Kafka, or AWS SQS?
**Senior Answer:**
> *"In enterprise multi-tenant architectures, PostgreSQL gives us transactional atomicity with our business data. When a user creates a project or commits code, we can insert the project record and enqueue the ingestion job inside the **same database transaction**. With Kafka or SQS, you face dual-write problems where the database commit succeeds but the message broker publish fails (requiring outbox patterns, CDC debezium, or 2PC). Furthermore, Postgres gives us native Row-Level Security (RLS), strict foreign key constraints, and relational audit querying without operating another distributed system."*

### Q5: What is the risk of high-frequency queue updates in PostgreSQL, and how is it mitigated?
**Senior Answer:**
> *"MVCC churn and table bloat. Every `UPDATE` on a job creates a new row version (dead tuple). If unmanaged, this causes index bloat and slow sequential scans. We mitigate this through:<br>
> 1. HOT (Heap-Only Tuple) optimization: ensure updated columns (`status`, `locked_by`, `lease_expires_at`) do not invalidate indexed columns unnecessarily.
> 2. Dedicated partial index: `CREATE INDEX idx_jobs_claimable ON jobs (available_at, id) WHERE status IN ('pending', 'running');`
> 3. Aggressive autovacuum tuning on the `jobs` table (`autovacuum_vacuum_scale_factor = 0.05`, `autovacuum_vacuum_cost_limit = 1000`)."*

### Q6: Can a job ever be executed more than once?
**Senior Answer:**
> *"Yes. Distributed queues offer **at-least-once** delivery, never exactly-once. If a worker completes 99% of a job's workload and then is abruptly killed by the OOM killer right before invoking `completeJob()`, the database lease will eventually expire and another worker will claim it. Therefore, all job handlers **must be idempotent**. We enforce idempotency via unique keys (e.g., commit SHA, hash of payload, or database upsert constraints)."*

### Q7: Why did we create forward-only migration 0024 instead of editing migration 0023 in-place?
**Senior Answer:**
> *"In production and persistent developer databases (`fluxora_dev`), migration `0023` had already been applied and recorded in `public.schema_migrations`. The migration runner skips files that already exist in `schema_migrations`. If you modify an already-applied migration in-place in Git, upgraded databases will never execute the changes, causing silent schema drift between existing databases and fresh installs. Forward-only migration (`0024_job_queue_configured_retry_limit.sql`) ensures every environment deterministically advances to the target schema without rewriting migration history."*

### Q8: What was the historical 386-line candidate, and how was backward compatibility verified?
**Senior Answer:**
> *"During Fix 2A, a 386-line candidate version of migration 0023 was formulated and preserved in review archives (`fluxora-fix2a-review-20261026-162346.zip`). Crucially, we treat this strictly as a **historical candidate**, not proven provenance—we do not claim it is proven to be the exact migration originally executed in `fluxora_dev`. To guarantee robustness, we built a dedicated backward-compatibility test: we initialize a disposable database with migrations 0001–0022, seed legacy fixtures, apply the archived 386-line candidate, and verify that migration 0024 cleanly upgrades the schema, validates constraints, installs trigger guards, and backfills configured limits without modifying historical migrations or touching `fluxora_dev`."*

---

## 10. Architectural Traps, Anti-Patterns & Red Flags

```
+------------------------------------+--------------------------------------------------------------------------+
| ANTI-PATTERN / RED FLAG            | WHY IT FAILS IN PRODUCTION                                               |
+------------------------------------+--------------------------------------------------------------------------+
| 1. Relying on Worker Try/Catch for | Uncaught signals (SIGKILL, OOM killer, power loss) terminate the runtime |
|    Crash Handling                  | process instantly. Try/catch blocks NEVER run on process termination!    |
+------------------------------------+--------------------------------------------------------------------------+
| 2. Decrementing `attempt_count`    | Metric destruction. Corrupts monitoring telemetry and conceals failure   |
|    to Satisfy Constraints          | rates from site reliability engineers.                                   |
+------------------------------------+--------------------------------------------------------------------------+
| 3. Unbounded Sweeping Queries      | Executing `UPDATE jobs SET status = 'dead_letter' WHERE ...` without     |
|    (`LIMIT` omitted)               | a `LIMIT` can lock thousands of rows, causing high latency spikes.       |
+------------------------------------+--------------------------------------------------------------------------+
| 4. Granting `SUPERUSER` or         | Violates least-privilege security. Breaks tenant isolation boundaries    |
|    `BYPASSRLS` during Migrations   | and introduces severe audit compliance violations.                       |
+------------------------------------+--------------------------------------------------------------------------+
| 5. Client-Side Time Math           | Worker clock drift causes premature lease expirations or delayed claims. |
|    (`Date.now() + 60000`)          | Always evaluate timestamps in the central database (`now()`).            |
+------------------------------------+--------------------------------------------------------------------------+
```

---

## 11. 2026 Production Readiness Verification Checklist

- [x] **Relational Constraint:** `jobs_attempt_count_le_max_attempts` checked and enforced.
- [x] **Crash Safety:** Expired running jobs past `max_attempts` cleanly transition to `dead_letter`.
- [x] **Metadata Scrubbing:** Expired dead-lettered jobs have `locked_by`, `locked_at`, `lease_expires_at` nulled.
- [x] **Dual Limit Preservation:** Operational `max_attempts` and historical `configured_max_attempts` tracked separately.
- [x] **Trigger Guard:** `fluxora_jobs_retry_limits_guard` enforces update immutability and insert synchronization.
- [x] **Non-Superuser RLS:** Transaction-scoped policies allow schema reconciliation without `BYPASSRLS`.
- [x] **Zero-Downtime Signature Upgrade:** Function updates safely dropped and recreated without table locks.
- [x] **Deterministic Test Coverage:** Verified against clean installs and incremental multi-version migrations.
