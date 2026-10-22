# Step 54 — Simulation Engine

## Objective & Role in Roadmap

Global Step 54 implements the **Simulation Engine** for Phase 8 per:
- `docs/architecture/17-implementation-roadmap.md §Phase 8 Step 3`
- `docs/architecture/04-system-architecture-diagrams.md §4.7`
- `docs/architecture/05-component-responsibilities.md §5.10`
- `docs/architecture/06-database-schema.md` (Scenario, Simulation, SimulationResult, Evidence)
- `docs/architecture/12-testing-strategy.md §12.1`
- `docs/architecture/02-product-scope.md` (MVP simulation boundary)

Its core objective is **Deterministic Scenario Propagation with Convergence, Causal Paths, Assumptions/Confidence, and Evidence-Backed Simulation State Changes**:
To build an in-memory pure domain propagation engine and an atomic database persistence/orchestration layer that executes scenario experiments against versioned graph snapshots using the Step 53 normative rule table.

### Strict Scope Boundary
Step 54 is strictly limited to the Simulation Engine, graph snapshot normalization, deterministic propagation, and evidence-backed persistence:
- **Simulation HTTP APIs** (`POST /scenarios`, `POST /scenarios/:id/run`, `GET /simulations/:id`) are **NOT** implemented (owned by Step 55).
- **Frontend simulation mode overlay** is **NOT** implemented (owned by Step 56).
- **Golden-fixture validation** is **NOT** implemented (owned by Step 58).
- **Capacity/traffic simulation, queueing theory, traffic multipliers, APM/OpenTelemetry ingestion, and AI explanations** are strictly excluded from MVP.

---

## Architecture & Separation of Concerns

The implementation maintains a strict separation between the **Pure Domain Engine** and the **Database Persistence & Orchestration Layer**:

```
+-----------------------------------------------------------------------------------+
|                           Simulation Engine Architecture                          |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  [Scenario Definition]  +  [Graph Snapshot]  +  [Rule Table (v1.0.0)]             |
|                                     │                                             |
|                                     ▼                                             |
|                     ┌───────────────────────────────┐                             |
|                     │     runSimulationEngine(...)  │ (Pure Domain Core)          |
|                     │  - Initialize all: HEALTHY    │                             |
|                     │  - Seed Target (FAIL/DEGRADE) │                             |
|                     │  - Deterministic Work Queue   │                             |
|                     │  - Incident Edge Traversal    │                             |
|                     │  - Step 53 Rule Table Eval    │                             |
|                     │  - Monotonicity Check         │                             |
|                     │  - Causal Path Assembly       │                             |
|                     │  - Convergence Detection      │                             |
|                     └───────────────┬───────────────┘                             |
|                                     │                                             |
|                                     ▼                                             |
|                        SimulationEngineResult                                     |
|                      (results, paths, assumptions)                                |
|                                     │                                             |
|                                     ▼                                             |
|                     ┌───────────────────────────────┐                             |
|                     │     executeSimulation(...)    │ (DB Persistence Layer)      |
|                     │  - Tenant & Run Isolation     │                             |
|                     │  - Status: pending -> running │                             |
|                     │  - Atomic Transaction:        │                             |
|                     │      saveSimulationResults    │                             |
|                     │      EvidenceWriter           │                             |
|                     │      Status: -> completed     │                             |
|                     │  - Rollback on failure        │                             |
|                     └───────────────────────────────┘                             |
|                                                                                   |
+-----------------------------------------------------------------------------------+
```

---

## Engine Inputs & Outputs

### Input Contract (`SimulationEngineInput`)
```ts
export interface SimulationEngineInput {
  readonly scenario: Scenario | {
    readonly id?: string | undefined;
    readonly targetNodeId: string;
    readonly failureType: ScenarioFailureType;
    readonly parameters?: Record<string, unknown> | undefined;
  };
  readonly graph: SimulationGraphSnapshot;
  readonly ruleTable?: SimulationRuleTable | undefined;
  readonly options?: {
    readonly maxIterations?: number | undefined;
  } | undefined;
}
```

