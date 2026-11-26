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
│   ├── phase-08/             # Simulation: persistence, deterministic rule-table, propagation engine, APIs, studio UI, simulation mode overlay
│   ├── production-hardening/ # Cross-cutting Production Hardening: Fix 1 (job queue RLS), Fix 2 (worker crash recovery), Fix 3 (SECURITY DEFINER hardening), Fix 4 (scenario referential integrity)
│   └── infrastructure/       # Cross-cutting infrastructure migrations (e.g. Vitest test runner migration)
├── decisions/                # Architectural Decision Records (ADRs)
├── notes/                    # In-depth technical learning notes and architectural concepts
└── interviews/               # Senior/staff engineer interview cheat sheets, Q&A guides, and trade-off analyses
```

### Learning Notes Numbering Convention

- **Foundational Series (Notes 1–6):** Cover foundational architecture, backend, database, infrastructure, job queues, and OpenTelemetry observability (Phase 1).
- **Roadmap Step Alignment (Notes 8–60+):** From Global Step 8 onward, the filename prefix matches the corresponding Global Step number.
- **Global Step 7:** Has no separate numbered note because its material (OpenTelemetry) is covered in foundational Note 6 (`6. OpenTelemetry Observability.md`).
- **Cross-cutting Notes:** Engineering hardening tasks (`Fix-01` through `Fix-04`) and infrastructure migrations (`Vitest Migration`) retain descriptive filenames and are not part of the numbered sequence.

---

## 2. Cross-cutting Production Hardening

Fix 1, Fix 2, Fix 3, and Fix 4 are completed engineering hardening tasks associated with database security, job queue, worker infrastructure, and relational referential integrity. These cross-cutting engineering fixes harden multi-tenant security, least-privilege role boundaries, crash resilience, invariant enforcement, migration backward-compatibility, `SECURITY DEFINER` privilege boundaries, and database-level foreign key invariants.

> [!NOTE]
> These production hardening tasks address critical database and worker infrastructure invariants discovered during production engineering reviews. They are tracked as cross-cutting infrastructure hardening and are kept separate from the numbered roadmap phases (and must not be confused with or labeled as Phase 11, which remains an independent future roadmap milestone).

### Document Directory by Category

#### Implementation Reports
- **Fix 1 — Job Queue Least-Privilege RLS & Worker Authorization:**<br>
  [`learning/implementations/production-hardening/fix-01-job-queue-least-privilege-rls.md`](implementations/production-hardening/fix-01-job-queue-least-privilege-rls.md)<br>
  *Covers threat modeling, `fluxora_queue` role attribute verification, column-specific grants, `SECURITY DEFINER` function lifecycle, atomic 4-parameter retry authorization, `withWorkerClient` connection pool hygiene, and host allowlist validation.*
- **Fix 2 — Worker Crash Recovery, Retry Limits & Migration Compatibility:**<br>
  [`learning/implementations/production-hardening/fix-02-worker-crash-recovery.md`](implementations/production-hardening/fix-02-worker-crash-recovery.md)<br>
  *Covers silent worker crashes vs. reported failures, bounded batch sweeper (`FOR UPDATE SKIP LOCKED LIMIT 25`), table CHECK constraint `attempt_count <= max_attempts`, non-superuser legacy reconciliation under forced RLS, dual-limit architecture (`configured_max_attempts` vs `max_attempts`), trigger guard immutability, and historical 386-line candidate compatibility testing.*
- **Fix 3 — PostgreSQL SECURITY DEFINER Hardening:**<br>
  [`learning/implementations/production-hardening/fix-03-security-definer-hardening.md`](implementations/production-hardening/fix-03-security-definer-hardening.md)<br>
  *Covers exhaustive audit of 20 SECURITY DEFINER functions, dedicated service roles (`fluxora_auth`, `fluxora_tenant_guard`), CVE-2018-1058 search-path defense, PostgreSQL 16+ `CREATEROLE` `ADMIN OPTION` mitigation, database-local advisory lock concurrency via a canonical lock database, driver-level connection string validation, and schema ownership prerequisites.*
- **Fix 4 — Scenario and Repository Referential Integrity:**<br>
  [`learning/implementations/production-hardening/fix-04-scenario-repository-referential-integrity.md`](implementations/production-hardening/fix-04-scenario-repository-referential-integrity.md)<br>
  *Covers composite foreign key enforcement, `graph_nodes` repository backfill, fail-closed pre-migration data audit, `BEFORE INSERT` trigger auto-derivation, immutable `repository_id` trigger guard, single-table simulation query optimization, and concurrency race validation.*

#### Technical Learning Notes
- **Fix 1 Technical Notes:**<br>
  [`learning/notes/Fix-01-Job-Queue-Least-Privilege-RLS.md`](notes/Fix-01-Job-Queue-Least-Privilege-RLS.md)<br>
  *Deep dive into PostgreSQL RLS mechanics, permissive policy OR-combination, superuser test masking, search path injection prevention, connection pool tainting, and destructive test guardrails.*
- **Fix 2 Technical Notes:**<br>
  [`learning/notes/Fix-02-Worker-Crash-Recovery-And-Retry-Limits.md`](notes/Fix-02-Worker-Crash-Recovery-And-Retry-Limits.md)<br>
  *Deep dive into attempt count semantic definitions, bounded sweeper concurrency, non-superuser transaction-scoped migration policies, honest representation of historical uncertainty (`NULL`), trigger guards vs column defaults, and PostgreSQL function return table upgrade rules.*
- **Fix 3 Technical Notes:**<br>
  [`learning/notes/Fix-03-PostgreSQL-Security-Definer-Hardening.md`](notes/Fix-03-PostgreSQL-Security-Definer-Hardening.md)<br>
  *Deep dive into SECURITY DEFINER mechanics, search-path resolution order, pg_temp attack vectors, role attributes, PostgreSQL 16+ role membership options (ADMIN, INHERIT, SET), advisory lock database locality, driver-level parser divergences, and schema vs. table ownership.*
- **Fix 4 Technical Notes:**<br>
  [`learning/notes/Fix-04-Scenario-Repository-Referential-Integrity.md`](notes/Fix-04-Scenario-Repository-Referential-Integrity.md)<br>
  *Deep dive into SQL standard composite foreign key constraints, referenced table UNIQUE requirements, graph node lineage derivation, trigger-based denormalization synchronization, concurrent foreign key validation, and index optimization.*

#### Interview Preparation
- **Fix 1 Interview Cheat Sheet:**<br>
  [`learning/interviews/Fix 1 Job Queue Least Privilege RLS Interview CheatSheet.md`](interviews/Fix%201%20Job%20Queue%20Least%20Privilege%20RLS%20Interview%20CheatSheet.md)<br>
  *Layman analogy ("Safe Deposit Box vs. Armored Car"), 30-second elevator pitch, staff-level Q&A, SQL patterns, architectural traps, and production readiness checklist.*
- **Fix 2 Interview Cheat Sheet:**<br>
  [`learning/interviews/Fix 2 Worker Crash Recovery and Retry Limits Interview CheatSheet.md`](interviews/Fix%202%20Worker%20Crash%20Recovery%20and%20Retry%20Limits%20Interview%20CheatSheet.md)<br>
  *Layman analogy ("Rental Car & Tow Truck"), 30-second elevator pitch, staff-level concurrency and queue Q&A, state machine diagram, operational vs configured limit trade-offs, and historical candidate verification caveats.*
- **Fix 3 Interview Cheat Sheet:**<br>
  [`learning/interviews/Fix 3 PostgreSQL SECURITY DEFINER Hardening Interview CheatSheet.md`](interviews/Fix%203%20PostgreSQL%20SECURITY%20DEFINER%20Hardening%20Interview%20CheatSheet.md)<br>
  *Layman analogy ("Diplomatic Pouch & Embassy Vault"), 30-second elevator pitch, staff-level PostgreSQL security Q&A, before vs. after comparison, and production deployment runbook checklist.*
- **Fix 4 Interview Cheat Sheet:**<br>
  [`learning/interviews/Fix 4 Scenario and Repository Referential Integrity Interview CheatSheet.md`](interviews/Fix%204%20Scenario%20and%20Repository%20Referential%20Integrity%20Interview%20CheatSheet.md)<br>
  *Layman analogy ("Boarding Pass & Gate Ticket"), 30-second elevator pitch, staff-level relational integrity Q&A, SQL patterns, operational migration zero-downtime trade-offs, and verification checklist.*

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

#### Fix 3 — PostgreSQL SECURITY DEFINER Hardening
Covers migration `0025_security_definer_hardening.sql` and regression suite `security-definer-hardening.test.ts`, establishing dedicated service-role ownership, pinned search paths, revoked public execute, PostgreSQL 16+ role membership hardening, database-local advisory lock serialization, and driver-level connection validation.

> [!IMPORTANT]
> **Status:** Implementation and non-destructive verification completed; live destructive PostgreSQL integration verification pending.
> `FLUXORA_QUEUE_TEST_DATABASE_URL`, `QUEUE_TEST_DATABASE_URL`, `FLUXORA_CLUSTER_LOCK_DATABASE_URL`, and `FLUXORA_ALLOW_DESTRUCTIVE_QUEUE_MIGRATION_TESTS=true` are not configured locally. Live integration verification remains pending execution against a dedicated disposable PostgreSQL test cluster and canonical lock database (with validated host and port consistency). `fluxora_dev` must never be used for destructive tests.

Key engineering highlights:
1. **Dedicated Service Role Architecture:** Provisioned dedicated least-privilege `NOLOGIN` roles `fluxora_auth` (auth functions) and `fluxora_tenant_guard` (tenant helpers), eliminating superuser/migrator function ownership.
2. **Search-Path & CVE-2018-1058 Defense:** Pinned `search_path = pg_catalog, public, pg_temp` across all 12 functions, schema-qualified all relation references, and revoked `CREATE ON SCHEMA public FROM PUBLIC`.
3. **PostgreSQL 16+ CREATEROLE ADMIN OPTION Mitigation:** Pre-provisioned service roles via trusted administrator and granted temporary `WITH SET TRUE, INHERIT FALSE, ADMIN FALSE` membership for ownership transfer, preventing migration runners from permanently administering service roles.
4. **Canonical Advisory Lock Concurrency:** Solved database-local advisory lock isolation across test runners by enforcing a dedicated canonical lock database (`FLUXORA_CLUSTER_LOCK_DATABASE_URL`), validated via preflight host/port endpoint matching.
5. **Driver-Level Connection String Validation:** Resolved `pg-connection-string` from installed `pg` via `createRequire`, validated effective driver configurations (preventing percent-encoding and query-parameter bypasses), and built frozen, branded `ValidatedPostgresConfig` objects.

#### Fix 4 — Scenario and Repository Referential Integrity
Covers forward-only migrations `0026_scenario_repository_referential_integrity.sql` and `0027_graph_node_lineage_integrity.sql`, query optimizations in `simulation.ts`, disposable test isolation in `packages/db/src/testing/test-database.ts`, and test suites `scenario-referential-integrity.test.ts` and `scenario-referential-integrity-migration.test.ts`, eliminating cross-repository entity targeting, repository identity spoofing, and lineage reassignment at the PostgreSQL storage engine level.

Key engineering highlights:
1. **Composite Foreign Key Hardening:** Replaced independent single-column foreign key with composite foreign key `CONSTRAINT scenarios_repository_target_node_fkey FOREIGN KEY (repository_id, target_node_id) REFERENCES graph_nodes (repository_id, id) ON DELETE CASCADE` (Migration 0026).
2. **Authoritative Lineage Derivation & Spoofing Rejection:** Denormalized `repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE` onto `graph_nodes`. In forward-only migration 0027, the `BEFORE INSERT` trigger (`trg_graph_nodes_set_repository_id`) authoritatively derives `repository_id` from `analysis_runs` $\to$ `repository_snapshots`. Caller-provided `repository_id` values are validated against derived truth; any mismatch is rejected with SQLSTATE `23000` (`integrity_constraint_violation`), while unresolvable runs fail closed with SQLSTATE `23503` (`foreign_key_violation`).
3. **Dual Immutability Guard:** Guarded `graph_nodes` against runtime updates to **both** `repository_id` AND `analysis_run_id` via `BEFORE UPDATE` trigger `trg_graph_nodes_prevent_repository_mutation` raising SQLSTATE `23000`.
4. **Upstream Lineage Verification:** Audited upstream parent models (`analysis_runs.snapshot_id`, `repository_snapshots.repository_id`) and verified they are write-once parent identities never updated in application or worker code.
5. **Fail-Closed Pre-Migration Data Audit:** Asserts 0 orphaned graph nodes and 0 mismatched scenarios before schema alterations (raising SQLSTATE `23514`), backed by temporary `NO FORCE RLS` relaxation for table owners during migration maintenance.
6. **Application-Layer Query Optimization:** Replaced a 3-table join in `createScenario` with a single-table indexed check, intercepting PostgreSQL constraint violation `23503` and translating it into a domain-level `SimulationPersistenceValidationError`.
7. **Disposable Test Database Isolation:** Enforces strict execution against dedicated disposable test databases (`fluxora_fix4_test`), safely rejecting `fluxora_dev` and production environments.
8. **Deterministic Concurrency Verification:** Replaced JavaScript timing assumptions with deterministic PostgreSQL `pg_locks` lock-wait checks (`waitForLockWait`).

---

## 3. Phase 8 — Simulation Deliverables

Phase 8 implements Fluxora's deterministic scenario simulation architecture, rule table, propagation engine, UI studio, and real golden-fixture validation.

### Document Directory

#### Implementation Reports
- **Step 52 — Simulation Persistence Foundation:**<br>
  [`learning/implementations/phase-08/step-52-simulation-persistence-foundation.md`](implementations/phase-08/step-52-simulation-persistence-foundation.md)
- **Step 53 — Simulation Rule Table:**<br>
  [`learning/implementations/phase-08/step-53-rule-table.md`](implementations/phase-08/step-53-rule-table.md)
- **Step 54 — Simulation Engine:**<br>
  [`learning/implementations/phase-08/step-54-simulation-engine.md`](implementations/phase-08/step-54-simulation-engine.md)
- **Step 55 — Simulation HTTP APIs:**<br>
  [`learning/implementations/phase-08/step-55-simulation-apis.md`](implementations/phase-08/step-55-simulation-apis.md)
- **Step 56 — Simulation Studio UI:**<br>
  [`learning/implementations/phase-08/step-56-simulation-studio-ui.md`](implementations/phase-08/step-56-simulation-studio-ui.md)
- **Step 57 — Simulation Mode Overlay:**<br>
  [`learning/implementations/phase-08/step-57-simulation-mode-overlay.md`](implementations/phase-08/step-57-simulation-mode-overlay.md)
- **Step 58 — Golden Fixture Simulation Validation:**<br>
  [`learning/implementations/phase-08/step-58-golden-fixture-simulation-validation.md`](implementations/phase-08/step-58-golden-fixture-simulation-validation.md)<br>
  *Covers Taxonomy golden fixture validation, the IMPORTS vs CALLS semantic boundary, ADR-012 test relationship provenance, 5-stage golden simulation test suite, and causal evidence verification.*

#### Technical Learning Notes
- **Note 52:** [`learning/notes/52. Simulation Persistence Foundation.md`](notes/52.%20Simulation%20Persistence%20Foundation.md)
- **Note 53:** [`learning/notes/53. Simulation Rule-Table.md`](notes/53.%20Simulation%20Rule-Table.md)
- **Note 54:** [`learning/notes/54. Simulation Engine.md`](notes/54.%20Simulation%20Engine.md)
- **Note 55:** [`learning/notes/55. Simulation HTTP APIs.md`](notes/55.%20Simulation%20HTTP%20APIs.md)
- **Note 56:** [`learning/notes/56. Simulation Studio UI.md`](notes/56.%20Simulation%20Studio%20UI.md)
- **Note 57:** [`learning/notes/57. Simulation Mode Overlay.md`](notes/57.%20Simulation%20Mode%20Overlay.md)
- **Note 58:** [`learning/notes/58. Golden Fixture Simulation Validation.md`](notes/58.%20Golden%20Fixture%20Simulation%20Validation.md)

#### Interview Preparation
- **Step 57 Interview Sheet:** [`learning/interviews/57. Step 57 Simulation Mode Overlay Interview CheatSheet.md`](interviews/57.%20Step%2057%20Simulation%20Mode%20Overlay%20Interview%20CheatSheet.md)
- **Step 58 Interview Sheet:** [`learning/interviews/58. Step 58 Golden Fixture Simulation Validation Interview CheatSheet.md`](interviews/58.%20Step%2058%20Golden%20Fixture%20Simulation%20Validation%20Interview%20CheatSheet.md)

---

## 4. Phase 9 — AI Reasoning Deliverables

Phase 9 implements Fluxora's AI reasoning layer, establishing a controlled Model Gateway, context assembly over deterministic evidence, structured output validation, and grounded explanations.

### Document Directory

#### Implementation Reports
- **Step 59 — Model Gateway Foundation:**<br>
  [`learning/implementations/phase-09/step-59-model-gateway.md`](implementations/phase-09/step-59-model-gateway.md)<br>
  *Covers provider-independent ModelGateway contract, Anthropic Claude Messages SDK integration, task-aware routing policies, bounded retries with exponential backoff and Retry-After parsing, secondary model fallback, cancellation propagation, microdollar token cost accounting, OpenTelemetry AI instrumentation, secret redaction, and offline deterministic mock mode.*
- **Step 60 — Impact Explanation Context Assembler:**<br>
  [`learning/implementations/phase-09/step-60-impact-context-assembler.md`](implementations/phase-09/step-60-impact-context-assembler.md)<br>
  *Covers pure deterministic context assembly, allowed evidence ID grounding manifest, multi-key prioritization (confidence, hop distance, category, stable nodeId), character budgeting and transparent truncation, tenant-scoped PostgreSQL loading with RLS, untrusted-data classification for prompt injection defense, and provider-independent ModelGatewayRequest generation.*
- **Step 61 — Structured Output Schemas & Evidence Grounding Validator:**<br>
  [`learning/implementations/phase-09/step-61-structured-output-validator.md`](implementations/phase-09/step-61-structured-output-validator.md)<br>
  *Covers canonical 4-field output schema (version `impact-explanation-output-v1`), strict JSON parsing (rejection of markdown fences, prose, primitives), evidence-manifest grounding validation against Step 60 allowed manifest, ADR-014 atomic whole-response rejection, bounded corrective retries (max 2 total attempts), and explicit distinction between citation provenance and semantic support.*
- **Step 62 — End-to-End Impact Explanation Integration:**<br>
  [`learning/implementations/phase-09/step-62-impact-explanation-integration.md`](implementations/phase-09/step-62-impact-explanation-integration.md)<br>
  *Covers end-to-end integration connecting completed deterministic impact analysis to Step 60 context assembly, Step 59 Model Gateway, Step 61 validation, durable tenant-isolated persistence in `ai_analyses` (Migration 0028), worker failure isolation boundary, authenticated `GET /api/v1/ai-analyses/:id` and extended impact analysis APIs, and `AIExplanationPanel` in explorer change mode.*
- **Step 63 — End-to-End AI Simulation Narration:**<br>
  [`learning/implementations/phase-09/step-63-simulation-narration.md`](implementations/phase-09/step-63-simulation-narration.md)<br>
  *Covers evidence-grounded AI narration for deterministic failure simulation, pure severity/hop-distance context assembler, strict evidence manifest synchronization, prompt version `simulation-narrate-v1` with simulation-vs-reality guardrails, output schema `simulation-narration-output-v1`, atomic whole-response rejection, failure-isolated async narration orchestration, extended simulation APIs, and `AISimulationNarrationPanel` with bounded discovery in SimulationStudio.*

#### Technical Learning Notes
- **Note 59:** [`learning/notes/59. Model Gateway Foundation.md`](notes/59.%20Model%20Gateway%20Foundation.md)
- **Note 60:** [`learning/notes/60. Impact Explanation Context Assembler.md`](notes/60.%20Impact%20Explanation%20Context%20Assembler.md)
- **Note 61:** [`learning/notes/61. Structured Output Schemas and Evidence Grounding Validator.md`](notes/61.%20Structured%20Output%20Schemas%20and%20Evidence%20Grounding%20Validator.md)
- **Note 62:** [`learning/notes/62. End-to-End Impact Explanation Integration.md`](notes/62.%20End-to-End%20Impact%20Explanation%20Integration.md)
- **Note 63:** [`learning/notes/63. AI Simulation Narration.md`](notes/63.%20AI%20Simulation%20Narration.md)

#### Architectural Decision Records
- **ADR-013 — Single Controlled Model Gateway Boundary with Secondary Model Fallback:**<br>
  [`learning/decisions/adr-013-model-gateway-boundary-and-fallback.md`](decisions/adr-013-model-gateway-boundary-and-fallback.md)<br>
  *Covers provider-independent ModelGateway boundary, provider SDK encapsulation, offline mock mode defaults, bounded task-aware primary/fallback routing, and clear separation from context assembly and deterministic explanation fallback.*
- **ADR-014 — Strict Whole-Response Rejection for Ungrounded Structured Output Citations:**<br>
  [`learning/decisions/adr-014-strict-whole-response-rejection-for-ungrounded-citations.md`](decisions/adr-014-strict-whole-response-rejection-for-ungrounded-citations.md)<br>
  *Covers atomic pass/fail validation boundary, rejection of ungrounded or duplicate evidence citations, prohibition of silent claim stripping or partial acceptance, bounded corrective retry limit (max 2 attempts), and clear separation from Step 66 deterministic template fallback.*
- **ADR-015 — Durable Tenant-Scoped AIAnalysis Persistence and Failure-Isolated Pipeline Orchestration:**<br>
  [`learning/decisions/adr-015-durable-tenant-scoped-ai-analysis-persistence-and-failure-isolated-orchestration.md`](decisions/adr-015-durable-tenant-scoped-ai-analysis-persistence-and-failure-isolated-orchestration.md)<br>
  *Covers dedicated `ai_analyses` table with unique constraint and RLS, worker failure isolation preventing LLM errors from failing deterministic jobs, safe withholding of ungrounded completions, and decoupled REST APIs.*
- **ADR-016 — Deterministic Simulation Narration Context, Evidence Grounding, and Bounded Discovery:**<br>
  [`learning/decisions/adr-016-simulation-narration-context-assembly-and-provenance.md`](decisions/adr-016-simulation-narration-context-assembly-and-provenance.md)<br>
  *Covers pure multi-key context prioritization for failure cascades, strict allowed evidence manifest synchronization, prompt-level simulation-vs-reality safety boundaries, schema `simulation-narration-output-v1`, asynchronous `simulation.narration` queue job handoff, and bounded 5-attempt discovery polling.*

#### Interview Preparation
- **Step 59 Interview Sheet:** [`learning/interviews/59. Step 59 Model Gateway Interview CheatSheet.md`](interviews/59.%20Step%2059%20Model%20Gateway%20Interview%20CheatSheet.md)
- **Step 60 Interview Sheet:** [`learning/interviews/60. Step 60 Context Assembler Interview CheatSheet.md`](interviews/60.%20Step%2060%20Context%20Assembler%20Interview%20CheatSheet.md)
- **Step 61 Interview Sheet:** [`learning/interviews/61. Step 61 Structured Output Validator Interview CheatSheet.md`](interviews/61.%20Step%2061%20Structured%20Output%20Validator%20Interview%20CheatSheet.md)
- **Step 62 Interview Sheet:** [`learning/interviews/62. Step 62 Impact Explanation Integration Interview CheatSheet.md`](interviews/62.%20Step%2062%20Impact%20Explanation%20Integration%20Interview%20CheatSheet.md)
- **Step 63 Interview Sheet:** [`learning/interviews/63. Step 63 AI Simulation Narration Interview CheatSheet.md`](interviews/63.%20Step%2063%20AI%20Simulation%20Narration%20Interview%20CheatSheet.md)

---

## 5. Canonical Architecture Cross-References

- **Implementation Snapshot:** [`docs/DESIGN.md`](../docs/DESIGN.md) (living snapshot of current state, active constraints, and verification results).
- **Implementation Roadmap:** [`docs/architecture/17-implementation-roadmap.md`](../docs/architecture/17-implementation-roadmap.md) (phase definitions and step sequencing).
- **Database Schema:** [`docs/architecture/06-database-schema.md`](../docs/architecture/06-database-schema.md) (relational models and RLS policies).
- **Security Architecture:** [`docs/architecture/11-security-architecture.md`](../docs/architecture/11-security-architecture.md) (sandboxing, least-privilege roles, and tenant boundaries).
