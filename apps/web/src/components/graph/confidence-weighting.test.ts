import { test } from "vitest";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  GraphQueryResponseEdge,
  GraphQueryResponseEvidence,
  GraphQueryResponseNode,
  ImpactAnalysisResponse,
} from "@fluxora/shared-types";
import {
  CONFIDENCE_THRESHOLDS,
  computeEdgeConfidenceStyles,
  normalizeConfidence,
  type NormalizedConfidence,
} from "./confidence-data.ts";
import {
  mapDomainGraphToFlow,
  type CanvasInputEdge,
  type CanvasInputNode,
} from "./graph-mapping.ts";
import {
  EvidenceCitation,
  EvidenceCitationList,
} from "./EvidenceCitation.tsx";
import {
  NodeInspectorPanel,
} from "./node-inspector-data.ts";
import {
  ChangeModeBar,
} from "./ChangeModeBar.tsx";
import {
  normalizeImpactAnalysisResponse,
} from "./change-mode-data.ts";

// ============================================================================
// Section A: Confidence Representation & Normalization Tests
// ============================================================================

test("normalizeConfidence preserves raw authoritative values and computes correct percentages", () => {
  const high = normalizeConfidence(0.98);
  assert.ok(high);
  assert.equal(high.raw, 0.98);
  assert.equal(high.value, 0.98);
  assert.equal(high.percentage, 98);
  assert.equal(high.formattedPercentage, "98%");
  assert.equal(high.tier, "high");
  assert.equal(high.label, "High confidence");
  assert.equal(high.accessibleLabel, "High confidence, 98 percent");

  const perfect = normalizeConfidence(1.0);
  assert.ok(perfect);
  assert.equal(perfect.percentage, 100);
  assert.equal(perfect.tier, "high");

  const zero = normalizeConfidence(0.0);
  assert.ok(zero);
  assert.equal(zero.percentage, 0);
  assert.equal(zero.tier, "low");
});

test("normalizeConfidence maps tiers deterministically across architectural thresholds", () => {
  // Threshold High: >= 0.90
  const highExact = normalizeConfidence(CONFIDENCE_THRESHOLDS.HIGH);
  assert.ok(highExact);
  assert.equal(highExact.tier, "high");

  const highAbove = normalizeConfidence(0.95);
  assert.ok(highAbove);
  assert.equal(highAbove.tier, "high");

  // Threshold Medium: >= 0.70 and < 0.90
  const medBelowHigh = normalizeConfidence(0.899);
  assert.ok(medBelowHigh);
  assert.equal(medBelowHigh.tier, "medium");
  assert.equal(medBelowHigh.label, "Medium confidence");

  const medExact = normalizeConfidence(CONFIDENCE_THRESHOLDS.MEDIUM);
  assert.ok(medExact);
  assert.equal(medExact.tier, "medium");

  // Threshold Low: < 0.70
  const lowBelowMed = normalizeConfidence(0.699);
  assert.ok(lowBelowMed);
  assert.equal(lowBelowMed.tier, "low");
  assert.equal(lowBelowMed.label, "Low confidence");

  const lowMinimal = normalizeConfidence(0.15);
  assert.ok(lowMinimal);
  assert.equal(lowMinimal.tier, "low");
});

test("normalizeConfidence returns null for missing or invalid confidence without fabricating values", () => {
  assert.equal(normalizeConfidence(undefined), null);
  assert.equal(normalizeConfidence(null), null);
  assert.equal(normalizeConfidence(Number.NaN), null);
  assert.equal(normalizeConfidence(Number.POSITIVE_INFINITY), null);
  assert.equal(normalizeConfidence(Number.NEGATIVE_INFINITY), null);
  assert.equal(normalizeConfidence("0.95" as unknown), null);
  assert.equal(normalizeConfidence({} as unknown), null);
});

