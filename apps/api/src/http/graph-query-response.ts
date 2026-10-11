import type {
  EvidenceRecord,
  GraphQueryResponse,
  GraphQueryResponseEdge,
  GraphQueryResponseEvidence,
  GraphQueryResponseNode,
  GraphTraversalResult,
} from "@fluxora/shared-types";

export interface FormatGraphQueryOptions {
  readonly minConfidence?: number | undefined;
}

export function formatGraphQueryResponse(
  result: GraphTraversalResult,
  options: FormatGraphQueryOptions = {},
): GraphQueryResponse {
  const { minConfidence } = options;

  // 1. Evidence lookup map: key = `${subjectType}:${subjectId}`
  const evidenceMap = new Map<string, EvidenceRecord>();
  if (result.evidence) {
    for (const ev of result.evidence) {
      const key = `${ev.subjectType}:${ev.subjectId}`;
      if (!evidenceMap.has(key)) {
        evidenceMap.set(key, ev);
      }
    }
  }

  // 2. Filter nodes deterministically
  const filteredNodes = result.nodes.filter((tn) => {
    if (minConfidence !== undefined) {
      return tn.node.confidence >= minConfidence;
    }
    return true;
  });

  const validNodeIdSet = new Set<string>(filteredNodes.map((tn) => tn.node.id));

  // 3. Filter edges deterministically (must meet confidence AND connect returned nodes)
  const filteredEdges = result.edges.filter((e) => {
    if (minConfidence !== undefined && e.confidence < minConfidence) {
      return false;
    }
    return validNodeIdSet.has(e.sourceNodeId) && validNodeIdSet.has(e.targetNodeId);
  });

  const validEdgeIdSet = new Set<string>(filteredEdges.map((e) => e.id));

  // 4. Map nodes to API response
  const responseNodes: GraphQueryResponseNode[] = filteredNodes.map((tn) => {
    const n = tn.node;
    const nodeObj: GraphQueryResponseNode = {
      id: n.id,
      type: n.nodeType,
      name: n.name,
      canonical_id: n.canonicalId,
      depth: tn.depth,
      confidence: n.confidence,
      path: n.path ?? null,
    };
    if (Object.keys(n.metadata).length > 0) {
      (nodeObj as { metadata?: Record<string, unknown> }).metadata = n.metadata;
    }
    return nodeObj;
  });

  // 5. Map edges to API response
  const responseEdges: GraphQueryResponseEdge[] = filteredEdges.map((e) => {
    const ev = evidenceMap.get(`graph_edge:${e.id}`);
    const edgeObj: GraphQueryResponseEdge = {
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      type: e.edgeType,
      confidence: e.confidence,
      provenance: e.provenance,
      evidence_id: ev ? ev.id : null,
      canonical_id: e.canonicalId ?? null,
    };
    if (Object.keys(e.metadata).length > 0) {
      (edgeObj as { metadata?: Record<string, unknown> }).metadata = e.metadata;
    }
    return edgeObj;
  });

  // 6. Map evidence (only for retained nodes & edges)
  let responseEvidence: GraphQueryResponseEvidence[] | undefined;
  if (result.evidence !== undefined) {
    const retainedEvidence: GraphQueryResponseEvidence[] = [];
    for (const ev of result.evidence) {
      if (
        (ev.subjectType === "graph_node" && validNodeIdSet.has(ev.subjectId)) ||
        (ev.subjectType === "graph_edge" && validEdgeIdSet.has(ev.subjectId))
      ) {
        if (minConfidence !== undefined && ev.confidence < minConfidence) {
          continue;
        }
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
        if (Object.keys(ev.metadata).length > 0) {
          (evObj as { metadata?: Record<string, unknown> }).metadata = ev.metadata;
        }
        retainedEvidence.push(evObj);
      }
    }
    responseEvidence = retainedEvidence;
  }

  const response: GraphQueryResponse = {
    nodes: responseNodes,
    edges: responseEdges,
    max_depth_reached: result.maxDepthReached,
    truncated: false,
  };

  if (responseEvidence !== undefined) {
    (response as { evidence?: readonly GraphQueryResponseEvidence[] }).evidence = responseEvidence;
  }

  return response;
}
