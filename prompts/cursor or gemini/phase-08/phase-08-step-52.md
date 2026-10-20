You are implementing Fluxora Phase 8, Step 52 only.

STEP 52: SCENARIO / SIMULATION / SIMULATION RESULT PERSISTENCE

Goal:
Implement the database and typed persistence foundation for Fluxora's simulation system:

- Scenario
- Simulation
- SimulationResult

This step is ONLY the persistence/domain-contract foundation.

Do NOT implement the simulation rule table.
Do NOT implement the propagation engine.
Do NOT implement simulation APIs.
Do NOT implement simulation UI.
Do NOT implement animation.
Do NOT implement AI narration.

Those are later Phase 8 steps.

==================================================
1. AUTHORITATIVE ROADMAP
==================================================

The canonical roadmap says Phase 8 is:

Phase 8 — Simulation
Goal: Rule-based scenario propagation.

Phase 8 steps:
1. Implement Scenario, Simulation, SimulationResult tables.
2. Design and implement the initial rule table.
3. Implement Simulation Engine.
4. Implement scenario/simulation APIs.
5. Implement simulation-mode frontend.
6. Add rule-table tests.
7. Validate with golden fixture.

THIS TASK IS ONLY STEP 1.

==================================================
2. ARCHITECTURAL SOURCE OF TRUTH
==================================================

Inspect before coding:

- docs/architecture/17-implementation-roadmap.md
- docs/architecture/05-component-responsibilities.md §5.10
- docs/architecture/06-database-schema.md
- docs/architecture/07-api-architecture.md
- docs/architecture/04-system-architecture-diagrams.md §4.7
- docs/architecture/02-product-scope.md
- docs/architecture/03-architecture-principles.md
- docs/architecture/11-security-architecture.md
- docs/architecture/12-testing-strategy.md
- docs/DESIGN.md

Use the canonical architecture package when there is any conflict.

==================================================
3. EXACT DOMAIN CONTRACT
==================================================

The architectural database model defines:

Scenario:

id,
organization_id,
repository_id,
name,
target_node_id,
failure_type,
parameters,
created_by,
created_at

Where:

failure_type =
- unavailable
- latency
- capacity
- removal

Simulation:

id,
scenario_id,
analysis_run_id,
status,
created_at

SimulationResult:

id,
simulation_id,
node_id,
resulting_state,
propagation_path,
rule_applied,
assumptions,
confidence

Where resulting_state =
- healthy
- degraded
- at_risk
- failed

Do not silently rename these concepts.

Use the repository's established TypeScript naming convention when mapping DB snake_case to TypeScript camelCase.

==================================================
4. IMPORTANT MVP SCOPE DISTINCTION
==================================================

The Scenario schema supports:

- unavailable
- latency
- capacity
- removal

because this is the architectural domain model.

However, the MVP simulation RULE TABLE is explicitly limited to:

- infra-unavailable
- latency-degradation

Do NOT implement rule behavior for:
- capacity
- removal

in Step 52.

Do not reject those values at the database schema level merely because rule support comes later, unless the canonical architecture explicitly requires such a constraint.

Step 52 stores the scenario definition.

Step 53 will define what each scenario type actually does.

==================================================
5. INSPECT EXISTING DATABASE PATTERNS
==================================================

Before creating anything inspect:

- existing migrations
- Repository tables
- AnalysisRun table
- GraphNode table
- User/organization tables
- existing RLS policies
- foreign-key conventions
- UUID/default conventions
- timestamp conventions
- indexes
- repository implementations
- shared-type definitions
- test conventions

Reuse the established patterns.

Do NOT introduce a new ORM.

Do NOT introduce Prisma/Drizzle/etc. if the repository currently uses direct PostgreSQL access.

Use the existing @fluxora/db architecture.

==================================================
6. DATABASE MIGRATION
==================================================

Create the next forward-only migration.

Do NOT modify an already-applied migration.

Create:

- scenarios
- simulations
- simulation_results

Use UUID primary keys consistent with the existing schema.

Use existing timestamp conventions.

Expected relationships:

Scenario
    organization
    repository
    target graph node
    creator/user

Simulation
    scenario
    analysis run

SimulationResult
    simulation
    graph node

Use foreign keys where the existing architecture supports them safely.

Do not invent cross-table relationships not supported by the architecture.

==================================================
7. TENANCY / RLS
==================================================

Tenant isolation is mandatory.

Scenario explicitly carries:

organization_id

Simulation and SimulationResult should be scoped transitively through their parent relationships according to the existing Fluxora RLS architecture.

Inspect how current child tables such as graph_nodes / graph_edges / evidence achieve tenant isolation.

Follow the established pattern exactly.

Requirements:
- one organization cannot read another organization's scenarios,
- simulation rows cannot escape their scenario's tenant,
- simulation results cannot escape their simulation/scenario tenant,
- no client-controlled organization authority,
- preserve existing RLS session mechanics.

Use FORCE ROW LEVEL SECURITY when that is the existing convention.

Add appropriate policies and indexes.

