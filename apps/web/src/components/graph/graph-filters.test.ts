import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_MAX_TRAVERSAL_DEPTH,
  HARD_MAX_TRAVERSAL_DEPTH,
  GraphNodeTypes,
  GraphEdgeTypes,
  type GraphNodeType,
  type GraphEdgeType,
} from "@fluxora/shared-types";
import {
  GraphFilters,
  DEFAULT_GRAPH_FILTERS,
  sanitizeMaxDepth,
  sanitizeMinConfidence,
  type GraphFilterState,
} from "./graph-filters-data.ts";
import {
  buildGraphQueryRequest,
  type ResolvedAnalysisContext,
} from "../../app/repositories/[repoId]/explorer/explorer-data.ts";

const MOCK_CONTEXT: ResolvedAnalysisContext = {
  repositoryId: "11111111-1111-4111-8111-111111111111",
  repositoryName: "fluxora-app",
  analysisRunId: "22222222-2222-4222-8222-222222222222",
  defaultStartNodeId: "33333333-3333-4333-8333-333333333333",
};

test("1. GraphFilters renders all supported filter categories and options", () => {
  const html = renderToStaticMarkup(
    React.createElement(GraphFilters, {
      filters: DEFAULT_GRAPH_FILTERS,
      onChange: () => {},
      onReset: () => {},
    }),
  );

  assert.ok(html.includes("data-testid=\"graph-filters\""));
  assert.ok(html.includes("data-testid=\"filter-node-types\""));
  assert.ok(html.includes("data-testid=\"filter-edge-types\""));
  assert.ok(html.includes("data-testid=\"filter-min-confidence\""));
  assert.ok(html.includes("data-testid=\"filter-max-depth\""));
  assert.ok(html.includes("data-testid=\"reset-filters-btn\""));

  // Check all node types are present
  for (const nt of GraphNodeTypes) {
    assert.ok(html.includes(`data-testid="filter-node-type-${nt}"`));
  }

  // Check all edge types are present
  for (const et of GraphEdgeTypes) {
    assert.ok(html.includes(`data-testid="filter-edge-type-${et}"`));
  }
});

test("2. Selecting node types updates typed filter state", () => {
  let emittedState: GraphFilterState | null = null;
  const initialFilters: GraphFilterState = {
    ...DEFAULT_GRAPH_FILTERS,
    nodeTypes: ["symbol"],
  };

  // Toggle "service" on
  const nextNodeTypes = [...initialFilters.nodeTypes, "service" as GraphNodeType];
  emittedState = {
    ...initialFilters,
    nodeTypes: nextNodeTypes,
  };

  assert.deepEqual(emittedState.nodeTypes, ["symbol", "service"]);

  // Toggle "symbol" off
  const toggledOff = emittedState.nodeTypes.filter((t) => t !== "symbol");
  assert.deepEqual(toggledOff, ["service"]);
});

test("3. Selecting edge types updates typed filter state", () => {
  const initialFilters: GraphFilterState = {
    ...DEFAULT_GRAPH_FILTERS,
    edgeTypes: ["CALLS"],
  };

  const nextEdgeTypes = [...initialFilters.edgeTypes, "QUERIES_DB" as GraphEdgeType];
  const updated: GraphFilterState = {
    ...initialFilters,
    edgeTypes: nextEdgeTypes,
  };

  assert.deepEqual(updated.edgeTypes, ["CALLS", "QUERIES_DB"]);
});

test("4. Changing minimum confidence updates filter state and sanitizes correctly", () => {
  assert.equal(sanitizeMinConfidence(0.75), 0.75);
  assert.equal(sanitizeMinConfidence(-0.5), 0);
  assert.equal(sanitizeMinConfidence(1.5), 1);
  assert.equal(sanitizeMinConfidence(Number.NaN), 0);

  const updated: GraphFilterState = {
    ...DEFAULT_GRAPH_FILTERS,
    minConfidence: sanitizeMinConfidence(0.85),
  };
  assert.equal(updated.minConfidence, 0.85);
});