test("normalizeConfidence safely handles out-of-contract numerical bounds", () => {
  // Negative values: clamped for visual math, raw preserved
  const negative = normalizeConfidence(-0.25);
  assert.ok(negative);
  assert.equal(negative.raw, -0.25);
  assert.equal(negative.value, 0);
  assert.equal(negative.percentage, 0);
  assert.equal(negative.tier, "low");

  // Overflow values: clamped for visual math, raw preserved
  const overflow = normalizeConfidence(1.35);
  assert.ok(overflow);
  assert.equal(overflow.raw, 1.35);
  assert.equal(overflow.value, 1);
  assert.equal(overflow.percentage, 100);
  assert.equal(overflow.tier, "high");
});

// ============================================================================
// Section B: Graph Edge Visual Weighting Tests
// ============================================================================

test("computeEdgeConfidenceStyles produces monotonic visual weighting across tiers", () => {
  const highStyles = computeEdgeConfidenceStyles(0.95);
  const medStyles = computeEdgeConfidenceStyles(0.80);
  const lowStyles = computeEdgeConfidenceStyles(0.50);

  // Stroke width is strictly monotonic: High > Medium > Low
  assert.ok(highStyles.strokeWidth > medStyles.strokeWidth);
  assert.ok(medStyles.strokeWidth > lowStyles.strokeWidth);

  // Opacity is strictly monotonic: High > Medium > Low
  assert.ok(highStyles.opacity > medStyles.opacity);
  assert.ok(medStyles.opacity > lowStyles.opacity);

  // Solid lines for High and Medium, distinct dashed pattern for Low
  assert.equal(highStyles.strokeDasharray, undefined);
  assert.equal(medStyles.strokeDasharray, undefined);
  assert.equal(lowStyles.strokeDasharray, "4 4");

  // High confidence has prominent darker stroke
  assert.equal(highStyles.stroke, "#64748b");
  assert.equal(medStyles.stroke, "#94a3b8");
  assert.equal(lowStyles.stroke, "#94a3b8");
});

test("Low-confidence edges remain visible, non-zero, and structurally intact", () => {
  const lowStyles = computeEdgeConfidenceStyles(0.40);
  // Visually perceptible opacity (never 0)
  assert.ok(lowStyles.opacity >= 0.5);
  // Visible stroke width (never 0)
  assert.ok(lowStyles.strokeWidth >= 1.0);
  assert.ok(lowStyles.stroke.length > 0);
});

test("computeEdgeConfidenceStyles handles missing confidence with neutral defaults", () => {
  const defaultStyles = computeEdgeConfidenceStyles(undefined);
  assert.equal(defaultStyles.stroke, "#94a3b8");
  assert.equal(defaultStyles.strokeWidth, 1.5);
  assert.equal(defaultStyles.opacity, 0.85);
  assert.equal(defaultStyles.strokeDasharray, undefined);
});

test("Selected edge state takes absolute visual priority over confidence weighting", () => {
  const selectedLow = computeEdgeConfidenceStyles(0.40, { isSelected: true });
  assert.equal(selectedLow.stroke, "#3b82f6");
  assert.equal(selectedLow.strokeWidth, 3);
  assert.equal(selectedLow.opacity, 1.0);

  const selectedHigh = computeEdgeConfidenceStyles(1.0, { isSelected: true });
  assert.equal(selectedHigh.stroke, "#3b82f6");
  assert.equal(selectedHigh.strokeWidth, 3);
  assert.equal(selectedHigh.opacity, 1.0);
});

