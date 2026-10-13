import assert from "node:assert/strict";
import test from "node:test";
import { GRAPH_QUERY_PATH, type GraphQueryRequest, type GraphQueryResponse } from "@fluxora/shared-types";
import {
  fetchGraphQuery,
  resolveRepositoryAnalysisContext,
  transformGraphResponseToFlow,
} from "./explorer-data.ts";

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
