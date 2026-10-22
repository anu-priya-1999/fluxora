You are implementing **Fluxora Step 54 — Simulation Engine**.

Step 53 is complete and verified. It provides the deterministic, versioned Simulation Rule Table with exactly four normative rules and explicit conservative metadata handling.

Your job now is to implement the **Simulation Engine: deterministic scenario propagation with convergence, causal paths, assumptions/confidence, and evidence-backed simulation state changes**.

Read the repository and architecture first. Do not assume file locations.

============================================================
1. AUTHORITATIVE SOURCES
============================================================

Read these before changing code:

1. docs/architecture/17-implementation-roadmap.md
   - Phase 8 — Simulation
   - Step 3: Implement the Simulation Engine

2. docs/architecture/04-system-architecture-diagrams.md
   - §4.7 Simulation architecture

3. docs/architecture/05-component-responsibilities.md
   - §5.10 Simulation Engine

4. docs/architecture/06-database-schema.md
   - Evidence
   - Scenario
   - Simulation
   - SimulationResult

5. docs/architecture/12-testing-strategy.md
   - §12.1 Policy/rules
   - simulation full-scenario testing requirements

6. docs/architecture/02-product-scope.md
   - MVP simulation boundary

7. Existing Step 52 implementation:
   - Scenario
   - Simulation
   - SimulationResult
   - repository functions
   - RLS conventions

8. Existing Step 53 implementation:
   - SimulationRuleInput
   - SimulationRuleDecision
   - SimulationRuleTable
   - evaluateSimulationRule(...)
   - evaluateAllSimulationRules(...)
   - createSimulationRuleInputFromEdge(...)
   - isStateMoreSevere(...)

Do not duplicate the Step 53 rule system.

============================================================
2. STEP 54 GOAL
============================================================

Implement:

Scenario
  ↓
initialize graph state
  ↓
seed target failure/degradation
  ↓
deterministic propagation worklist
  ↓
evaluate Step 53 Rule Table
  ↓
apply only state-worsening transitions
  ↓
record causal propagation path
  ↓
repeat until no more state changes
  ↓
converged Simulation Engine result
  ↓
persist SimulationResult + simulation-state evidence atomically

The engine must be deterministic and terminating.

============================================================
3. STRICT STEP 54 BOUNDARY
============================================================

IMPLEMENT:

- Simulation Engine
- graph snapshot loading/normalization required by the engine
- deterministic propagation loop
- convergence detection
- state transition tracking
- causal propagation paths
- rule/version tracking
- assumptions aggregation
- confidence propagation
- target-node scenario seeding
- evidence-backed simulation state persistence
- simulation execution status handling where needed by engine execution
- unit tests
- small hand-built full-scenario tests
- evidence tests for simulation state conclusions
- learning artifacts
- docs/DESIGN.md

DO NOT IMPLEMENT:

- Simulation HTTP APIs
- POST /scenarios
- POST /scenarios/:id/run
- GET /simulations/:id
- frontend simulation mode
- WebSocket simulation UI
- AI reasoning
- LLM calls
- runtime telemetry
- APM integration
- OpenTelemetry ingestion
- capacity/traffic simulation
- queueing theory
- traffic multipliers
- removal simulation
- distributed simulation
- background simulation workers
- job queues
- golden-fixture validation

Step 55 owns the HTTP API.

Step 56 owns the frontend simulation overlay.

Step 58 owns golden-fixture validation.

Do not pull future work into Step 54.

============================================================
4. FIRST INSPECT THE ACTUAL IMPLEMENTATION
============================================================

Before editing:

- inspect git status
- inspect recent commits
- inspect Step 52 simulation repository
- inspect Step 53 simulation rule implementation
- inspect GraphNode/GraphEdge shared types
- inspect graph repository queries
- inspect EvidenceWriter
- inspect existing transaction helpers
- inspect existing database repository patterns
- inspect existing test patterns

Determine the cleanest architecture from the codebase.

Prefer reuse over creating parallel abstractions.

Do not create duplicate graph models, duplicate state enums, or duplicate rule definitions.

============================================================
5. ARCHITECTURAL RESPONSIBILITY
============================================================

The architecture defines Simulation Engine responsibility as:

Deterministically propagate a scenario
(infra failure, latency injection, node removal)
across the graph
using the explicit Rule Table.

For MVP, only:

- unavailable
- latency

are supported.

Do not implement:

