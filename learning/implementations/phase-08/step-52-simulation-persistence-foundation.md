# Step 52 — Simulation Persistence Foundation (Scenario, Simulation, SimulationResult)

## Objective & Role in Roadmap

Global Step 52 kicks off **Phase 8: Simulation** per `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/05-component-responsibilities.md §5.10`, `docs/architecture/06-database-schema.md §6.3`, and `docs/architecture/04-system-architecture-diagrams.md §4.7`.

Its core objective is **Persistence & Domain-Contract Foundation**:
Establish the PostgreSQL schema, forward-only migrations, Row-Level Security (RLS) policies, domain contracts in `@fluxora/shared-types`, and tenant-scoped repository operations in `@fluxora/db` for Fluxora's simulation system:
- `Scenario`: The definition of a what-if experiment (target node, failure type, parameters).
- `Simulation`: An execution record of a scenario against an immutable analysis run snapshot.
- `SimulationResult`: The deterministic end state of each affected graph node resulting from a simulation execution.

**Strict Scope Boundary**:
Step 52 is strictly the database and typed persistence foundation.
- Rule table is **NOT** implemented (reserved for Step 53).
- Propagation engine is **NOT** implemented (reserved for Step 54).
- Simulation HTTP REST APIs are **NOT** implemented (reserved for Step 55).
- Simulation-mode frontend UI is **NOT** implemented (reserved for Step 56).
- Animation and AI narration are **NOT** implemented (reserved for later steps).

---

## Architecture & Domain Model

### 1. Entity Responsibilities & Separation of Concerns

```
┌────────────────────────────────────────────────────────┐
│                        Scenario                        │
│ - id, organization_id, repository_id                   │
│ - name: "Payment provider unavailable"                 │
│ - target_node_id: uuid (references graph_nodes)        │
│ - failure_type: "unavailable" | "latency" | ...        │
│ - parameters: { delay_ms: 1500, timeout: true }        │
│ - created_by: uuid (references users)                  │
└───────────────────────────┬────────────────────────────┘
                            │ 1 : N (instantiates)
                            ▼
┌────────────────────────────────────────────────────────┐
│                       Simulation                       │
│ - id, scenario_id, analysis_run_id                     │
│ - status: "pending" | "running" | "completed" | "failed"│
│ - created_at                                           │
└───────────────────────────┬────────────────────────────┘
                            │ 1 : N (produces)
                            ▼
┌────────────────────────────────────────────────────────┐
│                    SimulationResult                    │
│ - id, simulation_id, node_id                           │
│ - resulting_state: "healthy"|"degraded"|"at_risk"|...  │
│ - propagation_path: ["node_pay", "node_checkout"]      │
│ - rule_applied: "CALLS+sync+no_fallback"               │
│ - assumptions: ["No circuit breaker detected"]         │
│ - confidence: 0.90                                     │
└────────────────────────────────────────────────────────┘
```

Why separate `Scenario`, `Simulation`, and `SimulationResult`?
1. **Reusable What-If Hypotheses (`Scenario`)**: An engineering team defines scenarios once (e.g., *"What happens if Auth0 is down?"* or *"What happens if Redis cluster experiences 500ms latency?"*). The hypothesis exists independently of any single commit or graph snapshot.
2. **Snapshot-Isolated Executions (`Simulation`)**: As code evolves across commits, branches, and PRs, each `AnalysisRun` produces a new versioned graph snapshot. Running the same `Scenario` against commit $C_1$ and later commit $C_2$ produces distinct `Simulation` records, tracking how architectural resiliency evolves over time.
3. **Per-Node Observable Conclusions (`SimulationResult`)**: A simulation outcome is not a monolithic boolean; it is a topological blast-radius detailing exact per-node degraded or failed states, traversed edge paths, rules applied, and conservative fallback assumptions.

---

## Analysis-Run Snapshot Boundary

A critical invariant enforced in Step 52 is the **Analysis-Run Snapshot Boundary**:
> *A simulation must never silently combine a Scenario target node from one graph run with results computed against another graph run.*

At the persistence layer, the repository strictly enforces:
1. When creating a `Simulation`:
   - The referenced `analysisRunId` must belong to the same `repositoryId` as the `Scenario`.
   - The `Scenario.targetNodeId` must exist within that specified `analysisRunId` (`SELECT id FROM graph_nodes WHERE id = targetNodeId AND analysis_run_id = analysisRunId`).
2. When creating or upserting `SimulationResult` records:
   - Every `nodeId` in the result set must belong to the `Simulation`'s `analysisRunId`.

Cross-run mixing is rejected at the repository boundary with `SimulationPersistenceValidationError`, guaranteeing graph snapshot consistency.

---

## Domain Types & Contracts

Exported from `@fluxora/shared-types`:

```typescript
export const ScenarioFailureTypes = [
  "unavailable",
  "latency",
  "capacity",
  "removal",
] as const;
export type ScenarioFailureType = (typeof ScenarioFailureTypes)[number];

export const SimulationResultStates = [
  "healthy",
  "degraded",
  "at_risk",
  "failed",
] as const;
export type SimulationResultState = (typeof SimulationResultStates)[number];

export const SimulationStatuses = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;
export type SimulationStatus = (typeof SimulationStatuses)[number];
```

