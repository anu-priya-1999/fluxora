Implement ONLY Global Step 40 of Fluxora.

This is the final step of Phase 5: Architecture Explorer UI.

Before editing anything, inspect the existing Step 34–39 implementation and preserve its architecture, terminology, and behavior.

Relevant areas:

- apps/web/src/app/repositories/[repoId]/explorer/
- apps/web/src/components/graph/
- apps/web/src/events/
- packages/shared-types/src/graph.ts
- packages/shared-types/src/events.ts
- docs/DESIGN.md
- learning/implementations/phase-05/
- learning/notes/
- learning/interviews/

==================================================
GLOBAL STEP 40 — FINAL ARCHITECTURE EXPLORER UI POLISH
==================================================

## Goal

Make the existing Architecture Explorer production-quality from a UX perspective by implementing clear:

- initial loading state
- background refresh/updating state
- empty state
- analysis-not-ready state
- query error state
- retry/recovery behavior
- WebSocket connection status
- lightweight accessibility and responsive polish

This is a PRESENTATION / UX step only.

The existing backend, graph semantics, query API, filters, LOD, inspector, evidence, and WebSocket architecture remain authoritative and unchanged.

==================================================
STRICT SCOPE
==================================================

DO NOT implement anything beyond Global Step 40.

DO NOT modify:

- graph traversal / recursive CTE
- graph builder
- graph diff logic
- graph persistence
- graph storage schema
- graph query semantics
- GraphQueryRequest / GraphQueryResponse semantics
- graph evidence semantics
- WebSocket server
- WebSocket authentication
- WebSocket tenant routing
- graph.updated event contract
- Step 37 filter behavior
- Step 38 LOD rules
- Step 36 inspector/evidence behavior

DO NOT add:

- new backend endpoints
- database migrations
- polling
- client-side BFS/DFS
- synthetic graph clustering
- new graph algorithms
- unrelated refactors
- new UI frameworks
- unnecessary dependencies
- Phase 6+ functionality

Do NOT redesign the entire dashboard/application.

Do NOT alter the existing visual identity unnecessarily.

==================================================
EXISTING ARCHITECTURE TO PRESERVE
==================================================

The current flow is:

Explorer context
    ↓
existing GraphQueryRequest
    ↓
POST /api/v1/graph/query
    ↓
GraphQueryResponse
    ↓
Step 37 filters
    ↓
Step 38 LOD
    ↓
GraphCanvas
    ↓
Step 36 NodeInspectorPanel / EvidenceTrail

And for live updates:

graph.updated
    ↓
existing WebSocket client
    ↓
invalidate/refetch
    ↓
existing graph-query flow
    ↓
fresh GraphQueryResponse

Do not duplicate any of these responsibilities.

==================================================
STATE MODEL
==================================================

Keep the state model simple and explicit.

Use a query lifecycle concept equivalent to:

- loading
- ready
- empty
- error

and a separate live-connection state equivalent to:

- connected
- reconnecting
- disconnected

Do not create an unnecessarily complex state machine.

Valid examples:

- loading + connected
- ready + connected
- ready + reconnecting
- ready + disconnected
- ready + refreshing
- error + disconnected
- empty + connected

Do not force WebSocket state into graph-query state.

==================================================
1. INITIAL LOADING
==================================================

When the explorer has not yet received its first successful graph query:

- do not render a blank unexplained area;
- show a lightweight loading state;
- communicate that the architecture graph is loading;
- avoid unnecessary layout shifts;
- keep the UI visually consistent with the existing explorer.

Use lightweight UI.

Do not build elaborate animations.

==================================================
2. BACKGROUND REFRESH / UPDATING
==================================================

When a graph refetch occurs because of:

- graph.updated;
- filter changes;
- any existing explorer query refresh;

and an existing graph is already displayed:

DO NOT remove the current graph.

Keep the existing graph visible while the new query is running.

Show a small non-blocking indication such as:

"Updating graph…"

or another equivalent existing-style status indicator.

The desired flow is:

existing graph
    ↓
background refetch
    ↓
keep existing graph visible
    ↓
success → replace graph
failure → keep previous graph + show recoverable error

Do not blank the graph during background refresh.

==================================================
3. EMPTY GRAPH
==================================================

When the graph query succeeds but returns zero renderable nodes:

render a clear empty state.

Clearly distinguish:

- empty result
from
- query failure
from
- analysis not ready

Do not fabricate nodes or edges.

Provide useful guidance where appropriate, for example:

