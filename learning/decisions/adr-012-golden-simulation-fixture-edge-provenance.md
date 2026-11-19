# ADR-012: Separation of Fixture-Backed Simulation Edges from Production Graph Projections

## Status
Accepted

## Context
In Fluxora Global Step 58, the objective is to validate the Step 53 Simulation Rule Table and Step 54 Simulation Engine against Fluxora's real, immutable Taxonomy golden repository fixture (`shadcn-ui/taxonomy` pinned at commit `298a8857c7128a0d121e7f699dfd729f23b3966d`).

Fluxora's core product principle (P1) mandates a deterministic core where dependency graph construction, blast-radius traversal, and scenario simulation must never rely on probabilistic inferences or fabricate relationships.

During inspection of the real Taxonomy graph projection produced by Phase 3 extraction (`runPhase3Pipeline` and `buildGraphProjection`):
1. The projection deterministically generates 490 nodes (367 symbol, 118 module, 5 api) and 888 edges (511 `IMPORTS`, 5 `EXPOSES_ROUTE`, 372 `RESOLVES_TO`).
2. Current static extraction for the Taxonomy repository discovers module-level imports (`IMPORTS`), but does not emit first-class function invocation edges (`CALLS`).
3. The Step 53 Simulation Rule Table specifically models failure propagation semantics across functional and operational relationships: `CALLS` (with synchronous/asynchronous, fallback, and circuit-breaker conditions), `WRITES`, `QUERIES_DB`, and `CONSUMES_EVENT`. It intentionally does not treat ordinary file-level `IMPORTS` edges as function invocations, because importing a module does not imply that an unavailable exported function in that module degrades the importing module at runtime.

A critical design choice arose: how to validate the deterministic simulation engine's multi-hop causal propagation against the real golden fixture when the production graph projection currently lacks `CALLS` edges for this repository.

## Alternatives Considered

1. **Reinterpret or Relabel `IMPORTS` as `CALLS`**:
   - *Proposal*: Map `IMPORTS` edges to `CALLS` during simulation propagation or update the rule table to treat `IMPORTS` as function calls.
   - *Why rejected*: Violates the semantic boundary between module importing and function execution. In real systems, a module often imports another for type definitions, utility constants, or dormant helpers; equating imports to calls generates severe false-positive cascades across the entire graph and destroys trust in blast-radius analysis.

2. **Add Speculative `CALLS` Extraction to the Production Pipeline during Step 58**:
   - *Proposal*: Quickly patch `apps/workers/src/builder/graph-builder.ts` or Phase 3 AST parsing to emit speculative `CALLS` edges.
   - *Why rejected*: Step 58 is strictly a validation step for Phase 8, not a new extraction feature. Introducing rushed, partial call-graph extraction outside of dedicated AST milestones would destabilize the existing Step 33 golden graph contracts (490 nodes / 888 edges) and obscure genuine extractor boundaries behind ad-hoc heuristics.

3. **Validate Only Seed Failure without Downstream Propagation**:
   - *Proposal*: Seed `mod:lib/subscription.ts` as failed and assert that zero propagation occurs.
   - *Why rejected*: This only validates negative controls and the seed transition; it leaves the simulation engine's rule application, causal path tracking, assumption generation, and confidence calculations untested against real fixture entities.

4. **Fixture-Backed, Manually Verified Simulation Relationship (Chosen)**:
   - *Proposal*: Hand-verify an actual awaited call site in the pinned fixture source code (`app/api/users/stripe/route.ts` line 20 awaiting `getUserSubscriptionPlan` from `lib/subscription.ts`), record it explicitly in a dedicated `GoldenSimulationExpectationManifest` (`fixtures/golden/simulation-manifest.json`), and represent it as an explicit, test-only `SimulationEdge` injected into the in-memory `SimulationGraphSnapshot` for simulation testing without mutating or persisting it into the production graph.

## Decision
We choose Alternative 4:

1. **Strict Production Graph Immobility**: The production `GraphProjectionResult` produced by `buildGraphProjection` remains 100% untouched. It produces exactly 490 nodes, 888 edges, and zero `CALLS` edges.
2. **Explicit Semantic Distinction**: `IMPORTS` edges are verified as negative controls—asserting that running the simulation on the pure production graph results in zero caller degradation, proving that imports are never conflated with calls.
3. **Source-Verified Test Relationship**: For validation of downstream simulation semantics, the manually verified awaited invocation (`app/api/users/stripe/route.ts:20` invoking `getUserSubscriptionPlan`) is represented as an explicit `SimulationEdge` with:
   - `edgeType: "CALLS"`
   - Deterministic ID: `test-edge:mod:app/api/users/stripe/route.ts->mod:lib/subscription.ts:CALLS`
   - Explicit `isTestOnly: true` declaration and `provenance: "test-fixture-manual-verification"`
   - Conservative metadata: `{ sync: true, hasFallback: "unknown", hasCircuitBreaker: "unknown" }`
4. **Offline, In-Memory Snapshot Composition**: The test edge is combined with projected production nodes and edges strictly in memory to form the `SimulationGraphSnapshot` passed to `runSimulationEngine`. It is never written to PostgreSQL or returned from production graph queries.

## Consequences

### Positive
- **Integrity**: Preserves the sanctity of production graph extraction. No synthetic or speculative relationships are added to production artifacts.
- **Semantic Fidelity**: Proves both negative control (`IMPORTS` do not cause failure) and positive control (verified `CALLS` edge degrades caller under `CALLS+sync+no_fallback` with confidence 0.9).
- **Causal Evidence Verification**: Fully exercises multi-hop causal step creation, assumption propagation, and determinism against real repository entities.
- **Traceability**: All provenance is recorded in `fixtures/golden/simulation-manifest.json` and validated by automated integrity tests against pinned fixture code.

### Negative / Limitations
- Golden simulation propagation requires an explicit test-augmented snapshot until future Phase AST milestones introduce first-class call-graph extraction into the production pipeline.