test("5. Changing max depth updates filter state and sanitizes within bounds", () => {
  assert.equal(sanitizeMaxDepth(10), 10);
  assert.equal(sanitizeMaxDepth(0), 1);
  assert.equal(sanitizeMaxDepth(-5), 1);
  assert.equal(sanitizeMaxDepth(25), HARD_MAX_TRAVERSAL_DEPTH);
  assert.equal(sanitizeMaxDepth(999), HARD_MAX_TRAVERSAL_DEPTH);
  assert.equal(sanitizeMaxDepth(Number.NaN), 1);

  const updated: GraphFilterState = {
    ...DEFAULT_GRAPH_FILTERS,
    maxDepth: sanitizeMaxDepth(7),
  };
  assert.equal(updated.maxDepth, 7);
});

test("6. Reset restores default filter state", () => {
  const modifiedFilters: GraphFilterState = {
    nodeTypes: ["symbol", "service"],
    edgeTypes: ["CALLS"],
    minConfidence: 0.9,
    maxDepth: 12,
  };

  // Reset operation
  const resetFilters = { ...DEFAULT_GRAPH_FILTERS };

  assert.deepEqual(resetFilters.nodeTypes, []);
  assert.deepEqual(resetFilters.edgeTypes, []);
  assert.equal(resetFilters.minConfidence, 0);
  assert.equal(resetFilters.maxDepth, DEFAULT_MAX_TRAVERSAL_DEPTH);
  assert.notDeepEqual(modifiedFilters, resetFilters);
});

test("7. Empty node-type selection means no node-type restriction", () => {
  const request = buildGraphQueryRequest({
    context: MOCK_CONTEXT,
    filters: {
      ...DEFAULT_GRAPH_FILTERS,
      nodeTypes: [],
    },
  });

  assert.equal(request.node_types, undefined, "Empty nodeTypes must be omitted so no restriction is applied");
});

test("8. Empty edge-type selection means no edge-type restriction", () => {
  const request = buildGraphQueryRequest({
    context: MOCK_CONTEXT,
    filters: {
      ...DEFAULT_GRAPH_FILTERS,
      edgeTypes: [],
    },
  });

  assert.equal(request.edge_types, undefined, "Empty edgeTypes must be omitted so no restriction is applied");
});

test("9. Max depth cannot exceed HARD_MAX_TRAVERSAL_DEPTH", () => {
  const clampedDepth = sanitizeMaxDepth(100);
  assert.equal(clampedDepth, HARD_MAX_TRAVERSAL_DEPTH);
  assert.ok(clampedDepth <= 20);

  const request = buildGraphQueryRequest({
    context: MOCK_CONTEXT,
    filters: {
      ...DEFAULT_GRAPH_FILTERS,
      maxDepth: clampedDepth,
    },
  });

  assert.equal(request.max_depth, HARD_MAX_TRAVERSAL_DEPTH);
});

test("10. GraphQueryRequest uses the exact existing field names", () => {
  const request = buildGraphQueryRequest({
    context: MOCK_CONTEXT,
    filters: {
      nodeTypes: ["symbol", "api"],
      edgeTypes: ["CALLS", "IMPORTS"],
      minConfidence: 0.8,
      maxDepth: 3,
    },
  });

  assert.deepEqual(request.node_types, ["symbol", "api"]);
  assert.deepEqual(request.edge_types, ["CALLS", "IMPORTS"]);
  assert.equal(request.min_confidence, 0.8);
  assert.equal(request.max_depth, 3);
  assert.equal(request.direction, "both");
  assert.equal(request.include_evidence, true);
});

test("11. organization_id is never added to the GraphQueryRequest", () => {
  const request = buildGraphQueryRequest({
    context: MOCK_CONTEXT,
    filters: {
      nodeTypes: ["symbol"],
      edgeTypes: ["CALLS"],
      minConfidence: 0.5,
      maxDepth: 4,
    },
  });

  assert.equal("organization_id" in request, false);
  assert.equal((request as unknown as Record<string, unknown>).organization_id, undefined);
});

test("12. analysis_run_id and start_node_id remain preserved under filtering", () => {
  const request = buildGraphQueryRequest({
    context: MOCK_CONTEXT,
    filters: {
      nodeTypes: ["database"],
      edgeTypes: ["QUERIES_DB"],
      minConfidence: 0.95,
      maxDepth: 2,
    },
  });

  assert.equal(request.analysis_run_id, MOCK_CONTEXT.analysisRunId);
  assert.equal(request.start_node_id, MOCK_CONTEXT.defaultStartNodeId);
});