- adjust filters;
- select another analysis context;
- wait for indexing/analysis completion.

Do not change the backend definition of what constitutes an empty result.

==================================================
4. ANALYSIS NOT READY
==================================================

Preserve the existing Step 35 deterministic "analysis not ready" behavior.

Improve only its presentation.

It must remain visually and semantically distinct from:

- empty graph;
- query error;
- WebSocket reconnecting/disconnected.

Do not change how analysis readiness is determined.

==================================================
5. QUERY ERROR
==================================================

For a failed graph query:

show a human-readable error state.

Requirements:

- no raw stack traces;
- no database internals;
- no secret information;
- clear retry action;
- keyboard accessible retry;
- appropriate error/status semantics.

IMPORTANT:

When the error happens during an initial load:

    no graph + error → full error state

When the error happens during a background refresh:

    existing graph + refresh failure
        → keep existing graph
        → show recoverable error indicator

Do NOT destroy already valid graph data merely because a later request failed.

Retry must use the EXISTING graph-query flow.

Do not create a new endpoint.

==================================================
6. RETRY / RECOVERY
==================================================

Retry behavior must be simple and deterministic.

On retry:

- call the existing graph-query mechanism;
- preserve current repository context;
- preserve current analysis run;
- preserve current start node;
- preserve current direction;
- preserve current Step 37 filters;
- preserve current Step 38 LOD behavior.

On success:

- clear the appropriate error state;
- display the fresh authoritative graph;
- preserve selection where the node still exists;
- preserve current viewport/zoom where existing implementation permits it.

Do not introduce a second data-fetch path.

==================================================
7. WEBSOCKET STATUS
==================================================

Reuse the existing Step 39 WebSocket client state.

Expose subtle status feedback for:

- connected
- reconnecting
- disconnected / live updates unavailable

The status should be informative but visually secondary.

IMPORTANT:

A WebSocket outage MUST NOT make an already-loaded graph unusable.

Example:

graph loaded
+
WebSocket disconnected
=
graph remains fully visible and interactive

Do NOT add polling as a fallback.

Do NOT change the WebSocket server.

Do NOT change WebSocket authentication.

Do NOT change tenant isolation.

==================================================
8. STEP 36 COMPATIBILITY
==================================================

Preserve all NodeInspectorPanel and EvidenceTrail behavior.

After refresh/retry:

- preserve selectedNodeId when that real node still exists;
- clear it when the selected node no longer exists;
- never replace a real node with a fabricated representation;
- EvidenceTrail must continue using the real GraphNode.

Do not modify the evidence-association model.

==================================================
9. STEP 37 COMPATIBILITY
==================================================

Preserve existing GraphFilters behavior.

Filter state must remain the same across:

- loading;
- background refresh;
- retry;
- WebSocket-triggered refetch;
- success;
- error.

Do not duplicate filter logic.

Do not change GraphQueryRequest semantics.

==================================================
10. STEP 38 COMPATIBILITY
==================================================

Preserve existing Level-of-Detail behavior.

After graph updates:

- LOD continues to be calculated by the existing Step 38 implementation;
- do not reset zoom unnecessarily;
- do not change zoom thresholds;
- do not invent clustering;
- do not alter deterministic node/edge visibility rules.

==================================================
11. STEP 39 COMPATIBILITY
==================================================

Preserve existing WebSocket live-update flow.

The event remains an invalidation signal.

The authoritative data source remains:

POST /api/v1/graph/query

Do not mutate graph truth from WebSocket payloads.

Do not add polling.

Do not add another real-time mechanism.

==================================================
12. ACCESSIBILITY
==================================================

Add lightweight accessibility improvements only where needed:

- status messages use suitable ARIA semantics;
- loading status is understandable by assistive technology;
- errors are announced appropriately where practical;
- retry buttons have accessible names;
- controls remain keyboard accessible;
- sufficient text contrast should be preserved using existing styles;
- status indicators should not rely only on color.

Do not introduce a large accessibility refactor.

==================================================
13. RESPONSIVE / LAYOUT POLISH
==================================================

Make the new states behave correctly within the existing explorer layout.

Ensure:

- loading state does not cause unnecessary page jumps;
- empty/error UI does not destroy the main explorer structure;
- inspector and filters remain usable;
- status elements do not overlap the graph or inspector;
- desktop behavior remains intact.

Do not redesign the layout.

==================================================
14. IMPLEMENTATION STRUCTURE
==================================================

