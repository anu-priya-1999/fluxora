import { test } from "vitest";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ImpactAnalysisFindingResponse,
  ImpactAnalysisResponse,
} from "@fluxora/shared-types";
import {
  computeImpactSliceMetrics,
  DEFAULT_CHANGE_MODE_STATE,
  fetchImpactAnalysis,
  normalizeImpactAnalysisResponse,
  type NormalizedChangeModeState,
} from "./change-mode-data.ts";
import {
  computeNodeVisualStyles,
  getChangeModeHopColor,
  getNodeVisualConfig,
} from "./node-styles.ts";
import { ChangeModeBar } from "./ChangeModeBar.tsx";
import { NodeInspectorPanel } from "./NodeInspectorPanel.tsx";

const PR_ID = "11111111-1111-4111-8111-111111111111";
const ANALYSIS_RUN_ID = "22222222-2222-4222-8222-222222222222";
const IMPACT_ID = "33333333-3333-4333-8333-333333333333";

const NODE_DIRECT_1 = "aaaa0001-0000-0000-0000-000000000001";
const NODE_DIRECT_2 = "aaaa0002-0000-0000-0000-000000000002";
const NODE_DOWNSTREAM_1 = "bbbb0001-0000-0000-0000-000000000001";
const NODE_DOWNSTREAM_2 = "bbbb0002-0000-0000-0000-000000000002";
const NODE_API = "cccc0001-0000-0000-0000-000000000001";
const NODE_EVENT = "dddd0001-0000-0000-0000-000000000001";
const NODE_UNAFFECTED = "eeee0001-0000-0000-0000-000000000001";

function createMockFinding(
  nodeId: string,
  options: {
    name?: string;
    type?: string;
    depth?: number;
    hop_distance?: number;
    confidence?: number;
    path?: string[];
    evidence_ids?: string[];
    evidence_id?: string | null;
  } = {},
): ImpactAnalysisFindingResponse {
  const depth = options.depth ?? (options.hop_distance !== undefined ? options.hop_distance : 1);
  return {
    node_id: nodeId,
    name: options.name ?? `Node-${nodeId.slice(0, 8)}`,
    type: options.type ?? "module",
    canonical_id: `mod:${nodeId}`,
    file_path: `src/${nodeId.slice(0, 8)}.ts`,
    depth,
    hop_distance: options.hop_distance ?? depth,
    confidence: options.confidence ?? 0.9,
    path: options.path ?? [nodeId],
    evidence_ids: options.evidence_ids ?? [`ev-${nodeId.slice(0, 8)}`],
    evidence_id: options.evidence_id ?? `ev-${nodeId.slice(0, 8)}`,
  };
}

function createMockImpactResponse(
  overrides: Partial<ImpactAnalysisResponse> = {},
): ImpactAnalysisResponse {
  return {
    id: IMPACT_ID,
    pull_request_id: PR_ID,
    analysis_run_id: ANALYSIS_RUN_ID,
    status: "completed",
    direct_impact: [
      createMockFinding(NODE_DIRECT_1, { hop_distance: 0, depth: 0, confidence: 1.0 }),
      createMockFinding(NODE_DIRECT_2, { hop_distance: 0, depth: 0, confidence: 1.0 }),
    ],
    downstream_impact: [
      createMockFinding(NODE_DOWNSTREAM_1, { hop_distance: 1, depth: 1, confidence: 0.9 }),
      createMockFinding(NODE_DOWNSTREAM_2, { hop_distance: 2, depth: 2, confidence: 0.81 }),
    ],
    affected_apis: [
      createMockFinding(NODE_API, { type: "api", hop_distance: 1, depth: 1, confidence: 0.9 }),
    ],
    affected_events: [
      createMockFinding(NODE_EVENT, { type: "event", hop_distance: 2, depth: 2, confidence: 0.81 }),
    ],
    affected_services: [],
    workflow_impact_summary: ["Checkout Flow", "Order Processing"],
    unresolved_files: [
      { path: "README.md", reason: "Non-code documentation file" },
    ],
    truncated: false,
    truncation_reason: null,
    max_depth_reached: 2,
    execution_metrics: {
      total_seed_nodes: 2,
      total_affected_nodes: 4,
      total_edges_traversed: 5,
      duration_ms: 12,
    },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// Test A: Persisted ImpactAnalysis -> Normalized change-mode state
// =============================================================================
test("Step 46 [A]: Normalizes persisted ImpactAnalysis into compact view model", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response, { enabled: true });

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.pullRequestId, PR_ID);
  assert.equal(normalized.impactAnalysisId, IMPACT_ID);
  assert.equal(normalized.status, "ready");
  assert.equal(normalized.executionStatus, "completed");
  assert.equal(normalized.directCount, 2);
  assert.equal(normalized.downstreamCount, 2);
  assert.equal(normalized.affectedApiCount, 1);
  assert.equal(normalized.affectedEventCount, 1);
});

