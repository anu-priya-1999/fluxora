# Fluxora Step 55 — Simulation HTTP APIs

You are implementing **Fluxora Global Step 55 — Simulation HTTP APIs**.

Step 54 — Simulation Engine has been implemented and audited. It provides:

- `runSimulationEngine(...)` for deterministic, in-memory simulation.
- `executeSimulation(...)` for tenant-scoped execution and transactional persistence.
- The existing Step 53 Simulation Rule Table.
- SimulationResult persistence and EvidenceWriter-backed simulation-state evidence.
- Deterministic propagation, convergence, causal paths, assumptions, confidence, and supported failure-type validation.

Your responsibility now is to expose the existing simulation capabilities through Fluxora's HTTP API.

Do not rewrite working Step 54 functionality.

---

## 1. Inspect the actual repository first

Before editing anything, inspect:

1. `docs/architecture/17-implementation-roadmap.md` — the Phase 8 step for Simulation HTTP APIs.
2. `docs/architecture/04-system-architecture-diagrams.md` — simulation architecture.
3. `docs/architecture/05-component-responsibilities.md` — API and Simulation Engine responsibilities.
4. `docs/architecture/02-product-scope.md` — MVP simulation boundary.
5. `docs/architecture/06-database-schema.md` — Scenario, Simulation, SimulationResult, and Evidence.
6. The Step 52 scenario/simulation repository and persistence implementation.
7. The Step 53 Rule Table and its public contracts.
8. The Step 54 `executeSimulation` implementation and tests.
9. Existing API routing in `apps/api`, including the native `node:http` server and route registration.
10. Existing Clerk authentication, user-to-organization resolution, tenant/RLS helpers, validation, error handling, and database repository conventions.
11. Existing API route tests and database integration-test patterns.
12. Current Git status, recent commits, and uncommitted changes.

Do not assume route files, repository functions, request schemas, or database columns exist at particular paths. Discover and reuse the actual implementations.

Do not mix nodes, scenarios, simulations, or evidence from different tenants or analysis runs.

---

## 2. Step 55 objective

Implement the following four HTTP endpoints, adapting their registration and method handling to the repository's established API conventions:

### Endpoint A — Create a scenario

`POST /scenarios`

Create a scenario using the existing Scenario domain model, database schema, and repository conventions.

The request must contain the fields required by the actual Scenario contract. Derive the exact request schema from the implementation and architecture rather than inventing a parallel model.

Validate:

- Required fields and data types.
- Scenario failure type.
- Target node identifier.
- Analysis-run identifier and its tenant ownership.
- Target-node membership in the intended analysis run.
- Any repository or project ownership constraints defined by the existing architecture.
- Optional scenario parameters using the existing domain contract.

For this MVP, the engine supports only:

- `unavailable`
- `latency`

Reject unsupported types such as `capacity` and `removal` explicitly. Do not silently reinterpret them.

Use the existing validation library and error-response format. If the schema supports descriptive metadata such as a name or description, validate it according to existing conventions.

Do not introduce a new database migration unless inspection establishes that the current schema is genuinely insufficient.

### Endpoint B — Run a scenario

`POST /scenarios/:id/run`

This endpoint must execute an existing, authorized scenario through the Step 54 implementation.

Required behavior:

1. Authenticate the request.
2. Resolve the user's authorized organization using the existing Clerk/tenant architecture.
3. Load the scenario within that tenant boundary.
4. Return the established not-found response when the scenario is missing or inaccessible.
5. Validate that the scenario references a valid, compatible analysis run and target node.
6. Create or initialize the Simulation record using the existing repository functions and lifecycle statuses.
7. Invoke `executeSimulation(...)` rather than reimplementing the propagation algorithm.
8. Persist results and simulation-state evidence using the established transactional behavior.
9. Return a response matching the actual execution outcome and existing API response conventions.

The execution path must preserve the existing lifecycle:

`pending → running → completed`

or the appropriate failure transition to `failed`.

**Do not create a new job queue or background worker.** The Step 54 implementation deliberately excludes them. Inspect `executeSimulation` to determine whether execution is synchronous and shape the HTTP response accordingly. Do not return `202 Accepted` or claim the run was queued unless asynchronous execution genuinely exists.

