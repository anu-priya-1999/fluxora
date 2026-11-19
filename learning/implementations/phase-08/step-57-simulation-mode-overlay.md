# Step 57 — Simulation Mode Overlay in Architecture Explorer

## Objective & Role in Roadmap

Global Step 57 implements the **Simulation Mode Overlay in the Architecture Explorer** for Phase 8 per:
- `docs/architecture/17-implementation-roadmap.md §Phase 8 Step 6`
- `docs/architecture/04-system-architecture-diagrams.md §4.7`
- `docs/architecture/05-component-responsibilities.md §5.7` (Architecture Explorer) and `§5.10` (Simulation Engine)
- `docs/architecture/07-api-architecture.md §7.2` (Simulation endpoints)
- Step 55 HTTP API endpoints (`GET /simulations/:id`, `GET /simulations/:id/results`)
- Step 56 Simulation Studio UI (`/simulations`)

Its core objective is **Connecting Persisted Failure Simulations to Real Graph Visualizations**:
Allow authenticated users navigating the Architecture Explorer (`/repositories/[repoId]/explorer`) to load a persisted simulation by UUID (or via `?simulation_id=<uuid>` deep-link), visually observe which components were affected across all 4 canonical simulation states (`failed`, `degraded`, `at_risk`, `healthy`), trace the causal propagation edges between components directly on the React Flow canvas, inspect circuit-breaker capped boundaries, and explore detailed step-by-step causal evidence per node in the Node Inspector without fabricating healthy results for unreached components.

---

## Strict Scope Boundaries & Deterministic Invariants

1. **Analysis-Run Snapshot Consistency**:
   - A simulation run is strictly scoped to an analysis-run snapshot (`simulation.analysis_run_id`).
   - Prior to displaying the overlay, the Explorer verifies:
     ```ts
     simulation.analysis_run_id === explorerContext.analysisRunId
     ```
   - If a simulation belongs to a different snapshot, the overlay is rejected with a clear context-mismatch error (`simulation_context_mismatch`). The existing graph topology is preserved, and cross-snapshot contamination is prevented.

2. **Semantic Truth for Absent Nodes ("No Result" vs "Healthy")**:
   - A graph node absent from the simulation results was unreached or unaffected by propagation.
   - Nodes absent from the simulation results must **never** be labeled `healthy`.
   - Absent nodes retain their ordinary Architecture Explorer node appearance (opacity 1.0, no grayscale or faded styling, no artificial 'NO RESULT' badge modifying graph node presentation).
   - The Node Inspector explicitly notes: *"No simulation result for this node. This node was not reached by the simulation propagation path."*
   - Only explicit results returned by the deterministic engine establish a component's resulting state.

3. **Pure Normalized State View Model (`simulation-mode-data.ts`)**:
   - Normalizes raw `SimulationResponse` and `SimulationResultResponse[]` into an immutable `NormalizedSimulationModeState` view model.
   - Indexes results by `nodeId` in `Map<string, SimulationResultResponse>` and causal edges in `Set<string>` for $O(1)$ graph canvas lookups during render cycles.
   - Resolves duplicate node results deterministically by state severity (`failed` > `degraded` > `at_risk` > `healthy`), deriving `causalEdgeIds` and `ruleTableVersion` strictly from final accepted results after duplicate resolution to prevent stale causal edge or rule-version leakage from superseded lower-severity results.
   - Computes canonical aggregate metrics (`failed`, `degraded`, `at_risk`, `healthy`, `capped`, `total`) and LOD slice metrics (`visibleAffectedNodes`, `hiddenAffectedNodes`).
   - Validates canonical states against domain enum bounds; invalid or unrecognized states are never converted into `at_risk` or other valid states, but are retained in `invalidResultsByNodeId` strictly for diagnostics without inflating canonical metrics or generating causal edges.
   - Parses structured `SimulationCausalStep` breadcrumbs from `propagation_path`. Rejects steps missing a canonical `nodeId`, `previousState`, or `resultingState` rather than misattributing values from the enclosing result in multi-node paths. Legacy string entries are treated as diagnostic-only without creating fabricated state transitions or causal edges. Never synthesizes phantom edge IDs.

