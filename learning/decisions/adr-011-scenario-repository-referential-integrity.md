# ADR-011: Composite Foreign Key for Scenario and Repository Referential Integrity

**Status:** Accepted & Implemented (Fix 4 / Migration 0026)
**Date:** November 2026
**Context:** Production Hardening (Database Referential Integrity)

---

## 1. Context and Problem Statement

In Fluxora's architecture, a `Scenario` defines a what-if hypothesis against an immutable software architecture graph. Each scenario specifies a target repository (`repository_id`) and a target graph node (`target_node_id`).

Prior to Fix 4, the `scenarios` table had independent, single-column foreign keys:
- `repository_id REFERENCES repositories(id)`
- `target_node_id REFERENCES graph_nodes(id)`

These constraints established that both referenced records existed, but did **not** establish that the selected target graph node belonged to the selected repository. While the application layer performed a 3-way join check on scenario creation, the database engine itself did not reject an invalid pairing. This exposed the system to:
- Time-of-Check to Time-of-Use (TOCTOU) races in concurrent transactions.
- Bypassed validation via direct SQL or background scripts.
- Unvalidated `UPDATE` operations modifying `target_node_id` or `repository_id`.
- Simulation corruption where failures in Repository A propagate across nodes in Repository B.

---

## 2. Decision

We enforce the scenario-to-repository-to-graph-node relationship directly in PostgreSQL using a **composite foreign key**:

```sql
ALTER TABLE public.scenarios
  ADD CONSTRAINT scenarios_repository_target_node_fkey
  FOREIGN KEY (repository_id, target_node_id)
  REFERENCES public.graph_nodes (repository_id, id)
  ON DELETE CASCADE;
```

To support this composite foreign key:
1. **Denormalize `repository_id` onto `graph_nodes`:** Add `repository_id uuid NOT NULL` to `graph_nodes`, backfilled from `analysis_runs` $\to$ `repository_snapshots` $\to$ `repositories`.
2. **Add Composite Unique Constraint:** Define `CONSTRAINT graph_nodes_repository_id_id_unique UNIQUE (repository_id, id)` on `graph_nodes`.
3. **Preserve Backward Compatibility & Lineage Integrity via Triggers:**
   - Deploy `BEFORE INSERT` trigger `trg_graph_nodes_set_repository_id` to authoritatively resolve `repository_id` from `analysis_runs` $\to$ `repository_snapshots`. In follow-up migration `0027_graph_node_lineage_integrity.sql`, explicitly supplied, non-null `repository_id` values are validated against the derived authority; mismatches are rejected with SQLSTATE `23000` (`integrity_constraint_violation`), and unresolvable analysis runs fail closed with SQLSTATE `23503` (`foreign_key_violation`).
   - Deploy `BEFORE UPDATE` trigger `trg_graph_nodes_prevent_repository_mutation` to guarantee immutability for **both** `repository_id` and `analysis_run_id` (raising SQLSTATE `23000` if mutated).
   - Functions remain `SECURITY INVOKER` with pinned `search_path = pg_catalog, public`, respecting tenant RLS boundaries without information disclosure.
4. **Fail-Closed Migration Audit:** Verify zero orphaned nodes and zero mismatched scenarios before applying schema mutations.
5. **Add Supporting Composite Index:** Add `scenarios_repository_target_node_idx ON scenarios (repository_id, target_node_id)`.
6. **Enforce Test Database Isolation:** Restrict destructive and migration testing to dedicated disposable test databases (`fluxora_fix4_test`), forbidding execution against `fluxora_dev` or production, and replacing timing-based concurrency assertions with deterministic `pg_locks` lock-wait checks.

---

## 3. Alternatives Considered

### Alternative A: Application-Level Validation Only
- **Description:** Retain independent foreign keys and rely on `nodeCheck` query in `createScenario`.
- **Why Rejected:** Advisory only. Does not protect against direct SQL mutations, administrative tools, background jobs, or concurrent TOCTOU races. Does not validate `UPDATE` operations unless duplicated across every update path.

### Alternative B: Subquery Check Constraint
- **Description:** Add `CHECK (repository_id = (SELECT repository_id FROM ...))` on `scenarios`.
- **Why Rejected:** PostgreSQL explicitly forbids subqueries in `CHECK` constraints (`ERROR: cannot use subquery in check constraint`).

### Alternative C: BEFORE INSERT / UPDATE Trigger on `scenarios`
- **Description:** Implement a PL/pgSQL trigger on `scenarios` that executes a lookup query on write.
- **Why Rejected:** Triggers do not establish declarative foreign-key metadata in the catalog, do not automatically acquire `FOR KEY SHARE` row locks during transactions, and require manual maintenance of cascade behavior.

### Alternative D: Trusting Caller-Supplied `repository_id` on INSERT
- **Description:** Derive `repository_id` only when `NEW.repository_id IS NULL`, trusting any explicitly passed non-null value.
- **Why Rejected:** Allows database callers to forge or spoof repository identity, associating an analysis run from Repository A with Repository B at the node boundary. Corrected in forward-only migration 0027.

---

## 4. Consequences and Trade-offs

### Positive
- **Guaranteed Invariant:** An invalid scenario-repository pair is rejected by the database storage engine for all `INSERT` and `UPDATE` operations.
- **Lineage Integrity at Boundary:** `graph_nodes.repository_id` cannot be spoofed on INSERT, nor can `repository_id` or `analysis_run_id` be modified on UPDATE.
- **Concurrency Safety:** Concurrent writes acquire row-level locks, eliminating TOCTOU races, verified via deterministic `pg_locks` lock-wait inspection.
- **Zero Ingestion Breaking Changes:** Automated derivation trigger allows existing graph builders and workers to continue inserting without schema modifications.
- **Index Optimization:** Leading `repository_id` in `UNIQUE (repository_id, id)` accelerates repository-filtered graph queries.
- **Performance:** `createScenario` validation query simplified from a 3-table join to a single-table indexed check.

### Negative / Trade-offs
- **Denormalization:** `graph_nodes` now stores `repository_id` in addition to `analysis_run_id` (16 bytes per row). Given graph node immutability, this redundancy is strictly controlled and validated by foreign keys and triggers.
- **Trigger Overhead:** A lightweight `BEFORE INSERT` check executes on graph node ingestion.

---

## 5. Rollout and Verification

- **Migrations:** `0026_scenario_repository_referential_integrity.sql` and forward-only follow-up `0027_graph_node_lineage_integrity.sql` applied cleanly in sequence.
- **Test Database Isolation:** Executed against dedicated disposable test database `fluxora_fix4_test` with strict host and naming guards.
- **Integration Tests:** 30 dedicated tests in `scenario-referential-integrity.test.ts` (including spoofing rejection, dual immutability, deterministic lock waits, and RLS checks) and 8 migration tests in `scenario-referential-integrity-migration.test.ts`.
- **Regression:** Full `@fluxora/db` suite, `typecheck` (0 errors), `lint` (0 errors), and `lint:evidence` (verified).
