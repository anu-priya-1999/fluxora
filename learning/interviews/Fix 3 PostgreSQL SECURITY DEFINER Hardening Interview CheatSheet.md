# Fluxora Fix 3 — PostgreSQL SECURITY DEFINER Hardening Masterclass & Interview Guide

> **Target Audience:** Senior / Staff / Principal Engineers & System Architects<br>
> **Status:** Implementation and non-destructive verification completed; live destructive PostgreSQL integration verification pending.<br>
> **Related Documentation:** [Implementation Report](../implementations/production-hardening/fix-03-security-definer-hardening.md) | [Technical Notes](../notes/Fix-03-PostgreSQL-Security-Definer-Hardening.md) | [Regression Tests](../../packages/db/src/migrate/security-definer-hardening.test.ts) | [Migration 0025 Source](../../packages/db/migrations/0025_security_definer_hardening.sql)<br>
> **Applicability:** PostgreSQL Security, `SECURITY DEFINER` Privileges, Least-Privilege Role Governance, PostgreSQL 16+ `CREATEROLE` `ADMIN OPTION`, Advisory Lock Locality, Driver-Level Connection String Defense

---

## 1. Executive Layman Analogy, 30-Second Pitch & Two-Minute Technical Walkthrough

### The Layman Analogy: The "Diplomatic Pouch & The Embassy Vault"
Imagine an embassy where junior consular officers (API servers / background workers) need to process visa requests:
* **The Vulnerable Setup:** The ambassador gives the junior officers a universal master key (`SUPERUSER` or migration runner ownership) or leaves the vault open to everyone (`PUBLIC EXECUTE`). Any officer can walk into the classified archives, read secret cables, or modify files. Furthermore, if the ambassador tells a messenger to retrieve a document without specifying the exact room (`unqualified table names` and unpinned `search_path`), an adversary can place a decoy folder in the hallway (`pg_temp` temporary table) that the messenger mistakenly signs and executes.
* **The Fix 3 Hardened Architecture:**
  1. **Dedicated Courier (`fluxora_auth` / `fluxora_tenant_guard`):** The embassy creates a specialized, locked dispatch role. The role can only enter the visa archive (`public.oauth_login_states`, `public.refresh_sessions`), strictly read/write permitted records, and cannot leave the building (`NOLOGIN, NOSUPERUSER, NOBYPASSRLS`).
  2. **The Sealed Pouch (`SECURITY DEFINER` + Pinned `search_path`):** The messenger only accepts orders addressed to exact coordinates (`public.<table>`), checking the official safe first (`pg_catalog`) and ignoring hallway decoys (`pg_temp` last).
  3. **No Master Key Duplication (PG16+ `ADMIN FALSE`):** The temporary locksmith who builds the lock cannot give themselves the right to duplicate keys for others (`ADMIN OPTION = false`).

### 30-Second Senior Architectural Summary
> *"In PostgreSQL, `SECURITY DEFINER` functions execute with the privileges of their owner. Left unhardened, they allow privilege escalation via search-path shadowing (CVE-2018-1058), public execution, and superuser ownership. Fix 3 audited all 20 `SECURITY DEFINER` functions across Fluxora, established dedicated least-privilege `NOLOGIN` service roles (`fluxora_auth`, `fluxora_tenant_guard`), pinned safe search paths (`pg_catalog, public, pg_temp`), fully schema-qualified all queries, and revoked `PUBLIC` execute grants. For deployment and testing, Fix 3 addressed PostgreSQL 16+ `CREATEROLE` `ADMIN OPTION` escalation, enforced database-local advisory lock serialization via a canonical lock database, and eliminated connection-string parsing divergences by validating driver-effective configs."*

### Two-Minute Technical Walkthrough
1. **The Vulnerability Vector:**
   In PostgreSQL, functions default to `SECURITY INVOKER`, running with the caller's privileges. When elevated privileges are needed without granting broad table access, `SECURITY DEFINER` is used. However, `SECURITY DEFINER` executes under the function owner's security identity. If the owner is a superuser or migrator, and if `search_path` is unpinned or omits `pg_temp` from a trailing position, an unprivileged user can create a temporary object in `pg_temp` that shadows system or application tables (CVE-2018-1058), capturing credentials or executing arbitrary code. Moreover, functions default to granting `EXECUTE` to `PUBLIC`.
2. **The Schema Hardening (Migration 0025):**
   Fluxora inventoried all 20 `SECURITY DEFINER` functions across migrations `0001` through `0024`. Eight functions (bootstrap and queue) had been pre-hardened in Fix 1 and Fix 2. Migration 0025 hardened the remaining 12 functions (6 auth functions, 6 tenant validation helpers). We created two dedicated `NOLOGIN` service roles: `fluxora_auth` (owns auth/session routines) and `fluxora_tenant_guard` (owns tenant validation helpers). We pinned `search_path = pg_catalog, public, pg_temp`, fully qualified every relation (`public.oauth_login_states`), revoked `PUBLIC` execution, and revoked `CREATE ON SCHEMA public FROM PUBLIC`.
3. **The PostgreSQL 16+ Role Governance Model:**
   In PostgreSQL 16+, role membership management splits into `ADMIN OPTION`, `INHERIT OPTION`, and `SET OPTION`. When a non-superuser role creates another role via `CREATEROLE`, PostgreSQL automatically grants `ADMIN OPTION` to the creator, which the creator cannot self-revoke. To prevent the migration runner from permanently administering service roles, service roles must be pre-provisioned by a cluster superuser, and the migration runner is granted only temporary `WITH SET TRUE, INHERIT FALSE, ADMIN FALSE` membership for function ownership transfer.
4. **Advisory Lock Locality & Concurrency Defense:**
   PostgreSQL advisory locks are database-local, partitioned by database OID. Parallel CI test workers targeting different disposable test databases cannot serialize cluster-level role mutations using database-local locks. Fix 3 mandates an explicit canonical lock database (`FLUXORA_CLUSTER_LOCK_DATABASE_URL`, e.g. `postgres`), serialized via `pg_advisory_lock`, with preflight host/port endpoint validation.
5. **Driver Connection String Parser Discrepancies:**
   Standard JavaScript `new URL()` validation diverges from `node-postgres`'s parser (`pg-connection-string`). Percent-encoded pathnames (e.g. `/fluxora%5Fdev`) and query parameter overrides (`?host=`, `?dbname=`) bypass naive string checks. Fix 3 resolves `pg-connection-string` directly from the installed `pg` dependency via `createRequire`, strictly validates decimal ports, rejects `fluxora_dev` and `*_dev`, and freezes branded `ValidatedPostgresConfig` objects.
6. **Operational Status:**
   Implementation and non-destructive verification completed (32 passed in the Fix 3 suite, full workspace typecheck, lint, and evidence checks passing); live destructive PostgreSQL integration verification (5 tests) remains pending dedicated disposable test database execution.

---

## 2. Architectural Diagrams

### Role Privilege Boundaries & Function Ownership

