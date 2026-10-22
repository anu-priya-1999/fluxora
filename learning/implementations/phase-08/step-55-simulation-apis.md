# Step 55 — Simulation HTTP APIs

## Objective & Role in Roadmap

Global Step 55 implements the **Simulation HTTP APIs** for Phase 8 per:
- `docs/architecture/17-implementation-roadmap.md §Phase 8 Step 4`
- `docs/architecture/04-system-architecture-diagrams.md §4.7`
- `docs/architecture/05-component-responsibilities.md §5.3` (API Server) and `§5.10` (Simulation Engine)
- `docs/architecture/02-product-scope.md` (MVP simulation boundary)
- `docs/architecture/06-database-schema.md` (Scenario, Simulation, SimulationResult, Evidence)
- `docs/architecture/07-api-architecture.md §7.2` (Simulation endpoints)

Its core objective is **Exposing Deterministic Simulation Capabilities through Secure, Tenant-Scoped HTTP Endpoints**:
Expose the existing Step 52 scenario/simulation persistence, Step 53 rule table, and Step 54 simulation engine (`executeSimulation`) through native `node:http` API endpoints with strict authentication, tenant isolation, request validation, and deterministic result serialization.

### Strict Scope Boundaries
- Reuses working Step 54 `executeSimulation` without rewriting or duplicating propagation algorithms.
- Excludes frontend simulation-mode graph overlay (reserved for Step 56).
- Excludes golden-fixture validation scenarios (reserved for Step 58).
- Excludes unsupported failure types (`capacity`, `removal`).
- Excludes background workers and job queues (execution is synchronous per Step 54 design).

---

## The Four HTTP Endpoints

### 1. Create a Scenario (`POST /scenarios` & `POST /api/v1/scenarios`)
- **Method & Paths:** `POST /scenarios` and `POST /api/v1/scenarios`
- **Authentication:** Bearer JWT verified with Clerk, resolving user to tenant organization.
- **Request Body:**
  ```json
  {
    "name": "Payment provider down",
    "target_node_id": "99999999-9999-4999-8999-999999999991",
    "failure_type": "unavailable",
    "repository_id": "66666666-6666-4666-8666-666666666666",
    "parameters": { "custom": "value" }
  }
  ```
- **Validation Rules:**
  - `name`: required non-empty string.
  - `target_node_id`: required valid UUID string.
  - `failure_type`: required; must be `"unavailable"` or `"latency"`. Unsupported types (`"capacity"`, `"removal"`) are explicitly rejected with `400 unsupported_failure_type`.
  - Scoping: At least one of `repository_id` or `analysis_run_id` is required. If `analysis_run_id` is provided, verifies that target node belongs to that specific analysis run and repository belongs to tenant.
  - Rejects caller-supplied `organization_id` (`400 invalid_request`).
- **Response:** `201 Created` with direct `ScenarioResponse` (flat contract without redundant wrapper).

### 2. Run a Scenario (`POST /scenarios/:id/run` & `POST /api/v1/scenarios/:id/run`)
- **Method & Paths:** `POST /scenarios/:id/run` and `POST /api/v1/scenarios/:id/run`
- **Authentication:** Bearer JWT; strictly tenant-scoped.
- **Behavior:**
  1. Loads scenario by ID within authenticated organization scope (`404 Not Found` if missing or foreign).
  2. Validates MVP supported failure types (`"unavailable"` | `"latency"`).
  3. Resolves target `analysis_run_id` (from body, scenario parameters, or target node snapshot).
  4. Verifies target node membership in the analysis run snapshot.
  5. Initializes a Simulation record with status `pending`.
  6. Synchronously invokes `executeSimulation(pool, organizationId, simulation.id)`.
  7. Persists `SimulationResult` records and `simulation_state` evidence atomically via `EvidenceWriter`.
  8. Returns `200 OK` with full outcome and convergence metrics.
- **Idempotency Distinction:** Each accepted run request creates a distinct simulation record. Within any given simulation execution, result persistence is idempotent via Step 54's `ON CONFLICT (simulation_id, node_id) DO UPDATE` to avoid duplicate result rows.

### 3. Retrieve a Simulation (`GET /simulations/:id` & `GET /api/v1/simulations/:id`)
- **Method & Paths:** `GET /simulations/:id` and `GET /api/v1/simulations/:id`
- **Authentication:** Bearer JWT; strictly tenant-scoped.
- **Behavior:**
  - Queries `simulations` joined with `scenarios` on `organization_id`.
  - Returns `404 Not Found` for nonexistent or foreign simulations without leaking existence.
  - Returns simulation identifier, scenario identifier, analysis run identifier, status, creation timestamp, and result summary.

### 4. Retrieve Simulation Results (`GET /simulations/:id/results` & `GET /api/v1/simulations/:id/results`)
- **Method & Paths:** `GET /simulations/:id/results` and `GET /api/v1/simulations/:id/results`
- **Authentication:** Bearer JWT; strictly tenant-scoped.
- **Behavior:**
  - Verifies simulation existence and tenant authorization.
  - Retrieves persisted `SimulationResult` records ordered by `created_at ASC, id ASC`.
  - Preserves full causal paths (`SimulationCausalStep[]`), applied rule IDs, explicit assumptions, and confidence.
  - Returns `200 OK` with `{ simulation_id, results, total }`. Returns empty results array (`total: 0`) for simulations with no persisted results.

---

## Architectural Verification Matrix

| Check | Target | Status | Result |
| :--- | :--- | :--- | :--- |
| Endpoint unit tests | `apps/api/src/http/simulation-request.test.ts` | PASSED | 17/17 passed |
| API integration tests | `apps/api/src/http/simulation.test.ts` | PASSED | 32/32 passed |
| Full API test suite | `pnpm --filter @fluxora/api test` | PASSED | 173/173 passed across 13 test files |
| Workspace typecheck | `pnpm typecheck` | PASSED | 0 errors across 7 workspace projects |
| Workspace lint | `pnpm lint` | PASSED | 0 ESLint errors |
| Evidence completeness | `pnpm lint:evidence` | PASSED | 0 violations across 5 conclusion targets |
| Production build | `pnpm build` | PASSED | Next.js production build cleanly compiled |
| Git whitespace | `git diff --check` | PASSED | 0 whitespace or formatting issues |

