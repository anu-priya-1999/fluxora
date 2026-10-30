# Fluxora Engineering Learning Repository

This directory serves as the engineering notebook, technical design journal, and interview preparation archive for the Fluxora platform.

---

## 1. Directory Structure

```text
learning/
├── implementations/          # Step-by-step engineering implementation reports
│   ├── phase-01/             # Foundation: monorepo, DB, auth, Clerk, S3/Redis, worker harness, OTel, CI/CD, docker-compose
│   ├── phase-02/             # Repository Ingestion: GitHub App, snapshots, commits, S3 packaging, events, failure paths
│   ├── phase-03/             # Code Intelligence: language detection, AST symbols, import/export graph, routes, DB refs
│   ├── phase-04/             # Graph: GraphNode/Edge/Evidence, GraphBuilder, traversal, query API, outbox diffs
│   ├── phase-05/             # Architecture UI: React Flow canvas, explorer, inspector, filters, clustering, WebSockets
│   ├── phase-06/             # PR Impact Analysis: webhook handling, diff storage, impact engine, change overlay
│   ├── phase-07/             # Evidence Engine: completeness audit, clickable citations, confidence weighting, coverage view
│   ├── phase-08/             # Simulation: persistence, deterministic rule-table, propagation engine, APIs, studio UI
│   ├── production-hardening/ # Cross-cutting Production Hardening: Fix 1 (job queue RLS) & Fix 2 (worker crash recovery)
│   └── infrastructure/       # Cross-cutting infrastructure migrations (e.g. Vitest test runner migration)
├── notes/                    # In-depth technical learning notes and architectural concepts
└── interviews/               # Senior/staff engineer interview cheat sheets, Q&A guides, and trade-off analyses
```

---

## 2. Cross-cutting Production Hardening

Fix 1 and Fix 2 are completed engineering hardening tasks associated with the job queue and worker infrastructure. These cross-cutting engineering fixes harden multi-tenant security, least-privilege role boundaries, crash resilience, invariant enforcement, and migration backward-compatibility.

> [!NOTE]
> These production hardening tasks address critical database and worker infrastructure invariants discovered during production engineering reviews. They are tracked as cross-cutting infrastructure hardening and are kept separate from the numbered roadmap phases (and must not be confused with or labeled as Phase 11, which remains an independent future roadmap milestone).

### Document Directory by Category

#### Implementation Reports
- **Fix 1 — Job Queue Least-Privilege RLS & Worker Authorization:**<br>
  [`learning/implementations/production-hardening/fix-01-job-queue-least-privilege-rls.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/learning/implementations/production-hardening/fix-01-job-queue-least-privilege-rls.md)<br>
  *Covers threat modeling, `fluxora_queue` role attribute verification, column-specific grants, `SECURITY DEFINER` function lifecycle, atomic 4-parameter retry authorization, `withWorkerClient` connection pool hygiene, and host allowlist validation.*
- **Fix 2 — Worker Crash Recovery, Retry Limits & Migration Compatibility:**<br>
  [`learning/implementations/production-hardening/fix-02-worker-crash-recovery.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/learning/implementations/production-hardening/fix-02-worker-crash-recovery.md)<br>
  *Covers silent worker crashes vs. reported failures, bounded batch sweeper (`FOR UPDATE SKIP LOCKED LIMIT 25`), table CHECK constraint `attempt_count <= max_attempts`, non-superuser legacy reconciliation under forced RLS, dual-limit architecture (`configured_max_attempts` vs `max_attempts`), trigger guard immutability, and historical 386-line candidate compatibility testing.*

#### Technical Learning Notes
- **Fix 1 Technical Notes:**<br>
  [`learning/notes/Fix-01-Job-Queue-Least-Privilege-RLS.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/learning/notes/Fix-01-Job-Queue-Least-Privilege-RLS.md)<br>
  *Deep dive into PostgreSQL RLS mechanics, permissive policy OR-combination, superuser test masking, search path injection prevention, connection pool tainting, and destructive test guardrails.*
- **Fix 2 Technical Notes:**<br>
  [`learning/notes/Fix-02-Worker-Crash-Recovery-And-Retry-Limits.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/learning/notes/Fix-02-Worker-Crash-Recovery-And-Retry-Limits.md)<br>
  *Deep dive into attempt count semantic definitions, bounded sweeper concurrency, non-superuser transaction-scoped migration policies, honest representation of historical uncertainty (`NULL`), trigger guards vs column defaults, and PostgreSQL function return table upgrade rules.*