```mermaid
flowchart TD
    subgraph ClusterRoles["PostgreSQL Cluster Roles (NOLOGIN, Least-Privilege)"]
        AUTH["fluxora_auth\n(Auth & Session Owner)"]
        TG["fluxora_tenant_guard\n(Tenant RLS Helper Owner)"]
        QUEUE["fluxora_queue\n(Job Queue Owner - Fix 1/2)"]
        BOOT["fluxora_bootstrap\n(Bootstrap Owner - Fix 1)"]
    end

    subgraph RuntimeIdentities["Application Runtime Connections (LOGIN)"]
        APP["fluxora_app\n(API Server)"]
        WORKER["fluxora_worker\n(Background Workers)"]
    end

    subgraph SchemaPublic["Schema public (Protected by FORCE RLS)"]
        T_AUTH["Auth Tables:\noauth_login_states\nrefresh_sessions\nusers"]
        T_DATA["Tenant Tables:\nrepositories, snapshots, runs,\npull_requests, impact, scenarios, sims"]
        T_QUEUE["Queue Tables:\njobs"]
    end

    APP -->|"EXECUTE (Auth + Tenant Helpers)"| AUTH
    APP -->|"EXECUTE"| TG
    WORKER -->|"EXECUTE (Tenant Helpers Only)"| TG
    WORKER -.->|"EXECUTION DENIED"| AUTH

    AUTH -->|"SELECT, INSERT, DELETE (Auth Tables Only)"| T_AUTH
    TG -->|"SELECT Only (Tenant Tables)"| T_DATA
    QUEUE -->|"SELECT, UPDATE (Jobs Only)"| T_QUEUE

    classDef role fill:#e8f0fe,stroke:#1a73e8,stroke-width:2px;
    classDef runtime fill:#fef7e0,stroke:#f9ab00,stroke-width:2px;
    classDef table fill:#e6f4ea,stroke:#137333,stroke-width:2px;
    class AUTH,TG,QUEUE,BOOT role;
    class APP,WORKER runtime;
    class T_AUTH,T_DATA,T_QUEUE table;
```

### Advisory Lock Locality: Disposable Databases vs Canonical Lock DB

```
+-----------------------------------------------------------------------------------+
|                        ADVISORY LOCK LOCALITY COMPARISON                          |
+----------------------------------------------------+------------------------------+
| Naive / Vulnerable Multi-DB Architecture           | Fluxora Canonical Lock Architecture (Safe) |
+----------------------------------------------------+------------------------------+
| Worker 1 (DB: fluxora_test_w1):                    | Worker 1:                    |
|   pg_advisory_lock(KEY) -> Acquired on DB 1        |   Connects to canonical "postgres" DB |
|                                                    |   pg_advisory_lock(KEY) -> Acquired |
| Worker 2 (DB: fluxora_test_w2):                    | Worker 2:                    |
|   pg_advisory_lock(KEY) -> Acquired on DB 2        |   Connects to canonical "postgres" DB |
|                                                    |   pg_advisory_lock(KEY) -> BLOCKED! |
| RESULT: Concurrent execution! Both modify shared   | RESULT: Strict serialization across |
| cluster roles -> Corrupted roles & race conditions!| all parallel workers and databases! |
+----------------------------------------------------+------------------------------+
```

---

## 3. Thirty Staff-Level Interview Questions & Model Answers

### Subject 1: SECURITY DEFINER vs SECURITY INVOKER Fundamentals
#### Q1: What is the fundamental difference between `SECURITY INVOKER` and `SECURITY DEFINER` in PostgreSQL, and when must each be used?
**Staff Answer:**
> *"By default, PostgreSQL functions execute as `SECURITY INVOKER`, meaning the function body runs under the privileges and role identity of the active session caller. The caller must have direct table-level permissions (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) on all queried tables.
> In contrast, a function defined with `SECURITY DEFINER` executes with the privileges and role identity of the **owner** of the function (`proowner` in `pg_proc`). The caller only requires `EXECUTE` privilege on the function itself.
> We use `SECURITY DEFINER` when an unprivileged client (e.g. an API server handling an unauthenticated OAuth callback or a worker claiming jobs) needs to perform a tightly scoped, security-sensitive operation without granting the client direct table permissions. For all routine application logic, `SECURITY INVOKER` is mandatory to enforce caller-level access controls."*
>
> **Difficult Follow-Up:** *If a `SECURITY DEFINER` function calls a `SECURITY INVOKER` function, under whose privileges does the second function execute?*<br>
> **Answer:** *It executes under the privileges of the owner of the calling `SECURITY DEFINER` function, because the active security context was switched when entering the `SECURITY DEFINER` routine. The entire call stack remains elevated until the `SECURITY DEFINER` function returns.*

---

### Subject 2: Search-Path Shadowing & CVE-2018-1058 Mechanics
#### Q2: How does search-path shadowing (CVE-2018-1058) work, and how does an attacker exploit it?
**Staff Answer:**
> *"When PostgreSQL resolves unqualified identifiers (such as `SELECT * FROM refresh_sessions` or calling a function like `now()`), it traverses the schemas listed in the session's `search_path` in order.
> In CVE-2018-1058, if an unprivileged user has `CREATE` permission on any schema in `search_path` (historically `public`), or if temporary schemas (`pg_temp`) take precedence, the attacker can create a shadow object (a table, view, function, or custom operator) with the exact same name as an object referenced inside a `SECURITY DEFINER` function.
> When a privileged user or service role invokes the `SECURITY DEFINER` function, PostgreSQL resolves the attacker's shadow object first. If the attacker shadowed an operator (like `=` or `+`) or a function, the attacker's arbitrary PL/pgSQL code executes under the function owner's elevated privileges, enabling complete database takeover."*
>
> **Difficult Follow-Up:** *Can search-path shadowing occur even if all tables are schema-qualified?*<br>
> **Answer:** *Yes! If operators (e.g. `WHERE a = b`) or system functions (e.g. `now()`) are unqualified and `search_path` is unpinned, an attacker can define a custom operator with matching operand types in a schema preceding `pg_catalog` in `search_path`, hijacking execution despite qualified tables.*

---

### Subject 3: Temporary Schema (`pg_temp`) Resolution Rules
#### Q3: Why does omitting `pg_temp` from `search_path` make a `SECURITY DEFINER` function vulnerable, and why must `pg_temp` be placed explicitly last?
**Staff Answer:**
> *"Under PostgreSQL resolution rules, every session has a private temporary schema (`pg_temp_nn`). Crucially, if `pg_temp` is **not** explicitly listed anywhere in `search_path`, PostgreSQL automatically searches `pg_temp` **first** for relation lookups (tables and views).
> If a developer sets `SET search_path = pg_catalog, public`, omitting `pg_temp`, PostgreSQL interprets this as: check `pg_temp` first, then `pg_catalog`, then `public`! An attacker can execute `CREATE TEMP TABLE refresh_sessions (...)`, and any subsequent query against `refresh_sessions` inside the function hits the temporary table.
> To prevent this, PostgreSQL requires explicitly placing `pg_temp` as the **last** entry: `SET search_path = pg_catalog, public, pg_temp`. When `pg_temp` is explicitly listed, PostgreSQL honors its position in the list, searching `pg_catalog` and `public` before `pg_temp`."*
>
> **Difficult Follow-Up:** *Why not set `search_path` to omit `pg_temp` entirely and somehow disable temporary tables?*<br>
> **Answer:** *PostgreSQL does not allow disabling `pg_temp` in a session; if omitted, it defaults to implicit first position. Setting `search_path = ''` (empty string) forces every reference to be schema-qualified, but built-in operators still require schema resolution unless qualified with `OPERATOR(pg_catalog.=)`. Thus, `pg_catalog, public, pg_temp` is the canonical standard recommended by the PostgreSQL Global Development Group.*

---