### Domain Model vs. MVP Rule Scope
- The database schema and TypeScript domain model deliberately support all 4 architectural failure types: `unavailable`, `latency`, `capacity`, and `removal`.
- Per `02-product-scope.md` and Step 53 requirements, the initial rule table implemented in Step 53 will strictly execute rules for `infra-unavailable` and `latency-degradation`.
- Storing `capacity` and `removal` in the schema avoids premature migration churning while preserving strict validation bounds against arbitrary strings.

---

## Database Schema & Migration (`0019_simulation_storage.sql`)

### 1. `scenarios` Table
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE`
- `repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE`
- `name text NOT NULL CHECK (length(trim(name)) > 0)`
- `target_node_id uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE`
- `failure_type text NOT NULL CHECK (failure_type IN ('unavailable', 'latency', 'capacity', 'removal'))`
- `parameters jsonb NOT NULL DEFAULT '{}'::jsonb`
- `created_by uuid REFERENCES users (id) ON DELETE SET NULL`
- `created_at timestamptz NOT NULL DEFAULT now()`

### 2. `simulations` Table
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `scenario_id uuid NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE`
- `analysis_run_id uuid NOT NULL REFERENCES analysis_runs (id) ON DELETE CASCADE`
- `status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed'))`
- `created_at timestamptz NOT NULL DEFAULT now()`

### 3. `simulation_results` Table
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `simulation_id uuid NOT NULL REFERENCES simulations (id) ON DELETE CASCADE`
- `node_id uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE`
- `resulting_state text NOT NULL CHECK (resulting_state IN ('healthy', 'degraded', 'at_risk', 'failed'))`
- `propagation_path jsonb NOT NULL DEFAULT '[]'::jsonb`
- `rule_applied text NOT NULL CHECK (length(trim(rule_applied)) > 0)`
- `assumptions jsonb NOT NULL DEFAULT '[]'::jsonb`
- `confidence double precision NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0)`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `CONSTRAINT simulation_results_simulation_node_unique UNIQUE (simulation_id, node_id)`

---

## Multi-Tenancy & Row-Level Security (RLS)

All three tables enforce PostgreSQL `FORCE ROW LEVEL SECURITY`:

1. `scenarios`:
   - Direct tenant ownership via `organization_id`.
   - `SELECT`, `UPDATE`, `DELETE` evaluated against `organization_id = fluxora_current_org_id()`.
   - `INSERT` checks both `organization_id = fluxora_current_org_id()` AND `fluxora_repository_in_current_tenant(repository_id)`.
2. `simulations`:
   - Scoped through `scenario_id` via `fluxora_scenario_in_current_tenant(scenario_id)`.
   - `INSERT` additionally verifies `fluxora_analysis_run_in_current_tenant(analysis_run_id)`.
3. `simulation_results`:
   - Scoped through `simulation_id` via `fluxora_simulation_in_current_tenant(simulation_id)`.

Helper functions `fluxora_scenario_in_current_tenant(uuid)` and `fluxora_simulation_in_current_tenant(uuid)` are `STABLE SECURITY DEFINER` functions granting zero unauthorized visibility across tenant boundaries.

---

## Evidence Boundary Preservation

In accordance with architectural principles:
- Evidence `subject_type` already supports `simulation_state` in `@fluxora/shared-types`.
- Step 52 does not invoke or modify `EvidenceWriter` because simulation execution logic is deferred to Step 53+.
- `pnpm lint:evidence` continues to pass with 0 violations across all conclusion write paths.

---

## Repository Layer (`packages/db/src/repositories/simulation.ts`)

- `createScenario`: Enforces organization and repository ownership, verifies target node exists in the repository, persists scenario definition.
- `getScenarioById`: Retrieves scenario scoped to authenticated tenant.
- `listScenarios`: Deterministically ordered scenario query (`ORDER BY created_at DESC, id DESC`).
- `deleteScenario`: Tenant-scoped cascading deletion.
- `createSimulation`: Enforces snapshot boundary, ensures target node belongs to specified analysis run, sets initial lifecycle status.
- `getSimulationById`: Tenant-scoped retrieval.
- `listSimulationsForScenario`: Deterministic list of executions for a scenario.
- `updateSimulationStatus`: Validates lifecycle transition (`pending` -> `running` -> `completed` / `failed`).
- `saveSimulationResults`: Atomic batch upsert for node simulation results with snapshot validation and idempotency (`ON CONFLICT (simulation_id, node_id) DO UPDATE`).
- `getSimulationResultById`: Tenant-scoped result lookup.
- `listSimulationResults`: Deterministically ordered result list (`ORDER BY created_at ASC, id ASC`).

---

## Verification Matrix

1. **Migration Execution**:
   - `pnpm --filter @fluxora/db migrate`: Successfully applied `0019_simulation_storage.sql`.
2. **Typecheck**:
   - `pnpm --filter @fluxora/shared-types typecheck`: 0 errors.
   - `pnpm --filter @fluxora/db typecheck`: 0 errors.
   - `pnpm typecheck`: 0 errors across workspace.
3. **Automated Unit & Integration Tests**:
   - `packages/db/src/repositories/simulation.test.ts`: 19 tests covering input validation, failure types, snapshot boundaries, lifecycle status updates, result idempotency, RLS isolation, deterministic ordering, and cascade deletions.
   - `@fluxora/db`: 15 test files, 153 tests passing.
4. **Evidence Lint**:
   - `pnpm lint:evidence`: 0 violations.
5. **Code Style**:
   - `pnpm lint`: 0 ESLint errors.

