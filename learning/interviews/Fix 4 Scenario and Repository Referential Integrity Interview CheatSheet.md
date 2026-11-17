# Fix 4: Scenario & Repository Referential Integrity — Interview CheatSheet

**Category:** Database Engineering, Relational Modeling, PostgreSQL Concurrency & Production Hardening
**Target Level:** Senior / Staff / Principal Software Engineer

---

## 1. Executive Summary & Analogies

### The Simple Analogy
Imagine an airline booking system. You select a **Flight Number** (Flight 101: New York to London) and a **Seat Number** (Seat 14B).
If the database has independent foreign keys:
- `flight_id` references `flights(id)` (Flight 101 exists? Yes).
- `seat_id` references `seats(id)` (Seat 14B exists? Yes).
The database approves the booking. But Seat 14B was on an Airbus A320 flying from Paris to Rome! You were booked into a seat that exists on a completely different airplane.
**The composite foreign key** forces the reservation to check `(flight_id, seat_id) REFERENCES seats(flight_id, seat_id)`. The seat must exist on *that specific flight*.

### 30-Second Elevator Pitch
"In Fluxora, scenarios represent what-if failure simulations targeting a specific graph node within a repository. Previously, `scenarios` had two independent foreign keys to `repositories` and `graph_nodes`. This verified both existed, but didn't verify the node belonged to that repository. I hardened this at the database level by denormalizing `repository_id` onto `graph_nodes`, adding a composite `UNIQUE (repository_id, id)` constraint, and replacing the single-column foreign key with a composite foreign key `(repository_id, target_node_id) REFERENCES graph_nodes (repository_id, id) ON DELETE CASCADE`. I deployed fail-closed migration audits and triggers for zero-breakage backward compatibility."

### Two-Minute Technical Deep Dive
"The core issue was a relational integrity gap: SQL `CHECK` constraints cannot contain subqueries, and two independent foreign keys only assert existential validity in isolation ($A \in \text{Table}_1 \land B \in \text{Table}_2$), not relational correlation ($\text{owner}(B) = A$).

In Fluxora's original schema, `graph_nodes` only referenced its immediate parent `analysis_runs`, which referenced `repository_snapshots`, which referenced `repositories`. Because `graph_nodes` lacked `repository_id`, PostgreSQL could not construct a foreign key constraint linking a scenario's repository directly to the target node.

To fix this properly without relying on advisory application code:
1. **Schema Refactoring:** We added `repository_id uuid NOT NULL` to `graph_nodes`, backfilled it across 48,000+ existing nodes from historical snapshots, and created a composite `UNIQUE (repository_id, id)` constraint.
2. **Backward Compatibility via Triggers:** Since graph ingestion pipelines insert nodes without passing `repository_id`, a `BEFORE INSERT` trigger automatically derives `repository_id` from the analysis run snapshot, while a `BEFORE UPDATE` trigger guarantees immutability.
3. **Composite Foreign Key:** We dropped the single-column foreign key on `scenarios.target_node_id` and added `FOREIGN KEY (repository_id, target_node_id) REFERENCES graph_nodes(repository_id, id) ON DELETE CASCADE`.
4. **Concurrency & Locking:** PostgreSQL automatically takes a `FOR KEY SHARE` lock on the referenced `(repository_id, id)` tuple during scenario inserts and updates. This eliminates TOCTOU races where a node could be concurrently deleted or swapped.
5. **Non-Superuser Migration Safety:** Under `FORCE ROW LEVEL SECURITY`, table-owning migration roles evaluate RLS policies during backfill. We managed `NO FORCE RLS` during migration execution and reaffirmed `FORCE RLS` prior to commit, ensuring seamless deployment in least-privilege environments."

---

## 2. Visual Architecture & Schema Diagrams

