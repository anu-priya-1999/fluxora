# Fix 1: Job Queue Least-Privilege RLS & Worker Authorization

## Technical Learning Notes

These notes capture the underlying PostgreSQL mechanics, role governance principles, and application-layer engineering patterns implemented in Fix 1.

---

## 1. The Core Tension: Multi-Tenant RLS vs. Global Job Queues

In a software digital twin platform like Fluxora, every code snapshot, AST graph, and analysis finding belongs strictly to a customer organization (`organization_id`).

```text
+---------------------------------------------------------------------------------+
|                                 DATABASE ENGINE                                 |
|                                                                                 |
|  [Tenant Query]                                                                 |
|  SET app.current_org_id = 'org-123'                                             |
|  SELECT * FROM jobs; -----> Filtered by RLS: only sees Org-123 jobs            |
|                                                                                 |
|  [Worker Claim Query]                                                           |
|  app.current_org_id IS NULL                                                     |
|  SELECT * FROM jobs; -----> Blocked by default RLS: sees 0 jobs! (Queue Stalled)|
+---------------------------------------------------------------------------------+
```

### Why Background Workers Must Be Cross-Tenant
- In production, we do not spin up dedicated worker instances per organization. A shared worker cluster must poll for pending jobs across all organizations.
- When an API node enqueues a job (`enqueueJob`), it is inside a tenant session (`app.current_org_id = 'org-123'`). The job row is stamped with `organization_id`.
- When a worker polls (`claimNextJob`), it runs in a global worker harness where `app.current_org_id` is intentionally `NULL`.

---

## 2. PostgreSQL Row-Level Security Mechanics

### 2.1 Normal RLS vs. `FORCE ROW LEVEL SECURITY`
- `ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;`
  In standard RLS, table owners and superusers bypass all RLS policies.
- `ALTER TABLE jobs FORCE ROW LEVEL SECURITY;`
  Forced RLS ensures that **even the table owner** is subject to RLS policies. This is vital for multi-tenant safety so that an accidental query executed by the application database user does not dump cross-tenant data.

### 2.2 The `SECURITY DEFINER` RLS Trap
Many developers assume:
> *"If I wrap the query inside a `SECURITY DEFINER` function, RLS will be bypassed."*

**This is false in PostgreSQL.**
When a `SECURITY DEFINER` function executes:
1. PostgreSQL switches the execution context to the **owner** of the function.
2. If the owner is a normal non-superuser, RLS is evaluated against that owner.
3. If the table enforces `FORCE ROW LEVEL SECURITY`, RLS policies are applied to the owner's session.
4. Because the tenant policy checks `organization_id = fluxora_current_org_id()`, and `fluxora_current_org_id()` is `NULL`, the query matches **zero rows**.

### 2.3 The Superuser Masking Trap in Testing
When developers or CI environments run tests as the `postgres` superuser:
- PostgreSQL superusers bypass `FORCE ROW LEVEL SECURITY`.
- `fluxora_claim_next_job` appears to work perfectly in testing!
- As soon as the application deploys to production (where connections run as constrained roles like `fluxora_app` or `fluxora_migrator`), the queue instantly stalls.
- **Lesson:** Always run RLS integration tests under a non-superuser role (`NOSUPERUSER, NOBYPASSRLS`).

### 2.4 Permissive Policies Combine with Logical `OR`
PostgreSQL supports two policy types: `PERMISSIVE` (default) and `RESTRICTIVE`.
For permissive policies on the same command (`SELECT` or `UPDATE`):
$$\text{Row Visible} = \text{Policy}_1 \lor \text{Policy}_2 \lor \dots \lor \text{Policy}_n$$

By creating policies scoped strictly to `fluxora_queue`:
```sql
CREATE POLICY jobs_queue_select ON public.jobs FOR SELECT TO fluxora_queue USING (true);
CREATE POLICY jobs_queue_update ON public.jobs FOR UPDATE TO fluxora_queue USING (true) WITH CHECK (true);
```
- For the `fluxora_queue` role: `(tenant_policy OR true)` evaluates to `true`.
- For any other role: `jobs_queue_*` does not apply; only the tenant policy evaluates.

---

## 3. PostgreSQL Role Attribute Hardening

PostgreSQL roles have 7 critical privilege flags. Least-privilege roles should disable all seven:

| Attribute | What it allows | Why `fluxora_queue` must NOT have it |
|---|---|---|
| `LOGIN` | Direct client connection via password/socket | Prevents attackers or apps from logging in as queue |
| `SUPERUSER` | Total database control, bypasses all checks | Extreme privilege escalation risk |
| `CREATEROLE` | Can create or alter database roles | Could grant itself superuser or bypass rights |
| `CREATEDB` | Can create new databases | Unnecessary for queue dispatch |
| `BYPASSRLS` | Global bypass of Row-Level Security | Would compromise all tenant tables, not just queue |
| `INHERIT` | Members automatically inherit privileges | We want explicit execution boundaries, not inherited |
| `REPLICATION`| Can start WAL streaming/replication slots | Unnecessary for application logic |

