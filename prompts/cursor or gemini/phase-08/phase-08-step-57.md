# Fluxora Global Step 57 — Simulation Mode Overlay in Architecture Explorer

> **Archival Reconstruction Notice:**
> This prompt is a reconstructed archival engineering prompt for Global Step 57, recovered from the shipped implementation, repository evidence, architectural contracts, and test suites. It adheres to the established Phase 8 prompt structure and engineering discipline.

---

## Role

Act as a senior full-stack engineer building Fluxora, an AI-powered repository intelligence and failure-simulation platform.

## Objective

Implement a production-quality **Simulation Mode Overlay in the Architecture Explorer** (`/repositories/[repoId]/explorer`), connecting persisted failure simulation results directly to the real React Flow architecture graph.

The implementation builds upon:
- **Step 53:** Simulation Rule Table (`packages/shared-types` and rule definitions).
- **Step 54:** Deterministic Simulation Engine (`packages/db` and simulation execution loop).
- **Step 55:** Authenticated Simulation HTTP APIs (`GET /api/v1/simulations/:id`, `GET /api/v1/simulations/:id/results`).
- **Step 56:** Simulation Studio UI (`/simulations`).

An authenticated user exploring a repository's architecture graph must be able to load a persisted simulation run by its UUID (or via a `?simulation_id=<uuid>` deep-link), visually observe which components were affected across all 4 canonical simulation states (`failed`, `degraded`, `at_risk`, `healthy`), trace causal propagation edges between components directly on the React Flow canvas, inspect circuit-breaker capped boundaries, and explore detailed step-by-step causal evidence per node in the Node Inspector—without fabricating synthetic healthy results for unreached components.

This is an implementation task, not a static mockup.

---

## 1. Inspect before coding

First inspect:
- The current Git status and diff. Preserve all existing uncommitted changes.
- `docs/architecture/17-implementation-roadmap.md` (Phase 8 Step 6).
- `docs/architecture/04-system-architecture-diagrams.md` §4.7.
- `docs/architecture/05-component-responsibilities.md` §5.7 (Architecture Explorer) and §5.10 (Simulation Engine).
- `docs/architecture/07-api-architecture.md` §7.2 (Simulation endpoints).
- `packages/shared-types/src/simulation.ts` for exact API request/response contracts and domain enums.
- `apps/web/src/components/simulation/simulation-api.ts` for authenticated API clients (`getSimulationApi`, `getSimulationResultsApi`).
- `apps/web/src/app/repositories/[repoId]/explorer/` (`page.tsx`, `explorer-client.tsx`, `explorer-data.ts`).
- `apps/web/src/components/graph/` (`GraphCanvas.tsx`, `NodeRenderer.tsx`, `node-styles.ts`, `node-inspector-data.ts`, `NodeInspectorPanel.tsx`, `change-mode-data.ts`).
- Existing test suites: `apps/web/src/components/graph/simulation-mode.test.ts` and `apps/web/src/app/repositories/[repoId]/explorer/explorer.test.ts`.
- `docs/DESIGN.md` for living architecture constraints and Step 56 baseline.

Discover the actual graph data structures, React Flow node data shapes, and styling pipelines. Reuse existing architecture and dependencies. Do not assume file paths, response shapes, or API contracts without checking them.

---

## 2. API Integration & Wire Contracts

Use the existing authenticated simulation endpoints from Step 55:
```text
GET /api/v1/simulations/:id
GET /api/v1/simulations/:id/results
```

Wire rules:
- Consume endpoints via `getSimulationApi` and `getSimulationResultsApi` in `apps/web/src/components/simulation/simulation-api.ts`.
- Authenticate requests using established Clerk session token conventions (`getToken`).
- Strictly adhere to backend response contracts (`SimulationResponse`, `SimulationResultsListResponse`, `SimulationResultResponse`).
- Do **not** create new backend endpoints, database tables, migrations, or background worker jobs. All simulation execution remains persisted and served by Step 54 and Step 55.

---

## 3. Analysis-Run Snapshot Consistency

A simulation run is strictly scoped to an immutable analysis-run snapshot (`simulation.analysis_run_id`).

Prior to displaying the simulation overlay, the Architecture Explorer must verify:
```ts
simulation.analysis_run_id === explorerContext.analysisRunId
```