### Subject 4: `pg_catalog` Leading Position & Operator Hijacking
#### Q4: Why must `pg_catalog` always be the first schema in a pinned `search_path`?
**Staff Answer:**
> *"The system catalog schema `pg_catalog` contains all built-in types, functions (`now()`, `coalesce()`, `char_length()`), and standard operators (`=`, `+`, `<>`).
> If `search_path` placed `public` before `pg_catalog` (`SET search_path = public, pg_catalog, pg_temp`), a malicious user who created a function `public.now()` or a custom operator `public.=` would intercept all system function and operator calls executed by the `SECURITY DEFINER` routine.
> Placing `pg_catalog` first ensures that built-in system routines and operators are always resolved directly from PostgreSQL's immutable internal catalog, completely immune to shadow functions."*
>
> **Difficult Follow-Up:** *Can an attacker create objects directly inside `pg_catalog`?*<br>
> **Answer:** *No. Only a cluster superuser can write to `pg_catalog`. Non-superusers and application service roles are strictly denied `CREATE` on `pg_catalog`.*

---

### Subject 5: Mandatory Full Schema Qualification
#### Q5: If `search_path` is already pinned to `pg_catalog, public, pg_temp`, why does Fluxora still mandate full schema qualification (`public.table_name`)?
**Staff Answer:**
> *"Defense in depth. Pinning `search_path` at the function level protects runtime execution, but full qualification provides two vital guarantees:
> 1. **Parser Ambiguity Prevention:** It guarantees that even if a developer alters the function header or if the function is inlined or called across different schema contexts, the query unambiguously resolves to the intended relation.
> 2. **Static AST Analysis & Linting:** In Fluxora's CI pipeline, static analyzers and `pnpm lint:evidence` verify schema qualification across migrations. Explicit schema qualification eliminates any reliance on runtime search path state for table identification."*
>
> **Difficult Follow-Up:** *Does schema qualification protect against custom operator shadowing?*<br>
> **Answer:** *No. Qualifying a table as `public.refresh_sessions` qualifies the relation, but operators within SQL clauses (`WHERE id = p_id`) cannot be table-qualified. That is why BOTH `pg_catalog` leading in `search_path` AND schema-qualified relations are strictly required together.*

---

### Subject 6: Revocation of `CREATE` on Schema `public`
#### Q6: Why did Migration 0025 execute `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`, and why was this historically a major security hole in PostgreSQL?
**Staff Answer:**
> *"Prior to PostgreSQL 15, the default database template (`template1`) granted `CREATE` and `USAGE` on schema `public` to the pseudo-role `PUBLIC` (all database users). This meant any authenticated database user could create tables, views, functions, and operators directly in `public`.
> This was the root facilitator of CVE-2018-1058: an attacker with low privileges could plant shadow objects in `public` that would be executed by other users.
> While PostgreSQL 15 removed this default for new databases, upgraded clusters or databases created from older templates retain the grant. Fluxora Migration 0025 explicitly executes `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` to guarantee that no unprivileged user can ever create objects in the shared application schema."*
>
> **Difficult Follow-Up:** *What permission does a standard application role like `fluxora_app` need on schema `public` once `CREATE` is revoked?*<br>
> **Answer:** *`fluxora_app` only needs `USAGE ON SCHEMA public`, which allows it to look up and access existing objects (tables, functions) that it has been granted permissions on, without granting the ability to create new objects.*

---

### Subject 7: Default `PUBLIC` Execution Privilege & Explicit Revocation
#### Q7: Why do newly created PostgreSQL functions grant `EXECUTE` to `PUBLIC` by default, and how does Fluxora remediate this?
**Staff Answer:**
> *"In PostgreSQL's default privilege model, any new function created via `CREATE FUNCTION` automatically grants `EXECUTE` privilege to the pseudo-role `PUBLIC`, unless altered by `DEFAULT PRIVILEGES`.
> For a `SECURITY DEFINER` function, this is catastrophic: an unauthenticated or read-only connection can invoke the function and perform actions under the function owner's elevated identity.
> Fluxora remediates this by immediately pairing every `CREATE OR REPLACE FUNCTION` in Migration 0025 with an explicit revocation:
> ```sql
> REVOKE ALL ON FUNCTION public.fluxora_store_oauth_login_state(text, text, timestamptz) FROM PUBLIC;
> GRANT EXECUTE ON FUNCTION public.fluxora_store_oauth_login_state(text, text, timestamptz) TO fluxora_app;
> ```
> This guarantees that only authorized runtime roles (`fluxora_app` for auth, `fluxora_app`/`fluxora_worker` for tenant helpers) can call the routine."*
>
> **Difficult Follow-Up:** *Why did we not just use `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`?*<br>
> **Answer:** *`ALTER DEFAULT PRIVILEGES` only applies to objects created in the future by the specific role executing the command. It does not alter existing functions or functions created by other roles. Explicit per-function `REVOKE ALL ... FROM PUBLIC;` is deterministic, auditable, and idempotent across all migrations.*

---

### Subject 8: Function Ownership (`proowner`) vs Table Ownership (`relowner`)
#### Q8: Why must function ownership and table ownership be strictly separated in a least-privilege relational database?
**Staff Answer:**
> *"Table ownership (`relowner`) grants schema modification authority: altering columns, adding/dropping constraints, truncating data, and defining Row-Level Security (`CREATE POLICY`, `FORCE ROW LEVEL SECURITY`). Table owners also bypass RLS by default.
> Function ownership (`proowner`) defines the execution context when `SECURITY DEFINER` is invoked.
> If our service role `fluxora_auth` owned the `public.refresh_sessions` table, anyone assuming `fluxora_auth` or exploiting a flaw in an auth function could drop constraints, disable RLS, or alter table schemas.
> By keeping table ownership with `fluxora_migrator` and granting `fluxora_auth` only specific DML permissions (`SELECT, INSERT, UPDATE`), `fluxora_auth` can execute its business logic but is physically incapable of altering the relational schema or dismantling security policies."*
>
> **Difficult Follow-Up:** *Can a non-owner of a table create an RLS policy on that table?*<br>
> **Answer:** *No. In PostgreSQL, `CREATE POLICY` and `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` are restricted strictly to the table owner or a superuser.*

---

### Subject 9: `FORCE ROW LEVEL SECURITY` Interaction with `SECURITY DEFINER`
#### Q9: In Fluxora Fix 1, we proved that `SECURITY DEFINER` does not bypass Row-Level Security for non-superusers. How does this affect function ownership and policy design?
**Staff Answer:**
> *"A frequent architectural misconception is that `SECURITY DEFINER` functions automatically bypass RLS. In PostgreSQL, they only bypass RLS if the function owner is a `SUPERUSER` or holds `BYPASSRLS`.
> When tables have `FORCE ROW LEVEL SECURITY` applied (as all Fluxora multi-tenant tables do), even the table owner is subject to RLS policies unless they possess `BYPASSRLS`.
> Because our service roles (`fluxora_auth`, `fluxora_tenant_guard`) are non-superusers and strictly have `NOBYPASSRLS`, any query executed inside a `SECURITY DEFINER` function is evaluated against the RLS policies applicable to that service role.
> Therefore, Migration 0025 explicitly provisions scoped permissive policies for service roles:
> ```sql
> CREATE POLICY refresh_sessions_auth_all ON public.refresh_sessions
>   FOR ALL TO fluxora_auth USING (true) WITH CHECK (true);
> ```
> Without this policy, `fluxora_auth` would see zero rows upon querying `refresh_sessions`!"*
>
> **Difficult Follow-Up:** *Why use `USING (true)` for `fluxora_auth` on `refresh_sessions` instead of tenant isolation?*<br>
> **Answer:** *Because refresh token rotation and OAuth state consumption occur at the boundary before a tenant context is established. The function itself enforces cryptographic hash lookup and user identity verification. The service role is granted table access solely through the function.*

---

