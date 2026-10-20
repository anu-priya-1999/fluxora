import { test } from "vitest";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  GraphQueryResponseEdge,
  GraphQueryResponseNode,
  ImpactAnalysisResponse,
} from "@fluxora/shared-types";
import {
  calculateGraphEdgeCoverage,
  calculateImpactFindingCoverage,
  formatCoveragePercentage,
  isGraphEdgeCovered,
  isImpactFindingCovered,
} from "./coverage-data.ts";
import { AnalysisCoverageBar } from "./AnalysisCoverageBar.tsx";
import {
  normalizeImpactAnalysisResponse,
} from "./change-mode-data.ts";
import { NodeInspectorPanel } from "./node-inspector-data.ts";

// ============================================================================
// Fixture Data
// ============================================================================

const MOCK_NODE_1: GraphQueryResponseNode = {
  id: "node-user-service",
  type: "service",
  name: "UserService",
  canonical_id: "services/user",
  depth: 0,
  confidence: 1.0,
  path: "src/services/user.ts",
};

const MOCK_NODE_2: GraphQueryResponseNode = {
  id: "node-auth-module",
  type: "module",
  name: "AuthModule",
  canonical_id: "modules/auth",
  depth: 1,
  confidence: 1.0,
  path: "src/modules/auth.ts",
};

const MOCK_NODE_3: GraphQueryResponseNode = {
  id: "node-db-client",
  type: "database",
  name: "DatabaseClient",
  canonical_id: "db/client",
  depth: 2,
  confidence: 0.9,
  path: "src/db/client.ts",
};

const MOCK_COVERED_EDGE_1: GraphQueryResponseEdge = {
  id: "edge-1",
  source: "node-user-service",
  target: "node-auth-module",
  type: "IMPORTS",
  confidence: 1.0,
  provenance: "static-analysis",
  evidence_id: "ev-edge-1",
};

const MOCK_COVERED_EDGE_2: GraphQueryResponseEdge = {
  id: "edge-2",
  source: "node-auth-module",
  target: "node-db-client",
  type: "QUERIES_DB",
  confidence: 0.85,
  provenance: "inferred",
  evidence_id: "ev-edge-2",
};

const MOCK_UNCOVERED_EDGE_3: GraphQueryResponseEdge = {
  id: "edge-3",
  source: "node-user-service",
  target: "node-db-client",
  type: "CALLS",
  confidence: 0.95, // High confidence but NO evidence -> MUST be uncovered!
  provenance: "ai-hypothesis",
  evidence_id: null,
};

const MOCK_UNCOVERED_EDGE_4: GraphQueryResponseEdge = {
  id: "edge-4",
  source: "node-auth-module",
  target: "node-user-service",
  type: "CALLS",
  confidence: 0.6,
  provenance: "heuristic",
  evidence_id: undefined,
};

// ============================================================================
// Section A: Coverage Calculation & Precision Tests
// ============================================================================

test("A1. formatCoveragePercentage calculates deterministic percentages with 1 decimal place", () => {
  assert.deepEqual(formatCoveragePercentage(10, 10), {
    percentage: 100,
    formattedPercentage: "100%",
  });
  assert.deepEqual(formatCoveragePercentage(0, 10), {
    percentage: 0,
    formattedPercentage: "0%",
  });
  assert.deepEqual(formatCoveragePercentage(0, 0), {
    percentage: 0,
    formattedPercentage: "N/A",
  });
  // 96.54% -> 96.5%
  assert.deepEqual(formatCoveragePercentage(965, 1000), {
    percentage: 96.5,
    formattedPercentage: "96.5%",
  });
  // 2 / 3 -> 66.7%
  assert.deepEqual(formatCoveragePercentage(2, 3), {
    percentage: 66.7,
    formattedPercentage: "66.7%",
  });
});

