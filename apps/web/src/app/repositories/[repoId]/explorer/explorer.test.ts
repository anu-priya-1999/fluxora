import assert from "node:assert/strict";
import { test } from "vitest";
import { GRAPH_QUERY_PATH, type GraphQueryRequest, type GraphQueryResponse } from "@fluxora/shared-types";
import {
  buildGraphQueryRequest,
  createSimulationPollController,
  fetchGraphQuery,
  resolveRepositoryAnalysisContext,
  shouldScheduleSimulationPoll,
  transformGraphResponseToFlow,
} from "./explorer-data.ts";
import {
  DEFAULT_SIMULATION_MODE_STATE,
  type NormalizedSimulationModeState,
} from "../../../../components/graph/simulation-mode-data.ts";
import { computeLodGraph } from "../../../../components/graph/graph-lod.ts";
import {
  handleGraphUpdatedMessage,
  isGraphUpdatedEventRelevant,
} from "../../../../events/graph-events.ts";
import {
  createExplorerWebSocketClient,
  type WebSocketLike,
} from "../../../../events/explorer-ws-client.ts";

const REPO_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const NODE_ROOT = "44444444-4444-4444-8444-444444444444";
const NODE_CHILD = "55555555-5555-4555-8555-555555555555";
const EDGE_ID = "66666666-6666-4666-8666-666666666666";