### Column-Level Privilege Narrowing
Rather than granting broad `UPDATE` on `public.jobs`:
```sql
GRANT UPDATE (
  status, attempt_count, locked_at, locked_by, lease_expires_at,
  started_at, completed_at, failed_at, last_error, available_at
) ON TABLE public.jobs TO fluxora_queue;
```
If a bug exists in a queue function, it cannot accidentally modify `organization_id`, `idempotency_key`, `type`, or `payload`.

---

## 4. Secure Function Lifecycle & Pinned `search_path`

### 4.1 Search Path Injection Attack
In a `SECURITY DEFINER` function, if `search_path` is left default:
- A malicious user with table/function creation rights could create a function `public.now()` that steals credentials or drops tables.
- When `fluxora_claim_next_job` calls `now()`, PostgreSQL would execute the malicious shadow function with owner privileges!
- **Rule:** Every `SECURITY DEFINER` function must explicitly pin:
  `SET search_path = pg_catalog, public, pg_temp`
  and schema-qualify all function invocations (`pg_catalog.now()`).

### 4.2 Revoking Default `PUBLIC` Execution
In PostgreSQL, functions granted `LANGUAGE sql` or `LANGUAGE plpgsql` grant `EXECUTE` to `PUBLIC` (all database users) by default.
We must explicitly revoke this:
```sql
REVOKE ALL ON FUNCTION public.fluxora_retry_failed_job(...) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fluxora_retry_failed_job(...) TO CURRENT_USER;
```

---

## 5. Atomic Worker Authorization & State Machine

### 5.1 The Insecure 2-Parameter Signature
Historically:
`fluxora_retry_failed_job(p_job_id uuid, p_retry_delay_seconds integer)`
Anyone with access to the database or API could invoke this on any job UUID, resetting running or failed jobs leased by other workers.

### 5.2 Atomic 4-Parameter Authorization
```sql
WHERE
  j.id = p_job_id
  AND j.status = 'running'
  AND j.locked_by = p_worker_id
  AND j.lease_expires_at IS NOT NULL
  AND j.lease_expires_at > pg_catalog.now()
```
This guarantees:
1. **Identity:** Only the worker holding the lease can trigger a retry.
2. **Lease:** If the worker crashed or paused and the lease expired, it can no longer retry.
3. **State:** The job must currently be `'running'`.

---

## 6. Connection Pool Hygiene & `withWorkerClient`

### 6.1 `pg.Pool` vs `pg.PoolClient`
In `node-postgres`:
- `pg.Pool` represents the pool. Calling `pool.connect()` returns a `pg.PoolClient`.
- `pg.PoolClient` represents a single connection checked out of the pool.
- Because `pg.PoolClient` inherits from `pg.Client`, it has a `.connect()` method. A naive check like `!("connect" in obj)` treats a client as a pool!
- `isPoolClient` inspects `release` and the absence of `totalCount`:
  ```typescript
  export function isPoolClient(obj: unknown): obj is pg.PoolClient {
    return (
      !!obj &&
      typeof obj === "object" &&
      !(obj instanceof pg.Pool) &&
      "query" in obj &&
      typeof (obj as any).release === "function" &&
      !("totalCount" in obj)
    );
  }
  ```

### 6.2 Connection Tainting on `RESET ROLE` Failure
When executing queries with an elevated or specific role:
```typescript
await client.query(`SET ROLE ${role}`);
try {
  await fn(client);
} finally {
  try {
    await client.query("RESET ROLE");
    client.release();
  } catch (resetErr) {
    // CRITICAL: Connection has a dirty role context.
    // Calling client.release(err) tells node-postgres to destroy the socket,
    // preventing the tainted connection from returning to the pool!
    client.release(resetErr as Error);
  }
}
```

### 6.3 Pre-Flight Input Validation
If a role string is invalid (e.g. invalid characters), checking out a connection first and then failing leaves an idle connection waiting or risks pool exhaustion.
Validating `localDatabaseRole()` format via regex **before** `pool.connect()` prevents connection leaks.

---

## 7. Test Harness Safety Engineering

When tests manipulate database roles or migrations:
1. **Never Connect to Unapproved Hosts:** An integration test must validate hostnames against an approved allowlist (`localhost`, `127.0.0.1`, `::1`, `postgres`) before opening any TCP socket.
2. **Distinctness Invariants:** Test databases must be distinctly named (`fluxora_queue_test`, `fluxora_inc_migration_test`) and never match production or development databases (`fluxora_dev`).
3. **Explicit Destructive Opt-In:** Destructive tests (dropping databases or tables) require an explicit environment flag `FLUXORA_ALLOW_DESTRUCTIVE_QUEUE_MIGRATION_TESTS=true`.
4. **Independent Teardown:** Never use `if (orgA && orgB)` in teardown. Teardown should attempt to clean up each fixture independently using `try / catch` and aggregate errors.
