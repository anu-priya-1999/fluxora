# Step 30 — Bounded-Depth Recursive-CTE Graph Traversal

## Overview

Global Step 30 implements **Bounded-Depth Recursive-CTE Graph Traversal** as a reusable internal query function (`traverseGraph`) in `@fluxora/db` (`docs/architecture/05-component-responsibilities.md §5.9`, `docs/architecture/06-database-schema.md §6.1`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 4`).

`traverseGraph` provides tenant-scoped, analysis-run isolated, bounded-depth graph exploration over PostgreSQL using a recursive Common Table Expression (`WITH RECURSIVE`). It enforces cycle prevention, server-side hard depth caps, parameterized SQL safety, deterministic result ordering, and complete evidence preservation.

---

## Architectural Purpose & Scope Boundary

- **Deterministic Core Traversal**: Graph traversal is part of Fluxora's deterministic core (`docs/architecture/03-architecture-principles.md §P1`). Traversal algorithms and graph reachability calculations are purely structural and never depend on an LLM or unverified heuristics.
- **PostgreSQL Recursive CTE Strategy**: Per `docs/architecture/06-database-schema.md §6.1`, Fluxora models dependency graphs using PostgreSQL adjacency-list tables (`graph_nodes`, `graph_edges`). Traversal is performed using PostgreSQL `WITH RECURSIVE` CTEs with path array tracking (`ARRAY[n.id::text]`) to guarantee cycle safety and bounded depth.
- **Tenant & Analysis Run Isolation**: Every traversal is executed within `withTenant(pool, organizationId, ...)` to enforce Row-Level Security (RLS). Every anchor query, recursive join, and output selection explicitly filters on `analysis_run_id = $2::uuid`.
- **Reusable Internal Function**: `traverseGraph` is designed as an internal repository utility for downstream engines (Impact Analysis Engine, Simulation Engine, Architecture Explorer BFF). It is NOT an arbitrary unconstrained graph query engine.
- **Scope Boundary**: Step 30 strictly implements the `traverseGraph` query function and its tests. It deliberately does NOT implement `POST /api/v1/graph/query` (Step 31), `graph.updated` events, graph visualization, PR impact analysis, or AI reasoning.

---

## Data Flow Architecture

```
                   Graph Traversal Request
            (orgId, analysisRunId, startNodeId, maxDepth)
                               │
                               ▼
            Validation & Hard Cap Enforcement (maxDepth <= 20)
                               │
                               ▼
                   PostgreSQL withTenant Session
                     (app.current_org_id set)
                               │
                               ▼
                  PostgreSQL Recursive CTE (WITH RECURSIVE)
         ┌─────────────────────┴─────────────────────┐
         ▼                                           ▼
   Anchor Member                              Recursive Member
(startNode at depth 0)                     (joins edges & target nodes)
         │                                           │
         └─────────────────────┬─────────────────────┘
                               │
                       Cycle Check (WHERE NOT (next_node.id::text = ANY(t.path)))
                       Depth Check (WHERE t.depth < maxDepth)
                               │
                               ▼
               Shortest Path & Distinct Node Selection
            (ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY depth ASC))
                               │
                               ▼
                      Evidence Collection
          (queries evidence for traversed nodes & edges)
                               │
                               ▼
                    GraphTraversalResult
         (startNode, nodes[], edges[], maxDepthReached, evidence[])
