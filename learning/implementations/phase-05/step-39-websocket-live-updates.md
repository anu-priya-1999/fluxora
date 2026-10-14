# Step 39 — WebSocket Live Updates & Analysis Invalidation

## 1. Objective

Connect the existing `graph.updated` domain event pipeline to the Architecture Explorer so authenticated browser clients receive live graph-update notifications for their tenant and refresh the displayed graph safely.

When code changes are pushed or new analysis runs complete, the software digital twin graph is updated in PostgreSQL. Rather than requiring users to manually refresh the browser page or running aggressive HTTP polling loops that degrade database performance, Step 39 establishes a lightweight, secure WebSocket invalidation channel that informs the browser when fresh graph data is available.

---

## 2. Scope

### In Scope
- **Domain Event Parsing & Validation** (`apps/web/src/events/graph-events.ts`):
  - Strongly typed `GraphUpdatedUiNotification` representation.
  - Safe parsing of raw WebSocket strings and JSON objects using `@fluxora/shared-types` (`parseFluxoraEventEnvelope`, `parseGraphUpdatedPayload`).
  - Strict relevancy checking (`isGraphUpdatedEventRelevant`) matching repository and analysis run IDs.
- **Resilient Browser WebSocket Client** (`apps/web/src/events/explorer-ws-client.ts`):
  - Dynamic URL resolution (`resolveWebSocketUrl`) supporting environment-configured hostnames or deriving `ws:` / `wss:` from `apiUrl`.
  - Secure authentication via WebSocket subprotocol (`Sec-WebSocket-Protocol: bearer.<token>`).
  - Bounded exponential backoff reconnect policy (`reconnectAttempts <= 5`, delay doubling up to cap).
  - Explicit connection lifecycle and timer cleanup on unmount.
- **Architecture Explorer Integration** (`apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx`):
  - Subscription effect connected to the browser WebSocket client.
  - Reactive invalidation triggering authoritative graph refetch (`POST /api/v1/graph/query`).
  - Filter state preservation: reuses exact Step 37 `GraphFilterState`.
  - Level-of-Detail (LOD) preservation: recomputes Step 38 visual subsets over updated graph without resetting viewport zoom.
  - Node selection synchronization: preserves real-node selection if the node still exists, clears selection if removed.
  - Stale response and race condition protection via effect-level cancellation.
- **Unit and Integration Test Suites**:
  - `apps/web/src/events/graph-events.test.ts`
  - `apps/web/src/events/explorer-ws-client.test.ts`
  - `apps/web/src/app/repositories/[repoId]/explorer/explorer.test.ts`
- **Documentation and Learning Artifacts**.

### Out of Scope (Strict Boundaries)
- **NO implementation of Step 40 loading/empty/error UI polish**.
- **NO new graph traversal logic** (backend recursive CTE remains unmodified).
- **NO new database graph tables or migrations**.
- **NO new graph-query API semantics or endpoints**.
- **NO client-side BFS/DFS graph traversal**.
- **NO synthetic cluster node fabrication**.
- **NO polling fallback** replacing WebSockets.
- **NO direct PostgreSQL access from `apps/web`**.

---

## 3. Existing Step 32 Event Architecture

Fluxora's event and realtime infrastructure was laid out in Step 8 (events foundation), Step 15 (WebSocket push), and Step 32 (`graph.updated` domain events):

```
 Worker Pipeline (Step 32)
       │
       ▼ (inside PostgreSQL transaction)
 ┌─────────────────────────────────────────────────────────────┐
 │ 1. Compute deterministic GraphDiff (nodes & edges delta)    │
 │ 2. Persist graph entities via EvidenceWriter                │
 │ 3. Insert Outbox Event: type = "graph.updated"              │
 │ 4. Execute pg_notify('fluxora_events', envelope_json)       │
 └──────────────────────────────┬──────────────────────────────┘
                                │ PostgreSQL LISTEN/NOTIFY
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ PostgresEventListener (apps/api/src/ws/listener.ts)         │
 │ - Parses incoming notification envelope                     │
 │ - Forwards to WebSocketHub                                  │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ WebSocketHub (apps/api/src/ws/hub.ts)                       │
 │ - Maps sockets by organizationId: Map<orgId, Set<Client>>   │
 │ - Filters broadcast strictly by envelope.organization_id    │
 └──────────────────────────────┬──────────────────────────────┘
                                │ RFC 6455 WebSocket Frame
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Authenticated Browser Client (Step 39)                      │
 │ - Verifies envelope: type === "graph.updated"               │
 │ - Verifies relevancy: matching repoId & runId               │
 │ - Triggers invalidation refetch: POST /api/v1/graph/query   │
 └─────────────────────────────────────────────────────────────┘
```

---

## 4. WebSocket Connection & Authentication Flow

Standard browser `WebSocket` APIs do not permit custom HTTP headers (such as `Authorization: Bearer <token>`) during the initial HTTP upgrade handshake. URL query parameters (`?token=...`) are explicitly disallowed in Fluxora to prevent tokens from appearing in access logs, browser history, or proxy telemetry.

To solve this securely, Step 32 established subprotocol authentication:
1. The browser passes `protocols: ["bearer." + token]` to the `WebSocket` constructor.
2. The browser emits the `Sec-WebSocket-Protocol: bearer.<jwt>` header in the upgrade request.
3. Fastify / Node HTTP server extracts the token via `extractWsToken(req)`.
4. The server validates the Clerk JWT, resolves the tenant organization, and registers the connection in `WebSocketHub` under `organizationId`.
5. The server acknowledges the connection with `{ type: "connection.ready", organization_id: orgId }`.