Repeated requests must not cause uncontrolled duplicate result rows or leave simulations stuck in an invalid state. Reuse existing idempotency behavior and database constraints. Do not invent a new idempotency protocol unless the architecture requires it.

### Endpoint C — Retrieve a simulation

`GET /simulations/:id`

Return the authenticated tenant's simulation metadata and current persisted status using the existing model.

Include the established fields needed by a client to identify and inspect the simulation, such as:

- Simulation identifier.
- Associated scenario identifier.
- Analysis-run identity where appropriate.
- Execution status.
- Existing timestamps or metadata.
- Rule-table version or summary fields only if supported by the current persistence contract.

Use the actual domain and API contracts. Do not fabricate fields or perform unnecessary schema changes.

The response must not expose any other tenant's simulation.

### Endpoint D — Retrieve simulation results

`GET /simulations/:id/results`

Return the persisted results associated with the specified, authorized simulation.

Reuse existing repository functions wherever possible. If a repository method is genuinely missing, introduce a small, well-scoped one that follows established database patterns.

Return the existing SimulationResult fields needed to explain the outcome, including where available:

- Node identifier.
- Resulting state.
- Applied rule.
- Propagation path.
- Assumptions.
- Confidence.
- Rule-table version or relevant causal metadata.

Preserve the serialized propagation-path contract. Do not discard causal steps, replace structured paths with summaries, or silently remove assumptions.

Ensure the results belong to the requested simulation, tenant, and analysis run.

Use a deterministic result ordering consistent with existing contracts. If pagination is already part of the API architecture, follow that convention; otherwise do not invent unnecessary pagination infrastructure.

---

## 3. Authentication and tenant isolation

Follow Fluxora's existing security model exactly.

- Reuse Clerk authentication middleware and identity resolution.
- Derive organization/tenant access from verified identity and existing membership rules.
- Never trust a caller-supplied organization ID as proof of authorization.
- Apply the existing `withTenant`/RLS patterns where applicable.
- Scope every scenario, simulation, result, and analysis-run query to the authorized tenant.
- Prevent cross-tenant access through both read and write endpoints.
- Preserve analysis-run boundaries already enforced by Step 54.

Where the existing API intentionally uses a not-found response for inaccessible resources, preserve that behavior to avoid leaking resource existence.

Do not weaken authentication or authorization to make integration tests pass.

---

## 4. Request validation and error handling

Reuse the API's existing request validation and error infrastructure.

Handle, consistently and safely:

- Missing or invalid authentication.
- Malformed JSON.
- Missing required parameters.
- Invalid identifiers.
- Invalid scenario data.
- Unsupported simulation failure types.
- Missing or inaccessible scenarios and simulations.
- Invalid analysis-run or target-node references.
- Unsupported HTTP methods, following established routing conventions.
- Database failures.
- Simulation execution failures.

Use established HTTP status codes and the repository's standard error envelope. Choose the exact codes based on the current API conventions and distinguish validation errors from authorization failures and internal errors.

Never return raw stack traces, SQL details, secrets, or internal exception diagnostics to clients. Preserve useful internal logging according to existing conventions.

Validate request-body size and parsing behavior using the server's existing safeguards.

Do not introduce a parallel HTTP framework or a second authentication system.

---

## 5. API architecture and boundaries

Keep the responsibilities separate:

- HTTP layer: routing, authentication, parsing, validation, status codes, and serialization.
- Scenario persistence: existing scenario repository and database contracts.
- Simulation execution: existing `executeSimulation(...)`.
- Pure propagation logic: existing `runSimulationEngine(...)`.
- Evidence: existing EvidenceWriter and transactional persistence.
- Authorization: existing organization and tenant boundaries.

Do not put a duplicate simulation-propagation algorithm in the route handler.

Do not bypass the EvidenceWriter.

Do not create raw SimulationResult or Evidence SQL writes inside HTTP handlers when an appropriate repository function already exists.

Do not add speculative service layers solely to make the code look more abstract than the existing repository warrants.

---

## 6. Required API tests

Add route-level tests using the existing API test infrastructure and integration tests where appropriate.

At minimum, cover the following cases.

### Scenario creation

