import assert from "node:assert/strict";
import test from "node:test";

import {
  GRAPH_QUERY_PATH,
  type GraphTraversalResult,
} from "@fluxora/shared-types";

import {
  isGraphQueryPath,
  mapDirectionToInternal,
  parseGraphQueryBody,
  toGraphTraversalOptions,
  GraphQueryValidationError,
} from "./graph-query-request.ts";
import { formatGraphQueryResponse } from "./graph-query-response.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NODE_1 = "22222222-2222-4222-8222-222222222222";
const NODE_2 = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";

test("recognizes the graph query endpoint path", () => {
  assert.equal(GRAPH_QUERY_PATH, "/api/v1/graph/query");
  assert.equal(isGraphQueryPath(GRAPH_QUERY_PATH), true);
  assert.equal(isGraphQueryPath("/api/v1/graph"), false);
  assert.equal(isGraphQueryPath("/api/v1/graph/traversal"), false);
});

test("parses valid downstream graph query request", () => {
  const parsed = parseGraphQueryBody({
    analysis_run_id: RUN_ID,
    start_node_id: NODE_1,
    direction: "downstream",
    max_depth: 3,
    edge_types: ["CALLS", "EMITS_EVENT"],
    min_confidence: 0.6,
  });

  assert.equal(parsed.analysisRunId, RUN_ID);
  assert.equal(parsed.startNodeId, NODE_1);
  assert.equal(parsed.publicDirection, "downstream");
  assert.equal(parsed.internalDirection, "outgoing");
  assert.equal(parsed.maxDepth, 3);
  assert.deepEqual(parsed.edgeTypes, ["CALLS", "EMITS_EVENT"]);
  assert.equal(parsed.minConfidence, 0.6);
  assert.equal(parsed.includeEvidence, true);
});

test("parses valid upstream and both direction mappings", () => {
  const upstream = parseGraphQueryBody({
    analysis_run_id: RUN_ID,
    start_node_id: NODE_1,
    direction: "upstream",
  });
  assert.equal(upstream.publicDirection, "upstream");
  assert.equal(upstream.internalDirection, "incoming");
  assert.equal(mapDirectionToInternal("upstream"), "incoming");

  const both = parseGraphQueryBody({
    analysis_run_id: RUN_ID,
    start_node_id: NODE_1,
    direction: "both",
  });
  assert.equal(both.publicDirection, "both");
  assert.equal(both.internalDirection, "both");
  assert.equal(mapDirectionToInternal("both"), "both");
});

test("defaults direction to downstream and max_depth to default when omitted", () => {
  const parsed = parseGraphQueryBody({
    analysis_run_id: RUN_ID,
    start_node_id: NODE_1,
  });

  assert.equal(parsed.publicDirection, "downstream");
  assert.equal(parsed.internalDirection, "outgoing");
  assert.equal(parsed.maxDepth, 5);
  assert.equal(parsed.includeEvidence, true);
});

test("rejects client-supplied organization_id to enforce tenant isolation", () => {
  assert.throws(
    () =>
      parseGraphQueryBody({
        organization_id: ORG_ID,
        analysis_run_id: RUN_ID,
        start_node_id: NODE_1,
      }),
    (err: unknown) =>
      err instanceof GraphQueryValidationError &&
      err.message.includes("Tenant organization cannot be specified"),
  );

  assert.throws(
    () =>
      parseGraphQueryBody({
        organizationId: ORG_ID,
        analysis_run_id: RUN_ID,
        start_node_id: NODE_1,
      }),
    (err: unknown) =>
      err instanceof GraphQueryValidationError &&
      err.message.includes("Tenant organization cannot be specified"),
  );
});

test("rejects malformed or non-UUID ids", () => {
  assert.throws(
    () =>
      parseGraphQueryBody({
        analysis_run_id: "not-a-uuid",
        start_node_id: NODE_1,
      }),
    GraphQueryValidationError,
  );

  assert.throws(
    () =>
      parseGraphQueryBody({
        analysis_run_id: RUN_ID,
        start_node_id: "not-a-uuid",
      }),
    GraphQueryValidationError,
  );
});

test("rejects invalid direction values", () => {
  assert.throws(
    () =>
      parseGraphQueryBody({
        analysis_run_id: RUN_ID,
        start_node_id: NODE_1,
        direction: "sideways",
      }),
    (err: unknown) =>
      err instanceof GraphQueryValidationError &&
      err.code === "invalid_traversal_options",
  );
});

test("rejects invalid max_depth (negative, float, above hard cap 20)", () => {
  assert.throws(
    () =>
      parseGraphQueryBody({
        analysis_run_id: RUN_ID,
        start_node_id: NODE_1,
        max_depth: -1,
      }),
    (err: unknown) =>
      err instanceof GraphQueryValidationError &&
      err.code === "invalid_traversal_options",
  );

  assert.throws(
    () =>
      parseGraphQueryBody({
        analysis_run_id: RUN_ID,
        start_node_id: NODE_1,
        max_depth: 25,
      }),
    (err: unknown) =>
      err instanceof GraphQueryValidationError &&
      err.code === "invalid_traversal_options",
  );

  assert.throws(
    () =>
      parseGraphQueryBody({
        analysis_run_id: RUN_ID,
        start_node_id: NODE_1,
        max_depth: 3.5,
      }),
    (err: unknown) =>
      err instanceof GraphQueryValidationError &&
      err.code === "invalid_traversal_options",
  );
});

test("rejects invalid min_confidence (out of [0, 1] range)", () => {
  assert.throws(
    () =>
      parseGraphQueryBody({
        analysis_run_id: RUN_ID,
        start_node_id: NODE_1,
        min_confidence: -0.1,
      }),
    GraphQueryValidationError,
  );

  assert.throws(
    () =>
      parseGraphQueryBody({
        analysis_run_id: RUN_ID,
        start_node_id: NODE_1,
        min_confidence: 1.5,
      }),
    GraphQueryValidationError,
  );
});