- capacity
- removal

even though Step 52's persistence schema can represent them.

Unsupported Step 54 failure types must fail clearly rather than silently behaving as something else.

============================================================
6. ENGINE INPUT
============================================================

Create a clean engine input contract based on the existing codebase.

Conceptually it needs:

- Scenario
- graph snapshot
- target node
- failure type
- scenario parameters
- analysisRunId / snapshot identity where required
- simulation/rule-table version where required

Prefer a structure conceptually similar to:

type SimulationEngineInput = {
  scenario: Scenario;
  graph: SimulationGraphSnapshot;
  ruleTable?: SimulationRuleTable;
};

But adapt naming to the repository's actual conventions.

The graph snapshot must contain:

- all relevant nodes
- all relevant edges
- edge metadata required by Step 53
- analysis-run identity

The engine must never combine nodes/edges from different analysis runs.

Validate this boundary defensively.

============================================================
7. ENGINE OUTPUT
============================================================

The engine must produce a deterministic result suitable for persistence.

Conceptually:

type SimulationEngineResult = {
  converged: boolean;
  iterations: number;
  ruleTableVersion: string;
  results: SimulationEngineNodeResult[];
};

Each node result should contain enough information to become:

SimulationResult:

- nodeId
- resultingState
- propagationPath
- ruleApplied
- assumptions
- confidence

The engine output should also preserve causal transition information needed for EvidenceWriter.

Do not invent a completely different persistence representation when the existing SimulationResult type already provides the correct shape.

============================================================
8. INITIAL STATE
============================================================

Initialize every graph node to:

healthy

Then seed the scenario target.

Use the existing domain contracts and architecture to determine the minimal deterministic seed behavior.

For MVP the intended semantic meaning is:

- unavailable scenario → target becomes failed
- latency scenario → target becomes degraded

If the repository already has an explicit seed abstraction, reuse it.

If no such abstraction exists, introduce only this minimal seed mapping and document it clearly as the engine's scenario-seed rule.

Do NOT add numerical latency semantics.

Do NOT add milliseconds, p95, p99, queueing, throughput, or capacity calculations.

The target seed must be explicitly represented in the causal history as:

ruleApplied = "target_failure"

or the repository's equivalent stable identifier.

============================================================
9. PROPAGATION ALGORITHM
============================================================

Implement a deterministic worklist-based propagation algorithm.

Do NOT implement uncontrolled recursive function calls.

Recommended conceptual flow:

1. Create state map:
   every node = HEALTHY

2. Seed target:
   unavailable → FAILED
   latency → DEGRADED

3. Put the changed target node into a deterministic work queue.

4. While queue is not empty:

   a. dequeue the next changed node

   b. find incident graph edges relevant to that node

   c. process edges in deterministic order

   d. construct SimulationRuleInput from:
      - edge
      - current source state
      - current target state
      - scenario failure type
      - edge metadata

   e. evaluate the existing Step 53 Rule Table

   f. if no rule matches:
      do nothing

   g. if a rule matches:
      determine affected node from the rule decision

   h. compare the proposed state with the affected node's current state

   i. apply the change ONLY when the new state is strictly more severe

   j. record the transition

   k. enqueue the newly changed node

5. Continue until the queue is empty.

6. The queue becoming empty means the graph reached a stable state.

Use the existing Step 53 severity ordering:

failed > degraded > at_risk > healthy

Do not duplicate this ranking in another location.

============================================================
10. WHY WORKLIST + STATE MONOTONICITY
============================================================

The engine must terminate even when the graph contains cycles.

Simulation state transitions are monotonic:

healthy
→ at_risk
→ degraded
→ failed

Never move a node backwards.

For example:

degraded → at_risk

must NOT happen.

A cycle such as:

A → B → C → A

must eventually converge because state severity can only move upward and the set of possible states is finite.

Use the existing:

isStateMoreSevere(...)

helper from Step 53.

Do not create a second severity hierarchy.

============================================================
11. DETERMINISTIC EDGE PROCESSING
============================================================

Results must not depend on incidental ordering.

Sort or otherwise deterministically order:

- graph edges
- adjacency/incident-edge processing
- transition records
- final result ordering

Never rely on:

- database default order
- object iteration order
- filesystem order
- UUID generation order

For equal-severity competing explanations:

- preserve the first deterministic causal explanation
- do not randomly replace it
- use stable edge/rule ordering

