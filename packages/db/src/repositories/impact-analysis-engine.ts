import type {
  AnalyzePullRequestImpactOptions,
  ComputeImpactAnalysisInput,
  EvidenceRecord,
  EvidenceSubjectType,
  GraphNode,
  GraphNodeType,
  ImpactAnalysisResult,
  ImpactFinding,
  PullRequestFile,
  UnresolvedChangedFile,
} from "@fluxora/shared-types";
import {
  DEFAULT_CONFIDENCE_DECAY_PER_HOP,
  DEFAULT_IMPACT_MAX_DEPTH,
  HARD_MAX_IMPACT_DEPTH,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";
import { traverseGraph } from "./graph.ts";
import { listPullRequestFiles } from "./pull-request.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Error Hierarchy for Step 43
// ---------------------------------------------------------------------------

export class ImpactAnalysisValidationError extends Error {
  readonly code = "invalid_input";
  constructor(message = "Impact analysis input parameters are invalid.") {
    super(message);
    this.name = "ImpactAnalysisValidationError";
  }
}

export class PullRequestNotFoundError extends Error {
  readonly code = "pull_request_not_found";
  constructor(message = "Pull request not found or inaccessible for this organization.") {
    super(message);
    this.name = "PullRequestNotFoundError";
  }
}

export class AnalysisSnapshotUnavailableError extends Error {
  readonly code = "analysis_snapshot_unavailable";
  constructor(message = "Analysis snapshot for repository is unavailable or incomplete.") {
    super(message);
    this.name = "AnalysisSnapshotUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Unified Diff Patch Parser
// ---------------------------------------------------------------------------

export interface ChangedLineRanges {
  readonly oldLines: readonly number[];
  readonly newLines: readonly number[];
}

/**
 * Parses unified diff patch text to extract changed line numbers.
 * Supports standard git diff hunk headers: `@@ -start,count +start,count @@`
 */
export function parsePatchModifiedLines(
  patch: string | null | undefined,
): ChangedLineRanges {
  if (!patch || typeof patch !== "string" || patch.trim().length === 0) {
    return { oldLines: [], newLines: [] };
  }

  const oldLines: number[] = [];
  const newLines: number[] = [];

  const lines = patch.split(/\r?\n/);
  let currentOldLine = 0;
  let currentNewLine = 0;
  let inHunk = false;

  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of lines) {
    const match = hunkRegex.exec(line);
    if (match) {
      inHunk = true;
      currentOldLine = parseInt(match[1]!, 10);
      currentNewLine = parseInt(match[3]!, 10);
      continue;
    }

    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      inHunk = false;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith("+")) {
      newLines.push(currentNewLine);
      currentNewLine++;
    } else if (line.startsWith("-")) {
      oldLines.push(currentOldLine);
      currentOldLine++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" - skip
    } else {
      // Context line (either starts with ' ' or general source line)
      currentOldLine++;
      currentNewLine++;
    }
  }

  return { oldLines, newLines };
}

/**
 * Extracts line number from symbol metadata or canonicalId if present.
 */
function extractSymbolLineStart(node: GraphNode): number | null {
  if (typeof node.metadata?.lineStart === "number") {
    return node.metadata.lineStart;
  }
  if (typeof node.metadata?.line_start === "number") {
    return node.metadata.line_start;
  }
  if (typeof node.metadata?.location === "object" && node.metadata.location !== null) {
    const loc = node.metadata.location as { startLine?: number; start?: { line?: number } };
    if (typeof loc.startLine === "number") return loc.startLine;
    if (typeof loc.start?.line === "number") return loc.start.line;
  }

  // Canonical ID format: sym:<path>#<kind>:<name>:<lineStart>
  if (node.canonicalId.startsWith("sym:")) {
    const parts = node.canonicalId.split(":");
    if (parts.length >= 3) {
      const lastPart = parts[parts.length - 1];
      const parsed = parseInt(lastPart ?? "", 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

/**
 * Extracts end line number from symbol metadata if present.
 */
function extractSymbolLineEnd(node: GraphNode): number | null {
  if (typeof node.metadata?.lineEnd === "number") {
    return node.metadata.lineEnd;
  }
  if (typeof node.metadata?.line_end === "number") {
    return node.metadata.line_end;
  }
  if (typeof node.metadata?.location === "object" && node.metadata.location !== null) {
    const loc = node.metadata.location as { endLine?: number; end?: { line?: number } };
    if (typeof loc.endLine === "number") return loc.endLine;
    if (typeof loc.end?.line === "number") return loc.end.line;
  }

  return null;
}

/**
 * Extracts line range [start, end] from evidence if available.
 */
function extractEvidenceLineRange(
  nodeId: string,
  evidenceMap?: Map<string, readonly EvidenceRecord[]>,
): { lineStart: number; lineEnd: number } | null {
  if (!evidenceMap) return null;
  const records = evidenceMap.get(nodeId);
  if (!records || records.length === 0) return null;

  let minStart: number | null = null;
  let maxEnd: number | null = null;

  for (const ev of records) {
    if (typeof ev.lineStart === "number" && ev.lineStart > 0) {
      if (minStart === null || ev.lineStart < minStart) minStart = ev.lineStart;
    }
    if (typeof ev.lineEnd === "number" && ev.lineEnd > 0) {
      if (maxEnd === null || ev.lineEnd > maxEnd) maxEnd = ev.lineEnd;
    }
  }

  if (minStart !== null) {
    return { lineStart: minStart, lineEnd: maxEnd ?? minStart };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Changed File -> Graph Node / Symbol Resolution
// ---------------------------------------------------------------------------

export interface ResolveSeedsResult {
  readonly seedNodes: readonly GraphNode[];
  readonly unresolvedFiles: readonly UnresolvedChangedFile[];
}

/**
 * Resolves a list of pull request changed files to concrete graph nodes / symbols.
 * Pure deterministic resolution logic.
 */
export function resolveFilesToSeeds(
  changedFiles: readonly PullRequestFile[],
  graphNodes: readonly GraphNode[],
  evidenceMap?: Map<string, readonly EvidenceRecord[]>,
): ResolveSeedsResult {
  const seedNodeMap = new Map<string, GraphNode>();
  const unresolvedFiles: UnresolvedChangedFile[] = [];

  // Group graph nodes by path and canonicalId for O(1) lookup
  const nodesByPath = new Map<string, GraphNode[]>();
  const nodeByCanonicalId = new Map<string, GraphNode>();

  for (const node of graphNodes) {
    nodeByCanonicalId.set(node.canonicalId, node);
    if (node.path) {
      const existing = nodesByPath.get(node.path);
      if (existing) {
        existing.push(node);
      } else {
        nodesByPath.set(node.path, [node]);
      }
    }
  }

  for (const file of changedFiles) {
    const filePath = file.path.trim();
    const candidateNodes: GraphNode[] = [];

    // 1. Direct path match
    const pathNodes = nodesByPath.get(filePath);
    if (pathNodes) {
      candidateNodes.push(...pathNodes);
    }

    // 2. Renamed previous path match
    if (file.previousPath && file.previousPath.trim().length > 0) {
      const prevNodes = nodesByPath.get(file.previousPath.trim());
      if (prevNodes) {
        candidateNodes.push(...prevNodes);
      }
    }

    // 3. Module canonicalId match (e.g. mod:src/utils.ts)
    const moduleCanonicalId = `mod:${filePath}`;
    const moduleNode = nodeByCanonicalId.get(moduleCanonicalId);
    if (moduleNode && !candidateNodes.some((n) => n.id === moduleNode.id)) {
      candidateNodes.push(moduleNode);
    }

    if (candidateNodes.length === 0) {
      unresolvedFiles.push({
        path: filePath,
        reason: "No matching graph nodes found in current analysis run.",
      });
      continue;
    }

    // If patch is present and contains modified line numbers, correlate with symbol locations
    if (file.patch && file.patch.trim().length > 0) {
      const { oldLines, newLines } = parsePatchModifiedLines(file.patch);
      const changedLineSet = new Set<number>([...oldLines, ...newLines]);

      const matchedSymbols: GraphNode[] = [];

      for (const node of candidateNodes) {
        if (node.nodeType === "symbol") {
          const evRange = extractEvidenceLineRange(node.id, evidenceMap);
          const lineStart = evRange?.lineStart ?? extractSymbolLineStart(node);
          const lineEnd = evRange?.lineEnd ?? extractSymbolLineEnd(node) ?? lineStart;

          if (lineStart !== null && lineEnd !== null) {
            let overlaps = false;
            for (let line = lineStart; line <= lineEnd; line++) {
              if (changedLineSet.has(line)) {
                overlaps = true;
                break;
              }
            }
            if (overlaps) {
              matchedSymbols.push(node);
            }
          }
        }
      }

      if (matchedSymbols.length > 0) {
        // High-precision symbol match: only changed symbols become seeds
        for (const sym of matchedSymbols) {
          seedNodeMap.set(sym.id, sym);
        }
        continue;
      }
    }

    // Fallback: If no patch or no specific symbol lines overlap (e.g. imports or whole file),
    // seed from all symbol nodes for that file, or all candidate nodes if no symbols exist.
    const symbolNodes = candidateNodes.filter((n) => n.nodeType === "symbol");
    if (symbolNodes.length > 0) {
      for (const sym of symbolNodes) {
        seedNodeMap.set(sym.id, sym);
      }
    } else {
      for (const node of candidateNodes) {
        seedNodeMap.set(node.id, node);
      }
    }
  }

  // Stable sort seeds deterministically
  const seedNodes = Array.from(seedNodeMap.values()).sort((a, b) => {
    const cmp = a.canonicalId.localeCompare(b.canonicalId);
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
  });

  const sortedUnresolved = unresolvedFiles.sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  return {
    seedNodes,
    unresolvedFiles: sortedUnresolved,
  };
}

// ---------------------------------------------------------------------------
// Pure In-Memory Deterministic Impact Traversal Engine
// ---------------------------------------------------------------------------

/**
 * Computes deterministic impact analysis over in-memory graph objects.
 * Guarantees cycle termination, depth decay, deterministic ordering, and bounded traversal.
 */
export function computeImpactAnalysis(
  input: ComputeImpactAnalysisInput,
): ImpactAnalysisResult {
  const startTime = Date.now();
  const {
    pullRequestId,
    analysisRunId,
    repositoryId,
    organizationId,
    changedFiles,
    graphNodes,
    graphEdges,
    evidence = [],
    maxDepth = DEFAULT_IMPACT_MAX_DEPTH,
    direction = "outgoing",
    decayFactor = DEFAULT_CONFIDENCE_DECAY_PER_HOP,
    edgeTypes,
    nodeTypes,
  } = input;

  if (
    typeof maxDepth !== "number" ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > HARD_MAX_IMPACT_DEPTH
  ) {
    throw new ImpactAnalysisValidationError(
      `maxDepth must be an integer between 0 and ${HARD_MAX_IMPACT_DEPTH}. Received: ${maxDepth}`,
    );
  }

  if (
    typeof decayFactor !== "number" ||
    !Number.isFinite(decayFactor) ||
    decayFactor <= 0 ||
    decayFactor > 1
  ) {
    throw new ImpactAnalysisValidationError(
      `decayFactor must be a number between 0 and 1. Received: ${decayFactor}`,
    );
  }

  // Build evidence index
  const evidenceMap = new Map<string, EvidenceRecord[]>();
  for (const ev of evidence) {
    const existing = evidenceMap.get(ev.subjectId);
    if (existing) {
      existing.push(ev);
    } else {
      evidenceMap.set(ev.subjectId, [ev]);
    }
  }

  // 1. Resolve changed files to seed nodes
  const { seedNodes, unresolvedFiles } = resolveFilesToSeeds(
    changedFiles,
    graphNodes,
    evidenceMap,
  );

  if (seedNodes.length === 0 || maxDepth === 0) {
    return {
      pullRequestId,
      analysisRunId,
      repositoryId,
      organizationId,
      seedNodes,
      directImpacts: [],
      downstreamImpacts: [],
      affectedApis: [],
      affectedEvents: [],
      affectedServices: [],
      workflowImpactSummary: [],
      unresolvedFiles,
      truncated: false,
      truncationReason: null,
      maxDepthReached: 0,
      executionMetrics: {
        totalSeedNodes: seedNodes.length,
        totalAffectedNodes: 0,
        totalEdgesTraversed: 0,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // 2. Build graph adjacency map
  const nodeById = new Map<string, GraphNode>();
  for (const node of graphNodes) {
    nodeById.set(node.id, node);
  }

  const allowedEdgeTypes = edgeTypes && edgeTypes.length > 0 ? new Set(edgeTypes) : null;
  const allowedNodeTypes = nodeTypes && nodeTypes.length > 0 ? new Set(nodeTypes) : null;

  interface OutgoingEdge {
    neighborId: string;
    edgeId: string;
    edgeType: string;
  }

  const adjacency = new Map<string, OutgoingEdge[]>();

  function addAdjacency(fromId: string, toId: string, edgeId: string, edgeType: string) {
    const targetNode = nodeById.get(toId);
    if (!targetNode) return;
    if (allowedNodeTypes && !allowedNodeTypes.has(targetNode.nodeType)) return;

    const list = adjacency.get(fromId);
    if (list) {
      list.push({ neighborId: toId, edgeId, edgeType });
    } else {
      adjacency.set(fromId, [{ neighborId: toId, edgeId, edgeType }]);
    }
  }

  let totalEdgesTraversed = 0;
  for (const edge of graphEdges) {
    if (allowedEdgeTypes && !allowedEdgeTypes.has(edge.edgeType)) {
      continue;
    }

    if (direction === "outgoing") {
      addAdjacency(edge.sourceNodeId, edge.targetNodeId, edge.id, edge.edgeType);
    } else if (direction === "incoming") {
      addAdjacency(edge.targetNodeId, edge.sourceNodeId, edge.id, edge.edgeType);
    } else if (direction === "both") {
      addAdjacency(edge.sourceNodeId, edge.targetNodeId, edge.id, edge.edgeType);
      addAdjacency(edge.targetNodeId, edge.sourceNodeId, edge.id, edge.edgeType);
    }
  }

  // 3. Multi-seed bounded BFS traversal
  interface BestReached {
    depth: number;
    path: string[];
    edgeIds: string[];
  }

  const bestReached = new Map<string, BestReached>();
  let truncationDetected = false;

  interface QueueItem {
    nodeId: string;
    depth: number;
    path: string[];
    edgeIds: string[];
  }

  const queue: QueueItem[] = [];

  // Initialize seeds at depth 0
  for (const seed of seedNodes) {
    bestReached.set(seed.id, {
      depth: 0,
      path: [seed.id],
      edgeIds: [],
    });
    queue.push({
      nodeId: seed.id,
      depth: 0,
      path: [seed.id],
      edgeIds: [],
    });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current.nodeId);
    if (!neighbors || neighbors.length === 0) {
      continue;
    }

    // Sort neighbors deterministically to avoid random row-order variance
    const sortedNeighbors = [...neighbors].sort((a, b) => {
      const nodeA = nodeById.get(a.neighborId);
      const nodeB = nodeById.get(b.neighborId);
      const canA = nodeA?.canonicalId ?? a.neighborId;
      const canB = nodeB?.canonicalId ?? b.neighborId;
      return canA.localeCompare(canB);
    });

    for (const edge of sortedNeighbors) {
      totalEdgesTraversed++;

      // Cycle prevention: do not re-visit any node already in the current path
      if (current.path.includes(edge.neighborId)) {
        continue;
      }

      const nextDepth = current.depth + 1;

      // If neighbor would exceed maxDepth, mark truncation and stop propagation along this branch
      if (nextDepth > maxDepth) {
        truncationDetected = true;
        continue;
      }

      const nextPath = [...current.path, edge.neighborId];
      const nextEdgeIds = [...current.edgeIds, edge.edgeId];

      const existing = bestReached.get(edge.neighborId);
      let shouldUpdate = false;

      if (!existing) {
        shouldUpdate = true;
      } else if (nextDepth < existing.depth) {
        shouldUpdate = true;
      } else if (nextDepth === existing.depth) {
        // Deterministic tie-break by path canonical representations
        const existingPathStr = existing.path.join("/");
        const nextPathStr = nextPath.join("/");
        if (nextPathStr.localeCompare(existingPathStr) < 0) {
          shouldUpdate = true;
        }
      }

      if (shouldUpdate) {
        bestReached.set(edge.neighborId, {
          depth: nextDepth,
          path: nextPath,
          edgeIds: nextEdgeIds,
        });

        // Continue exploring from this neighbor if depth allows
        if (nextDepth < maxDepth) {
          queue.push({
            nodeId: edge.neighborId,
            depth: nextDepth,
            path: nextPath,
            edgeIds: nextEdgeIds,
          });
        } else if (nextDepth === maxDepth) {
          // Check if this maxDepth node has any further unvisited neighbors
          const furtherNeighbors = adjacency.get(edge.neighborId);
          if (furtherNeighbors) {
            for (const fn of furtherNeighbors) {
              if (!nextPath.includes(fn.neighborId)) {
                truncationDetected = true;
                break;
              }
            }
          }
        }
      }
    }
  }

  // 4. Transform and Classify Findings
  const directImpacts: ImpactFinding[] = [];
  const downstreamImpacts: ImpactFinding[] = [];
  const affectedApis: ImpactFinding[] = [];
  const affectedEvents: ImpactFinding[] = [];
  const affectedServices: ImpactFinding[] = [];
  const workflowSummaries = new Set<string>();

  let maxDepthReached = 0;

  for (const [nodeId, reachInfo] of bestReached.entries()) {
    // Exclude seed nodes (depth 0) from affected downstream impacts
    if (reachInfo.depth === 0) {
      continue;
    }

    const node = nodeById.get(nodeId);
    if (!node) continue;

    if (reachInfo.depth > maxDepthReached) {
      maxDepthReached = reachInfo.depth;
    }

    // Deterministic depth-based confidence decay:
    // Base node confidence decayed by decayFactor^depth, rounded to 4 decimals
    const decayedConfidence = Math.round(
      node.confidence * Math.pow(decayFactor, reachInfo.depth) * 10000,
    ) / 10000;

    // Collect evidence IDs associated with node or shortest path edges
    const evidenceIds: string[] = [];
    const nodeEv = evidenceMap.get(node.id);
    if (nodeEv) {
      for (const ev of nodeEv) evidenceIds.push(ev.id);
    }
    for (const edgeId of reachInfo.edgeIds) {
      const edgeEv = evidenceMap.get(edgeId);
      if (edgeEv) {
        for (const ev of edgeEv) evidenceIds.push(ev.id);
      }
    }

    const finding: ImpactFinding = {
      node,
      depth: reachInfo.depth,
      confidence: decayedConfidence,
      path: reachInfo.path,
      ...(evidenceIds.length > 0
        ? { evidenceIds: Array.from(new Set(evidenceIds)).sort() }
        : {}),
    };

    // Classify by depth
    if (reachInfo.depth === 1) {
      directImpacts.push(finding);
    } else {
      downstreamImpacts.push(finding);
    }

    // Classify by GraphNode taxonomy
    if (node.nodeType === "api") {
      affectedApis.push(finding);
      const routeStr = typeof node.metadata?.routePath === "string"
        ? node.metadata.routePath
        : node.name;
      workflowSummaries.add(`API route: ${routeStr}`);
    } else if (node.nodeType === "event") {
      affectedEvents.push(finding);
      workflowSummaries.add(`Event: ${node.name}`);
    } else if (node.nodeType === "service" || node.nodeType === "application") {
      affectedServices.push(finding);
      workflowSummaries.add(`Service: ${node.name}`);
    }
  }

  // Deterministic stable sorting
  const sortFindings = (list: ImpactFinding[]) =>
    list.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      const cmp = a.node.canonicalId.localeCompare(b.node.canonicalId);
      return cmp !== 0 ? cmp : a.node.id.localeCompare(b.node.id);
    });

  sortFindings(directImpacts);
  sortFindings(downstreamImpacts);
  sortFindings(affectedApis);
  sortFindings(affectedEvents);
  sortFindings(affectedServices);

  const totalAffectedNodes = directImpacts.length + downstreamImpacts.length;

  return {
    pullRequestId,
    analysisRunId,
    repositoryId,
    organizationId,
    seedNodes,
    directImpacts,
    downstreamImpacts,
    affectedApis,
    affectedEvents,
    affectedServices,
    workflowImpactSummary: Array.from(workflowSummaries).sort(),
    unresolvedFiles,
    truncated: truncationDetected,
    truncationReason: truncationDetected
      ? `Traversal reached maximum depth limit of ${maxDepth} hops; additional downstream nodes exist.`
      : null,
    maxDepthReached,
    executionMetrics: {
      totalSeedNodes: seedNodes.length,
      totalAffectedNodes,
      totalEdgesTraversed,
      durationMs: Date.now() - startTime,
    },
  };
}

// ---------------------------------------------------------------------------
// Database-Backed Seed Resolution Helper
// ---------------------------------------------------------------------------

interface GraphNodeRow {
  id: string;
  analysis_run_id: string;
  canonical_id: string;
  node_type: string;
  name: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
  confidence: number;
  created_at: Date;
}

interface EvidenceRow {
  id: string;
  analysis_run_id: string;
  subject_type: string;
  subject_id: string;
  file_path: string;
  symbol_id: string | null;
  line_start: number | null;
  line_end: number | null;
  column_start: number | null;
  column_end: number | null;
  relationship_description: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

function mapGraphNodeRow(row: GraphNodeRow): GraphNode {
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    canonicalId: row.canonical_id,
    nodeType: row.node_type as GraphNodeType,
    name: row.name,
    path: row.path,
    metadata: row.metadata ?? {},
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

function mapEvidenceRow(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    subjectType: row.subject_type as EvidenceSubjectType,
    subjectId: row.subject_id,
    filePath: row.file_path,
    symbolId: row.symbol_id,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    columnStart: row.column_start,
    columnEnd: row.column_end,
    relationshipDescription: row.relationship_description,
    confidence: row.confidence,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

/**
 * Resolves pull request changed files to graph nodes from PostgreSQL within a tenant transaction.
 */
export async function resolveChangedFilesToSeeds(
  client: pg.PoolClient,
  _organizationId: string,
  analysisRunId: string,
  changedFiles: readonly PullRequestFile[],
): Promise<ResolveSeedsResult> {
  if (changedFiles.length === 0) {
    return { seedNodes: [], unresolvedFiles: [] };
  }

  const filePaths = Array.from(
    new Set(
      changedFiles.flatMap((f) => [f.path, f.previousPath].filter(Boolean) as string[]),
    ),
  );

  const moduleCanonicalIds = filePaths.map((p) => `mod:${p}`);

  // Fetch all graph nodes for these paths and module canonicalIds
  const nodesRes = await client.query<GraphNodeRow>(
    `SELECT id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence, created_at
     FROM graph_nodes
     WHERE analysis_run_id = $1::uuid
       AND (path = ANY($2::text[]) OR canonical_id = ANY($3::text[]))
     ORDER BY canonical_id ASC, id ASC`,
    [analysisRunId, filePaths, moduleCanonicalIds],
  );

  const candidateNodes = nodesRes.rows.map(mapGraphNodeRow);
  const nodeIds = candidateNodes.map((n) => n.id);

  // Fetch node evidence for precise line range matching
  const evidenceMap = new Map<string, EvidenceRecord[]>();
  if (nodeIds.length > 0) {
    const evRes = await client.query<EvidenceRow>(
      `SELECT id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
              line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at
       FROM evidence
       WHERE analysis_run_id = $1::uuid
         AND subject_type = 'graph_node'
         AND subject_id = ANY($2::uuid[])
       ORDER BY created_at ASC, id ASC`,
      [analysisRunId, nodeIds],
    );
    for (const row of evRes.rows) {
      const ev = mapEvidenceRow(row);
      const list = evidenceMap.get(ev.subjectId);
      if (list) list.push(ev);
      else evidenceMap.set(ev.subjectId, [ev]);
    }
  }

  return resolveFilesToSeeds(changedFiles, candidateNodes, evidenceMap);
}

// ---------------------------------------------------------------------------
// Database-Backed End-to-End Impact Analysis Engine
// ---------------------------------------------------------------------------

/**
 * End-to-end multi-tenant Impact Analysis Engine for Step 43.
 * Queries stored pull request, resolves changed files to seeds, traverses graph,
 * and produces deterministic in-memory result.
 */
export async function analyzePullRequestImpact(
  pool: pg.Pool,
  options: AnalyzePullRequestImpactOptions,
): Promise<ImpactAnalysisResult> {
  const startTime = Date.now();
  const {
    organizationId,
    pullRequestId,
    analysisRunId: requestedAnalysisRunId,
    maxDepth = DEFAULT_IMPACT_MAX_DEPTH,
    direction = "outgoing",
    decayFactor = DEFAULT_CONFIDENCE_DECAY_PER_HOP,
    edgeTypes,
    nodeTypes,
    includeEvidence = true,
  } = options;

  // 1. Strict Input Validation
  if (!UUID_REGEX.test(organizationId)) {
    throw new ImpactAnalysisValidationError(
      "organizationId must be a valid UUID string.",
    );
  }
  if (!UUID_REGEX.test(pullRequestId)) {
    throw new ImpactAnalysisValidationError(
      "pullRequestId must be a valid UUID string.",
    );
  }
  if (
    requestedAnalysisRunId !== undefined &&
    !UUID_REGEX.test(requestedAnalysisRunId)
  ) {
    throw new ImpactAnalysisValidationError(
      "analysisRunId must be a valid UUID string.",
    );
  }
  if (
    typeof maxDepth !== "number" ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > HARD_MAX_IMPACT_DEPTH
  ) {
    throw new ImpactAnalysisValidationError(
      `maxDepth must be an integer between 0 and ${HARD_MAX_IMPACT_DEPTH}. Received: ${maxDepth}`,
    );
  }
  if (
    typeof decayFactor !== "number" ||
    !Number.isFinite(decayFactor) ||
    decayFactor <= 0 ||
    decayFactor > 1
  ) {
    throw new ImpactAnalysisValidationError(
      `decayFactor must be a number between 0 and 1. Received: ${decayFactor}`,
    );
  }
  if (
    direction !== "outgoing" &&
    direction !== "incoming" &&
    direction !== "both"
  ) {
    throw new ImpactAnalysisValidationError(`Invalid direction: ${direction}`);
  }

  // 2. Tenant Scoping & Resolution
  return withTenant(pool, organizationId, async (client) => {
    // 2.1 Verify pull request exists within tenant
    const prRes = await client.query<{
      id: string;
      organization_id: string;
      repository_id: string;
      number: number;
    }>(
      `SELECT id, organization_id, repository_id, number
       FROM pull_requests
       WHERE id = $1::uuid AND organization_id = $2::uuid`,
      [pullRequestId, organizationId],
    );

    const pr = prRes.rows[0];
    if (!pr) {
      throw new PullRequestNotFoundError(
        `Pull request ${pullRequestId} not found or inaccessible for organization ${organizationId}.`,
      );
    }

    // 2.2 Resolve Analysis Run ID (current repository graph snapshot)
    let effectiveAnalysisRunId: string;
    if (requestedAnalysisRunId) {
      const runRes = await client.query<{ id: string; status: string }>(
        `SELECT ar.id, ar.status
         FROM analysis_runs ar
         JOIN repository_snapshots rs ON rs.id = ar.snapshot_id
         JOIN repositories repo ON repo.id = rs.repository_id
         WHERE ar.id = $1::uuid
           AND repo.id = $2::uuid
           AND repo.organization_id = $3::uuid`,
        [requestedAnalysisRunId, pr.repository_id, organizationId],
      );
      const runRow = runRes.rows[0];
      if (!runRow) {
        throw new AnalysisSnapshotUnavailableError(
          `Analysis run ${requestedAnalysisRunId} does not exist or does not belong to repository ${pr.repository_id}.`,
        );
      }
      effectiveAnalysisRunId = runRow.id;
    } else {
      // Find latest completed analysis run for this repository
      const latestRunRes = await client.query<{ id: string }>(
        `SELECT ar.id
         FROM analysis_runs ar
         JOIN repository_snapshots rs ON rs.id = ar.snapshot_id
         JOIN repositories repo ON repo.id = rs.repository_id
         WHERE repo.id = $1::uuid
           AND repo.organization_id = $2::uuid
           AND ar.status = 'completed'
         ORDER BY ar.created_at DESC, ar.id DESC
         LIMIT 1`,
        [pr.repository_id, organizationId],
      );
      const latestRun = latestRunRes.rows[0];
      if (!latestRun) {
        throw new AnalysisSnapshotUnavailableError(
          `No completed analysis run found for repository ${pr.repository_id}.`,
        );
      }
      effectiveAnalysisRunId = latestRun.id;
    }

    // 2.3 Fetch changed files for the pull request
    const files = await listPullRequestFiles(pool, organizationId, pullRequestId);
    if (files.length === 0) {
      return {
        pullRequestId,
        analysisRunId: effectiveAnalysisRunId,
        repositoryId: pr.repository_id,
        organizationId,
        seedNodes: [],
        directImpacts: [],
        downstreamImpacts: [],
        affectedApis: [],
        affectedEvents: [],
        affectedServices: [],
        workflowImpactSummary: [],
        unresolvedFiles: [],
        truncated: false,
        truncationReason: null,
        maxDepthReached: 0,
        executionMetrics: {
          totalSeedNodes: 0,
          totalAffectedNodes: 0,
          totalEdgesTraversed: 0,
          durationMs: Date.now() - startTime,
        },
      };
    }

    // 2.4 Resolve changed files to seeds
    const { seedNodes, unresolvedFiles } = await resolveChangedFilesToSeeds(
      client,
      organizationId,
      effectiveAnalysisRunId,
      files,
    );

    if (seedNodes.length === 0 || maxDepth === 0) {
      return {
        pullRequestId,
        analysisRunId: effectiveAnalysisRunId,
        repositoryId: pr.repository_id,
        organizationId,
        seedNodes,
        directImpacts: [],
        downstreamImpacts: [],
        affectedApis: [],
        affectedEvents: [],
        affectedServices: [],
        workflowImpactSummary: [],
        unresolvedFiles,
        truncated: false,
        truncationReason: null,
        maxDepthReached: 0,
        executionMetrics: {
          totalSeedNodes: seedNodes.length,
          totalAffectedNodes: 0,
          totalEdgesTraversed: 0,
          durationMs: Date.now() - startTime,
        },
      };
    }

    // 2.5 Multi-seed graph traversal reusing Step 30's `traverseGraph`
    // We traverse up to `maxDepth + 1` (clamped to HARD_MAX_IMPACT_DEPTH) to detect truncation
    const probeDepth = Math.min(maxDepth + 1, HARD_MAX_IMPACT_DEPTH);

    interface AccumulatedNode {
      node: GraphNode;
      minDepth: number;
      shortestPath: readonly string[];
      evidenceIds: Set<string>;
    }

    const accumulatedMap = new Map<string, AccumulatedNode>();
    let truncationDetected = false;
    let totalEdgesTraversed = 0;

    // Run traversal for each seed node
    for (const seed of seedNodes) {
      const traversal = await traverseGraph(pool, {
        organizationId,
        analysisRunId: effectiveAnalysisRunId,
        startNodeId: seed.id,
        maxDepth: probeDepth,
        direction,
        includeEvidence,
        ...(edgeTypes !== undefined ? { edgeTypes } : {}),
        ...(nodeTypes !== undefined ? { nodeTypes } : {}),
      });

      totalEdgesTraversed += traversal.edges.length;

      // Evidence lookup from traversal result
      const traversalEvidence = traversal.evidence ?? [];
      const evidenceBySubject = new Map<string, string[]>();
      for (const ev of traversalEvidence) {
        const list = evidenceBySubject.get(ev.subjectId);
        if (list) list.push(ev.id);
        else evidenceBySubject.set(ev.subjectId, [ev.id]);
      }

      for (const tn of traversal.nodes) {
        if (tn.depth > maxDepth) {
          truncationDetected = true;
          continue;
        }

        // Exclude seeds (depth 0) from accumulated downstream findings
        if (tn.depth === 0) {
          continue;
        }

        const existing = accumulatedMap.get(tn.node.id);
        if (!existing) {
          const evIds = new Set(evidenceBySubject.get(tn.node.id) ?? []);
          accumulatedMap.set(tn.node.id, {
            node: tn.node,
            minDepth: tn.depth,
            shortestPath: tn.path,
            evidenceIds: evIds,
          });
        } else if (tn.depth < existing.minDepth) {
          existing.minDepth = tn.depth;
          existing.shortestPath = tn.path;
          for (const evId of evidenceBySubject.get(tn.node.id) ?? []) {
            existing.evidenceIds.add(evId);
          }
        } else if (tn.depth === existing.minDepth) {
          // Stable tie break
          if (tn.path.join("/").localeCompare(existing.shortestPath.join("/")) < 0) {
            existing.shortestPath = tn.path;
          }
          for (const evId of evidenceBySubject.get(tn.node.id) ?? []) {
            existing.evidenceIds.add(evId);
          }
        }
      }
    }

    // 2.6 Classify findings
    const directImpacts: ImpactFinding[] = [];
    const downstreamImpacts: ImpactFinding[] = [];
    const affectedApis: ImpactFinding[] = [];
    const affectedEvents: ImpactFinding[] = [];
    const affectedServices: ImpactFinding[] = [];
    const workflowSummaries = new Set<string>();

    let maxDepthReached = 0;

    for (const acc of accumulatedMap.values()) {
      if (acc.minDepth > maxDepthReached) {
        maxDepthReached = acc.minDepth;
      }

      const decayedConfidence = Math.round(
        acc.node.confidence * Math.pow(decayFactor, acc.minDepth) * 10000,
      ) / 10000;

      const finding: ImpactFinding = {
        node: acc.node,
        depth: acc.minDepth,
        confidence: decayedConfidence,
        path: acc.shortestPath,
        ...(acc.evidenceIds.size > 0
          ? { evidenceIds: Array.from(acc.evidenceIds).sort() }
          : {}),
      };

      if (acc.minDepth === 1) {
        directImpacts.push(finding);
      } else {
        downstreamImpacts.push(finding);
      }

      if (acc.node.nodeType === "api") {
        affectedApis.push(finding);
        const routeStr = typeof acc.node.metadata?.routePath === "string"
          ? acc.node.metadata.routePath
          : acc.node.name;
        workflowSummaries.add(`API route: ${routeStr}`);
      } else if (acc.node.nodeType === "event") {
        affectedEvents.push(finding);
        workflowSummaries.add(`Event: ${acc.node.name}`);
      } else if (
        acc.node.nodeType === "service" ||
        acc.node.nodeType === "application"
      ) {
        affectedServices.push(finding);
        workflowSummaries.add(`Service: ${acc.node.name}`);
      }
    }

    // Stable deterministic sort
    const sortFindings = (list: ImpactFinding[]) =>
      list.sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        const cmp = a.node.canonicalId.localeCompare(b.node.canonicalId);
        return cmp !== 0 ? cmp : a.node.id.localeCompare(b.node.id);
      });

    sortFindings(directImpacts);
    sortFindings(downstreamImpacts);
    sortFindings(affectedApis);
    sortFindings(affectedEvents);
    sortFindings(affectedServices);

    const totalAffectedNodes = directImpacts.length + downstreamImpacts.length;

    return {
      pullRequestId,
      analysisRunId: effectiveAnalysisRunId,
      repositoryId: pr.repository_id,
      organizationId,
      seedNodes,
      directImpacts,
      downstreamImpacts,
      affectedApis,
      affectedEvents,
      affectedServices,
      workflowImpactSummary: Array.from(workflowSummaries).sort(),
      unresolvedFiles,
      truncated: truncationDetected,
      truncationReason: truncationDetected
        ? `Traversal reached maximum depth limit of ${maxDepth} hops; additional downstream nodes exist.`
        : null,
      maxDepthReached,
      executionMetrics: {
        totalSeedNodes: seedNodes.length,
        totalAffectedNodes,
        totalEdgesTraversed,
        durationMs: Date.now() - startTime,
      },
    };
  });
}