Prefer small focused components/helpers where useful.

Possible names include:

- ExplorerStatus
- ExplorerLoadingState
- ExplorerEmptyState
- ExplorerErrorState
- ExplorerConnectionStatus

These are suggestions only.

Reuse an existing component if the codebase already has the right abstraction.

Keep presentation separate from graph-fetch/business logic where practical.

Do not duplicate:

- graph fetching;
- filter construction;
- WebSocket connection logic;
- LOD logic;
- evidence logic.

==================================================
15. TESTS
==================================================

Add focused tests for at minimum:

1. initial loading state renders;
2. ready graph renders normally;
3. background refresh keeps the existing graph visible;
4. updating indicator appears during background refresh;
5. successful zero-node response renders empty state;
6. analysis-not-ready state remains distinct from empty state;
7. initial query failure renders error state;
8. refresh failure preserves previous graph;
9. retry invokes the existing graph-query flow;
10. successful retry clears the appropriate error;
11. connected WebSocket status is represented correctly;
12. reconnecting state does not hide the graph;
13. disconnected state does not hide the graph;
14. WebSocket recovery clears the appropriate connection status;
15. selection remains valid when the selected node survives refresh;
16. selection is cleared when the selected node disappears;
17. Step 37 filters remain active after refresh;
18. Step 38 LOD remains applied after refresh;
19. Step 39 graph.updated invalidation still triggers refetch;
20. no previous Step 34–39 tests regress.

Do not weaken, delete, or skip existing tests to make the suite pass.

==================================================
16. LEARNING DOCUMENTATION
==================================================

Create:

### Implementation document

`learning/implementations/phase-05/step-40-architecture-explorer-ui-polish.md`

Include:

- objective
- scope
- architecture
- UI state model
- initial loading
- background refresh
- empty state
- analysis-not-ready state
- query error handling
- retry/recovery
- WebSocket connection status
- graph preservation
- interaction with Steps 36–39
- accessibility
- responsive behavior
- performance considerations
- security/invariants
- limitations
- verification
- final Phase 5 completion summary

### Learning notes

`learning/notes/40. Architecture Explorer UI Polish.md`

Explain in plain English:

- loading vs background refreshing;
- empty vs error;
- stale-data preservation;
- retry;
- WebSocket status;
- why graph truth remains backend-authoritative;
- why refresh failures should not destroy usable data;
- how UI state is separated from domain graph state.

### Interview cheat sheet

`learning/interviews/40. Step 40 Architecture Explorer UI Polish Interview CheatSheet.md`

Include:

- likely interview questions;
- concise answers;
- UI state modeling;
- loading vs refreshing;
- stale-data UX;
- retries;
- error recovery;
- WebSocket status UX;
- accessibility;
- performance;
- tradeoffs.

### DESIGN.md

Update:

`docs/DESIGN.md`

Append the Global Step 40 architecture/design section.

DO NOT delete, rewrite, or reorder previous Step 1–39 sections.

Use the same terminology and structure already established in Fluxora documentation.

==================================================
17. VERIFICATION
==================================================

Run all relevant verification commands:

- pnpm --filter @fluxora/web test
- pnpm test
- pnpm --filter @fluxora/web typecheck
- pnpm typecheck
- pnpm lint
- pnpm lint:evidence
- pnpm build
- git diff --check

Fix ONLY issues introduced by Step 40.

Report the actual results.

==================================================
18. FINAL SCOPE GUARD
==================================================

The final diff must contain ONLY:

- Step 40 UI state/polish implementation;
- Step 40 tests;
- Step 40 learning documentation;
- Step 40 DESIGN.md update;
- minimal integration changes required for those items.

DO NOT:

- modify backend APIs;
- add database migrations;
- change graph storage;
- change graph traversal;
- change graph-query semantics;
- change event contracts;
- modify WebSocket server behavior;
- add polling;
- change filters;
- change LOD rules;
- change evidence rules;
- add Phase 6 functionality;
- add unnecessary dependencies;
- perform unrelated refactors.

==================================================
19. FINAL REPORT
==================================================

At the end provide:

1. exact files created;
2. exact files modified;
3. exact UI states implemented;
4. explanation of background refresh behavior;
5. explanation of retry/recovery;
6. explanation of WebSocket status handling;
7. confirmation that Steps 36–39 remain behaviorally intact;
8. complete test/typecheck/lint/build results;
9. confirmation that no Phase 6+ work was implemented.

DO NOT commit or push anything unless explicitly asked.