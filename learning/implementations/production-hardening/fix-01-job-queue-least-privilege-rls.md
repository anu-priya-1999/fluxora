# Fluxora Production Hardening — Fix 1: Job Queue Least-Privilege RLS & Worker Authorization

## 1. Executive Summary & Problem Context

In Fluxora's architecture, background workers perform long-running, asynchronous operations—such as repository ingestion, symbol extraction, dependency graph generation, PR diff impact analysis, and scenario simulation.

The `public.jobs` table durably coordinates this work across multiple tenants. To prevent data leakage between organizations, the table is protected with `FORCE ROW LEVEL SECURITY`. All standard tenant queries evaluate the session setting `app.current_org_id` via the helper function `fluxora_current_org_id()`.

### The Core Architectural Dilemma
1. **Forced Tenant Isolation**: Customer data must never be visible across organization boundaries.
2. **Global Work Dispatch**: Background workers are stateless, distributed worker nodes that pull jobs globally across all customer organizations without belonging to any single tenant context.
3. **The `SECURITY DEFINER` RLS Trap**: The queue operations (`fluxora_claim_next_job`, `fluxora_complete_job`, `fluxora_fail_job`, `fluxora_retry_failed_job`) were authored as `SECURITY DEFINER` functions. However, under PostgreSQL, **`SECURITY DEFINER` does NOT bypass Row-Level Security** when the function owner is a non-superuser or when `FORCE ROW LEVEL SECURITY` is enabled and no role-specific policy applies to the function owner.
4. **Superuser Masking**: Early integration tests ran using the PostgreSQL `postgres` superuser, which automatically bypasses RLS policies. In real staging and production environments, where application services and workers connect as non-superusers, `fluxora_claim_next_job` evaluated RLS against an empty tenant context (`app.current_org_id` is `NULL`) and returned zero jobs, completely stalling the queue.

Fix 1 (spanning migrations `0020_job_queue_least_privilege_rls.sql` and `0021_job_queue_hardening.sql` alongside comprehensive application repository hardening) resolves this fundamental conflict through a least-privilege role architecture, atomic authorization, and isolated test harnesses.

---

## 2. Threat Model & Production Review Findings

During production engineering reviews (Fix 1, 1B, 1C, 1D), critical operational and security vulnerabilities were identified and systematically resolved:

```
+----------------------------------------------------------------------------------------------------+
|                                    FIX 1 THREAT MODEL & MITIGATIONS                                |
+------------------------------------+----------------------------------+----------------------------+
| Threat / Vulnerability             | Root Cause                       | Production Resolution      |
+------------------------------------+----------------------------------+----------------------------+
| 1. Queue Stall under Non-Superuser | SECURITY DEFINER evaluated with  | Dedicated NOLOGIN role     |
|    Connection                      | non-superuser owner lacking RLS  | `fluxora_queue` with       |
|                                    | bypass policy                    | queue-specific RLS policies|
+------------------------------------+----------------------------------+----------------------------+
| 2. Unauthenticated Job Retries     | 2-argument retry function        | 4-argument atomic retry    |
|    Across Organizations            | allowed any caller to retry any  | requiring worker ID and    |
|                                    | job without active lease check   | unexpired active lease     |
+------------------------------------+----------------------------------+----------------------------+
| 3. Connection Leak on Invalid Role | Node checked out pool client     | Validate role format via   |
|    Configuration                   | BEFORE validating role string    | regex BEFORE acquiring     |
|                                    | format                           | connection from pool       |
+------------------------------------+----------------------------------+----------------------------+
| 4. PoolClient vs. Pool Mismatches  | `pg.PoolClient` inherits         | `isPoolClient` predicate   |
|                                    | `connect` from `pg.Client`,      | checking `release` function|
|                                    | misclassified as `pg.Pool`       | and absence of counters    |
+------------------------------------+----------------------------------+----------------------------+
| 5. Tainted Pool Connections on     | If `RESET ROLE` failed, client   | Catch `RESET ROLE` error   |
|    Role Reset Failure              | was returned to pool with dirty  | and call `release(err)` to |
|                                    | role context                     | evict and destroy client   |
+------------------------------------+----------------------------------+----------------------------+
| 6. Accidental Remote DB Mutation   | Test helper connected to DB host | `assertApprovedQueueTest-  |
|    During Integration Tests        | before verifying host allowlist  | Host` validates URL before |
|                                    |                                  | creating any client or SQL |
+------------------------------------+----------------------------------+----------------------------+
| 7. Destructive Test Data Loss      | Incremental migration test       | Mandatory opt-in flag +    |
|    on Non-Disposable Servers       | dropped test databases without   | explicit host allowlist +  |
|                                    | explicit safety opt-in           | distinctness validation    |
+------------------------------------+----------------------------------+----------------------------+
| 8. Migration Ownership Ordering    | `DROP FUNCTION` on queue-owned   | Temporary membership grant |
|    Failure under Non-Superusers    | function failed without holding  | to migrator BEFORE drop,   |
|                                    | owner role authority             | revoked before commit      |
+------------------------------------+----------------------------------+----------------------------+
```