1. Authenticated request creates a valid scenario.
2. Missing required fields are rejected.
3. Malformed JSON returns the established validation response.
4. Unsupported failure types are rejected.
5. Nonexistent target nodes are rejected.
6. Target nodes and analysis runs from incompatible runs are rejected.
7. A caller cannot create a scenario in another tenant's scope.
8. Valid optional fields and parameters are handled according to the actual schema.

### Scenario execution

9. Authorized scenario execution invokes `executeSimulation(...)`.
10. Successful execution returns the actual persisted execution outcome.
11. Unsupported or invalid scenarios fail explicitly.
12. Missing or inaccessible scenarios do not execute.
13. Repeated execution does not produce uncontrolled duplicate SimulationResult rows.
14. A failed execution is represented according to the established failed-status contract.
15. Simulation-result evidence remains governed by the Step 54 transactional invariant.

### Simulation retrieval

16. A tenant can retrieve its own simulation.
17. A nonexistent simulation returns the standard not-found response.
18. A tenant cannot retrieve another tenant's simulation.
19. Persisted status and metadata are returned accurately.

### Result retrieval

20. Results belong only to the requested simulation.
21. Results cannot be retrieved across tenant boundaries.
22. The response preserves causal paths, rule IDs, assumptions, and confidence.
23. Results are returned in deterministic order.
24. An authorized simulation with no persisted results is handled according to established API conventions.

Add further tests for any relevant edge cases exposed by the existing implementation.

Use real database integration tests for database isolation and transactional claims where the repository supports them. Clearly distinguish tests using mocks from tests that exercised PostgreSQL/RLS behavior.

---

## 7. Backward compatibility and scope restrictions

Do not:

- Rewrite Step 54's Simulation Engine.
- Redefine Step 53 rules or state severity.
- Introduce new simulation failure types.
- Add AI/LLM reasoning.
- Add runtime telemetry or APM ingestion.
- Introduce background workers, job queues, or distributed simulation.
- Implement frontend simulation mode or WebSocket UI.
- Implement Step 58 golden-fixture validation.
- Create redundant database tables or duplicate domain models.
- Make unrelated refactors or unrelated bug fixes.

Avoid database migrations unless the audit proves a required schema capability is absent.

---

## 8. Documentation

Update `docs/DESIGN.md` with a Global Step 55 section documenting:

- The four API endpoints.
- Request and response contracts.
- Authentication and tenant-scoping behavior.
- Scenario-validation rules.
- The relationship between API orchestration and `executeSimulation`.
- Status and failure handling.
- Results serialization.
- Error-handling conventions.
- Current synchronous/asynchronous execution behavior as actually implemented.
- Explicit exclusions and the Step 56 dependency.

Follow the repository's established learning-artifact pattern. Create a Step 55 implementation summary, engineering notes, and interview notes in the appropriate existing folders if that pattern is still current.

Keep documentation consistent with the actual code and tests.

---

## 9. Verification

Run and report the actual outcomes of:

1. Focused Step 55 API route tests.
2. Relevant database integration tests.
3. `pnpm --filter @fluxora/api test`
4. `pnpm --filter @fluxora/db test`
5. `pnpm test`
6. `pnpm typecheck`
7. `pnpm lint`
8. `pnpm lint:evidence`
9. `pnpm build`
10. `git diff --check`

Use the exact scripts available in the current repository. If a command is unavailable, explain the discrepancy and use the established equivalent.

Do not claim a command passed without an actual successful exit code. Report skipped tests and infrastructure limitations explicitly.

Inspect the final Git diff and ensure no unrelated changes were introduced.

---

## 10. Final report

Produce:

# Fluxora Step 55 — Simulation HTTP APIs

Include:

### Implementation
- Files created and modified.
- Endpoint contracts and HTTP methods.
- Authentication and tenant isolation.
- Validation and error handling.
- Scenario creation and simulation execution flow.
- Simulation/result retrieval.
- Persistence and evidence invariants.

### Verification
A table listing every requested command, its actual result, passed/skipped test counts, and any limitations.

### Scope
Explicitly confirm that:

- Step 54's engine was reused rather than duplicated.
- No Step 56 frontend simulation mode was introduced.
- No Step 58 golden-fixture validation was introduced.
- No unsupported simulation types were added.
- No unrelated changes were made.

Conclude whether Step 55 satisfies the implemented acceptance criteria. If something remains incomplete, identify it clearly rather than declaring success prematurely.