import { test } from "vitest";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  GraphQueryResponseEvidence,
  GraphQueryResponseNode,
} from "@fluxora/shared-types";
import {
  EvidenceTrail,
  NodeInspectorPanel,
  filterAndSortNodeEvidence,
  formatCoordinates,
  resolveSelectedNode,
  safeFormatMetadataValue,
} from "./node-inspector-data.ts";

const MOCK_NODE_1: GraphQueryResponseNode = {
  id: "44444444-4444-4444-8444-444444444444",
  type: "symbol",
  name: "traverseGraph",
  canonical_id: "sym:src/traversal.ts#traverseGraph:42",
  depth: 2,
  confidence: 0.95,
  path: "src/traversal.ts",
  metadata: {
    visibility: "public",
    async: true,
    tags: ["core", "traversal"],
  },
};

const MOCK_NODE_2: GraphQueryResponseNode = {
  id: "55555555-5555-4555-8555-555555555555",
  type: "api",
  name: "POST /graph/query",
  canonical_id: "route:src/server.ts#POST:/graph/query",
  depth: 1,
  confidence: 1.0,
  path: "src/server.ts",
  metadata: {
    method: "POST",
  },
};

const MOCK_EVIDENCE_NODE_1A: GraphQueryResponseEvidence = {
  id: "ev-node-1-alpha",
  subject_type: "graph_node",
  subject_id: MOCK_NODE_1.id,
  file_path: "src/traversal.ts",
  symbol_id: "sym:src/traversal.ts#traverseGraph:42",
  line_start: 42,
  line_end: 80,
  column_start: 1,
  column_end: 35,
  relationship_description: "Function declaration of traverseGraph",
  confidence: 1.0,
  metadata: { astType: "FunctionDeclaration" },
};

const MOCK_EVIDENCE_NODE_1B: GraphQueryResponseEvidence = {
  id: "ev-node-1-beta",
  subject_type: "graph_node",
  subject_id: MOCK_NODE_1.id,
  file_path: "src/traversal.ts",
  symbol_id: "sym:src/traversal.ts#traverseGraph:42",
  line_start: 10,
  line_end: 10,
  relationship_description: "Type signature import for traverseGraph",
  confidence: 0.9,
};

const MOCK_EVIDENCE_NODE_2: GraphQueryResponseEvidence = {
  id: "ev-node-2",
  subject_type: "graph_node",
  subject_id: MOCK_NODE_2.id,
  file_path: "src/server.ts",
  symbol_id: "route:src/server.ts#POST:/graph/query",
  line_start: 120,
  line_end: 145,
  column_start: 3,
  column_end: 25,
  relationship_description: "Fastify route declaration POST /graph/query",
  confidence: 1.0,
};

const MOCK_EVIDENCE_EDGE: GraphQueryResponseEvidence = {
  id: "ev-edge-1",
  subject_type: "graph_edge",
  subject_id: "edge-999",
  file_path: "src/calls.ts",
  line_start: 5,
  line_end: 5,
  relationship_description: "Call to traverseGraph",
  confidence: 0.85,
};

const MOCK_EVIDENCE_OTHER_SUBJECT: GraphQueryResponseEvidence = {
  id: "ev-impact-1",
  subject_type: "impact_finding",
  subject_id: MOCK_NODE_1.id, // Matching ID but wrong subject_type
  file_path: "src/impact.ts",
  line_start: 1,
  line_end: 10,
  relationship_description: "Impact finding provenance",
  confidence: 0.8,
};