### Subject 10: Dedicated Least-Privilege Service Roles: `fluxora_auth` vs `fluxora_tenant_guard`
#### Q10: Why did Fix 3 create two distinct service roles (`fluxora_auth` and `fluxora_tenant_guard`) instead of a single shared service role?
**Staff Answer:**
> *"Separation of duties and least privilege.
> 1. **`fluxora_auth`**: Owns 6 authentication and session functions. Requires write access (`INSERT, UPDATE, DELETE`) to authentication tables (`oauth_login_states`, `refresh_sessions`), but has ZERO access to tenant data (repositories, graph nodes, pull requests, simulations).
> 2. **`fluxora_tenant_guard`**: Owns 6 cross-table tenant validation helper functions (e.g. `fluxora_snapshot_in_current_tenant`). Requires read-only `SELECT` access to parent tenant tables, but has ZERO write access to any table, and ZERO access to auth tables.
> If these roles were merged, an injection in a tenant helper function could be leveraged to read or manipulate OAuth states and refresh tokens. Decoupling them limits the blast radius of any potential function vulnerability."*
>
> **Difficult Follow-Up:** *Which application roles can execute functions owned by each service role?*<br>
> **Answer:** *`fluxora_app` (API server) is granted `EXECUTE` on both `fluxora_auth` and `fluxora_tenant_guard` functions. `fluxora_worker` (background worker) is granted `EXECUTE` strictly on `fluxora_tenant_guard` functions, with zero execution rights on `fluxora_auth`.*

---

### Subject 11: The Seven Role Security Attributes
#### Q11: What are the seven critical role security attributes in PostgreSQL, and how are they configured for Fluxora service roles?
**Staff Answer:**
> *"Stored in `pg_catalog.pg_roles`, the seven attributes are:
> 1. `rolcanlogin` (`NOLOGIN`): Prevents initiating a direct database connection. Service roles can only be assumed via `SECURITY DEFINER` or `SET ROLE`.
> 2. `rolsuper` (`NOSUPERUSER`): Prevents bypassing access controls.
> 3. `rolcreaterole` (`NOCREATEROLE`): Prevents creating, altering, or dropping roles.
> 4. `rolcreatedb` (`NOCREATEDB`): Prevents creating or dropping databases.
> 5. `rolbypassrls` (`NOBYPASSRLS`): Ensures the role cannot bypass Row-Level Security.
> 6. `rolinherit` (`NOINHERIT`): Prevents ambient inheritance of permissions across role grants.
> 7. `rolreplication` (`NOREPLICATION`): Prevents initiating streaming replication or logical replication slots.
> In Fluxora, `fluxora_auth`, `fluxora_tenant_guard`, `fluxora_queue`, and `fluxora_bootstrap` are all verified via assertion blocks in migrations to ensure all seven flags are strictly disabled."*
>
> **Difficult Follow-Up:** *Why is `NOINHERIT` so important for service roles?*<br>
> **Answer:** *If a service role had `INHERIT TRUE`, any member role granted the service role would automatically wield all of its permissions in standard SQL queries without executing `SET ROLE`, destroying the privilege separation boundary.*

---

### Subject 12: PostgreSQL 16+ Role Membership Model (`ADMIN`, `INHERIT`, `SET`)
#### Q12: How did PostgreSQL 16 redesign role membership, and what do the `ADMIN`, `INHERIT`, and `SET` options control?
**Staff Answer:**
> *"Prior to PostgreSQL 16, `GRANT target_role TO member_role` conferred coupled rights. PostgreSQL 16 restructured `pg_catalog.pg_auth_members` into three orthogonal boolean attributes:
> 1. **`ADMIN OPTION` (Grant Authority):** Controls whether `member_role` can grant or revoke `target_role` to/from other users.
> 2. **`INHERIT OPTION` (Ambient Privileges):** Controls whether `member_role` automatically inherits the permissions of `target_role` during standard query execution.
> 3. **`SET OPTION` (Identity Switching):** Controls whether `member_role` can execute `SET ROLE target_role` to assume its identity.
> This allows fine-grained role assignment: granting `WITH SET TRUE, INHERIT FALSE, ADMIN FALSE` gives the member the ability to switch identity for specific maintenance operations without ambient privilege creep and without grant delegation authority."*
>
> **Difficult Follow-Up:** *What is the default value of these three options if unspecified in a `GRANT role TO user` command in PostgreSQL 16?*<br>
> **Answer:** *The defaults in PostgreSQL 16 are `WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`.*

---

### Subject 13: The PostgreSQL 16+ `CREATEROLE` `ADMIN OPTION` Trap
#### Q13: What is the `CREATEROLE` `ADMIN OPTION` trap in PostgreSQL 16+, and why is it a critical privilege escalation vector?
**Staff Answer:**
> *"In PostgreSQL 16+, role creation was hardened so non-superusers with `CREATEROLE` only administer roles they created.
> However, the kernel enforces this by automatically inserting a row into `pg_auth_members` granting the creator `ADMIN OPTION` on the created role (with `INHERIT FALSE, SET FALSE`).
> The critical trap is: **in PostgreSQL, a non-superuser cannot revoke `ADMIN OPTION` from itself!**
> If a non-superuser migration runner executes `CREATE ROLE fluxora_auth`, the migration runner permanently retains `ADMIN OPTION` on `fluxora_auth`. If that migration credential is later compromised, an attacker can grant `fluxora_auth` to any database user.
> Therefore, non-superuser migration scripts must **never** dynamically execute `CREATE ROLE` for privileged service roles."*
>
> **Difficult Follow-Up:** *Why can't the creator role execute `REVOKE ADMIN OPTION FOR fluxora_auth FROM CURRENT_USER;`?*<br>
> **Answer:** *PostgreSQL kernel privilege rules prevent a role from revoking privileges from itself when it is the sole grantor, returning `ERROR: permission denied to grant role` or failing because non-superusers cannot alter self-granted admin rights.*

---

### Subject 14: Pre-Provisioned Service Roles Architecture
#### Q14: How does Fluxora solve the PostgreSQL 16+ `CREATEROLE` trap in production?
**Staff Answer:**
> *"By mandating the **Pre-Provisioned Service Roles Pattern**:
> 1. A cluster administrator (superuser or provisioning automation) pre-provisions `fluxora_auth` and `fluxora_tenant_guard` before running migrations.
> 2. The administrator grants the migration runner temporary membership with:
>    ```sql
>    GRANT fluxora_auth, fluxora_tenant_guard TO fluxora_migrator
>      WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;
>    ```
> 3. Because the grant comes from the administrator with `ADMIN FALSE`, `fluxora_migrator` never acquires `ADMIN OPTION`.
> 4. `fluxora_migrator` uses its `SET TRUE` membership solely to execute `ALTER FUNCTION ... OWNER TO fluxora_auth`.
> 5. Post-migration, the administrator revokes the membership, leaving `fluxora_migrator` with zero residual association with the service roles."*
>
> **Difficult Follow-Up:** *What happens if Migration 0025 is run in an environment where the service roles were NOT pre-provisioned?*<br>
> **Answer:** *Migration 0025 executes an inline `DO $$ ... $$` preflight block that queries `pg_catalog.pg_roles`. If the roles are missing or possess unsafe attributes (e.g. `rolcanlogin = true`), it raises an explicit exception: `Existing service role has unsafe attributes; expected NOLOGIN and no elevated privileges`."*

---

