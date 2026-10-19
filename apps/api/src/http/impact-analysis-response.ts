import type {
  EvidenceRecord,
  GraphQueryResponseEvidence,
  ImpactAnalysis,
  ImpactAnalysisExecutionMetrics,
  ImpactAnalysisExecutionMetricsResponse,
  ImpactAnalysisFindingResponse,
  ImpactAnalysisResponse,
  ImpactAnalysisUnresolvedFileResponse,
  ImpactFinding,
  UnresolvedChangedFile,
} from "@fluxora/shared-types";

export function formatImpactEvidence(
  ev: EvidenceRecord,
): GraphQueryResponseEvidence {
  const evObj: GraphQueryResponseEvidence = {
    id: ev.id,
    subject_type: ev.subjectType,
    subject_id: ev.subjectId,
    file_path: ev.filePath,
    symbol_id: ev.symbolId ?? null,
    line_start: ev.lineStart ?? null,
    line_end: ev.lineEnd ?? null,
    column_start: ev.columnStart ?? null,
    column_end: ev.columnEnd ?? null,
    relationship_description: ev.relationshipDescription,
    confidence: ev.confidence,
  };
  if (ev.metadata && Object.keys(ev.metadata).length > 0) {
    (evObj as { metadata?: Record<string, unknown> }).metadata = ev.metadata;
  }
  return evObj;
}

export function formatImpactFinding(
  finding: ImpactFinding,
): ImpactAnalysisFindingResponse {
  const evidenceIds = finding.evidenceIds ?? [];
  return {
    node_id: finding.node.id,
    name: finding.node.name,
    type: finding.node.nodeType,
    ...(finding.node.canonicalId
      ? { canonical_id: finding.node.canonicalId }
      : {}),
    file_path: finding.node.path ?? null,
    depth: finding.depth,
    hop_distance: finding.depth,
    confidence: finding.confidence,
    path: finding.path,
    evidence_ids: evidenceIds,
    evidence_id: evidenceIds[0] ?? null,
  };
}

export function formatUnresolvedFile(
  file: UnresolvedChangedFile,
): ImpactAnalysisUnresolvedFileResponse {
  return {
    path: file.path,
    reason: file.reason,
  };
}

export function formatExecutionMetrics(
  metrics: ImpactAnalysisExecutionMetrics,
): ImpactAnalysisExecutionMetricsResponse {
  return {
    total_seed_nodes: metrics.totalSeedNodes ?? 0,
    total_affected_nodes: metrics.totalAffectedNodes ?? 0,
    total_edges_traversed: metrics.totalEdgesTraversed ?? 0,
    duration_ms: metrics.durationMs ?? 0,
  };
}

export function formatImpactAnalysisResponse(
  analysis: ImpactAnalysis,
  evidence?: readonly EvidenceRecord[],
): ImpactAnalysisResponse {
  const formattedEvidence =
    evidence !== undefined && evidence.length > 0
      ? evidence.map(formatImpactEvidence)
      : undefined;

  return {
    id: analysis.id,
    pull_request_id: analysis.pullRequestId,
    analysis_run_id: analysis.analysisRunId,
    status: analysis.status,
    direct_impact: (analysis.directImpact ?? []).map(formatImpactFinding),
    downstream_impact: (analysis.downstreamImpact ?? []).map(formatImpactFinding),
    affected_apis: (analysis.affectedApis ?? []).map(formatImpactFinding),
    affected_events: (analysis.affectedEvents ?? []).map(formatImpactFinding),
    affected_services: (analysis.affectedServices ?? []).map(formatImpactFinding),
    workflow_impact_summary: analysis.workflowImpactSummary ?? [],
    unresolved_files: (analysis.unresolvedFiles ?? []).map(formatUnresolvedFile),
    truncated: analysis.truncated,
    truncation_reason: analysis.truncationReason ?? null,
    max_depth_reached: analysis.maxDepthReached,
    execution_metrics: formatExecutionMetrics(analysis.executionMetrics),
    created_at:
      analysis.createdAt instanceof Date
        ? analysis.createdAt.toISOString()
        : String(analysis.createdAt),
    ...(formattedEvidence !== undefined ? { evidence: formattedEvidence } : {}),
  };
}

