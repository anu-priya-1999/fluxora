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
  buildSourcePermalink,
  deduplicateAndSortEvidence,
  formatLineRange,
  resolveEvidenceForFinding,
} from "./evidence-citation-data.ts";
import {
  EvidenceCitation,
  EvidenceCitationList,
} from "./EvidenceCitation.tsx";
import {
  EvidenceTrail,
  NodeInspectorPanel,
} from "./node-inspector-data.ts";
import {
  normalizeImpactAnalysisResponse,
} from "./change-mode-data.ts";
import { ChangeModeBar } from "./ChangeModeBar.tsx";

const MOCK_NODE_1: GraphQueryResponseNode = {
  id: "node-1111-1111-1111-111111111111",
  type: "symbol",
  name: "authenticateUser",
  canonical_id: "sym:src/auth/service.ts#authenticateUser:15",
  depth: 1,
  confidence: 0.98,
  path: "src/auth/service.ts",
};

const MOCK_EDGE_1: GraphQueryResponseEdge = {
  id: "edge-2222-2222-2222-222222222222",
  source: "node-1111-1111-1111-111111111111",
  target: "node-3333-3333-3333-333333333333",
  type: "CALLS",
  confidence: 0.95,
  provenance: "ast_visitor",
  evidence_id: "ev-edge-calls-1",
};

const MOCK_EVIDENCE_NODE_1: GraphQueryResponseEvidence = {
  id: "ev-node-1",
  subject_type: "graph_node",
  subject_id: MOCK_NODE_1.id,
  file_path: "src/auth/service.ts",
  symbol_id: "sym:src/auth/service.ts#authenticateUser:15",
  line_start: 15,
  line_end: 45,
  column_start: 1,
  column_end: 30,
  relationship_description: "Function declaration for authenticateUser",
  confidence: 0.98,
  metadata: { astType: "FunctionDeclaration" },
};

const MOCK_EVIDENCE_EDGE_1: GraphQueryResponseEvidence = {
  id: "ev-edge-calls-1",
  subject_type: "graph_edge",
  subject_id: MOCK_EDGE_1.id,
  file_path: "src/auth/controller.ts",
  symbol_id: "sym:src/auth/controller.ts#loginHandler:22",
  line_start: 28,
  line_end: 28,
  column_start: 5,
  column_end: 42,
  relationship_description: "Invokes authenticateUser from controller",
  confidence: 0.95,
};

const MOCK_EVIDENCE_NO_LINES: GraphQueryResponseEvidence = {
  id: "ev-file-level",
  subject_type: "graph_node",
  subject_id: MOCK_NODE_1.id,
  file_path: "src/auth/index.ts",
  relationship_description: "Module re-export of auth service",
  confidence: 1.0,
};

// ==========================================
// 1. buildSourcePermalink Tests
// ==========================================

test("buildSourcePermalink constructs GitHub permalink with commit SHA and line range", () => {
  const result = buildSourcePermalink({
    repositoryName: "acme/fluxora",
    commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    filePath: "src/auth/service.ts",
    lineStart: 15,
    lineEnd: 45,
  });

  assert.equal(result.available, true);
  assert.equal(
    result.url,
    "https://github.com/acme/fluxora/blob/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/src/auth/service.ts#L15-L45",
  );
  assert.equal(result.reason, null);
});

test("buildSourcePermalink constructs single line anchor when start and end are identical", () => {
  const result = buildSourcePermalink({
    repositoryName: "acme/fluxora",
    commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    filePath: "src/auth/controller.ts",
    lineStart: 28,
    lineEnd: 28,
  });

  assert.equal(result.available, true);
  assert.equal(
    result.url,
    "https://github.com/acme/fluxora/blob/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/src/auth/controller.ts#L28",
  );
});

test("buildSourcePermalink constructs permalink without line anchor when coordinates are absent", () => {
  const result = buildSourcePermalink({
    repositoryName: "acme/fluxora",
    commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    filePath: "src/auth/index.ts",
  });

  assert.equal(result.available, true);
  assert.equal(
    result.url,
    "https://github.com/acme/fluxora/blob/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/src/auth/index.ts",
  );
});

test("buildSourcePermalink falls back to ref when commitSha is absent", () => {
  const result = buildSourcePermalink({
    repositoryName: "acme/fluxora",
    ref: "feat/pr-123",
    filePath: "src/auth/service.ts",
    lineStart: 10,
  });

  assert.equal(result.available, true);
  assert.equal(
    result.url,
    "https://github.com/acme/fluxora/blob/feat/pr-123/src/auth/service.ts#L10",
  );
});

