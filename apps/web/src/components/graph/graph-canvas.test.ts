import { test } from "vitest";
import assert from "node:assert/strict";
import type { GraphNodeType, GraphQueryResponseNode } from "@fluxora/shared-types";
import { getNodeVisualConfig } from "./node-styles.ts";
import {
  mapDomainGraphToFlow,
  type CanvasInputEdge,
  type CanvasInputNode,
} from "./graph-mapping.ts";

test("Node visual styles provide distinct presentation for all shared domain node types", () => {
  const expectedTypes: GraphNodeType[] = [
    "application",
    "service",
    "package",
    "module",
    "symbol",
    "api",
    "event",
    "database",
  ];

  const seenBorderColors = new Set<string>();

  for (const type of expectedTypes) {
    const config = getNodeVisualConfig(type);
    assert.ok(config, `Expected config for node type ${type}`);
    assert.ok(config.label.length > 0);
    assert.ok(config.borderColor.startsWith("#"));
    assert.ok(config.backgroundColor.startsWith("#"));
    assert.ok(config.badgeBg.startsWith("#"));
    assert.ok(config.badgeColor.startsWith("#"));

    // Distinct border color for each node type
    assert.ok(
      !seenBorderColors.has(config.borderColor),
      `Duplicate border color for ${type}: ${config.borderColor}`,
    );
    seenBorderColors.add(config.borderColor);
  }

  // Graceful fallback for unknown node types
  const unknownConfig = getNodeVisualConfig("custom-microservice");
  assert.equal(unknownConfig.label, "Custom-microservice");
  assert.equal(unknownConfig.category, "Component");
});

test("mapDomainGraphToFlow preserves domain node and edge IDs deterministically", () => {
  const inputNodes: CanvasInputNode[] = [
    {
      id: "node-1",
      canonicalId: "sym:src/index.ts#main:10",
      nodeType: "symbol",
      name: "main",
      path: "src/index.ts",
      confidence: 1.0,
      depth: 0,
    },
    {
      id: "node-2",
      canonicalId: "mod:src/utils.ts",
      nodeType: "module",
      name: "utils.ts",
      path: "src/utils.ts",
      confidence: 0.95,
      depth: 1,
    },
  ];

  const inputEdges: CanvasInputEdge[] = [
    {
      id: "edge-1",
      sourceNodeId: "node-1",
      targetNodeId: "node-2",
      edgeType: "IMPORTS",
      confidence: 1.0,
      provenance: "static-analysis",
    },
  ];

  const { nodes, edges } = mapDomainGraphToFlow(inputNodes, inputEdges);

  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);

  // Assert exact preservation of IDs
  assert.equal(nodes[0]?.id, "node-1");
  assert.equal(nodes[0]?.data.id, "node-1");
  assert.equal(nodes[0]?.data.canonicalId, "sym:src/index.ts#main:10");
  assert.equal(nodes[0]?.data.nodeType, "symbol");
  assert.equal(nodes[0]?.data.name, "main");
  assert.equal(nodes[0]?.data.path, "src/index.ts");
  assert.equal(nodes[0]?.data.confidence, 1.0);
  assert.equal(nodes[0]?.data.depth, 0);

  assert.equal(nodes[1]?.id, "node-2");
  assert.equal(nodes[1]?.data.id, "node-2");
  assert.equal(nodes[1]?.data.canonicalId, "mod:src/utils.ts");
  assert.equal(nodes[1]?.data.nodeType, "module");
  assert.equal(nodes[1]?.data.name, "utils.ts");
  assert.equal(nodes[1]?.data.path, "src/utils.ts");
  assert.equal(nodes[1]?.data.confidence, 0.95);
  assert.equal(nodes[1]?.data.depth, 1);

  // Assert exact preservation of edge relationship
  assert.equal(edges[0]?.id, "edge-1");
  assert.equal(edges[0]?.source, "node-1");
  assert.equal(edges[0]?.target, "node-2");
  assert.equal(edges[0]?.label, "IMPORTS");
});

test("mapDomainGraphToFlow supports API GraphQueryResponse convention (source/target and canonical_id)", () => {
  const apiNodes: GraphQueryResponseNode[] = [
    {
      id: "api-node-1",
      canonical_id: "route:src/server.ts#getUser:GET:/users:42",
      type: "api",
      name: "GET /users",
      path: "src/server.ts",
      confidence: 1.0,
      depth: 0,
      metadata: { method: "GET" },
    },
    {
      id: "api-node-2",
      canonical_id: "sym:src/db.ts#getUserRecord:12",
      type: "symbol",
      name: "getUserRecord",
      path: "src/db.ts",
      confidence: 0.88,
      depth: 1,
    },
  ];

  const apiEdges = [
    {
      id: "api-edge-1",
      source: "api-node-1",
      target: "api-node-2",
      type: "CALLS",
      confidence: 0.88,
      provenance: "static-analysis",
    },
  ];

  const { nodes, edges } = mapDomainGraphToFlow(apiNodes, apiEdges);

  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);

  assert.equal(nodes[0]?.id, "api-node-1");
  assert.equal(nodes[0]?.data.canonicalId, "route:src/server.ts#getUser:GET:/users:42");
  assert.equal(nodes[0]?.data.nodeType, "api");
  assert.equal(nodes[0]?.data.name, "GET /users");

  assert.equal(edges[0]?.id, "api-edge-1");
  assert.equal(edges[0]?.source, "api-node-1");
  assert.equal(edges[0]?.target, "api-node-2");
  assert.equal(edges[0]?.label, "CALLS");
});