```text
PRE-FIX 4 RELATIONAL TOPOLOGY (GAP)
┌────────────────┐                     ┌────────────────────┐
│  repositories  │◄─────[FK: repo]─────│     scenarios      │
└───────┬────────┘                     └─────────┬──────────┘
        │                                        │
        ▼ (3-step join)                          │ [FK: node] (independent!)
┌────────────────┐                     ┌─────────▼──────────┐
│  graph_nodes   │◄────────────────────┤  Can target node   │
│ (no repo_id!)  │                     │ from OTHER repo!   │
└────────────────┘                     └────────────────────┘

POST-FIX 4 COMPOSITE INTEGRITY
┌────────────────┐
│  repositories  │◄─────────────────────────────┐
└───────┬────────┘                              │
        │                                       │ [FK: repository_id]
        ▼                                       │ (direct cascade)
┌──────────────────────────────────────┐        │
│             graph_nodes              │        │
│  - id: uuid (PK)                     │        │
│  - repository_id: uuid (NOT NULL, FK)│        │
│  - UNIQUE (repository_id, id)        │◄──┐    │
└──────────────────────────────────────┘   │    │
                                           │    │
            [Composite Foreign Key]        │    │
   (repository_id, target_node_id) ────────┘    │
                                                │
┌──────────────────────────────────────┐        │
│              scenarios               │        │
│  - id: uuid (PK)                     │        │
│  - repository_id: uuid (NOT NULL) ───┴────────┘
│  - target_node_id: uuid (NOT NULL)
└──────────────────────────────────────┘
```

---

## 3. SQL Implementations

```sql
-- 1. Establish composite unique referenced key
ALTER TABLE public.graph_nodes
  ADD COLUMN IF NOT EXISTS repository_id uuid;

UPDATE public.graph_nodes gn
SET repository_id = rs.repository_id
FROM public.analysis_runs ar
JOIN public.repository_snapshots rs ON rs.id = ar.snapshot_id
WHERE ar.id = gn.analysis_run_id AND gn.repository_id IS NULL;

ALTER TABLE public.graph_nodes
  ALTER COLUMN repository_id SET NOT NULL;

ALTER TABLE public.graph_nodes
  ADD CONSTRAINT graph_nodes_repository_id_id_unique
  UNIQUE (repository_id, id);

-- 2. Establish composite foreign key on referencing table
ALTER TABLE public.scenarios
  DROP CONSTRAINT IF EXISTS scenarios_target_node_id_fkey;

ALTER TABLE public.scenarios
  ADD CONSTRAINT scenarios_repository_target_node_fkey
  FOREIGN KEY (repository_id, target_node_id)
  REFERENCES public.graph_nodes (repository_id, id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS scenarios_repository_target_node_idx
  ON public.scenarios (repository_id, target_node_id);
```

---

## 4. Senior & Staff Engineer Interview Q&A (15 Questions)

### Q1: Why couldn't we simply use a CHECK constraint on `scenarios`?
**Answer:** In ANSI SQL and PostgreSQL, `CHECK` constraints are strictly row-local scalar predicates. Subqueries are prohibited (`ERROR: cannot use subquery in check constraint`). A check constraint on `scenarios` cannot query `graph_nodes` or `analysis_runs` to verify parentage.

### Q2: Why wasn't application-layer validation (`nodeCheck`) sufficient?
**Answer:** Application-layer validation is advisory and non-atomic across multiple operations. It suffers from Time-of-Check to Time-of-Use (TOCTOU) races:
- If a target node is deleted or modified concurrently after `nodeCheck` runs but before `INSERT` executes, an invalid state is committed.
- Direct database writes (administrative scripts, data migrations, worker tasks) bypass application logic entirely.
- Database constraints represent the immutable source of truth; application validation is merely early client feedback.

### Q3: Why does PostgreSQL require `UNIQUE (repository_id, id)` on `graph_nodes` if `id` is already a globally unique primary key?
**Answer:** PostgreSQL enforces the SQL standard: a composite foreign key referencing $(A, B)$ must reference a target table that has a declared `PRIMARY KEY` or `UNIQUE` constraint on exactly $(A, B)$. Even though $B$ (`id`) is already unique, the database engine requires an index structured on $(A, B)$ to perform efficient, single-probe B-tree index lookups during foreign key validation on write operations.

### Q4: What index overhead did adding `UNIQUE (repository_id, id)` introduce?
**Answer:** Minimal to zero net overhead. In PostgreSQL, declaring `UNIQUE (repository_id, id)` automatically creates a unique B-tree index. Because `repository_id` is the leading column, this index can be used by the PostgreSQL query planner for any query filtering by `repository_id` (e.g. `SELECT * FROM graph_nodes WHERE repository_id = $1`), eliminating the need for a separate standalone index on `graph_nodes.repository_id`.

