/**
 * Graph persistence domain types for Step 27 & Step 28.
 * Supports GraphNode, GraphEdge, Evidence, and AnalysisRun persistence models.
 */

export const AnalysisRunStatuses = [
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
] as const;

export type AnalysisRunStatus = (typeof AnalysisRunStatuses)[number];

export interface AnalysisRun {
  readonly id: string;
  readonly snapshotId: string;
  readonly status: AnalysisRunStatus;
  readonly parserVersions: Record<string, string>;
  readonly startedAt: Date;
  readonly completedAt?: Date | null;
  readonly coverageSummary: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface CreateAnalysisRunInput {
  id?: string;
  organizationId: string;
  snapshotId: string;
  status?: AnalysisRunStatus;
  parserVersions?: Record<string, string>;
  startedAt?: Date;
  completedAt?: Date | null;
  coverageSummary?: Record<string, unknown>;
}

export const GraphNodeTypes = [
  "application",
  "service",
  "package",
  "module",
  "symbol",
  "api",
  "event",
  "database",
] as const;

export type GraphNodeType = (typeof GraphNodeTypes)[number] | (string & {});

export interface GraphNode {
  readonly id: string;
  readonly analysisRunId: string;
  readonly canonicalId: string;
  readonly nodeType: GraphNodeType;
  readonly name: string;
  readonly path?: string | null;
  readonly metadata: Record<string, unknown>;
  readonly confidence: number;
  readonly createdAt: Date;
}

export interface CreateGraphNodeInput {
  id?: string;
  organizationId: string;
  analysisRunId: string;
  canonicalId: string;
  nodeType: GraphNodeType;
  name: string;
  path?: string | null;
  metadata?: Record<string, unknown>;
  confidence?: number;
  evidence?: CreateEvidenceInput;
}

export const GraphEdgeTypes = [
  "IMPORTS",
  "CALLS",
  "EXTENDS",
  "EXPOSES_ROUTE",
  "EMITS_EVENT",
  "CONSUMES_EVENT",
  "QUERIES_DB",
  "WRITES",
  "RESOLVES_TO",
] as const;

export type GraphEdgeType = (typeof GraphEdgeTypes)[number] | (string & {});

export const GraphEdgeProvenances = [
  "static-analysis",
  "inferred",
  "ai-hypothesis",
  "runtime-observed",
] as const;

export type GraphEdgeProvenance = (typeof GraphEdgeProvenances)[number];

export interface GraphEdge {
  readonly id: string;
  readonly analysisRunId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly edgeType: GraphEdgeType;
  readonly canonicalId?: string | null;
  readonly metadata: Record<string, unknown>;
  readonly confidence: number;
  readonly provenance: GraphEdgeProvenance;
  readonly createdAt: Date;
}

export interface CreateGraphEdgeInput {
  id?: string;
  organizationId: string;
  analysisRunId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: GraphEdgeType;
  canonicalId?: string | null;
  metadata?: Record<string, unknown>;
  confidence?: number;
  provenance?: GraphEdgeProvenance;
  evidence?: CreateEvidenceInput;
}

export const EvidenceSubjectTypes = [
  "graph_node",
  "graph_edge",
  "impact_finding",
  "simulation_state",
] as const;

export type EvidenceSubjectType = (typeof EvidenceSubjectTypes)[number] | (string & {});

export interface EvidenceRecord {
  readonly id: string;
  readonly analysisRunId: string;
  readonly subjectType: EvidenceSubjectType;
  readonly subjectId: string;
  readonly filePath: string;
  readonly symbolId?: string | null;
  readonly lineStart?: number | null;
  readonly lineEnd?: number | null;
  readonly columnStart?: number | null;
  readonly columnEnd?: number | null;
  readonly relationshipDescription: string;
  readonly confidence: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface CreateEvidenceInput {
  id?: string;
  organizationId: string;
  analysisRunId: string;
  subjectType: EvidenceSubjectType;
  subjectId: string;
  filePath: string;
  symbolId?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  columnStart?: number | null;
  columnEnd?: number | null;
  relationshipDescription: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export const DEFAULT_MAX_TRAVERSAL_DEPTH = 5;
export const HARD_MAX_TRAVERSAL_DEPTH = 20;

export const TraversalDirections = ["outgoing", "incoming", "both"] as const;
export type TraversalDirection = (typeof TraversalDirections)[number];

export interface GraphTraversalOptions {
  readonly organizationId: string;
  readonly analysisRunId: string;
  readonly startNodeId: string;
  readonly maxDepth: number;
  readonly direction?: TraversalDirection;
  readonly edgeTypes?: readonly GraphEdgeType[];
  readonly nodeTypes?: readonly GraphNodeType[];
  readonly includeEvidence?: boolean;
}

export interface GraphTraversalNode {
  readonly node: GraphNode;
  readonly depth: number;
  readonly path: readonly string[];
}

export interface GraphTraversalResult {
  readonly startNode: GraphNode | null;
  readonly nodes: readonly GraphTraversalNode[];
  readonly edges: readonly GraphEdge[];
  readonly maxDepthReached: number;
  readonly evidence?: readonly EvidenceRecord[] | undefined;
}

export const GRAPH_QUERY_PATH = "/api/v1/graph/query" as const;

export const GraphQueryDirections = [
  "downstream",
  "upstream",
  "both",
] as const;

export type GraphQueryDirection = (typeof GraphQueryDirections)[number];

export interface GraphQueryRequest {
  readonly analysis_run_id: string;
  readonly start_node_id: string;
  readonly direction?: GraphQueryDirection | undefined;
  readonly max_depth?: number | undefined;
  readonly edge_types?: readonly string[] | undefined;
  readonly node_types?: readonly string[] | undefined;
  readonly min_confidence?: number | undefined;
  readonly include_evidence?: boolean | undefined;
}

export interface GraphQueryResponseNode {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly canonical_id: string;
  readonly depth: number;
  readonly confidence: number;
  readonly path?: string | null | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface GraphQueryResponseEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly confidence: number;
  readonly provenance: string;
  readonly evidence_id?: string | null | undefined;
  readonly canonical_id?: string | null | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface GraphQueryResponseEvidence {
  readonly id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly file_path: string;
  readonly symbol_id?: string | null | undefined;
  readonly line_start?: number | null | undefined;
  readonly line_end?: number | null | undefined;
  readonly column_start?: number | null | undefined;
  readonly column_end?: number | null | undefined;
  readonly relationship_description: string;
  readonly confidence: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface GraphQueryResponse {
  readonly nodes: readonly GraphQueryResponseNode[];
  readonly edges: readonly GraphQueryResponseEdge[];
  readonly max_depth_reached: number;
  readonly truncated: boolean;
  readonly evidence?: readonly GraphQueryResponseEvidence[] | undefined;
}
