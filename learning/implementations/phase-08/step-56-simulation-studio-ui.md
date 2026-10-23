# Step 56 — Simulation Studio UI

## Objective & Role in Roadmap

Global Step 56 implements the **Simulation Studio UI** for Phase 8 per:
- `docs/architecture/17-implementation-roadmap.md §Phase 8 Step 5`
- `docs/architecture/04-system-architecture-diagrams.md §4.7`
- `docs/architecture/05-component-responsibilities.md §5.3` (API Server) and `§5.10` (Simulation Engine)
- `docs/architecture/02-product-scope.md` (MVP simulation boundary)
- `docs/architecture/07-api-architecture.md §7.2` (Simulation endpoints)
- Step 55 HTTP API endpoints and Step 53/54 simulation rules and engine contracts.

Its core objective is **Empowering Authenticated Users with Interactive Failure Scenario Modeling and Causal Path Inspection**:
Provide a production-quality, responsive Simulation Studio interface within Next.js App Router (`/simulations`) where users can select repositories and analysis run snapshots, query real graph nodes to seed failure scenarios, create versioned scenarios via `POST /api/v1/scenarios`, trigger deterministic propagation runs via `POST /api/v1/scenarios/:id/run`, inspect affected nodes in a filterable/sortable table, and explore the step-by-step causal chain with explicit assumptions, confidence scores, and circuit-breaker capping indicators.

### Strict Scope Boundaries & Deterministic Invariants
- **Step 55 Contract Alignment**: Frontend strictly conforms to the verified Step 55 request parsers and response serializers.
- **Scenario Creation**: Sends established fields: `name`, `target_node_id`, `failure_type`, `repository_id` and/or `analysis_run_id`, and optional `parameters`. Never sends `seed_failures` or client-supplied `organization_id`.
- **Response Shape Mapping**:
  - `ScenarioResponse`: Consumes `id`, `name`, `target_node_id`, `failure_type`, `repository_id`, `parameters`, `created_at`.
  - `SimulationResponse`: Consumes `id`, `scenario_id`, `analysis_run_id`, `status`, `created_at`, `total_results`, `converged`, `iterations`.
  - `SimulationResultsListResponse`: Consumes `simulation_id`, `results`, and `total` (not `total_affected`).
  - `SimulationResultResponse`: Consumes `id`, `simulation_id`, `node_id`, `resulting_state`, `state`, `propagation_path` (not `causal_steps`), `rule_applied`, `assumptions`, `confidence`.
- **Canonical State Semantics**: Uses strictly canonical result states: `healthy`, `at_risk`, `degraded`, `failed`. `unavailable` and `latency` are strictly scenario failure types, never result states.
- **Derived Metadata Discipline**: Top-level `rule_table_version` is not assumed to be returned by endpoints; it is derived from `step.ruleVersion` in causal steps. `converged` and `iterations` are displayed only when returned by the execution endpoint and omitted when undefined (such as on `GET /simulations/:id`).
- **Repository / Analysis Context**: Node's native `node:http` API backend currently does not expose list endpoints for repositories or analysis runs. Context is resolved from route params (`/repositories/[repoId]/explorer`) or query params (`?repository_id=...&analysis_run_id=...`) and target nodes are scoped strictly to the selected run snapshot via `POST /api/v1/graph/query` on the native `node:http` server.

---

## Route Architecture & Navigation

1. **Primary Route (`/simulations`)**:
   - Location: `apps/web/src/app/simulations/page.tsx`
   - Role: Main authenticated Simulation Studio workbench.
   - Query Parameters Supported:
     - `repository_id` / `repo_id`: Pre-selects repository identifier.
     - `analysis_run_id` / `run_id`: Pre-selects analysis run identifier.
     - `start_node_id`: Seeds graph query traversal for node selection.
     - `target_node_id` / `node_id`: Pre-selects scenario target node.
     - `scenario_id`: Pre-loads existing scenario.
     - `simulation_id`: Pre-loads existing simulation run and results.
   - Authentication: Server-side Clerk `await auth()` gate; unauthenticated requests redirect to sign-in with return URL preserved.
   - API URL: Server resolves public API URL via `readFluxoraApiUrl()` without hard-coding localhost.

2. **Convenience Redirects**:
   - `/simulation` (`apps/web/src/app/simulation/page.tsx`): Redirects to `/simulations` preserving query parameters.
   - `/repositories/[repoId]/simulation` (`apps/web/src/app/repositories/[repoId]/simulation/page.tsx`): Scopes to `repository_id=${repoId}` and redirects to `/simulations`.

3. **Dashboard & Explorer Cross-Links**:
   - In `apps/web/src/app/dashboard/page.tsx`: Surfaces direct link to Open Simulation Studio.
   - In `apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx`: Header bar includes a "Simulation Studio" badge linking to `/simulations?repository_id=${repoId}&analysis_run_id=${analysisRunId}` with the currently selected node pre-seeded as target node.

---

## Component Architecture & Responsibilities

