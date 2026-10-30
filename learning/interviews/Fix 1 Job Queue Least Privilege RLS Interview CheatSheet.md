# Fluxora Fix 1 — Job Queue Least-Privilege RLS Masterclass & Interview Guide

> **Target Audience:** Senior / Staff / Principal Engineers & System Architects<br>
> **Status:** Production Hardened (Migrations `0020`, `0021`)<br>
> **Applicability:** PostgreSQL RLS Multi-Tenancy, Least-Privilege Role Security, Distributed Worker Authorization

---

## 1. Executive Layman Analogy & 30-Second Elevator Pitch

### The Layman Analogy: The "Safe Deposit Box vs. Armored Car"
Imagine a bank where every customer has a safe deposit box (`Organization` tenant data).
* **Normal Customer Access (Tenant RLS):** A customer can only open their own deposit box with their specific key (`app.current_org_id`).
* **The Worker Problem (Global Queue):** Armored car guards (background workers) need to pick up sealed mail bags from all branches. The guards do not belong to any single customer.
* **The Historical Vulnerability:** If you give the guards master keys (`SUPERUSER` or `BYPASSRLS`), any compromised guard can peek inside every customer's deposit box. Conversely, if you don't give them a special protocol, bank security blocks them, and zero bags are delivered (queue stalls).
* **The Fix 1 Solution:** The bank creates a specialized, locked dispatch window (`fluxora_queue`). The guards have zero master keys (`NOLOGIN, NOBYPASSRLS, NOSUPERUSER`). They can only receive envelopes through the dispatch window, and they must present an active, non-expired dispatch badge (`locked_by` and `lease_expires_at`) before returning or rescheduling any parcel.

### 30-Second Senior Architectural Summary
> *"In a multi-tenant database using `FORCE ROW LEVEL SECURITY`, background workers must process jobs globally across organizations without holding broad tenant bypass privileges. Fix 1 resolves this by decoupling execution identity from database superusers: we introduced a dedicated `NOLOGIN`, `NOBYPASSRLS` function owner (`fluxora_queue`) with column-level table grants and role-specific permissive RLS policies. Queue functions execute with pinned search paths, revoked `PUBLIC` execute grants, and atomic worker authorization requiring matching identity and active lease timestamps on retry."*

---

## 2. Senior / Staff Engineer Interview Questions & Model Answers

### Q1: Why didn't `SECURITY DEFINER` allow workers to claim jobs across tenants automatically?
**Senior Answer:**
> *"In PostgreSQL, `SECURITY DEFINER` executes the function with the privileges of the function's **owner**, not as an automatic bypass of the system. If the table enforces `FORCE ROW LEVEL SECURITY` and the owner is a non-superuser, PostgreSQL evaluates RLS policies against the owner's session. Because the existing tenant policy checked `organization_id = fluxora_current_org_id()`, and a background worker has no tenant context set, `fluxora_current_org_id()` evaluated to `NULL`. Consequently, the query returned zero rows. `SECURITY DEFINER` only bypasses RLS if the owner either has `BYPASSRLS` or there is a specific RLS policy granting access to that owner."*

### Q2: Why not just grant `BYPASSRLS` or use `postgres` superuser for the worker role?
**Senior Answer:**
> *"Granting `BYPASSRLS` or superuser privileges completely violates the principle of least privilege. In a multi-tenant platform, repository code and pull request payloads are untrusted inputs. If a worker process were compromised (e.g., via a malicious compiler plugin or native dependency vulnerability), a database client with `BYPASSRLS` could read and exfiltrate source code, AST graphs, and secrets belonging to every tenant in the database. By using a `NOLOGIN` role with column-specific `UPDATE` grants on only the queue table, even a fully compromised worker connection cannot bypass tenant boundaries on any other table."*

### Q3: How do multiple permissive RLS policies interact in PostgreSQL?
**Senior Answer:**
> *"In PostgreSQL, multiple permissive policies for the same command (`SELECT`, `UPDATE`, etc.) are combined with logical `OR`. If Policy A evaluates to `false` and Policy B evaluates to `true`, the row is visible. We leverage this by creating `jobs_queue_select` and `jobs_queue_update` scoped strictly `TO fluxora_queue USING (true)`. For the queue owner, `(tenant_policy OR true)` evaluates to `true`. For any other role, `jobs_queue_*` does not apply, and only the strict tenant policy evaluates."*

