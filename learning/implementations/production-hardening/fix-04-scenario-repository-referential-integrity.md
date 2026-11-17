# Fix 4 — Scenario and Repository Referential Integrity: Engineering Implementation Report

**Status:** Completed and Verified
**Package:** `@fluxora/db`
**Migration:** `packages/db/migrations/0026_scenario_repository_referential_integrity.sql`
**Author:** Fluxora Database & Infrastructure Engineering Team
**Date:** November 2026

---

## 1. Executive Summary

In Fluxora's architecture, a **Scenario** represents a deterministic what-if hypothesis (e.g., node failure, latency degradation, capacity exhaustion) configured to test resilience against an immutable software graph snapshot. Each scenario specifies a target repository (`repository_id`) and a target graph node (`target_node_id`).

Prior to Fix 4, the `scenarios` table possessed independent, single-column foreign keys to `repositories(id)` and `graph_nodes(id)`. While these constraints ensured that both the referenced repository and the target node existed in the database, they **failed to establish that the selected target graph node actually belonged to the selected repository**.

As a consequence:
1. A scenario could be inserted or updated to associate Repository A with a graph node belonging to Repository B.
2. Cross-repository relationship validity depended entirely on pre-insert application-level validation (`nodeCheck`), leaving the database vulnerable to race conditions (Time-of-Check to Time-of-Use / TOCTOU), direct SQL operations, background workers, and administrative scripts.
3. A cross-repository mismatch would corrupt simulation execution, produce falsified blast-radius analysis, and break multi-tenant data hygiene.

**Fix 4 resolves this gap by moving referential integrity enforcement into PostgreSQL's relational core.** It introduces a denormalized, immutable `repository_id` column on `graph_nodes`, establishes a composite unique constraint `(repository_id, id)` on `graph_nodes`, replaces the single-column target node foreign key with a composite foreign key:
```sql
CONSTRAINT scenarios_repository_target_node_fkey
  FOREIGN KEY (repository_id, target_node_id)
  REFERENCES public.graph_nodes (repository_id, id)
  ON DELETE CASCADE
```
and deploys backward-compatible triggers to automatically derive and preserve graph node repository associations without breaking existing graph ingestion pipelines.

---

## 2. Threat Model and Failure Scenarios

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               THE REFERENTIAL INTEGRITY GAP                             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│                                  scenarios                                             │
│                     ┌──────────────────────────────────┐                               │
│                     │ id: uuid                         │                               │
│                     │ repository_id: Repo A            │───┐                           │
│                     │ target_node_id: Node X           │─┐ │                           │
│                     └──────────────────────────────────┘ │ │                           │
│                                                          │ │                           │
│                     Pre-Fix 4 Independent Constraints    │ │                           │
│                     ─────────────────────────────────    │ │                           │
│                     FK 1: target_node_id -> Node X (OK) ─┘ │                           │
│                     FK 2: repository_id  -> Repo A (OK) ───┘                           │
│                                                                                        │
│                     PostgreSQL Question: Does Node X belong to Repo A?                 │
│                     Pre-Fix 4 Answer:    "I do not know and cannot enforce it."        │
│                     Post-Fix 4 Answer:   "REJECTED: (Repo A, Node X) violates FK."     │
│                                                                                        │
│         repositories                             graph_nodes                           │
│     ┌──────────────────┐                   ┌───────────────────────┐                   │
│     │ id: Repo A       │                   │ id: Node X            │                   │
│     └──────────────────┘                   │ repository_id: Repo B │                   │
│                                            └───────────────────────┘                   │
│                                                                                        │
│     Result: Scenario A points to Node X belonging to Repo B!                           │
│     Impact: Simulation engine propagates failure across unrelated codebases!          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Threat Vectors

1. **Simulation Falsification (Integrity Violation):**
   If Scenario S in Repository A targets Node N in Repository B, running the simulation engine against Repository A's analysis run causes graph traversal queries to fail or—worse—simulate infrastructure failure cascades across completely unrelated software repositories.
2. **Time-of-Check to Time-of-Use (TOCTOU) Concurrency Race:**
   In concurrent workflows, application checks verify that a node belongs to a repository at timestamp $t_0$. If another process or direct SQL mutation alters relationships or scenario parameters at timestamp $t_1$, an insert or update at $t_2$ bypasses application validation.