test("mapDomainGraphToFlow applies confidence-based visual styles and accessible ariaLabel to edges", () => {
  const nodes: CanvasInputNode[] = [
    { id: "node-a", name: "A", nodeType: "module", confidence: 1.0 },
    { id: "node-b", name: "B", nodeType: "module", confidence: 1.0 },
    { id: "node-c", name: "C", nodeType: "module", confidence: 1.0 },
    { id: "node-d", name: "D", nodeType: "module", confidence: 1.0 },
  ];

  const edges: CanvasInputEdge[] = [
    {
      id: "edge-high",
      source: "node-a",
      target: "node-b",
      edgeType: "IMPORTS",
      confidence: 0.95,
    },
    {
      id: "edge-low",
      source: "node-c",
      target: "node-d",
      edgeType: "CALLS",
      confidence: 0.55,
    },
    {
      id: "edge-unspecified",
      source: "node-a",
      target: "node-c",
      edgeType: "RESOLVES_TO",
      // No confidence provided
    },
  ];

  const result = mapDomainGraphToFlow(nodes, edges);
  assert.equal(result.edges.length, 3);

  const highEdge = result.edges.find((e) => e.id === "edge-high");
  assert.ok(highEdge);
  assert.equal(highEdge.style?.strokeWidth, 2.0);
  assert.equal(highEdge.style?.opacity, 1.0);
  assert.equal(highEdge.style?.strokeDasharray, undefined);
  assert.match(highEdge.ariaLabel ?? "", /IMPORTS edge from node-a to node-b, High confidence, 95 percent/);
  const highData = highEdge.data as { normalizedConfidence?: NormalizedConfidence | null } | undefined;
  assert.equal(highData?.normalizedConfidence?.tier, "high");

  const lowEdge = result.edges.find((e) => e.id === "edge-low");
  assert.ok(lowEdge);
  assert.equal(lowEdge.style?.strokeWidth, 1.25);
  assert.equal(lowEdge.style?.opacity, 0.65);
  assert.equal(lowEdge.style?.strokeDasharray, "4 4");
  assert.match(lowEdge.ariaLabel ?? "", /CALLS edge from node-c to node-d, Low confidence, 55 percent/);
  const lowData = lowEdge.data as { normalizedConfidence?: NormalizedConfidence | null } | undefined;
  assert.equal(lowData?.normalizedConfidence?.tier, "low");

  const unspecEdge = result.edges.find((e) => e.id === "edge-unspecified");
  assert.ok(unspecEdge);
  assert.equal(unspecEdge.style?.strokeWidth, 1.5);
  assert.equal(unspecEdge.style?.opacity, 0.85);
  assert.equal(unspecEdge.style?.strokeDasharray, undefined);
  assert.equal(unspecEdge.ariaLabel, "RESOLVES_TO edge from node-a to node-c");
  const unspecData = unspecEdge.data as { normalizedConfidence?: NormalizedConfidence | null } | undefined;
  assert.equal(unspecData?.normalizedConfidence, null);
});

// ============================================================================
// Section C: Node Confidence Presentation & Invariant Tests
// ============================================================================

test("Node inspector displays authoritative node confidence with tier and accessibility metadata", () => {
  const mockNodeWithConfidence: GraphQueryResponseNode = {
    id: "node-sample",
    type: "module",
    name: "auth-service.ts",
    canonical_id: "mod:src/auth.ts",
    depth: 1,
    confidence: 0.85, // Medium confidence
    path: "src/auth.ts",
  };

  const html = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: mockNodeWithConfidence,
      evidence: [],
    }),
  );

  assert.match(html, /data-testid="inspector-node-confidence"/);
  assert.match(html, /85%/);
  assert.match(html, /data-confidence-tier="medium"/);
  assert.match(html, /aria-label="Medium confidence, 85 percent"/);
  assert.match(html, /medium/);
});

test("Node inspector does not invent confidence when node has default 1.0 confidence", () => {
  const perfectNode: GraphQueryResponseNode = {
    id: "node-perfect",
    type: "symbol",
    name: "perfectSymbol",
    canonical_id: "sym:src/index.ts#perfectSymbol:1",
    depth: 0,
    confidence: 1.0,
  };

  const html = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: perfectNode,
      evidence: [],
    }),
  );

  assert.match(html, /data-testid="inspector-node-confidence"/);
  assert.match(html, /100%/);
  // Tier badge is omitted when node confidence is 1.0 (standard compiler certainty)
  assert.ok(!html.includes('class="text-[10px] font-mono px-1.5 py-0.2 rounded border bg-slate-100'));
});

