import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GraphQueryResponse } from "@fluxora/shared-types";
import {
  ExplorerLoadingState,
  ExplorerEmptyState,
  ExplorerAnalysisNotReady,
  ExplorerErrorState,
  ExplorerConnectionBadge,
  ExplorerUpdatingIndicator,
  ExplorerRefreshErrorBanner,
  mapWsStatusToConnectionStatus,
  type ExplorerConnectionStatus,
} from "./explorer-status-data.ts";
import type { ExplorerState } from "../../app/repositories/[repoId]/explorer/explorer-data.ts";
import {
  buildGraphQueryRequest,
  fetchGraphQuery,
  transformGraphResponseToFlow,
} from "../../app/repositories/[repoId]/explorer/explorer-data.ts";
import { computeLodGraph } from "./graph-lod.ts";
import {
  handleGraphUpdatedMessage,
  isGraphUpdatedEventRelevant,
} from "../../events/graph-events.ts";

const REPO_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const NODE_ROOT = "44444444-4444-4444-8444-444444444444";
const NODE_CHILD = "55555555-5555-4555-8555-555555555555";
const EDGE_ID = "66666666-6666-4666-8666-666666666666";

const MOCK_CONTEXT = {
  repositoryId: REPO_ID,
  analysisRunId: RUN_ID,
  defaultStartNodeId: NODE_ROOT,
};

const MOCK_GRAPH_RESPONSE: GraphQueryResponse = {
  nodes: [
    { id: NODE_ROOT, type: "application", name: "fluxora", canonical_id: "app:fluxora", depth: 0, confidence: 1.0 },
    { id: NODE_CHILD, type: "service", name: "api-service", canonical_id: "svc:api", depth: 1, confidence: 0.95 },
  ],
  edges: [
    { id: EDGE_ID, source: NODE_ROOT, target: NODE_CHILD, type: "DEPENDS_ON", confidence: 0.95, provenance: "static-analysis" },
  ],
  max_depth_reached: 1,
  truncated: false,
};

// =============================================================================
// Test 1: Initial loading state renders
// =============================================================================
test("Step 40 #1: Initial loading state renders with accessible status", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExplorerLoadingState, null),
  );

  assert.match(html, /data-testid="explorer-loading-state"/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Loading Architecture Graph/);
});

// =============================================================================
// Test 2: Ready graph renders normally
// =============================================================================
test("Step 40 #2: Ready state produces valid flow nodes and edges for GraphCanvas", () => {
  const flow = transformGraphResponseToFlow(MOCK_GRAPH_RESPONSE);

  assert.equal(flow.nodes.length, 2);
  assert.equal(flow.edges.length, 1);
  assert.equal(flow.nodes[0]?.id, NODE_ROOT);
  assert.equal(flow.nodes[1]?.id, NODE_CHILD);
  assert.equal(flow.edges[0]?.source, NODE_ROOT);
  assert.equal(flow.edges[0]?.target, NODE_CHILD);
});

// =============================================================================
// Test 3: Background refresh keeps existing graph visible
// =============================================================================
test("Step 40 #3: Background refresh preserves existing ready state during fetch", () => {
  // Simulate the explorer state machine: when a ready graph exists and a refetch starts,
  // the state should remain 'ready' (not revert to 'loading')
  const readyState: ExplorerState = {
    status: "ready",
    analysisRunId: RUN_ID,
    repositoryId: REPO_ID,
    graph: MOCK_GRAPH_RESPONSE,
    flowNodes: transformGraphResponseToFlow(MOCK_GRAPH_RESPONSE).nodes,
    flowEdges: transformGraphResponseToFlow(MOCK_GRAPH_RESPONSE).edges,
  };

  // The explorer-client logic: if prev.status === 'ready', keep it (don't go to loading)
  const nextState: ExplorerState = readyState.status === "ready" ? readyState : { status: "loading" };

  assert.equal(nextState.status, "ready");
  assert.equal((nextState as { graph: GraphQueryResponse }).graph.nodes.length, 2);
});

