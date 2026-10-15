import { test } from "vitest";
import assert from "node:assert/strict";
import type { CanvasInputEdge, CanvasInputNode } from "./graph-mapping.ts";
import {
  computeLodGraph,
  getLodLevelFromZoom,
  type LodLevel,
} from "./graph-lod.ts";

const SAMPLE_NODES: CanvasInputNode[] = [
  {
    id: "app-1",
    canonicalId: "app:fluxora",
    nodeType: "application",
    name: "fluxora",
    confidence: 1.0,
    depth: 0,
  },
  {
    id: "svc-1",
    canonicalId: "svc:api",
    nodeType: "service",
    name: "api-service",
    confidence: 1.0,
    depth: 1,
  },
  {
    id: "db-1",
    canonicalId: "db:postgres:main",
    nodeType: "database",
    name: "postgres",
    confidence: 1.0,
    depth: 1,
  },
  {
    id: "pkg-1",
    canonicalId: "pkg:shared-types",
    nodeType: "package",
    name: "shared-types",
    confidence: 1.0,
    depth: 1,
  },
  {
    id: "mod-1",
    canonicalId: "mod:src/server.ts",
    nodeType: "module",
    name: "server.ts",
    path: "src/server.ts",
    confidence: 1.0,
    depth: 2,
  },
  {
    id: "api-1",
    canonicalId: "api:GET:/health",
    nodeType: "api",
    name: "GET /health",
    confidence: 0.95,
    depth: 2,
  },
  {
    id: "evt-1",
    canonicalId: "evt:repo.indexed",
    nodeType: "event",
    name: "repo.indexed",
    confidence: 0.9,
    depth: 2,
  },
  {
    id: "sym-1",
    canonicalId: "sym:src/server.ts#start:20",
    nodeType: "symbol",
    name: "start",
    path: "src/server.ts",
    confidence: 1.0,
    depth: 3,
  },
  {
    id: "sym-2",
    canonicalId: "sym:src/server.ts#stop:45",
    nodeType: "symbol",
    name: "stop",
    path: "src/server.ts",
    confidence: 1.0,
    depth: 3,
  },
];

const SAMPLE_EDGES: CanvasInputEdge[] = [
  {
    id: "edge-app-svc",
    sourceNodeId: "app-1",
    targetNodeId: "svc-1",
    edgeType: "EXPOSES_ROUTE",
  },
  {
    id: "edge-svc-mod",
    sourceNodeId: "svc-1",
    targetNodeId: "mod-1",
    edgeType: "IMPORTS",
  },
  {
    id: "edge-mod-api",
    sourceNodeId: "mod-1",
    targetNodeId: "api-1",
    edgeType: "EXPOSES_ROUTE",
  },
  {
    id: "edge-mod-sym1",
    sourceNodeId: "mod-1",
    targetNodeId: "sym-1",
    edgeType: "RESOLVES_TO",
  },
  {
    id: "edge-sym1-sym2",
    sourceNodeId: "sym-1",
    targetNodeId: "sym-2",
    edgeType: "CALLS",
  },
  {
    id: "edge-svc-db",
    sourceNodeId: "svc-1",
    targetNodeId: "db-1",
    edgeType: "QUERIES_DB",
  },
];

test("1. getLodLevelFromZoom maps zoom factors deterministically to LOD tiers", () => {
  // Low zoom (overview)
  assert.equal(getLodLevelFromZoom(0.2), "overview");
  assert.equal(getLodLevelFromZoom(0.4), "overview");
  assert.equal(getLodLevelFromZoom(0.59), "overview");

  // Medium zoom (module)
  assert.equal(getLodLevelFromZoom(0.6), "module");
  assert.equal(getLodLevelFromZoom(0.8), "module");
  assert.equal(getLodLevelFromZoom(1.0), "module");
  assert.equal(getLodLevelFromZoom(1.09), "module");

  // High zoom (detail)
  assert.equal(getLodLevelFromZoom(1.1), "detail");
  assert.equal(getLodLevelFromZoom(1.5), "detail");
  assert.equal(getLodLevelFromZoom(2.0), "detail");
  assert.equal(getLodLevelFromZoom(2.5), "detail");

  // Robustness against NaN / infinite values
  assert.equal(getLodLevelFromZoom(Number.NaN), "overview");
  assert.equal(getLodLevelFromZoom(-1), "overview");
});

test("2. Low zoom (overview) reduces visual density and prioritizes high-level architectural nodes", () => {
  const result = computeLodGraph({
    nodes: SAMPLE_NODES,
    edges: SAMPLE_EDGES,
    lod: "overview",
  });

  // Overview includes application, service, database, package
  const visibleIds = result.visibleNodes.map((n) => n.id);
  assert.deepEqual(visibleIds, ["app-1", "svc-1", "db-1", "pkg-1"]);
  assert.equal(result.hiddenNodeCount, 5); // mod-1, api-1, evt-1, sym-1, sym-2 hidden

  // Edges: only edge-app-svc and edge-svc-db connect nodes that are both visible
  const visibleEdgeIds = result.visibleEdges.map((e) => e.id);
  assert.deepEqual(visibleEdgeIds, ["edge-app-svc", "edge-svc-db"]);
  assert.equal(result.hiddenEdgeCount, 4);
});

