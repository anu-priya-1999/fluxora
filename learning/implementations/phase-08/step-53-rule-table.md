# Step 53 — Initial Simulation Rule Table

## Objective & Role in Roadmap

Global Step 53 implements the **Initial Simulation Rule Table** for Phase 8 per `docs/architecture/17-implementation-roadmap.md §Phase 8 Step 2`, `docs/architecture/02-product-scope.md`, `docs/architecture/04-system-architecture-diagrams.md §4.7`, `docs/architecture/05-component-responsibilities.md §5.10`, and `docs/architecture/12-testing-strategy.md §12.1`.

Its core objective is **Deterministic, Pure, Versioned Simulation Rules**:
Establish a deterministic, versioned, side-effect-free, and independently testable Rule Table abstraction with explicit assumption surfacing and confidence scoring.

### Strict Scope Boundary
Step 53 is strictly limited to the domain-level Rule Table and isolated policy tests:
- **Simulation Engine** (propagation loop, BFS/DFS traversal, convergence check) is **NOT** implemented (reserved for Step 54).
- **Simulation APIs** (`POST /scenarios/:id/run`, `GET /simulations/:id`) are **NOT** implemented (reserved for Step 55).
- **Frontend simulation mode** is **NOT** implemented (reserved for Step 56).
- **Capacity/traffic modeling**, runtime telemetry, node removal, and AI reasoning are strictly out of scope.

---

## Architectural Semantics & Corrected Boundaries

### 1. The 4 Normative Propagation Rules
Per `docs/architecture/04-system-architecture-diagrams.md §4.7`, the normative simulation rule table contains exactly four propagation rules:

1. **`calls.sync.no_fallback` (`RULE_ID_CALLS_SYNC_NO_FALLBACK = "CALLS+sync+no_fallback"`)**:
   - `CALLS + sync + no fallback` → dependent/caller `DEGRADED` (uncapped).
2. **`calls.circuit_breaker` (`RULE_ID_CALLS_CIRCUIT_BREAKER = "CALLS+circuit_breaker"`)**:
   - `CALLS + circuit breaker present` → dependent/caller `DEGRADED` (`capped: true`).
3. **`writes.failure` (`RULE_ID_WRITES_FAILURE = "WRITES+failure"`)**:
   - `WRITES + failed dependency` → dependent READERS `AT_RISK`.
4. **`emits.consumer_only` (`RULE_ID_EMITS_CONSUMER_AT_RISK = "EMITS+consumer_only"`)**:
   - `EMITS + consumer` → consumer `AT_RISK`; producer remains unaffected.

Everything else represents a non-match rather than invented propagation rules.

### 2. Semantic Boundary Clarifications
- **Fallback Handling**: Fallback is metadata that suppresses the `calls.sync.no_fallback` rule; it is **NOT** its own propagation rule (`CALLS + fallback → HEALTHY` is removed). When a fallback handler is present, the rule table returns an explicit non-match (`matched: false`), allowing the future Simulation Engine to preserve the node's current state.
- **Async CALLS Handling**: Asynchronous invocation is an explicit non-match for the synchronous CALLS rule (`CALLS + async → HEALTHY` is removed). The call does not block, no degradation propagates, and the rule table returns `matched: false`.
- **Narrowed `WRITES+failure`**: The rule strictly produces `AT_RISK` for dependent **read/query** consumers (`QUERIES_DB`). Dependent write edges (`WRITES`) return non-match (`matched: false`).
- **Explicit Unknown Metadata (`MetadataPresence = boolean | "unknown"`)**:
  - Unknown metadata is explicitly distinguishable from verified `false` (`sync`, `hasFallback`, `hasCircuitBreaker`).
  - Unknown metadata is never silently converted to `false`.
  - When metadata is `"unknown"` (or omitted), the rule table applies the conservative architectural default (behave as though protection is absent), but explicitly surfaces an assumption (e.g. `"No circuit breaker detected on call"` or `"No fallback handler detected on call"`), without claiming that the code definitively has no protection.
- **Qualitative & Deterministic Latency**:
  - `failureType: "latency"` is supported qualitatively and deterministically using explicit dependency semantics.
  - Milliseconds, p95/p99 percentiles, queueing theory, traffic multipliers, and capacity simulations are strictly excluded.

---

## Domain Contracts (`@fluxora/shared-types`)

### Key Types & Interfaces
```ts
export type MetadataPresence = boolean | "unknown";

export interface SimulationRuleInput {
  readonly edgeType: GraphEdgeType;
  readonly sourceState: SimulationResultState;
  readonly targetState: SimulationResultState;
  readonly sync?: MetadataPresence | undefined;
  readonly hasFallback?: MetadataPresence | undefined;
  readonly hasCircuitBreaker?: MetadataPresence | undefined;
  readonly failureType?: ScenarioFailureType | undefined;
  readonly isWriteFailure?: boolean | undefined;
  readonly sourceNodeName?: string | undefined;
  readonly targetNodeName?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface SimulationRuleDecision {
  readonly matched: boolean;
  readonly resultingState?: SimulationResultState | undefined;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly affectedNode?: "source" | "target" | "none" | undefined;
  readonly capped?: boolean | undefined;
  readonly assumptions: readonly string[];
  readonly confidence: number;
}
```

### Core API Functions
- `evaluateSimulationRule(input, table?)`: Deterministically evaluates rules in priority order; returns the first matching decision or `NO_MATCH`.
- `evaluateAllSimulationRules(input, table?)`: Evaluates all matching rules in a table.
- `extractSimulationEdgeMetadata(metadata)`: Normalizes edge metadata, preserving explicit `"unknown"` values.
- `createSimulationRuleInputFromEdge(edge, sourceState, targetState, options?)`: Adapter mapping `GraphEdge` and node states to `SimulationRuleInput`.
- `isStateMoreSevere(newState, currentState)`: Monotonic severity hierarchy (`failed > degraded > at_risk > healthy`).

---

## Verification Summary

- **Unit Tests**: `packages/db/src/repositories/simulation-rules.test.ts` (44 tests covering all normative rules, non-matching boundaries, explicit unknown metadata, regression test for dependent writes, and latency scenarios).
- **Static Checks**: `pnpm typecheck`, `pnpm lint`, `pnpm lint:evidence` (0 violations).
- **Workspace Build**: `pnpm build` (Next.js production build cleanly compiled in Turbopack).

