# 10. Frontend Architecture

## 10.1 Stack

Next.js (App Router) + React + TypeScript + Tailwind + shadcn/ui, deployed as a mix of SSR (initial page loads, SEO-irrelevant here but SSR still wins for perceived performance on data-heavy first paints) and client-rendered interactive graph views.

## 10.2 Routes

```
/                                → org dashboard: connected repos, recent activity
/repositories/connect            → GitHub OAuth connect flow
/repositories/[repoId]           → repository overview (latest analysis summary)
/repositories/[repoId]/explorer  → Architecture Explorer (graph view) — the flagship screen
/repositories/[repoId]/explorer/[nodeId]  → node inspection deep-link
/repositories/[repoId]/pull-requests/[prId]        → PR impact report
/repositories/[repoId]/pull-requests/[prId]/impact/[impactId] → impact detail, change-mode graph overlay
/repositories/[repoId]/scenarios                   → scenario library
/repositories/[repoId]/scenarios/[scenarioId]/simulations/[simId] → simulation-mode graph overlay
/repositories/[repoId]/chat                        → free-form architecture Q&A
/settings/organization            → tenant settings, GitHub app management
/settings/billing                 → (future) plan management
```

## 10.3 State management

- **Server state:** React Query (TanStack Query) for all API data — analysis runs, graph queries, impact/simulation results. This is the right default because almost everything in Fluxora *is* server state with well-defined invalidation triggers (a `graph.updated` WS event invalidates the relevant graph-query cache key).
- **Client/UI state:** local component state + a small Zustand store for cross-component UI state that genuinely needs to be shared and doesn't belong on the server (selected node, active graph filters, change-mode vs. simulation-mode toggle, graph zoom/pan position).
- **Explicit rejection of a heavier global state library (Redux):** the app's state shape doesn't need the ceremony — server state is React Query's job, UI state is small enough for Zustand, and introducing Redux here would be exactly the kind of over-engineering Principle P8 argues against.
- **Real-time:** a single WebSocket connection per session, dispatching `graph.updated`, `impact.analysis.completed`, `simulation.completed`, `ai.analysis.completed` events into React Query cache invalidation, so the UI updates live without polling.

## 10.4 Graph visualization

- **Library:** react-flow (or a comparable node-based canvas library) for the interactive Architecture Explorer — well-suited to typed nodes/edges, custom node renderers per `node_type`, and built-in pan/zoom/minimap.
- **Level of detail / clustering:** for graphs beyond a configurable node-count threshold (e.g., >300 visible nodes), the frontend requests a *pre-aggregated* view from the server (`POST /graph/query` with a `cluster_by` parameter — e.g., cluster by `Application`) rather than rendering every symbol-level node at once. Drilling into a cluster expands it client-side via a follow-up scoped query.
- **Change-mode overlay:** given an `ImpactAnalysis`, changed nodes are highlighted (distinct border/color), affected downstream nodes get a propagation-path animation (edges pulse in traversal order), and hovering a node surfaces its evidence and confidence in a side panel — all derived from the same base graph render, layered via edge/node style props rather than a separate rendering path.
- **Simulation-mode overlay:** same base graph, nodes colored by `resulting_state` (healthy/degraded/at_risk/failed), with a timeline scrubber (future enhancement) to animate propagation order.

## 10.5 Data-fetching strategy

- Initial graph load: server-rendered summary (node/edge counts, top-level Application nodes) for fast first paint, full interactive graph hydrated client-side.
- Deep graph queries (expand a node, change filters): client-side `POST /graph/query` calls via React Query, with query-key structured as `['graph', analysisRunId, queryParams]` so filter changes are independently cacheable and don't refetch the whole graph.
- Impact/simulation results: fetched once, cached indefinitely (they're immutable once `completed`), invalidated only by the corresponding WS `*.completed` event or explicit "regenerate."

## 10.6 Component boundaries

```
/components
  /graph
    GraphCanvas.tsx          — react-flow wrapper, layout logic
    NodeRenderer.tsx         — per-node-type visual components
    EdgeRenderer.tsx         — per-edge-type visual components, confidence-based styling
    NodeInspectorPanel.tsx   — side panel: evidence, dependencies, consumers, risk
    GraphFilters.tsx         — node-type/edge-type/confidence filters
  /impact
    ImpactSummaryCard.tsx
    ImpactPropagationOverlay.tsx  — composes GraphCanvas + change-mode styling
  /simulation
    ScenarioBuilder.tsx
    SimulationResultOverlay.tsx   — composes GraphCanvas + simulation-mode styling
  /ai
    AIExplanationPanel.tsx        — renders AIAnalysis, visually distinct "AI narration" styling
    ChatInterface.tsx
    EvidenceCitation.tsx          — clickable citation chip -> jumps to evidence in graph
  /shared
    ConfidenceBadge.tsx
    EvidenceTrail.tsx              — the "why do you think this" breadcrumb component
```

The `EvidenceCitation` / `EvidenceTrail` components are deliberately called out as shared, reusable primitives — evidence traceability (Principle P2) is a cross-cutting UI concern, not something bolted onto one screen.

## 10.7 Performance strategy

- **Code splitting:** graph visualization library and its dependencies are lazy-loaded only on routes that need them (`/explorer`, impact/simulation detail pages) — not shipped in the base bundle.
- **Virtualization:** node inspector lists (dependencies/consumers) virtualized for nodes with very high fan-in/fan-out.
- **Debounced/throttled graph interaction:** filter changes and pan/zoom-triggered data requests are debounced to avoid request storms during interactive exploration.
- **Optimistic UI:** actions like "run simulation" immediately show a pending state and job progress via WS, rather than waiting for the full result round-trip.
- **Web Workers (future):** client-side graph layout computation for very large clusters offloaded to a worker thread to keep the main thread responsive.