The browser client never sends or trusts client-specified organization IDs; tenant boundaries are enforced entirely by server-side verification.

---

## 5. Invalidation as the Core Pattern

A critical invariant of Fluxora is:
> **The WebSocket is an invalidation signal; the graph query is the source of truth.**

Rather than streaming differential mutations (e.g., trying to mutate nodes and edges incrementally on the client), the arrival of `graph.updated` triggers a fresh call to `POST /api/v1/graph/query`:

1. **Deterministic Authority**: The backend recursive CTE remains the sole engine determining reachability, traversal depth, and confidence thresholding.
2. **Filter Consistency**: The refetch automatically passes the user's active Step 37 filters (`node_types`, `edge_types`, `min_confidence`, `max_depth`).
3. **No Drift**: Incremental client-side graph patching easily drifts when events arrive out of order, are dropped during network reconnection, or when complex transitive relationships change. Refetching guarantees 100% mathematical consistency with backend truth.

---

## 6. Race-Condition & Stale Response Handling

When multiple updates occur in rapid succession:
- Update 1 arrives → Refetch 1 begins.
- Update 2 arrives → Refetch 2 begins.
- If Refetch 1 completes *after* Refetch 2 (due to network variance), displaying Refetch 1 would corrupt the UI with outdated graph state.

Step 39 guards against this using:
- **Effect Cancellation**: The `loadGraph` effect tracks `isCancelled`. When a new update or filter change occurs, the cleanup handler sets `isCancelled = true`.
- **Request Sequence Tracking**: Stale responses are discarded before updating React state if a newer request generation has already been dispatched.

---

## 7. Reconnect Strategy & Lifecycle Discipline

Network disruptions and server restarts must not crash the explorer or cause connection storms:
- **Bounded Backoff**: Reconnects are capped at 5 attempts (`maxReconnectAttempts: 5`).
- **Exponential Delay**: Delay begins at 1000ms and doubles on each retry (`1s, 2s, 4s, 8s, 10s`), capped at `maxDelayMs: 10000`.
- **Reset on Open**: A successful socket `open` event immediately resets the retry counter to zero.
- **Strict Cleanup**: Unmounting the explorer explicitly invokes `client.close()`, which clears any pending `setTimeout` backoff timer and cleanly closes the active WebSocket.
- **React Strict Mode Tolerance**: Rapid mount → unmount → remount cycles during React development or Next.js route transitions clean up the initial connection immediately, leaving exactly one active socket without orphaned listeners.

---

## 8. Interaction with Steps 36–38

1. **Step 36 (Node Inspector & Evidence Trail)**:
   - When the graph refreshes, `selectedNodeId` is inspected.
   - If the selected node still exists in the newly fetched graph, `selectedNodeId` is retained, keeping the inspector open.
   - If the node was deleted or filtered out, `selectedNodeId` is reset to `null`, gracefully resetting `NodeInspectorPanel` and `EvidenceTrail` to their empty state.
2. **Step 37 (Graph Filters)**:
   - The refetch reuses the current `GraphFilterState`.
   - Filters are never reset or broadened when a live update arrives.
3. **Step 38 (Level of Detail & Clustering)**:
   - When new nodes and edges arrive from the refetch, `GraphCanvas` receives the new props.
   - `computeLodGraph` recomputes the visible subset according to the active viewport zoom level without resetting the user's viewport pan/zoom position.

---

## 9. Security & Tenancy Invariants

1. **Authoritative Tenancy**: The WebSocket client does not pass `organization_id` or `tenant_id`. The server extracts identity solely from the verified JWT.
2. **Strict Hub Isolation**: `WebSocketHub` categorizes sockets into sets by `organizationId`. A broadcast to Org A is physically never sent to sockets in Org B.
3. **No Direct Database Access**: `apps/web` does not import `@fluxora/db` or connect directly to PostgreSQL.
4. **Sanitized URL Construction**: `resolveWebSocketUrl` sanitizes inputs, ensures secure protocols (`wss:` in production), and prevents query string credentials.

---

## 10. Verification Results

| Suite / Check | Command | Result |
| :--- | :--- | :--- |
| **Web Unit & Integration Tests** | `pnpm --filter @fluxora/web test` | **85 passed, 0 failed** |
| **API WebSocket & Route Tests** | `pnpm --filter @fluxora/api test` | **65 passed, 0 failed** |
| **Workspace Unit Tests** | `pnpm test` | **All packages passed (380+ tests)** |
| **Web Typecheck** | `pnpm --filter @fluxora/web typecheck` | **Passed (0 errors)** |
| **Workspace Typecheck** | `pnpm typecheck` | **Passed across all 7 projects** |
| **Workspace Linter** | `pnpm lint` | **Passed (0 errors, 0 warnings)** |
| **CI Evidence Linter** | `pnpm lint:evidence` | **Passed (100% graph write AST compliance)** |
| **Next.js Production Build** | `pnpm build` | **Passed (Compiled successfully, all routes valid)** |
| **Git Diff Cleanliness** | `git diff --check` | **Passed (0 whitespace / newline errors)** |

---

## 11. Scope Confirmation

> [!IMPORTANT]
> **Step 40 was explicitly NOT implemented.**
> No loading/empty/error UI polish, skeleton animations, or Step 40 design adjustments were introduced. All work strictly adheres to Global Step 39 live invalidation and WebSocket updates.