test("3. Medium zoom (module) reveals modules, APIs, and events while hiding symbols", () => {
  const result = computeLodGraph({
    nodes: SAMPLE_NODES,
    edges: SAMPLE_EDGES,
    lod: "module",
  });

  const visibleIds = result.visibleNodes.map((n) => n.id);
  assert.deepEqual(visibleIds, [
    "app-1",
    "svc-1",
    "db-1",
    "pkg-1",
    "mod-1",
    "api-1",
    "evt-1",
  ]);
  assert.equal(result.hiddenNodeCount, 2); // sym-1 and sym-2 are hidden

  // Edges connecting visible nodes are preserved
  const visibleEdgeIds = result.visibleEdges.map((e) => e.id);
  assert.ok(visibleEdgeIds.includes("edge-app-svc"));
  assert.ok(visibleEdgeIds.includes("edge-svc-mod"));
  assert.ok(visibleEdgeIds.includes("edge-mod-api"));
  assert.ok(visibleEdgeIds.includes("edge-svc-db"));
  // Symbol edges are omitted
  assert.ok(!visibleEdgeIds.includes("edge-mod-sym1"));
  assert.ok(!visibleEdgeIds.includes("edge-sym1-sym2"));
});

test("4. High zoom (detail) reveals complete graph with symbols", () => {
  const result = computeLodGraph({
    nodes: SAMPLE_NODES,
    edges: SAMPLE_EDGES,
    lod: "detail",
  });

  assert.equal(result.visibleNodes.length, SAMPLE_NODES.length);
  assert.equal(result.visibleEdges.length, SAMPLE_EDGES.length);
  assert.equal(result.hiddenNodeCount, 0);
  assert.equal(result.hiddenEdgeCount, 0);
});

test("5. Identical input yields identical, deterministic results across repeated runs", () => {
  const run1 = computeLodGraph({
    nodes: SAMPLE_NODES,
    edges: SAMPLE_EDGES,
    lod: "module",
  });

  const run2 = computeLodGraph({
    nodes: SAMPLE_NODES,
    edges: SAMPLE_EDGES,
    lod: "module",
  });

  assert.deepEqual(run1, run2);
});

test("6. No rendered edge references a hidden or non-rendered endpoint", () => {
  const lodTiers: LodLevel[] = ["overview", "module", "detail"];

  for (const lod of lodTiers) {
    const result = computeLodGraph({
      nodes: SAMPLE_NODES,
      edges: SAMPLE_EDGES,
      lod,
    });

    const renderedNodeIds = new Set(result.visibleNodes.map((n) => n.id));

    for (const edge of result.visibleEdges) {
      const sourceId = edge.sourceNodeId ?? edge.source ?? "";
      const targetId = edge.targetNodeId ?? edge.target ?? "";

      assert.ok(
        renderedNodeIds.has(sourceId),
        `Edge ${edge.id} source ${sourceId} is not in rendered nodes for LOD ${lod}`,
      );
      assert.ok(
        renderedNodeIds.has(targetId),
        `Edge ${edge.id} target ${targetId} is not in rendered nodes for LOD ${lod}`,
      );
    }
  }
});

test("7. Selected real node is never hidden or converted into a synthetic cluster", () => {
  // Even at "overview" LOD where symbols are normally hidden, a selected symbol MUST remain visible
  const result = computeLodGraph({
    nodes: SAMPLE_NODES,
    edges: SAMPLE_EDGES,
    lod: "overview",
    selectedNodeId: "sym-1",
  });

  const visibleIds = result.visibleNodes.map((n) => n.id);
  assert.ok(visibleIds.includes("sym-1"), "Selected symbol node must remain visible at overview LOD");

  const symNode = result.visibleNodes.find((n) => n.id === "sym-1");
  assert.ok(symNode);
  assert.equal(symNode.id, "sym-1");
  assert.equal(symNode.nodeType, "symbol");
  assert.equal(symNode.name, "start");
  // Never converted to synthetic cluster
  assert.equal("isCluster" in symNode, false);
});

test("8. Filtered graph remains filtered under LOD", () => {
  // Simulate Step 37 filtering: only services and modules were returned/selected
  const filteredNodes: CanvasInputNode[] = [
    {
      id: "svc-1",
      canonicalId: "svc:api",
      nodeType: "service",
      name: "api-service",
      confidence: 1.0,
      depth: 1,
    },
    {
      id: "mod-1",
      canonicalId: "mod:src/server.ts",
      nodeType: "module",
      name: "server.ts",
      confidence: 1.0,
      depth: 2,
    },
  ];

  const filteredEdges: CanvasInputEdge[] = [
    {
      id: "edge-svc-mod",
      sourceNodeId: "svc-1",
      targetNodeId: "mod-1",
      edgeType: "IMPORTS",
    },
  ];

  // At overview LOD, module is hidden, so only service remains
  const overviewResult = computeLodGraph({
    nodes: filteredNodes,
    edges: filteredEdges,
    lod: "overview",
  });

  assert.equal(overviewResult.visibleNodes.length, 1);
  assert.equal(overviewResult.visibleNodes[0]?.id, "svc-1");
  // Since mod-1 is hidden, edge-svc-mod has a hidden target and must be excluded
  assert.equal(overviewResult.visibleEdges.length, 0);

  // At module LOD, both are visible
  const moduleResult = computeLodGraph({
    nodes: filteredNodes,
    edges: filteredEdges,
    lod: "module",
  });

  assert.equal(moduleResult.visibleNodes.length, 2);
  assert.equal(moduleResult.visibleEdges.length, 1);
});