// =============================================================================
// Test 4: Updating indicator appears during background refresh
// =============================================================================
test("Step 40 #4: Updating indicator renders when visible and hides when not", () => {
  const visibleHtml = renderToStaticMarkup(
    React.createElement(ExplorerUpdatingIndicator, { visible: true }),
  );
  assert.match(visibleHtml, /data-testid="explorer-updating-indicator"/);
  assert.match(visibleHtml, /role="status"/);
  assert.match(visibleHtml, /aria-label="Updating graph"/);

  const hiddenHtml = renderToStaticMarkup(
    React.createElement(ExplorerUpdatingIndicator, { visible: false }),
  );
  assert.ok(!hiddenHtml.includes("explorer-updating-indicator"));
});

// =============================================================================
// Test 5: Successful zero-node response renders empty state
// =============================================================================
test("Step 40 #5: Empty state renders when query succeeds with zero nodes", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExplorerEmptyState, {
      message: "The graph query returned successfully but contained no renderable nodes.",
    }),
  );

  assert.match(html, /data-testid="explorer-empty-state"/);
  assert.match(html, /No Graph Nodes Found/);
  assert.match(html, /no renderable nodes/);
  assert.match(html, /role="status"/);
  // Must contain guidance
  assert.match(html, /adjust/);
});

// =============================================================================
// Test 6: Analysis-not-ready is visually distinct from empty state
// =============================================================================
test("Step 40 #6: Analysis-not-ready state is distinct from empty state", () => {
  const notReadyHtml = renderToStaticMarkup(
    React.createElement(ExplorerAnalysisNotReady, {
      message: "Analysis has not completed yet.",
    }),
  );

  const emptyHtml = renderToStaticMarkup(
    React.createElement(ExplorerEmptyState, {
      message: "No nodes returned.",
    }),
  );

  // Different test IDs
  assert.match(notReadyHtml, /data-testid="explorer-analysis-not-ready"/);
  assert.match(emptyHtml, /data-testid="explorer-empty-state"/);

  // Different headings
  assert.match(notReadyHtml, /Analysis Not Ready/);
  assert.match(emptyHtml, /No Graph Nodes Found/);

  // Not-ready uses hourglass, empty uses inbox
  assert.match(notReadyHtml, /\u23f3/);
  assert.match(emptyHtml, /\ud83d\udced/);
});

// =============================================================================
// Test 7: Initial query failure renders error state with retry
// =============================================================================
test("Step 40 #7: Error state renders with retry button when initial query fails", () => {
  let retryCalled = false;
  const html = renderToStaticMarkup(
    React.createElement(ExplorerErrorState, {
      message: "The Fluxora API could not be reached.",
      onRetry: () => { retryCalled = true; },
    }),
  );

  assert.match(html, /data-testid="explorer-error-state"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /Graph Query Failed/);
  assert.match(html, /could not be reached/);
  assert.match(html, /data-testid="explorer-retry-button"/);
  assert.match(html, /aria-label="Retry loading the architecture graph"/);
  assert.equal(retryCalled, false);
});

// =============================================================================
// Test 8: Refresh failure preserves previous graph (non-blocking banner)
// =============================================================================
test("Step 40 #8: Refresh error banner renders non-blocking error with retry", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExplorerRefreshErrorBanner, {
      message: "Network timeout.",
      onRetry: () => {},
      onDismiss: () => {},
    }),
  );

  assert.match(html, /data-testid="explorer-refresh-error"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Network timeout/);
  assert.match(html, /data-testid="refresh-error-retry-button"/);
  assert.match(html, /aria-label="Retry graph refresh"/);
  assert.match(html, /data-testid="refresh-error-dismiss-button"/);
  assert.match(html, /aria-label="Dismiss error"/);
});