```

---

## Technical Design & Component Layers

### 1. Traversal API & Domain Types (`packages/shared-types/src/graph.ts`)

- `DEFAULT_MAX_TRAVERSAL_DEPTH`: 5
- `HARD_MAX_TRAVERSAL_DEPTH`: 20
- `TraversalDirection`: `"outgoing"` | `"incoming"` | `"both"`
- `GraphTraversalOptions`: Arguments for traversal including `organizationId`, `analysisRunId`, `startNodeId`, `maxDepth`, optional `direction`, `edgeTypes`, `nodeTypes`, and `includeEvidence`.
- `GraphTraversalNode`: Traversed node wrapper containing `node: GraphNode`, `depth: number`, `path: readonly string[]`.
- `GraphTraversalResult`: Structural output containing `startNode`, `nodes`, `edges`, `maxDepthReached`, and optional `evidence`.

### 2. Traversal Repository Implementation (`packages/db/src/repositories/graph.ts`)

- `GraphTraversalValidationError`: Thrown when UUID parameters are invalid, `maxDepth` is non-integer, negative, or exceeds `HARD_MAX_TRAVERSAL_DEPTH` (20), or `direction` is invalid.
- **Recursive CTE Query Design**:
  - Anchor query selects starting node at `depth = 0` with initial path `ARRAY[n.id::text]`.
  - Recursive member joins `graph_edges` and `graph_nodes` matching `analysis_run_id`.
  - Supports `"outgoing"` (`e.source_node_id = t.node_id`), `"incoming"` (`e.target_node_id = t.node_id`), and `"both"` directions.
  - Cycle prevention: `WHERE NOT (next_node.id::text = ANY(t.path))` prevents visiting nodes already present in the path array.
  - Depth limit: `WHERE t.depth < maxDepth` halts recursion at `maxDepth`.
  - Shortest path selection: Uses `ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY depth ASC, path::text ASC) WHERE rn = 1` to collapse multiple paths to the same node while picking the minimum depth and deterministic path.
- **Evidence Retrieval**: Collects evidence records for all returned nodes and edges without fabricating any evidence or source locations.

---

## Primary Files Created & Modified

1. `packages/shared-types/src/graph.ts` — Added `DEFAULT_MAX_TRAVERSAL_DEPTH`, `HARD_MAX_TRAVERSAL_DEPTH`, `GraphTraversalOptions`, `GraphTraversalNode`, `GraphTraversalResult`, and `TraversalDirection`.
2. `packages/db/src/repositories/graph.ts` — Implemented `traverseGraph` and `GraphTraversalValidationError`.
3. `packages/db/src/repositories/graph-storage.test.ts` — Added 12 comprehensive unit and integration tests for `traverseGraph`.
4. `docs/DESIGN.md` — Updated with Step 30 implementation status, architectural details, and next step (Step 31).

---

## Verification & Test Strategy

All 12 focused Step 30 test scenarios pass:

1. **Linear graph chain traversal & depth limits**: Traverses `n1 -> n2 -> n3 -> n4`, asserting nodes beyond `maxDepth` are excluded and depths match.
2. **Hop boundary exclusion**: Verifies nodes at `maxDepth + 1` are not returned when `maxDepth = 2` but appear when `maxDepth = 3`.
3. **Cyclic graph traversal termination**: Traverses cyclic graph (`n5 -> n6 -> n7 -> n5`) without infinite recursion.
4. **Disconnected components**: Verifies unreachable nodes in separate components are omitted.
5. **Starting node with no outgoing relationships**: Returns start node at depth 0 with 0 edges and `maxDepthReached = 0`.
6. **Depth-zero query**: Returns only the start node at depth 0 with 0 edges when `maxDepth = 0`.
7. **Repeated paths deduplication**: Deduplicates fan-in paths (`n1 -> n2 -> n5` vs `n1 -> n2 -> n3 -> n5`) to the minimum depth (depth 2).
8. **Invalid depths and hard cap validation**: Asserts negative, non-integer, or > 20 depth inputs throw `GraphTraversalValidationError`.
9. **Missing or invalid starting node**: Returns `startNode: null` and empty results cleanly.
10. **Deterministic result ordering**: Confirms identical result ordering across repeated executions.
11. **Tenant & analysis run isolation**: Asserts Org B cannot traverse Org A's graph, and Run A2 cannot traverse Run A1's nodes.
12. **Evidence preservation**: Confirms evidence records associated with traversed nodes and edges are returned intact.

Workspace Verification:
- `pnpm lint:evidence` — PASSED
- `pnpm typecheck` — PASSED
- `pnpm lint` — PASSED
- `pnpm test` — PASSED (244 passed, 0 failed, 1 skipped)
- `pnpm build` — PASSED