test("A2. calculateGraphEdgeCoverage computes exact numerator, denominator, and percentage", () => {
  const edges = [
    MOCK_COVERED_EDGE_1,
    MOCK_COVERED_EDGE_2,
    MOCK_UNCOVERED_EDGE_3,
    MOCK_UNCOVERED_EDGE_4,
  ];
  const summary = calculateGraphEdgeCoverage({
    edges,
    nodes: [MOCK_NODE_1, MOCK_NODE_2, MOCK_NODE_3],
    analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
  });

  assert.equal(summary.kind, "available");
  assert.equal(summary.subjectType, "graph_edge");
  assert.equal(summary.total, 4);
  assert.equal(summary.covered, 2);
  assert.equal(summary.uncovered, 2);
  assert.equal(summary.percentage, 50);
  assert.equal(summary.formattedPercentage, "50%");
  assert.equal(summary.isFullCoverage, false);
  assert.equal(summary.isZeroCoverage, false);
  assert.equal(summary.isEmptyScope, false);
});

test("A3. calculateGraphEdgeCoverage handles 100% full coverage cleanly", () => {
  const edges = [MOCK_COVERED_EDGE_1, MOCK_COVERED_EDGE_2];
  const summary = calculateGraphEdgeCoverage({
    edges,
    nodes: [MOCK_NODE_1, MOCK_NODE_2, MOCK_NODE_3],
    analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
  });

  assert.equal(summary.total, 2);
  assert.equal(summary.covered, 2);
  assert.equal(summary.uncovered, 0);
  assert.equal(summary.percentage, 100);
  assert.equal(summary.formattedPercentage, "100%");
  assert.equal(summary.isFullCoverage, true);
  assert.equal(summary.isZeroCoverage, false);
});

test("A4. calculateGraphEdgeCoverage handles 0% zero coverage cleanly", () => {
  const edges = [MOCK_UNCOVERED_EDGE_3, MOCK_UNCOVERED_EDGE_4];
  const summary = calculateGraphEdgeCoverage({
    edges,
    nodes: [MOCK_NODE_1, MOCK_NODE_2, MOCK_NODE_3],
    analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
  });

  assert.equal(summary.total, 2);
  assert.equal(summary.covered, 0);
  assert.equal(summary.uncovered, 2);
  assert.equal(summary.percentage, 0);
  assert.equal(summary.formattedPercentage, "0%");
  assert.equal(summary.isFullCoverage, false);
  assert.equal(summary.isZeroCoverage, true);
});

test("A5. calculateGraphEdgeCoverage handles zero analyzed subjects (empty slice)", () => {
  const summary = calculateGraphEdgeCoverage({
    edges: [],
    nodes: [],
    analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
  });

  assert.equal(summary.total, 0);
  assert.equal(summary.covered, 0);
  assert.equal(summary.uncovered, 0);
  assert.equal(summary.percentage, 0);
  assert.equal(summary.formattedPercentage, "N/A");
  assert.equal(summary.isEmptyScope, true);
  assert.equal(summary.isFullCoverage, false);
  assert.equal(summary.isZeroCoverage, false);
  assert.match(summary.accessibleLabel, /0 analyzed graph edges/);
});

// ============================================================================
// Section B: Scope Isolation & Integrity Tests
// ============================================================================

test("B1. Scope labels identify the specific analysis run without mixing runs", () => {
  const run1 = "11111111-1111-1111-1111-111111111111";
  const run2 = "22222222-2222-2222-2222-222222222222";

  const summary1 = calculateGraphEdgeCoverage({
    edges: [MOCK_COVERED_EDGE_1],
    analysisRunId: run1,
    repositoryName: "fluxora/core",
    commitSha: "abc1234",
    gitRef: "main",
  });

  const summary2 = calculateGraphEdgeCoverage({
    edges: [MOCK_UNCOVERED_EDGE_3],
    analysisRunId: run2,
    repositoryName: "fluxora/core",
    commitSha: "def5678",
    gitRef: "feat/payments",
  });

  assert.equal(summary1.analysisRunId, run1);
  assert.equal(summary2.analysisRunId, run2);
  assert.match(summary1.scopeLabel, /11111111/);
  assert.match(summary2.scopeLabel, /22222222/);
  assert.equal(summary1.covered, 1);
  assert.equal(summary2.covered, 0);
});

