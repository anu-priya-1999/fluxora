import type {
  GraphNode,
  GraphNodeType,
  GraphQueryResponseEdge,
  GraphQueryResponseNode,
} from "@fluxora/shared-types";
import type { Edge, Node } from "@xyflow/react";

/**
 * Common shape for input graph nodes to GraphCanvas.
 * Supports both domain GraphNode and API GraphQueryResponseNode.
 */
export interface CanvasInputNode {
  readonly id: string;
  readonly canonicalId?: string;
  readonly canonical_id?: string;
  readonly nodeType?: GraphNodeType;
  readonly type?: string;
  readonly name: string;
  readonly path?: string | null;
  readonly confidence: number;
  readonly depth?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Common shape for input graph edges to GraphCanvas.
 * Supports both domain GraphEdge and API GraphQueryResponseEdge.
 */
export interface CanvasInputEdge {
  readonly id: string;
  readonly sourceNodeId?: string;
  readonly source?: string;
  readonly targetNodeId?: string;
  readonly target?: string;
  readonly edgeType?: string;
  readonly type?: string;
  readonly confidence?: number;
  readonly provenance?: string;
  readonly canonicalId?: string | null;
  readonly canonical_id?: string | null;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The typed payload carried inside React Flow Node.data.
 */
export interface FluxoraNodeData {
  readonly id: string;
  readonly canonicalId: string;
  readonly nodeType: string;
  readonly name: string;
  readonly path: string | null;
  readonly confidence: number;
  readonly depth?: number;
  readonly metadata: Record<string, unknown>;
  readonly isSelected?: boolean;
  [key: string]: unknown;
}

export type FluxoraFlowNode = Node<FluxoraNodeData>;
export type FluxoraFlowEdge = Edge;

export interface GraphMappingOptions {
  /**
   * Horizontal spacing between nodes in grid layout (default 260px).
   */
  readonly xSpacing?: number;
  /**
   * Vertical spacing between rows in grid layout (default 140px).
   */
  readonly ySpacing?: number;
  /**
   * Number of columns before wrapping in grid layout (default 4).
   */
  readonly columns?: number;
}

/**
 * Deterministically maps domain/API graph nodes and edges into React Flow nodes and edges.
 *
 * Requirements:
 * - Preserves domain IDs without random generation or Date.now().
 * - Calculates deterministic initial layout positions without external physics.
 * - Does not mutate source domain objects.
 * - Strips or excludes invalid/dangling edges deterministically.
 */
export function mapDomainGraphToFlow(
  inputNodes: readonly (CanvasInputNode | GraphNode | GraphQueryResponseNode)[],
  inputEdges: readonly (CanvasInputEdge | GraphQueryResponseEdge)[],
  options: GraphMappingOptions = {},
): { nodes: FluxoraFlowNode[]; edges: FluxoraFlowEdge[] } {
  const xSpacing = options.xSpacing ?? 260;
  const ySpacing = options.ySpacing ?? 140;
  const columns = options.columns ?? 4;

  const validNodeIds = new Set<string>();

  // 1. Map nodes deterministically
  const nodes: FluxoraFlowNode[] = inputNodes.map((n, index) => {
    const id = n.id;
    validNodeIds.add(id);

    // Resolve properties across GraphNode vs GraphQueryResponseNode conventions
    const canonicalId =
      ("canonicalId" in n && typeof n.canonicalId === "string"
        ? n.canonicalId
        : "canonical_id" in n && typeof n.canonical_id === "string"
          ? n.canonical_id
          : id);

    const nodeType =
      ("nodeType" in n && typeof n.nodeType === "string"
        ? n.nodeType
        : "type" in n && typeof n.type === "string"
          ? n.type
          : "unknown");

    const path = n.path ?? null;
    const confidence = typeof n.confidence === "number" ? n.confidence : 1.0;
    const depth = "depth" in n && typeof n.depth === "number" ? n.depth : undefined;
    const metadata = n.metadata ?? {};

    // Deterministic grid layout positioning:
    // If nodes provide depth, group by depth columns or standard deterministic grid
    const colIndex = index % columns;
    const rowIndex = Math.floor(index / columns);

    const position = {
      x: colIndex * xSpacing + 50,
      y: rowIndex * ySpacing + 50,
    };

    return {
      id,
      type: "fluxoraNode",
      position,
      data: {
        id,
        canonicalId,
        nodeType,
        name: n.name,
        path,
        confidence,
        ...(depth !== undefined ? { depth } : {}),
        metadata,
      },
    };
  });

  // 2. Map edges deterministically (avoiding dangling edges)
  const edges: FluxoraFlowEdge[] = [];
  for (const e of inputEdges) {
    const source =
      "sourceNodeId" in e && typeof e.sourceNodeId === "string"
        ? e.sourceNodeId
        : "source" in e && typeof e.source === "string"
          ? e.source
          : "";

    const target =
      "targetNodeId" in e && typeof e.targetNodeId === "string"
        ? e.targetNodeId
        : "target" in e && typeof e.target === "string"
          ? e.target
          : "";

    if (!source || !target) {
      continue;
    }

    // Preserve edge identity and filter out references to non-existent nodes
    if (!validNodeIds.has(source) || !validNodeIds.has(target)) {
      continue;
    }

    const edgeType =
      "edgeType" in e && typeof e.edgeType === "string"
        ? e.edgeType
        : "type" in e && typeof e.type === "string"
          ? e.type
          : "CONNECTED_TO";

    edges.push({
      id: e.id,
      source,
      target,
      label: edgeType,
      animated: edgeType === "EMITS_EVENT" || edgeType === "CONSUMES_EVENT",
      style: {
        stroke: "#94a3b8",
        strokeWidth: 1.5,
      },
      data: {
        edgeType,
        confidence: e.confidence ?? 1.0,
        provenance: e.provenance ?? "static-analysis",
        metadata: e.metadata ?? {},
      },
    });
  }

  return { nodes, edges };
}