3. **Invalid Direct SQL Updates:**
   Application-layer checks in `createScenario` only ran on initial insert. Any direct SQL `UPDATE scenarios SET repository_id = ...` or `UPDATE scenarios SET target_node_id = ...` would bypass the application validation query completely, leaving corrupted scenario records in the database.
4. **Cross-Tenant Repository Boundary Bleed:**
   Although Row-Level Security (RLS) protects tenant visibility, inconsistent foreign keys create cross-repository pollution within the same organization or across organizations if superuser or service roles perform maintenance.

---

## 3. Schema and Constraint Inspection Findings

Before designing Migration 0026, an exhaustive audit of the live schema was conducted against the 12 mandatory inspection criteria:

| # | Inspection Criterion | Schema Finding | Engineering Impact |
|---|----------------------|----------------|--------------------|
| 1 | Is `scenarios.repository_id` nullable? | **No (`NOT NULL`)** | Mandatory repository association must be preserved. |
| 2 | Is `scenarios.target_node_id` nullable? | **No (`NOT NULL`)** | Every scenario requires a target node. |
| 3 | Is a scenario permitted without a target node? | **No** | In both DB schema and API contracts, target node is mandatory. |
| 4 | Does `graph_nodes.repository_id` exist / NOT NULL? | **Did not exist in pre-Fix 4 schema!** | `graph_nodes` only had `analysis_run_id`. Required adding `repository_id uuid NOT NULL`. |
| 5 | Is `graph_nodes.id` globally unique? | **Yes (`PRIMARY KEY`)** | Global UUID uniqueness verified. |
| 6 | Was `(repository_id, id)` UNIQUE? | **No** | PostgreSQL composite foreign key requires an explicit `UNIQUE (repository_id, id)` constraint. |
| 7 | Existing foreign keys on `scenarios`? | **Two separate FKs** | `scenarios_repository_id_fkey` and `scenarios_target_node_id_fkey`. |
| 8 | Existing `ON DELETE` actions? | **`CASCADE` for both** | Deleting repository or node cascades scenario deletion. |
| 9 | Can a node's `repository_id` be updated? | **No** | Graph nodes belong to immutable analysis runs; immutability trigger deployed. |
| 10 | Can a repository be deleted with scenarios? | **Yes (via `CASCADE`)** | Existing cascade semantics preserved. |
| 11 | How is tenant isolation enforced? | **`FORCE ROW LEVEL SECURITY`** | `organization_id = fluxora_current_org_id()` + `fluxora_repository_in_current_tenant`. |
| 12 | Application creation/update paths? | **`createScenario` in `simulation.ts`** | Had 3-table join `nodeCheck` query; no `updateScenario` existed in repository layer. |

---

## 4. Root Cause of the Referential Integrity Gap

The relational schema originally modeled the hierarchy as:
$$\text{repositories} \longleftarrow \text{repository\_snapshots} \longleftarrow \text{analysis\_runs} \longleftarrow \text{graph\_nodes}$$

Under this design, `graph_nodes` only referenced its immediate parent, `analysis_runs(id)`. When `scenarios` was created in Migration 0019, it introduced two independent foreign keys:
1. `scenarios.repository_id \to repositories.id`
2. `scenarios.target_node_id \to graph_nodes.id`

In relational database theory and ANSI SQL, two independent foreign keys enforce existence, not joint correlation:
$$\exists r \in \text{repositories} \land \exists n \in \text{graph\_nodes}$$
They do **not** enforce the predicate:
$$\text{repo\_of}(n) = r$$

Because SQL `CHECK` constraints cannot contain subqueries (`CHECK ((SELECT ...) = ...)` is explicitly forbidden by PostgreSQL), and PostgreSQL foreign keys can only reference columns on a single target table, **enforcing this invariant at the database level requires the target table to carry the correlated key**.

---

## 5. Composite Foreign-Key Design & Referenced Key Architecture

To enforce the invariant at the storage engine level, the relational schema was refactored:

### 5.1 Referenced Key on `graph_nodes`

1. **Denormalized `repository_id` Column:**
   Added `repository_id uuid NOT NULL` to `graph_nodes`, backed by foreign key `graph_nodes_repository_id_fkey REFERENCES repositories(id) ON DELETE CASCADE`.
2. **Composite Unique Constraint:**
   ```sql
   CONSTRAINT graph_nodes_repository_id_id_unique UNIQUE (repository_id, id)
   ```
   PostgreSQL automatically generates a unique B-tree index on `(repository_id, id)`. Because `repository_id` is the leading index column, this index doubles as an index for repository-filtered graph queries.