test("B2. Graph edges and PR impact findings maintain distinct denominators", () => {
  const edges = [MOCK_COVERED_EDGE_1, MOCK_UNCOVERED_EDGE_3]; // 2 edges, 1 covered
  const mockImpact: ImpactAnalysisResponse = {
    id: "impact-1",
    pull_request_id: "pr-1",
    analysis_run_id: "run-1",
    status: "completed",
    direct_impact: [
      {
        node_id: "node-user-service",
        name: "UserService",
        type: "service",
        depth: 0,
        hop_distance: 0,
        confidence: 1.0,
        path: ["node-user-service"],
        evidence_ids: ["ev-1", "ev-2"],
        evidence_id: "ev-1",
      },
    ],
    downstream_impact: [],
    affected_apis: [],
    affected_events: [],
    affected_services: [],
    workflow_impact_summary: [],
    unresolved_files: [],
    truncated: false,
    truncation_reason: null,
    max_depth_reached: 1,
    execution_metrics: {
      total_seed_nodes: 1,
      total_affected_nodes: 1,
      total_edges_traversed: 1,
      duration_ms: 10,
    },
    created_at: new Date().toISOString(),
  };

  const changeModeState = normalizeImpactAnalysisResponse(mockImpact, { enabled: true });

  const edgeSummary = calculateGraphEdgeCoverage({
    edges,
    analysisRunId: "run-1",
  });

  const impactSummary = calculateImpactFindingCoverage({
    changeModeState,
    analysisRunId: "run-1",
  });

  // Edge summary: denominator is 2
  assert.equal(edgeSummary.subjectType, "graph_edge");
  assert.equal(edgeSummary.total, 2);
  assert.equal(edgeSummary.covered, 1);
  assert.equal(edgeSummary.percentage, 50);

  // Impact summary: denominator is 1
  assert.equal(impactSummary.subjectType, "impact_finding");
  assert.equal(impactSummary.total, 1);
  assert.equal(impactSummary.covered, 1);
  assert.equal(impactSummary.percentage, 100);

  // They are never mixed!
  assert.notEqual(edgeSummary.total, impactSummary.total);
});

// ============================================================================
// Section C: Category Coverage Breakdown Tests
// ============================================================================

test("C1. Categories breakdown groups graph edges by edge type deterministically", () => {
  const edges = [
    MOCK_COVERED_EDGE_1, // IMPORTS, covered
    MOCK_COVERED_EDGE_2, // QUERIES_DB, covered
    MOCK_UNCOVERED_EDGE_3, // CALLS, uncovered
    MOCK_UNCOVERED_EDGE_4, // CALLS, uncovered
  ];

  const summary = calculateGraphEdgeCoverage({
    edges,
    analysisRunId: "run-1",
  });

  assert.equal(summary.categories.length, 3);
  const callsCategory = summary.categories.find((c) => c.id === "CALLS");
  const importsCategory = summary.categories.find((c) => c.id === "IMPORTS");
  const queriesDbCategory = summary.categories.find((c) => c.id === "QUERIES_DB");

  assert.ok(callsCategory);
  assert.equal(callsCategory.total, 2);
  assert.equal(callsCategory.covered, 0);
  assert.equal(callsCategory.uncovered, 2);
  assert.equal(callsCategory.percentage, 0);

  assert.ok(importsCategory);
  assert.equal(importsCategory.total, 1);
  assert.equal(importsCategory.covered, 1);
  assert.equal(importsCategory.uncovered, 0);
  assert.equal(importsCategory.percentage, 100);

  assert.ok(queriesDbCategory);
  assert.equal(queriesDbCategory.total, 1);
  assert.equal(queriesDbCategory.covered, 1);
  assert.equal(queriesDbCategory.percentage, 100);
});