// ============================================================================
// Section D: Impact Findings Visual Weighting Tests
// ============================================================================

test("ChangeModeBar findings panel renders distinct confidence chips and tier styling for each finding", () => {
  const mockImpact: ImpactAnalysisResponse = {
    id: "impact-50-test",
    pull_request_id: "pr-50",
    analysis_run_id: "run-50",
    status: "completed",
    direct_impact: [
      {
        node_id: "node-direct-high",
        name: "directHigh",
        type: "symbol",
        depth: 0,
        hop_distance: 0,
        confidence: 1.0, // High
        path: ["node-direct-high"],
        evidence_ids: [],
        evidence_id: null,
      },
    ],
    downstream_impact: [
      {
        node_id: "node-downstream-med",
        name: "downstreamMed",
        type: "symbol",
        depth: 1,
        hop_distance: 1,
        confidence: 0.81, // Medium
        path: ["node-direct-high", "node-downstream-med"],
        evidence_ids: [],
        evidence_id: null,
      },
      {
        node_id: "node-downstream-low",
        name: "downstreamLow",
        type: "symbol",
        depth: 3,
        hop_distance: 3,
        confidence: 0.59, // Low
        path: ["node-direct-high", "node-downstream-med", "node-downstream-low"],
        evidence_ids: [],
        evidence_id: null,
      },
    ],
    affected_apis: [
      {
        node_id: "node-api-finding",
        name: "GET /api/v1/orders",
        type: "api",
        depth: 2,
        hop_distance: 2,
        confidence: 0.73, // Medium
        path: ["node-api-finding"],
        evidence_ids: [],
        evidence_id: null,
      },
    ],
    affected_events: [
      {
        node_id: "node-event-finding",
        name: "OrderCompleted",
        type: "event",
        depth: 1,
        hop_distance: 1,
        confidence: 0.90, // High
        path: ["node-event-finding"],
        evidence_ids: [],
        evidence_id: null,
      },
    ],
    affected_services: [
      {
        node_id: "node-service-finding",
        name: "billing-service",
        type: "service",
        depth: 2,
        hop_distance: 2,
        confidence: 0.65, // Low
        path: ["node-service-finding"],
        evidence_ids: [],
        evidence_id: null,
      },
    ],
    workflow_impact_summary: [],
    unresolved_files: [],
    truncated: false,
    truncation_reason: null,
    max_depth_reached: 3,
    execution_metrics: {
      total_seed_nodes: 1,
      total_affected_nodes: 5,
      total_edges_traversed: 4,
      duration_ms: 12,
    },
    evidence: [],
    created_at: new Date().toISOString(),
  };

  const normalized = normalizeImpactAnalysisResponse(mockImpact, { enabled: true });

  const html = renderToStaticMarkup(
    React.createElement(ChangeModeBar, {
      state: normalized,
      initialShowFindings: true,
      onToggle: () => {},
      onLoadAnalysis: () => {},
      onRetry: () => {},
      onClear: () => {},
      repositoryName: "acme/fluxora",
      commitSha: "commit-step-50",
    }),
  );

  // Toggle button shows "Hide Citations" when panel is expanded
  assert.match(html, /Hide Citations/);

  // Assert findings panel is rendered with confidence chips and tier styling
  assert.match(html, /data-testid="impact-findings-panel"/);

  // Direct finding with 100% confidence
  assert.match(html, /data-testid="finding-confidence-node-direct-high"/);
  assert.match(html, /100%/);
  assert.match(html, /data-confidence-tier="high"/);

  // Downstream findings with medium (81%) and low (59%) confidence
  assert.match(html, /data-testid="finding-confidence-node-downstream-med"/);
  assert.match(html, /81%/);
  assert.match(html, /data-confidence-tier="medium"/);

  assert.match(html, /data-testid="finding-confidence-node-downstream-low"/);
  assert.match(html, /59%/);
  assert.match(html, /data-confidence-tier="low"/);

  // API finding with medium (73%) confidence
  assert.match(html, /data-testid="finding-confidence-node-api-finding"/);
  assert.match(html, /73%/);

  // Event finding with high (90%) confidence
  assert.match(html, /data-testid="finding-confidence-node-event-finding"/);
  assert.match(html, /90%/);

  // Service finding with low (65%) confidence
  assert.match(html, /data-testid="finding-confidence-node-service-finding"/);
  assert.match(html, /65%/);

  // Assert legend includes edge confidence guidance
  assert.match(html, /High Conf Edge/);
  assert.match(html, /Low Conf Edge/);
});