### Q4: Why did we validate all 7 role attributes for `fluxora_queue` in Migration 0021?
**Senior Answer:**
> *"To prevent privilege creep and guarantee defense-in-depth across deployment environments. In PostgreSQL, role attributes like `SUPERUSER`, `BYPASSRLS`, `LOGIN`, `CREATEROLE`, `CREATEDB`, `INHERIT`, and `REPLICATION` could accidentally be granted during manual maintenance or cloud provisioning. Migration 0021 runs a defensive `DO $$` validation block asserting that all 7 attributes are strictly disabled (`NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOBYPASSRLS, NOINHERIT, NOREPLICATION`), aborting the migration if any elevated attribute exists."*

### Q5: What is a search path injection attack, and how is it mitigated?
**Senior Answer:**
> *"When a `SECURITY DEFINER` function executes, it runs with elevated authority. If `search_path` is not pinned, PostgreSQL searches schemas in the order of the caller's search path. A malicious user could create an object (e.g. `public.now()`) in a schema they control. When the privileged function calls `now()`, it executes the attacker's shadow function with owner privileges. We mitigate this by pinning `SET search_path = pg_catalog, public, pg_temp` on every queue function and qualifying catalog functions as `pg_catalog.now()`."*

### Q6: Why did we change `fluxora_retry_failed_job` from 2 arguments to 4 arguments?
**Senior Answer:**
> *"The historical signature `fluxora_retry_failed_job(p_job_id, p_retry_delay_seconds)` had zero authorization: any caller who knew or guessed a job UUID could force a retry, resetting running jobs leased by other workers or disrupting the queue. The hardened signature `fluxora_retry_failed_job(p_job_id, p_worker_id, p_retry_delay_seconds, p_error)` enforces atomic ownership:
> ```sql
> WHERE j.id = p_job_id
>   AND j.status = 'running'
>   AND j.locked_by = p_worker_id
>   AND j.lease_expires_at > pg_catalog.now()
> ```
> If another worker owns the lease, or if the caller's lease has expired, the update matches 0 rows and returns empty, preventing lease stealing and race conditions."*

### Q7: In Node.js, what is the risk of calling `RESET ROLE` in a connection pool, and how is connection tainting handled?
**Senior Answer:**
> *"If `withWorkerClient` executes `SET ROLE` to assume a specific role, it must execute `RESET ROLE` before returning the connection to the pool. If `RESET ROLE` fails (due to a database error, connection interruption, or transaction abort), returning that connection to the pool would leave a socket with a dirty, elevated role context for subsequent arbitrary queries.
> In `node-postgres`, calling `client.release(err)` with an error argument signals to the pool that the client is broken or tainted. Node-postgres closes the underlying TCP socket and discards the connection rather than returning it to the idle pool."*

### Q8: Why does `isPoolClient` need a custom predicate instead of `instanceof pg.PoolClient`?
**Senior Answer:**
> *"In `node-postgres`, `pg.PoolClient` is not exported as an instantiable public class prototype across all module formats, and `PoolClient` instances extend `pg.Client`, which includes a `.connect` method. Checking `!("connect" in obj)` mistakenly treats checked-out clients as connection pools and attempts to call `.connect()` on them again. `isPoolClient` checks:
> 1. Not an `instanceof pg.Pool`
> 2. Has a `release` method (`typeof obj.release === 'function'`)
> 3. Does not contain pool management counters (`!("totalCount" in obj)`)."*

### Q9: Why is pre-connection host validation necessary in integration tests?
**Senior Answer:**
> *"If an integration test utility connects to `process.env.DATABASE_URL` to inspect or clean up fixtures, a misconfigured CI environment or developer `.env` file could inadvertently point to a staging or production database. If the test connects before verifying the host, it may run destructive queries (`DROP DATABASE` or `TRUNCATE`) against a real server. `assertApprovedQueueTestHost` parses the database URL and strictly validates the hostname against `localhost`, `127.0.0.1`, `::1`, and `postgres` before any TCP connection or client creation occurs."*

---

## 3. Comparative Architecture: Before vs. After Fix 1