The `SimulationGraphSnapshot` contains:
- `analysisRunId`: UUID identifying the graph snapshot run.
- `nodes`: list of `GraphNode` or `SimulationNode` instances.
- `edges`: list of `GraphEdge` or `SimulationEdge` instances with metadata (`sync`, `hasFallback`, `hasCircuitBreaker`).

### Output Contract (`SimulationEngineResult`)
```ts
export interface SimulationEngineResult {
  readonly converged: boolean;
  readonly iterations: number;
  readonly ruleTableVersion: string;
  readonly results: readonly SimulationEngineNodeResult[];
  readonly nodeStates: ReadonlyMap<string, SimulationResultState>;
}
```

Each affected node produces a `SimulationEngineNodeResult`:
- `nodeId`: ID of the affected graph node.
- `resultingState`: `'failed' | 'degraded' | 'at_risk'`.
- `propagationPath`: structured list of `SimulationCausalStep` explaining the exact path of propagation.
- `ruleApplied`: canonical rule ID (e.g. `RULE_ID_TARGET_FAILURE`, `CALLS+sync+no_fallback`).
- `assumptions`: deduplicated list of assumptions accumulated across the causal path.
- `confidence`: rule-derived confidence score in `[0.0, 1.0]`.
- `capped`: boolean indicating if propagation was capped (e.g. via circuit breaker).

---

## Pure Propagation Algorithm

### 1. State Initialization & Target Seeding
1. All nodes in the snapshot are initialized to `healthy` state in `stateMap`.
2. The scenario's target node is validated to exist within the graph snapshot.
3. Target failure is seeded:
   - `failureType: "unavailable"` → target node transitions to `failed`.
   - `failureType: "latency"` → target node transitions to `degraded`.
4. Initial causal step recorded:
   - `ruleId: "target_failure"` (`RULE_ID_TARGET_FAILURE`)
   - `ruleVersion: ruleTable.version`
   - `previousState: "healthy"`
   - `resultingState`: `failed` or `degraded`
   - `confidence: 1.0`
5. Target node ID is placed into the deterministic FIFO `workQueue`.

### 2. Worklist Loop & Incident Edge Traversal
While `workQueue` is not empty:
1. Dequeue `currentNodeId`.
2. Retrieve incident edges connected to `currentNodeId` (either as `sourceNodeId` or `targetNodeId`).
3. Incident edges are processed in strict deterministic order:
   `sourceNodeId ASC`, `targetNodeId ASC`, `edgeType ASC`, `id ASC`.
4. For each incident edge:
   - Retrieve `sourceNode`, `targetNode`, and their current states from `stateMap`.
   - Construct `SimulationRuleInput` via `createSimulationRuleInputFromEdge`.
   - Evaluate against the normative `SimulationRuleTable` via `evaluateSimulationRule`.
   - If `!decision.matched`, skip.
   - If matched, determine `affectedNodeId`:
     - `affectedNode === "source"` → `edge.sourceNodeId`
     - `affectedNode === "target"` → `edge.targetNodeId`
5. **Monotonicity Guard**:
   - Compare proposed state with current state using `isStateMoreSevere(proposedState, currentAffectedState)`.
   - If not strictly more severe, do not apply transition (preserves existing first deterministic causal explanation).
   - If strictly more severe:
     - Apply new state in `stateMap`.
     - Assemble full causal path: take the causal path of the triggering node on the other side of the edge, append the new `SimulationCausalStep`.
     - Combine and deduplicate assumptions.
     - If `decision.capped === true`, fail-fast circuit-breaker isolation halts cascading propagation; do not enqueue.
     - If `!decision.capped`, push `affectedNodeId` into `workQueue`.

### 3. Convergence & Termination Guarantees
- The state hierarchy is strictly finite and monotonic:
  `healthy (0) -> at_risk (1) -> degraded (2) -> failed (3)`.