4. **Explicit Pending & Running Execution Lifecycle States & Bounded Polling**:
   - `pending` and `running` simulations returned by the API are explicitly represented as `pending` and `running` in the UI; they are never labeled `Ready` or `Empty`.
   - Partial results from a pending or running simulation run are never presented as a completed result set; the graph overlay is only applied once execution is completed.
   - Completed simulations with zero affected components produce an empty state with honest messaging: convergence is only claimed if `converged === true`, otherwise neutral wording ("Completed with no result nodes.") is displayed.
   - User-triggered manual refresh is provided at all times via GET-based requests.
   - Bounded automatic polling (maximum 15 attempts, 4000ms interval) is governed by `createSimulationPollController` and `shouldScheduleSimulationPoll`:
     - Polling timers are only scheduled when Simulation Mode is enabled, simulation ID is present, and both server execution status and UI status are `pending` or `running`.
     - Polling is strictly suppressed when UI status is `loading` (active fetch in progress) or `error`, preventing overlapping GET requests and automatic retry loops upon network/API failures.
     - Polling attempts and budget are scoped per simulation ID; switching simulation IDs resets the attempt counter to 0.
     - Scheduled timers are cancelled on component unmount, mode disable, simulation change/clear, or execution completion/failure.
     - Stale asynchronous responses from earlier simulations are guarded by checking the target simulation ID and discarded before updating component state.

5. **Mutual Exclusivity of Visualization Overlays**:
   - Simulation Mode and Change Mode represent distinct analytical lenses.
   - When Simulation Mode is active and ready, it takes visual precedence on the React Flow canvas to prevent ambiguous or contradictory multi-colored borders.
   - Disabling or clearing Simulation Mode cleanly restores the underlying Change Mode overlay without requiring a re-fetch of PR impact analysis.
   - Selected-node styling priority is preserved across both modes.

6. **Deterministic Causal Edge Highlighting**:
   - The graph canvas highlights only edge IDs explicitly identified in structured causal propagation steps (`step.edgeId`).
   - Causal edges are rendered with high-visibility failure stroke styling (`#dc2626`, 3px width, opacity 1.0); non-causal edges receive muted opacity (`0.35`).
   - Seed target failure steps have no edge ID (`null`) and do not synthesize phantom edges.

7. **Honest Confidence & Static Assumptions Notice**:
   - Prominently displayed in both `SimulationModeBar` and `NodeInspectorPanel`:
     > *"Simulation confidence reflects deterministic rule confidence and static metadata assumptions. It is not a real-world failure probability."*
   - Explains that latency degradation models topology-driven risk propagation rather than fabricated numerical millisecond queueing metrics.

---

## Route Integration & Deep-Linking Architecture

- **Route**: `/repositories/[repoId]/explorer`
- **Query Parameters**:
  - `analysis_run_id=<uuid>` (established context)
  - `start_node_id=<uuid>` (established context)
  - `simulation_id=<uuid>` (Step 57 deep-link parameter)
- **Server Context Resolution**:
  - In `apps/web/src/app/repositories/[repoId]/explorer/explorer-data.ts`, `resolveAnalysisContext` parses `simulation_id` (supporting both array and scalar query parameters) and populates `initialSimulationId` on `ResolvedAnalysisContext`.
- **Client Synchronization**:
  - In `apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx`, `simulation_id` is synced with browser history using `window.history.replaceState`.
  - When present upon initial load, the client automatically triggers authenticated retrieval (`getSimulationApi` and `getSimulationResultsApi`).
- **Bidirectional Deep-Link**:
  - `SimulationStudio` calculates `explorerSimulationUrl` via `buildExplorerSimulationUrl` and renders a direct action button: **View on Architecture Graph**.

---

## Component Architecture & Visual Presentation