test("EvidenceTrail filters evidence strictly to the selected node", () => {
  const allEvidence = [
    MOCK_EVIDENCE_NODE_1A,
    MOCK_EVIDENCE_EDGE,
    MOCK_EVIDENCE_NODE_2,
    MOCK_EVIDENCE_OTHER_SUBJECT,
    MOCK_EVIDENCE_NODE_1B,
  ];

  const filteredForNode1 = filterAndSortNodeEvidence(allEvidence, MOCK_NODE_1.id);

  // Must only include evidence where subject_type === 'graph_node' and subject_id === MOCK_NODE_1.id
  assert.equal(filteredForNode1.length, 2);
  assert.ok(filteredForNode1.some((e) => e.id === "ev-node-1-alpha"));
  assert.ok(filteredForNode1.some((e) => e.id === "ev-node-1-beta"));

  // Edge and foreign subject types must never be included
  assert.ok(!filteredForNode1.some((e) => e.id === "ev-edge-1"));
  assert.ok(!filteredForNode1.some((e) => e.id === "ev-impact-1"));
  assert.ok(!filteredForNode1.some((e) => e.id === "ev-node-2"));
});

test("EvidenceTrail excludes edges and other node IDs cleanly", () => {
  const allEvidence = [MOCK_EVIDENCE_EDGE, MOCK_EVIDENCE_NODE_2];

  const result = filterAndSortNodeEvidence(allEvidence, MOCK_NODE_1.id);
  assert.equal(result.length, 0);

  const emptyResult = filterAndSortNodeEvidence([], MOCK_NODE_1.id);
  assert.equal(emptyResult.length, 0);

  const nullNodeResult = filterAndSortNodeEvidence(allEvidence, null);
  assert.equal(nullNodeResult.length, 0);
});

test("Evidence ordering is deterministic (file_path, line_start, line_end, id)", () => {
  const unordered: GraphQueryResponseEvidence[] = [
    {
      id: "ev-z",
      subject_type: "graph_node",
      subject_id: "node-x",
      file_path: "src/z.ts",
      line_start: 10,
      relationship_description: "Z file",
      confidence: 1.0,
    },
    {
      id: "ev-a2",
      subject_type: "graph_node",
      subject_id: "node-x",
      file_path: "src/a.ts",
      line_start: 50,
      relationship_description: "A file line 50",
      confidence: 1.0,
    },
    {
      id: "ev-a1",
      subject_type: "graph_node",
      subject_id: "node-x",
      file_path: "src/a.ts",
      line_start: 10,
      line_end: 20,
      relationship_description: "A file line 10-20",
      confidence: 1.0,
    },
    {
      id: "ev-a1-extended",
      subject_type: "graph_node",
      subject_id: "node-x",
      file_path: "src/a.ts",
      line_start: 10,
      line_end: 30,
      relationship_description: "A file line 10-30",
      confidence: 1.0,
    },
  ];

  const sorted = filterAndSortNodeEvidence(unordered, "node-x");

  assert.equal(sorted.length, 4);
  assert.equal(sorted[0]?.id, "ev-a1"); // src/a.ts, line 10, end 20
  assert.equal(sorted[1]?.id, "ev-a1-extended"); // src/a.ts, line 10, end 30
  assert.equal(sorted[2]?.id, "ev-a2"); // src/a.ts, line 50
  assert.equal(sorted[3]?.id, "ev-z"); // src/z.ts, line 10

  // Reverse input order and assert exact identical result
  const reversed = [...unordered].reverse();
  const sortedReversed = filterAndSortNodeEvidence(reversed, "node-x");
  assert.deepEqual(
    sorted.map((e) => e.id),
    sortedReversed.map((e) => e.id),
  );
});

test("formatCoordinates formats full and partial coordinates safely", () => {
  // Full coordinates range
  const full = formatCoordinates({
    line_start: 10,
    line_end: 25,
    column_start: 1,
    column_end: 50,
  });
  assert.equal(full, "Lines 10–25, Col 1–50");

  // Single line with column range
  const singleLineWithCols = formatCoordinates({
    line_start: 42,
    line_end: 42,
    column_start: 5,
    column_end: 15,
  });
  assert.equal(singleLineWithCols, "Line 42, Col 5–15");

  // Line only (range)
  const lineRangeOnly = formatCoordinates({
    line_start: 15,
    line_end: 20,
  });
  assert.equal(lineRangeOnly, "Lines 15–20");

  // Single line only (without end line)
  const singleLineOnly = formatCoordinates({
    line_start: 99,
  });
  assert.equal(singleLineOnly, "Line 99");

  // Columns only
  const colsOnly = formatCoordinates({
    column_start: 4,
    column_end: 18,
  });
  assert.equal(colsOnly, "Col 4–18");

  // Missing / partial null values
  const missing = formatCoordinates({
    line_start: null,
    line_end: null,
    column_start: undefined,
  });
  assert.equal(missing, null);
});