Document the tie-breaking behavior.

============================================================
12. PROPAGATION DIRECTION
============================================================

Do NOT hard-code one universal graph direction.

The Step 53 Rule Decision already identifies the affected side:

- source
- target
- none

Use that contract.

For example:

CALLS:
  impaired callee
  → caller becomes DEGRADED

Therefore the engine must be able to inspect the incident edge from either side and apply the rule's declared affected node.

WRITES / QUERIES_DB:
  impaired datastore
  → dependent reader becomes AT_RISK

EMITS / CONSUMES_EVENT:
  impaired event/broker
  → consumer becomes AT_RISK

The engine must not assume that all propagation means:

source → target

============================================================
13. INCIDENT EDGE LOOKUP
============================================================

For each changed node, retrieve/process all incident edges that could cause propagation.

The implementation should allow rules to reason about either:

- changed source node
- changed target node

Only rules that match should cause propagation.

Do not traverse unrelated edge types merely because they are connected.

Step 53 already defines the supported rule semantics.

The engine should delegate rule semantics to Step 53 rather than duplicating conditional logic.

============================================================
14. PROPAGATION PATH
============================================================

Every changed node needs a deterministic causal path.

Example:

payment-service
  FAILED

checkout-service
  DEGRADED
  because CALLS edge payment → checkout
  under calls.sync.no_fallback

orders-service
  DEGRADED
  because checkout-service became DEGRADED
  via another CALLS edge

The result for each node should be sufficient to answer:

"Why did this node reach this state?"

Represent propagation_path using the existing SimulationResult JSONB contract.

Prefer structured steps containing:

- node id
- edge id
- rule id
- rule version
- previous state
- resulting state
- assumptions
- confidence

Use actual graph IDs.

Do not store fake file paths or fake source locations.

============================================================
15. MULTI-HOP PROPAGATION
============================================================

The engine must support more than one hop.

Example:

Payment
  FAILED
    ↓
Checkout
  DEGRADED
    ↓
Orders
  DEGRADED
    ↓
Subscriptions
  AT_RISK

The engine must keep propagating until stable.

Do not impose the Impact Analysis engine's max-depth configuration here.

This is a finite-state simulation convergence problem, not a bounded-impact query.

Termination comes from monotonic state transitions and convergence.

============================================================
16. CYCLES
============================================================

Add explicit tests for cycles.

Example:

A CALLS B
B CALLS A

One node is seeded as failed.

The engine must:

- terminate
- produce stable states
- never repeatedly enqueue forever
- never duplicate causal transitions indefinitely

Do not solve this with a fixed arbitrary hop count.

The primary termination mechanism must be:

- monotonic state changes
- work queue
- convergence

A safety guard may exist as a defensive invariant, but it must never be the normal termination mechanism.

If a safety guard is triggered:

- fail the run explicitly
- do not return a partial "successful" result
- surface enough diagnostics to debug the graph/rule behavior

============================================================
17. CONFIDENCE PROPAGATION
============================================================

Use confidence from Step 53 decisions.

Do NOT invent a completely new confidence model.

For each state transition preserve:

- rule confidence
- assumptions

For multi-hop propagation, deterministic confidence should reflect the causal chain.

Before implementing a new decay formula, inspect existing Fluxora confidence conventions.

Do not reuse the Impact Analysis decay mechanism unless the existing architecture explicitly defines it for simulation.

If the architecture does not specify a mathematical simulation decay formula, preserve the rule decision confidence and document that simulation confidence is currently rule/assumption-derived rather than introducing an arbitrary formula.

============================================================
18. ASSUMPTION PROPAGATION
============================================================

A propagated result must retain assumptions from the rule decisions that caused it.

Example:

edge metadata unknown
→ Step 53 returns assumption:
"No fallback handler detected on call"
→ engine carries that assumption into the affected node's SimulationResult.

For multi-hop paths:

combine assumptions deterministically
without duplicates.

Do not hide assumptions.

============================================================
19. RULE VERSION
============================================================

Every simulation execution result must know which Rule Table version produced it.

Reuse Step 53's:

DEFAULT_SIMULATION_RULE_TABLE_VERSION

or equivalent existing constant.

Do not hard-code another independent version string in the engine.

The persisted SimulationResult.rule_applied must identify the rule used.

============================================================
20. EVIDENCE REQUIREMENT — IMPORTANT
============================================================