test("buildSourcePermalink prefers immutable commit SHA over mutable ref", () => {
  const result = buildSourcePermalink({
    repositoryName: "acme/fluxora",
    commitSha: "commit-sha-40-hex",
    ref: "main",
    filePath: "src/auth/service.ts",
  });

  assert.equal(result.available, true);
  assert.equal(
    result.url,
    "https://github.com/acme/fluxora/blob/commit-sha-40-hex/src/auth/service.ts",
  );
});

test("buildSourcePermalink rejects missing repository name with clear reason", () => {
  const result = buildSourcePermalink({
    commitSha: "commit-sha",
    filePath: "src/file.ts",
  });

  assert.equal(result.available, false);
  assert.equal(result.url, null);
  assert.match(result.reason!, /Repository name is not available/i);
});

test("buildSourcePermalink rejects invalid repository name format", () => {
  const result = buildSourcePermalink({
    repositoryName: "not-an-owner-repo-pattern",
    commitSha: "commit-sha",
    filePath: "src/file.ts",
  });

  assert.equal(result.available, false);
  assert.match(result.reason!, /owner\/repo format/i);
});

test("buildSourcePermalink rejects missing commit SHA and missing ref", () => {
  const result = buildSourcePermalink({
    repositoryName: "acme/fluxora",
    filePath: "src/file.ts",
  });

  assert.equal(result.available, false);
  assert.match(result.reason!, /Commit reference is not resolved/i);
});

test("buildSourcePermalink sanitizes path traversal attempts safely", () => {
  const result = buildSourcePermalink({
    repositoryName: "acme/fluxora",
    commitSha: "commit-sha",
    filePath: "../../../etc/passwd",
  });

  assert.equal(result.available, false);
  assert.match(result.reason!, /unsafe file path/i);
});

test("buildSourcePermalink sanitizes protocol injection attempts safely", () => {
  const result = buildSourcePermalink({
    repositoryName: "acme/fluxora",
    commitSha: "commit-sha",
    filePath: "javascript:alert(1)",
  });

  assert.equal(result.available, false);
  assert.match(result.reason!, /unsafe file path/i);
});

// ==========================================
// 2. formatLineRange Tests
// ==========================================

test("formatLineRange formats range and single line correctly", () => {
  assert.equal(formatLineRange(10, 25), "L10–L25");
  assert.equal(formatLineRange(42, 42), "L42");
  assert.equal(formatLineRange(99, undefined), "L99");
  assert.equal(formatLineRange(null, null), null);
  assert.equal(formatLineRange(undefined, undefined), null);
  assert.equal(formatLineRange(0, 0), null); // Non-positive lines rejected
});

// ==========================================
// 3. deduplicateAndSortEvidence Tests
// ==========================================

test("deduplicateAndSortEvidence deduplicates by ID and sorts deterministically", () => {
  const ev1: GraphQueryResponseEvidence = {
    id: "ev-b",
    subject_type: "graph_node",
    subject_id: "node-1",
    file_path: "src/b.ts",
    line_start: 10,
    line_end: 20,
    relationship_description: "B file",
    confidence: 1.0,
  };

  const ev2: GraphQueryResponseEvidence = {
    id: "ev-a",
    subject_type: "graph_node",
    subject_id: "node-1",
    file_path: "src/a.ts",
    line_start: 5,
    line_end: 15,
    relationship_description: "A file line 5",
    confidence: 1.0,
  };

  const evDuplicate: GraphQueryResponseEvidence = {
    ...ev1,
    id: "ev-b", // Exact duplicate ID
  };

  const ev3: GraphQueryResponseEvidence = {
    id: "ev-a-line50",
    subject_type: "graph_node",
    subject_id: "node-1",
    file_path: "src/a.ts",
    line_start: 50,
    line_end: 60,
    relationship_description: "A file line 50",
    confidence: 1.0,
  };

  const sorted = deduplicateAndSortEvidence([ev1, evDuplicate, ev3, ev2]);

  assert.equal(sorted.length, 3);
  assert.equal(sorted[0]?.id, "ev-a");
  assert.equal(sorted[1]?.id, "ev-a-line50");
  assert.equal(sorted[2]?.id, "ev-b");
});