test("EvidenceTrail empty state renders correctly", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceTrail, {
      evidence: [],
      selectedNodeId: MOCK_NODE_1.id,
    }),
  );

  assert.match(html, /data-testid="evidence-empty-state"/);
  assert.match(html, /No evidence records found/);
  assert.ok(!html.includes('data-testid="evidence-trail"'));
});

test("EvidenceTrail renders matching evidence items with all fields", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceTrail, {
      evidence: [MOCK_EVIDENCE_NODE_1A],
      selectedNodeId: MOCK_NODE_1.id,
    }),
  );

  assert.match(html, /data-testid="evidence-trail"/);
  assert.match(html, /data-testid="evidence-item-ev-node-1-alpha"/);
  assert.match(html, /data-testid="evidence-relationship"/);
  assert.match(html, /Function declaration of traverseGraph/);
  assert.match(html, /data-testid="evidence-file-path"/);
  assert.match(html, /src\/traversal\.ts/);
  assert.match(html, /data-testid="evidence-coordinates"/);
  assert.match(html, /Lines 42–80, Col 1–35/);
  assert.match(html, /data-testid="evidence-symbol"/);
  assert.match(html, /sym:src\/traversal\.ts#traverseGraph:42/);
  assert.match(html, /data-testid="evidence-confidence"/);
  assert.match(html, /100%/);
  assert.match(html, /data-testid="evidence-metadata"/);
  assert.match(html, /FunctionDeclaration/);
});

test("NodeInspectorPanel renders empty state when no node is selected", () => {
  const html = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: null,
      evidence: [MOCK_EVIDENCE_NODE_1A],
    }),
  );

  assert.match(html, /data-testid="inspector-empty-state"/);
  assert.match(html, /No Node Selected/);
  assert.ok(!html.includes('data-testid="node-inspector-panel"'));
});

test("NodeInspectorPanel renders selected node details correctly", () => {
  const html = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: MOCK_NODE_1,
      evidence: [MOCK_EVIDENCE_NODE_1A, MOCK_EVIDENCE_NODE_1B],
      onClose: () => {},
    }),
  );

  assert.match(html, /data-testid="node-inspector-panel"/);
  assert.match(html, /data-testid="inspector-node-name"/);
  assert.match(html, /traverseGraph/);
  assert.match(html, /data-testid="inspector-node-type"/);
  assert.match(html, /Symbol/i);

  assert.match(html, /data-testid="inspector-node-id"/);
  assert.match(html, new RegExp(MOCK_NODE_1.id));
  assert.match(html, /data-testid="inspector-node-canonical-id"/);
  assert.match(html, /sym:src\/traversal\.ts#traverseGraph:42/);
  assert.match(html, /data-testid="inspector-node-depth"/);
  assert.match(html, /2/);
  assert.match(html, /data-testid="inspector-node-confidence"/);
  assert.match(html, /95%/);
  assert.match(html, /data-testid="inspector-node-path"/);
  assert.match(html, /src\/traversal\.ts/);

  // Close / clear selection button rendered
  assert.match(html, /data-testid="clear-selection-button"/);

  // Embedded EvidenceTrail rendered with matching evidence
  assert.match(html, /data-testid="evidence-trail"/);
  assert.match(html, /ev-node-1-alpha/);
  assert.match(html, /ev-node-1-beta/);
});