==================================================
8. INDEXING
==================================================

Use indexes based on actual access patterns.

At minimum, investigate indexes for:

Scenario:
- organization_id
- repository_id
- target_node_id

Simulation:
- scenario_id
- analysis_run_id

SimulationResult:
- simulation_id
- node_id

Do not blindly create excessive indexes.

Use the same indexing style as existing Fluxora tables.

Document why each non-obvious index exists.

==================================================
9. CONSTRAINTS / DATA INTEGRITY
==================================================

Add database constraints where they are explicit and safe.

Examples:

failure_type:
- unavailable
- latency
- capacity
- removal

resulting_state:
- healthy
- degraded
- at_risk
- failed

Do NOT use free-form strings when the existing architecture clearly defines bounded values.

parameters:
- JSONB
- default empty object only if that matches existing repository conventions

propagation_path:
- JSONB

assumptions:
- JSONB

confidence:
- numeric range 0.0–1.0 if the repository already enforces this pattern elsewhere

Do not invent additional validation that belongs to Step 53's rule engine.

==================================================
10. ANALYSIS-RUN SNAPSHOT BOUNDARY
==================================================

Simulation belongs to a specific graph snapshot.

Simulation contains:

analysis_run_id

This is important.

A simulation must never silently combine:
- one Scenario target from one graph run
with
- results computed against another graph run.

At the persistence layer:
- store the explicit analysis_run_id,
- preserve the relationship,
- add appropriate indexes,
- validate IDs and ownership consistently with existing repositories.

Do not implement propagation validation here.

That belongs to the Simulation Engine.

==================================================
11. SCENARIO TARGET NODE
==================================================

Scenario.target_node_id identifies the graph node being subjected to the scenario.

Simulation does NOT independently redefine the target.

The Scenario owns:
- what is being simulated
- why/name
- failure type
- parameters

Simulation owns:
- which analysis run/snapshot was used
- lifecycle/status

SimulationResult owns:
- per-node resulting state
- propagation path
- rule
- assumptions
- confidence

Preserve this separation.

==================================================
12. SIMULATION STATUS
==================================================

Inspect the existing Fluxora job/status conventions before choosing the Simulation.status values.

Do not invent a large state machine.

Define the smallest status set required for persistence and later execution.

It must support at least the lifecycle needed by the architecture:

- pending/queued
- running
- completed
- failed

Use the repository's established terminology if a compatible job/status enum already exists.

Document the decision.

Do NOT implement status transitions or execution behavior in Step 52.

==================================================
13. TYPES
==================================================

Add shared domain/API-safe types where the repository convention requires them.

Potential conceptual types:

Scenario
Simulation
SimulationResult

ScenarioFailureType:
- unavailable
- latency
- capacity
- removal

SimulationResultState:
- healthy
- degraded
- at_risk
- failed

SimulationStatus:
use the canonical repository status vocabulary discovered during inspection.

Do not create API request/response contracts for Step 52 unless existing architecture requires them.

Step 54 will own API behavior.

==================================================
14. REPOSITORY LAYER
==================================================

Implement database repository functions following existing @fluxora/db conventions.

At minimum consider:

Scenario:
- create
- get by id
- list by repository or organization
- delete only if the architecture permits deletion
- otherwise preserve append-only/immutability conventions

Simulation:
- create
- get by id
- update lifecycle status only if existing persistence patterns support this

SimulationResult:
- insert result
- list by simulation
- get by id if required by existing repository conventions

IMPORTANT:

Do not implement simulation execution.

These repositories only persist and retrieve domain records.

Use:
- authenticated organization scope where applicable,
- tenant transaction helpers,
- parameterized SQL,
- existing UUID validation,
- existing mapping functions,
- deterministic ordering.

Do not expose raw database rows directly.

==================================================
15. IMMUTABILITY / UPDATE RULES
==================================================

Inspect the architecture before deciding mutability.

Scenario is the definition of a what-if experiment.

Simulation records execution of a scenario against a specific analysis run.

SimulationResult records the result of that execution.

Do not create a generic "edit anything" repository.

Lifecycle status may need controlled updates.

Results should not be silently overwritten across unrelated simulation executions.

Respect existing idempotency and append-only conventions where applicable.

If the architecture does not yet specify an update policy, implement the minimum necessary persistence API and document the limitation.

==================================================
16. EVIDENCE BOUNDARY
==================================================

Do NOT implement simulation evidence generation in this step.

However, preserve the existing architecture:

Evidence.subject_type already supports:

simulation_state

Step 53/Simulation Engine must later associate every state change with:
- the graph edge,
- the rule,
- and the evidence that justified the transition.

Step 52 only establishes the storage foundation.

Do NOT weaken the existing `pnpm lint:evidence` contract.

Do NOT modify EvidenceWriter merely to add simulation behavior.

==================================================
17. NO RULE TABLE YET
==================================================

Do NOT implement:

- CALLS + sync + no fallback
- circuit-breaker logic
- WRITES failure propagation
- EMITS consumer propagation
- latency degradation propagation
- fallback behavior
- convergence loop
- BFS/DFS simulation traversal

