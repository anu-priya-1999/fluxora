import type {
  EvidenceRecord,
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  GraphNodeType,
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
