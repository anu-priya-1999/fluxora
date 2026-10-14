# Step 38 — Graph Clustering and Level-of-Detail (LOD)

## 1. Objective

Implement deterministic client-side graph level-of-detail (LOD) and visual aggregation for Fluxora's Architecture Explorer.

As software graphs scale, rendering hundreds or thousands of fine-grained nodes (such as individual symbols or functions) simultaneously degrades browser frame rates, causes canvas clutter, and renders text illegible when zoomed out. Step 38 introduces deterministic LOD tied directly to the React Flow viewport zoom level, progressively revealing finer-grained details as the user zooms in while maintaining high-level architectural clarity when zoomed out.

---

## 2. Scope

### In Scope
- **Pure LOD Calculation Functions** (`apps/web/src/components/graph/graph-lod.ts`):
  - Viewport zoom to LOD level mapping (`getLodLevelFromZoom`).
  - Deterministic node visibility rules by node type and depth (`isNodeVisibleAtLod`).
  - Graph LOD subset calculation with dangling edge elimination (`computeLodGraph`).
- **GraphCanvas Integration** (`apps/web/src/components/graph/GraphCanvas.tsx`):
  - Viewport movement tracking via React Flow `onMoveEnd`.
  - Non-intrusive LOD indicator badge showing current tier and visible node ratio.
  - Full preservation of selected node visibility across all zoom levels.
- **Unit and Integration Test Suite** (`apps/web/src/components/graph/graph-lod.test.ts`).
- **Documentation and Learning Artifacts**.

### Out of Scope (Strict Boundaries)
- No modification of Step 30 recursive CTE traversal.
- No modification of Step 31 `POST /api/v1/graph/query` API endpoint.
- No modification of Step 32 `graph.updated` domain event bus.
- No modification of Step 33 golden fixture graph verification.
- No modification of Step 36 Node Inspector or Evidence Trail behavior.
- No modification of Step 37 Graph Filters contract or behavior.
- No implementation of Step 39 WebSocket live subscriptions.
- No implementation of Step 40 loading/empty/error UI polish.
- No database imports (`@fluxora/db`) or SQL execution in `apps/web`.

---

## 3. Architecture & Data Flow

```
                      ┌───────────────────────────────────────────────┐
                      │              POST /api/v1/graph/query         │
                      │         (Backend Authoritative Graph Truth)    │
                      └───────────────────────┬───────────────────────┘
                                              │ GraphQueryResponse
                                              ▼
                      ┌───────────────────────────────────────────────┐
                      │          ArchitectureExplorerClient           │
                      │ - filters (Step 37: types, depth, confidence)  │
                      │ - selectedNodeId (Step 36)                    │
                      └───────────────────────┬───────────────────────┘
                                              │ filtered nodes & edges
                                              ▼
                      ┌───────────────────────────────────────────────┐
                      │               GraphCanvas                     │
                      │ React Flow Viewport State: zoom               │
                      └───────┬───────────────────────────────┬───────┘
                              │                               │
        viewport onMoveEnd    ▼                               ▼ selectedNodeId
    ┌──────────────────────────────────┐        ┌───────────────────────────────┐
    │       getLodLevelFromZoom        │        │   NodeInspectorPanel          │
    │  zoom < 0.6  ──> "overview"      │        │   EvidenceTrail               │
    │  0.6 - 1.1   ──> "module"        │        │   (Always reflects real       │
    │  zoom >= 1.1 ──> "detail"        │        │    selected GraphNode, never  │
    └─────────────────┬────────────────┘        │    a synthetic cluster)       │
                      │                                 ▲
                      │ currentLod                      │
                      ▼                                 │
    ┌──────────────────────────────────┐                │
    │         computeLodGraph          │────────────────┘
    │ - Filter nodes by LOD priority   │
    │ - ALWAYS keep selectedNodeId     │
    │ - Prune dangling edges           │
    │ - Preserve exact domain IDs      │
    └─────────────────┬────────────────┘
                      │ { visibleNodes, visibleEdges }
                      ▼
    ┌──────────────────────────────────┐
    │       mapDomainGraphToFlow       │
    │  Deterministic grid positioning  │
    │  NodeRenderer component styles   │
    └──────────────────────────────────┘
```