test("C2. Categories breakdown groups impact findings across the 5 authoritative categories", () => {
  const mockImpact: ImpactAnalysisResponse = {
    id: "impact-categories-test",
    pull_request_id: "pr-1",
    analysis_run_id: "run-1",
    status: "completed",
    direct_impact: [
      {
        node_id: "node-1",
        name: "LoginHandler",
        type: "symbol",
        depth: 0,
        hop_distance: 0,
        confidence: 1.0,
        path: ["node-1"],
        evidence_ids: ["ev-1"],
        evidence_id: "ev-1",
      },
    ],
    downstream_impact: [
      {
        node_id: "node-2",
        name: "AuthService",
        type: "service",
        depth: 1,
        hop_distance: 1,
        confidence: 0.9,
        path: ["node-1", "node-2"],
        evidence_ids: [],
        evidence_id: null, // Uncovered downstream
      },
    ],
    affected_apis: [
      {
        node_id: "node-3",
        name: "POST /login",
        type: "api",
        depth: 1,
        hop_distance: 1,
        confidence: 0.9,
        path: ["node-1", "node-3"],
        evidence_ids: ["ev-api-1"],
        evidence_id: "ev-api-1",
      },
    ],
    affected_events: [],
    affected_services: [
      {
        node_id: "node-4",
        name: "BillingService",
        type: "service",
        depth: 2,
        hop_distance: 2,
        confidence: 0.81,
        path: ["node-1", "node-2", "node-4"],
        evidence_ids: ["ev-service-1"],
        evidence_id: "ev-service-1",
      },
    ],
    workflow_impact_summary: [],
    unresolved_files: [{ path: "docs/README.md", reason: "Non-code file" }],
    truncated: false,
    truncation_reason: null,
    max_depth_reached: 2,
    execution_metrics: {
      total_seed_nodes: 1,
      total_affected_nodes: 4,
      total_edges_traversed: 4,
      duration_ms: 25,
    },
    created_at: new Date().toISOString(),
  };

  const changeMode = normalizeImpactAnalysisResponse(mockImpact, { enabled: true });
  const summary = calculateImpactFindingCoverage({ changeModeState: changeMode });

  assert.equal(summary.total, 4);
  assert.equal(summary.covered, 3);
  assert.equal(summary.uncovered, 1);
  assert.equal(summary.percentage, 75);
  assert.equal(summary.unresolvedFilesCount, 1);

  // Categories present: direct (1/1), downstream (0/1), api (1/1), service (1/1). Events empty -> omitted
  assert.equal(summary.categories.length, 4);

  const directCat = summary.categories.find((c) => c.id === "direct");
  assert.ok(directCat);
  assert.equal(directCat.covered, 1);
  assert.equal(directCat.total, 1);

  const downCat = summary.categories.find((c) => c.id === "downstream");
  assert.ok(downCat);
  assert.equal(downCat.covered, 0);
  assert.equal(downCat.total, 1);
  assert.equal(downCat.uncovered, 1);
});

// ============================================================================
// Section D: Missing Evidence & Critical Distinction (Confidence vs Coverage)
// ============================================================================

test("D1. High confidence without evidence is strictly UNCOVERED", () => {
  // MOCK_UNCOVERED_EDGE_3 has confidence 0.95 (High tier) but evidence_id is null
  assert.equal(MOCK_UNCOVERED_EDGE_3.confidence, 0.95);
  assert.equal(isGraphEdgeCovered(MOCK_UNCOVERED_EDGE_3), false);

  const summary = calculateGraphEdgeCoverage({
    edges: [MOCK_UNCOVERED_EDGE_3],
    analysisRunId: "run-test",
  });

  assert.equal(summary.covered, 0);
  assert.equal(summary.uncovered, 1);
  assert.equal(summary.uncoveredEdges.length, 1);
  assert.equal(summary.uncoveredEdges[0]?.id, MOCK_UNCOVERED_EDGE_3.id);
});

