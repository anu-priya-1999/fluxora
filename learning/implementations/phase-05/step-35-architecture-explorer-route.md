# Step 35 — Architecture Explorer Route & Graph API Fetching

## Executive Summary

Fluxora Global Step 35 implements the Architecture Explorer route (`/repositories/[repoId]/explorer`) and wires authenticated graph fetching directly into the Step 34 `GraphCanvas`. 

This step establishes the connection between user navigation in the Next.js frontend and the deterministic backend graph query contract (`POST /api/v1/graph/query` established in Step 31).

Per Phase 5 architectural boundaries:
- `apps/web` remains strictly a consumer of backend graph truth.
- `apps/web` **never** imports `@fluxora/db` or communicates directly with PostgreSQL.
- Deterministic graph traversal, bounds, and provenance remain strictly in the backend engine.
- Step 36 features (`NodeInspectorPanel`, `EvidenceTrail`, `GraphFilters`, clustering, live WebSocket cache invalidation, impact/simulation modes) are strictly excluded.

---

## Architecture & Boundary Separation

```
  ┌─────────────────────────────────────────────────────────────┐
  │ Browser / Next.js Server Page                               │
  │ /repositories/[repoId]/explorer?analysis_run_id=...&start_node_id=...│
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Server Component (page.tsx)                                 │
  │ - Enforces Clerk auth() session                             │
  │ - Validates repository & analysis context                   │
  │ - Renders empty/not-ready state if analysis context missing │
  │ - Passes context & apiUrl to Client Boundary                │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Client Component (ArchitectureExplorerClient)               │
  │ - Fetches JWT token from Clerk useAuth()                    │
  │ - Calls POST /api/v1/graph/query (Never sends org_id)       │
  │ - Handles loading, empty, and error states                  │
  │ - Transforms GraphQueryResponse via mapDomainGraphToFlow()   │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Presentational Canvas (Step 34 GraphCanvas)                 │
  │ - Zero network logic                                        │
  │ - Renders React Flow nodes & edges deterministically        │
  └─────────────────────────────────────────────────────────────┘
```

---

## Key Invariants Preserved

1. **Frontend Does Not Own the DB Boundary**:
   The frontend application (`apps/web`) communicates with the backend exclusively via HTTP API contracts. `apps/web` does not import `@fluxora/db`, nor does it execute SQL or manage database connection pools.

2. **Backend Derives Tenancy**:
   `POST /api/v1/graph/query` receives a Bearer JWT token from Clerk. The client never supplies `organization_id` or `organizationId` in request bodies or query parameters. The API server derives tenant isolation deterministically from verified authentication tokens.

3. **Deterministic Graph Truth**:
   The frontend performs zero graph traversal, cycle detection, or relationship derivation. All nodes, edges, types, confidence values, and depth measurements are returned by the backend's bounded recursive CTE traversal (Step 30/31).

4. **Robust State Handling**:
   - **Loading**: Clear loading indicator while the graph query is executing.
   - **Not Ready / Empty**: Clean, accessible message when no completed analysis run or start node is specified.
   - **Error**: Safe error feedback without leaking authentication secrets, tokens, or raw database errors.

---

## Verification

Step 35 is verified through:
- `pnpm --filter @fluxora/web test`: 27 passing unit tests verifying context resolution, POST `/api/v1/graph/query` payload and headers, 401/404 handling, and flow mapping.
- `pnpm --filter @fluxora/web typecheck`: Clean TypeScript compilation.
- `pnpm typecheck`: Clean workspace-wide TypeScript compilation across all 7 projects.
- `pnpm lint`: Clean ESLint across workspace.
- `pnpm lint:evidence`: CI Evidence AST verification ensuring all graph-write paths invoke EvidenceWriter.
- `pnpm build`: Successful Next.js 16 (Turbopack) production build including `/repositories/[repoId]/explorer`.

