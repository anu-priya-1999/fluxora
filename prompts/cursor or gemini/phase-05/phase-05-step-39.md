Implement ONLY Global Step 39 of Fluxora:

# Global Step 39 — WebSocket Live Updates

Before making changes, inspect the existing Step 32 WebSocket/event architecture and the Step 34–38 web implementation, especially:

- apps/api/src/
- apps/web/src/
- packages/db/src/
- packages/shared-types/src/events.ts
- packages/shared-types/src/graph.ts
- apps/web/src/app/repositories/[repoId]/explorer/
- apps/web/src/components/graph/
- docs/DESIGN.md
- learning/implementations/phase-05/
- learning/notes/
- learning/interviews/

Use the existing architecture. Do NOT invent a second realtime mechanism.

## Goal

Connect the existing `graph.updated` event flow to the Architecture Explorer so authenticated clients receive live graph-update notifications for their tenant and refresh the displayed graph safely.

The intended flow is:

Graph persistence
→ transactional `graph.updated` outbox/event
→ PostgreSQL notification / existing API listener
→ existing WebSocket server
→ authenticated tenant WebSocket client
→ explorer receives `graph.updated`
→ refetches the existing `POST /api/v1/graph/query`
→ updates the graph presentation.

## STRICT SCOPE

Implement ONLY live graph updates in the existing explorer.

Do NOT implement:

- Step 40 loading/empty/error UI polish
- new graph traversal logic
- new database graph tables
- new graph-query API semantics
- new graph storage behavior
- new clustering/LOD behavior
- changes to Step 34 node rendering
- changes to Step 36 inspector/evidence semantics
- changes to Step 37 filter semantics
- unrelated refactors
- a second WebSocket server
- polling as a replacement for WebSocket
- client-side BFS/DFS
- direct PostgreSQL access from `apps/web`

Do NOT modify the Step 32 event contract unless absolutely required for wiring compatibility. Prefer reusing the existing `graph.updated` payload exactly as defined.

## Existing architecture requirements

First determine how Step 32 currently exposes WebSocket functionality.

Reuse:
- existing authentication model;
- existing tenant/org isolation;
- existing `graph.updated` event type;
- existing WebSocket endpoint/server;
- existing event payload;
- existing graph query request builder from Step 37.

Do NOT create an alternate authentication mechanism.

The browser must never trust an organization/tenant identifier supplied by the client for authorization.

The server remains authoritative for tenant isolation.

## WebSocket client

Add a small, testable browser-side WebSocket client/helper for the explorer.

Requirements:

- construct the WebSocket URL from the current application configuration;
- do not hard-code production hosts;
- connect only when the explorer has the required authenticated context;
- cleanly close the connection on unmount;
- avoid duplicate connections during React development/Strict Mode;
- do not create a new connection on every render;
- handle reconnects conservatively;
- avoid an infinite reconnect storm;
- ensure timers/listeners are cleaned up.

Do not introduce an external WebSocket dependency.

## Authentication

Inspect the existing Step 32 WebSocket authentication mechanism and use it exactly.

Do not send secrets that are intended to remain server-side.

Do not expose Clerk secret keys or database credentials to the browser.

If the current architecture requires a browser-safe token/session mechanism, use the existing application mechanism rather than inventing a parallel auth flow.

## graph.updated behavior

When the authenticated WebSocket receives:

`graph.updated`

for the currently displayed repository/analysis context:

1. validate the event payload using existing shared types/parsers where available;
2. ignore malformed or irrelevant events safely;
3. determine whether the event affects the current explorer context;
4. trigger a fresh graph query through the existing Step 31 endpoint;
5. reuse the current Step 37 filter state;
6. reuse the current start node and traversal direction;
7. reuse the current max depth and confidence constraints;
8. replace the displayed graph with the fresh authoritative response;
9. preserve existing LOD behavior from Step 38;
10. preserve real-node selection where the node still exists;
11. clear selection only when the selected real node no longer exists.

Do NOT patch the graph locally from the event payload unless the existing event contract explicitly requires that behavior.

The event is an invalidation/update signal.
The graph query remains the source of truth.

## Race-condition / stale response protection

Handle multiple updates safely.

Example:

- update A arrives;
- refetch A starts;
- update B arrives before A completes;
- refetch B starts/completes.

The UI must not end up displaying an older response after a newer response.

Use a simple deterministic mechanism such as:
- request sequence/generation tracking;
- AbortController where appropriate;
- or another small existing-pattern solution.

Do not overengineer this.

## Explorer integration

Integrate live updates into:

`apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx`

without rewriting the current Step 35–38 architecture.