---

## 3. Architecture & Role Governance

### 3.1 The Dedicated Least-Privilege Owner: `fluxora_queue`
To avoid granting dangerous `SUPERUSER` or `BYPASSRLS` privileges to application or worker roles, Fluxora introduces a locked-down PostgreSQL service role: `fluxora_queue`.

All 7 PostgreSQL privilege attributes are strictly enforced:
- `NOLOGIN`: The role cannot be used to open direct database connections.
- `NOSUPERUSER`: The role has zero superuser rights.
- `NOCREATEROLE`: The role cannot create or modify other roles.
- `NOCREATEDB`: The role cannot create or drop databases.
- `NOBYPASSRLS`: The role does NOT bypass RLS globally.
- `NOINHERIT`: Members do not automatically inherit privileges.
- `NOREPLICATION`: The role cannot initiate streaming replication.

Migration `0021_job_queue_hardening.sql` verifies all 7 attributes at migration time:
```sql
SELECT
  r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
  r.rolbypassrls, r.rolinherit, r.rolreplication
INTO
  v_can_login, v_is_superuser, v_can_create_role, v_can_create_db,
  v_bypasses_rls, v_inherit, v_replication
FROM pg_catalog.pg_roles AS r
WHERE r.rolname = 'fluxora_queue';

IF v_can_login OR v_is_superuser OR v_can_create_role OR v_can_create_db
   OR v_bypasses_rls OR v_inherit OR v_replication THEN
  RAISE EXCEPTION 'Existing fluxora_queue role has unsafe attributes';
END IF;
```

### 3.2 Least-Privilege Table Privileges
`fluxora_queue` is granted only the exact privileges necessary to manage queue lifecycles:
1. `USAGE` on schema `public`.
2. `SELECT` on table `public.jobs`.
3. Column-specific `UPDATE` on only mutable lifecycle columns:
   `status`, `attempt_count`, `locked_at`, `locked_by`, `lease_expires_at`, `started_at`, `completed_at`, `failed_at`, `last_error`, `available_at`.
   The role cannot alter immutable columns such as `id`, `organization_id`, `type`, `payload`, `idempotency_key`, or `created_at`.

### 3.3 Role-Specific Permissive RLS Policies
Because `public.jobs` enforces `FORCE ROW LEVEL SECURITY`, RLS applies even to table owners and function owners.

In PostgreSQL, multiple permissive RLS policies on the same table are combined using logical `OR`:
$$\text{Policy Result} = \text{Tenant Policy} \lor \text{Queue Policy}$$

Fluxora defines queue-specific policies scoped strictly `TO fluxora_queue`:
```sql
CREATE POLICY jobs_queue_select
  ON public.jobs
  FOR SELECT
  TO fluxora_queue
  USING (true);

CREATE POLICY jobs_queue_update
  ON public.jobs
  FOR UPDATE
  TO fluxora_queue
  USING (true)
  WITH CHECK (true);
```

**Security Isolation Impact:**
- When `fluxora_claim_next_job` runs, it executes as `fluxora_queue`. Its policy evaluates `(tenant_policy OR true)` $\to$ `true`, allowing cross-tenant queue discovery.
- When normal API or worker connections execute standard SQL, they connect as `fluxora_app` or `fluxora_worker` (or without role elevation). The `jobs_queue_*` policies do **not** apply to them. They can only access rows matching `organization_id = fluxora_current_org_id()`.