### Subject 15: Temporary Membership Lifecycle & Post-Migration Revocation
#### Q15: Why can't Migration 0025 revoke the migration runner's temporary membership in `fluxora_auth` at the end of the migration script?
**Staff Answer:**
> *"Under PostgreSQL privilege semantics, revoking role membership requires that the revoking role possesses `ADMIN OPTION` on the target role or is a superuser.
> Because `fluxora_migrator` was correctly granted membership with `ADMIN FALSE`, it lacks the authority to modify role grants—including its own!
> If Migration 0025 attempted to execute `REVOKE fluxora_auth FROM CURRENT_USER;`, PostgreSQL would reject the statement with `ERROR: permission denied to grant role`.
> Therefore, revocation must be handled externally by the cluster administrator or deployment pipeline as an automated post-migration step (executed on both success and failure)."*
>
> **Difficult Follow-Up:** *What is the risk if the post-migration revocation step fails or is omitted?*<br>
> **Answer:** *`fluxora_migrator` retains `SET TRUE` on `fluxora_auth`. While it cannot grant `fluxora_auth` to others (`ADMIN FALSE`) or inherit its permissions ambiently (`INHERIT FALSE`), anyone with access to `fluxora_migrator` could execute `SET ROLE fluxora_auth` to manipulate auth tables. Revocation restores absolute least privilege.*

---

### Subject 16: Schema Ownership Transfer Prerequisites (`AlterSchemaOwner`)
#### Q16: In PostgreSQL's source code, what kernel prerequisite does `ALTER SCHEMA public OWNER TO ...` enforce, and how did Fix 3 solve it?
**Staff Answer:**
> *"In PostgreSQL's backend source (`src/backend/commands/schemacmds.c:AlterSchemaOwner`), the kernel checks whether the proposed new schema owner holds `ACL_CREATE` on the parent database (`ERROR: permission denied for database <db>`).
> If `fluxora_migrator` does not hold `CREATE` on the database, the command fails.
> However, granting permanent `CREATE` on the database violates least privilege (it would allow the migrator to create arbitrary new schemas).
> **Fix 3 Solution:** The cluster administrator executes a temporary 3-statement dance:
> ```sql
> GRANT CONNECT, CREATE ON DATABASE fluxora_prod TO fluxora_migrator;
> ALTER SCHEMA public OWNER TO fluxora_migrator;
> REVOKE CREATE ON DATABASE fluxora_prod FROM fluxora_migrator;
> ```
> This satisfies the kernel check during the transfer and immediately strips database-level `CREATE`, leaving the migrator owning `schema public` without the right to create new schemas."*
>
> **Difficult Follow-Up:** *Why doesn't `fluxora_auth` need schema ownership to own functions inside `public`?*<br>
> **Answer:** *Object ownership in PostgreSQL is independent of schema ownership. To own a function in `public`, a role only needs `USAGE` (and temporary `CREATE` during function definition/reassignment) on the schema. Schema ownership remains with `fluxora_migrator`.*

---

### Subject 17: Schema Ownership vs `CREATE WITH GRANT OPTION`
#### Q17: Why does `REVOKE CREATE ON SCHEMA public FROM PUBLIC` require schema ownership rather than just holding `CREATE ... WITH GRANT OPTION`?
**Staff Answer:**
> *"Under PostgreSQL access control semantics, a privilege can only be revoked by:
> 1. The owner of the object,
> 2. A superuser, or
> 3. The grantor who originally issued the grant.
> The default grant of `CREATE` on schema `public` to `PUBLIC` was created during database initialization by the system bootstrap superuser.
> Even if a role holds `CREATE ON SCHEMA public WITH GRANT OPTION`, it can only revoke grants that *it* personally issued. It has zero authority to revoke system grants or grants issued by other users.
> Therefore, for the migration runner to successfully execute `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`, it must be the **owner of schema public**."*
>
> **Difficult Follow-Up:** *What error does PostgreSQL return if a non-owner attempts to revoke a grant they did not issue?*<br>
> **Answer:** *PostgreSQL issues a `WARNING: no privileges were revoked for "public"` and leaves the ACL completely unchanged, creating a silent security failure if not properly guarded!*

---

### Subject 18: PostgreSQL Advisory Locks Database Locality Trap
#### Q18: Why are PostgreSQL advisory locks (`pg_advisory_lock`) database-local, and what concurrency failure does this cause in test suites?
**Staff Answer:**
> *"In PostgreSQL, advisory locks are stored in the server's shared memory (`LockMethod`), but their lock tag includes the **database OID** (`locktag_field1 = MyDatabaseId`).
> Consequently, an advisory lock acquired on Database A provides **zero mutual exclusion** against an advisory lock acquired with the exact same 64-bit key on Database B on the exact same PostgreSQL cluster!
> In test environments where each worker runs tests against an isolated disposable database (`fluxora_test_worker1`, `fluxora_test_worker2`), a naive advisory lock acquired within the test database fails to serialize workers when they manipulate cluster-level objects like roles or passwords. Both workers acquire the lock simultaneously and corrupt cluster state."*
>
> **Difficult Follow-Up:** *Is there any cluster-global variant of advisory locks in standard PostgreSQL?*<br>
> **Answer:** *No. All standard `pg_advisory_lock` variants in PostgreSQL partition by database OID. True cluster-wide synchronization requires all connections to explicitly target the same database.*

---

### Subject 19: Cross-Worker Concurrency Races in Multi-Database Testing
#### Q19: Describe the exact race condition that occurs when parallel Vitest/Jest workers execute cluster-role migrations concurrently across disposable databases.
**Staff Answer:**
> *"Assume two parallel test workers, W1 and W2.
> - W1 creates disposable database `fluxora_test_w1`.
> - W2 creates disposable database `fluxora_test_w2`.
> - W1 acquires advisory lock `KEY` on `fluxora_test_w1`.
> - W2 acquires advisory lock `KEY` on `fluxora_test_w2`. Because database OIDs differ, both acquire the lock!
> - W1 creates service role `fluxora_auth` and grants temporary membership to `fluxora_mig_w1`.
> - Concurrently, W2 attempts `CREATE ROLE fluxora_auth` -> fails with `role already exists`.
> - Or W1 alters role passwords or drops roles in teardown while W2 is midway through migration 0025.
> - Tests fail nondeterministically with deadlocks, role collision errors, or foreign-key/permission violations."*
>
> **Difficult Follow-Up:** *Why not just run the test suite serially with `--no-threads`?*<br>
> **Answer:** *Serializing the entire test suite degrades CI performance and developer feedback loops. Furthermore, running multi-worker tests proves that the concurrency and locking architecture is robust enough for distributed production deployments.*

---

### Subject 20: Canonical Lock Database Architecture
#### Q20: How does Fluxora's Canonical Lock Database architecture (`FLUXORA_CLUSTER_LOCK_DATABASE_URL`) solve cross-worker concurrency?
**Staff Answer:**
> *"Fix 3C introduced an explicit separation between the **lock endpoint** and the **workload endpoint**:
> 1. All test runners configure `FLUXORA_CLUSTER_LOCK_DATABASE_URL` pointing to a shared canonical maintenance database (typically `postgres`).
> 2. Before creating or touching any disposable test database, each worker opens a dedicated `lockClient` targeting `FLUXORA_CLUSTER_LOCK_DATABASE_URL`.
> 3. The worker acquires `pg_advisory_lock(FLUXORA_CLUSTER_LOCK_KEY)` on `lockClient`.
> 4. Because all workers lock within the **same canonical database**, PostgreSQL serializes them globally across the cluster.
> 5. The worker executes disposable database creation, migration 0025, and teardown, then releases the lock on `lockClient` in an outer `finally` block."*
>
> **Difficult Follow-Up:** *Why use a separate client (`lockClient`) rather than using the main admin client?*<br>
> **Answer:** *If the main admin client is switched to a disposable database (`\c disposable_db`), the advisory lock held on `postgres` is lost. A dedicated `lockClient` stays connected to `postgres` throughout the entire test lifecycle, guaranteeing unbroken lock ownership.*