Step 54 is the first step where simulated state conclusions are produced.

Architecture requires every state change to be traceable to:

- the graph edge
- the rule that caused it
- base evidence supporting that graph relationship

The existing Evidence model supports:

subject_type = "simulation_state"

and:

subject_id = simulation result id.

Use the existing EvidenceWriter abstraction.

Do NOT fabricate source locations.

For simulation evidence:

- cite the underlying graph-edge evidence/provenance
- preserve the actual source file/line information when available
- preserve analysis_run_id
- preserve confidence
- describe the simulation relationship explicitly

Example relationship description:

"Simulation state changed from healthy to degraded because rule calls.sync.no_fallback propagated impairment across graph edge <edge-id>."

When a multi-hop state change has no direct source-file line of its own:

- do not invent lines
- use the base edge's evidence
- put the causal path in the simulation-state metadata/propagation path

============================================================
21. EVIDENCE PERSISTENCE
============================================================

The architecture requires simulation conclusions and evidence to be persisted atomically.

Reuse existing transaction patterns.

A simulation state should never exist as a successful persisted conclusion without its corresponding evidence.

Prefer:

BEGIN
  create/update SimulationResult
  create simulation_state Evidence
COMMIT

On evidence failure:

ROLLBACK

Do not leave an unevidenced SimulationResult behind.

Use the existing deterministic EvidenceWriter ID generation and validation.

Do not bypass EvidenceWriter with raw evidence INSERTs.

============================================================
22. EVIDENCE LINT
============================================================

The existing evidence lint currently protects graph/impact conclusion paths.

Step 54 introduces a new conclusion-producing path.

Extend the evidence lint architecture where necessary so simulation-state writes cannot bypass EvidenceWriter.

Do this without weakening existing Step 48 checks.

Add tests proving:

- simulation result write path is detected
- direct evidence bypass would fail the lint
- proper EvidenceWriter usage passes

Keep the linter deterministic.

============================================================
23. DATABASE SCOPE
============================================================

Step 52 already created:

- scenarios
- simulations
- simulation_results

Do NOT create another migration unless inspection proves something in the current schema is genuinely missing for Step 54.

Prefer the existing schema.

Use existing repository functions and transaction helpers.

Respect:

- organization tenant boundaries
- repository boundaries
- analysis_run boundaries
- RLS

The engine must never mix graph data from another analysis run.

============================================================
24. SIMULATION STATUS
============================================================

Reuse the existing Simulation statuses:

- pending
- running
- completed
- failed

Where engine execution owns status updates:

pending
→ running
→ completed

or:

pending/running
→ failed

Do not introduce new statuses.

Do not expose these through an HTTP API yet.

============================================================
25. FAILURE BEHAVIOR
============================================================

Fail explicitly when:

- scenario target node is absent
- target node belongs to a different analysis run
- graph snapshot is internally inconsistent
- unsupported failure type is supplied
- required graph data is invalid
- evidence persistence fails
- convergence safety guard is triggered

Do not silently produce plausible-looking results.

Simulation is a deterministic trust-sensitive feature.

============================================================
26. PURE ENGINE VS DATABASE ORCHESTRATION
============================================================

Prefer a clean separation:

A. Pure/domain engine

Input:
scenario + graph snapshot + rule table

Output:
deterministic in-memory simulation result + transition/evidence descriptors

B. Persistence/orchestration layer

Responsible for:

- Simulation status
- SimulationResult persistence
- EvidenceWriter
- transaction
- tenant/run boundaries

Do not put SQL, PostgreSQL clients, or React concerns inside the pure propagation algorithm.

This separation is important for unit testing.

Use existing package boundaries rather than creating a new package unnecessarily.

============================================================
27. TESTS — REQUIRED
============================================================

Step 54 must have both:

A. Rule integration with the engine
B. Full-scenario tests against hand-built graphs

Do NOT defer full-scenario tests to Step 58.

Create focused engine tests covering at minimum:

------------------------------------------------------------
Test 1 — single unavailable target
------------------------------------------------------------

Target node:

PaymentService

Scenario:

unavailable

Expected:

PaymentService = FAILED

No other node changes if no relevant dependency exists.

------------------------------------------------------------
Test 2 — one-hop synchronous CALLS
------------------------------------------------------------

PaymentService = FAILED

CheckoutService --CALLS(sync,no fallback)--> PaymentService

Expected:

CheckoutService = DEGRADED