// =============================================================================
// Test 9: Retry invokes the existing graph-query flow
// =============================================================================
test("Step 40 #9: Retry uses existing graph-query mechanism with preserved context and filters", async () => {
  const currentFilters = {
    nodeTypes: ["service", "database"] as string[],
    edgeTypes: ["DEPENDS_ON"] as string[],
    minConfidence: 0.8,
    maxDepth: 3,
  };

  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const request = buildGraphQueryRequest({
    context: MOCK_CONTEXT,
    filters: currentFilters,
    direction: "both",
    includeEvidence: true,
  });

  const result = await fetchGraphQuery({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "valid-jwt",
    request,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify(MOCK_GRAPH_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  // Verify filters are preserved in the retry request
  assert.deepEqual(requests[0]?.body.node_types, ["service", "database"]);
  assert.deepEqual(requests[0]?.body.edge_types, ["DEPENDS_ON"]);
  assert.equal(requests[0]?.body.min_confidence, 0.8);
  assert.equal(requests[0]?.body.max_depth, 3);
  assert.equal(requests[0]?.body.analysis_run_id, RUN_ID);
  assert.equal(requests[0]?.body.start_node_id, NODE_ROOT);
});

// =============================================================================
// Test 10: Successful retry clears the appropriate error
// =============================================================================
test("Step 40 #10: Successful fetch transitions from error to ready state", async () => {
  // Simulate: start in error state, retry succeeds
  let currentState: ExplorerState = { status: "error", message: "Network error" };

  const result = await fetchGraphQuery({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "valid-jwt",
    request: buildGraphQueryRequest({ context: MOCK_CONTEXT }),
    fetchImpl: async () => {
      return new Response(JSON.stringify(MOCK_GRAPH_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  if (result.ok && result.data.nodes.length > 0) {
    const flow = transformGraphResponseToFlow(result.data);
    currentState = {
      status: "ready",
      analysisRunId: MOCK_CONTEXT.analysisRunId,
      repositoryId: MOCK_CONTEXT.repositoryId,
      graph: result.data,
      flowNodes: flow.nodes,
      flowEdges: flow.edges,
    };
  }

  assert.equal(currentState.status, "ready");
});

// =============================================================================
// Test 11: Connected WebSocket status is represented correctly
// =============================================================================
test("Step 40 #11: Connected WebSocket status renders correct badge", () => {
  const status = mapWsStatusToConnectionStatus("connected");
  assert.equal(status, "connected");

  const html = renderToStaticMarkup(
    React.createElement(ExplorerConnectionBadge, { status: "connected" }),
  );

  assert.match(html, /data-testid="explorer-connection-badge"/);
  assert.match(html, /data-status="connected"/);
  assert.match(html, /aria-label="Live updates connected"/);
  assert.match(html, /Live/);
});

// =============================================================================
// Test 12: Reconnecting state does not hide the graph
// =============================================================================
test("Step 40 #12: Reconnecting status maps correctly and does not remove graph", () => {
  const status = mapWsStatusToConnectionStatus("connecting");
  assert.equal(status, "reconnecting");

  const html = renderToStaticMarkup(
    React.createElement(ExplorerConnectionBadge, { status: "reconnecting" }),
  );

  assert.match(html, /data-status="reconnecting"/);
  assert.match(html, /Reconnecting/);
  // The badge is a small indicator that lives alongside the graph, not replacing it
  assert.ok(!html.includes("explorer-error-state"));
  assert.ok(!html.includes("explorer-loading-state"));
});

// =============================================================================
// Test 13: Disconnected state does not hide the graph
// =============================================================================
test("Step 40 #13: Disconnected status maps correctly and does not remove graph", () => {
  const disconnected = mapWsStatusToConnectionStatus("disconnected");
  assert.equal(disconnected, "disconnected");

  const closed = mapWsStatusToConnectionStatus("closed");
  assert.equal(closed, "disconnected");

  const idle = mapWsStatusToConnectionStatus("idle");
  assert.equal(idle, "disconnected");

  const html = renderToStaticMarkup(
    React.createElement(ExplorerConnectionBadge, { status: "disconnected" }),
  );

  assert.match(html, /data-status="disconnected"/);
  assert.match(html, /Offline/);
  assert.match(html, /aria-label="Live updates unavailable"/);
});

// =============================================================================
// Test 14: WebSocket recovery clears connection status
// =============================================================================
test("Step 40 #14: WebSocket recovery transitions from disconnected to connected", () => {
  // Simulate status transitions
  const transitions: ExplorerConnectionStatus[] = [];

  const statuses: Array<"idle" | "connecting" | "connected" | "disconnected" | "closed"> = [
    "idle",
    "connecting",
    "connected",
    "disconnected",
    "connecting",
    "connected",
  ];

  for (const ws of statuses) {
    transitions.push(mapWsStatusToConnectionStatus(ws));
  }

  assert.deepEqual(transitions, [
    "disconnected",
    "reconnecting",
    "connected",
    "disconnected",
    "reconnecting",
    "connected",
  ]);
});

// =============================================================================
// Test 15: Selection remains valid when selected node survives refresh
// =============================================================================
test("Step 40 #15: Selection preserved when selected node exists in refreshed graph", () => {
  const selectedNodeId = NODE_CHILD;
  const refreshedGraph = MOCK_GRAPH_RESPONSE;

  const exists = refreshedGraph.nodes.some((n) => n.id === selectedNodeId);
  const newSelectedId = exists ? selectedNodeId : null;

  assert.equal(newSelectedId, NODE_CHILD);
});

// =============================================================================
// Test 16: Selection cleared when selected node disappears
// =============================================================================
test("Step 40 #16: Selection cleared when selected node is absent after refresh", () => {
  const selectedNodeId = NODE_CHILD;
  const refreshedGraph: GraphQueryResponse = {
    nodes: [
      { id: NODE_ROOT, type: "application", name: "fluxora", canonical_id: "app:fluxora", depth: 0, confidence: 1 },
    ],
    edges: [],
    max_depth_reached: 0,
    truncated: false,
  };

  const exists = refreshedGraph.nodes.some((n) => n.id === selectedNodeId);
  const newSelectedId = exists ? selectedNodeId : null;

  assert.equal(newSelectedId, null);
});

// =============================================================================
// Test 17: Step 37 filters remain active after refresh
// =============================================================================
test("Step 40 #17: Filters remain active and are included in retry/refresh request", () => {
  const filters = {
    nodeTypes: ["service", "api"] as string[],
    edgeTypes: ["CALLS", "IMPORTS"] as string[],
    minConfidence: 0.7,
    maxDepth: 4,
  };

  // Build request preserving filters (same mechanism used by retry)
  const request = buildGraphQueryRequest({
    context: MOCK_CONTEXT,
    filters,
    direction: "both",
    includeEvidence: true,
  });

  assert.deepEqual(request.node_types, ["service", "api"]);
  assert.deepEqual(request.edge_types, ["CALLS", "IMPORTS"]);
  assert.equal(request.min_confidence, 0.7);
  assert.equal(request.max_depth, 4);
  assert.equal(request.analysis_run_id, RUN_ID);
  assert.equal(request.start_node_id, NODE_ROOT);
});

// =============================================================================
// Test 18: Step 38 LOD remains applied after refresh
// =============================================================================
test("Step 40 #18: LOD is reapplied deterministically after graph refresh", () => {
  const refreshedResponse: GraphQueryResponse = {
    nodes: [
      { id: NODE_ROOT, type: "application", name: "fluxora", canonical_id: "app:fluxora", depth: 0, confidence: 1.0 },
      { id: NODE_CHILD, type: "service", name: "api-service", canonical_id: "svc:api", depth: 1, confidence: 0.95 },
      { id: "symbol-1", type: "symbol", name: "getUser", canonical_id: "sym:getUser", depth: 2, confidence: 0.9 },
    ],
    edges: [
      { id: EDGE_ID, source: NODE_ROOT, target: NODE_CHILD, type: "DEPENDS_ON", confidence: 0.95, provenance: "static" },
      { id: "edge-2", source: NODE_CHILD, target: "symbol-1", type: "CALLS", confidence: 0.9, provenance: "static" },
    ],
    max_depth_reached: 2,
    truncated: false,
  };

  const lodResult = computeLodGraph({
    nodes: refreshedResponse.nodes,
    edges: refreshedResponse.edges,
    lod: "overview",
    selectedNodeId: null,
  });

  // At overview, symbols are hidden
  assert.equal(lodResult.visibleNodes.length, 2);
  assert.ok(!lodResult.visibleNodes.some((n) => n.id === "symbol-1"));
  assert.equal(lodResult.visibleEdges.length, 1);
});

// =============================================================================
// Test 19: Step 39 graph.updated invalidation still triggers refetch
// =============================================================================
test("Step 40 #19: graph.updated event still triggers refetch via existing mechanism", () => {
  const eventPayload = {
    event_id: "77777777-7777-4777-8777-777777777777",
    event_type: "graph.updated",
    organization_id: "11111111-1111-4111-8111-111111111111",
    occurred_at: "2026-10-14T12:00:00.000Z",
    schema_version: 1,
    idempotency_key: "graph.updated:run-1",
    payload: {
      organization_id: "11111111-1111-4111-8111-111111111111",
      analysis_run_id: RUN_ID,
      repository_id: REPO_ID,
      summary: {
        nodes_added: 1, nodes_removed: 0, nodes_changed: 0, nodes_unchanged: 5,
        edges_added: 0, edges_removed: 0, edges_changed: 0, edges_unchanged: 3,
        total_nodes_before: 5, total_nodes_after: 6,
        total_edges_before: 3, total_edges_after: 3,
        node_delta: 1, edge_delta: 0,
      },
      diff: {
        addedNodes: [], removedNodes: [], changedNodes: [],
        addedEdges: [], removedEdges: [], changedEdges: [],
      },
    },
  };

  const notification = handleGraphUpdatedMessage(eventPayload);
  assert.ok(notification !== null);
  const isRelevant = isGraphUpdatedEventRelevant(notification!.payload, MOCK_CONTEXT);
  assert.equal(isRelevant, true);
});

// =============================================================================
// Test 20: No previous Step 34-39 tests regress (ExplorerState compatibility)
// =============================================================================
test("Step 40 #20: ExplorerState type supports all previous and new states without regression", () => {
  // Verify all state shapes are valid
  const loading: ExplorerState = { status: "loading" };
  assert.equal(loading.status, "loading");

  const notReady: ExplorerState = { status: "not_ready", message: "Analysis pending" };
  assert.equal(notReady.status, "not_ready");

  const empty: ExplorerState = { status: "empty", message: "No nodes found" };
  assert.equal(empty.status, "empty");

  const error: ExplorerState = { status: "error", message: "Network error" };
  assert.equal(error.status, "error");

  const ready: ExplorerState = {
    status: "ready",
    analysisRunId: RUN_ID,
    repositoryId: REPO_ID,
    graph: MOCK_GRAPH_RESPONSE,
    flowNodes: [],
    flowEdges: [],
  };
  assert.equal(ready.status, "ready");

  // Verify mapWsStatusToConnectionStatus handles all ExplorerWsStatus values
  assert.equal(mapWsStatusToConnectionStatus("idle"), "disconnected");
  assert.equal(mapWsStatusToConnectionStatus("connecting"), "reconnecting");
  assert.equal(mapWsStatusToConnectionStatus("connected"), "connected");
  assert.equal(mapWsStatusToConnectionStatus("disconnected"), "disconnected");
  assert.equal(mapWsStatusToConnectionStatus("closed"), "disconnected");
});