---

## 4. Why Level-of-Detail is Needed

In architecture visualization, digital twins can have thousands of nodes spanning systems, services, packages, modules, routes, databases, and symbols.

1. **Cognitive Load & Readability**: When looking at an entire system, displaying individual method symbols makes the diagram an illegible dense "hairball". Engineers need high-level component boundaries first.
2. **DOM / SVG Performance**: Rendering thousands of interactive DOM or SVG nodes simultaneously in React Flow degrades panning and zooming frame rates (sub-30 FPS).
3. **Progressive Disclosure**: Zooming into a module naturally shifts user intent from "What does the architecture look like?" to "How does this module work internally?".

---

## 5. Viewport Zoom to LOD Rules

Zoom factors in React Flow typically range from `0.2` (max zoomed out) to `2.5` (max zoomed in):

| Tier | Zoom Threshold | Node Types Revealed | Purpose |
| :--- | :--- | :--- | :--- |
| **`overview`** | `zoom < 0.6` | `application`, `service`, `database`, `package` | System topology and coarse structural boundaries. Lowest visual density. |
| **`module`** | `0.6 <= zoom < 1.1` | Adds `module`, `api`, `event` | Module dependencies, public routes, event channels. Standard working view. |
| **`detail`** | `zoom >= 1.1` | Adds `symbol` (functions, classes, methods) | Detailed internal implementation call graphs and symbol declarations. |

---

## 6. Deterministic Invariants

1. **Backend as Sole Source of Truth**:
   The browser never runs BFS, DFS, or graph algorithms to infer connections. All nodes and edges rendered originate from the backend `GraphQueryResponse`.
2. **Selected Node Immunity**:
   If the user selects a node (via click or URL state), that node is **always** preserved in `visibleNodes` regardless of the current LOD tier. This prevents the selection from disappearing or breaking the `NodeInspectorPanel` and `EvidenceTrail`.
3. **No Dangling Edges**:
   An edge is included in `visibleEdges` if and only if **both** its source and target nodes are currently visible.
4. **Stable Domain Identities**:
   Nodes and edges retain their exact domain IDs (`id`, `canonicalId`). No random identifiers, Date stamps, or synthetic proxy nodes are introduced.
5. **Composability with Step 37 Filters**:
   LOD operates as a purely presentational projection over the already filtered graph dataset. If Step 37 filters out all modules, LOD respects that restriction without resurrecting them.

---

## 7. Performance & Interaction Considerations

- **Debounced Viewport Changes via `onMoveEnd`**: Rather than recalculating visible sets on every animation frame during a zoom gesture (`onMove`), `onMoveEnd` is utilized. This prevents layout thrashing and unnecessary React rerenders while the user is actively dragging or wheeling.
- **Pure Functions**: `computeLodGraph` and `getLodLevelFromZoom` are pure, stateless functions, allowing React's `useMemo` to skip recalculations when inputs (nodes, edges, LOD tier, selected node) remain unchanged.

---

## 8. Verification Results

- **Unit & Integration Tests**: 66 tests passing across `apps/web` (including 8 dedicated tests in `graph-lod.test.ts`).
- **Workspace Typecheck**: Passed across all packages with zero errors (`tsc --noEmit`).
- **ESLint**: Passed with zero warnings or errors (`eslint .`).
- **Evidence Lint**: Passed verifying all graph-write paths invoke `EvidenceWriter`.
- **Production Build**: Passed with Turbopack compiling `apps/web` successfully.
- **Git Diff**: Clean formatting verified via `git diff --check`.