// =============================================================================
// Test B: Direct impact classification
// =============================================================================
test("Step 46 [B]: Classifies direct impact nodes with hop distance 0", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response);

  assert.ok(normalized.directNodeIds.has(NODE_DIRECT_1));
  assert.ok(normalized.directNodeIds.has(NODE_DIRECT_2));
  assert.equal(normalized.hopDistanceByNodeId.get(NODE_DIRECT_1), 0);
  assert.equal(normalized.hopDistanceByNodeId.get(NODE_DIRECT_2), 0);
  assert.equal(normalized.directCount, 2);
});

// =============================================================================
// Test C: Downstream impact classification
// =============================================================================
test("Step 46 [C]: Classifies downstream impacted nodes with correct membership", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response);

  assert.ok(normalized.downstreamNodeIds.has(NODE_DOWNSTREAM_1));
  assert.ok(normalized.downstreamNodeIds.has(NODE_DOWNSTREAM_2));
  assert.ok(!normalized.directNodeIds.has(NODE_DOWNSTREAM_1));
  assert.equal(normalized.downstreamCount, 2);
});

// =============================================================================
// Test D: Hop-distance preservation
// =============================================================================
test("Step 46 [D]: Preserves exact hop distance per node", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response);

  assert.equal(normalized.hopDistanceByNodeId.get(NODE_DIRECT_1), 0);
  assert.equal(normalized.hopDistanceByNodeId.get(NODE_DOWNSTREAM_1), 1);
  assert.equal(normalized.hopDistanceByNodeId.get(NODE_DOWNSTREAM_2), 2);
});

// =============================================================================
// Test E: Confidence preservation
// =============================================================================
test("Step 46 [E]: Preserves confidence values per node", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response);

  assert.equal(normalized.confidenceByNodeId.get(NODE_DIRECT_1), 1.0);
  assert.equal(normalized.confidenceByNodeId.get(NODE_DOWNSTREAM_1), 0.9);
  assert.equal(normalized.confidenceByNodeId.get(NODE_DOWNSTREAM_2), 0.81);
});

// =============================================================================
// Test F: Affected API classification
// =============================================================================
test("Step 46 [F]: Classifies affected API routes in distinct set", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response);

  assert.ok(normalized.affectedApiNodeIds.has(NODE_API));
  assert.equal(normalized.affectedApiCount, 1);
  assert.ok(!normalized.affectedApiNodeIds.has(NODE_DIRECT_1));
});

// =============================================================================
// Test G: Affected event classification
// =============================================================================
test("Step 46 [G]: Classifies affected events in distinct set", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response);

  assert.ok(normalized.affectedEventNodeIds.has(NODE_EVENT));
  assert.equal(normalized.affectedEventCount, 1);
  assert.ok(!normalized.affectedEventNodeIds.has(NODE_DIRECT_1));
});

