import type { CanvasInputEdge, CanvasInputNode } from "./graph-mapping.ts";

/**
 * Supported Level-of-Detail tiers tied to viewport zoom.
 *
 * - "overview" (zoom < 0.6): High-level architectural overview. Focuses on system boundaries,
 *   applications, services, packages, and databases. Symbol and deep module nodes are hidden.
 * - "module" (0.6 <= zoom < 1.1): Structural module overview. Shows packages, modules, APIs,
 *   events, databases, and services. Fine-grained symbols are hidden.
 * - "detail" (zoom >= 1.1): Complete symbol-level graph with full granularity.
 */
export type LodLevel = "overview" | "module" | "detail";

/**
 * Thresholds for zoom-to-LOD mapping.
 * Zoom values in React Flow typically range between minZoom (0.2) and maxZoom (2.5).
 */
export const LOD_THRESHOLDS = {
  OVERVIEW_MAX: 0.6,
  MODULE_MAX: 1.1,
} as const;

/**
 * Determines the deterministic LOD level from a zoom factor.
 */
export function getLodLevelFromZoom(zoom: number): LodLevel {
  if (!Number.isFinite(zoom) || zoom < LOD_THRESHOLDS.OVERVIEW_MAX) {
    return "overview";
  }
  if (zoom < LOD_THRESHOLDS.MODULE_MAX) {
    return "module";
  }
  return "detail";
}

/**
 * Normalized node type priorities for LOD visibility.
 * Higher priority values (e.g. 3) remain visible at all LOD levels.
 * Lower priority values (e.g. 1) are only revealed when zoomed in ("detail").
 */
const NODE_TYPE_LOD_PRIORITY: Record<string, number> = {
  // Level 3 (Highest architectural abstraction - visible in overview, module, and detail)
  application: 3,
  service: 3,
  database: 3,
  package: 3,

  // Level 2 (Module/boundary abstraction - visible in module and detail)
  module: 2,
  api: 2,
  event: 2,

  // Level 1 (Symbol-level details - visible only in detail)
  symbol: 1,
};

/**
 * Minimum priority required to be visible per LOD level.
 */
const LOD_MIN_PRIORITY: Record<LodLevel, number> = {
  overview: 3,
  module: 2,
  detail: 1,
};

export interface LodNodeVisibilityOptions {
  /**
   * The currently selected node ID, if any.
   * If provided, the selected node is always preserved so selection/inspector never breaks.
   */
  readonly selectedNodeId?: string | null | undefined;
  /**
   * Maximum depth allowed at overview level (optional depth cutoff).
   * For instance, even for high-level nodes, overview can prioritize root/shallow depths.
   */
  readonly maxOverviewDepth?: number | undefined;
}

/**
 * Evaluates whether a given node is visible under the specified LOD level.
 *
 * Deterministic rules:
 * 1. If the node is currently selected (`node.id === selectedNodeId`), it is ALWAYS visible.
 * 2. At "detail" LOD, all nodes are visible.
 * 3. At "module" LOD, symbols are hidden; modules, APIs, events, packages, services, and databases are visible.
 * 4. At "overview" LOD, only applications, services, databases, and packages are visible.
 * 5. Unknown node types default to priority 2 (module-level).
 */
export function isNodeVisibleAtLod(
  node: CanvasInputNode,
  lod: LodLevel,
  options: LodNodeVisibilityOptions = {},
): boolean {
  if (options.selectedNodeId && node.id === options.selectedNodeId) {
    return true;
  }

  if (lod === "detail") {
    return true;
  }

  const rawType = node.nodeType ?? node.type ?? "module";
  const priority = NODE_TYPE_LOD_PRIORITY[rawType] ?? 2;
  const minRequiredPriority = LOD_MIN_PRIORITY[lod];

  if (priority < minRequiredPriority) {
    return false;
  }

  // At overview LOD, if depth is present and exceeds maxOverviewDepth (if set), hide deeper nodes
  if (lod === "overview" && typeof options.maxOverviewDepth === "number" && typeof node.depth === "number") {
    if (node.depth > options.maxOverviewDepth) {
      return false;
    }
  }

  return true;
}

export interface ComputeLodGraphInput {
  readonly nodes: readonly CanvasInputNode[];
  readonly edges: readonly CanvasInputEdge[];
  readonly lod: LodLevel;
  readonly selectedNodeId?: string | null | undefined;
}

export interface LodGraphResult {
  readonly visibleNodes: readonly CanvasInputNode[];
  readonly visibleEdges: readonly CanvasInputEdge[];
  readonly hiddenNodeCount: number;
  readonly hiddenEdgeCount: number;
  readonly lod: LodLevel;
}

/**
 * Computes the deterministic visible subset of nodes and edges for a given LOD level.
 *
 * Invariants:
 * - Preserves original node and edge objects without mutation.
 * - Deterministic ordering identical to source order.
 * - Guarantees NO dangling edges: an edge is only included if BOTH source and target
 *   are in the visible node set.
 * - Never converts a real node into a synthetic cluster or alters node IDs.
 */
export function computeLodGraph(input: ComputeLodGraphInput): LodGraphResult {
  const { nodes, edges, lod, selectedNodeId } = input;

  // 1. Identify visible nodes
  const visibleNodes: CanvasInputNode[] = [];
  const visibleNodeIds = new Set<string>();

  for (const node of nodes) {
    if (isNodeVisibleAtLod(node, lod, { selectedNodeId })) {
      visibleNodes.push(node);
      visibleNodeIds.add(node.id);
    }
  }

  // 2. Identify visible edges (strictly endpoints both visible)
  const visibleEdges: CanvasInputEdge[] = [];
  for (const edge of edges) {
    const sourceId = edge.sourceNodeId ?? edge.source ?? "";
    const targetId = edge.targetNodeId ?? edge.target ?? "";

    if (sourceId && targetId && visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId)) {
      visibleEdges.push(edge);
    }
  }

  return {
    visibleNodes,
    visibleEdges,
    hiddenNodeCount: nodes.length - visibleNodes.length,
    hiddenEdgeCount: edges.length - visibleEdges.length,
    lod,
  };
}