---

### Subject 21: Preflight Endpoint Consistency Validation
#### Q21: What is preflight endpoint consistency validation, and why does `assertEndpointsTargetSamePostgresServer` exist?
**Staff Answer:**
> *"If `FLUXORA_CLUSTER_LOCK_DATABASE_URL` points to PostgreSQL Instance 1 (`localhost:5432`) and the test database URL points to PostgreSQL Instance 2 (`localhost:5433` or another host), an advisory lock on Instance 1 provides zero protection for Instance 2!
> In `packages/db/src/migrate/security-definer-hardening.test.ts`, `assertEndpointsTargetSamePostgresServer(lockUrl, adminUrl)` parses both connection strings via `pg-connection-string`, normalizes hostnames (e.g. `127.0.0.1` vs `localhost`), compares normalized ports (defaulting to 5432), and verifies that both endpoints resolve to the exact same server.
> If hosts or ports diverge, the test suite aborts immediately before initiating any network connections or executing queries."*
>
> **Difficult Follow-Up:** *How does the validator handle IPv6 loopback (`::1`) vs IPv4 (`127.0.0.1`)?*<br>
> **Answer:** *The validator normalizes standard loopback aliases (`localhost`, `127.0.0.1`, `::1`) into a canonical loopback identifier before comparison.*

---

### Subject 22: Advisory Lock Lifecycle in Test Suites
#### Q22: Walk through the exact lifecycle of an advisory lock during a destructive migration test run.
**Staff Answer:**
> *"The lifecycle in `security-definer-hardening.test.ts` follows a strict deterministic sequence:
> 1. **Configuration Preflight:** Parse and validate `FLUXORA_CLUSTER_LOCK_DATABASE_URL` and `FLUXORA_QUEUE_TEST_DATABASE_URL`. Assert endpoint host/port identity.
> 2. **Client Initialization:** Construct frozen `lockConfig`. Initialize `lockClient = new pg.Client(lockConfig)`.
> 3. **Connection & Lock Acquisition:** `await lockClient.connect()`; `await lockClient.query('SELECT pg_advisory_lock($1)', [CLUSTER_LOCK_KEY])`.
> 4. **Protected Execution (`try` block):**
>    - Connect `adminClient` to target database.
>    - Create disposable test database (`fluxora_secdef_upg_<uuid>`).
>    - Apply migrations 0001–0025.
>    - Verify role boundaries and execution permissions.
>    - Teardown disposable database and test-scoped roles.
> 5. **Unconditional Outer Cleanup (`finally` block):**
>    - In an outer `finally` block completely independent of test outcomes, `await lockClient.query('SELECT pg_advisory_unlock($1)', [CLUSTER_LOCK_KEY])`.
>    - `await lockClient.end()`.
> Even if the test crashes, throws an unhandled rejection, or times out, the advisory lock is either explicitly unlocked or automatically reclaimed by PostgreSQL when the TCP socket closes."*
>
> **Difficult Follow-Up:** *What happens if `lockClient.end()` hangs or network fails?*<br>
> **Answer:** *Session-level advisory locks in PostgreSQL are bound to the backend session process. If the client disconnects or the TCP connection terminates, the PostgreSQL backend terminates and releases all session advisory locks automatically.*

---

### Subject 23: JavaScript `new URL()` vs Driver Parser (`pg-connection-string`) Divergence
#### Q23: Why is validating PostgreSQL connection strings with JavaScript's native `new URL()` parser dangerous in security-critical code?
**Staff Answer:**
> *"JavaScript's `new URL()` implements the WHATWG URL specification for web browsers. However, `node-postgres` (`pg`) delegates connection string parsing to `pg-connection-string`, which implements PostgreSQL libpq connection URI conventions.
> These two parsers diverge fundamentally:
> 1. **Percent-Decoding:** `new URL()` preserves percent-encoded characters in `pathname` (e.g. `/fluxora%5Fdev`). `pg-connection-string` decodes them directly into the target database name (`fluxora_dev`).
> 2. **Query Parameter Overrides:** libpq and `pg-connection-string` allow connection parameters inside the query string (e.g. `?host=evil.com&port=9999&dbname=fluxora_dev`) to override the authority and pathname components of the URL!
> A naive validator inspecting `new URL(url).hostname` and `new URL(url).pathname` can declare a URL safe, while `pg.Client` connects to an entirely different host, port, or database!"*
>
> **Difficult Follow-Up:** *Why didn't we just strip query parameters from the URL before passing to `pg.Client`?*<br>
> **Answer:** *PostgreSQL connection strings legitimately use query parameters for SSL configuration (`sslmode=require`), timeouts, and application names. Stripping them breaks valid connections; parsing them with the driver's own parser ensures total fidelity.*

---

### Subject 24: Connection String Percent-Decoding Bypass (`%5F` -> `_`)
#### Q24: Explain the percent-decoding bypass and how Fix 3C neutralized it.
**Staff Answer:**
> *"An attacker or misconfigured script provides:
> `postgresql://postgres:pass@localhost:5432/fluxora%5Fdev`
> A validator checking:
> ```ts
> const u = new URL(connStr);
> if (u.pathname === "/fluxora_dev") throw new Error("Blocked!");
> ```
> Passes without error, because `u.pathname` evaluates to `"/fluxora%5Fdev"`.
> But `pg.Client` parses the string, decodes `%5F` to `_`, and connects directly to `fluxora_dev`, executing destructive tests against the developer database!
> **Fix 3C Neutralization:**
> 1. Validates that percent-encoding is well-formed with regex `/%(?![0-9a-fA-F]{2})/i`.
> 2. Uses `parsePgConnectionString` to obtain the effective decoded database name.
> 3. Explicitly asserts `decodedDb !== "fluxora_dev" && !decodedDb.endsWith("_dev")` against the driver-effective database name."*
>
> **Difficult Follow-Up:** *What if an attacker uses double percent-encoding (`%255F`)?*<br>
> **Answer:** *`pg-connection-string` performs a single decode pass. `%255F` decodes to `%5F`, resulting in database name `fluxora%5Fdev`, which PostgreSQL treats literally as a database named `fluxora%5Fdev` (which does not match `fluxora_dev`).*

---

### Subject 25: Connection String Query Parameter Overrides
#### Q25: How do query parameter overrides (`?host=`, `?port=`, `?dbname=`) bypass naive URL validation?
**Staff Answer:**
> *"Consider the connection string:
> `postgresql://user:pass@localhost:5432/disposable_db?host=remote.compromised.com&port=9999&dbname=fluxora_dev`
> - `new URL().hostname` returns `'localhost'`.
> - `new URL().port` returns `'5432'`.
> - `new URL().pathname` returns `'/disposable_db'`.
> A naive validator approving `localhost:5432/disposable_db` passes.
> But `pg-connection-string` parses the query string and overrides the parsed object:
> `result.host = 'remote.compromised.com'`, `result.port = '9999'`, `result.database = 'fluxora_dev'`.
> `pg.Client` connects to `remote.compromised.com:9999/fluxora_dev`!
> Fix 3C validates the **effective parsed properties** returned by `pg-connection-string`, completely neutralizing query parameter overrides."*
>
> **Difficult Follow-Up:** *What happens if multiple `host` query parameters are provided (`?host=a&host=b`)?*<br>
> **Answer:** *`pg-connection-string` returns an array `['a', 'b']`. Fix 3C explicitly checks `Array.isArray(config.host)` and throws an error, rejecting multi-host connection strings.*