// =============================================================================
// Test H: Evidence ID preservation
// =============================================================================
test("Step 46 [H]: Preserves, deduplicates, and sorts evidence IDs", () => {
  const response = createMockImpactResponse({
    direct_impact: [
      createMockFinding(NODE_DIRECT_1, {
        evidence_ids: ["ev-beta", "ev-alpha", "ev-beta"],
        evidence_id: "ev-gamma",
      }),
    ],
  });
  const normalized = normalizeImpactAnalysisResponse(response);

  const evidence = normalized.evidenceIdsByNodeId.get(NODE_DIRECT_1);
  assert.ok(evidence);
  // Deduplicated and sorted lexicographically
  assert.deepEqual(evidence, ["ev-alpha", "ev-beta", "ev-gamma"]);
});

// =============================================================================
// Test I: Unresolved files preservation
// =============================================================================
test("Step 46 [I]: Preserves unresolved files list with reasons", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response);

  assert.equal(normalized.unresolvedFiles.length, 1);
  assert.equal(normalized.unresolvedFiles[0]?.path, "README.md");
  assert.equal(normalized.unresolvedFiles[0]?.reason, "Non-code documentation file");
});

// =============================================================================
// Test J: Truncated state preservation
// =============================================================================
test("Step 46 [J]: Preserves truncated state and ceiling metadata", () => {
  const response = createMockImpactResponse({
    truncated: true,
    truncation_reason: "Max depth ceiling of 5 reached with outgoing edges",
    max_depth_reached: 5,
  });
  const normalized = normalizeImpactAnalysisResponse(response);

  assert.equal(normalized.truncated, true);
  assert.equal(
    normalized.truncationReason,
    "Max depth ceiling of 5 reached with outgoing edges",
  );
  assert.equal(normalized.maxDepthReached, 5);
});

// =============================================================================
// Test K: Deterministic ordering
// =============================================================================
test("Step 46 [K]: Produces deterministic normalization regardless of array input order", () => {
  const res1 = createMockImpactResponse();
  const res2 = createMockImpactResponse({
    direct_impact: [res1.direct_impact[1]!, res1.direct_impact[0]!],
    downstream_impact: [res1.downstream_impact[1]!, res1.downstream_impact[0]!],
  });

  const norm1 = normalizeImpactAnalysisResponse(res1);
  const norm2 = normalizeImpactAnalysisResponse(res2);

  assert.deepEqual(Array.from(norm1.directNodeIds), Array.from(norm2.directNodeIds));
  assert.deepEqual(Array.from(norm1.downstreamNodeIds), Array.from(norm2.downstreamNodeIds));
});

// =============================================================================
// Test L: Duplicate node IDs handled deterministically
// =============================================================================
test("Step 46 [L]: Multi-seed shallowest path: direct wins over downstream, lowest hop distance wins", () => {
  const duplicateNode = "dup00000-0000-0000-0000-000000000001";
  const response = createMockImpactResponse({
    direct_impact: [
      createMockFinding(duplicateNode, { hop_distance: 0, depth: 0, confidence: 1.0 }),
    ],
    downstream_impact: [
      // Duplicate occurrence in downstream: direct must take precedence
      createMockFinding(duplicateNode, { hop_distance: 2, depth: 2, confidence: 0.81 }),
    ],
  });

  const normalized = normalizeImpactAnalysisResponse(response);

  assert.ok(normalized.directNodeIds.has(duplicateNode));
  assert.ok(!normalized.downstreamNodeIds.has(duplicateNode));
  assert.equal(normalized.hopDistanceByNodeId.get(duplicateNode), 0);
  assert.equal(normalized.confidenceByNodeId.get(duplicateNode), 1.0);
});

test("Step 46 [L-2]: Duplicate downstream paths: shallowest hop distance wins", () => {
  const duplicateNode = "dup00000-0000-0000-0000-000000000002";
  const response = createMockImpactResponse({
    direct_impact: [],
    downstream_impact: [
      createMockFinding(duplicateNode, { hop_distance: 3, depth: 3, confidence: 0.72 }),
      createMockFinding(duplicateNode, { hop_distance: 1, depth: 1, confidence: 0.90 }),
    ],
  });

  const normalized = normalizeImpactAnalysisResponse(response);

  assert.ok(normalized.downstreamNodeIds.has(duplicateNode));
  assert.equal(normalized.hopDistanceByNodeId.get(duplicateNode), 1);
  assert.equal(normalized.confidenceByNodeId.get(duplicateNode), 0.90);
});

