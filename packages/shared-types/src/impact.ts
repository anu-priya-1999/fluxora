import type {
  EvidenceRecord,
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  GraphNodeType,
  GraphQueryResponseEvidence,
  TraversalDirection,
} from "./graph.ts";
import type { PullRequestFile } from "./pull-request.ts";

/** Default maximum traversal depth for PR blast-radius impact analysis (Step 43). */
export const DEFAULT_IMPACT_MAX_DEPTH = 5;

/** Hard maximum allowed traversal depth for PR blast-radius impact analysis. */
export const HARD_MAX_IMPACT_DEPTH = 20;

/** Default confidence decay factor per traversal hop. */
export const DEFAULT_CONFIDENCE_DECAY_PER_HOP = 0.9;

/**
 * An affected graph node finding within an impact analysis blast radius.
 */
export interface ImpactFinding {
  readonly node: GraphNode;
  readonly depth: number;
  readonly confidence: number;
  readonly path: readonly string[];
  readonly evidenceIds?: readonly string[] | undefined;
}

/**
 * Details of a pull request changed file that could not be mapped to any graph nodes.
 */
export interface UnresolvedChangedFile {
  readonly path: string;
  readonly reason: string;
}

/**
 * Execution metrics for an impact analysis run.
 */
export interface ImpactAnalysisExecutionMetrics {
  readonly totalSeedNodes: number;
  readonly totalAffectedNodes: number;
  readonly totalEdgesTraversed: number;
  readonly durationMs: number;
}

/**
 * Deterministic in-memory result of an Impact Analysis computation.
 */
export interface ImpactAnalysisResult {
  readonly pullRequestId: string;
  readonly analysisRunId: string;
  readonly repositoryId: string;
  readonly organizationId: string;
  readonly seedNodes: readonly GraphNode[];
  readonly directImpacts: readonly ImpactFinding[];
  readonly downstreamImpacts: readonly ImpactFinding[];
  readonly affectedApis: readonly ImpactFinding[];
  readonly affectedEvents: readonly ImpactFinding[];
  readonly affectedServices: readonly ImpactFinding[];
  readonly workflowImpactSummary: readonly string[];
  readonly unresolvedFiles: readonly UnresolvedChangedFile[];
  readonly truncated: boolean;
  readonly truncationReason?: string | null | undefined;
  readonly maxDepthReached: number;
  readonly executionMetrics: ImpactAnalysisExecutionMetrics;
}

/**
 * Caller options for analyzing the impact of a stored pull request.
 */
export interface AnalyzePullRequestImpactOptions {
  readonly organizationId: string;
  readonly pullRequestId: string;
  readonly analysisRunId?: string | undefined;
  readonly maxDepth?: number | undefined;
  readonly direction?: TraversalDirection | undefined;
  readonly edgeTypes?: readonly GraphEdgeType[] | undefined;
  readonly nodeTypes?: readonly GraphNodeType[] | undefined;
  readonly decayFactor?: number | undefined;
  readonly includeEvidence?: boolean | undefined;
}

/**
 * In-memory inputs for pure deterministic impact analysis computation.
 */
export interface ComputeImpactAnalysisInput {
  readonly pullRequestId: string;
  readonly analysisRunId: string;
  readonly repositoryId: string;
  readonly organizationId: string;
  readonly changedFiles: readonly PullRequestFile[];
  readonly graphNodes: readonly GraphNode[];
  readonly graphEdges: readonly GraphEdge[];
  readonly evidence?: readonly EvidenceRecord[] | undefined;
  readonly maxDepth?: number | undefined;
  readonly direction?: TraversalDirection | undefined;
  readonly decayFactor?: number | undefined;
  readonly edgeTypes?: readonly GraphEdgeType[] | undefined;
  readonly nodeTypes?: readonly GraphNodeType[] | undefined;
}

/**
 * Valid execution states for persisted impact analyses.
 */
export const ImpactAnalysisStatuses = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;

export type ImpactAnalysisStatus = (typeof ImpactAnalysisStatuses)[number];

/**
 * Persisted ImpactAnalysis database record (Step 44).
 */