test("Impact findings preserve deterministic ordering regardless of confidence score", () => {
  // Test ordering rule: Direct findings come first, followed by downstream, APIs, events, services
  // High confidence downstream finding must NOT leapfrog earlier findings
  const mockImpact: ImpactAnalysisResponse = {
    id: "impact-ordering",
    pull_request_id: "pr-ord",
    analysis_run_id: "run-ord",
    status: "completed",
    direct_impact: [
      {
        node_id: "node-direct-low-conf",
        name: "directLow",
        type: "symbol",
        depth: 0,
        hop_distance: 0,
        confidence: 0.50, // Direct with low confidence
        path: ["node-direct-low-conf"],
        evidence_ids: [],
        evidence_id: null,
      },
    ],
    downstream_impact: [
      {
        node_id: "node-downstream-high-conf",
        name: "downstreamHigh",
        type: "symbol",
        depth: 1,
        hop_distance: 1,
        confidence: 0.99, // Downstream with high confidence
        path: ["node-direct-low-conf", "node-downstream-high-conf"],
        evidence_ids: [],
        evidence_id: null,
      },
    ],
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
      total_affected_nodes: 2,
      total_edges_traversed: 1,
      duration_ms: 5,
    },
    created_at: new Date().toISOString(),
  };

  const normalized = normalizeImpactAnalysisResponse(mockImpact, { enabled: true });
  assert.equal(normalized.directImpactFindings[0]?.node_id, "node-direct-low-conf");
  assert.equal(normalized.downstreamImpactFindings[0]?.node_id, "node-downstream-high-conf");
});

// ============================================================================
// Section E: EvidenceCitation Integration Tests
// ============================================================================

test("EvidenceCitation displays confidence chip and accessibility label when confidence is present", () => {
  const evWithConfidence: GraphQueryResponseEvidence = {
    id: "ev-step-50-high",
    subject_type: "graph_edge",
    subject_id: "edge-123",
    file_path: "src/service.ts",
    line_start: 10,
    line_end: 20,
    relationship_description: "Calls database",
    confidence: 0.92,
  };

  // Compact mode
  const htmlCompact = renderToStaticMarkup(
    React.createElement(EvidenceCitation, {
      evidence: evWithConfidence,
      mode: "compact",
      repositoryName: "acme/fluxora",
      commitSha: "sha12345",
    }),
  );

  assert.match(htmlCompact, /data-testid="citation-confidence-chip"/);
  assert.match(htmlCompact, /92%/);
  assert.match(htmlCompact, /data-confidence-tier="high"/);
  assert.match(htmlCompact, /aria-label="High confidence, 92 percent"/);

  // Expanded mode
  const htmlExpanded = renderToStaticMarkup(
    React.createElement(EvidenceCitation, {
      evidence: evWithConfidence,
      mode: "expanded",
      repositoryName: "acme/fluxora",
      commitSha: "sha12345",
    }),
  );

  assert.match(htmlExpanded, /data-testid="citation-confidence"/);
  assert.match(htmlExpanded, /Confidence: 92%/);
  assert.match(htmlExpanded, /data-confidence-tier="high"/);
  assert.match(htmlExpanded, /aria-label="High confidence, 92 percent"/);
});