---

## 4. Database Function Implementation & Atomic Retry Authorization

### 4.1 Pinned `search_path` and `SECURITY DEFINER`
All queue functions are configured with:
```sql
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
```
Pinned search paths prevent malicious schema substitution attacks where an attacker creates a shadow function (e.g. `public.now()`) in a high-priority schema.

### 4.2 Function Ownership & Execution ACL Lifecycle
Queue functions are owned by `fluxora_queue`. Default `PUBLIC` execution is revoked:
```sql
REVOKE ALL ON FUNCTION public.fluxora_claim_next_job(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fluxora_claim_next_job(text, integer) TO CURRENT_USER;
```
If runtime roles `fluxora_worker` or `fluxora_rls_test` exist, execution is explicitly granted to them.

### 4.3 Atomic Retry Authorization (`fluxora_retry_failed_job`)
In earlier implementations, retrying a job was invoked via `fluxora_retry_failed_job(uuid, integer)`. This had a critical security hole: any tenant or caller who guessed a UUID could force a job to be retried or reset, even if another worker owned the active lease.

Migration `0021_job_queue_hardening.sql` drops the 2-parameter signature and replaces it with an atomic 4-parameter signature:
```sql
CREATE OR REPLACE FUNCTION public.fluxora_retry_failed_job(
  p_job_id uuid,
  p_worker_id text,
  p_retry_delay_seconds integer DEFAULT 0,
  p_error text DEFAULT NULL
)
RETURNS TABLE (...)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  UPDATE public.jobs AS j
  SET
    status = CASE
      WHEN j.attempt_count >= j.max_attempts THEN 'dead_letter'
      ELSE 'pending'
    END,
    available_at = CASE
      WHEN j.attempt_count < j.max_attempts
        THEN pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_delay_seconds)
      ELSE j.available_at
    END,
    last_error = COALESCE(p_error, j.last_error),
    failed_at = CASE
      WHEN j.attempt_count >= j.max_attempts THEN pg_catalog.now()
      ELSE NULL
    END,
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL
  WHERE
    j.id = p_job_id
    AND j.status = 'running'
    AND j.locked_by = p_worker_id
    AND j.lease_expires_at IS NOT NULL
    AND j.lease_expires_at > pg_catalog.now()
  RETURNING ...;
$$;
```

**Key Invariants Enforced Atomically:**
1. **Worker Lease Ownership**: The caller must match `locked_by = p_worker_id`. A worker cannot retry a job leased to another worker.
2. **Active Lease Validity**: The lease must not have expired (`lease_expires_at > now()`). If the worker took too long and the lease expired, it loses the right to retry the job.
3. **Attempt Exhaustion Check**: If `attempt_count >= max_attempts`, the job transitions immediately to `'dead_letter'`, recording `failed_at = now()`.
4. **Retry Backoff Scheduling**: If attempts remain, the job transitions to `'pending'` with `available_at` deferred by `p_retry_delay_seconds`.
5. **State Reset**: Clears `locked_at`, `locked_by`, and `lease_expires_at` to `NULL`.

---

## 5. Application Client Lifecycle & Pool Management

In `packages/db/src/repositories/job.ts`, worker queries execute inside `withWorkerClient`:

```typescript
export async function withWorkerClient<T>(
  clientOrPool: pg.Pool | pg.PoolClient | undefined,
  fn: (client: pg.PoolClient | pg.ClientBase) => Promise<T>,
): Promise<T> {
  // 1. Caller-supplied PoolClient lifecycle: do not alter role or close client
  if (isPoolClient(clientOrPool)) {
    return fn(clientOrPool);
  }

  // 2. Validate role format BEFORE acquiring connection from pool
  const role = localDatabaseRole();
  const pool = (clientOrPool as pg.Pool | undefined) ?? getPool();
  const client = await pool.connect();

  let result: T;
  try {
    if (role !== null) {
      await client.query(`SET ROLE ${role}`);
    }
    result = await fn(client);
  } catch (operationError) {
    if (role !== null) {
      try {
        await client.query("RESET ROLE");
        client.release();
      } catch (resetErr) {
        // Evict and destroy tainted connection from pool
        client.release(resetErr as Error);
      }
    } else {
      client.release();
    }
    throw operationError;
  }

  // 3. Normal cleanup
  if (role !== null) {
    try {
      await client.query("RESET ROLE");
      client.release();
    } catch (resetErr) {
      client.release(resetErr as Error);
      throw resetErr;
    }
  } else {
    client.release();
  }

  return result;
}
```