test("resolveEvidenceForFinding resolves evidence from pool using finding evidence_ids and subject_id", () => {
  const finding = {
    node_id: MOCK_NODE_1.id,
    name: "authenticateUser",
    type: "symbol",
    depth: 0,
    hop_distance: 0,
    confidence: 1.0,
    path: [MOCK_NODE_1.id],
    evidence_ids: [MOCK_EVIDENCE_NODE_1.id],
    evidence_id: MOCK_EVIDENCE_NODE_1.id,
  };

  const pool = [MOCK_EVIDENCE_NODE_1, MOCK_EVIDENCE_EDGE_1, MOCK_EVIDENCE_NO_LINES];
  const resolved = resolveEvidenceForFinding(finding, pool);

  // MOCK_EVIDENCE_NODE_1 matched by evidence_ids, MOCK_EVIDENCE_NO_LINES matched by subject_id
  assert.ok(resolved.some((e) => e.id === MOCK_EVIDENCE_NODE_1.id));
  assert.ok(resolved.some((e) => e.id === MOCK_EVIDENCE_NO_LINES.id));
});

// ==========================================
// 4. EvidenceCitation Component Tests
// ==========================================

test("EvidenceCitation renders compact chip with short file name and line range", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitation, {
      evidence: MOCK_EVIDENCE_NODE_1,
      mode: "compact",
      repositoryName: "acme/fluxora",
      commitSha: "sha123",
    }),
  );

  assert.match(html, /data-testid="evidence-citation-compact"/);
  assert.match(html, /service\.ts:L15–L45/);
  assert.match(html, /data-testid="citation-confidence-chip"/);
  assert.match(html, /98%/);
});

test("EvidenceCitation renders expanded card with full provenance metadata", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitation, {
      evidence: MOCK_EVIDENCE_NODE_1,
      mode: "expanded",
      repositoryName: "acme/fluxora",
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      analysisRunId: "run-999",
      findingRole: "direct",
    }),
  );

  assert.match(html, /data-testid="evidence-citation-card"/);
  assert.match(html, /data-testid="citation-badge-label"/);
  assert.match(html, /Verified Evidence/);
  assert.match(html, /data-testid="citation-role-badge"/);
  assert.match(html, /Direct Impact/);
  assert.match(html, /data-testid="citation-relationship"/);
  assert.match(html, /Function declaration for authenticateUser/);
  assert.match(html, /data-testid="citation-file-path"/);
  assert.match(html, /src\/auth\/service\.ts/);
  assert.match(html, /data-testid="citation-lines"/);
  assert.match(html, /L15–L45/);
  assert.match(html, /data-testid="citation-columns"/);
  assert.match(html, /Col 1–30/);
  assert.match(html, /data-testid="citation-symbol"/);
  assert.match(html, /sym:src\/auth\/service\.ts#authenticateUser:15/);
  assert.match(html, /data-testid="citation-analysis-run"/);
  assert.match(html, /run-999/);

  // Clickable external source link
  assert.match(html, /data-testid="citation-source-link"/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/fluxora\/blob\/abcdef1234567890abcdef1234567890abcdef12\/src\/auth\/service\.ts#L15-L45"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("EvidenceCitation renders honest unavailable indicator when repo/commit is missing", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitation, {
      evidence: MOCK_EVIDENCE_NODE_1,
      mode: "expanded",
      // No repositoryName or commitSha provided
    }),
  );

  assert.match(html, /data-testid="citation-source-unavailable"/);
  assert.match(html, /Source permalink unavailable/);
  assert.ok(!html.includes('data-testid="citation-source-link"'));
});

test("EvidenceCitation renders loading state cleanly", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitation, {
      isLoading: true,
    }),
  );

  assert.match(html, /data-testid="citation-loading-state"/);
  assert.match(html, /Loading evidence/);
});

test("EvidenceCitation renders error state cleanly", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitation, {
      errorMessage: "Evidence record failed integrity verification",
    }),
  );

  assert.match(html, /data-testid="citation-error-state"/);
  assert.match(html, /failed integrity verification/);
});

test("EvidenceCitation renders unresolved ID fallback cleanly", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitation, {
      evidenceId: "ev-missing-123",
    }),
  );

  assert.match(html, /data-testid="citation-unresolved-id"/);
  assert.match(html, /ev-missing-123/);
  assert.match(html, /metadata unavailable/);
});

// ==========================================
// 5. EvidenceCitationList Tests
// ==========================================

test("EvidenceCitationList renders ordered, deduplicated citations", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitationList, {
      evidenceList: [MOCK_EVIDENCE_NODE_1, MOCK_EVIDENCE_EDGE_1, MOCK_EVIDENCE_NODE_1], // Contains duplicate
      evidenceIds: ["ev-unresolved-456"],
      mode: "compact",
      repositoryName: "acme/fluxora",
      commitSha: "sha123",
    }),
  );

  assert.match(html, /data-testid="evidence-citation-list"/);
  assert.match(html, /service\.ts:L15–L45/);
  assert.match(html, /controller\.ts:L28/);
  assert.match(html, /ev-unresolved-456/);
});