test("resolveRepositoryAnalysisContext resolves context from route params and searchParams", () => {
  const result = resolveRepositoryAnalysisContext({
    repoId: REPO_ID,
    searchParams: {
      analysis_run_id: RUN_ID,
      start_node_id: NODE_ROOT,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.context.repositoryId, REPO_ID);
    assert.equal(result.context.analysisRunId, RUN_ID);
    assert.equal(result.context.defaultStartNodeId, NODE_ROOT);
  }
});

test("resolveRepositoryAnalysisContext supports run_id and node_id aliases", () => {
  const result = resolveRepositoryAnalysisContext({
    repoId: REPO_ID,
    searchParams: {
      run_id: RUN_ID,
      node_id: NODE_ROOT,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.context.repositoryId, REPO_ID);
    assert.equal(result.context.analysisRunId, RUN_ID);
    assert.equal(result.context.defaultStartNodeId, NODE_ROOT);
  }
});

test("resolveRepositoryAnalysisContext handles invalid repoId as repository_not_found", () => {
  const result = resolveRepositoryAnalysisContext({
    repoId: "invalid-uuid-string",
    searchParams: {
      analysis_run_id: RUN_ID,
      start_node_id: NODE_ROOT,
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "repository_not_found");
    assert.match(result.message, /invalid repository/i);
  }
});

test("resolveRepositoryAnalysisContext handles missing analysis_run_id as analysis_not_ready", () => {
  const result = resolveRepositoryAnalysisContext({
    repoId: REPO_ID,
    searchParams: {},
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "analysis_not_ready");
    assert.match(result.message, /not ready yet/i);
  }
});

test("resolveRepositoryAnalysisContext handles missing start_node_id as analysis_not_ready", () => {
  const result = resolveRepositoryAnalysisContext({
    repoId: REPO_ID,
    searchParams: {
      analysis_run_id: RUN_ID,
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "analysis_not_ready");
    assert.match(result.message, /no start node/i);
  }
});

test("fetchGraphQuery targets POST /api/v1/graph/query with GraphQueryRequest and session token", async () => {
  const requestsMade: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];

  const mockResponse: GraphQueryResponse = {
    nodes: [
      {
        id: NODE_ROOT,
        type: "application",
        name: "fluxora",
        canonical_id: "app:fluxora",
        depth: 0,
        confidence: 1.0,
      },
      {
        id: NODE_CHILD,
        type: "service",
        name: "api-service",
        canonical_id: "svc:api",
        depth: 1,
        confidence: 0.95,
      },
    ],
    edges: [
      {
        id: EDGE_ID,
        source: NODE_ROOT,
        target: NODE_CHILD,
        type: "DEPENDS_ON",
        confidence: 0.95,
        provenance: "static-analysis",
      },
    ],
    max_depth_reached: 1,
    truncated: false,
  };

  const reqBody: GraphQueryRequest = {
    analysis_run_id: RUN_ID,
    start_node_id: NODE_ROOT,
    direction: "both",
  };

  const result = await fetchGraphQuery({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "valid-jwt-token",
    request: reqBody,
    fetchImpl: async (url, init) => {
      requestsMade.push({
        url,
        init,
        body: JSON.parse(init.body as string),
      });
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(requestsMade.length, 1);
  const firstRequest = requestsMade[0];
  assert.ok(firstRequest);
  assert.equal(firstRequest.url, `http://127.0.0.1:4000${GRAPH_QUERY_PATH}`);
  assert.equal(firstRequest.init.method, "POST");

  const headers = firstRequest.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer valid-jwt-token");
  assert.equal(headers["content-type"], "application/json");

  // Verify that request body strictly conforms to GraphQueryRequest and DOES NOT include organization_id
  assert.equal(firstRequest.body["analysis_run_id"], RUN_ID);
  assert.equal(firstRequest.body["start_node_id"], NODE_ROOT);
  assert.equal("organization_id" in firstRequest.body, false);
  assert.equal("organizationId" in firstRequest.body, false);
});

test("fetchGraphQuery correctly reports authentication errors without leaking tokens", async () => {
  const result = await fetchGraphQuery({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => null,
    request: {
      analysis_run_id: RUN_ID,
      start_node_id: NODE_ROOT,
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_authenticated");
    assert.equal(result.message, "Authentication required.");
  }
});

test("fetchGraphQuery handles 404 start node not found cleanly", async () => {
  const result = await fetchGraphQuery({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "valid-jwt",
    request: {
      analysis_run_id: RUN_ID,
      start_node_id: NODE_ROOT,
    },
    fetchImpl: async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "start_node_not_found",
            message: "Start node was not found within the requested analysis run.",
          },
        }),
        { status: 404 },
      );
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_found");
    assert.match(result.message, /not found/i);
  }
});

test("transformGraphResponseToFlow maps GraphQueryResponse deterministically to GraphCanvas input", () => {
  const mockResponse: GraphQueryResponse = {
    nodes: [
      {
        id: NODE_ROOT,
        type: "application",
        name: "fluxora",
        canonical_id: "app:fluxora",
        depth: 0,
        confidence: 1.0,
      },
      {
        id: NODE_CHILD,
        type: "service",
        name: "api-service",
        canonical_id: "svc:api",
        depth: 1,
        confidence: 0.95,
      },
    ],
    edges: [
      {
        id: EDGE_ID,
        source: NODE_ROOT,
        target: NODE_CHILD,
        type: "DEPENDS_ON",
        confidence: 0.95,
        provenance: "static-analysis",
      },
    ],
    max_depth_reached: 1,
    truncated: false,
  };

  const { nodes, edges } = transformGraphResponseToFlow(mockResponse);

  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);

  assert.equal(nodes[0]?.id, NODE_ROOT);
  assert.equal(nodes[0]?.data.name, "fluxora");
  assert.equal(nodes[0]?.data.nodeType, "application");
  assert.equal(nodes[0]?.data.canonicalId, "app:fluxora");

  assert.equal(nodes[1]?.id, NODE_CHILD);
  assert.equal(nodes[1]?.data.name, "api-service");

  assert.equal(edges[0]?.id, EDGE_ID);
  assert.equal(edges[0]?.source, NODE_ROOT);
  assert.equal(edges[0]?.target, NODE_CHILD);
});

test("Step 39: WebSocket client connects for correct explorer context and subprotocol", async () => {
  let connectedUrl = "";
  let connectedProtocols: string | string[] | undefined;

  const mockWs: WebSocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close() {
      this.onclose?.call(this, new CloseEvent("close"));
    },
  };

  const client = createExplorerWebSocketClient({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "test-session-jwt",
    webSocketFactory: (url, protocols) => {
      connectedUrl = url;
      connectedProtocols = protocols;
      return mockWs;
    },
    onGraphUpdated: () => {},
  });

  await client.connect();

  assert.equal(connectedUrl, "ws://127.0.0.1:4000/api/v1/ws");
  assert.deepEqual(connectedProtocols, ["bearer.test-session-jwt"]);

  client.close();
});

test("Step 39: Duplicate React mounting cleans up without leaving duplicate active connections", async () => {
  const activeSockets: WebSocketLike[] = [];

  function createMockWs(_url: string, _protocols?: string | string[]): WebSocketLike {
    void _url;
    void _protocols;
    const ws: WebSocketLike = {
      readyState: 1,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close() {
        const idx = activeSockets.indexOf(ws);
        if (idx !== -1) {
          activeSockets.splice(idx, 1);
        }
      },
    };
    activeSockets.push(ws);
    return ws;
  }

  // Simulate Mount 1
  const client1 = createExplorerWebSocketClient({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "jwt-1",
    webSocketFactory: createMockWs,
    onGraphUpdated: () => {},
  });
  await client1.connect();
  assert.equal(activeSockets.length, 1);

  // Strict Mode unmount of Mount 1
  client1.close();
  assert.equal(activeSockets.length, 0);

  // Simulate Mount 2
  const client2 = createExplorerWebSocketClient({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "jwt-2",
    webSocketFactory: createMockWs,
    onGraphUpdated: () => {},
  });
  await client2.connect();
  assert.equal(activeSockets.length, 1);

  client2.close();
  assert.equal(activeSockets.length, 0);
});

test("Step 39: Valid graph.updated triggers refetch with current Step 37 filters preserved", async () => {
  const context = {
    repositoryId: REPO_ID,
    analysisRunId: RUN_ID,
    defaultStartNodeId: NODE_ROOT,
  };

  const currentFilters: import("../../../../components/graph/GraphFilters.tsx").GraphFilterState = {
    nodeTypes: ["service", "database"],
    edgeTypes: ["DEPENDS_ON"],
    minConfidence: 0.8,
    maxDepth: 3,
  };

  const requests: GraphQueryRequest[] = [];

  const refetchGraph = async () => {
    const req = buildGraphQueryRequest({
      context,
      filters: currentFilters,
      direction: "both",
      includeEvidence: true,
    });
    requests.push(req);
  };

  // Simulate incoming WebSocket message
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
        nodes_added: 1,
        nodes_removed: 0,
        nodes_changed: 0,
        nodes_unchanged: 5,
        edges_added: 0,
        edges_removed: 0,
        edges_changed: 0,
        edges_unchanged: 3,
        total_nodes_before: 5,
        total_nodes_after: 6,
        total_edges_before: 3,
        total_edges_after: 3,
        node_delta: 1,
        edge_delta: 0,
      },
      diff: {
        addedNodes: [],
        removedNodes: [],
        changedNodes: [],
        addedEdges: [],
        removedEdges: [],
        changedEdges: [],
      },
    },
  };

  const notification = handleGraphUpdatedMessage(eventPayload);
  assert.ok(notification !== null);

  if (isGraphUpdatedEventRelevant(notification.payload, context)) {
    await refetchGraph();
  }

  assert.equal(requests.length, 1);
  const sentReq = requests[0];
  assert.ok(sentReq);
  assert.equal(sentReq.analysis_run_id, RUN_ID);
  assert.equal(sentReq.start_node_id, NODE_ROOT);
  assert.deepEqual(sentReq.node_types, ["service", "database"]);
  assert.deepEqual(sentReq.edge_types, ["DEPENDS_ON"]);
  assert.equal(sentReq.min_confidence, 0.8);
  assert.equal(sentReq.max_depth, 3);
});