### Q5: How did we avoid breaking existing code that inserts into `graph_nodes` without passing `repository_id`, while preventing caller identity spoofing?
**Answer:** In Migration 0026, we added `trg_graph_nodes_set_repository_id`. However, an independent audit revealed that deriving `repository_id` only when `NEW.repository_id IS NULL` allowed callers to supply a forged `repository_id` that didn't match the analysis run. In forward-only migration 0027, we hardened the trigger: the database always resolves the authoritative `repository_id` from `analysis_runs` $\to$ `repository_snapshots`. If the caller passes a non-null `repository_id`, it is compared against the authoritative derived identity, and any mismatch is rejected with SQLSTATE `23000` (`integrity_constraint_violation`). Unresolvable analysis runs fail closed with SQLSTATE `23503`.

### Q6: Can a graph node's `repository_id` or `analysis_run_id` ever be updated? How is that enforced?
**Answer:** No. In Fluxora's architecture, graph nodes belong to immutable analysis runs. The initial trigger only checked `repository_id`, leaving `analysis_run_id` vulnerable to reassignment. In migration 0027, `trg_graph_nodes_prevent_repository_mutation` enforces immutability for **both** `repository_id` and `analysis_run_id` using `IS DISTINCT FROM` comparisons, raising SQLSTATE `23000` on any mutation attempt. Mutable attributes like `name` and `metadata` remain updateable.

### Q7: What are PostgreSQL's composite foreign key NULL semantics under `MATCH SIMPLE`?
**Answer:** Under default `MATCH SIMPLE`, if *any* column in the composite key is `NULL`, the entire foreign key validation is skipped. However, because both `scenarios.repository_id` and `scenarios.target_node_id` have column-level `NOT NULL` constraints, partial NULLs are impossible. Every scenario row must supply both values, and the joint pair is rigorously checked.

### Q8: What would happen if we used `ON DELETE SET NULL` on the composite foreign key?
**Answer:** Under default ANSI composite behavior, `ON DELETE SET NULL` sets *all* referencing columns to `NULL`, including `repository_id`. If `repository_id` is `NOT NULL`, the delete fails; if nullable, the scenario loses its repository association. In our domain, a scenario without a target node is meaningless, so `ON DELETE CASCADE` is the correct semantic behavior.

### Q9: Why did we retain the separate `scenarios_repository_id_fkey` constraint?
**Answer:** Defense-in-depth and deletion performance. If a repository is deleted, `scenarios_repository_id_fkey` directly cascades the deletion of scenarios without relying solely on cascading through `graph_nodes`. Furthermore, it keeps the relationship to `repositories` explicit in the database schema.

### Q10: How does PostgreSQL handle concurrency during scenario inserts?
**Answer:** When a transaction inserts into `scenarios`, PostgreSQL acquires a `FOR KEY SHARE` lock on the referenced row in `graph_nodes`. This lock allows concurrent reads and other scenario inserts referencing the same node, but blocks concurrent `DELETE` or `UPDATE` of the key columns of that node until the inserting transaction commits or aborts.

### Q11: What happened when we tested concurrent Tx 1 (Insert Scenario) vs Tx 2 (Delete Node)?
**Answer:**
1. If Tx 1 inserts first (uncommitted), Tx 2's `DELETE` blocks waiting on Tx 1's `KEY SHARE` lock. When Tx 1 commits, Tx 2 resumes and cascades the delete, removing the newly inserted scenario.
2. If Tx 2 deletes first (uncommitted), Tx 1's `INSERT` blocks waiting on Tx 2's exclusive lock. When Tx 2 commits, Tx 1 resumes, detects that the referenced tuple is gone, and aborts with error `23503` (`foreign_key_violation`). In neither case can an invalid relation persist.

### Q12: Why did `security-definer-hardening.test.ts` fail initially during Migration 0026 testing?
**Answer:** Under `FORCE ROW LEVEL SECURITY`, even the table owner is subject to RLS policies. The non-superuser migration role (`TEST_MIGRATOR_ROLE`) attempted to update `graph_nodes`, which evaluated `fluxora_analysis_run_in_current_tenant`. Because Fix 3 revoked public execute on tenant helpers, the migration role was denied permission. We resolved this by having the migration role execute `NO FORCE RLS` during migration execution and reaffirming `FORCE RLS` at commit.

