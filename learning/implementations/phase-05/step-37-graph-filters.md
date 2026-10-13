# Step 37 — Graph Filters

## Executive Summary

Fluxora Global Step 37 adds interactive graph filtering controls to the Architecture Explorer. Engineers can narrow the rendered architectural digital twin by node types, edge types, minimum confidence, and maximum traversal depth.

All filter adjustments are dispatched through the existing backend graph query contract (`POST /api/v1/graph/query` created in Step 31) without altering backend traversal truth, inventing client-side graph traversal algorithms, introducing external state libraries, or exposing database access to the frontend.

---

## Architecture & Data Flow

```
   ┌─────────────────────────────────────────────────────────────┐
   │ GraphFilters Component (Presentational UI)                 │
   │ - Node types (GraphNodeTypes buttons)                       │
   │ - Edge types (GraphEdgeTypes buttons)                       │
   │ - Min confidence (Range slider 0–100%)                      │
   │ - Max depth (Slider & input bounded to 1–20)                │
   │ - Reset Filters button                                      │
   └──────────────────────────────┬──────────────────────────────┘
                                  │ onChange(nextFilters) / onReset()
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ ArchitectureExplorerClient State                            │
   │ - filters: GraphFilterState                                 │
   │ - selectedNodeId: string | null                             │
   └──────────────────────────────┬──────────────────────────────┘
                                  │ buildGraphQueryRequest({ context, filters })
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ POST /api/v1/graph/query                                    │
   │ - node_types?: string[]                                     │
   │ - edge_types?: string[]                                     │
   │ - min_confidence?: number                                   │
   │ - max_depth?: number                                        │
   │ - organization_id NOT passed (enforced by Clerk session)    │
   └──────────────────────────────┬──────────────────────────────┘
                                  │ GraphQueryResponse
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ Selection & Inspector Reconciliation                        │
   │ - Does selectedNodeId still exist in response.nodes?        │
   │   YES ──> Keep selection & synchronized NodeInspectorPanel  │
   │   NO  ──> Safely clear selectedNodeId & empty inspector     │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ React Flow GraphCanvas                                      │
   │ Renders updated filtered nodes and edges deterministically  │
   └─────────────────────────────────────────────────────────────┘
```

---

## Core Components & Responsibilities

### 1. `GraphFilters` (`apps/web/src/components/graph/GraphFilters.tsx`)
- **Data-Driven & Purely Presentational**: Receives typed filter state via `filters: GraphFilterState` and emits changes via `onChange` and `onReset`.
- **Zero Network/Database Side Effects**: Does not execute `fetch` requests, does not import `@fluxora/db`, and does not hold global or persistent state.
- **Strict Bounding**:
  - Clamps `maxDepth` to `[1, HARD_MAX_TRAVERSAL_DEPTH]` (`20`).
  - Clamps `minConfidence` to `[0, 1]`.
- **Active State Indicator & Reset**: Visually indicates whether filters are active ("Active Filters" badge) or unconstrained ("Showing All" badge). The "Reset Filters" button restores baseline defaults in one click.

### 2. Typed Filter Model (`GraphFilterState`)
```typescript
export interface GraphFilterState {
  readonly nodeTypes: readonly GraphNodeType[];
  readonly edgeTypes: readonly GraphEdgeType[];
  readonly minConfidence: number;
  readonly maxDepth: number;
}
```
Reuses existing domain vocabularies directly from `@fluxora/shared-types`:
- `GraphNodeTypes`: `["application", "service", "package", "module", "symbol", "api", "event", "database"]`
- `GraphEdgeTypes`: `["IMPORTS", "CALLS", "EXTENDS", "EXPOSES_ROUTE", "EMITS_EVENT", "CONSUMES_EVENT", "QUERIES_DB", "WRITES", "RESOLVES_TO"]`

### 3. Explorer Integration & Request Mapping (`buildGraphQueryRequest`)
Maps local UI filter state directly into the existing `GraphQueryRequest` interface:
```typescript
export function buildGraphQueryRequest(input: {
  readonly context: ResolvedAnalysisContext;
  readonly filters?: GraphFilterState;
  readonly direction?: GraphQueryDirection;
  readonly includeEvidence?: boolean;
}): GraphQueryRequest
```
- When `nodeTypes` or `edgeTypes` are empty, they are omitted (`undefined`) so the backend traversal executes without restriction.
- When `minConfidence` is 0, it is omitted.
- `organization_id` is never attached to the request payload; tenancy is enforced through the backend session bearer token.
- `analysis_run_id` and `start_node_id` remain strictly preserved.

### 4. Selection & Inspector Synchronization
When filter changes trigger a new graph query:
- If the previously selected node is present in the new node list, `selectedNodeId` is retained, keeping the `NodeInspectorPanel` and `EvidenceTrail` synchronized with that node.
- If the node was filtered out, `selectedNodeId` is set to `null`, resetting the inspector to its empty state.
- Stale race conditions are neutralized using an effect cancellation pattern (`isCancelled`), ensuring slow older requests never overwrite newer filter query results.

---

## Security & Tenant Isolation Invariants

1. **No Backend Database Access in Frontend**: Neither `GraphFilters` nor the Explorer imports `@fluxora/db` or communicates directly with PostgreSQL.
2. **Untrusted Frontend Input Handled by Backend**: All request fields (`max_depth`, `node_types`, `edge_types`, `min_confidence`) are validated in `apps/api/src/routes/graph/query.ts` with Fastify JSON schemas. The frontend bounds `maxDepth <= 20` to prevent user frustration, but the backend remains the ultimate gatekeeper.
3. **Tenancy Preserved**: Organization identity is derived on the API server via authenticated Clerk credentials and Postgres RLS `withTenant`.

---

## Verification Results

| Check | Tool / Command | Result |
|---|---|---|
| Unit & Integration Tests | `pnpm --filter @fluxora/web test` | Passed (58 tests, 0 failures) |
| Web Typecheck | `pnpm --filter @fluxora/web typecheck` | Passed (0 errors) |
| Workspace Typecheck | `pnpm typecheck` | Passed across all 8 packages |
| Code Quality & Lint | `pnpm lint` | Passed (ESLint clean) |
| Evidence Provenance AST Lint | `pnpm lint:evidence` | Passed (All graph-writes invoke EvidenceWriter) |
| Workspace Build | `pnpm build` | Passed (Next.js 16 App Router build clean) |
| Whitespace & Git Status | `git diff --check` | Clean |