test("EvidenceCitation omits confidence badge when confidence is undefined or missing", () => {
  const evWithoutConfidence: GraphQueryResponseEvidence = {
    id: "ev-step-50-no-conf",
    subject_type: "graph_node",
    subject_id: "node-123",
    file_path: "src/module.ts",
    line_start: 1,
    line_end: 5,
    relationship_description: "Module declaration",
    confidence: undefined as unknown as number,
  };

  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitation, {
      evidence: evWithoutConfidence,
      mode: "compact",
      repositoryName: "acme/fluxora",
      commitSha: "sha12345",
    }),
  );

  assert.ok(!html.includes('data-testid="citation-confidence-chip"'));
  assert.ok(!html.includes('data-confidence-tier'));
  // File and coordinates still render cleanly
  assert.match(html, /module\.ts:L1–L5/);
});

test("EvidenceCitation accepts explicit confidence prop overriding record confidence", () => {
  const ev: GraphQueryResponseEvidence = {
    id: "ev-override-test",
    subject_type: "impact_finding",
    subject_id: "finding-1",
    file_path: "src/handler.ts",
    relationship_description: "Impact provenance",
    confidence: 1.0,
  };

  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitation, {
      evidence: ev,
      confidence: 0.65, // Overridden to 65% (low confidence)
      mode: "compact",
      repositoryName: "acme/fluxora",
      commitSha: "sha12345",
    }),
  );

  assert.match(html, /data-testid="citation-confidence-chip"/);
  assert.match(html, /65%/);
  assert.match(html, /data-confidence-tier="low"/);
  assert.match(html, /aria-label="Low confidence, 65 percent"/);
});

test("EvidenceCitationList forwards confidence down to child citations", () => {
  const ev: GraphQueryResponseEvidence = {
    id: "ev-list-conf",
    subject_type: "graph_edge",
    subject_id: "edge-list-1",
    file_path: "src/api.ts",
    relationship_description: "API route edge",
    confidence: 1.0,
  };

  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitationList, {
      evidenceList: [ev],
      confidence: 0.77, // Propagated medium confidence
      mode: "compact",
      repositoryName: "acme/fluxora",
      commitSha: "sha12345",
    }),
  );

  assert.match(html, /data-testid="citation-confidence-chip"/);
  assert.match(html, /77%/);
  assert.match(html, /data-confidence-tier="medium"/);
});

// ============================================================================
// Section F: Accessibility & Non-Color Signaling Tests
// ============================================================================

test("Edge styling and confidence presentation do not rely on color alone", () => {
  const lowStyles = computeEdgeConfidenceStyles(0.45);
  const highStyles = computeEdgeConfidenceStyles(0.95);

  // Different stroke width
  assert.notEqual(lowStyles.strokeWidth, highStyles.strokeWidth);
  // Different stroke dasharray
  assert.notEqual(lowStyles.strokeDasharray, highStyles.strokeDasharray);
  // Different opacity
  assert.notEqual(lowStyles.opacity, highStyles.opacity);

  // Low confidence is explicitly dashed
  assert.equal(lowStyles.strokeDasharray, "4 4");
});

test("Node inspector edge inspection renders confidence textually and with ARIA label", () => {
  const mockEdge: GraphQueryResponseEdge = {
    id: "edge-acc-test",
    source: "node-alpha",
    target: "node-beta",
    type: "QUERIES_DB",
    confidence: 0.65, // Low confidence
    provenance: "ast_visitor",
  };

  const html = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: null,
      edge: mockEdge,
      evidence: [],
      repositoryName: "acme/fluxora",
      commitSha: "sha-test",
    }),
  );

  assert.match(html, /data-testid="inspector-edge-confidence"/);
  assert.match(html, /65%/);
  assert.match(html, /data-confidence-tier="low"/);
  assert.match(html, /aria-label="Low confidence, 65 percent"/);
  assert.match(html, /low/); // Textual tier indicator present
});