### Reliable `isPoolClient` Predicate
In `node-postgres`, `pg.PoolClient` extends or wraps `pg.Client`, meaning `client.connect` exists. Naive checks such as `!("connect" in clientOrPool)` fail and treat checked-out clients as pools.
`isPoolClient` solves this:
```typescript
export function isPoolClient(clientOrPool: unknown): clientOrPool is pg.PoolClient {
  if (!clientOrPool || typeof clientOrPool !== "object") return false;
  if (clientOrPool instanceof pg.Pool) return false;
  return (
    "query" in clientOrPool &&
    typeof (clientOrPool as { release?: unknown }).release === "function" &&
    !("totalCount" in clientOrPool)
  );
}
```

---

## 6. Test Safety & CI Guardrails

Queue and RLS integration tests require testing cross-tenant behavior and non-superuser role transitions. Because tests can execute dangerous SQL or drop databases, strict guardrails are enforced:

### 6.1 Host Allowlist Validation Before Database Connection
In `packages/db/src/repositories/job-queue-rls.test.ts`:
```typescript
export const APPROVED_QUEUE_TEST_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "postgres",
] as const;

export function assertApprovedQueueTestHost(rawUrl: string | URL): URL {
  const parsed = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  if (!isApprovedQueueTestHost(parsed.hostname)) {
    throw new Error(
      `Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets unapproved remote host "${parsed.hostname}". ` +
      `Queue integration tests are restricted to approved disposable local/CI hosts.`
    );
  }
  return parsed;
}
```
`assertApprovedQueueTestHost` is called **before** `fetchDatabaseIdentity` or `runMigrations`, guaranteeing no network connection or SQL query is sent to remote or unapproved servers.

### 6.2 Destructive Test Safety Flags
In `packages/db/src/migrate/job-queue-rls-migration.test.ts`:
- Destructive migration tests (creating and dropping `fluxora_inc_migration_test`) require an explicit environment opt-in: `FLUXORA_ALLOW_DESTRUCTIVE_QUEUE_MIGRATION_TESTS=true`.
- The test verifies that the target database name is distinct from `DATABASE_URL`, `FLUXORA_QUEUE_TEST_DATABASE_URL`, and never matches development databases (`fluxora_dev` or `*_dev`).
- In CI, the workflow `.github/workflows/ci.yml` sets this variable exclusively for its disposable container service. If missing in CI, the test fails loudly rather than silently skipping.

### 6.3 Independent Partial Fixture Cleanup
In test teardown, multiple fixtures (`orgA`, `orgB`) are deleted independently. If creation of `orgB` fails, `orgA` is still cleaned up, avoiding orphan database rows. Errors during teardown are aggregated using `AggregateError`.

---

## 7. Verification Results

All Fix 1 implementations have been verified across unit, integration, and CI test suites:

- **Dedicated Worker Client Unit Suite** (`packages/db/src/repositories/job-worker-client.test.ts`):
  16 passed, 0 failed.
  Verifies `isPoolClient`, `withWorkerClient` normal paths, callback failure paths, `SET ROLE` failures, `RESET ROLE` failures, and leak prevention.
- **Queue & RLS Integration Suite** (`packages/db/src/repositories/job-queue-rls.test.ts`):
  18 passed (5 safety guard tests + 13 queue integration tests), 0 failed.
  Verifies role attributes, function ownership, lack of `PUBLIC` grants, cross-tenant claiming, worker lease enforcement, atomic retry authorization, and tenant isolation.
- **Incremental Non-Superuser Migration Suite** (`packages/db/src/migrate/job-queue-rls-migration.test.ts`):
  Non-superuser migration runner test passed applying migrations 0020 and 0021 under `fluxora_migrator_test`.
- **Full Workspace Quality Gates**:
  - `pnpm typecheck`: 0 errors across 7 workspace projects.
  - `pnpm lint`: 0 errors.
  - `pnpm lint:evidence`: 0 errors.
  - `pnpm build`: Clean workspace build.