Consistency invariants:
- If `simulation.analysis_run_id` does not match the active graph's `explorerContext.analysisRunId`, reject the overlay with an explicit context-mismatch error:
  `"Analysis run mismatch: Simulation belongs to run <simRunId>, but current explorer is displaying run <contextRunId>."`
- Preserve the existing graph topology on mismatch; never render cross-snapshot simulation results over a foreign graph snapshot.
- Similarly, verify that the returned simulation ID matches the requested target simulation ID on both metadata and results responses, discarding any mismatched or out-of-order responses to prevent stuck loading states.

---

## 4. Honest Simulation Result Semantics ("No Result" vs "Healthy")

Deterministic failure simulation traverses from a failure seed across directed dependency edges. It evaluates only reachable components governed by deterministic propagation rules.

Invariants:
- Support **only** the 4 canonical simulation states:
  ```text
  healthy
  at_risk
  degraded
  failed
  ```
- **Never fabricate results for absent nodes:** A graph node absent from `simulation.results` was unreached or unaffected by the simulation propagation path. It must **never** be labeled `healthy` or assigned synthetic metrics.
- Unreached nodes must retain their normal Architecture Explorer appearance (opacity 1.0, standard border and background colors, no simulation badges, no artificial "NO RESULT" badge modifying node layout).
- The Node Inspector must explicitly clarify:
  > *"No simulation result for this node. This node was not reached by the simulation propagation path."*
- Only explicit results returned by the deterministic engine establish a component's resulting state.

---

## 5. Normalized Simulation View Model (`simulation-mode-data.ts`)

Build a pure, immutable normalization module `apps/web/src/components/graph/simulation-mode-data.ts` that transforms raw simulation responses into an indexed view model (`NormalizedSimulationModeState`):

Requirements:
1. **$O(1)$ Rendering Lookups:**
   - Index results by `nodeId` in `resultsByNodeId: Map<string, SimulationResultResponse>`.
   - Index resulting state in `resultingStateByNodeId: Map<string, SimulationResultState>`.
   - Index causal edges in `causalEdgeIds: Set<string>`.
   - Index rules, confidence, assumptions, causal steps, and capped flags by `nodeId`.
2. **Deterministic Duplicate-Result Resolution:**
   - When multiple simulation results target the same component, resolve duplicates deterministically by state severity:
     ```text
     failed (4) > degraded (3) > at_risk (2) > healthy (1)
     ```
   - Decrement prior state counts when replacing a lower-severity result with a higher-severity result.
3. **Derived Metadata Integrity:**
   - Derive `causalEdgeIds` and `ruleTableVersion` **exclusively** from the final accepted results after duplicate resolution.
   - Never leak causal edges or rule-table versions from superseded lower-severity results.
4. **Canonical State Validation:**
   - Validate states against `isCanonicalSimulationState(value)`.
   - Retain malformed or unrecognized states in `invalidResultsByNodeId` strictly for diagnostics.
   - Never convert invalid states into `at_risk` or other valid states; do not inflate canonical metrics or generate causal edges from invalid records.
5. **Structured Causal-Step Parsing (`extractSimulationCausalSteps`):**
   - Parse discrete `SimulationCausalStep` breadcrumbs from `propagation_path`.
   - Strictly validate `nodeId`, `previousState`, and `resultingState`.
   - Reject any step missing a canonical `nodeId`, `previousState`, or `resultingState` rather than misattributing values from the enclosing result record in multi-node paths.
   - Never synthesize phantom edge IDs.
   - Treat legacy string entries (e.g. `"target_failure"`) as diagnostic-only without creating fabricated state transitions or causal edges.
6. **LOD Slice Metrics (`computeSimulationSliceMetrics`):**
   - Accurately compute `totalResultNodes`, `visibleResultNodes`, and `hiddenResultNodes` relative to the current viewport LOD slice (`visibleNodes`).

---

## 6. Execution Lifecycle & Bounded Polling

The UI must distinguish the full execution lifecycle:
- `pending`: Simulation queued on server.
- `running`: Simulation executing propagation loop.
- `completed`: Simulation converged and results persisted.
- `failed`: Simulation execution failed on server.

