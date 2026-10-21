You are implementing **Fluxora Step 53 — Initial Simulation Rule Table**.

Read the existing repository implementation and architecture docs before changing anything.

## 1. Source of truth

Use these Fluxora architecture documents as the authoritative specification:

- `docs/architecture/17-implementation-roadmap.md`
  - Phase 8 — Simulation
  - Step 2: design and implement the initial rule table
- `docs/architecture/02-product-scope.md`
  - MVP simulation scope is limited to:
    - infrastructure unavailable
    - latency degradation
  - large-scale capacity/traffic simulation is out of scope
- `docs/architecture/04-system-architecture-diagrams.md`
  - §4.7 Simulation architecture
- `docs/architecture/05-component-responsibilities.md`
  - §5.10 Simulation Engine
- `docs/architecture/12-testing-strategy.md`
  - §12.1 Policy/rules testing

Relevant architecture requirements:

### Simulation architecture

The simulation flow is:

Scenario
→ initialize all nodes HEALTHY
→ propagation engine
→ Rule Table
→ state changes
→ convergence
→ SimulationResult
→ evidence

The rule table currently specifies these propagation relationships:

1. `CALLS + sync + no fallback`
   → downstream becomes `DEGRADED`

2. `CALLS + circuit breaker present`
   → downstream becomes `DEGRADED`, capped

3. `WRITES + failure`
   → dependent reads become `AT_RISK`

4. `EMITS + consumer only`
   → consumer becomes `AT_RISK`
   → producer remains unaffected

The architecture also explicitly says that if metadata required by a rule is unknown, the simulation must use a conservative default and surface the assumption instead of guessing optimistically.

### Simulation Engine responsibility

The Rule Table is a dependency of the future Simulation Engine.

The engine will eventually consume:

- scenario definition
- graph snapshot
- edge metadata
  - sync/async
  - has-fallback
  - has-circuit-breaker where knowable

The engine will eventually produce:

- per-node state
- propagation path
- assumptions
- confidence

Do NOT implement the engine yet.

---

# 2. Step 53 boundary

This step is ONLY:

> Implement a deterministic, versioned, testable simulation Rule Table and its isolated unit tests.

Do NOT implement:

- Simulation Engine
- propagation loop
- BFS/DFS traversal
- convergence logic
- scenario execution
- simulation worker
- API endpoints
- frontend simulation mode
- database changes
- SimulationResult persistence
- evidence writing for simulation execution
- AI reasoning
- latency telemetry
- runtime telemetry
- capacity/traffic simulation
- node removal simulation
- distributed simulation
- queues/jobs for simulation
- changes to Step 52 persistence unless absolutely required for type compatibility

Step 52 already established:

- `Scenario`
- `Simulation`
- `SimulationResult`
- simulation persistence
- shared simulation types

Reuse those concepts rather than creating duplicate versions.

---

# 3. First inspect the current implementation

Before editing:

1. Inspect the latest git history.
2. Inspect existing Phase 8 / Step 52 files.
3. Inspect the current shared graph types and graph edge types.
4. Inspect existing conventions for:
   - pure domain logic
   - discriminated unions
   - constants
   - error handling
   - test organization
   - package boundaries
   - naming
5. Find where the graph already represents edge metadata such as:
   - edge type
   - sync/async
   - fallback
   - circuit breaker
6. Determine whether any existing simulation-related type should be reused.

Do not invent a parallel graph-edge metadata model when an existing one already exists.

Keep the implementation consistent with the current monorepo architecture.

---

# 4. Rule Table design

Create the smallest clean abstraction that can later be consumed by Step 54.

The Rule Table must be:

- deterministic
- pure
- side-effect free
- versioned
- independently testable
- explicit about assumptions
- explicit about confidence
- easy to extend later
- independent of PostgreSQL
- independent of HTTP/API
- independent of React
- independent of workers/queues

Prefer a domain-level function/model rather than embedding rules inside future propagation code.

A good conceptual shape is:

```ts
type SimulationRuleInput = {
  edgeType: ...
  sourceState: ...
  targetState: ...
  sync: ...
  hasFallback: ...
  hasCircuitBreaker: ...
  failureType: ...
  ...
};

type SimulationRuleDecision = {
  matched: boolean;
  resultingState?: ...;
  ruleId: string;
  ruleVersion: string;
  assumptions: string[];
  confidence: number;
};