### 1. `SimulationModeBar` (`apps/web/src/components/graph/SimulationModeBar.tsx`)
- Placed above the graph canvas alongside `ChangeModeBar`.
- Features:
  - ON/OFF toggle.
  - Manual simulation UUID input with format validation.
  - Action buttons: Load, Clear, and Retry.
  - In-flight loading spinner.
  - Status indicators: Ready, Empty Results (distinguishing verified convergence from unknown convergence), Pending, Running (with Refresh action), Failed Simulation, and Context Mismatch.
  - Summary metric chips: Total Affected, Failed, Degraded, At Risk, Healthy, Capped.
  - Honest simulation confidence notice.
  - Expandable visual legend detailing all 4 canonical states and the neutral treatment of unreached nodes.

### 2. Graph Node Visualization (`node-styles.ts` & `NodeRenderer.tsx`)
- Visual styling for canonical simulation states:
  - `failed`: Solid red border (`#dc2626`), red tint background (`#fef2f2`), `FAILED` badge.
  - `degraded`: Amber border (`#d97706`), amber tint background (`#fffbeb`), `DEGRADED` badge.
  - `at_risk`: Yellow border (`#eab308`), yellow tint background (`#fefce8`), `AT RISK` badge.
  - `healthy`: Emerald border (`#059669`), emerald tint background (`#ecfdf5`), `HEALTHY` badge.
  - `unreached`: Retains ordinary Architecture Explorer node appearance (opacity 1.0, normal border/bg, no simulation badge).
- Node badge includes circuit-breaker indicator (`CAPPED`) when capped by policy, and calibrated confidence percentage.

### 3. Graph Edge Highlighting (`GraphCanvas.tsx`)
- Causal propagation edges are traced directly on React Flow edges.
- Causal edges matching `normalizedState.causalEdgeIds` receive:
  - `#dc2626` stroke color.
  - `3px` stroke width.
  - `opacity: 1.0` (while non-causal edges receive `0.35` muted opacity).
  - High z-index priority.

### 4. Node Inspector Extension (`node-inspector-data.ts` & `NodeInspectorPanel.tsx`)
- When a node is selected in Simulation Mode, the inspector surfaces a dedicated **Simulation Result** section:
  - Resulting state badge & calibrated confidence score.
  - Applied simulation rule ID and version.
  - Explicit static metadata assumptions (e.g. `"No circuit breaker detected on call"`).
  - Chronological causal path breadcrumb timeline:
    - Step number.
    - State transition: `previousState → resultingState`.
    - Rule applied & version.
    - Causal edge ID (or `"Seed target failure"`).
    - Circuit-breaker capped badge when applicable.
  - Neutral explanation for unreached nodes.

---

## Verification Matrix

| Verification Check | Target / Scope | Result |
| --- | --- | --- |
| `pnpm --filter @fluxora/web test` | 16 test files (including `simulation-mode.test.ts` with 49 tests and `explorer.test.ts` with 27 tests) | **283 passed (0 failed)** |
| Full Workspace Tests (`pnpm test`) | 7 workspace packages, 75 test files | **1,144 passed, 9 skipped (0 failed)** |
| `pnpm typecheck` | 7 workspace packages | **Exit code 0 (clean)** |
| `pnpm lint` | Monorepo ESLint check | **Exit code 0 (0 errors, 0 warnings)** |
| `pnpm lint:evidence` | EvidenceWriter AST lint | **Exit code 0 (all paths pass)** |
| `pnpm build` | Next.js 16 production build | **Exit code 0 (all routes compiled)** |
| `git diff --check` | Whitespace & format check | **Exit code 0 (clean)** |

---

## Explicit Scope Exclusions

- No re-implementation or modification of Step 54 Simulation Engine or Step 53 Rule Table.
- No new database tables, migrations, or backend API endpoints.
- No background queue workers for simulations.
- No speculative failure types (`capacity`, `removal`).
- No probabilistic machine learning or LLM-generated simulation graphs.
- No golden-fixture benchmark test suites (reserved for Step 58).