- A node can transition at most 3 times.
- In a finite graph of $N$ nodes, total possible transitions across all nodes is bounded by $3N$.
- Once all affected nodes reach their maximally severe reachable states, no further state worsening is possible.
- The worklist naturally empties, guaranteeing termination even in cyclic graphs (e.g. $A \leftrightarrow B$).
- A defensive invariant (`maxIterations`) guards against runaway iteration, throwing `SimulationConvergenceError` if exceeded.

---

## Evidence Generation & Persistence

Step 54 is the first step where simulated state conclusions are produced. Every state change is persisted alongside a corresponding `simulation_state` evidence record using `EvidenceWriter`.

### Atomic Transaction Pattern
In `executeSimulation`:
```sql
BEGIN;
  -- 1. Update simulation status to 'running'
  UPDATE simulations SET status = 'running' WHERE id = $1;

  -- 2. Upsert SimulationResult records
  INSERT INTO simulation_results (simulation_id, node_id, resulting_state, propagation_path, rule_applied, assumptions, confidence)
  VALUES (...)
  ON CONFLICT (simulation_id, node_id) DO UPDATE ...
  RETURNING id, simulation_id, node_id, resulting_state, ...;

  -- 3. Insert EvidenceWriter-backed simulation_state Evidence records
  INSERT INTO evidence (id, analysis_run_id, subject_type, subject_id, file_path, symbol_id, line_start, line_end, column_start, column_end, relationship_description, confidence, metadata)
  VALUES (...);

  -- 4. Update simulation status to 'completed'
  UPDATE simulations SET status = 'completed' WHERE id = $1;
COMMIT;
```

If any failure occurs, the transaction automatically rolls back. In a separate connection, the simulation status is updated to `'failed'`, ensuring that no unevidenced `SimulationResult` records ever exist in the database.

### Evidence Completeness CI Linter
`packages/db/src/repositories/evidence-lint.ts` was extended to include `packages/db/src/repositories/simulation-engine.ts` in `DEFAULT_CONCLUSION_WRITE_TARGETS`, detecting any raw simulation result writes and enforcing `EvidenceWriter.createSimulationStateEvidence`.

---

## Tenant & Analysis-Run Invariants

1. **Organization Boundary**: Scenarios and Simulations are strictly isolated via PostgreSQL Row-Level Security (`current_setting('app.current_org_id')`) and `withTenant`.
2. **Analysis-Run Snapshot Boundary**: The engine rejects graph snapshots where any node or edge carries an `analysisRunId` different from the snapshot's declared `analysisRunId` (`CrossAnalysisRunBoundaryError`).
3. **Deterministic Idempotency**: Re-executing a simulation overwrites existing node results using `ON CONFLICT (simulation_id, node_id) DO UPDATE`, preventing duplicate rows.

---

## Limitations & Non-Goals

1. **MVP Failure Types Only**: Only `"unavailable"` and `"latency"` are supported by the engine. Unsupported failure types (`"capacity"`, `"removal"`) fail explicitly with `UnsupportedScenarioFailureTypeError`.
2. **Qualitative Latency**: Latency degradation propagates qualitatively (e.g. caller degraded) without numerical modeling, p95/p99 values, or queueing simulations.
3. **No HTTP Endpoints**: HTTP REST endpoints (`POST /scenarios`, `POST /scenarios/:id/run`, `GET /simulations/:id`) are strictly deferred to Step 55.
4. **No LLM Integration**: The engine is purely deterministic and executes without AI intervention.

---

## How Step 55 Will Call the Engine

In Step 55, the API endpoint handler `POST /scenarios/:id/run` will:
1. Verify user authentication and organization tenancy via Fastify auth hook.
2. Call `createSimulation(pool, orgId, { scenarioId, analysisRunId })`.
3. Call `executeSimulation(pool, orgId, simulation.id)`.
4. Return the resulting simulation execution status, node results, and causal paths to the client.