### Q13: Why did `security-definer-hardening.test.ts` fail with "22 !== 20" functions?
**Answer:** The test verifies that exactly 20 `SECURITY DEFINER` functions exist in the database (Fix 1, 2, and 3). We initially declared the two new trigger functions with `SECURITY DEFINER`. Trigger functions do not need elevated privileges because triggers run in the security context of the operation; removing `SECURITY DEFINER` restored the invariant.

### Q14: How does Migration 0026 ensure a fail-closed upgrade?
**Answer:** Before altering any table or creating constraints, an anonymous `DO $$` block executes an audit query. If any scenario exists where `target_node_id` belongs to a different repository, or any node lacks a repository, the block raises a `check_violation` exception with detailed mismatch counts, aborting the entire migration transaction.

### Q15: How did we optimize the application code in `simulation.ts`?
**Answer:** We replaced a 3-table join query (`SELECT ... FROM graph_nodes gn JOIN analysis_runs ar JOIN repository_snapshots rs ...`) with a direct single-table query:
```sql
SELECT id FROM graph_nodes WHERE id = $1::uuid AND repository_id = $2::uuid
```
This queries the newly indexed composite key directly, improving query execution time while keeping PostgreSQL as the authoritative enforcer.

### Q16: How can a composite foreign key still fail to guarantee business-level ownership if the referenced column can be forged?
**Answer:** A composite foreign key only guarantees that the tuple $(A, B)$ in the child table matches a tuple $(A, B)$ in the parent table. If the parent table's ownership column $A$ (`graph_nodes.repository_id`) can be forged at insert time or mutated on update, the child table's composite foreign key will happily link to forged data. Referential integrity requires that parent ownership is authoritatively derived by the database, caller-supplied ownership IDs are validated rather than trusted, and parent lineage keys are strictly immutable.

### Q17: Why must destructive tests run against a dedicated disposable database rather than `fluxora_dev`?
**Answer:** Running destructive migrations or test fixtures against `localhost:5432/fluxora_dev` pollutes local development data, creates flaky cross-test side effects, and risks catastrophic data loss. By using a disposable test database framework (`packages/db/src/testing/test-database.ts`), tests dynamically create and tear down isolated databases (`fluxora_fix4_test`), strictly validating that targets are local test databases and explicitly rejecting development (`*_dev`) and production databases.

### Q18: How do we verify concurrency deterministically without relying on timing or sleep assumptions?
**Answer:** Relying on `assert(txFinished === false)` immediately after launching an asynchronous promise can pass simply because of Node.js event-loop microtask scheduling. To prove true PostgreSQL lock contention, our concurrency tests query `pg_locks` for the contending backend's PID to confirm `NOT granted` (or inspect `pg_stat_activity` for `wait_event_type = 'Lock'`). Only after physically observing the lock wait in PostgreSQL does the test proceed to commit the blocking transaction.

---

## 5. Production Readiness & Deployment Checklist

- [x] Forward-only migration (`0026_scenario_repository_referential_integrity.sql`)
- [x] Forward-only follow-up migration (`0027_graph_node_lineage_integrity.sql`)
- [x] Fail-closed pre-migration data audit for mismatches and orphans
- [x] Denormalized `repository_id` column with `NOT NULL` and foreign key
- [x] Composite unique constraint `UNIQUE (repository_id, id)` on `graph_nodes`
- [x] Composite foreign key `FOREIGN KEY (repository_id, target_node_id) REFERENCES graph_nodes(repository_id, id)`
- [x] Authoritative derivation trigger with caller mismatch rejection (SQLSTATE `23000`)
- [x] Dual immutability trigger preventing `repository_id` AND `analysis_run_id` mutation (SQLSTATE `23000`)
- [x] Pinned `search_path = pg_catalog, public` and `SECURITY INVOKER` on trigger functions
- [x] Composite index `(repository_id, target_node_id)` on `scenarios`
- [x] `FORCE ROW LEVEL SECURITY` reaffirmed across all tables
- [x] Dedicated disposable test database isolation framework (`fluxora_fix4_test`)
- [x] Deterministic concurrency verification via `pg_locks` (`waitForLockWait`)
- [x] Comprehensive test coverage: 30 integration tests + 8 migration tests passing
- [x] Regression testing: All package test suites clean
- [x] Workspace typecheck (0 errors) and ESLint (0 errors) clean