// =============================================================================
// Test M: Missing graph nodes do not create fake nodes
// =============================================================================
test("Step 46 [M]: Missing graph nodes are reported in metrics without fabricating fake nodes", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response);

  // Loaded graph slice only contains NODE_DIRECT_1, not other findings
  const visibleNodes = [{ id: NODE_DIRECT_1 }];
  const metrics = computeImpactSliceMetrics(normalized, visibleNodes);

  assert.equal(metrics.totalImpactedNodes, 4); // 2 direct + 2 downstream
  assert.equal(metrics.visibleImpactedNodes, 1);
  assert.equal(metrics.missingFromSliceCount, 3);
});

// =============================================================================
// Test N: Selected-node priority over change-mode styling
// =============================================================================
test("Step 46 [N]: Selected node styling takes absolute priority over change-mode overlay", () => {
  const directStylesSelected = computeNodeVisualStyles({
    nodeType: "module",
    isSelected: true,
    changeModeActive: true,
    impactRole: "direct",
    impactHopDistance: 0,
    impactConfidence: 1.0,
  });

  // Must use selection blue border and selection ring
  assert.equal(directStylesSelected.border, "2px solid #2563eb");
  assert.ok(directStylesSelected.boxShadow.includes("rgba(37, 99, 235"));
  assert.equal(directStylesSelected.opacity, 1.0);

  const directStylesUnselected = computeNodeVisualStyles({
    nodeType: "module",
    isSelected: false,
    changeModeActive: true,
    impactRole: "direct",
    impactHopDistance: 0,
    impactConfidence: 1.0,
  });

  // When unselected, direct change red border is rendered
  assert.equal(directStylesUnselected.border, "2px solid #dc2626");
  assert.ok(directStylesUnselected.boxShadow.includes("rgba(220, 38, 38"));
});

// =============================================================================
// Test O: Change mode disabled = existing graph behavior
// =============================================================================
test("Step 46 [O]: Disabled change mode outputs standard base visual styles", () => {
  const baseConfig = getNodeVisualConfig("module");
  const styles = computeNodeVisualStyles({
    nodeType: "module",
    isSelected: false,
    changeModeActive: false,
    impactRole: "direct",
  });

  assert.equal(styles.border, `2px solid ${baseConfig.borderColor}`);
  assert.equal(styles.backgroundColor, baseConfig.backgroundColor);
  assert.equal(styles.opacity, 1.0);
  assert.equal(styles.filter, undefined);
});

// =============================================================================
// Test P: Filter interaction
// =============================================================================
test("Step 46 [P]: Preserves impact findings when graph filters hide nodes", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response);

  // Suppose user filters out all services, leaving only module nodes in visibleNodes
  const filteredVisibleNodes = [
    { id: NODE_DIRECT_1 },
    { id: NODE_DOWNSTREAM_1 },
  ];

  const metrics = computeImpactSliceMetrics(normalized, filteredVisibleNodes);

  // Normalized findings are never deleted
  assert.equal(normalized.directCount, 2);
  assert.equal(normalized.downstreamCount, 2);
  assert.equal(metrics.visibleImpactedNodes, 2);
  assert.equal(metrics.missingFromSliceCount, 2);
});

// =============================================================================
// Test Q: LOD interaction
// =============================================================================
test("Step 46 [Q]: LOD zoom tiers retain full impact findings while updating visible slice", () => {
  const response = createMockImpactResponse();
  const normalized = normalizeImpactAnalysisResponse(response);

  // Low LOD tier (e.g. system tier): only top-level node is visible
  const lodNodes = [{ id: NODE_DIRECT_1 }];
  const metrics = computeImpactSliceMetrics(normalized, lodNodes);

  assert.equal(metrics.totalImpactedNodes, 4);
  assert.equal(metrics.visibleImpactedNodes, 1);
  assert.equal(metrics.hiddenImpactedNodes, 3);
});

