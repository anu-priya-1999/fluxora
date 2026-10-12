# Step 34 — React Flow Graph Canvas & Node Renderers

## Executive Summary

Fluxora Global Step 34 establishes the visual rendering foundation for the Architecture Explorer. Building on the deterministic graph persistence, recursive CTE traversal, and golden fixture verification established across Steps 27–33, Step 34 integrates React Flow (`@xyflow/react`) inside `apps/web` and delivers:
1. `GraphCanvas`: A client-side wrapper that accepts typed domain/API graph records and renders an interactive diagram.
2. `NodeRenderer`: A presentational component mapping the 8 domain node categories (`application`, `service`, `package`, `module`, `symbol`, `api`, `event`, `database`) to distinct visual representations with deterministic handles, confidence indicators, and selected state.
3. `mapDomainGraphToFlow`: A pure, deterministic domain-to-canvas mapping utility that preserves canonical IDs without UUID generation or client-side mutation.

Per the Phase 5 roadmap boundary, Step 34 strictly excludes API fetching, Explorer routes, WebSocket cache invalidation, NodeInspectorPanel, EvidenceTrail, GraphFilters, clustering, and simulation/impact overlays.

---

## Architecture & Data Flow

```
   ┌──────────────────────────────────────────────────────────────┐
   │ Fluxora Backend (Steps 27–33)                                │
   │ Deterministic Graph State (PostgreSQL + RLS + EvidenceWriter)│
   └──────────────────────────────┬───────────────────────────────┘
                                  │ POST /api/v1/graph/query (Step 31)
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ Graph Query Response / Domain Graph                          │
   │ { nodes: GraphQueryResponseNode[], edges: ... }              │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
               mapDomainGraphToFlow(inputNodes, inputEdges)
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ React Flow Model                                             │
   │ - nodes: Node<FluxoraNodeData>[] (deterministic layout)      │
   │ - edges: Edge[] (stroke, labels, animation)                  │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ GraphCanvas Component ("use client")                        │
   │ ┌──────────────────────────────────────────────────────────┐ │
   │ │ ReactFlow Viewport (Pan, Zoom, FitView)                  │ │
   │ │  ├─ NodeRenderer (per-node-type styling & handles)       │ │
   │ │  ├─ Background (Dots pattern)                            │ │
   │ │  └─ Controls (Zoom in / out / reset)                     │ │
   │ └──────────────────────────────────────────────────────────┘ │
   └──────────────────────────────────────────────────────────────┘
```

---

## Key Design Principles & Invariants Preserved

1. **Deterministic Core vs. Presentational UI**:
   The frontend canvas never invents graph edges, infers dependencies, or modifies domain identities. The frontend is strictly a deterministic visual projection of server-verified graph data.
2. **Stable Node & Edge Identity**:
   Domain IDs (`canonical_id` / `canonicalId`, node `id`, edge `id`) are preserved 1:1. Render keys and React Flow identifiers are never generated via `Date.now()`, `Math.random()`, or random UUIDs.
3. **Strict Separation of Concerns**:
   `GraphCanvas` and `NodeRenderer` contain zero `fetch` or React Query calls. Data fetching is isolated to page/container components in Step 35.
4. **Client-Component Isolation**:
   Because `@xyflow/react` uses browser DOM measurements, mouse event handlers, and Canvas/SVG rendering, `GraphCanvas` is designated as `"use client"`.

---

## File Deliverables

- `apps/web/src/components/graph/node-styles.ts`: Color tokens, category badges, and label mappings for all 8 domain node types.
- `apps/web/src/components/graph/graph-mapping.ts`: Pure mapping function `mapDomainGraphToFlow` supporting both `GraphNode` and `GraphQueryResponseNode` contracts with deterministic grid layout.
- `apps/web/src/components/graph/NodeRenderer.tsx`: Custom React Flow node component supporting target/source connection handles, type badges, depth indicator, canonical path, confidence score, and selected state.
- `apps/web/src/components/graph/GraphCanvas.tsx`: Main React Flow canvas wrapper component with configurable controls, background, and node click callbacks.
- `apps/web/src/components/graph/index.ts`: Barrel export file.
- `apps/web/src/components/graph/graph-canvas.test.ts`: Test suite verifying node styling, ID preservation, empty graph resilience, multi-node type support, dangling edge filtering, deterministic coordinates, and network call prohibition.

---

## Verification & Status

All project verification gates pass:
- `pnpm --filter @fluxora/web typecheck`: 0 errors
- `pnpm --filter @fluxora/web test`: 18 tests passing (including 8 new Step 34 unit tests)
- `pnpm typecheck`: Workspace typecheck passing across all 7 packages
- `pnpm lint`: ESLint passing across entire monorepo
- `pnpm lint:evidence`: AST evidence static analysis passing
- `pnpm build`: Next.js Turbopack build passing
- `git diff --check`: 0 whitespace issues