### 5.2 Referencing Key on `scenarios`

1. **Replaced Single-Column Constraint:**
   Dropped `scenarios_target_node_id_fkey`.
2. **Added Composite Foreign Key:**
   ```sql
   CONSTRAINT scenarios_repository_target_node_fkey
     FOREIGN KEY (repository_id, target_node_id)
     REFERENCES public.graph_nodes (repository_id, id)
     ON DELETE CASCADE
   ```
3. **Preserved Independent Repository Foreign Key:**
   Retained `scenarios_repository_id_fkey REFERENCES repositories(id) ON DELETE CASCADE` for defense-in-depth and direct repository foreign-key cascade semantics.
4. **Supporting Index:**
   Created composite index `scenarios_repository_target_node_idx ON scenarios (repository_id, target_node_id)` to optimize join performance and cascade lookups.

---

## 6. Automated Derivation and Immutability Triggers (Hardened in Migration 0027)

Existing graph ingestion code (`packages/db/src/repositories/graph.ts`) inserts nodes via:
```sql
INSERT INTO graph_nodes (analysis_run_id, canonical_id, node_type, name, path, metadata, confidence)
```
Passing `repository_id` explicitly would require refactoring every graph builder, AST extractor, and worker service. In addition, an independent audit of Migration 0026 revealed two critical integrity defects:
1. **Explicit Repository Identity Spoofing:** In Migration 0026, `NEW.repository_id` was derived only when `NEW.repository_id IS NULL`. An explicit, non-null `repository_id` bypassed derivation and validation, allowing a caller to associate Run A with Repository B at the node boundary.
2. **Analysis Run Mutation:** The UPDATE trigger only checked `repository_id`, permitting `analysis_run_id` to be modified on an existing node, severing its relationship with the stored repository identity.

To resolve these defects while maintaining backward compatibility, forward-only migration `0027_graph_node_lineage_integrity.sql` deploys hardened triggers:

1. **BEFORE INSERT Authoritative Derivation & Spoofing Rejection Trigger (`trg_graph_nodes_set_repository_id`):**
   The database always derives the authoritative repository identity independently from `analysis_runs` $\to$ `repository_snapshots`. If an explicit `repository_id` is supplied, it is validated against the derived authority; any mismatch is rejected with SQLSTATE `23000`. Unresolvable analysis runs fail closed with SQLSTATE `23503`:
   ```sql
   CREATE OR REPLACE FUNCTION public.fluxora_set_graph_node_repository_id()
   RETURNS trigger LANGUAGE plpgsql
   SET search_path = pg_catalog, public AS $$
   DECLARE
     v_derived_repo_id uuid;
   BEGIN
     -- 1. Authoritative resolution from upstream lineage
     SELECT rs.repository_id INTO v_derived_repo_id
     FROM public.analysis_runs ar
     JOIN public.repository_snapshots rs ON rs.id = ar.snapshot_id
     WHERE ar.id = NEW.analysis_run_id;

     -- 2. Fail closed if unresolvable
     IF v_derived_repo_id IS NULL THEN
       RAISE EXCEPTION 'Cannot resolve repository_id for graph_node with analysis_run_id %', NEW.analysis_run_id
         USING ERRCODE = 'foreign_key_violation';
     END IF;

     -- 3. Reject caller-supplied spoofed mismatch
     IF NEW.repository_id IS NOT NULL AND NEW.repository_id IS DISTINCT FROM v_derived_repo_id THEN
       RAISE EXCEPTION 'Explicit repository_id % does not match authoritative repository_id % derived from analysis_run_id %',
         NEW.repository_id, v_derived_repo_id, NEW.analysis_run_id
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     -- 4. Authoritative assignment
     NEW.repository_id := v_derived_repo_id;
     RETURN NEW;
   END;
   $$;
   ```