------------------------------------------------------------
Test 3 — two-hop propagation
------------------------------------------------------------

PaymentService = FAILED
CheckoutService = DEGRADED
OrdersService = DEGRADED

Verify the second hop is actually caused by CheckoutService's new state.

------------------------------------------------------------
Test 4 — circuit breaker
------------------------------------------------------------

Failed callee
+
CALLS
+
circuit breaker

Expected:

caller = DEGRADED
capped = true

Propagation behavior must come from Step 53.

------------------------------------------------------------
Test 5 — fallback suppresses propagation
------------------------------------------------------------

Failed callee
+
CALLS
+
fallback present

Expected:

no state transition from this rule.

------------------------------------------------------------
Test 6 — async call
------------------------------------------------------------

Failed callee
+
async CALLS

Expected:

no synchronous-call propagation.

------------------------------------------------------------
Test 7 — database read dependency
------------------------------------------------------------

Database node = FAILED

Reader --QUERIES_DB--> Database

Expected:

Reader = AT_RISK

------------------------------------------------------------
Test 8 — dependent write is not propagated by WRITES+failure
------------------------------------------------------------

Verify the Step 53 semantic correction remains intact.

------------------------------------------------------------
Test 9 — event consumer
------------------------------------------------------------

Event/broker node impaired

Event --CONSUMES_EVENT--> Consumer

Expected:

Consumer = AT_RISK

------------------------------------------------------------
Test 10 — producer unaffected
------------------------------------------------------------

Producer remains unchanged by consumer-side event failure semantics.

------------------------------------------------------------
Test 11 — latency scenario
------------------------------------------------------------

Target service:

latency

Expected target seed:

DEGRADED

Then verify deterministic propagation using the Step 53 qualitative latency semantics.

No numerical performance model.

------------------------------------------------------------
Test 12 — cycle
------------------------------------------------------------

A ↔ B

Seed A failed.

Expected:

engine terminates

states are stable

no duplicate infinite propagation

------------------------------------------------------------
Test 13 — fan-out
------------------------------------------------------------

One failed dependency affects several synchronous callers.

All eligible callers propagate independently.

------------------------------------------------------------
Test 14 — fan-in
------------------------------------------------------------

A node depends on multiple upstream/downstream relationships.

Verify state only becomes more severe.

------------------------------------------------------------
Test 15 — mixed rules
------------------------------------------------------------

One graph containing:

CALLS
CALLS with circuit breaker
QUERIES_DB
CONSUMES_EVENT
irrelevant IMPORTS

Verify only supported rules affect the simulation.

------------------------------------------------------------
Test 16 — monotonic state
------------------------------------------------------------

A node reaches DEGRADED.

A later rule proposes AT_RISK.

Expected:

remain DEGRADED.

------------------------------------------------------------
Test 17 — deterministic ordering
------------------------------------------------------------

Run identical input multiple times.

Expected:

- identical final states
- identical propagation paths
- identical rule IDs
- identical assumptions
- identical confidence
- identical ordering

------------------------------------------------------------
Test 18 — unknown metadata
------------------------------------------------------------

Unknown fallback/circuit-breaker metadata.

Expected:

conservative Step 53 assumptions preserved into engine output.

------------------------------------------------------------
Test 19 — cross-analysis-run rejection
------------------------------------------------------------

Graph node/edge from different analysis run.

Expected:

engine rejects rather than mixing snapshots.

------------------------------------------------------------
Test 20 — evidence completeness
------------------------------------------------------------

Every actual simulated state change has:

- simulation result
- corresponding simulation_state evidence
- matching analysis_run_id
- correct rule ID
- actual graph edge/base evidence provenance

No evidence row without a real state transition.

============================================================
28. PERSISTENCE TESTS
============================================================

Add integration coverage for:

- simulation result + evidence in same transaction
- evidence failure rolls back simulation result
- deterministic evidence IDs where applicable
- rerunning the same deterministic simulation does not create uncontrolled duplicates
- RLS isolation
- analysis-run isolation

Reuse the repository's existing DB integration patterns.

Do not weaken existing Step 48 invariants.

============================================================
29. GOLDEN FIXTURE BOUNDARY
============================================================

Do NOT implement the golden-fixture validation yet.

Step 58 owns that.

Step 54 should use:

- small synthetic graphs
- hand-built expected results

This keeps the engine independently testable.