test("EvidenceCitationList renders empty state when no evidence is supplied", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceCitationList, {
      evidenceList: [],
      evidenceIds: [],
    }),
  );

  assert.match(html, /data-testid="evidence-citation-empty"/);
  assert.match(html, /No evidence citations attached/);
});

// ==========================================
// 6. NodeInspectorPanel Edge & Provenance Tests
// ==========================================

test("NodeInspectorPanel renders edge inspection when edge is selected", () => {
  const html = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: null,
      edge: MOCK_EDGE_1,
      evidence: [MOCK_EVIDENCE_EDGE_1],
      repositoryName: "acme/fluxora",
      commitSha: "sha-edge-test",
    }),
  );

  assert.match(html, /data-testid="node-inspector-panel"/);
  assert.match(html, /data-testid="inspector-edge-type"/);
  assert.match(html, /CALLS/);
  assert.match(html, /data-testid="inspector-edge-id"/);
  assert.match(html, new RegExp(MOCK_EDGE_1.id));
  assert.match(html, /data-testid="inspector-edge-confidence"/);
  assert.match(html, /95%/);
  assert.match(html, /data-testid="inspector-edge-provenance"/);
  assert.match(html, /ast_visitor/);

  // Embedded edge evidence citation
  assert.match(html, /data-testid="inspector-edge-evidence-section"/);
  assert.match(html, /data-testid="evidence-citation-card"/);
  assert.match(html, /Invokes authenticateUser from controller/);
  assert.match(html, /src\/auth\/controller\.ts/);
  assert.match(html, /data-testid="citation-source-link"/);
});

test("NodeInspectorPanel renders empty edge evidence when edge has no evidence_id", () => {
  const edgeWithoutEvidence: GraphQueryResponseEdge = {
    ...MOCK_EDGE_1,
    evidence_id: null,
  };

  const html = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: null,
      edge: edgeWithoutEvidence,
      evidence: [],
    }),
  );

  assert.match(html, /data-testid="edge-evidence-empty"/);
  assert.match(html, /No evidence record linked to this edge/);
});

// ==========================================
// 7. EvidenceTrail Clickable Citation Tests
// ==========================================

test("EvidenceTrail renders citation-source-link when repositoryName and commitSha are provided", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceTrail, {
      evidence: [MOCK_EVIDENCE_NODE_1],
      selectedNodeId: MOCK_NODE_1.id,
      repositoryName: "acme/fluxora",
      commitSha: "sha123",
    }),
  );

  assert.match(html, /data-testid="evidence-trail"/);
  assert.match(html, /data-testid="citation-source-link"/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/fluxora\/blob\/sha123\/src\/auth\/service\.ts#L15-L45"/);
});

test("EvidenceTrail renders citation-source-unavailable when repositoryName is absent", () => {
  const html = renderToStaticMarkup(
    React.createElement(EvidenceTrail, {
      evidence: [MOCK_EVIDENCE_NODE_1],
      selectedNodeId: MOCK_NODE_1.id,
      // No repositoryName
    }),
  );

  assert.match(html, /data-testid="evidence-trail"/);
  assert.match(html, /data-testid="citation-source-unavailable"/);
  assert.match(html, /Source link unavailable/);
});

// ==========================================
// 8. PR Impact Findings Integration Tests
// ==========================================

test("ChangeModeBar renders expandable impact-findings-panel with clickable citations", () => {
  const mockImpact: ImpactAnalysisResponse = {
    id: "impact-test-1",
    pull_request_id: "pr-1",
    analysis_run_id: "run-1",
    status: "completed",
    direct_impact: [
      {
        node_id: MOCK_NODE_1.id,
        name: "authenticateUser",
        type: "symbol",
        canonical_id: MOCK_NODE_1.canonical_id,
        file_path: "src/auth/service.ts",
        depth: 0,
        hop_distance: 0,
        confidence: 1.0,
        path: [MOCK_NODE_1.id],
        evidence_ids: ["ev-node-1"],
        evidence_id: "ev-node-1",
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
      total_edges_traversed: 0,
      duration_ms: 10,
    },
    evidence: [MOCK_EVIDENCE_NODE_1],
    created_at: new Date().toISOString(),
  };

  const normalized = normalizeImpactAnalysisResponse(mockImpact, { enabled: true });

  const html = renderToStaticMarkup(
    React.createElement(ChangeModeBar, {
      state: normalized,
      onToggle: () => {},
      onLoadAnalysis: () => {},
      onRetry: () => {},
      onClear: () => {},
      repositoryName: "acme/fluxora",
      commitSha: "sha-impact-test",
    }),
  );

  assert.match(html, /data-testid="toggle-findings-panel-btn"/);
  assert.match(html, /Inspect Citations \(1\)/);
});