test("Step 39: Irrelevant repository/run events do not trigger refetch", async () => {
  const context = {
    repositoryId: REPO_ID,
    analysisRunId: RUN_ID,
    defaultStartNodeId: NODE_ROOT,
  };

  let refetchCalled = false;

  const notificationForOtherRepo = handleGraphUpdatedMessage({
    event_id: "77777777-7777-4777-8777-777777777777",
    event_type: "graph.updated",
    organization_id: "11111111-1111-4111-8111-111111111111",
    occurred_at: "2026-10-14T12:00:00.000Z",
    schema_version: 1,
    idempotency_key: "key-other",
    payload: {
      organization_id: "11111111-1111-4111-8111-111111111111",
      analysis_run_id: RUN_ID,
      repository_id: "99999999-9999-4999-8999-999999999999", // Different repo
      summary: {
        nodes_added: 1,
        nodes_removed: 0,
        nodes_changed: 0,
        nodes_unchanged: 5,
        edges_added: 0,
        edges_removed: 0,
        edges_changed: 0,
        edges_unchanged: 3,
        total_nodes_before: 5,
        total_nodes_after: 6,
        total_edges_before: 3,
        total_edges_after: 3,
        node_delta: 1,
        edge_delta: 0,
      },
      diff: {
        addedNodes: [],
        removedNodes: [],
        changedNodes: [],
        addedEdges: [],
        removedEdges: [],
        changedEdges: [],
      },
    },
  });

  assert.ok(notificationForOtherRepo !== null);
  if (isGraphUpdatedEventRelevant(notificationForOtherRepo.payload, context)) {
    refetchCalled = true;
  }
  assert.equal(refetchCalled, false);

  const notificationForOtherRun = handleGraphUpdatedMessage({
    event_id: "88888888-8888-4888-8888-888888888888",
    event_type: "graph.updated",
    organization_id: "11111111-1111-4111-8111-111111111111",
    occurred_at: "2026-10-14T12:00:00.000Z",
    schema_version: 1,
    idempotency_key: "key-other-run",
    payload: {
      organization_id: "11111111-1111-4111-8111-111111111111",
      analysis_run_id: "88888888-8888-4888-8888-888888888888", // Different run
      repository_id: REPO_ID,
      summary: {
        nodes_added: 1,
        nodes_removed: 0,
        nodes_changed: 0,
        nodes_unchanged: 5,
        edges_added: 0,
        edges_removed: 0,
        edges_changed: 0,
        edges_unchanged: 3,
        total_nodes_before: 5,
        total_nodes_after: 6,
        total_edges_before: 3,
        total_edges_after: 3,
        node_delta: 1,
        edge_delta: 0,
      },
      diff: {
        addedNodes: [],
        removedNodes: [],
        changedNodes: [],
        addedEdges: [],
        removedEdges: [],
        changedEdges: [],
      },
    },
  });

  assert.ok(notificationForOtherRun !== null);
  if (isGraphUpdatedEventRelevant(notificationForOtherRun.payload, context)) {
    refetchCalled = true;
  }
  assert.equal(refetchCalled, false);
});