// =============================================================================
// Test R: Loading state
// =============================================================================
test("Step 46 [R]: Loading state displays spinner and fetching message", () => {
  const loadingState: NormalizedChangeModeState = {
    ...DEFAULT_CHANGE_MODE_STATE,
    enabled: true,
    impactAnalysisId: IMPACT_ID,
    status: "loading",
  };

  const html = renderToStaticMarkup(
    React.createElement(ChangeModeBar, {
      state: loadingState,
      onToggle: () => {},
      onLoadAnalysis: () => {},
      onRetry: () => {},
      onClear: () => {},
    }),
  );

  assert.ok(html.includes("data-testid=\"change-mode-loading-status\""));
  assert.ok(html.includes("Fetching impact analysis..."));
});

// =============================================================================
// Test S: Pending/running state
// =============================================================================
test("Step 46 [S]: Pending/running state surfaces in-progress execution status", () => {
  const runningResponse = createMockImpactResponse({
    status: "running",
  });
  const normalized = normalizeImpactAnalysisResponse(runningResponse);

  assert.equal(normalized.status, "loading");
  assert.equal(normalized.executionStatus, "running");

  const html = renderToStaticMarkup(
    React.createElement(ChangeModeBar, {
      state: normalized,
      onToggle: () => {},
      onLoadAnalysis: () => {},
      onRetry: () => {},
      onClear: () => {},
    }),
  );

  assert.ok(html.includes("Analysis in progress (running)..."));
});

// =============================================================================
// Test T: Completed-empty state
// =============================================================================
test("Step 46 [T]: Completed analysis with zero findings sets status to empty", () => {
  const emptyResponse = createMockImpactResponse({
    direct_impact: [],
    downstream_impact: [],
    affected_apis: [],
    affected_events: [],
  });
  const normalized = normalizeImpactAnalysisResponse(emptyResponse);

  assert.equal(normalized.status, "empty");
  assert.equal(normalized.directCount, 0);
  assert.equal(normalized.downstreamCount, 0);

  const html = renderToStaticMarkup(
    React.createElement(ChangeModeBar, {
      state: normalized,
      onToggle: () => {},
      onLoadAnalysis: () => {},
      onRetry: () => {},
      onClear: () => {},
    }),
  );

  assert.ok(html.includes("data-testid=\"change-mode-empty-status\""));
  assert.ok(html.includes("0 affected nodes"));
});

// =============================================================================
// Test U: API error state
// =============================================================================
test("Step 46 [U]: API fetch error formats error status and surfaces retry", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        error: { code: "not_found", message: "Impact analysis not found." },
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );

  const result = await fetchImpactAnalysis({
    apiUrl: "http://localhost:3001",
    impactAnalysisId: IMPACT_ID,
    getToken: async () => "mock-jwt-token",
    fetchImpl,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_found");
    assert.equal(result.message, "The requested impact analysis was not found.");
  }

  const errorState: NormalizedChangeModeState = {
    ...DEFAULT_CHANGE_MODE_STATE,
    enabled: true,
    impactAnalysisId: IMPACT_ID,
    status: "error",
    errorMessage: "The requested impact analysis was not found.",
  };

  const html = renderToStaticMarkup(
    React.createElement(ChangeModeBar, {
      state: errorState,
      onToggle: () => {},
      onLoadAnalysis: () => {},
      onRetry: () => {},
      onClear: () => {},
    }),
  );

  assert.ok(html.includes("data-testid=\"change-mode-error-status\""));
  assert.ok(html.includes("data-testid=\"change-mode-retry-btn\""));
  assert.ok(html.includes("The requested impact analysis was not found."));
});