The explorer should continue to work when WebSocket is unavailable.

Important:

WebSocket is for live invalidation.

The existing graph query remains the authoritative data fetch path.

Do not introduce polling.

Do not silently fall back to a different backend data source.

## LOD interaction

After a graph refresh:

- recompute the Step 38 presentation layer normally;
- preserve current LOD tier/zoom where practical;
- do not reset viewport unnecessarily;
- do not fabricate cluster nodes;
- preserve stable real graph node IDs.

## Filters interaction

After a graph refresh:

- reuse the exact current Step 37 filter state;
- send filters through the existing `GraphQueryRequest`;
- do not broaden the result set because of the event;
- do not duplicate filtering logic in the WebSocket layer.

## Selection / inspector interaction

After a graph refresh:

- preserve `selectedNodeId` if that node still exists;
- clear it if the node disappeared;
- never convert a synthetic/hidden representation into a real node;
- EvidenceTrail must continue to reference the real selected `GraphNode`.

Do not change the Step 36 evidence association model.

## Connection lifecycle

Implement:

- connection open handling;
- message handling;
- close handling;
- error handling;
- cleanup;
- bounded reconnect behavior.

Avoid aggressive reconnect loops.

A reasonable bounded backoff is sufficient.

The implementation must be deterministic and easy to test.

## Tests

Add focused tests covering at minimum:

1. WebSocket client creates a connection for the correct explorer context.
2. Cleanup closes the connection and removes listeners.
3. Duplicate React mounting does not leave duplicate active connections.
4. Valid `graph.updated` causes a graph refetch.
5. Irrelevant repository/run events do not refetch the current explorer.
6. Malformed WebSocket payloads are ignored safely.
7. Existing Step 37 filters are reused during the refetch.
8. Existing Step 38 LOD is reapplied after fresh graph data arrives.
9. Selected real node is preserved when it still exists.
10. Selection is cleared when the selected node disappears.
11. Stale refetch responses cannot overwrite newer graph data.
12. Reconnect behavior is bounded and cleans up correctly.

Preserve all existing Step 34–38 tests.

## Documentation / learning requirements

Create:

1. `learning/implementations/phase-05/step-39-websocket-live-updates.md`

Include:
- objective
- scope
- existing Step 32 event architecture
- WebSocket connection flow
- authentication flow
- tenant isolation
- `graph.updated` handling
- invalidation → graph query flow
- race/stale response handling
- reconnect strategy
- lifecycle/cleanup
- interaction with Steps 36–38
- performance considerations
- security invariants
- limitations
- verification
- explicit confirmation that Step 40 was NOT implemented

2. `learning/notes/39. WebSocket Live Updates.md`

Plain-English personal learning notes explaining:
- WebSocket vs HTTP
- why Fluxora uses WebSocket as an invalidation channel
- why the graph query remains authoritative
- reconnects
- stale responses
- cleanup
- tenant isolation

3. `learning/interviews/39. Step 39 WebSocket Live Updates Interview CheatSheet.md`

Include:
- likely interview questions
- concise answers
- architecture/data flow
- WebSocket lifecycle
- authentication
- reconnect strategy
- race conditions
- why refetch instead of mutating graph locally
- scalability/tradeoffs
- security considerations

4. Update `docs/DESIGN.md`

Append the Step 39 architecture/design section.

Do NOT delete or rewrite previous Step 1–38 sections.

Use the same terminology, organization, and detail level as the existing Fluxora documentation.

## Verification

Run and report:

- relevant WebSocket/API tests
- web tests
- workspace tests
- web typecheck
- workspace typecheck
- lint
- evidence lint
- build
- `git diff --check`

Fix only issues introduced by Step 39.

## Final scope guard

Final diff must contain ONLY:

- Step 39 WebSocket/live-update implementation
- required Step 39 tests
- required Step 39 learning documentation
- required `docs/DESIGN.md` update
- minimal shared-type changes only if genuinely required for compatibility

Do NOT:
- implement Step 40;
- modify graph traversal;
- modify graph storage;
- add a new API endpoint unless the existing architecture genuinely cannot expose the already-existing WebSocket;
- add a database migration;
- add a new external dependency;
- add polling;
- add client-side graph traversal;
- add synthetic clustering;
- change the existing GraphQuery contract.

At the end, report:

1. exact files created/modified;
2. exact WebSocket/event flow implemented;
3. authentication and tenant-isolation mechanism reused;
4. how `graph.updated` triggers refetch;
5. how stale responses/reconnects are handled;
6. tests and verification results;
7. explicit confirmation that Step 40 was not implemented.