import type {
  CreateEvidenceInput,
  CreateGraphEdgeInput,
  CreateGraphNodeInput,
  EvidenceRecord,
  GraphEdge,
  GraphNode,
} from "./graph.ts";
import type { RepositoryNormalizedResult } from "./normalized.ts";

/**
 * Execution scope for the Graph Builder.
 */
export interface GraphBuilderScope {
  readonly organizationId: string;
  readonly analysisRunId: string;
}

/**
 * Input options passed into the Graph Builder.
 */
export interface GraphBuilderOptions extends GraphBuilderScope {
  readonly normalizedResult: RepositoryNormalizedResult;
}

/**
 * Summary counts and statistics for deterministic verification of graph build.
 */
export interface GraphBuilderStatistics {
  readonly totalNodes: number;
  readonly symbolNodes: number;
  readonly moduleNodes: number;
  readonly routeNodes: number;
  readonly eventNodes: number;
  readonly databaseNodes: number;
  readonly totalEdges: number;
  readonly importEdges: number;
  readonly routeEdges: number;
  readonly eventEdges: number;
  readonly databaseEdges: number;
  readonly resolveEdges: number;
  readonly totalEvidenceRecords: number;
  readonly rejectedEdgesCount: number;
}

/**
 * Pure, in-memory result of Graph Projection before database persistence.
 */
export interface GraphProjectionResult {
  readonly nodes: readonly CreateGraphNodeInput[];
  readonly edges: readonly CreateGraphEdgeInput[];
  readonly evidence: readonly CreateEvidenceInput[];
  readonly statistics: GraphBuilderStatistics;
}

/**
 * Output result after atomic database persistence of graph records.
 */
export interface PersistedGraphResult {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly evidence: readonly EvidenceRecord[];
  readonly statistics: GraphBuilderStatistics;
}

