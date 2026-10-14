# Step 40 — Architecture Explorer UI Polish

## Objective

Make the existing Architecture Explorer production-quality from a UX perspective by implementing clear loading, refresh, empty, analysis-not-ready, error, retry/recovery, and WebSocket connection status states. This is a presentation/UX step only — no backend, graph semantics, or WebSocket server changes.

## Scope

- **Modified**: `apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx` (main explorer component), `apps/web/src/app/repositories/[repoId]/explorer/explorer-data.ts` (ExplorerState type), `apps/web/src/components/graph/index.ts` (barrel exports), `apps/web/package.json` (test script)
- **Created**: `apps/web/src/components/graph/explorer-status-data.ts` (presentational status components), `apps/web/src/components/graph/ExplorerStatus.tsx` (re-export wrapper), `apps/web/src/components/graph/explorer-status.test.ts` (Step 40 tests)
- **Updated**: `docs/DESIGN.md`, learning docs
- **NOT modified**: backend APIs, graph traversal, graph builder, graph diff, graph persistence, graph storage schema, WebSocket server/auth/routing, event contracts, filter behavior, LOD rules, inspector/evidence behavior

## Architecture

### UI State Model

The explorer maintains two orthogonal state dimensions:

**Query Lifecycle State** (`ExplorerState`):
- `loading` — initial fetch, no graph data yet
- `ready` — graph successfully loaded and displayed
- `empty` — query succeeded but returned zero renderable nodes
- `not_ready` — server-side analysis has not completed
- `error` — query failed entirely

**Connection State** (`ExplorerConnectionStatus`):
- `connected` — WebSocket is active and receiving events
- `reconnecting` — WebSocket is attempting to reconnect
- `disconnected` — WebSocket is unavailable (live updates paused)

These two dimensions are independent. Valid combinations include:
- `loading` + `disconnected` (initial load before WS connects)
- `ready` + `connected` (normal operating state)
- `ready` + `reconnecting` (graph visible, WS recovering)
- `ready` + `disconnected` (graph visible, WS down — graph still fully usable)
- `error` + `disconnected` (initial load failed)
- `empty` + `connected` (query returned zero nodes)

### Background Refresh Tracking

A separate `isRefreshing` boolean flag tracks whether a background refetch is in progress when the graph is already in `ready` state. This is orthogonal to `ExplorerState` — when `isRefreshing` is true and `state.status === "ready"`, the existing graph remains fully visible and interactive.

### Refresh Error Handling

A `refreshError` string tracks non-blocking errors from background refresh failures. When set, a dismissible banner appears above the graph. The existing graph data is never destroyed by a refresh failure.

## Initial Loading

- Renders `ExplorerLoadingState` component with spinner, heading, and description
- Uses `role="status"` and `aria-live="polite"` for screen reader announcement
- Centered layout with `minHeight: 400px` to prevent layout shifts
- No unnecessary animations beyond a simple CSS spinner

## Background Refresh

Triggered by:
- `graph.updated` WebSocket event (Step 39)
- Filter changes (Step 37)
- Manual retry

Behavior:
1. If `state.status === "ready"`, set `isRefreshing = true` (keep graph visible)
2. If `state.status !== "ready"`, set `state = { status: "loading" }` (show loading)
3. Execute existing `buildGraphQueryRequest` → `fetchGraphQuery` pipeline
4. On success: update `state` to new ready state, clear `isRefreshing` and `refreshError`
5. On failure with existing graph: set `refreshError` message, keep existing graph
6. On failure without existing graph: set `state = { status: "error" }`

Visual indicator: `ExplorerUpdatingIndicator` — a thin animated progress bar at the top of the explorer, absolutely positioned so it doesn't shift layout.

## Empty State

- Renders `ExplorerEmptyState` component (distinct test ID: `explorer-empty-state`)
- Heading: "No Graph Nodes Found"
- Guidance list: adjust filters, verify analysis completion, select different context
- Clearly distinguishable from error (no warning icon) and analysis-not-ready (no hourglass)
- Uses inbox icon (📭) as visual marker

## Analysis Not Ready State

- Renders `ExplorerAnalysisNotReady` component (distinct test ID: `explorer-analysis-not-ready`)
- Heading: "Analysis Not Ready"
- Uses hourglass icon (⏳) as visual marker
- Preserves existing Step 35 deterministic behavior — only the presentation is improved
- Visually and semantically distinct from empty (different heading, icon, message)

## Query Error Handling

### Initial Error (no graph)
- Renders `ExplorerErrorState` with full-screen error display
- Warning icon (⚠️), red heading, clear message
- Retry button with `aria-label` for accessibility
- `role="alert"` and `aria-live="assertive"` for screen reader urgency

