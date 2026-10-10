# Step 28 — Graph Builder Implementation

## Overview

Global Step 28 implements the Graph Builder component for Fluxora (`docs/architecture/05-component-responsibilities.md §5.7`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 2`).

The Graph Builder transforms the normalized, deduplicated AST code-intelligence output from Phase 3 (`RepositoryNormalizedResult`) into the relational `GraphNode`, `GraphEdge`, and `Evidence` entities established by Step 27 in PostgreSQL.

---

## Architectural Purpose & Scope Boundary

- **Separation of Concerns**: Graph Storage (Step 27) provides low-level relational tables, schema constraints, and RLS policies. Graph Builder (Step 28) projects normalized code-intelligence into structured graph models and atomically persists them.
- **Source of Truth**: The builder consumes the deterministic Phase 3 normalized result (`RepositoryNormalizedResult`). It does not run parsers or AST extractions directly.
- **Graph Construction Only**: Step 28 performs graph projection and persistence ONLY. It deliberately does NOT implement recursive CTE queries, graph diffs, `graph.updated` WebSocket events, UI visualization, or LLM reasoning.

---

## Technical Design & Component Layers

### 1. Pure Graph Projection (`buildGraphProjection`)

The mapping layer is completely decoupled from PostgreSQL:
- **Pure Function**: `buildGraphProjection(options: GraphBuilderOptions): GraphProjectionResult` takes normalized analysis results and returns projected node, edge, and evidence arrays.
- **In-Memory Testing**: Can be unit tested instantly without database dependencies or environment prerequisites.

### 2. Node & Relationship Mapping

- **Symbols (`GraphNodeType = "symbol"`)**: Normalized symbols map directly to graph nodes. `canonicalId` (e.g. `sym:src/auth.ts#function:login:100`) is preserved.
- **Modules (`GraphNodeType = "module"`)**: File paths map to module nodes with canonical ID `mod:${filePath}`.
- **API Routes (`GraphNodeType = "api"`)**: API routes map to route nodes with canonical ID `route:...`. Module-to-route edges (`EXPOSES_ROUTE`) and route-to-handler edges (`RESOLVES_TO`) are constructed.
- **Event Patterns (`GraphNodeType = "event"`)**: Pub/sub events map to event nodes. Producer module/symbols produce `EMITS_EVENT` edges; consumer module/symbols produce `CONSUMES_EVENT` edges.
- **Database References (`GraphNodeType = "database"`)**: ORM/SQL calls map to database nodes. Read operations produce `QUERIES_DB` edges; mutation operations (`create`, `update`, `delete`, `write`) produce `WRITES` edges.

### 3. Invariant Validation & Endpoint Protection

- **Endpoint Verification**: Every edge requires both source and target nodes to exist in the generated node map. If an edge references a non-existent or external target node, the edge is safely rejected and counted in `statistics.rejectedEdgesCount`.
- **Non-Fabrication**: Unresolved Phase 3 specifiers or references (`normalizedResult.unresolved`) remain unresolved. Fake nodes or dangling edges are never fabricated.

### 4. Deterministic Construction & Deterministic UUIDs

- **Deterministic UUID Generation**: Node, edge, and evidence primary keys (`id`) are deterministically derived from `(analysisRunId + canonicalId / relationshipKey)` using SHA-256 (`generateDeterministicUuid`).
- **Deterministic Ordering**: Nodes, edges, and evidence arrays are sorted lexicographically by `canonicalId` / subject keys ASC before returning or persisting.
- **Idempotency**: Executing `buildAndPersistGraph` multiple times for the same analysis run produces identical IDs and triggers `ON CONFLICT (...) DO UPDATE` in PostgreSQL, preventing duplicate records.

### 5. Atomic Transaction & Multi-Tenant Isolation

- **Atomic Transactions**: `persistGraphBuild` executes all node, edge, and evidence insertions inside a single `withTenant` PostgreSQL transaction block.
- **All-or-Nothing Rollback**: If any node, edge, or evidence insert fails validation or database constraint, `withTenant` catches the error and issues `ROLLBACK`, leaving zero partial graph data in the database.
- **RLS Policy Enforcement**: All persisted rows inherit `analysis_run_id` and are validated against PostgreSQL Row-Level Security policies (`fluxora_analysis_run_in_current_tenant`). Cross-tenant writes are blocked at the database level.

---

## Primary Files Created & Modified

1. `packages/shared-types/src/builder.ts` — Graph Builder domain interfaces, options, projection types, and summary statistics.
2. `packages/shared-types/src/index.ts` — Exported builder types.
3. `packages/db/src/repositories/graph.ts` — Added `persistGraphBuild` method for atomic transactional persistence of nodes, edges, and evidence.
4. `apps/workers/src/builder/graph-builder.ts` — Implemented `buildGraphProjection`, `generateDeterministicUuid`, and `buildAndPersistGraph`.
5. `apps/workers/src/builder/graph-builder.test.ts` — Added 16 focused test scenarios verifying pure projection, determinism, idempotency, RLS isolation, and transaction rollbacks.
6. `docs/DESIGN.md` — Updated with Section 45 architecture details and ASCII data flow diagram.

