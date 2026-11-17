# Fix 4 Technical Notes: Scenario and Repository Referential Integrity

These technical learning notes examine database-level integrity design, composite foreign keys, concurrency mechanics, and PostgreSQL constraint architecture using real examples from the Fluxora codebase.

---

## 1. Single-Column vs. Composite Foreign Keys

### 1.1 The Single-Column Fallacy

A common database modeling mistake is assuming that multiple independent foreign keys enforce cross-column relationship invariants.

Consider the pre-Fix 4 `scenarios` table:
```sql
CREATE TABLE scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  target_node_id uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  ...
);
```

What does PostgreSQL actually verify when an insert occurs?
1. Does the provided `repository_id` exist in `repositories.id`? (Yes $\to$ Pass).
2. Does the provided `target_node_id` exist in `graph_nodes.id`? (Yes $\to$ Pass).

PostgreSQL verifies **existence in isolation**. It does **not** check whether `target_node_id` is an entity that was produced by, or belongs to, `repository_id`.

```text
┌────────────────────────────────────────────────────────┐
│ Independent Foreign Keys:                              │
│   Scenario S.repository_id = Repo A                    │
│   Scenario S.target_node_id = Node B                   │
│                                                        │
│ PostgreSQL checks:                                     │
│   1. Repo A exists in repositories?     -> TRUE        │
│   2. Node B exists in graph_nodes?      -> TRUE        │
│   Constraint evaluation:                -> PASS        │
│                                                        │
│ Reality:                                               │
│   Node B was analyzed from Repo B, not Repo A!         │
│   Referential integrity invariant is VIOLATED!         │
└────────────────────────────────────────────────────────┘
```

### 1.2 The Composite Foreign Key Solution

A composite foreign key spans multiple columns in both the referencing and referenced tables:
```sql
ALTER TABLE scenarios
  ADD CONSTRAINT scenarios_repository_target_node_fkey
  FOREIGN KEY (repository_id, target_node_id)
  REFERENCES graph_nodes (repository_id, id)
  ON DELETE CASCADE;
```

With this composite key, PostgreSQL checks the joint tuple:
$$(\text{repository\_id}, \text{target\_node\_id}) \in \text{graph\_nodes}(\text{repository\_id}, \text{id})$$

If `target_node_id` has `repository_id = Repo B`, then the tuple `(Repo A, Node B)` does **not exist** in `graph_nodes`, and PostgreSQL immediately rejects the operation with error code `23503` (`foreign_key_violation`).

---

## 2. Composite Uniqueness Requirements in PostgreSQL

In SQL-92/SQL:1999 standard and PostgreSQL:
> **Rule:** A foreign key that references multiple columns $(c_1, c_2, \dots, c_k)$ in table $T$ requires that table $T$ possesses an explicit `UNIQUE` or `PRIMARY KEY` constraint on $(c_1, c_2, \dots, c_k)$.

Even if column $c_2$ (`id`) is already globally unique and the primary key of `graph_nodes`, PostgreSQL **will not allow** `FOREIGN KEY (repository_id, target_node_id) REFERENCES graph_nodes(repository_id, id)` unless `graph_nodes` defines:
```sql
CONSTRAINT graph_nodes_repository_id_id_unique UNIQUE (repository_id, id)
```

### Why does PostgreSQL mandate this?
1. **Query Plan Efficiency:** Foreign key checks occur on every write (`INSERT`, `UPDATE`, `DELETE`). The storage engine needs a guaranteed unique B-tree index on the referenced column combination to perform single-probe index lookups without scanning rows.
2. **Deterministic Cardinality:** The database must guarantee that a referencing tuple matches at most one referenced row.

### Index Optimization Payoff
By placing `repository_id` as the leading column in `UNIQUE (repository_id, id)` on `graph_nodes`, the underlying B-tree index doubles as an index for:
```sql
SELECT * FROM graph_nodes WHERE repository_id = $1;
```
This eliminated the need for a separate standalone index on `graph_nodes.repository_id`.

---

## 3. PostgreSQL MATCH Types and NULL Semantics

Composite foreign keys have nuanced behavior when columns are nullable. PostgreSQL supports three ANSI MATCH options:

1. **`MATCH SIMPLE` (PostgreSQL Default):**
   If *any* referencing column in the composite key is `NULL`, the entire foreign key check is skipped (treated as valid).
   *Example:* `(Repo A, NULL)` is accepted even if Repo A does not exist.
2. **`MATCH FULL`:**
   Requires either *all* referencing columns to be non-null, or *all* referencing columns to be `NULL`. A partial null like `(Repo A, NULL)` is rejected.
3. **`MATCH PARTIAL`:**
   Allows partial nulls, but non-null columns must match a subset in the referenced table (rarely implemented in RDBMS engines).