### Background Refresh Error (existing graph preserved)
- Renders `ExplorerRefreshErrorBanner` as a non-blocking banner above the graph
- Red background, error icon, message, retry button, dismiss button
- Existing graph remains fully visible and interactive below the banner

## Retry / Recovery

- Retry increments `liveUpdateTrigger` which triggers the existing `useEffect` fetch cycle
- All context is preserved: repository, analysis run, start node, direction, filters, LOD
- On success: error state is cleared, fresh graph is displayed
- Selection is preserved if the selected node still exists; cleared if it doesn't
- No new data-fetch path is created — retry uses the exact same `fetchGraphQuery` pipeline

## WebSocket Connection Status

- `ExplorerConnectionBadge` renders in the explorer header
- Three states: "Live" (green), "Reconnecting" (amber), "Offline" (gray)
- Maps from WebSocket client's `ExplorerWsStatus` via `mapWsStatusToConnectionStatus()`
- `connected` → "Live", `connecting` → "Reconnecting", `idle`/`disconnected`/`closed` → "Offline"
- Status change tracked via existing `onStatusChange` callback in WebSocket client
- A disconnected WebSocket NEVER makes the graph unusable

## Graph Preservation

- An already-loaded graph is NEVER blanked during background refresh
- A refresh failure NEVER destroys existing valid graph data
- A WebSocket outage NEVER removes or disables the graph
- Only a successful new response or an empty result can change the displayed graph

## Interaction with Steps 36–39

- **Step 36 (Inspector/Evidence)**: Selection preserved when node survives refresh; cleared when node disappears. EvidenceTrail continues using real GraphNode data.
- **Step 37 (Filters)**: Filter state persists across all state transitions. Filters are always included in retry/refresh requests.
- **Step 38 (LOD)**: LOD continues to be calculated by existing `computeLodGraph`. Zoom is not reset by refresh.
- **Step 39 (WebSocket)**: Event remains invalidation signal. `POST /api/v1/graph/query` remains authoritative. No polling added.

## Accessibility

- Loading: `role="status"`, `aria-live="polite"`
- Empty/Not-Ready: `role="status"`, `aria-live="polite"`
- Error: `role="alert"`, `aria-live="assertive"`
- Retry buttons: `aria-label` descriptors
- Connection badge: `role="status"`, `aria-label` with descriptive text
- Updating indicator: `role="status"`, `aria-label="Updating graph"`
- All controls remain keyboard accessible
- Status not conveyed by color alone (text labels accompany colored dots)

## Responsive Behavior

- Loading/empty/error states use centered flex layout with max-width constraints
- No layout shifts — loading state has `minHeight: 400px`
- Updating indicator is absolutely positioned at top, no layout displacement
- Refresh error banner is a flex row within normal flow
- Inspector and filters remain usable in all states
- Desktop layout preserved

## Performance Considerations

- No new network requests or endpoints
- No polling
- CSS animations use GPU-friendly transforms
- Status badge and indicator are lightweight DOM elements
- `isRefreshing` and `refreshError` are simple primitive state values

## Security / Invariants

- No raw stack traces or database internals in error messages
- No secret information exposed in error states
- Tenant isolation (RLS) unmodified
- WebSocket authentication unchanged
- No customer code execution

## Limitations

- No skeleton loader for graph canvas (would require React Flow canvas mocking)
- No automatic retry with exponential backoff for query errors (WebSocket has its own backoff; HTTP query errors are user-triggered)
- Retry is manual (button click) for initial and refresh errors
- Uses inline banner rather than toast notifications

## Verification

- 20 focused tests covering all specified scenarios
- All existing Step 34–39 tests pass without modification (105 total passing tests in `@fluxora/web`)
- TypeScript compilation clean
- ESLint clean
- No evidence lint violations
- Build succeeds

## Final Phase 5 Completion Summary

With Step 40 complete, Phase 5 (Architecture Explorer UI) is fully complete. The explorer now provides:

1. **Step 34**: GraphCanvas with React Flow, deterministic mapping, per-type node rendering
2. **Step 35**: Server-side analysis context resolution with routing
3. **Step 36**: NodeInspectorPanel with EvidenceTrail for selected node details
4. **Step 37**: GraphFilters with node type, edge type, confidence, and depth filtering
5. **Step 38**: Level-of-Detail (LOD) with zoom-driven tiered visibility
6. **Step 39**: WebSocket live updates with invalidation-driven refetch
7. **Step 40**: Production-quality loading, empty, error, retry, and connection status UX

The Architecture Explorer is a fully interactive, deterministic, live-updating graph visualization tool backed by the Fluxora API's recursive CTE traversal engine.