#### Interview Preparation
- **Fix 1 Interview Cheat Sheet:**<br>
  [`learning/interviews/Fix 1 Job Queue Least Privilege RLS Interview CheatSheet.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/learning/interviews/Fix%201%20Job%20Queue%20Least%20Privilege%20RLS%20Interview%20CheatSheet.md)<br>
  *Layman analogy ("Safe Deposit Box vs. Armored Car"), 30-second elevator pitch, staff-level Q&A, SQL patterns, architectural traps, and production readiness checklist.*
- **Fix 2 Interview Cheat Sheet:**<br>
  [`learning/interviews/Fix 2 Worker Crash Recovery and Retry Limits Interview CheatSheet.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/learning/interviews/Fix%202%20Worker%20Crash%20Recovery%20and%20Retry%20Limits%20Interview%20CheatSheet.md)<br>
  *Layman analogy ("Rental Car & Tow Truck"), 30-second elevator pitch, staff-level concurrency and queue Q&A, state machine diagram, operational vs configured limit trade-offs, and historical candidate verification caveats.*

---

### Engineering Fix Details

#### Fix 1 — Job Queue Least-Privilege RLS & Worker Authorization
Covers migrations `0020_job_queue_least_privilege_rls.sql` and `0021_job_queue_hardening.sql`, establishing global worker claiming under `FORCE ROW LEVEL SECURITY` without granting superuser or `BYPASSRLS` privileges.

Key engineering highlights:
1. **Dedicated Role Governance:** Enforces a dedicated `NOLOGIN` role `fluxora_queue` with all 7 privilege attributes disabled (`NOLOGIN`, `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, `NOBYPASSRLS`, `NOINHERIT`, `NOREPLICATION`), verified by migration 0021.
2. **Column-Specific Grants:** Table permissions on `public.jobs` restricted to `SELECT` and column-level `UPDATE` on mutable lifecycle columns only (`status`, `locked_by`, `locked_at`, `lease_expires_at`, `attempt_count`, `available_at`, `last_error`, `completed_at`, `failed_at`).
3. **Atomic 4-Parameter Retry:** Replaced unauthenticated 2-parameter retry with `fluxora_retry_failed_job(p_job_id, p_worker_id, p_retry_delay_seconds, p_error)` verifying active worker lease ownership.
4. **Connection Pool Hygiene:** `withWorkerClient` prevents connection leaks, validates role regex pre-checkout, and evicts tainted clients via `client.release(err)` on `RESET ROLE` failures.

#### Fix 2 — Worker Crash Recovery, Retry Limits & Migration Compatibility
Covers migrations `0022_job_queue_crash_recovery_retry_limit.sql`, `0023_job_queue_attempt_count_invariant.sql`, and `0024_job_queue_configured_retry_limit.sql`, establishing database-level crash recovery, table-level upper-bound constraints, dual-limit audit preservation, and historical candidate backward compatibility.

Key engineering highlights:
1. **Bounded Batch Sweeper:** Inside `fluxora_claim_next_job`, a bounded batch update (`FOR UPDATE SKIP LOCKED LIMIT 25`) transitions expired running jobs that reached `max_attempts` directly to `dead_letter`, preventing infinite crash loops without blocking concurrent workers.
2. **Physical Constraint Invariant:** Enforces `0 <= attempt_count <= max_attempts` via table CHECK constraint `jobs_attempt_count_le_max_attempts`.
3. **Transaction-Scoped Migration Policies:** Non-superuser migrations under `FORCE ROW LEVEL SECURITY` reconcile cross-tenant legacy rows using temporary `FOR ALL TO CURRENT_USER` policies dropped prior to commit.
4. **Dual-Limit Architecture & Trigger Guards:** Forward-only migration 0024 introduces `configured_max_attempts` with `NULL` indicating unprovable historical limits, guarded by immutable trigger `fluxora_jobs_retry_limits_guard`.
5. **Historical 386-Line Candidate Compatibility:** Cautiously treats the archived 386-line migration candidate as a historical candidate (not proven provenance for `fluxora_dev`), verified via backward-compatibility suite in `packages/db/src/migrate/job-queue-rls-migration.test.ts`.

---

## 3. Canonical Architecture Cross-References

- **Implementation Snapshot:** [`docs/DESIGN.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/docs/DESIGN.md) (living snapshot of current state, active constraints, and verification results).
- **Implementation Roadmap:** [`docs/architecture/17-implementation-roadmap.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/docs/architecture/17-implementation-roadmap.md) (phase definitions and step sequencing).
- **Database Schema:** [`docs/architecture/06-database-schema.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/docs/architecture/06-database-schema.md) (relational models and RLS policies).
- **Security Architecture:** [`docs/architecture/11-security-architecture.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/docs/architecture/11-security-architecture.md) (sandboxing, least-privilege roles, and tenant boundaries).