test("rejects invalid edge_types or node_types", () => {
  assert.throws(
    () =>
      parseGraphQueryBody({
        analysis_run_id: RUN_ID,
        start_node_id: NODE_1,
        edge_types: ["UNKNOWN_EDGE"],
      }),
    GraphQueryValidationError,
  );

  assert.throws(
    () =>
      parseGraphQueryBody({
        analysis_run_id: RUN_ID,
        start_node_id: NODE_1,
        node_types: ["unknown_node"],
      }),
    GraphQueryValidationError,
  );
});

test("toGraphTraversalOptions constructs correct repository traversal input", () => {
  const parsed = parseGraphQueryBody({
    analysis_run_id: RUN_ID,
    start_node_id: NODE_1,
    direction: "downstream",
    max_depth: 2,
    edge_types: ["CALLS"],
  });

  const options = toGraphTraversalOptions(ORG_ID, parsed);
  assert.equal(options.organizationId, ORG_ID);
  assert.equal(options.analysisRunId, RUN_ID);
  assert.equal(options.startNodeId, NODE_1);
  assert.equal(options.maxDepth, 2);
  assert.equal(options.direction, "outgoing");
  assert.deepEqual(options.edgeTypes, ["CALLS"]);
});

test("formatGraphQueryResponse formats nodes, edges, and evidence safely", () => {
  const mockResult: GraphTraversalResult = {
    startNode: {
      id: NODE_1,
      analysisRunId: RUN_ID,
      canonicalId: "mod:n1",
      nodeType: "module",
      name: "n1",
      metadata: { private_key: "never_leak" },
      confidence: 1.0,
      createdAt: new Date(),
    },
    nodes: [
      {
        node: {
          id: NODE_1,
          analysisRunId: RUN_ID,
          canonicalId: "mod:n1",
          nodeType: "module",
          name: "n1",
          metadata: { size: 100 },
          confidence: 1.0,
          createdAt: new Date(),
        },
        depth: 0,
        path: [NODE_1],
      },
      {
        node: {
          id: NODE_2,
          analysisRunId: RUN_ID,
          canonicalId: "mod:n2",
          nodeType: "service",
          name: "n2",
          metadata: {},
          confidence: 0.5,
          createdAt: new Date(),
        },
        depth: 1,
        path: [NODE_1, NODE_2],
      },
    ],
    edges: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        analysisRunId: RUN_ID,
        sourceNodeId: NODE_1,
        targetNodeId: NODE_2,
        edgeType: "CALLS",
        confidence: 0.8,
        provenance: "static-analysis",
        metadata: {},
        createdAt: new Date(),
      },
    ],
    maxDepthReached: 1,
    evidence: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        analysisRunId: RUN_ID,
        subjectType: "graph_edge",
        subjectId: "55555555-5555-4555-8555-555555555555",
        filePath: "src/n1.ts",
        relationshipDescription: "calls n2",
        confidence: 0.8,
        metadata: {},
        createdAt: new Date(),
      },
    ],
  };

  const formatted = formatGraphQueryResponse(mockResult);
  assert.equal(formatted.nodes.length, 2);
  assert.equal(formatted.edges.length, 1);
  assert.equal(formatted.nodes[0]?.id, NODE_1);
  assert.equal(formatted.nodes[0]?.depth, 0);
  assert.equal(formatted.edges[0]?.source, NODE_1);
  assert.equal(formatted.edges[0]?.target, NODE_2);
  assert.equal(formatted.edges[0]?.evidence_id, "66666666-6666-4666-8666-666666666666");
  assert.equal(formatted.truncated, false);
  assert.ok(formatted.evidence);
  assert.equal(formatted.evidence.length, 1);
});

test("formatGraphQueryResponse applies min_confidence filtering deterministically", () => {
  const mockResult: GraphTraversalResult = {
    startNode: {
      id: NODE_1,
      analysisRunId: RUN_ID,
      canonicalId: "mod:n1",
      nodeType: "module",
      name: "n1",
      metadata: {},
      confidence: 1.0,
      createdAt: new Date(),
    },
    nodes: [
      {
        node: {
          id: NODE_1,
          analysisRunId: RUN_ID,
          canonicalId: "mod:n1",
          nodeType: "module",
          name: "n1",
          metadata: {},
          confidence: 1.0,
          createdAt: new Date(),
        },
        depth: 0,
        path: [NODE_1],
      },
      {
        node: {
          id: NODE_2,
          analysisRunId: RUN_ID,
          canonicalId: "mod:n2",
          nodeType: "service",
          name: "n2",
          metadata: {},
          confidence: 0.5, // Below 0.7
          createdAt: new Date(),
        },
        depth: 1,
        path: [NODE_1, NODE_2],
      },
    ],
    edges: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        analysisRunId: RUN_ID,
        sourceNodeId: NODE_1,
        targetNodeId: NODE_2,
        edgeType: "CALLS",
        confidence: 0.8,
        provenance: "static-analysis",
        metadata: {},
        createdAt: new Date(),
      },
    ],
    maxDepthReached: 1,
    evidence: [],
  };

  // With minConfidence = 0.7: node 2 is pruned (< 0.7); edge is pruned because target node 2 is gone
  const formatted = formatGraphQueryResponse(mockResult, { minConfidence: 0.7 });
  assert.equal(formatted.nodes.length, 1);
  assert.equal(formatted.nodes[0]?.id, NODE_1);
  assert.equal(formatted.edges.length, 0);
});