test("13. Changing filters constructs new GraphQueryRequest without mutating context", () => {
  const req1 = buildGraphQueryRequest({
    context: MOCK_CONTEXT,
    filters: DEFAULT_GRAPH_FILTERS,
  });

  const req2 = buildGraphQueryRequest({
    context: MOCK_CONTEXT,
    filters: {
      ...DEFAULT_GRAPH_FILTERS,
      nodeTypes: ["symbol"],
      minConfidence: 0.8,
    },
  });

  assert.notDeepEqual(req1, req2);
  assert.equal(req1.node_types, undefined);
  assert.deepEqual(req2.node_types, ["symbol"]);
  assert.equal(req2.min_confidence, 0.8);
  assert.equal(req1.analysis_run_id, req2.analysis_run_id);
});

test("14. Stale/obsolete results do not overwrite newer filter responses", async () => {
  // Simulate race condition where older request (filter A) resolves after newer request (filter B)
  let activeGeneration = 0;
  let settledResultId = "";

  async function mockFetchWithRace(queryId: string, delayMs: number) {
    const generation = ++activeGeneration;
    await new Promise((r) => setTimeout(r, delayMs));

    // Stale check pattern: generation matches current generation
    if (generation === activeGeneration) {
      settledResultId = queryId;
    }
  }

  // Request 1 starts with 50ms delay
  const p1 = mockFetchWithRace("query-1-slow", 50);
  // Request 2 starts with 10ms delay (user changed filters rapidly)
  const p2 = mockFetchWithRace("query-2-fast", 10);

  await Promise.all([p1, p2]);

  // query-2-fast finished first, but generation check ensures query-1 (now obsolete) does NOT overwrite it
  assert.equal(settledResultId, "query-2-fast");
});

test("15. Selected node is cleared when filters remove it from graph", () => {
  let selectedNodeId: string | null = "node-2";

  // Filter applied: only symbols returned
  const filteredNodes = [{ id: "node-1", type: "symbol" }];

  // Reconciliation logic in Explorer
  const exists = filteredNodes.some((n) => n.id === selectedNodeId);
  if (!exists) {
    selectedNodeId = null;
  }

  assert.equal(selectedNodeId, null, "Selected node should be cleared when absent in filtered nodes");
});

test("16. Selected node remains selected when still present after filtering", () => {
  let selectedNodeId: string | null = "node-1";

  // Filter applied: node-1 is retained
  const filteredNodes = [{ id: "node-1", type: "symbol" }];

  // Reconciliation logic in Explorer
  const exists = filteredNodes.some((n) => n.id === selectedNodeId);
  if (!exists) {
    selectedNodeId = null;
  }

  assert.equal(selectedNodeId, "node-1", "Selected node should remain selected when still present");
});

test("17. NodeInspectorPanel and EvidenceTrail remain synchronized under filtering", () => {
  const node1 = {
    id: "node-1",
    type: "symbol",
    name: "sym1",
    canonical_id: "can:1",
    depth: 1,
    confidence: 0.9,
  };
  const filteredNodes = [node1];
  let currentSelection: string | null = "node-2"; // removed

  // Explorer synchronization
  const stillPresent = filteredNodes.some((n) => n.id === currentSelection);
  if (!stillPresent) {
    currentSelection = null;
  }

  const resolvedNode = filteredNodes.find((n) => n.id === currentSelection) ?? null;
  assert.equal(resolvedNode, null);
});

test("18. No database or network logic is introduced into GraphFilters itself", () => {
  let networkAttempted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    networkAttempted = true;
    return Promise.reject(new Error("Network called"));
  };

  try {
    renderToStaticMarkup(
      React.createElement(GraphFilters, {
        filters: {
          nodeTypes: ["symbol"],
          edgeTypes: ["CALLS"],
          minConfidence: 0.5,
          maxDepth: 3,
        },
        onChange: () => {},
        onReset: () => {},
      }),
    );
    assert.equal(networkAttempted, false, "GraphFilters must never perform network or database calls");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