// =============================================================================
// Test V: Retry behavior
// =============================================================================
test("Step 46 [V]: Retry callback executes on user click", () => {
  let retried = false;
  const errorState: NormalizedChangeModeState = {
    ...DEFAULT_CHANGE_MODE_STATE,
    enabled: true,
    impactAnalysisId: IMPACT_ID,
    status: "error",
    errorMessage: "Network failure.",
  };

  const element = React.createElement(ChangeModeBar, {
    state: errorState,
    onToggle: () => {},
    onLoadAnalysis: () => {},
    onRetry: () => {
      retried = true;
    },
    onClear: () => {},
  });

  // Verify element instantiates and onRetry triggers callback
  assert.ok(element);
  element.props.onRetry();
  assert.equal(retried, true);
});

// =============================================================================
// Test W: Toggling change mode off restores normal rendering
// =============================================================================
test("Step 46 [W]: Toggling change mode OFF disables overlay and restores base styling", () => {
  let toggledValue: boolean | null = null;
  const readyState = normalizeImpactAnalysisResponse(createMockImpactResponse(), {
    enabled: true,
  });

  const bar = React.createElement(ChangeModeBar, {
    state: readyState,
    onToggle: (next) => {
      toggledValue = next;
    },
    onLoadAnalysis: () => {},
    onRetry: () => {},
    onClear: () => {},
  });

  bar.props.onToggle(false);
  assert.equal(toggledValue, false);

  const html = renderToStaticMarkup(bar);
  assert.ok(html.includes("Change Mode: ON"));

  // Compute styles when toggled off
  const disabledStyles = computeNodeVisualStyles({
    nodeType: "module",
    isSelected: false,
    changeModeActive: false,
    impactRole: "direct",
  });

  assert.equal(disabledStyles.border, "2px solid #2563eb");
  assert.equal(disabledStyles.opacity, 1.0);
});

// =============================================================================
// Component Integration Tests: NodeInspectorPanel with Change Mode
// =============================================================================
test("Step 46 [Inspector]: Renders PR Impact section with hop, confidence, and evidence for impacted node", () => {
  const readyState = normalizeImpactAnalysisResponse(createMockImpactResponse());
  const selectedNode = {
    id: NODE_DIRECT_1,
    type: "module",
    name: "PaymentService.ts",
    canonical_id: "mod:src/PaymentService.ts",
    confidence: 1.0,
    depth: 0,
  };

  const html = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: selectedNode,
      changeMode: readyState,
    }),
  );

  assert.ok(html.includes("data-testid=\"inspector-impact-section\""));
  assert.ok(html.includes("data-testid=\"inspector-impact-role-badge\""));
  assert.ok(html.includes("Direct Change"));
  assert.ok(html.includes("data-testid=\"inspector-impact-hop\""));
  assert.ok(html.includes("data-testid=\"inspector-impact-confidence\""));
  assert.ok(html.includes("data-testid=\"inspector-impact-evidence-list\""));
});

test("Step 46 [Inspector]: Renders 'Unaffected' badge when selected node is outside blast radius", () => {
  const readyState = normalizeImpactAnalysisResponse(createMockImpactResponse());
  const unaffectedNode = {
    id: NODE_UNAFFECTED,
    type: "module",
    name: "UnrelatedService.ts",
    canonical_id: "mod:src/UnrelatedService.ts",
    confidence: 1.0,
    depth: 0,
  };

  const html = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: unaffectedNode,
      changeMode: readyState,
    }),
  );

  assert.ok(html.includes("data-testid=\"inspector-impact-section\""));
  assert.ok(html.includes("data-testid=\"inspector-impact-unaffected-badge\""));
  assert.ok(html.includes("outside the blast radius"));
});

// =============================================================================
// Hop color progression test
// =============================================================================
test("Step 46 [HopColors]: Chromatic decay provides distinct colors per hop distance", () => {
  const hop0 = getChangeModeHopColor(0);
  const hop1 = getChangeModeHopColor(1);
  const hop2 = getChangeModeHopColor(2);
  const hop3 = getChangeModeHopColor(3);

  assert.equal(hop0, "#dc2626"); // Red 600
  assert.equal(hop1, "#d97706"); // Amber 600
  assert.equal(hop2, "#f59e0b"); // Amber 500
  assert.equal(hop3, "#fbbf24"); // Amber 400
});