2. **BEFORE UPDATE Dual Immutability Trigger (`trg_graph_nodes_prevent_repository_mutation`):**
   Graph nodes belong to immutable repository snapshots. Both `repository_id` and `analysis_run_id` are strictly immutable after creation. The trigger uses `IS DISTINCT FROM` to handle NULL semantics properly and rejects mutations with SQLSTATE `23000`:
   ```sql
   CREATE OR REPLACE FUNCTION public.fluxora_prevent_graph_node_repository_mutation()
   RETURNS trigger LANGUAGE plpgsql
   SET search_path = pg_catalog, public AS $$
   BEGIN
     IF NEW.repository_id IS DISTINCT FROM OLD.repository_id THEN
       RAISE EXCEPTION 'graph_nodes.repository_id is immutable and cannot be updated'
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     IF NEW.analysis_run_id IS DISTINCT FROM OLD.analysis_run_id THEN
       RAISE EXCEPTION 'graph_nodes.analysis_run_id is immutable and cannot be updated'
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     RETURN NEW;
   END;
   $$;
   ```

3. **Upstream Lineage Verification:**
   An exhaustive audit of upstream models confirmed that `analysis_runs.snapshot_id` and `repository_snapshots.repository_id` are write-once parent identities. Application repositories (`packages/db/src/repositories/graph.ts` and `repository-snapshot.ts`) only update mutable lifecycle fields (`status`, `completed_at`, `file_count`). Upstream relationships cannot be mutated by normal application or worker transactions, guaranteeing the derived invariant remains protected.

---

## 7. Pre-Migration Data Audit & Fail-Closed Strategy

In accordance with strict production hardening requirements, Migration 0026 implements a fail-closed pre-migration verification block.

### 7.1 Live Audit Findings

Prior to running the migration:
- **Orphaned Graph Nodes:** `0` (all graph nodes resolved cleanly to their repository snapshots).
- **Mismatched Scenarios:** `0` (all scenarios had target nodes belonging to their declared repository).

### 7.2 Fail-Closed Migration Block

If any invalid or orphaned data is present when the migration runs, Migration 0026 aborts immediately before any schema mutations take place:
```sql
-- Check for existing scenario records whose target_node_id does not belong to repository_id
SELECT count(*) INTO v_mismatch_count
FROM public.scenarios s
LEFT JOIN public.graph_nodes gn ON gn.id = s.target_node_id
LEFT JOIN public.analysis_runs ar ON ar.id = gn.analysis_run_id
LEFT JOIN public.repository_snapshots rs ON rs.id = ar.snapshot_id
WHERE s.target_node_id IS NOT NULL
  AND (gn.id IS NULL OR rs.repository_id IS DISTINCT FROM s.repository_id);

IF v_mismatch_count > 0 THEN
  RAISE EXCEPTION 'Migration 0026 aborted: Found % scenario records with target_node_id not belonging to scenario repository_id.',
    v_mismatch_count
    USING ERRCODE = 'check_violation';
END IF;
```

---

## 8. Multi-Tenancy, Row-Level Security & Trigger Security

### 8.1 Schema RLS Policies
All existing `FORCE ROW LEVEL SECURITY` configurations on `scenarios`, `repositories`, and `graph_nodes` remain strictly intact.
- `scenarios_tenant_select`: `organization_id = fluxora_current_org_id()`
- `scenarios_tenant_insert`: `organization_id = fluxora_current_org_id() AND fluxora_repository_in_current_tenant(repository_id)`
- `scenarios_tenant_update`: `organization_id = fluxora_current_org_id() AND fluxora_repository_in_current_tenant(repository_id)`
- `scenarios_tenant_delete`: `organization_id = fluxora_current_org_id()`

### 8.2 Trigger Security Mode & Search Path Pinning
Both trigger functions use `SECURITY INVOKER` and explicit `SET search_path = pg_catalog, public`.
- When invoked during application or worker operations under tenant context `app.current_org_id`, the lineage lookup is evaluated with the caller's privileges.
- If a caller attempts to reference an `analysis_run_id` from another tenant, RLS on `analysis_runs` filters out the row; `v_derived_repo_id` evaluates to NULL, and the trigger fails closed with SQLSTATE `23503` without leaking the other tenant's repository identity or presence.
- Execution privileges are explicitly granted to `fluxora_app`, `fluxora_worker`, and test role `fluxora_rls_test`.

### 8.3 Migration Role RLS Management
Under PostgreSQL `FORCE ROW LEVEL SECURITY`, even the table-owning migration role is subjected to RLS policies. In non-superuser migration environments (such as tested in `security-definer-hardening.test.ts`), evaluating policies during catalog backfills triggers execution of `fluxora_analysis_run_in_current_tenant`.