### Application to Fluxora
In Fluxora's schema, both `scenarios.repository_id` and `scenarios.target_node_id` are defined as `NOT NULL`:
- A scenario without a repository cannot exist.
- A scenario without a target node cannot exist.

Because both columns have column-level `NOT NULL` constraints, `MATCH SIMPLE` behaves identically to strict validation: every row must supply both columns, and both columns must exist as a joint pair in `graph_nodes`.

---

## 4. ON DELETE and ON UPDATE Semantics

When designing a composite foreign key, deletion and update actions apply to the entire referencing tuple unless column-specific syntax is used:

### 4.1 Danger of Default `ON DELETE SET NULL`
If a composite key is defined with `ON DELETE SET NULL`:
```sql
-- DANGEROUS IF REPOSITORY MUST BE PRESERVED:
FOREIGN KEY (repository_id, target_node_id)
REFERENCES graph_nodes (repository_id, id)
ON DELETE SET NULL
```
When the referenced node is deleted, PostgreSQL sets **both** `target_node_id` **and** `repository_id` to `NULL`. If `repository_id` has a `NOT NULL` constraint, the delete fails; if it is nullable, the scenario loses its repository association!

In PostgreSQL 15+, column-specific `ON DELETE SET NULL (target_node_id)` is supported, allowing only specific columns to be cleared.

### 4.2 Fluxora's Deletion Architecture
In Fluxora, deleting a target node invalidates the scenario hypothesis. Therefore, `ON DELETE CASCADE` is the correct domain behavior:
- Deleting `graph_nodes` row $\to$ Cascades and deletes the referencing `scenarios` row.
- Deleting `repositories` row $\to$ Cascades and deletes both `graph_nodes` and `scenarios`.
- Independent foreign key `scenarios_repository_id_fkey REFERENCES repositories(id) ON DELETE CASCADE` is retained as defense-in-depth.

---

## 5. Foreign-Key Concurrency and Row Locking

Database-level foreign keys provide guarantees that application code cannot match under concurrent workloads.

### 5.1 Lock Modes: `FOR KEY SHARE` vs `FOR UPDATE`

When Transaction 1 executes:
```sql
INSERT INTO scenarios (repository_id, target_node_id, ...)
VALUES ('repo-1', 'node-1', ...);
```
PostgreSQL automatically acquires a **`FOR KEY SHARE`** lock on the referenced row in `graph_nodes ('repo-1', 'node-1')`.

| Lock Held on Referenced Row | Allowed Concurrent Operations | Blocked Concurrent Operations |
|-----------------------------|-------------------------------|-------------------------------|
| `FOR KEY SHARE` (by Tx 1)   | `SELECT`, concurrent `FOR KEY SHARE` (other scenario inserts referencing the same node), non-key `UPDATE` | `DELETE` of `node-1`, `UPDATE` of `node-1` key columns (`id`, `repository_id`) |

### 5.2 Race Scenario 1: Insert vs. Concurrent Delete

```text
Time   Transaction 1 (Insert Scenario)       Transaction 2 (Delete Node)
────────────────────────────────────────────────────────────────────────────
t1     BEGIN;
t2     INSERT INTO scenarios (node-1)...
       [Takes FOR KEY SHARE on node-1]
t3                                           BEGIN;
t4                                           DELETE FROM graph_nodes WHERE id = node-1;
                                             [BLOCKS waiting for Tx 1 lock release]
t5     COMMIT;
                                             [Tx 2 UNBLOCKS and executes DELETE]
t6                                           COMMIT;
                                             [CASCADE deletes Scenario from t2]
```
**Outcome:** No orphaned or invalid state is ever committed.

### 5.3 Race Scenario 2: Uncommitted Delete vs. Insert

```text
Time   Transaction 2 (Delete Node)           Transaction 1 (Insert Scenario)
────────────────────────────────────────────────────────────────────────────
t1     BEGIN;
t2     DELETE FROM graph_nodes WHERE id = 1;
       [Takes Exclusive lock on node-1]
t3                                           BEGIN;
t4                                           INSERT INTO scenarios (node-1)...
                                             [BLOCKS waiting for Tx 2]
t5     COMMIT;
                                             [Tx 1 UNBLOCKS, sees row is gone]
                                             [FAILS with 23503 foreign_key_violation]
```
**Outcome:** PostgreSQL strictly prevents the insertion of a scenario pointing to a deleted node. Application code without explicit pessimistic locks would have suffered a TOCTOU race.

---

## 6. Database Constraints vs. Application Validation