```
+-----------------------------------+-----------------------------------+-----------------------------------+
| DIMENSION                         | BEFORE FIX 1                      | AFTER FIX 1                       |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Queue Dispatch Under RLS          | Stalls on non-superuser roles;    | Global discovery enabled via      |
|                                   | returns 0 rows without tenant GUC | role-scoped `jobs_queue_*` policy |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Function Owner                    | Table owner / generic user        | Dedicated `fluxora_queue` role    |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Function Owner Privileges         | Unchecked; potential superuser    | All 7 attributes strictly `NO*`   |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Table Grants                      | Broad `ALL` on `public.jobs`      | `SELECT` + column-level `UPDATE`  |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Retry Authorization               | Insecure `(uuid, delay)`          | Atomic `(uuid, worker, delay, err)`|
|                                   | Any caller can reset any job      | Requires active lease & worker ID |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Function Execution ACL            | `PUBLIC` execute permitted        | Revoked from `PUBLIC`, granted to |
|                                   | by default in PostgreSQL          | specific migrator & worker roles  |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Pool Connection Hygiene           | Naive client release; connection  | Tainted socket destroyed on       |
|                                   | leak on invalid role format       | `RESET ROLE` failure (`release(e)`)|
+-----------------------------------+-----------------------------------+-----------------------------------+
| Test Harness Safety               | Tests ran against any URL;        | Host allowlist enforced before    |
|                                   | superuser masked RLS bugs         | TCP connect; non-superuser tests  |
+-----------------------------------+-----------------------------------+-----------------------------------+
```

---

## 4. Key SQL Patterns

### Atomic Retry & Dead-Letter Transition
```sql
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
```

### Temporary Role Membership for Non-Superuser Migrations
```sql
-- Migration runner needs authority to replace functions owned by fluxora_queue
GRANT fluxora_queue TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO fluxora_queue;

-- Drop and replace functions
DROP FUNCTION IF EXISTS public.fluxora_retry_failed_job(uuid, integer);
CREATE OR REPLACE FUNCTION public.fluxora_retry_failed_job(...) ...;
ALTER FUNCTION public.fluxora_retry_failed_job(...) OWNER TO fluxora_queue;

-- Clean up temporary authority before commit
REVOKE CREATE ON SCHEMA public FROM fluxora_queue;
REVOKE fluxora_queue FROM CURRENT_USER;
```

---

## 5. Architectural Traps & Red Flags

1. **Assuming `SECURITY DEFINER` Ignores RLS**:
   `SECURITY DEFINER` adopts the privileges of the owner. If the owner is not a superuser and does not possess an explicit bypass policy, `FORCE ROW LEVEL SECURITY` will evaluate and filter out rows.
2. **Testing as `postgres` Superuser**:
   Superusers automatically bypass RLS policies. Any test running as superuser is incapable of validating tenant isolation or worker claiming permissions.
3. **Omitting `SET search_path`**:
   Leaving search path unpinned in `SECURITY DEFINER` functions allows search path spoofing / privilege escalation.
4. **Returning Tainted Clients to Connection Pools**:
   Failing to handle errors during `RESET ROLE` can return a privileged or misconfigured client to the pool, contaminating unrelated requests.
5. **Connecting to Database URLs Before Validating Allowed Hosts**:
   Testing utilities that parse environment variables and immediately call `client.connect()` risk executing destructive DDL against unintended external environments.

---

## 6. Production Readiness Checklist

- [x] **Least-Privilege Role:** `fluxora_queue` has `NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOBYPASSRLS, NOINHERIT, NOREPLICATION`.
- [x] **Column-Level Privileges:** Table grants narrowed to `SELECT` and `UPDATE` on only mutable lifecycle columns.
- [x] **Tenant Separation:** `FORCE ROW LEVEL SECURITY` enabled on `public.jobs`; queue policies scoped strictly to `fluxora_queue`.
- [x] **Atomic Worker Retry:** `fluxora_retry_failed_job` requires matching `locked_by` and unexpired `lease_expires_at`.
- [x] **Execution ACLs:** `PUBLIC` execution revoked; explicit grants to migration and worker roles.
- [x] **Pinned Search Paths:** All queue functions pin `SET search_path = pg_catalog, public, pg_temp`.
- [x] **Pool Hygiene:** `withWorkerClient` evicts connections on reset errors; validates role syntax before connection checkout.
- [x] **Test Isolation:** Host allowlist validated before client connection; non-superuser integration tests run under `fluxora_migrator_test`.