test("D2. Low confidence with evidence is strictly COVERED", () => {
  const lowConfWithEvidence: GraphQueryResponseEdge = {
    id: "edge-low-covered",
    source: "node-1",
    target: "node-2",
    type: "CALLS",
    confidence: 0.35, // Low confidence tier (<0.70)
    provenance: "heuristic",
    evidence_id: "ev-low-conf",
  };

  assert.equal(isGraphEdgeCovered(lowConfWithEvidence), true);

  const findingWithEvidence = {
    node_id: "node-1",
    name: "LowConfFinding",
    type: "service",
    depth: 3,
    hop_distance: 3,
    confidence: 0.25,
    path: ["node-0", "node-1"],
    evidence_ids: ["ev-finding-1"],
    evidence_id: "ev-finding-1",
  };
  assert.equal(isImpactFindingCovered(findingWithEvidence), true);

  const findingWithoutEvidence = {
    node_id: "node-2",
    name: "HighConfUncoveredFinding",
    type: "service",
    depth: 0,
    hop_distance: 0,
    confidence: 1.0,
    path: ["node-2"],
    evidence_ids: [],
    evidence_id: null,
  };
  assert.equal(isImpactFindingCovered(findingWithoutEvidence), false);

  const summary = calculateGraphEdgeCoverage({
    edges: [lowConfWithEvidence],
    analysisRunId: "run-test",
  });

  assert.equal(summary.covered, 1);
  assert.equal(summary.uncovered, 0);
  assert.equal(summary.isFullCoverage, true);
});

test("D3. Deterministic ordering of uncovered graph edges and impact findings", () => {
  const edgeA: GraphQueryResponseEdge = {
    id: "edge-b-calls",
    source: "node-beta",
    target: "node-alpha",
    type: "CALLS",
    confidence: 0.8,
    provenance: "static",
    evidence_id: null,
  };
  const edgeB: GraphQueryResponseEdge = {
    id: "edge-a-calls",
    source: "node-alpha",
    target: "node-gamma",
    type: "CALLS",
    confidence: 0.8,
    provenance: "static",
    evidence_id: null,
  };
  const edgeC: GraphQueryResponseEdge = {
    id: "edge-imports",
    source: "node-zeta",
    target: "node-omega",
    type: "IMPORTS",
    confidence: 0.8,
    provenance: "static",
    evidence_id: null,
  };

  const summary = calculateGraphEdgeCoverage({
    edges: [edgeA, edgeB, edgeC],
    nodes: [
      { id: "node-beta", name: "Beta", type: "module", canonical_id: "b", depth: 0, confidence: 1 },
      { id: "node-alpha", name: "Alpha", type: "module", canonical_id: "a", depth: 0, confidence: 1 },
      { id: "node-gamma", name: "Gamma", type: "module", canonical_id: "g", depth: 0, confidence: 1 },
      { id: "node-zeta", name: "Zeta", type: "module", canonical_id: "z", depth: 0, confidence: 1 },
      { id: "node-omega", name: "Omega", type: "module", canonical_id: "o", depth: 0, confidence: 1 },
    ],
    analysisRunId: "run-order",
  });

  // CALLS sorted before IMPORTS
  // Among CALLS: Alpha -> Gamma sorted before Beta -> Alpha
  assert.equal(summary.uncoveredEdges[0]?.id, "edge-a-calls");
  assert.equal(summary.uncoveredEdges[1]?.id, "edge-b-calls");
  assert.equal(summary.uncoveredEdges[2]?.id, "edge-imports");
});

// ============================================================================
// Section E: Component Rendering & UI States Tests
// ============================================================================

test("E1. AnalysisCoverageBar renders summary metrics, progress bar, and badge", () => {
  const edges = [MOCK_COVERED_EDGE_1, MOCK_UNCOVERED_EDGE_3];
  const html = renderToStaticMarkup(
    React.createElement(AnalysisCoverageBar, {
      edges,
      nodes: [MOCK_NODE_1, MOCK_NODE_2, MOCK_NODE_3],
      analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
      repositoryName: "fluxora/core",
      commitSha: "abc1234",
    }),
  );

  assert.match(html, /data-testid="analysis-coverage-bar"/);
  assert.match(html, /data-testid="coverage-percentage-badge"/);
  assert.match(html, /50%/);
  assert.match(html, /data-testid="coverage-covered-count"/);
  assert.match(html, /data-testid="coverage-uncovered-count"/);
  assert.match(html, /data-testid="coverage-total-count"/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="50"/);
});

