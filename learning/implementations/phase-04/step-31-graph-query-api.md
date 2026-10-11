# Step 31 — Graph Query API (POST /api/v1/graph/query)

## Overview

Global Step 31 implements the public HTTP boundary for graph queries: `POST /api/v1/graph/query` (`docs/architecture/07-api-architecture.md §7.2`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 5`).

This endpoint exposes the deterministic, bounded-depth recursive-CTE graph traversal functionality implemented in Step 30 (`traverseGraph`) to authenticated API clients. It performs strict request validation, securely derives tenant organization identity from the authenticated session, maps public API concepts (e.g., `downstream`, `upstream`) to internal traversal semantics, enforces depth caps and confidence filtering, and returns an API-safe JSON representation of the graph without leaking database internals.

---

## Architectural Purpose & Scope Boundary

- **HTTP Boundary vs. Internal Primitive**: Step 30 implemented the internal graph traversal query primitive (`traverseGraph`) directly against PostgreSQL. Step 31 wraps this primitive in an HTTP interface, handling authentication, content negotiation, request validation, error formatting, and response shaping.
- **No CTE Duplication**: The HTTP handler does not implement or duplicate recursive CTE logic. It delegates traversal entirely to Step 30's `traverseGraph` repository method.
- **Deterministic Core Protection**: The endpoint is strictly read-only. It performs zero mutations against `graph_nodes`, `graph_edges`, or `evidence`. No AI or LLM components are involved.
- **Multi-Tenant Security**: Tenant identity is strictly derived from the authenticated Bearer token and Clerk GitHub identity. Clients cannot specify or override `organization_id` in the request body.
- **Scope Boundary**: Step 31 implements ONLY `POST /api/v1/graph/query`. It deliberately does NOT implement:
  - `graph.updated` events (Step 32)
  - Graph diff computation across runs (Step 32)
  - WebSocket push of graph updates (Step 32)
  - PR impact analysis (Phase 6)
  - Graph visualization / React Flow UI (Phase 5)
  - AI analysis or explanations (Phase 9)

---

## Request & Response Flow

```
                      Client HTTP Request
                POST /api/v1/graph/query
                           │
                           ▼
                 Content-Type Validation
                (must be application/json)
                           │
                           ▼
                 Bearer JWT Authentication
                (Clerk verifyToken + Identity)
                           │
                           ▼
                  Tenant Derivation
             (organizationId from auth session)
                           │
                           ▼
                 Request Body Validation
          (analysisRunId, startNodeId, direction,
           maxDepth, edgeTypes, nodeTypes, minConfidence)
                           │
                           ▼
                 Direction Mapping
         (downstream -> outgoing, upstream -> incoming)
                           │
                           ▼
               Repository Traversal (Step 30)
                 traverseGraph(pool, options)
                           │
                           ▼
                 Response Formatting
        (Deterministic confidence filtering,
         internal-to-public mapping, evidence linking)
                           │
                           ▼
                    JSON Response (200)
         { nodes: [...], edges: [...], truncated: false }
```

---

## API Contract

### Request

```http
POST /api/v1/graph/query HTTP/1.1
Host: api.fluxora.io
Authorization: Bearer <session-token>
Content-Type: application/json

{
  "analysis_run_id": "run_7c3e41...",
  "start_node_id": "node_9f2a...",
  "direction": "downstream",
  "max_depth": 3,
  "edge_types": ["CALLS", "EMITS_EVENT"],
  "min_confidence": 0.6,
  "include_evidence": true
}
```

#### Field Specifications:
- `analysis_run_id` (string, required): Valid UUID of the analysis run.
- `start_node_id` (string, required): Valid UUID of the starting node within the analysis run.
- `direction` (string, optional): `"downstream"` (default, outgoing edges), `"upstream"` (incoming edges), or `"both"`.
- `max_depth` (number, optional): Integer between `0` and `20` (`HARD_MAX_TRAVERSAL_DEPTH`). Defaults to `5`.
- `edge_types` (string[], optional): Array of valid `GraphEdgeType` values (e.g., `"CALLS"`, `"IMPORTS"`, `"EMITS_EVENT"`).
- `node_types` (string[], optional): Array of valid `GraphNodeType` values (e.g., `"module"`, `"symbol"`, `"service"`).
- `min_confidence` (number, optional): Float between `0.0` and `1.0`.
- `include_evidence` (boolean, optional): Whether to return linked evidence records. Defaults to `true`.

### Response

```json
{
  "nodes": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "type": "module",
      "name": "src/app.ts",
      "canonical_id": "mod:src/app.ts",
      "depth": 0,
      "confidence": 1.0,
      "path": "src/app.ts",
      "metadata": { "lines": 100 }
    },
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "type": "service",
      "name": "src/service.ts",
      "canonical_id": "mod:src/service.ts",
      "depth": 1,
      "confidence": 0.9,
      "path": "src/service.ts"
    }
  ],
  "edges": [
    {
      "id": "eeeeeeee-1111-4111-8111-111111111111",
      "source": "22222222-2222-4222-8222-222222222222",
      "target": "33333333-3333-4333-8333-333333333333",
      "type": "CALLS",
      "confidence": 0.95,
      "provenance": "static-analysis",
      "evidence_id": "ffffffff-1111-4111-8111-111111111111"
    }
  ],
  "max_depth_reached": 1,
  "truncated": false,
  "evidence": [
    {
      "id": "ffffffff-1111-4111-8111-111111111111",
      "subject_type": "graph_edge",
      "subject_id": "eeeeeeee-1111-4111-8111-111111111111",
      "file_path": "src/app.ts",
      "line_start": 10,
      "line_end": 12,
      "column_start": 1,
      "column_end": 20,
      "relationship_description": "app calls service",
      "confidence": 0.95
    }
  ]
}
```

---

## Core Invariants & Engineering Decisions

### 1. Authenticated Tenant Derivation
In accordance with `docs/architecture/07-api-architecture.md §7.3`, `organization_id` is derived strictly from the authenticated identity and user record. If a client attempts to pass `organization_id` or `organizationId` in the request body, the endpoint rejects the request with HTTP `400` (`invalid_request`).

### 2. Direction Mapping
The public API uses intuitive relationship directions:
- `"downstream"` → mapped internally to `"outgoing"` (dependencies/consumers called by the node)
- `"upstream"` → mapped internally to `"incoming"` (callers/parents that depend on the node)
- `"both"` → mapped internally to `"both"` (bidirectional exploration)

### 3. Server-Side Hard Depth Cap
To protect the database against resource exhaustion, the endpoint strictly enforces `0 <= max_depth <= 20` (`HARD_MAX_TRAVERSAL_DEPTH`). Values exceeding `20` or non-integers are rejected with HTTP `400` (`invalid_traversal_options`).

### 4. Deterministic Confidence Filtering
When `min_confidence` is provided:
- Nodes with `confidence < min_confidence` are pruned.
- Edges with `confidence < min_confidence` OR edges referencing pruned nodes are pruned.
- Evidence records for pruned nodes or edges are pruned.
Filtering is applied deterministically to preserve graph consistency.

### 5. Evidence Preservation & Non-Fabrication
Evidence records returned by the traversal primitive are mapped to public API objects without altering source provenance. `evidence_id` is linked directly on edges and corresponding evidence records are exposed in the `evidence` array.

### 6. Read-Only Guarantee
Graph querying is completely side-effect free. It executes within read transactions and issues zero `INSERT`, `UPDATE`, or `DELETE` statements.

### 7. Consistent Error Contract
Errors strictly follow Fluxora's API standard:
```json
{
  "error": {
    "code": "invalid_request",
    "message": "start_node_id must be a valid UUID string."
  }
}
```
- `400`: Validation error / malformed request / invalid traversal options
- `401`: Missing or invalid Bearer authentication token
- `403`: Missing connected GitHub account or tenant access rejected
- `404`: Start node not found in the tenant's analysis run
- `415`: Unsupported Media Type (Content-Type not application/json)
- `500`: Internal error with sensitive details redacted

---

## Verification & Definition of Done

The implementation has been verified through automated test suites:
- `pnpm --filter @fluxora/api test`: 65 passing tests including 16 dedicated Step 31 API tests.
- `pnpm --filter @fluxora/db test`: Step 30 traversal tests passing.
- `pnpm lint:evidence`: Static AST lint verifying no unwrapped graph writes.
- `pnpm typecheck`: Full workspace TypeScript verification passed.
- `pnpm lint`: ESLint passed across all workspaces.
- `pnpm build`: Next.js web application and monorepo packages compiled successfully.