Those belong to Steps 53+.

Step 52 must not contain code that decides:

"Given this edge and this failure, set the node to DEGRADED."

==================================================
18. NO FRONTEND YET
==================================================

Do NOT implement:
- simulation mode
- graph state coloring
- assumptions panel
- simulation controls
- scenario creation UI
- animation
- timeline controls

Those belong to later Phase 8 steps.

==================================================
19. SECURITY
==================================================

Follow existing security architecture.

Scenario creation/persistence must be tenant-scoped.

Target node must belong to:
- the selected repository,
- and ultimately the authenticated organization.

Analysis run must correspond to the same repository context.

Simulation and SimulationResult must not become cross-tenant foreign-key escape paths.

Do not trust organization_id supplied by a client as authorization.

The API layer will derive organization identity from auth.

==================================================
20. TESTING
==================================================

Create focused database/type tests for Step 52.

At minimum cover:

A. Scenario schema
- create valid scenario
- failure type values
- invalid failure type rejected
- parameters JSON persisted
- organization/repository/target relationships

B. Simulation schema
- valid simulation references scenario
- analysis_run_id persisted
- status validation
- invalid status rejected

C. SimulationResult schema
- valid states accepted
- invalid state rejected
- JSON propagation_path persists
- JSON assumptions persist
- confidence range handled correctly

D. Tenant isolation
- tenant A cannot read tenant B scenario
- tenant A cannot read tenant B simulation
- tenant A cannot read tenant B results

E. Repository behavior
- deterministic ordering
- invalid IDs handled consistently
- missing records return existing null/not-found conventions
- no cross-run mixing

F. Migration
- migration applies cleanly
- schema test sees all three tables
- indexes/constraints exist as intended

Do not write tests for rule behavior yet.

==================================================
21. LEARNING ARTIFACTS
==================================================

Preserve the exact Fluxora learning pattern.

Create:

learning/implementations/phase-08/step-52-simulation-persistence-foundation.md

learning/notes/52. Simulation Persistence Foundation.md

learning/interviews/52. Step 52 Simulation Persistence Foundation Interview CheatSheet.md

Update:

docs/DESIGN.md

Documentation must explain:

- why simulation needs separate Scenario / Simulation / SimulationResult entities
- Scenario vs Simulation vs SimulationResult responsibilities
- analysis-run snapshot boundary
- tenancy/RLS
- persistence relationships
- lifecycle status
- JSONB fields
- failure type vs rule support distinction
- evidence boundary
- why rule logic is intentionally excluded
- why execution engine is intentionally excluded
- future Step 53 boundary
- senior/staff interview reasoning

Use the same terminology and depth as the previous Fluxora learning artifacts.

==================================================
22. DESIGN.MD
==================================================

Update docs/DESIGN.md with the actual Step 52 implementation.

Document:
- new entities
- table relationships
- important constraints
- indexes
- tenant isolation
- analysis-run scoping
- repository layer
- status model
- evidence relationship reserved for later engine work
- explicit Step 53 boundary

Do not rewrite unrelated architecture.

==================================================
23. SCOPE BOUNDARY
==================================================

DO NOT IMPLEMENT:

- Rule Table
- Simulation Engine
- propagation
- convergence
- scenario API
- simulation-run API
- simulation GET API
- simulation frontend
- graph state coloring
- assumptions UI
- animation
- AI reasoning
- runtime telemetry
- new evidence-writing path
- Phase 9 work

This is Step 52 only:

DATABASE + DOMAIN TYPES + PERSISTENCE FOUNDATION.

==================================================
24. VERIFICATION
==================================================

Run focused checks first:

- relevant db schema tests
- relevant repository tests
- shared-types tests

Then:

pnpm typecheck
pnpm lint
pnpm lint:evidence
pnpm build
pnpm test
git diff --check

Also verify migration application using the repository's normal migration command.

Use the existing Fluxora migration workflow.

Do not claim migration success without actually running it.

==================================================
25. FINAL DIFF REVIEW
==================================================

Review the final diff for:

- only Step 52 changes
- no simulation engine logic
- no rule table
- no APIs
- no frontend simulation UI
- no unrelated refactors
- no generated artifacts
- no secrets
- no node_modules

==================================================
26. FINAL REPORT
==================================================

Report:

1. Step 52 status
2. migration filename/version
3. Scenario schema
4. Simulation schema
5. SimulationResult schema
6. foreign keys
7. indexes
8. constraints/enums
9. RLS/tenant isolation
10. analysis-run boundary
11. repository functions
12. shared types
13. test results
14. typecheck
15. lint
16. evidence lint
17. build
18. git diff --check
19. limitations
20. exact Step 53 boundary

Explicitly confirm:

- Rule table NOT implemented.
- Simulation Engine NOT implemented.
- Simulation APIs NOT implemented.
- Simulation frontend NOT implemented.
- Evidence writing for simulation state changes NOT implemented yet.

Do NOT commit or push.