1. **`SimulationStudio` (`apps/web/src/components/simulation/SimulationStudio.tsx`)**:
   - Two-column responsive workbench layout:
     - **Left Column (5 cols)**: Configuration & Control:
       - Section 1: Repository and analysis run selection with format validation (UUID regex). Includes "Load Snapshot Nodes" button invoking `POST /api/v1/graph/query`.
       - Section 2: Scenario definition with searchable target node dropdown, required scenario name input, and failure type selector (`"unavailable"` vs `"latency"`). Action: **Create Scenario** (`POST /api/v1/scenarios`).
       - Section 3: Distinct **Run Simulation** action button (`POST /api/v1/scenarios/:id/run`) with duplicate-submission prevention and loading spinner.
     - **Right Column (7 cols)**: Outcomes & Causal Inspection:
       - Impact summary card: Total affected count, breakdown by state (`failed`, `degraded`, `at_risk`, `healthy`), capped count (circuit breakers), iterations, and rule table version.
       - Affected nodes table: Filterable by state (`all`, `failed`, `degraded`, `at_risk`, `healthy`) and searchable by node name/ID/rule. Sortable by state severity (`failed > degraded > at_risk > healthy`), name, confidence, and path length. Row selection triggers causal inspection.
       - Causal path inspector: Step-by-step causal chain showing transitions (`previousState → resultingState`), rule ID & version, edge ID (or `"None (Seed target failure)"`), capped badge, explicit assumptions list, and confidence.
       - Details & limitations section: Displays runtime IDs, derived rule table version, deterministic guarantees, and qualitative latency limitations.

2. **API Client (`apps/web/src/components/simulation/simulation-api.ts`)**:
   - `fetchAnalysisGraph`: Queries `POST /api/v1/graph/query` to populate actual graph nodes for selection.
   - `createScenarioApi`: Calls `POST /api/v1/scenarios` with session Bearer token; never sends `organization_id`.
   - `runScenarioApi`: Calls `POST /api/v1/scenarios/:id/run` with `analysis_run_id`.
   - `getSimulationApi`: Calls `GET /api/v1/simulations/:id`.
   - `getSimulationResultsApi`: Calls `GET /api/v1/simulations/:id/results`.
   - Consistent error mapping: maps 401/403 to `not_authenticated`, 404 to `not_found`, 422 to `convergence_failure`, 400 to `invalid_request` or `unsupported_failure_type`, 500 to `server_error`, and network aborts to `network_error`.
   - Failed requests are never rendered as successful empty simulations.

3. **Pure Helpers (`apps/web/src/components/simulation/simulation-helpers.ts`)**:
   - `calculateSimulationImpact`: Aggregates affected counts, circuit breaker caps, and derives `ruleTableVersion` from causal steps without assuming server returned it.
   - `filterAndSortSimulationResults`: Pure filter and sort pipeline for affected node results across canonical states.
   - `extractCausalSteps`: Extracts structured `SimulationCausalStep` arrays from `result.propagation_path`.
   - `validateScenarioInput`: Real-time form validation for required fields, failure type enum, and UUID formats.
   - `formatConfidence`: Pure formatting for rule confidence scores.
   - `getStateBadgeColors`: Semantic color palettes for `failed` (red), `degraded` (amber), `at_risk` (yellow), and `healthy` (emerald).

4. **Types (`apps/web/src/components/simulation/simulation-types.ts`)**:
   - Re-exports shared domain types from `@fluxora/shared-types`.
   - Defines `SimulationImpactSummary`, `StudioFilterState`, `ApiResult`, and `ApiResultReason`.

---

## Dependent Selection Invalidation Rules

To prevent stale or cross-snapshot state:
- Changing **Repository ID**: Clears target node ID, created scenario, simulation ID, results, and causal inspector.
- Changing **Analysis Run ID**: Clears loaded graph nodes, target node ID, created scenario, simulation ID, results, and causal inspector.
- Changing **Target Node**: Clears created scenario, simulation ID, results, and causal inspector.

---

## Verification Matrix

| Check | Target / Command | Result |
| :--- | :--- | :--- |
| Simulation Studio unit & contract tests | `apps/web/src/components/simulation/simulation-studio.test.ts` | PASSED (21/21) |
| Web package test suite | `pnpm --filter @fluxora/web test` | PASSED (220/220 across 15 files) |
| API simulation contract alignment tests | `apps/api/src/http/simulation-web-contract.test.ts` | PASSED (8/8) |
| Web package typecheck | `pnpm --filter @fluxora/web typecheck` | PASSED (0 errors) |
| Workspace typecheck | `pnpm typecheck` | PASSED (7/7 packages) |
| Workspace ESLint | `pnpm lint` | PASSED (0 errors, 0 warnings) |
| Evidence completeness | `pnpm lint:evidence` | PASSED (5 conclusion targets scanned) |
| Workspace full tests | `pnpm test` | PASSED (939 passed, 9 skipped across 68 files) |
| Workspace build | `pnpm build` | PASSED (Turbopack + SSG / SSR) |
| Git whitespace check | `git diff --check` | PASSED (clean) |