test("NodeInspectorPanel renders metadata safely without unbounded dumps", () => {
  const nodeWithComplexMetadata: GraphQueryResponseNode = {
    ...MOCK_NODE_1,
    metadata: {
      framework: "express",
      count: 42,
      active: true,
      tags: ["alpha", "beta"],
      nested: { service: "core", retries: 3 },
    },
  };

  const html = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: nodeWithComplexMetadata,
      evidence: [],
    }),
  );

  assert.match(html, /data-testid="inspector-node-metadata"/);
  assert.match(html, /data-testid="metadata-item-framework"/);
  assert.match(html, /express/);
  assert.match(html, /data-testid="metadata-item-count"/);
  assert.match(html, /42/);
  assert.match(html, /data-testid="metadata-item-active"/);
  assert.match(html, /true/);
  assert.match(html, /data-testid="metadata-item-tags"/);

  // Test safeFormatMetadataValue truncation
  const hugePayload = { large: "x".repeat(300) };
  const formatted = safeFormatMetadataValue(hugePayload);
  assert.ok(formatted.length <= 200);
  assert.ok(formatted.endsWith("..."));
});

test("Changing node selection updates inspector properties and evidence trail", () => {
  const allEvidence = [MOCK_EVIDENCE_NODE_1A, MOCK_EVIDENCE_NODE_2];

  // Render for Node 1
  const htmlNode1 = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: MOCK_NODE_1,
      evidence: allEvidence,
    }),
  );
  assert.match(htmlNode1, /traverseGraph/);
  assert.match(htmlNode1, /ev-node-1-alpha/);
  assert.ok(!htmlNode1.includes("POST /graph/query"));
  assert.ok(!htmlNode1.includes("ev-node-2"));

  // Render for Node 2
  const htmlNode2 = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: MOCK_NODE_2,
      evidence: allEvidence,
    }),
  );
  assert.match(htmlNode2, /POST \/graph\/query/);
  assert.match(htmlNode2, /ev-node-2/);
  assert.ok(!htmlNode2.includes("traverseGraph"));
  assert.ok(!htmlNode2.includes("ev-node-1-alpha"));
});

test("Clearing selection returns inspector to empty state", () => {
  // When active node is cleared (set to null)
  const htmlCleared = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: null,
      evidence: [MOCK_EVIDENCE_NODE_1A],
    }),
  );

  assert.match(htmlCleared, /data-testid="inspector-empty-state"/);
  assert.ok(!htmlCleared.includes('data-testid="node-inspector-panel"'));
});

test("No network request is performed by NodeInspectorPanel or EvidenceTrail", () => {
  let networkCallAttempted = false;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = () => {
    networkCallAttempted = true;
    return Promise.reject(new Error("Network call forbidden in inspector"));
  };

  try {
    renderToStaticMarkup(
      React.createElement(NodeInspectorPanel, {
        node: MOCK_NODE_1,
        evidence: [MOCK_EVIDENCE_NODE_1A],
      }),
    );
    renderToStaticMarkup(
      React.createElement(EvidenceTrail, {
        evidence: [MOCK_EVIDENCE_NODE_1A],
        selectedNodeId: MOCK_NODE_1.id,
      }),
    );

    assert.equal(
      networkCallAttempted,
      false,
      "NodeInspectorPanel and EvidenceTrail must never perform network requests",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Explorer selection state transitions operate cleanly", () => {
  const nodes = [MOCK_NODE_1, MOCK_NODE_2];

  // Test exported resolveSelectedNode helper

  // Initial state: nothing selected
  assert.equal(resolveSelectedNode(nodes, null), null);

  // User clicks Node 1
  const sel1 = resolveSelectedNode(nodes, MOCK_NODE_1.id);
  assert.equal(sel1?.id, MOCK_NODE_1.id);

  // User clicks Node 2 (selection replaced)
  const sel2 = resolveSelectedNode(nodes, MOCK_NODE_2.id);
  assert.equal(sel2?.id, MOCK_NODE_2.id);

  // User clicks clear (selection cleared)
  const cleared = resolveSelectedNode(nodes, null);
  assert.equal(cleared, null);

  // Non-existent ID safely resolves to null
  const missing = resolveSelectedNode(nodes, "phantom-node-id");
  assert.equal(missing, null);
});