---

### Subject 26: Driver-Level Parsing via `createRequire`
#### Q26: How does Fluxora's test suite resolve `pg-connection-string` in ESM TypeScript without adding new direct dependencies?
**Staff Answer:**
> *"In `packages/db/src/migrate/security-definer-hardening.test.ts`, we need the exact parser used by `pg`, but `pg-connection-string` is a transitive dependency of `pg`.
> Because the codebase is ESM (`"type": "module"`), we use Node's `createRequire`:
> ```ts
> const nodeRequire = createRequire(import.meta.url);
> const pgPackagePath = nodeRequire.resolve("pg");
> const pgConnectionStringPath = nodeRequire.resolve("pg-connection-string", {
>   paths: [pgPackagePath],
> });
> const { parse: parsePgConnectionString } = nodeRequire(pgConnectionStringPath);
> ```
> This guarantees that our test validator executes the **exact same binary code and version** of `pg-connection-string` that `pg.Client` uses internally, with zero version drift and zero package manifest pollution."*
>
> **Difficult Follow-Up:** *Why not import `pg-connection-string` directly with `import { parse } from "pg-connection-string"`?*<br>
> **Answer:** *Adding a direct dependency to `package.json` expands our dependency tree and maintenance burden. Resolving via `createRequire` ensures the validator precisely mirrors `pg`'s internal resolution logic.*

---

### Subject 27: Decimal-Only Port Validation Regex vs `parseInt` Bugs
#### Q27: Why does Fix 3C enforce `/^\d+$/` on port strings rather than using `parseInt()` or relying on default fallbacks?
**Staff Answer:**
> *"JavaScript's `parseInt()` has notorious edge cases:
> 1. `parseInt("5432junk", 10)` returns `5432`, silently dropping the trailing invalid characters.
> 2. `parseInt("0x1538", 10)` parses hex as `0` in older engines or produces unexpected integers.
> 3. `parseInt("-5432", 10)` returns negative numbers.
> 4. `parseInt("5432.89", 10)` parses floats by truncating decimals.
> If a connection string contains an invalid port like `5432junk`, `parseInt` might pass it as 5432, but underlying socket libraries or alternative drivers fail or misroute.
> Fix 3C enforces `/^\d+$/`, verifying the string contains strictly decimal digits, validates `1 <= port <= 65535`, and applies default port `5432` **only when port is genuinely absent** from both the URL and query parameters."*
>
> **Difficult Follow-Up:** *What if port is explicitly set to `0`?*<br>
> **Answer:** *Port `0` matches `/^\d+$/`, but fails the range check `port >= 1 && port <= 65535`, raising an immediate validation error.*

---

### Subject 28: Frozen, Branded `ValidatedPostgresConfig` Pattern
#### Q28: How does the frozen, branded `ValidatedPostgresConfig` pattern guarantee configuration safety across the application?
**Staff Answer:**
> *"In Fix 3C, once a connection string is validated, we do **not** pass the raw connection string to `pg.Client`.
> Instead:
> 1. We construct a discrete `pg.ClientConfig` object containing explicit properties: `{ host, port, database, user, password, ssl }`.
> 2. We freeze the object using `Object.freeze()`.
> 3. We stamp it with a unique TypeScript branded symbol: `[VALIDATED_CONFIG_BRAND]: true`.
> 4. When secondary clients need derived credentials (e.g. `dbAdminClient` connecting to a newly created disposable database), we call a pure helper `deriveClientConfig(baseConfig, { database: newDb })`.
> `deriveClientConfig` copies frozen host, port, and SSL settings while overriding only target database/credentials, returning a new frozen branded object.
> **No client in the test suite is ever instantiated from a raw URL.**"*
>
> **Difficult Follow-Up:** *Why is object freezing necessary in a single-threaded Node environment?*<br>
> **Answer:** *In complex asynchronous test suites with multiple parallel async tasks and shared helper modules, freezing prevents accidental mutation of base configuration objects (e.g. a worker accidentally modifying `config.database` in-place).*

---

### Subject 29: Safe Cluster Test Isolation & Snapshot Comparator
#### Q29: How does Fix 3 verify that destructive tests do not alter pre-existing PostgreSQL cluster roles or passwords?
**Staff Answer:**
> *"PostgreSQL roles are cluster-wide objects. Careless tests that drop roles (`DROP ROLE IF EXISTS fluxora_auth`) or alter passwords destroy shared environment state.
> Fix 3 enforces four safeguards in `security-definer-hardening.test.ts`:
> 1. **Dynamic Hex Suffixes:** Every execution creates uniquely named roles: `fluxora_mig_${crypto.randomUUID().slice(0, 8)}`.
> 2. **Positive Tracking:** Roles are added to `createdExecutionRoles` only after successful creation.
> 3. **Role & Password Snapshots:** Before any test runs, `captureRoleSnapshot()` records attributes and password hashes (`rolpassword` from `pg_authid`) for all pre-existing roles (`fluxora_app`, `fluxora_worker`, `fluxora_queue`).
> 4. **Teardown & Diff Assertion:** In `afterAll`, only tracked roles are dropped (never `DROP ROLE CASCADE`), and an assertion verifies that every pre-existing role matches its original snapshot byte-for-byte."*
>
> **Difficult Follow-Up:** *What if the test runner does not have access to read `pg_authid` to capture password hashes?*<br>
> **Answer:** *If `pg_authid` access is restricted (non-superuser test runner), the snapshot captures `rolpassword: null` and logs an honest operational limitation, verifying all accessible boolean attributes from `pg_roles` without falsely claiming password hash verification.*

---

### Subject 30: Outstanding Live PostgreSQL Integration Verification & Safety
#### Q30: What is the current verification status of Fix 3, which 5 tests are skipped locally, and why must `fluxora_dev` never be used for destructive tests?
**Staff Answer:**
> *"**Status:** Implementation and non-destructive verification completed; live destructive PostgreSQL integration verification pending.
> All 32 non-destructive tests in the Fix 3 suite pass locally (static SQL checks, URL parser security, branded configuration assembly, membership snapshot comparators).
> However, exactly **five live integration tests are currently skipped locally** because the local environment does not have:
> - `FLUXORA_QUEUE_TEST_DATABASE_URL`
> - `QUEUE_TEST_DATABASE_URL`
> - `FLUXORA_CLUSTER_LOCK_DATABASE_URL`
> - `FLUXORA_ALLOW_DESTRUCTIVE_QUEUE_MIGRATION_TESTS=true`
>
> The five skipped live tests are:
> 1. *Live migration 0025 and service-role isolation* (`applies migration 0025 without ADMIN OPTION and verifies strict service-role isolation`).
> 2. *Clean migration bootstrap from 0001–0025* (`performs clean installation from 0001 through 0025 using a constrained non-superuser role`).
> 3. *Advisory-lock contention* (`serializes a second lock contender with a distinct validated queue database configuration sharing the canonical lock database`).
> 4. *Preservation of pre-existing PostgreSQL role state* (`leaves existing cluster runtime and service role passwords and attributes unchanged`).
> 5. *Constrained migration schema privileges* (`proves the constrained migration role possesses exact required schema privileges without superuser or BYPASSRLS`).
>
> **Safety Invariant:** `fluxora_dev` contains active local development data across 21 tables. Destructive tests drop and recreate tables and schemas; executing them against `fluxora_dev` would cause irreversible data loss. Verification must run in a dedicated disposable database on a dedicated test container in CI."*
>
> **Difficult Follow-Up:** *What are the endpoint requirements when configuring `FLUXORA_QUEUE_TEST_DATABASE_URL` and `FLUXORA_CLUSTER_LOCK_DATABASE_URL`?*<br>
> **Answer:** *Both URLs must target the exact same PostgreSQL server instance (validated matching host and port), but point to distinct databases: `FLUXORA_CLUSTER_LOCK_DATABASE_URL` points to the canonical maintenance database (`postgres`), while `FLUXORA_QUEUE_TEST_DATABASE_URL` points to a dedicated disposable database.*