| Dimension | Application-Level Validation (`nodeCheck`) | Database-Level Constraint (`scenarios_repository_target_node_fkey`) |
|---|---|---|
| **Authority** | Advisory (client-side check) | Authoritative (storage engine) |
| **Race Resistance** | Vulnerable to TOCTOU races | Atomic, enforced under transaction locks |
| **Bypass Surface** | Bypassed by direct SQL, workers, background migrations, scripts | Impossible to bypass without altering schema |
| **UPDATE Coverage** | Often omitted on update endpoints | Evaluated on every `INSERT` and `UPDATE` |
| **Performance** | Extra network round-trip query | Evaluated locally during write via unique index |

**Best Practice:** Use application validation as a helpful user-facing error generator, but keep PostgreSQL as the authoritative gatekeeper. Wrap database operations to translate constraint violations (`23503`) into domain errors so internal SQL details are never exposed to clients.

---

## 7. Tenant Isolation vs. Referential Integrity

It is crucial to distinguish **tenant isolation** from **referential integrity**:

- **Referential Integrity:** Guarantees that Entity A and Entity B satisfy relational invariants (e.g., target node $N$ belongs to repository $R$).
- **Tenant Isolation:** Guarantees that Tenant 1 cannot observe, modify, or infer data belonging to Tenant 2.

A composite foreign key between `scenarios` and `graph_nodes` guarantees that a scenario cannot reference a node from another repository. However, it does not replace Row-Level Security (RLS).

In Fluxora:
1. `FORCE ROW LEVEL SECURITY` ensures that Tenant A can only query or insert scenarios where `organization_id = fluxora_current_org_id()`.
2. The composite foreign key ensures that within that organization (or across any boundary), a scenario cannot connect a repository to an unrelated graph node.
3. Defense-in-depth: Even if an RLS policy had a bug or a service role bypassed tenant filtering, the composite foreign key prevents cross-repository pollution.

---

## 8. Why a Composite Foreign Key Alone Can Still Fail (Engineering Learnings)

A critical engineering insight from the Fix 4 hardening process is:

> **A composite foreign key guarantees relational alignment between the referencing table and the referenced table, but it does NOT guarantee business-level truth if the referenced table's ownership column can be forged, or if its parent lineage can be mutated after insertion.**

### 8.1 The Identity Spoofing Defect (Defect 1)
In Migration 0026, the trigger derived `graph_nodes.repository_id` only when `NEW.repository_id IS NULL`. If a database caller explicitly passed a non-null `repository_id = Repo B` alongside an `analysis_run_id` belonging to `Repo A`:
1. The trigger skipped derivation and accepted the caller's value.
2. The node was committed with `analysis_run_id = Run A` (Repo A) but `repository_id = Repo B`.
3. When a scenario was subsequently created in Repo B referencing that node, the composite foreign key check `(Repo B, Node) IN graph_nodes(repository_id, id)` **succeeded**, because PostgreSQL trusted the stored `graph_nodes.repository_id`!
4. **Resolution (Migration 0027):** The database must derive authoritative identity independently. A caller-supplied repository ID is a value to validate, never an authority. Any mismatch is rejected with SQLSTATE `23000`.

### 8.2 The Lineage Mutation Defect (Defect 2)
The original UPDATE trigger only checked `NEW.repository_id IS DISTINCT FROM OLD.repository_id`. It did not guard `analysis_run_id`.
If an UPDATE modified `analysis_run_id` to point to a run from another repository (or another run within the same repository):
1. `repository_id` remained unchanged, so the trigger passed.
2. The node's lineage was severed from its stored repository identity.
3. **Resolution (Migration 0027):** Both lineage fields (`repository_id` and `analysis_run_id`) are immutable after creation using `IS DISTINCT FROM` comparisons, rejecting mutations with SQLSTATE `23000`.

### 8.3 Upstream Lineage Verification
For the invariant `graph_nodes.repository_id = repository_snapshots.repository_id` to hold permanently, the upstream chain (`analysis_runs.snapshot_id` $\to$ `repository_snapshots.repository_id`) must also remain immutable. In Fluxora, inspection confirmed that `snapshot_id` and `repository_id` on upstream entities are write-once parent identities never updated in application or worker code.

### 8.4 Test Database Isolation & Deterministic Concurrency
1. **Isolation:** Destructive and migration tests must never execute against development (`fluxora_dev`) or production databases. A dedicated disposable test database framework (`packages/db/src/testing/test-database.ts`) enforces strict naming rules (`fluxora_fix4_test`), verifies approved local hosts, and isolates test side effects.
2. **Deterministic Synchronization:** Concurrency assertions must never rely on JavaScript scheduling or sleep statements (`assert(txFinished === false)` immediately after launch). Instead, deterministic lock waits verify in PostgreSQL's `pg_locks` that the contending backend PID has `NOT granted`, physically confirming that PostgreSQL is holding the transaction in a row lock wait before proceeding.