Invariants:
- Never label `pending` or `running` simulations as `Ready` or `Empty`.
- Never overlay partial results from pending or running executions onto the graph canvas.
- For completed simulations with zero result nodes, claim convergence only when `converged === true`; otherwise display neutral wording (`"Completed with no result nodes."`).
- Provide user-triggered manual refresh via GET-based requests.
- Implement bounded automatic polling via `createSimulationPollController` and `shouldScheduleSimulationPoll` in `explorer-data.ts`:
  - Maximum **15 attempts** at **4,000 ms** intervals (60-second polling ceiling).
  - Poll **only** when Simulation Mode is enabled, simulation ID is present, server execution status is `pending` or `running`, and UI status is `pending` or `running`.
  - Strictly suppress polling when UI status is `loading` (active fetch in progress) or `error`, preventing request stampedes and infinite retry loops on failure.
  - Reset the attempt budget to 0 when switching simulation IDs.
  - Deterministically cancel timers on component unmount, mode disable, simulation change/clear, or terminal execution status.
  - Discard stale asynchronous responses from prior fetches by asserting `prev.simulationId === targetSimulationId`.

---

## 7. Visualization & React Flow Overlay Behavior

Implement visual overlay components in `apps/web/src/components/graph/`:

### A. `SimulationModeBar.tsx`
- Mode toggle button (`Simulation Mode: ON / OFF`).
- Manual simulation UUID input with validation against `UUID_REGEX`.
- Action buttons: `Load`, `Clear`, and `Retry`.
- Status indicators: `Loading`, `Pending` (with Refresh action), `Running` (with Refresh action), `Ready`, `Empty`, and `Error` banner.
- Metric summary chips for Ready status: Total Results, Failed, Degraded, At Risk, Healthy, Capped (Breakers), Causal Edges, Rule Table Version, and Analysis Snapshot ID.
- Expandable visual legend detailing all 4 canonical states and neutral unreached node styling.
- Honest simulation confidence notice.

### B. Graph Node Visualization (`node-styles.ts` & `NodeRenderer.tsx`)
- Canonical state border, background, and ring styling:
  - `failed`: `#dc2626` (Red 600) border, `#fef2f2` (Red 50) background, `FAILED` badge.
  - `degraded`: `#d97706` (Amber 600) border, `#fffbeb` (Amber 50) background, `DEGRADED` badge.
  - `at_risk`: `#eab308` (Yellow 500) border, `#fefce8` (Yellow 50) background, `AT RISK` badge.
  - `healthy`: `#059669` (Emerald 600) border, `#ecfdf5` (Emerald 50) background, `HEALTHY` badge.
  - `unreached`: Retains normal node appearance (opacity 1.0, base type border/background, no simulation badges).
- Render `CAPPED` badge when a component's propagation was stopped by a circuit breaker policy.
- Render calibrated confidence percentage badge.
- Selected-node styling priority: Selected node styling (`#2563eb`, high z-index) takes absolute priority over both Simulation Mode and Change Mode overlays.

### C. Exact Causal Edge Highlighting (`GraphCanvas.tsx`)
- Trace verified causal propagation edges matching `normalizedState.causalEdgeIds`.
- Causal edge styling: `#dc2626` stroke color, `3px` stroke width, `opacity: 1.0`.
- Non-causal edges receive muted opacity (`0.35`).
- Seed target failure steps have `edgeId === null`; do **not** synthesize phantom edges.

### D. Node Inspector Extension (`node-inspector-data.ts` & `NodeInspectorPanel.tsx`)
- Add dedicated **Simulation Result** section when Simulation Mode is ready and a node is selected:
  - Resulting state badge & calibrated confidence score.
  - Applied rule ID and rule version.
  - Explicit static metadata assumptions (e.g. `"No circuit breaker detected on call"`).
  - Chronological causal propagation path timeline:
    - Step index (`Step X`).
    - State transition: `previousState → resultingState`.
    - Rule applied & rule version.
    - Causal edge ID (or `"None (Seed target failure)"`).
    - Circuit-breaker `CAPPED` indicator when applicable.
  - Neutral explanation for unreached nodes:
    `"No simulation result for this node. This node was not reached by the simulation propagation path."`
  - Explanatory card for invalid/unrecognized result states.

### E. Mutual Exclusivity with Change Mode
- Simulation Mode and Change Mode represent distinct analytical lenses.
- When Simulation Mode is active and ready, it takes visual precedence on the React Flow canvas.
- Preserves underlying Change Mode state without clearing or mutating PR impact data.
- Disabling or clearing Simulation Mode cleanly restores the active Change Mode overlay without re-fetching.