============================================================
30. DOCUMENTATION — REQUIRED
============================================================

Preserve the same Fluxora learning pattern used in earlier steps.

Create:

learning/implementations/phase-08/step-54-simulation-engine.md

Document:

- Step 54 objective
- architecture
- engine inputs/outputs
- state initialization
- scenario seeding
- worklist propagation
- deterministic ordering
- convergence
- cycle handling
- monotonic state transitions
- propagation direction
- causal path representation
- confidence/assumption handling
- evidence generation
- transaction boundaries
- persistence boundary
- tenant/run invariants
- failure modes
- testing strategy
- limitations
- explicit non-goals
- how Step 55 will call the engine

Create:

learning/notes/step-54-simulation-engine.md

Explain in plain English:

- why a worklist is used
- why recursion alone is risky
- how convergence works
- why monotonic state transitions guarantee termination
- how cycles are handled
- why graph direction cannot be hard-coded
- how causal propagation paths are built
- why simulation output must be evidence-backed
- why deterministic ordering matters
- why latency remains qualitative
- how persistence and domain logic are separated

Create:

learning/interviews/step-54-simulation-engine.md

Include senior/staff-level questions such as:

- How would you design a deterministic failure-propagation engine?
- Why use a work queue instead of recursive DFS?
- How do you guarantee convergence in cyclic graphs?
- Why are state transitions monotonic?
- How do you avoid propagating in the wrong graph direction?
- How do rule-table decisions remain separate from traversal?
- How do you represent causal paths?
- How do you handle competing propagation causes?
- How do you prevent speculative simulation claims from becoming ungrounded?
- How does simulation evidence differ from static graph evidence?
- How would you scale the engine later?
- How would runtime telemetry eventually complement this deterministic engine?

Update:

docs/DESIGN.md

Add a clear Global Step 54 section covering:

- Simulation Engine responsibility
- domain/persistence separation
- propagation algorithm
- convergence
- causal path
- assumptions/confidence
- evidence persistence
- analysis-run boundary
- current MVP limitations
- Step 55 dependency

Do not rewrite unrelated architecture sections.

============================================================
31. DESIGN PRINCIPLE
============================================================

Fluxora's deterministic core must remain independent from AI.

The Simulation Engine must never call an LLM.

It must derive results from:

- Scenario
- Graph
- Rule Table
- deterministic state transitions

AI reasoning comes later.

============================================================
32. ACCEPTANCE CRITERIA
============================================================

Step 54 is complete only when:

1. A scenario can seed a graph target deterministically.
2. The engine propagates state through multiple hops.
3. The existing Step 53 Rule Table is the only source of propagation semantics.
4. State transitions are monotonic.
5. Cyclic graphs terminate.
6. Convergence is explicit.
7. Results are deterministic across repeated runs.
8. Propagation paths explain why every affected node changed.
9. Assumptions are preserved.
10. Confidence is preserved according to the defined deterministic semantics.
11. Every persisted simulation state conclusion has corresponding EvidenceWriter-backed evidence.
12. Evidence and simulation result persistence are atomic.
13. Analysis-run boundaries cannot be crossed.
14. Unsupported future simulation types are rejected.
15. No API/UI/future-phase functionality has been introduced.

============================================================
33. VERIFICATION
============================================================

Run focused tests first.

Then run:

1. Step 54 simulation-engine tests
2. simulation persistence/evidence integration tests
3. full @fluxora/db test suite
4. full workspace tests
5. pnpm typecheck
6. pnpm lint
7. pnpm lint:evidence
8. pnpm build
9. git diff --check

If a test requires infrastructure unavailable locally, clearly state that and distinguish local execution from CI.

Do not claim a command passed unless it actually passed.

Do not make unrelated fixes.

============================================================
34. FINAL REPORT
============================================================

At the end produce:

# Fluxora Step 54 — Simulation Engine

## Implementation
- files created/modified
- engine architecture
- propagation algorithm
- convergence strategy
- cycle handling
- causal path
- confidence/assumptions
- evidence integration
- persistence behavior

## Tests
Table:

| Check | Result |
|---|---|
| focused engine tests | |
| persistence/evidence tests | |
| @fluxora/db | |
| workspace tests | |
| typecheck | |
| lint | |
| evidence lint | |
| build | |
| diff check | |

## Scope
Explicitly confirm:

- no Step 55 APIs
- no Step 56 frontend
- no Step 58 golden-fixture validation