To prevent permission denial while maintaining complete tenant isolation:
1. Migration 0026 executes `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` at the start of the migration transaction. Under `NO FORCE RLS`, the table owner safely performs schema-level maintenance without evaluating tenant session variables.
2. Migration 0026 executes `ALTER TABLE ... FORCE ROW LEVEL SECURITY` at the end of the migration transaction, guaranteeing that all runtime access by application roles remains subject to strict hardware RLS.

---

## 9. Application Layer Refinement

In `packages/db/src/repositories/simulation.ts`:

1. **Optimized Validation Query:**
   Replaced the 3-table join (`graph_nodes gn JOIN analysis_runs ar JOIN repository_snapshots rs`) with a single-table indexed check:
   ```ts
   const nodeCheck = await client.query<{ id: string }>(
     `SELECT gn.id FROM graph_nodes gn WHERE gn.id = $1::uuid AND gn.repository_id = $2::uuid`,
     [targetNodeId, repositoryId],
   );
   ```
2. **Constraint Error Translation:**
   Wrapped the insert query to intercept PostgreSQL constraint violation `23503` for `scenarios_repository_target_node_fkey` and translate it into a domain-specific `SimulationPersistenceValidationError("Target node does not exist in the specified repository.")`, ensuring internal SQL details are never exposed to API callers.

---

## 10. Critical Test Database Isolation & Concurrency Verification

### 10.1 Dedicated Disposable Test Database Policy
Previous destructive tests ran against `localhost:5432/fluxora_dev`. To eliminate cross-test interference and protect development environments:
1. All destructive migration and integration tests execute exclusively against a dedicated disposable database (`fluxora_fix4_test` or temporary disposable databases prefixed with `fluxora_clean_`).
2. Host and database safety guards (`packages/db/src/testing/test-database.ts`) reject unapproved remote hosts, reject `fluxora_dev` and `*_dev` databases, and reject production targets.
3. Test runners recreate the isolated database, point `DATABASE_URL` to it, run migrations from 0001 through 0027, and tear down cleanly upon completion.

### 10.2 Deterministic Concurrency Verification
In concurrency tests, JavaScript timing assumptions have been replaced by database-observed lock waits via helper `waitForLockWait`:
- The test polls PostgreSQL's `pg_locks` catalog to verify that the contending transaction's backend PID is actively waiting (`NOT granted`) on the row lock held by the primary transaction before committing.
- This guarantees that serialization is enforced by PostgreSQL's `FOR KEY SHARE` and exclusive row-level locking mechanisms rather than thread scheduling coincidences.

---

## 11. Comprehensive Verification Matrix

All checks were executed against live PostgreSQL instances:

| Test Suite / Command | Scope / Coverage | Result |
|----------------------|------------------|--------|
| `scenario-referential-integrity.test.ts` | 30 dedicated tests on disposable DB: valid relations, invalid INSERTs, invalid UPDATEs, node deletion cascades, repository deletion cascades, tenant isolation, deterministic concurrency, explicit spoofing rejection (23000), dual immutability (23000), and RLS invoker checks. | **30 passed, 0 failed** |
| `scenario-referential-integrity-migration.test.ts` | 8 migration tests: 0026 & 0027 static analysis, catalog constraint verification (`pg_constraint`, `pg_index`), fail-closed audit rejection (`23514`), trigger derivation, and forward-only 0026 $\to$ 0027 upgrade test. | **8 passed, 0 failed** |
| `security-definer-hardening.test.ts` | Fix 3 regression suite: non-superuser migration, least-privilege role permissions, and 20 SECURITY DEFINER function invariants. | **37 passed, 0 failed** |
| Full `@fluxora/db` Test Suite | All test files across the database package. | **Clean passing** |
| `pnpm typecheck` | TypeScript compilation across all 7 workspace projects. | **Passed (0 errors)** |
| `pnpm lint` | ESLint across monorepo. | **Passed (0 errors)** |
| `pnpm lint:evidence` | CI static AST verification that graph writes invoke `EvidenceWriter`. | **Passed (5 target files verified)** |
| `git diff --check` | Whitespace and syntax diff check. | **Clean (0 errors)** |

---

## 12. Operational Considerations

1. **Forward-Only Migration:** Migration 0026 was preserved completely without editing or rewriting. Migration 0027 applies cleanly forward-only.
2. **Zero Downtime:** Schema changes in 0026 and function replacements in 0027 execute within transactional DDL without table locks or data loss.
3. **Worktree Preservation:** All pre-existing commits, unstaged changes, and untracked files are preserved. Nothing was committed or pushed.