test("E2. AnalysisCoverageBar renders 100% full coverage with complete styling", () => {
  const edges = [MOCK_COVERED_EDGE_1, MOCK_COVERED_EDGE_2];
  const html = renderToStaticMarkup(
    React.createElement(AnalysisCoverageBar, {
      edges,
      nodes: [MOCK_NODE_1, MOCK_NODE_2, MOCK_NODE_3],
      analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
      initialExpanded: true,
    }),
  );

  assert.match(html, /100%/);
  assert.match(html, /data-testid="coverage-all-covered-message"/);
  assert.match(html, /All analyzed conclusions have verified evidence/);
});

test("E3. AnalysisCoverageBar renders empty graph scope state without fake percentage", () => {
  const html = renderToStaticMarkup(
    React.createElement(AnalysisCoverageBar, {
      edges: [],
      nodes: [],
      analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
    }),
  );

  assert.match(html, /data-testid="analysis-coverage-bar"/);
  assert.match(html, /N\/A/);
  assert.match(html, /Covered:.*0/);
  assert.match(html, /Total:.*0/);
});

test("E4. AnalysisCoverageBar renders loading state cleanly", () => {
  const html = renderToStaticMarkup(
    React.createElement(AnalysisCoverageBar, {
      isLoading: true,
      analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
    }),
  );

  assert.match(html, /Loading\.\.\./);
});

test("E5. AnalysisCoverageBar renders error/unavailable state cleanly", () => {
  const html = renderToStaticMarkup(
    React.createElement(AnalysisCoverageBar, {
      errorMessage: "Network timeout connecting to server.",
      analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
    }),
  );

  assert.match(html, /Network timeout connecting to server\./);
});

test("E6. AnalysisCoverageBar renders refreshing/stale indicator badge", () => {
  const html = renderToStaticMarkup(
    React.createElement(AnalysisCoverageBar, {
      edges: [MOCK_COVERED_EDGE_1],
      analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
      isRefreshing: true,
    }),
  );

  assert.match(html, /data-testid="coverage-stale-badge"/);
  assert.match(html, /Refreshing\.\.\./);
});

// ============================================================================
// Section F: Expanded Drawer, Category Details & Item Inspection Tests
// ============================================================================

test("F1. Expanded panel lists categories and uncovered edge items with inspect action", () => {
  const edges = [MOCK_COVERED_EDGE_1, MOCK_UNCOVERED_EDGE_3];
  const html = renderToStaticMarkup(
    React.createElement(AnalysisCoverageBar, {
      edges,
      nodes: [MOCK_NODE_1, MOCK_NODE_2, MOCK_NODE_3],
      analysisRunId: "550e8400-e29b-41d4-a716-446655440000",
      initialExpanded: true,
      onSelectEdge: () => {},
    }),
  );

  assert.match(html, /data-testid="coverage-expanded-panel"/);
  assert.match(html, /data-testid="coverage-categories-section"/);
  assert.match(html, /data-testid="coverage-category-CALLS"/);
  assert.match(html, /data-testid="coverage-category-IMPORTS"/);
  assert.match(html, /data-testid="coverage-uncovered-item"/);
  assert.match(html, /data-testid="inspect-uncovered-edge-button"/);
  assert.match(html, /Inspect in Graph/);
  assert.match(html, /Missing Evidence/);
});