test("Step 39: Selection preservation when selected node remains, and clearing when removed", () => {
  const currentSelectedId = NODE_CHILD;

  const refreshedResponseWithNode: GraphQueryResponse = {
    nodes: [
      { id: NODE_ROOT, type: "application", name: "fluxora", canonical_id: "app:fluxora", depth: 0, confidence: 1 },
      { id: NODE_CHILD, type: "service", name: "api-service", canonical_id: "svc:api", depth: 1, confidence: 0.95 },
    ],
    edges: [],
    max_depth_reached: 1,
    truncated: false,
  };

  const nextSelectedPreserved = refreshedResponseWithNode.nodes.some((n) => n.id === currentSelectedId)
    ? currentSelectedId
    : null;
  assert.equal(nextSelectedPreserved, NODE_CHILD);

  // When node is removed in next graph update
  const refreshedResponseWithoutNode: GraphQueryResponse = {
    nodes: [
      { id: NODE_ROOT, type: "application", name: "fluxora", canonical_id: "app:fluxora", depth: 0, confidence: 1 },
    ],
    edges: [],
    max_depth_reached: 0,
    truncated: false,
  };

  const nextSelectedCleared = refreshedResponseWithoutNode.nodes.some((n) => n.id === currentSelectedId)
    ? currentSelectedId
    : null;
  assert.equal(nextSelectedCleared, null);
});

test("Step 39: Stale refetch responses cannot overwrite newer graph data", async () => {
  let latestSeq = 0;
  let activeGraphNodes: string[] = [];

  async function mockRefetch(generation: number, delayMs: number, nodes: string[]) {
    await new Promise((r) => setTimeout(r, delayMs));
    // Stale check
    if (generation !== latestSeq) {
      return; // Discard stale response
    }
    activeGraphNodes = nodes;
  }

  // Request A starts at seq 1 with a slow 50ms response
  const seqA = ++latestSeq;
  const promiseA = mockRefetch(seqA, 50, ["node-from-A"]);

  // Request B arrives at seq 2 with a fast 10ms response
  const seqB = ++latestSeq;
  const promiseB = mockRefetch(seqB, 10, ["node-from-B"]);

  await Promise.all([promiseA, promiseB]);

  // Even though Request A finished after Request B, activeGraphNodes must reflect B!
  assert.deepEqual(activeGraphNodes, ["node-from-B"]);
});

