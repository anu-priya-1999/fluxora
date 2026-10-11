import type {
  GraphDiff,
  GraphDiffSummary,
  GraphEdgeDiffItem,
  GraphNodeDiffItem,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GraphDiffNodeInput {
  readonly id?: string;
  readonly canonicalId: string;
  readonly nodeType: string;
  readonly name: string;
  readonly path?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly confidence?: number;
}

export interface GraphDiffEdgeInput {
  readonly id?: string;
  readonly canonicalId?: string | null;
  readonly sourceNodeId?: string;
  readonly targetNodeId?: string;
  readonly sourceCanonicalId?: string;
  readonly targetCanonicalId?: string;
  readonly edgeType: string;
  readonly metadata?: Record<string, unknown>;
  readonly confidence?: number;
  readonly provenance?: string;
}

export interface GraphStateInput {
  readonly nodes?: readonly GraphDiffNodeInput[];
  readonly edges?: readonly GraphDiffEdgeInput[];
}

export function canonicalJsonStringify(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(canonicalJsonStringify).join(",")}]`;
  }
  const keys = Object.keys(val as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) =>
      `${JSON.stringify(k)}:${canonicalJsonStringify((val as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(",")}}`;
}

/**
 * Pure, deterministic in-memory Graph Diff computation.
 * Compares "before" and "after" graph states and generates a structured diff and summary.
 */
export function computeGraphDiff(
  previousState: GraphStateInput | null | undefined,
  currentState: GraphStateInput,
): GraphDiff {
  const prevNodes = previousState?.nodes ?? [];
  const prevEdges = previousState?.edges ?? [];
  const currNodes = currentState.nodes ?? [];
  const currEdges = currentState.edges ?? [];

  // 1. Index Nodes by canonicalId and by id
  const prevNodesMap = new Map<string, GraphDiffNodeInput>();
  const prevNodeIdToCanonicalId = new Map<string, string>();
  for (const n of prevNodes) {
    if (!prevNodesMap.has(n.canonicalId)) {
      prevNodesMap.set(n.canonicalId, n);
    }
    if (n.id) {
      prevNodeIdToCanonicalId.set(n.id, n.canonicalId);
    }
  }

  const currNodesMap = new Map<string, GraphDiffNodeInput>();
  const currNodeIdToCanonicalId = new Map<string, string>();
  for (const n of currNodes) {
    if (!currNodesMap.has(n.canonicalId)) {
      currNodesMap.set(n.canonicalId, n);
    }
    if (n.id) {
      currNodeIdToCanonicalId.set(n.id, n.canonicalId);
    }
  }

  // 2. Classify Node Changes
  const addedNodes: GraphNodeDiffItem[] = [];
  const removedNodes: GraphNodeDiffItem[] = [];
  const changedNodes: GraphNodeDiffItem[] = [];
  let nodesUnchanged = 0;

  // Nodes added or changed
  for (const [canonicalId, curr] of currNodesMap) {
    const prev = prevNodesMap.get(canonicalId);
    if (!prev) {
      addedNodes.push({
        canonicalId,
        nodeType: curr.nodeType,
        name: curr.name,
        path: curr.path ?? null,
        changeType: "added",
      });
    } else {
      const changedFields: string[] = [];
      if (curr.nodeType !== prev.nodeType) changedFields.push("nodeType");
      if (curr.name !== prev.name) changedFields.push("name");
      if ((curr.path ?? null) !== (prev.path ?? null)) changedFields.push("path");
      if (
        Math.abs((curr.confidence ?? 1.0) - (prev.confidence ?? 1.0)) > 1e-6
      ) {
        changedFields.push("confidence");
      }
      if (
        canonicalJsonStringify(curr.metadata ?? {}) !==
        canonicalJsonStringify(prev.metadata ?? {})
      ) {
        changedFields.push("metadata");
      }

      if (changedFields.length > 0) {
        changedFields.sort();
        changedNodes.push({
          canonicalId,
          nodeType: curr.nodeType,
          name: curr.name,
          path: curr.path ?? null,
          changeType: "changed",
          changedFields,
        });
      } else {
        nodesUnchanged++;
      }
    }
  }

  // Nodes removed
  for (const [canonicalId, prev] of prevNodesMap) {
    if (!currNodesMap.has(canonicalId)) {
      removedNodes.push({
        canonicalId,
        nodeType: prev.nodeType,
        name: prev.name,
        path: prev.path ?? null,
        changeType: "removed",
      });
    }
  }

  // 3. Resolve & Index Edges
  function resolveEdgeCoordinates(
    edge: GraphDiffEdgeInput,
    idMap: Map<string, string>,
  ): { sourceCanonicalId: string; targetCanonicalId: string } {
    const sourceCanonicalId =
      edge.sourceCanonicalId ??
      (edge.sourceNodeId ? idMap.get(edge.sourceNodeId) : undefined) ??
      "";
    const targetCanonicalId =
      edge.targetCanonicalId ??
      (edge.targetNodeId ? idMap.get(edge.targetNodeId) : undefined) ??
      "";
    return { sourceCanonicalId, targetCanonicalId };
  }

  function getEdgeKey(
    sourceCanonicalId: string,
    targetCanonicalId: string,
    edgeType: string,
  ): string {
    return `${sourceCanonicalId}->${targetCanonicalId}:${edgeType}`;
  }

  const prevEdgesMap = new Map<
    string,
    { edge: GraphDiffEdgeInput; sourceCanonicalId: string; targetCanonicalId: string }
  >();
  for (const edge of prevEdges) {
    const { sourceCanonicalId, targetCanonicalId } = resolveEdgeCoordinates(
      edge,
      prevNodeIdToCanonicalId,
    );
    const key = getEdgeKey(sourceCanonicalId, targetCanonicalId, edge.edgeType);
    if (!prevEdgesMap.has(key)) {
      prevEdgesMap.set(key, { edge, sourceCanonicalId, targetCanonicalId });
    }
  }

  const currEdgesMap = new Map<
    string,
    { edge: GraphDiffEdgeInput; sourceCanonicalId: string; targetCanonicalId: string }
  >();
  for (const edge of currEdges) {
    const { sourceCanonicalId, targetCanonicalId } = resolveEdgeCoordinates(
      edge,
      currNodeIdToCanonicalId,
    );
    const key = getEdgeKey(sourceCanonicalId, targetCanonicalId, edge.edgeType);
    if (!currEdgesMap.has(key)) {
      currEdgesMap.set(key, { edge, sourceCanonicalId, targetCanonicalId });
    }
  }

  // 4. Classify Edge Changes
  const addedEdges: GraphEdgeDiffItem[] = [];
  const removedEdges: GraphEdgeDiffItem[] = [];
  const changedEdges: GraphEdgeDiffItem[] = [];
  let edgesUnchanged = 0;

  // Edges added or changed
  for (const [key, curr] of currEdgesMap) {
    const prev = prevEdgesMap.get(key);
    if (!prev) {
      addedEdges.push({
        canonicalId: curr.edge.canonicalId ?? null,
        sourceCanonicalId: curr.sourceCanonicalId,
        targetCanonicalId: curr.targetCanonicalId,
        edgeType: curr.edge.edgeType,
        changeType: "added",
      });
    } else {
      const changedFields: string[] = [];
      if (
        Math.abs(
          (curr.edge.confidence ?? 1.0) - (prev.edge.confidence ?? 1.0),
        ) > 1e-6
      ) {
        changedFields.push("confidence");
      }
      if (
        (curr.edge.provenance ?? "static-analysis") !==
        (prev.edge.provenance ?? "static-analysis")
      ) {
        changedFields.push("provenance");
      }
      if ((curr.edge.canonicalId ?? null) !== (prev.edge.canonicalId ?? null)) {
        changedFields.push("canonicalId");
      }
      if (
        canonicalJsonStringify(curr.edge.metadata ?? {}) !==
        canonicalJsonStringify(prev.edge.metadata ?? {})
      ) {
        changedFields.push("metadata");
      }

      if (changedFields.length > 0) {
        changedFields.sort();
        changedEdges.push({
          canonicalId: curr.edge.canonicalId ?? null,
          sourceCanonicalId: curr.sourceCanonicalId,
          targetCanonicalId: curr.targetCanonicalId,
          edgeType: curr.edge.edgeType,
          changeType: "changed",
          changedFields,
        });
      } else {
        edgesUnchanged++;
      }
    }
  }

  // Edges removed
  for (const [, prev] of prevEdgesMap) {
    const key = getEdgeKey(
      prev.sourceCanonicalId,
      prev.targetCanonicalId,
      prev.edge.edgeType,
    );
    if (!currEdgesMap.has(key)) {
      removedEdges.push({
        canonicalId: prev.edge.canonicalId ?? null,
        sourceCanonicalId: prev.sourceCanonicalId,
        targetCanonicalId: prev.targetCanonicalId,
        edgeType: prev.edge.edgeType,
        changeType: "removed",
      });
    }
  }

  // 5. Deterministic Sorting
  addedNodes.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
  removedNodes.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
  changedNodes.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

  function edgeSortKey(e: GraphEdgeDiffItem): string {
    return `${e.sourceCanonicalId}:${e.targetCanonicalId}:${e.edgeType}:${e.canonicalId ?? ""}`;
  }

  addedEdges.sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)));
  removedEdges.sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)));
  changedEdges.sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)));

  // 6. Summary Counts
  const totalNodesBefore = prevNodesMap.size;
  const totalNodesAfter = currNodesMap.size;
  const totalEdgesBefore = prevEdgesMap.size;
  const totalEdgesAfter = currEdgesMap.size;
  const nodeDelta = totalNodesAfter - totalNodesBefore;
  const edgeDelta = totalEdgesAfter - totalEdgesBefore;

  const summary: GraphDiffSummary = {
    nodesAdded: addedNodes.length,
    nodesRemoved: removedNodes.length,
    nodesChanged: changedNodes.length,
    nodesUnchanged,
    edgesAdded: addedEdges.length,
    edgesRemoved: removedEdges.length,
    edgesChanged: changedEdges.length,
    edgesUnchanged,
    totalNodesBefore,
    totalNodesAfter,
    totalEdgesBefore,
    totalEdgesAfter,
    nodes_added: addedNodes.length,
    nodes_removed: removedNodes.length,
    nodes_changed: changedNodes.length,
    nodes_unchanged: nodesUnchanged,
    edges_added: addedEdges.length,
    edges_removed: removedEdges.length,
    edges_changed: changedEdges.length,
    edges_unchanged: edgesUnchanged,
    node_delta: nodeDelta,
    edge_delta: edgeDelta,
    total_nodes_before: totalNodesBefore,
    total_nodes_after: totalNodesAfter,
    total_edges_before: totalEdgesBefore,
    total_edges_after: totalEdgesAfter,
  };

  return {
    summary,
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges,
    removedEdges,
    changedEdges,
  };
}

/**
 * Loads graph state for an analysis run inside an existing client transaction.
 */
export async function getGraphStateForAnalysisRunTx(
  client: pg.PoolClient,
  _organizationId: string,
  analysisRunId: string,
): Promise<{ nodes: GraphDiffNodeInput[]; edges: GraphDiffEdgeInput[] }> {
  if (!UUID_REGEX.test(analysisRunId)) {
    return { nodes: [], edges: [] };
  }

  const nodesRes = await client.query<{
    id: string;
    canonical_id: string;
    node_type: string;
    name: string;
    path: string | null;
    metadata: Record<string, unknown>;
    confidence: number;
  }>(
    `SELECT id, canonical_id, node_type, name, path, metadata, confidence
     FROM graph_nodes
     WHERE analysis_run_id = $1::uuid
       AND fluxora_analysis_run_in_current_tenant(analysis_run_id)
     ORDER BY canonical_id ASC`,
    [analysisRunId],
  );

  const edgesRes = await client.query<{
    id: string;
    source_node_id: string;
    target_node_id: string;
    edge_type: string;
    canonical_id: string | null;
    metadata: Record<string, unknown>;
    confidence: number;
    provenance: string;
  }>(
    `SELECT id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance
     FROM graph_edges
     WHERE analysis_run_id = $1::uuid
       AND fluxora_analysis_run_in_current_tenant(analysis_run_id)
     ORDER BY source_node_id ASC, target_node_id ASC, edge_type ASC`,
    [analysisRunId],
  );

  const nodes: GraphDiffNodeInput[] = nodesRes.rows.map((r) => ({
    id: r.id,
    canonicalId: r.canonical_id,
    nodeType: r.node_type,
    name: r.name,
    path: r.path,
    metadata: r.metadata ?? {},
    confidence: r.confidence,
  }));

  const edges: GraphDiffEdgeInput[] = edgesRes.rows.map((r) => ({
    id: r.id,
    sourceNodeId: r.source_node_id,
    targetNodeId: r.target_node_id,
    edgeType: r.edge_type,
    canonicalId: r.canonical_id,
    metadata: r.metadata ?? {},
    confidence: r.confidence,
    provenance: r.provenance,
  }));

  return { nodes, edges };
}

/**
 * Loads graph state for an analysis run.
 */
export async function getGraphStateForAnalysisRun(
  pool: pg.Pool,
  organizationId: string,
  analysisRunId: string,
): Promise<{ nodes: GraphDiffNodeInput[]; edges: GraphDiffEdgeInput[] }> {
  return withTenant(pool, organizationId, async (client) => {
    return getGraphStateForAnalysisRunTx(client, organizationId, analysisRunId);
  });
}

/**
 * Resolves previous analysis run id and loads its graph state within a transaction.
 */
export async function resolvePreviousGraphStateTx(
  client: pg.PoolClient,
  organizationId: string,
  currentAnalysisRunId: string,
  previousAnalysisRunId?: string | null,
): Promise<{ previousRunId: string | null; state: GraphStateInput }> {
  let targetPrevRunId: string | null = null;

  if (previousAnalysisRunId !== undefined) {
    targetPrevRunId = previousAnalysisRunId;
  } else {
    // Look up previous completed analysis run for the same repository
    const prevRunLookup = await client.query<{ id: string }>(
      `SELECT prev_ar.id
       FROM analysis_runs cur_ar
       JOIN repository_snapshots cur_rs ON cur_rs.id = cur_ar.snapshot_id
       JOIN repository_snapshots prev_rs ON prev_rs.repository_id = cur_rs.repository_id
       JOIN analysis_runs prev_ar ON prev_ar.snapshot_id = prev_rs.id
       WHERE cur_ar.id = $1::uuid
         AND prev_ar.id <> $1::uuid
         AND prev_ar.status = 'completed'
       ORDER BY prev_ar.created_at DESC, prev_ar.id DESC
       LIMIT 1`,
      [currentAnalysisRunId],
    );
    if (prevRunLookup.rows[0]) {
      targetPrevRunId = prevRunLookup.rows[0].id;
    }
  }

  if (targetPrevRunId && UUID_REGEX.test(targetPrevRunId)) {
    const prevState = await getGraphStateForAnalysisRunTx(
      client,
      organizationId,
      targetPrevRunId,
    );
    return { previousRunId: targetPrevRunId, state: prevState };
  }

  return { previousRunId: null, state: { nodes: [], edges: [] } };
}

/**
 * Resolves repository correlation metadata for an analysis run within a transaction.
 */
export async function resolveAnalysisRunCorrelationTx(
  client: pg.PoolClient,
  analysisRunId: string,
): Promise<{ repositoryId?: string; commitSha?: string }> {
  if (!UUID_REGEX.test(analysisRunId)) {
    return {};
  }

  const res = await client.query<{ repository_id: string; commit_sha: string }>(
    `SELECT rs.repository_id, rs.commit_sha
     FROM analysis_runs ar
     JOIN repository_snapshots rs ON rs.id = ar.snapshot_id
     WHERE ar.id = $1::uuid`,
    [analysisRunId],
  );

  const row = res.rows[0];
  if (!row) {
    return {};
  }

  return {
    repositoryId: row.repository_id,
    commitSha: row.commit_sha,
  };
}

/**
 * Computes a deterministic graph diff across two analysis runs within the specified organization.
 */
export async function diffAnalysisRuns(
  pool: pg.Pool,
  options: {
    organizationId: string;
    currentAnalysisRunId: string;
    previousAnalysisRunId?: string | null;
  },
): Promise<GraphDiff> {
  const { organizationId, currentAnalysisRunId, previousAnalysisRunId } =
    options;

  if (
    !UUID_REGEX.test(organizationId) ||
    !UUID_REGEX.test(currentAnalysisRunId)
  ) {
    throw new Error("Invalid organizationId or currentAnalysisRunId");
  }

  return withTenant(pool, organizationId, async (client) => {
    const currentState = await getGraphStateForAnalysisRunTx(
      client,
      organizationId,
      currentAnalysisRunId,
    );
    const { state: prevState } = await resolvePreviousGraphStateTx(
      client,
      organizationId,
      currentAnalysisRunId,
      previousAnalysisRunId,
    );
    return computeGraphDiff(prevState, currentState);
  });
}