test("F2. Surface selector tabs switch between Graph Edges and PR Impact findings", () => {
  const mockImpact: ImpactAnalysisResponse = {
    id: "impact-pr-tabs",
    pull_request_id: "pr-42",
    analysis_run_id: "run-42",
    status: "completed",
    direct_impact: [
      {
        node_id: "node-user-service",
        name: "UserService",
        type: "service",
        depth: 0,
        hop_distance: 0,
        confidence: 1.0,
        path: ["node-user-service"],
        evidence_ids: ["ev-1"],
        evidence_id: "ev-1",
      },
    ],
    downstream_impact: [],
    affected_apis: [],
    affected_events: [],
    affected_services: [],
    workflow_impact_summary: [],
    unresolved_files: [],
    truncated: false,
    truncation_reason: null,
    max_depth_reached: 1,
    execution_metrics: {
      total_seed_nodes: 1,
      total_affected_nodes: 1,
      total_edges_traversed: 1,
      duration_ms: 5,
    },
    created_at: new Date().toISOString(),
  };

  const changeMode = normalizeImpactAnalysisResponse(mockImpact, { enabled: true });

  const html = renderToStaticMarkup(
    React.createElement(AnalysisCoverageBar, {
      edges: [MOCK_COVERED_EDGE_1, MOCK_UNCOVERED_EDGE_3],
      changeModeState: changeMode,
      analysisRunId: "run-42",
    }),
  );

  assert.match(html, /data-testid="coverage-tab-graph"/);
  assert.match(html, /data-testid="coverage-tab-impact"/);
  assert.match(html, /Graph Edges/);
  assert.match(html, /PR Impact Findings/);
});

// ============================================================================
// Section G: Accessibility Tests
// ============================================================================

test("G1. Coverage is fully understandable without color alone", () => {
  const summary = calculateGraphEdgeCoverage({
    edges: [MOCK_COVERED_EDGE_1, MOCK_UNCOVERED_EDGE_3],
    analysisRunId: "run-1",
  });

  // Text includes exact numbers and words
  assert.equal(
    summary.accessibleLabel,
    "Evidence coverage: 50%, 1 of 2 analyzed conclusions have evidence.",
  );

  const html = renderToStaticMarkup(
    React.createElement(AnalysisCoverageBar, {
      edges: [MOCK_COVERED_EDGE_1, MOCK_UNCOVERED_EDGE_3],
      analysisRunId: "run-1",
      initialExpanded: true,
    }),
  );

  // Verifies explicit text chips: "Covered: 1", "Missing: 1", "Total: 2", "50%"
  assert.match(html, /Covered:.*1/);
  assert.match(html, /Missing:.*1/);
  assert.match(html, /Total:.*2/);
  assert.match(html, /50%/);
  // Verifies semantic ARIA progressbar
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="50"/);
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="100"/);
});

// ============================================================================
// Section H: NodeInspectorPanel Edge Coverage Integration Tests
// ============================================================================

test("H1. NodeInspectorPanel surfaces explicit coverage status for inspected edges", () => {
  // Inspected edge WITH evidence -> Covered
  const coveredHtml = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      edge: MOCK_COVERED_EDGE_1,
      evidence: [
        {
          id: "ev-edge-1",
          subject_type: "graph_edge",
          subject_id: "edge-1",
          file_path: "src/user.ts",
          line_start: 10,
          line_end: 20,
          relationship_description: "imports auth",
          confidence: 1.0,
        },
      ],
      analysisRunId: "run-1",
    }),
  );

  assert.match(coveredHtml, /data-testid="inspector-edge-coverage-status"/);
  assert.match(coveredHtml, /data-coverage-status="covered"/);
  assert.match(coveredHtml, /Covered/);

  // Inspected edge WITHOUT evidence -> Missing Evidence (Uncovered)
  const uncoveredHtml = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      edge: MOCK_UNCOVERED_EDGE_3,
      evidence: [],
      analysisRunId: "run-1",
    }),
  );

  assert.match(uncoveredHtml, /data-testid="inspector-edge-coverage-status"/);
  assert.match(uncoveredHtml, /data-coverage-status="uncovered"/);
  assert.match(uncoveredHtml, /Missing Evidence/);
});