---

## 4. Architectural Anti-Patterns & Traps

```
+---------------------------------------------------------------------------------------------------+
|                                 POSTGRESQL SECURITY ANTI-PATTERNS                                 |
+-----------------------------------+-----------------------------------+---------------------------+
| Anti-Pattern                      | Why It Fails                      | Fluxora Production Pattern|
+-----------------------------------+-----------------------------------+---------------------------+
| 1. Superuser Function Owner       | Any caller of the function wields | Dedicated NOLOGIN roles   |
|                                   | superuser powers during execution.| with explicit RLS policies|
+-----------------------------------+-----------------------------------+---------------------------+
| 2. Pinned search_path without     | PostgreSQL checks pg_temp FIRST!  | Explicit trailing pg_temp:|
|    trailing pg_temp               | Attacker shadows tables with temp.| pg_catalog, public,pg_temp|
+-----------------------------------+-----------------------------------+---------------------------+
| 3. Unqualified Table References   | Ambiguous resolution allows       | Fully qualified relations:|
|                                   | relation hijacking.               | public.oauth_login_states |
+-----------------------------------+-----------------------------------+---------------------------+
| 4. Default PUBLIC EXECUTE Grants  | Any database user can call the    | REVOKE ALL ... FROM PUBLIC|
|                                   | privileged security routine.      | Explicit grants to app/wkr|
+-----------------------------------+-----------------------------------+---------------------------+
| 5. Non-superuser CREATEROLE for   | Creator permanently retains       | Pre-provision service     |
|    Service Role Creation (PG16+)  | ADMIN OPTION; cannot self-revoke. | roles; grant ADMIN FALSE. |
+-----------------------------------+-----------------------------------+---------------------------+
| 6. Database-Local Advisory Locks  | Advisory locks partition by DB OID| Canonical Lock Database   |
|    for Cluster-Role Concurrency   | Multi-DB workers do NOT serialize.| (e.g. postgres) for locks |
+-----------------------------------+-----------------------------------+---------------------------+
| 7. JavaScript new URL() for       | Percent-encoding and query params | pg-connection-string from |
|    PostgreSQL Connection Strings  | bypass naive checks (%5F -> _).   | pg; frozen branded configs|
+-----------------------------------+-----------------------------------+---------------------------+
```

---

## 5. Comparative Architecture: Before vs. After Fix 3

```
+-----------------------------------+-----------------------------------+-----------------------------------+
| DIMENSION                         | BEFORE FIX 3                      | AFTER FIX 3                       |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Function Ownership                | Owned by superuser or default     | Owned by dedicated NOLOGIN roles  |
|                                   | migration runner identity.        | (`fluxora_auth`, tenant_guard).   |
+-----------------------------------+-----------------------------------+-----------------------------------+
| search_path Safety                | Unpinned or `pg_catalog, public`  | Strictly pinned:                  |
|                                   | (omitted `pg_temp` -> vulnerable).| `pg_catalog, public, pg_temp`.    |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Relation References               | Unqualified table names           | Fully schema-qualified            |
|                                   | (`DELETE FROM oauth_login_states`)| (`public.oauth_login_states`).    |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Schema Public Permissions         | `CREATE` granted to `PUBLIC`      | `REVOKE CREATE ON SCHEMA public   |
|                                   | (CVE-2018-1058 attack surface).   | FROM PUBLIC;` enforced.           |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Execution Privileges              | Explicitly granted to `PUBLIC`    | `REVOKE ALL ... FROM PUBLIC;`     |
|                                   | on all 12 functions.              | Granted only to app/worker roles. |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Role Administration (PG16+)       | Risk of permanent `ADMIN OPTION`  | Service roles pre-provisioned;    |
|                                   | retained by migration runner.     | migrator granted `ADMIN FALSE`.   |
+-----------------------------------+-----------------------------------+-----------------------------------+
| Advisory Lock Concurrency         | Assumed cluster-global; failed to | Canonical lock database           |
|                                   | serialize multi-database workers. | (`FLUXORA_CLUSTER_LOCK_DATABASE`)|
+-----------------------------------+-----------------------------------+-----------------------------------+
| Connection String Parsing         | Naive `new URL()` validation;     | `pg-connection-string` resolution;|
|                                   | vulnerable to `%5F` & query overrides| frozen, branded `ClientConfig`.   |
+-----------------------------------+-----------------------------------+-----------------------------------+
```

---

## 6. Production Deployment Runbook & Operational Checklist

When deploying Migration 0025 to staging or production:

### Phase 1: Cluster Administrator Pre-Provisioning
```sql
-- As postgres / superuser:
CREATE ROLE fluxora_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE fluxora_tenant_guard NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- Grant minimal schema ownership prerequisites to migration identity:
GRANT CONNECT, CREATE ON DATABASE fluxora_prod TO fluxora_migrator;
ALTER SCHEMA public OWNER TO fluxora_migrator;
REVOKE CREATE ON DATABASE fluxora_prod FROM fluxora_migrator;

-- Grant temporary non-inheriting membership for ownership transfer:
GRANT fluxora_auth, fluxora_tenant_guard TO fluxora_migrator WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;
```

### Phase 2: Run Migration 0025
```bash
psql -U fluxora_migrator -d fluxora_prod -v ON_ERROR_STOP=1 -f packages/db/migrations/0025_security_definer_hardening.sql
```

### Phase 3: Cluster Administrator Cleanup
```sql
-- As postgres / superuser (executed on both SUCCESS and FAILURE):
REVOKE fluxora_auth, fluxora_tenant_guard FROM fluxora_migrator;

-- Verify complete revocation:
SELECT COUNT(*) FROM pg_catalog.pg_auth_members m
JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
WHERE gr.rolname IN ('fluxora_auth', 'fluxora_tenant_guard') AND mr.rolname = 'fluxora_migrator';
-- MUST RETURN 0
```

---

## 7. Honest Live PostgreSQL Verification Status

> [!IMPORTANT]
> **Current Status Statement**: Implementation and non-destructive verification completed; live destructive PostgreSQL integration verification pending.

The following configuration variables are not set in the local development environment:
- `FLUXORA_QUEUE_TEST_DATABASE_URL` is not configured locally.
- `QUEUE_TEST_DATABASE_URL` is not configured locally.
- `FLUXORA_CLUSTER_LOCK_DATABASE_URL` is not configured locally.
- `FLUXORA_ALLOW_DESTRUCTIVE_QUEUE_MIGRATION_TESTS=true` is not configured locally.

Consequently, the five live integration tests in `packages/db/src/migrate/security-definer-hardening.test.ts` remain **unverified on this local development machine**:
1. Live migration 0025 and service-role isolation.
2. Clean migration bootstrap from 0001–0025.
3. Advisory-lock contention across concurrent connections.
4. Preservation of pre-existing PostgreSQL role passwords and attributes.
5. Constrained migration schema privileges without superuser or `BYPASSRLS`.

**Operational Constraints for Verification**:
- Verification must use a dedicated disposable PostgreSQL test database and a separate canonical advisory-lock database.
- Both databases must target the same PostgreSQL server, with validated host and port consistency.
- **`fluxora_dev` must never be used for destructive tests.**