test("mapDomainGraphToFlow handles empty graph without crashing", () => {
  const result = mapDomainGraphToFlow([], []);
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.edges, []);
});

test("mapDomainGraphToFlow renders multiple node types without duplication or mutation", () => {
  const inputNodes: CanvasInputNode[] = [
    { id: "app-1", name: "Fluxora API", nodeType: "application", confidence: 1.0 },
    { id: "srv-1", name: "Worker Service", nodeType: "service", confidence: 1.0 },
    { id: "pkg-1", name: "@fluxora/shared-types", nodeType: "package", confidence: 1.0 },
    { id: "mod-1", name: "graph.ts", nodeType: "module", path: "src/graph.ts", confidence: 1.0 },
    { id: "sym-1", name: "traverseGraph", nodeType: "symbol", path: "src/traversal.ts", confidence: 1.0 },
    { id: "api-1", name: "POST /graph/query", nodeType: "api", path: "src/api.ts", confidence: 1.0 },
    { id: "evt-1", name: "graph.updated", nodeType: "event", confidence: 1.0 },
    { id: "db-1", name: "graph_nodes", nodeType: "database", confidence: 1.0 },
  ];

  const inputEdges: CanvasInputEdge[] = [
    { id: "e1", source: "app-1", target: "srv-1", edgeType: "CALLS" },
    { id: "e2", source: "srv-1", target: "pkg-1", edgeType: "IMPORTS" },
    { id: "e3", source: "pkg-1", target: "mod-1", edgeType: "IMPORTS" },
    { id: "e4", source: "mod-1", target: "sym-1", edgeType: "RESOLVES_TO" },
    { id: "e5", source: "app-1", target: "api-1", edgeType: "EXPOSES_ROUTE" },
    { id: "e6", source: "srv-1", target: "evt-1", edgeType: "EMITS_EVENT" },
    { id: "e7", source: "srv-1", target: "db-1", edgeType: "WRITES" },
  ];

  // Freeze input objects to guarantee immutability
  Object.freeze(inputNodes);
  Object.freeze(inputEdges);

  const { nodes, edges } = mapDomainGraphToFlow(inputNodes, inputEdges);

  assert.equal(nodes.length, 8);
  assert.equal(edges.length, 7);

  // Check no duplicate IDs exist
  const nodeIds = new Set(nodes.map((n) => n.id));
  assert.equal(nodeIds.size, 8);
  const edgeIds = new Set(edges.map((e) => e.id));
  assert.equal(edgeIds.size, 7);
});

test("mapDomainGraphToFlow filters out dangling edges pointing to non-existent nodes", () => {
  const inputNodes: CanvasInputNode[] = [
    { id: "node-1", name: "Node 1", nodeType: "module", confidence: 1.0 },
  ];

  const inputEdges: CanvasInputEdge[] = [
    { id: "edge-valid", source: "node-1", target: "node-1", edgeType: "SELF" },
    { id: "edge-dangling-target", source: "node-1", target: "ghost-node", edgeType: "CALLS" },
    { id: "edge-dangling-source", source: "phantom-node", target: "node-1", edgeType: "CALLS" },
  ];

  const { edges } = mapDomainGraphToFlow(inputNodes, inputEdges);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.id, "edge-valid");
});

test("mapDomainGraphToFlow generates deterministic layout coordinates without random numbers", () => {
  const inputNodes: CanvasInputNode[] = [
    { id: "n1", name: "Node 1", nodeType: "module", confidence: 1.0 },
    { id: "n2", name: "Node 2", nodeType: "module", confidence: 1.0 },
    { id: "n3", name: "Node 3", nodeType: "module", confidence: 1.0 },
    { id: "n4", name: "Node 4", nodeType: "module", confidence: 1.0 },
    { id: "n5", name: "Node 5", nodeType: "module", confidence: 1.0 },
  ];

  const run1 = mapDomainGraphToFlow(inputNodes, []);
  const run2 = mapDomainGraphToFlow(inputNodes, []);

  assert.deepEqual(run1.nodes.map((n) => n.position), run2.nodes.map((n) => n.position));
  assert.deepEqual(run1.nodes[0]?.position, { x: 50, y: 50 });
  assert.deepEqual(run1.nodes[4]?.position, { x: 50, y: 190 }); // wrapped to row 2
});

test("Rendering does not perform any network calls", () => {
  // Capture any attempt to invoke global fetch
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalled = true;
    return Promise.reject(new Error("Network call forbidden in graph rendering"));
  };

  try {
    const inputNodes: CanvasInputNode[] = [
      { id: "a", name: "A", nodeType: "module", confidence: 1.0 },
      { id: "b", name: "B", nodeType: "module", confidence: 1.0 },
    ];
    const inputEdges: CanvasInputEdge[] = [
      { id: "ab", source: "a", target: "b", edgeType: "IMPORTS" },
    ];

    const result = mapDomainGraphToFlow(inputNodes, inputEdges);
    assert.equal(result.nodes.length, 2);
    assert.equal(fetchCalled, false, "Mapping must never call fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