---

## 8. Honest Confidence & Static Assumptions Notice

Prominently display the following notice in both `SimulationModeBar` and `NodeInspectorPanel`:

> *"Simulation confidence reflects deterministic rule confidence and static metadata assumptions. It is not a real-world failure probability."*

Ensure documentation and UI copy clearly state that latency degradation models topology-driven risk propagation under static analysis rather than fabricated millisecond histograms or queueing simulations.

---

## 9. Routing & Deep-Linking

Support deep-linking to persisted simulations via URL search parameters:
```text
/repositories/[repoId]/explorer?simulation_id=<uuid>
```

Requirements:
- Server route handling in `apps/web/src/app/repositories/[repoId]/explorer/explorer-data.ts`:
  Parse `simulation_id` into `initialSimulationId` on `ResolvedAnalysisContext`.
- Client route synchronization in `explorer-client.tsx`:
  Sync `simulation_id` with browser history using `window.history.replaceState`.
  Auto-load simulation on mount when `initialSimulationId` is present.
- Bidirectional navigation:
  In `SimulationStudio.tsx`, provide a direct action button: **View on Architecture Graph**, computing canonical deep-link URLs via `buildExplorerSimulationUrl`.
  In Architecture Explorer header, provide a direct link to **Simulation Studio**, pre-populating repository, analysis-run, and target-node context.

---

## 10. Engineering Quality & Verification

Follow existing Next.js 16, TypeScript, Tailwind CSS, and React Flow conventions.

Write meaningful unit and integration tests:
- **`apps/web/src/components/graph/simulation-mode.test.ts`**:
  - Normalization of simulation responses and results lists.
  - Canonical state mapping, badge styling, and border colors.
  - Rejection of invalid/missing previous states and resulting states in causal steps.
  - Rejection of steps missing a `nodeId`.
  - Circuit-breaker capped propagation flags.
  - Seed step handling with null edge IDs.
  - Duplicate-result resolution by severity with stale causal edge discarding.
  - Pending, running, completed, and failed execution lifecycle states.
  - Empty results versus converged execution messaging.
  - LOD slice metrics calculation (`visibleResultNodes`, `hiddenResultNodes`).
  - Interactive SimulationModeBar toggle, ID input, Load, and Clear button clicks.
  - NodeInspectorPanel simulation section, causal step timeline, and unreached node messaging.
- **`apps/web/src/app/repositories/[repoId]/explorer/explorer.test.ts`**:
  - Context mismatch detection and error handling (`simulation.analysis_run_id !== context.analysisRunId`).
  - Mismatched metadata and results simulation ID rejection.
  - Deep-link initialization via `initialSimulationId`.
  - Polling controller lifecycle: pending/running polling, active-fetch/error suppression, completed/failed termination, per-ID budget reset, max 15 attempts, and cleanup on unmount/disable.
  - Stale async response protection.
  - Mutual exclusivity and restoration of Change Mode.

Verification commands:
- `pnpm --filter @fluxora/web test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm lint:evidence`
- `git diff --check`

Update `docs/DESIGN.md` with Step 57 architecture, create the implementation report `learning/implementations/phase-08/step-57-simulation-mode-overlay.md`, and create the interview cheat sheet `learning/interviews/57. Step 57 Simulation Mode Overlay Interview CheatSheet.md`.

---

## Scope Boundaries

- Do **not** reimplement or modify the Step 54 Simulation Engine or Step 53 Rule Table.
- Do **not** create new database tables, migrations, or backend API endpoints.
- Do **not** add background queue workers for simulations.
- Do **not** introduce speculative failure types (`capacity`, `removal`).
- Do **not** fabricate probabilities, downtime estimates, or numerical queueing latency.
- Do **not** implement golden-fixture simulation benchmarks (reserved for Step 58).
- Do **not** commit or push changes. Preserve existing working tree.

---

## Final Report Guidelines

Provide:
1. Architectural role of the Simulation Mode Overlay.
2. Verified API contracts and wire protocol.
3. Invariants enforced (snapshot consistency, honest result semantics, duplicate resolution, bounded polling).
4. Files modified and tests implemented.
5. Actual command execution results.
6. Suggested commit message.