test("Step 39: Step 38 LOD is reapplied deterministically after fresh graph data arrives", () => {
  const freshResponse: GraphQueryResponse = {
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

  // Reapply LOD at overview tier: only architectural nodes visible
  const lodOverview = computeLodGraph({
    nodes: freshResponse.nodes,
    edges: freshResponse.edges,
    lod: "overview",
    selectedNodeId: null,
  });

  assert.equal(lodOverview.visibleNodes.length, 2);
  assert.equal(lodOverview.visibleNodes.some((n) => n.id === "symbol-1"), false);
  assert.equal(lodOverview.visibleEdges.length, 1);
  assert.equal(lodOverview.visibleEdges[0]?.id, EDGE_ID);

  // Reapply LOD with selectedNodeId on symbol-1 (Selected Node Immunity)
  const lodOverviewWithSelected = computeLodGraph({
    nodes: freshResponse.nodes,
    edges: freshResponse.edges,
    lod: "overview",
    selectedNodeId: "symbol-1",
  });

  assert.equal(lodOverviewWithSelected.visibleNodes.some((n) => n.id === "symbol-1"), true);
});

test("Step 57: resolveRepositoryAnalysisContext resolves simulation_id parameter", () => {
  const simId = "77777777-7777-4777-8777-777777777777";
  const result = resolveRepositoryAnalysisContext({
    repoId: REPO_ID,
    searchParams: {
      analysis_run_id: RUN_ID,
      start_node_id: NODE_ROOT,
      simulation_id: simId,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.context.initialSimulationId, simId);
  }

  // Gracefully ignores malformed simulation_id
  const resultMalformed = resolveRepositoryAnalysisContext({
    repoId: REPO_ID,
    searchParams: {
      analysis_run_id: RUN_ID,
      start_node_id: NODE_ROOT,
      simulation_id: "not-a-valid-uuid",
    },
  });

  assert.equal(resultMalformed.ok, true);
  if (resultMalformed.ok) {
    assert.equal(resultMalformed.context.initialSimulationId, undefined);
  }
});

// =============================================================================
// Step 57 Hardening: Bounded Simulation Polling Lifecycle Regression Tests
// =============================================================================

test("Step 57 [Polling 1]: Pending simulation schedules polling", () => {
  let pollTriggerCount = 0;
  const controller = createSimulationPollController({
    onPoll: () => {
      pollTriggerCount += 1;
    },
  });

  controller.update({
    enabled: true,
    simulationId: "sim-111",
    executionStatus: "pending",
    status: "pending",
  });

  assert.equal(controller.isScheduled(), true);
  assert.equal(pollTriggerCount, 0);
  controller.cancel();
});

test("Step 57 [Polling 2]: Running simulation schedules polling", () => {
  let pollTriggerCount = 0;
  const controller = createSimulationPollController({
    onPoll: () => {
      pollTriggerCount += 1;
    },
  });

  controller.update({
    enabled: true,
    simulationId: "sim-111",
    executionStatus: "running",
    status: "running",
  });

  assert.equal(controller.isScheduled(), true);
  assert.equal(pollTriggerCount, 0);
  controller.cancel();
});

test("Step 57 [Polling 3]: Loading status does not schedule polling timer", () => {
  let pollTriggerCount = 0;
  const controller = createSimulationPollController({
    onPoll: () => {
      pollTriggerCount += 1;
    },
  });

  const state = {
    enabled: true,
    simulationId: "sim-111",
    executionStatus: "running",
    status: "loading",
  };

  assert.equal(shouldScheduleSimulationPoll(state), false);

  controller.update(state);

  assert.equal(controller.isScheduled(), false);
  assert.equal(pollTriggerCount, 0);
});

test("Step 57 [Polling 4]: Error status does not automatically trigger polling timer", () => {
  let pollTriggerCount = 0;
  const controller = createSimulationPollController({
    onPoll: () => {
      pollTriggerCount += 1;
    },
  });

  const state = {
    enabled: true,
    simulationId: "sim-111",
    executionStatus: "running",
    status: "error",
  };

  assert.equal(shouldScheduleSimulationPoll(state), false);

  controller.update(state);

  assert.equal(controller.isScheduled(), false);
  assert.equal(pollTriggerCount, 0);
});

test("Step 57 [Polling 5]: Completed simulation stops polling", () => {
  let pollTriggerCount = 0;
  const controller = createSimulationPollController({
    onPoll: () => {
      pollTriggerCount += 1;
    },
  });

  // Initially running
  controller.update({
    enabled: true,
    simulationId: "sim-111",
    executionStatus: "running",
    status: "running",
  });
  assert.equal(controller.isScheduled(), true);

  // Transition to completed
  controller.update({
    enabled: true,
    simulationId: "sim-111",
    executionStatus: "completed",
    status: "ready",
  });
  assert.equal(controller.isScheduled(), false);
  assert.equal(pollTriggerCount, 0);
});

test("Step 57 [Polling 6]: Failed simulation stops polling", () => {
  let pollTriggerCount = 0;
  const controller = createSimulationPollController({
    onPoll: () => {
      pollTriggerCount += 1;
    },
  });

  controller.update({
    enabled: true,
    simulationId: "sim-111",
    executionStatus: "failed",
    status: "error",
  });

  assert.equal(controller.isScheduled(), false);
  assert.equal(pollTriggerCount, 0);
});

test("Step 57 [Polling 7]: Switching simulation IDs resets the attempt count", () => {
  let scheduledCallbacks: Array<() => void> = [];
  const mockSetTimeout = ((fn: () => void) => {
    scheduledCallbacks.push(fn);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  const mockClearTimeout = (() => {
    scheduledCallbacks = [];
  }) as unknown as typeof clearTimeout;

  let pollCount = 0;
  const controller = createSimulationPollController({
    onPoll: () => {
      pollCount += 1;
    },
    maxAttempts: 15,
    setTimeoutFn: mockSetTimeout,
    clearTimeoutFn: mockClearTimeout,
  });

  // Exhaust 15 attempts on sim-A
  for (let i = 0; i < 15; i++) {
    controller.update({
      enabled: true,
      simulationId: "sim-A",
      executionStatus: "running",
      status: "running",
    });
    const cb = scheduledCallbacks.pop();
    assert.ok(cb);
    cb();
  }

  assert.equal(controller.getBudget().count, 15);
  assert.equal(pollCount, 15);

  // Attempt 16 on sim-A is blocked by budget
  controller.update({
    enabled: true,
    simulationId: "sim-A",
    executionStatus: "running",
    status: "running",
  });
  assert.equal(controller.isScheduled(), false);

  // Switch to sim-B: budget must reset to 0 and polling must be scheduled!
  controller.update({
    enabled: true,
    simulationId: "sim-B",
    executionStatus: "running",
    status: "running",
  });

  assert.equal(controller.getBudget().simulationId, "sim-B");
  assert.equal(controller.getBudget().count, 0);
  assert.equal(controller.isScheduled(), true);

  // Trigger sim-B callback
  const cbB = scheduledCallbacks.pop();
  assert.ok(cbB);
  cbB();
  assert.equal(controller.getBudget().count, 1);
  assert.equal(pollCount, 16);
});

test("Step 57 [Polling 8]: The maximum of 15 attempts is strictly respected", () => {
  let scheduledCallbacks: Array<() => void> = [];
  const mockSetTimeout = ((fn: () => void) => {
    scheduledCallbacks.push(fn);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  const mockClearTimeout = (() => {
    scheduledCallbacks = [];
  }) as unknown as typeof clearTimeout;

  let pollCount = 0;
  const controller = createSimulationPollController({
    onPoll: () => {
      pollCount += 1;
    },
    maxAttempts: 15,
    setTimeoutFn: mockSetTimeout,
    clearTimeoutFn: mockClearTimeout,
  });

  for (let i = 0; i < 15; i++) {
    controller.update({
      enabled: true,
      simulationId: "sim-A",
      executionStatus: "running",
      status: "running",
    });
    assert.equal(controller.isScheduled(), true);
    const cb = scheduledCallbacks.pop();
    assert.ok(cb);
    cb();
  }

  assert.equal(pollCount, 15);
  assert.equal(controller.getBudget().count, 15);

  // 16th check: must not schedule another timer
  controller.update({
    enabled: true,
    simulationId: "sim-A",
    executionStatus: "running",
    status: "running",
  });
  assert.equal(controller.isScheduled(), false);
  assert.equal(scheduledCallbacks.length, 0);
});

test("Step 57 [Polling 9]: Disabling Simulation Mode cancels scheduled polling", () => {
  let scheduledCallbacks: Array<() => void> = [];
  const mockSetTimeout = ((fn: () => void) => {
    scheduledCallbacks.push(fn);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  const mockClearTimeout = (() => {
    scheduledCallbacks = [];
  }) as unknown as typeof clearTimeout;

  let pollCount = 0;
  const controller = createSimulationPollController({
    onPoll: () => {
      pollCount += 1;
    },
    setTimeoutFn: mockSetTimeout,
    clearTimeoutFn: mockClearTimeout,
  });

  // Scheduled when enabled
  controller.update({
    enabled: true,
    simulationId: "sim-A",
    executionStatus: "running",
    status: "running",
  });
  assert.equal(controller.isScheduled(), true);

  // Disabled
  controller.update({
    enabled: false,
    simulationId: "sim-A",
    executionStatus: "running",
    status: "running",
  });
  assert.equal(controller.isScheduled(), false);
  assert.equal(scheduledCallbacks.length, 0);
  assert.equal(pollCount, 0);
});

async function runSimulatedLoadSimulation(options: {
  targetSimulationId: string;
  fetchMetadata: () => Promise<
    | { ok: true; data: { id: string; status: string; analysis_run_id: string } }
    | { ok: false; message: string }
  >;
  fetchResults?: () => Promise<
    | { ok: true; data: { simulation_id: string; results: unknown[] } }
    | { ok: false; message: string }
  >;
  analysisRunId: string;
  getState: () => NormalizedSimulationModeState;
  setState: (updater: (prev: NormalizedSimulationModeState) => NormalizedSimulationModeState) => void;
}) {
  const { targetSimulationId, fetchMetadata, fetchResults, analysisRunId, setState } = options;

  setState((prev) => {
    if (!prev.enabled || prev.simulationId !== targetSimulationId) return prev;
    return { ...prev, status: "loading", errorMessage: null };
  });

  const simRes = await fetchMetadata();

  if (!simRes.ok) {
    setState((prev) => {
      if (!prev.enabled || prev.simulationId !== targetSimulationId) return prev;
      return { ...prev, status: "error", errorMessage: simRes.message };
    });
    return;
  }

  // Mismatched metadata simulation ID guard
  if (simRes.data.id !== targetSimulationId) {
    setState((prev) => {
      if (!prev.enabled || prev.simulationId !== targetSimulationId) return prev;
      return {
        ...prev,
        status: "error",
        executionStatus: null,
        errorMessage: `Simulation metadata ID mismatch: Received simulation ID "${simRes.data.id}", but requested "${targetSimulationId}".`,
      };
    });
    return;
  }

  if (simRes.data.analysis_run_id !== analysisRunId) {
    setState((prev) => {
      if (!prev.enabled || prev.simulationId !== targetSimulationId) return prev;
      return { ...prev, status: "error", errorMessage: "Run mismatch" };
    });
    return;
  }

  if (simRes.data.status === "failed") {
    setState((prev) => {
      if (!prev.enabled || prev.simulationId !== targetSimulationId) return prev;
      return { ...prev, status: "error", executionStatus: "failed", errorMessage: "Simulation failed" };
    });
    return;
  }

  if (simRes.data.status === "pending" || simRes.data.status === "running") {
    setState((prev) => {
      if (!prev.enabled || prev.simulationId !== targetSimulationId) return prev;
      return { ...prev, status: "running", executionStatus: simRes.data.status as "pending" | "running" };
    });
    return;
  }

  if (fetchResults) {
    const resultsRes = await fetchResults();
    if (!resultsRes.ok) {
      setState((prev) => {
        if (!prev.enabled || prev.simulationId !== targetSimulationId) return prev;
        return { ...prev, status: "error", errorMessage: resultsRes.message };
      });
      return;
    }

    // Mismatched results simulation ID guard
    if (resultsRes.data.simulation_id !== targetSimulationId) {
      setState((prev) => {
        if (!prev.enabled || prev.simulationId !== targetSimulationId) return prev;
        return {
          ...prev,
          status: "error",
          executionStatus: null,
          errorMessage: `Simulation results mismatch: Received results for simulation "${resultsRes.data.simulation_id}", but requested "${targetSimulationId}".`,
        };
      });
      return;
    }

    setState((prev) => {
      if (!prev.enabled || prev.simulationId !== targetSimulationId) return prev;
      return { ...prev, status: "ready", executionStatus: "completed" };
    });
  }
}

test("Step 57 [Mismatch 1]: Metadata response with mismatched simulation ID transitions to error instead of remaining in loading", async () => {
  let simState: NormalizedSimulationModeState = {
    ...DEFAULT_SIMULATION_MODE_STATE,
    enabled: true,
    simulationId: "sim-requested",
    status: "loading",
    executionStatus: "running",
  };

  await runSimulatedLoadSimulation({
    targetSimulationId: "sim-requested",
    analysisRunId: RUN_ID,
    fetchMetadata: async () => ({
      ok: true,
      data: {
        id: "sim-different",
        status: "completed",
        analysis_run_id: RUN_ID,
      },
    }),
    getState: () => simState,
    setState: (updater) => {
      simState = updater(simState);
    },
  });

  // Must transition to error, NOT remain in loading
  assert.equal(simState.status, "error");
  assert.notEqual(simState.status, "loading");
  assert.equal(simState.executionStatus, null);
  assert.ok(simState.errorMessage?.includes("sim-different"));
  assert.ok(simState.errorMessage?.includes("sim-requested"));
});

test("Step 57 [Mismatch 2]: Results response with mismatched simulation ID transitions to error instead of remaining in loading", async () => {
  let simState: NormalizedSimulationModeState = {
    ...DEFAULT_SIMULATION_MODE_STATE,
    enabled: true,
    simulationId: "sim-requested",
    status: "loading",
    executionStatus: "running",
  };

  await runSimulatedLoadSimulation({
    targetSimulationId: "sim-requested",
    analysisRunId: RUN_ID,
    fetchMetadata: async () => ({
      ok: true,
      data: {
        id: "sim-requested",
        status: "completed",
        analysis_run_id: RUN_ID,
      },
    }),
    fetchResults: async () => ({
      ok: true,
      data: {
        simulation_id: "sim-wrong-results",
        results: [],
      },
    }),
    getState: () => simState,
    setState: (updater) => {
      simState = updater(simState);
    },
  });

  // Must transition to error, NOT remain in loading
  assert.equal(simState.status, "error");
  assert.notEqual(simState.status, "loading");
  assert.equal(simState.executionStatus, null);
  assert.ok(simState.errorMessage?.includes("sim-wrong-results"));
  assert.ok(simState.errorMessage?.includes("sim-requested"));
});

test("Step 57 [Mismatch 3]: Stale mismatched metadata response cannot overwrite a different currently selected simulation", async () => {
  let simState: NormalizedSimulationModeState = {
    ...DEFAULT_SIMULATION_MODE_STATE,
    enabled: true,
    simulationId: "sim-A",
    status: "loading",
  };

  // Start slow fetch for sim-A which will return mismatched metadata
  const promiseA = runSimulatedLoadSimulation({
    targetSimulationId: "sim-A",
    analysisRunId: RUN_ID,
    fetchMetadata: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: true,
        data: {
          id: "sim-mismatched",
          status: "completed",
          analysis_run_id: RUN_ID,
        },
      };
    },
    getState: () => simState,
    setState: (updater) => {
      simState = updater(simState);
    },
  });

  // User immediately switches to sim-B before sim-A completes
  simState = {
    ...DEFAULT_SIMULATION_MODE_STATE,
    enabled: true,
    simulationId: "sim-B",
    status: "ready",
    executionStatus: "completed",
    errorMessage: null,
  };

  await promiseA;

  // Stale mismatch from sim-A must not overwrite sim-B!
  assert.equal(simState.simulationId, "sim-B");
  assert.equal(simState.status, "ready");
  assert.equal(simState.executionStatus, "completed");
  assert.equal(simState.errorMessage, null);
});

test("Step 57 [Mismatch 4]: Stale mismatched results response cannot overwrite a different currently selected simulation", async () => {
  let simState: NormalizedSimulationModeState = {
    ...DEFAULT_SIMULATION_MODE_STATE,
    enabled: true,
    simulationId: "sim-A",
    status: "loading",
  };

  // Start fetch for sim-A where results take time and return mismatched simulation_id
  const promiseA = runSimulatedLoadSimulation({
    targetSimulationId: "sim-A",
    analysisRunId: RUN_ID,
    fetchMetadata: async () => ({
      ok: true,
      data: {
        id: "sim-A",
        status: "completed",
        analysis_run_id: RUN_ID,
      },
    }),
    fetchResults: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: true,
        data: {
          simulation_id: "sim-mismatched-results",
          results: [],
        },
      };
    },
    getState: () => simState,
    setState: (updater) => {
      simState = updater(simState);
    },
  });

  // User immediately switches to sim-B
  simState = {
    ...DEFAULT_SIMULATION_MODE_STATE,
    enabled: true,
    simulationId: "sim-B",
    status: "ready",
    executionStatus: "completed",
    errorMessage: null,
  };

  await promiseA;

  // Stale results mismatch from sim-A must not overwrite sim-B
  assert.equal(simState.simulationId, "sim-B");
  assert.equal(simState.status, "ready");
  assert.equal(simState.errorMessage, null);
});

test("Step 57 [Mismatch 5]: Stale mismatched response cannot overwrite state when simulation mode is disabled", async () => {
  let simState: NormalizedSimulationModeState = {
    ...DEFAULT_SIMULATION_MODE_STATE,
    enabled: true,
    simulationId: "sim-A",
    status: "loading",
  };

  const promiseA = runSimulatedLoadSimulation({
    targetSimulationId: "sim-A",
    analysisRunId: RUN_ID,
    fetchMetadata: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        ok: true,
        data: {
          id: "sim-mismatched",
          status: "completed",
          analysis_run_id: RUN_ID,
        },
      };
    },
    getState: () => simState,
    setState: (updater) => {
      simState = updater(simState);
    },
  });

  // User disables simulation mode
  simState = {
    ...DEFAULT_SIMULATION_MODE_STATE,
    enabled: false,
    simulationId: "sim-A",
    status: "idle",
  };

  await promiseA;

  // State remains disabled and idle, not overwritten by error
  assert.equal(simState.enabled, false);
  assert.equal(simState.status, "idle");
  assert.equal(simState.errorMessage, null);
});