export interface ImpactAnalysis {
  readonly id: string;
  readonly pullRequestId: string;
  readonly analysisRunId: string;
  readonly status: ImpactAnalysisStatus;
  readonly directImpact: readonly ImpactFinding[];
  readonly downstreamImpact: readonly ImpactFinding[];
  readonly affectedApis: readonly ImpactFinding[];
  readonly affectedEvents: readonly ImpactFinding[];
  readonly affectedServices: readonly ImpactFinding[];
  readonly workflowImpactSummary: readonly string[];
  readonly unresolvedFiles: readonly UnresolvedChangedFile[];
  readonly truncated: boolean;
  readonly truncationReason?: string | null | undefined;
  readonly maxDepthReached: number;
  readonly executionMetrics: ImpactAnalysisExecutionMetrics;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

/**
 * Input parameters for saving an impact analysis record and its finding evidence.
 */
export interface SaveImpactAnalysisInput {
  id?: string | undefined;
  organizationId: string;
  pullRequestId?: string | undefined;
  analysisRunId?: string | undefined;
  status?: ImpactAnalysisStatus | undefined;
  directImpact?: readonly ImpactFinding[] | undefined;
  downstreamImpact?: readonly ImpactFinding[] | undefined;
  affectedApis?: readonly ImpactFinding[] | undefined;
  affectedEvents?: readonly ImpactFinding[] | undefined;
  affectedServices?: readonly ImpactFinding[] | undefined;
  workflowImpactSummary?: readonly string[] | undefined;
  unresolvedFiles?: readonly UnresolvedChangedFile[] | undefined;
  truncated?: boolean | undefined;
  truncationReason?: string | null | undefined;
  maxDepthReached?: number | undefined;
  executionMetrics?: ImpactAnalysisExecutionMetrics | undefined;
  metadata?: Record<string, unknown> | undefined;
  result?: ImpactAnalysisResult | undefined;
}

/**
 * Return value of saving an impact analysis, including created evidence records.
 */
export interface SaveImpactAnalysisResult {
  readonly impactAnalysis: ImpactAnalysis;
  readonly evidenceRecords: readonly EvidenceRecord[];
}

/**
 * Options for executing impact analysis and persisting the result with evidence.
 */
export interface PersistPullRequestImpactAnalysisOptions
  extends AnalyzePullRequestImpactOptions {
  id?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Result of executing and persisting PR impact analysis.
 */
export interface PersistImpactAnalysisResult {
  readonly impactAnalysis: ImpactAnalysis;
  readonly evidenceRecords: readonly EvidenceRecord[];
}

/**
 * Stable API response representation of an individual impact finding (Step 45).
 */
export interface ImpactAnalysisFindingResponse {
  readonly node_id: string;
  readonly name: string;
  readonly type: string;
  readonly canonical_id?: string | undefined;
  readonly file_path?: string | null | undefined;
  readonly depth: number;
  readonly hop_distance: number;
  readonly confidence: number;
  readonly path: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly evidence_id: string | null;
}

/**
 * Stable API response representation of an unresolved file (Step 45).
 */
export interface ImpactAnalysisUnresolvedFileResponse {
  readonly path: string;
  readonly reason: string;
}

/**
 * Stable API response representation of execution metrics (Step 45).
 */
export interface ImpactAnalysisExecutionMetricsResponse {
  readonly total_seed_nodes: number;
  readonly total_affected_nodes: number;
  readonly total_edges_traversed: number;
  readonly duration_ms: number;
}

/**
 * Stable API representation of a persisted ImpactAnalysis record (Step 45).
 */
export interface ImpactAnalysisResponse {
  readonly id: string;
  readonly pull_request_id: string;
  readonly analysis_run_id: string;
  readonly status: ImpactAnalysisStatus;
  readonly direct_impact: readonly ImpactAnalysisFindingResponse[];
  readonly downstream_impact: readonly ImpactAnalysisFindingResponse[];
  readonly affected_apis: readonly ImpactAnalysisFindingResponse[];
  readonly affected_events: readonly ImpactAnalysisFindingResponse[];
  readonly affected_services: readonly ImpactAnalysisFindingResponse[];
  readonly workflow_impact_summary: readonly string[];
  readonly unresolved_files: readonly ImpactAnalysisUnresolvedFileResponse[];
  readonly truncated: boolean;
  readonly truncation_reason: string | null;
  readonly max_depth_reached: number;
  readonly execution_metrics: ImpactAnalysisExecutionMetricsResponse;
  readonly created_at: string;
  readonly evidence?: readonly GraphQueryResponseEvidence[] | undefined;
}

/**
 * Response payload for an accepted asynchronous impact analysis job (HTTP 202).
 */
export interface PullRequestAnalyzeImpactQueuedResponse {
  readonly status: "queued";
  readonly job_id: string;
  readonly pull_request_id: string;
  readonly idempotency_key: string;
}
